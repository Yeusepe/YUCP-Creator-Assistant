import * as ed from '@noble/ed25519';
import {
  base64ToBytes,
  base64UrlDecodeToBytes as base64UrlDecode,
  base64UrlEncode,
  bytesToBase64,
} from '@yucp/shared/crypto';

ed.etc.sha512Async = async (...messages: Uint8Array[]) => {
  const data = ed.etc.concatBytes(...messages);
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
  const hash = await crypto.subtle.digest('SHA-512', buffer);
  return new Uint8Array(hash);
};

export interface LicenseClaims {
  iss: string;
  aud: 'yucp-license-gate';
  sub: string;
  jti: string;
  package_id: string;
  machine_fingerprint: string;
  provider: string;
  iat: number;
  exp: number;
}

type BaseRuntimeClaims = {
  iss: string;
  sub: string;
  jti: string;
  package_id: string;
  machine_fingerprint: string;
  project_id: string;
  artifact_key: string;
  artifact_channel: string;
  artifact_platform: string;
  artifact_version: string;
  metadata_version: number;
  delivery_name: string;
  content_type: string;
  envelope_cipher: string;
  envelope_iv_b64: string;
  ciphertext_sha256: string;
  ciphertext_size: number;
  plaintext_sha256: string;
  plaintext_size: number;
  code_signing_subject?: string;
  code_signing_thumbprint?: string;
  iat: number;
  exp: number;
};

export type CouplingRuntimeClaims = BaseRuntimeClaims & {
  aud: 'yucp-coupling-runtime';
};

export type CouplingRuntimePackageClaims = BaseRuntimeClaims & {
  aud: 'yucp-runtime-package';
};

export async function getPublicKeyFromPrivate(privateKeyBase64: string): Promise<string> {
  const privateKeyBytes = base64ToBytes(privateKeyBase64);
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);
  return bytesToBase64(publicKeyBytes);
}

export async function signCouplingRuntimeJwt(
  claims: CouplingRuntimeClaims,
  privateKeyBase64: string,
  keyId: string
): Promise<string> {
  return signJwt(claims, privateKeyBase64, keyId);
}

export async function signCouplingRuntimePackageJwt(
  claims: CouplingRuntimePackageClaims,
  privateKeyBase64: string,
  keyId: string
): Promise<string> {
  return signJwt(claims, privateKeyBase64, keyId);
}

async function signJwt(
  claims: LicenseClaims | CouplingRuntimeClaims | CouplingRuntimePackageClaims,
  privateKeyBase64: string,
  keyId: string
): Promise<string> {
  const header = { alg: 'EdDSA', crv: 'Ed25519', kid: keyId };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;
  const messageBytes = new TextEncoder().encode(signingInput);
  const privateKeyBytes = base64ToBytes(privateKeyBase64);
  const signatureBytes = await ed.signAsync(messageBytes, privateKeyBytes);
  return `${signingInput}.${base64UrlEncode(signatureBytes)}`;
}

async function verifyJwt<T extends { iss: string; aud: string; iat: number; exp: number }>(
  jwt: string,
  publicKeyBase64: string,
  expectedIssuer: string,
  expectedAudience: string
): Promise<T | null> {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const headerJson = new TextDecoder().decode(base64UrlDecode(parts[0]));
    const payloadJson = new TextDecoder().decode(base64UrlDecode(parts[1]));
    const header = JSON.parse(headerJson) as { alg?: string; kid?: string };
    if (header.alg !== 'EdDSA' || !header.kid) {
      return null;
    }

    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signatureBytes = base64UrlDecode(parts[2]);
    const publicKeyBytes = base64ToBytes(publicKeyBase64);
    const valid = await ed.verifyAsync(signatureBytes, signingInput, publicKeyBytes);
    if (!valid) {
      return null;
    }

    const claims = JSON.parse(payloadJson) as T;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (claims.iss !== expectedIssuer || claims.aud !== expectedAudience) {
      return null;
    }
    if (claims.exp <= nowSeconds || claims.iat > nowSeconds + 300) {
      return null;
    }

    return claims;
  } catch {
    return null;
  }
}

export async function verifyLicenseJwt(
  jwt: string,
  publicKeyBase64: string,
  expectedIssuer: string
): Promise<LicenseClaims | null> {
  return await verifyJwt<LicenseClaims>(jwt, publicKeyBase64, expectedIssuer, 'yucp-license-gate');
}
