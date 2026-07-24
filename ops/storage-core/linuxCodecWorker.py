import ctypes
import hashlib
import json
import os
import resource
import shutil
import sys
from pathlib import PurePosixPath

INPUT_ROOT = "/input"
OUTPUT_ROOT = "/output"
RUNTIME_PATH = "/opt/yucp/yucp_coupling.so"
FORBIDDEN_ENV_MARKERS = (
    "AWS_",
    "B2_",
    "CAS_S3_",
    "INFISICAL_",
    "COUPLING_WM_MASTER",
    "BROKER_SHARED",
    "PRIVATE_KEY",
    "SIGNING_KEY",
)


def framed_hash(purpose, fields):
    digest = hashlib.sha256()
    digest.update(purpose.encode("ascii"))
    for field in fields:
        digest.update(len(field).to_bytes(8, "big"))
        digest.update(field)
    return digest.digest()


def safe_relative_path(value, require_unity_root=False):
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or not candidate.parts:
        raise ValueError("invalid relative path")
    if any(part in ("", ".", "..") for part in candidate.parts):
        raise ValueError("invalid relative path")
    if require_unity_root and candidate.parts[0] not in ("Assets", "Packages"):
        raise ValueError("invalid Unity path")
    return candidate


def confined_path(root, relative_path):
    candidate = os.path.realpath(os.path.join(root, *relative_path.parts))
    if os.path.commonpath((os.path.realpath(root), candidate)) != os.path.realpath(root):
        raise ValueError("path escaped its root")
    return candidate


def load_runtime():
    runtime = ctypes.CDLL(RUNTIME_PATH)
    runtime.xg_0122.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p)
    runtime.xg_0122.restype = ctypes.c_int
    runtime.xg_0123.argtypes = (
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_uint32,
    )
    runtime.xg_0123.restype = ctypes.c_int
    return runtime


def require_hex(value, expected_length, name):
    if (
        not isinstance(value, str)
        or len(value) != expected_length
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"invalid {name}")
    return value


def process_file(runtime, entry):
    source_relative = safe_relative_path(entry.get("sourcePath"))
    output_relative = safe_relative_path(entry.get("normalizedPath"), True)
    token_hex = require_hex(entry.get("tokenHex"), 16, "token")
    seed_hex = require_hex(entry.get("seedHex"), 64, "seed")
    source_path = confined_path(INPUT_ROOT, source_relative)
    output_path = confined_path(OUTPUT_ROOT, output_relative)
    if not os.path.isfile(source_path):
        raise ValueError("source is not a regular file")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    shutil.copyfile(source_path, output_path)
    encode_status = runtime.xg_0122(
        output_path.encode("utf-8"),
        token_hex.encode("ascii"),
        seed_hex.encode("ascii"),
    )
    if encode_status != 0:
        raise RuntimeError(f"native encode failed with status {encode_status}")

    decoded = ctypes.create_string_buffer(17)
    decode_status = runtime.xg_0123(
        output_path.encode("utf-8"),
        seed_hex.encode("ascii"),
        decoded,
        len(decoded),
    )
    if decode_status != 0:
        raise RuntimeError(f"native decode failed with status {decode_status}")
    decoded_token = decoded.value.decode("ascii")
    if decoded_token != token_hex:
        raise RuntimeError("native roundtrip returned a different attribution token")

    with open(output_path, "rb") as output_file:
        output_bytes = output_file.read()
    return {
        "decodedTokenHex": decoded_token,
        "normalizedPath": output_relative.as_posix(),
        "outputBytes": len(output_bytes),
        "outputSha256": hashlib.sha256(output_bytes).hexdigest(),
    }


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    forbidden_environment = sorted(
        name
        for name, value in os.environ.items()
        if value and any(marker in name.upper() for marker in FORBIDDEN_ENV_MARKERS)
    )
    if forbidden_environment:
        raise RuntimeError("codec received a forbidden credential environment")

    request = json.load(sys.stdin)
    files = request.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= 16:
        raise ValueError("files must contain between one and sixteen entries")

    runtime = load_runtime()
    results = sorted(
        (process_file(runtime, entry) for entry in files),
        key=lambda entry: entry["normalizedPath"].encode("utf-8"),
    )
    tree_fields = []
    for result in results:
        tree_fields.extend(
            (
                result["normalizedPath"].encode("utf-8"),
                bytes.fromhex(result["outputSha256"]),
                result["outputBytes"].to_bytes(8, "big"),
            )
        )
    response = {
        "credentialEnvironment": forbidden_environment,
        "files": results,
        "outputTreeRoot": framed_hash("yucp:output-tree:v2", tree_fields).hex(),
        "schemaVersion": 1,
    }
    json.dump(response, sys.stdout, separators=(",", ":"), sort_keys=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        json.dump(
            {"error": str(error), "errorType": type(error).__name__, "schemaVersion": 1},
            sys.stderr,
            separators=(",", ":"),
            sort_keys=True,
        )
        sys.exit(1)
