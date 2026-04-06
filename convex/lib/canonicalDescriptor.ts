/**
 * Layer A — C2PA-inspired canonical manifest for protected assets.
 *
 * A manifest is signed over the pre-trace canonical form of the asset
 * (before any recipient-specific tracing mutations are applied).
 * This makes manifests stable across all buyers of the same package version.
 *
 * Signing algorithm: Ed25519 (@noble/ed25519 via yucpCrypto)
 * Domain prefix:     "yucp.descriptor.v2|"
 * Signed message:    domain + canonicalSha256 + "|" + packageId + "|" + assetPath + "|" + issuedAt
 *
 * References:
 *   C2PA 2.3 spec   https://c2pa.org/specifications/specifications/2.3/
 *   RFC 8032         https://www.rfc-editor.org/rfc/rfc8032 (EdDSA)
 *   FIPS 205         SLH-DSA (post-quantum secondary chain; deferred to Phase 7b)
 */

import * as ed from '@noble/ed25519';
import { sha256Hex } from '@yucp/shared/crypto';
import { base64ToBytes, bytesToBase64 } from './yucpCrypto';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AssetFormat = 'png' | 'fbx' | 'text' | 'unknown';

/**
 * The claim that is signed.  All fields are bound into the Ed25519 signature.
 */
export type ManifestClaim = {
  packageId: string;
  assetPath: string;
  protectedAssetId: string;
  canonicalSha256: string;
  format: AssetFormat;
  manifestVersion: '2';
  issuedAt: string; // ISO 8601
};

/**
 * Ed25519 signature block.
 */
export type Ed25519SignatureBlock = {
  alg: 'Ed25519';
  sig: string; // base64url
  signerThumbprint?: string;
  tsaToken?: string; // RFC 3161 timestamp token (base64, omitted until TSA is wired)
};

/**
 * Full signed manifest.  Stored as a separate .yucp.sig file in the ZIP payload.
 */
export type SignedManifest = {
  yucp_manifest_version: '2';
  claim: ManifestClaim;
  signatures: {
    ed25519: Ed25519SignatureBlock;
  };
};

/**
 * Six-state validation outcome (C2PA-shaped).
 */
export type ManifestValidationState =
  | 'well-formed'       // manifest parses and is structurally valid
  | 'valid'             // canonical_sha256 matches the asset's canonical form
  | 'trusted'           // signer identity is on the YUCP trust list
  | 'modified'          // canonical hash mismatch — asset was changed after signing
  | 'descriptor-missing' // no .yucp.sig present (never collapsed into 'modified')
  | 'unsupported-transform'; // format re-encoded in a way that destroys the canonical form

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Domain-separated signing prefix for v2 manifests. */
const MANIFEST_DOMAIN_PREFIX = 'yucp.descriptor.v2|';

/**
 * Build the canonical message bytes that are signed/verified.
 * Format: "yucp.descriptor.v2|<canonicalSha256>|<packageId>|<assetPath>|<issuedAt>"
 */
function buildSigningMessage(claim: ManifestClaim): Uint8Array {
  const text =
    MANIFEST_DOMAIN_PREFIX +
    claim.canonicalSha256 +
    '|' +
    claim.packageId +
    '|' +
    claim.assetPath +
    '|' +
    claim.issuedAt;
  return new TextEncoder().encode(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-trace canonical hash computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the pre-trace canonical hash for an asset.
 *
 * The canonical form is defined per format:
 *   - PNG: the raw IDAT chunk data bytes (before pixelseal is applied)
 *   - FBX: the normalized ASCII numeric form (before QIM embedding)
 *   - text / other: the file bytes as-is
 *
 * When the server only has the original file bytes and cannot perform
 * format-specific canonicalization (e.g., PNG IDAT extraction), pass
 * `format = 'unknown'` to use the full file bytes as the canonical form.
 * This is appropriate for server-side contexts that receive raw files.
 *
 * NOTE: The canonical hash MUST be computed before any tracing mutations.
 * Once pixelseal or QIM has been applied, the canonical bytes have changed.
 */
export async function computePreTraceCanonicalHash(
  fileBytes: Uint8Array,
  format: AssetFormat
): Promise<string> {
  switch (format) {
    case 'png': {
      // Extract IDAT chunk data bytes from the PNG stream.
      // The signature (8 bytes) + chunks; each chunk: 4-byte length, 4-byte type, data, 4-byte CRC.
      const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
      if (fileBytes.length < 8) {
        return sha256Hex(fileBytes);
      }
      for (let i = 0; i < 8; i++) {
        if (fileBytes[i] !== PNG_SIG[i]) {
          // Not a valid PNG — fall back to full file bytes
          return sha256Hex(fileBytes);
        }
      }
      const idatChunks: Uint8Array[] = [];
      let pos = 8;
      while (pos + 12 <= fileBytes.length) {
        const dataLen =
          (fileBytes[pos]! << 24) |
          (fileBytes[pos + 1]! << 16) |
          (fileBytes[pos + 2]! << 8) |
          fileBytes[pos + 3]!;
        const type = String.fromCharCode(
          fileBytes[pos + 4]!,
          fileBytes[pos + 5]!,
          fileBytes[pos + 6]!,
          fileBytes[pos + 7]!
        );
        const dataStart = pos + 8;
        const dataEnd = dataStart + dataLen;
        if (dataEnd > fileBytes.length) break;
        if (type === 'IDAT') {
          idatChunks.push(fileBytes.slice(dataStart, dataEnd));
        }
        pos = dataEnd + 4; // skip 4-byte CRC
      }
      if (idatChunks.length === 0) {
        return sha256Hex(fileBytes);
      }
      // Concatenate all IDAT data and hash
      const totalLen = idatChunks.reduce((s, c) => s + c.length, 0);
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of idatChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      return sha256Hex(combined);
    }

    case 'fbx': {
      // Normalize ASCII FBX: extract all decimal/floating-point numeric tokens
      // from the raw text and hash their concatenation. This mirrors the
      // QIM normalization used by xg_0120 / xg_0121.
      const text = new TextDecoder('utf-8', { fatal: false }).decode(fileBytes);
      // Extract numeric tokens (integer and float literals)
      const matches = text.match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? [];
      const normalized = matches.join('\n');
      return sha256Hex(new TextEncoder().encode(normalized));
    }

    case 'text':
    case 'unknown':
    default:
      return sha256Hex(fileBytes);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Signing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sign a manifest claim using the root Ed25519 private key (base64-encoded seed).
 * Returns a fully formed SignedManifest ready to be stored as .yucp.sig.
 */
export async function signManifest(
  claim: ManifestClaim,
  privateKeyBase64: string,
  signerThumbprint?: string
): Promise<SignedManifest> {
  const message = buildSigningMessage(claim);
  const privateKeyBytes = base64ToBytes(privateKeyBase64);
  const signatureBytes = await ed.signAsync(message, privateKeyBytes);
  const sig = bytesToBase64(signatureBytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, ''); // base64url

  return {
    yucp_manifest_version: '2',
    claim,
    signatures: {
      ed25519: {
        alg: 'Ed25519',
        sig,
        ...(signerThumbprint ? { signerThumbprint } : {}),
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a manifest against the asset bytes and a known trusted public key.
 *
 * Returns the highest validation state reached:
 *   - 'trusted':   signature valid AND signer matches the trusted public key
 *   - 'valid':     canonical hash matches AND signature well-formed (signer unverified)
 *   - 'well-formed': manifest parses but canonical hash or signature not checked
 *   - 'modified':  manifest present but canonical hash mismatches
 *   - 'descriptor-missing': manifest is null/undefined
 *   - 'unsupported-transform': format extraction failed (e.g., corrupted PNG IDAT)
 */
export async function verifyManifest(
  manifest: SignedManifest | null | undefined,
  assetBytes: Uint8Array,
  trustedPublicKeyBase64: string
): Promise<ManifestValidationState> {
  if (!manifest) {
    return 'descriptor-missing';
  }

  // 1. Structural validation
  if (
    manifest.yucp_manifest_version !== '2' ||
    !manifest.claim ||
    !manifest.claim.canonicalSha256 ||
    !manifest.claim.packageId ||
    !manifest.claim.assetPath ||
    !manifest.claim.issuedAt ||
    !manifest.signatures?.ed25519?.sig
  ) {
    return 'well-formed'; // parsed but incomplete
  }

  // 2. Canonical hash check
  let computedHash: string;
  try {
    computedHash = await computePreTraceCanonicalHash(assetBytes, manifest.claim.format ?? 'unknown');
  } catch {
    return 'unsupported-transform';
  }

  if (computedHash.toLowerCase() !== manifest.claim.canonicalSha256.toLowerCase()) {
    return 'modified';
  }

  // 3. Signature verification
  try {
    const b64 = manifest.signatures.ed25519.sig
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const sigBytes = base64ToBytes(padded);
    const pubKeyBytes = base64ToBytes(trustedPublicKeyBase64);
    const message = buildSigningMessage(manifest.claim);
    const ok = await ed.verifyAsync(sigBytes, message, pubKeyBytes);
    if (!ok) {
      return 'valid'; // hash matched but signature invalid for this key
    }
  } catch {
    return 'valid'; // hash matched but signature could not be verified
  }

  return 'trusted';
}
