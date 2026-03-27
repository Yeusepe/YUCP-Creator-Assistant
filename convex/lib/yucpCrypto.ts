/**
 * YUCP Certificate Authority, Ed25519 signing utilities.
 *
 * Uses @noble/ed25519 v2 wired to the Web Crypto API's SHA-512 implementation
 * so no additional hash-library dependency is required at runtime.
 *
 * References:
 *   @noble/ed25519   https://github.com/paulmillr/noble-ed25519
 *   Sigstore design  https://docs.sigstore.dev/about/overview/
 *   RFC 8032         https://www.rfc-editor.org/rfc/rfc8032 (EdDSA)
 */

import * as ed from '@noble/ed25519';

// Wire up Web Crypto SHA-512 so sign()/verify() work in Convex's JS runtime
// without needing @noble/hashes as a second dependency.
ed.etc.sha512Async = async (...messages: Uint8Array[]) => {
  const data = ed.etc.concatBytes(...messages);
  // Copy to a plain ArrayBuffer to satisfy Web Crypto's BufferSource type
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
  const hash = await crypto.subtle.digest('SHA-512', buffer);
  return new Uint8Array(hash);
};

// ─────────────────────────────────────────────────────────────────────────────
// Encoding helpers
// ─────────────────────────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Certificate types
// ─────────────────────────────────────────────────────────────────────────────

export interface IdentityAnchors {
  /** Better Auth user ID (primary stable anchor) */
  yucpUserId: string;
  discordUserId?: string;
  emailHash?: string;
}

/** CertData for schemaVersion 2 (identity-anchored). */
export interface CertData {
  devPublicKey: string;
  expiresAt: string; // ISO 8601
  /** Better Auth user ID of the certificate owner */
  yucpUserId: string;
  identityAnchors: IdentityAnchors;
  issuedAt: string; // ISO 8601
  issuer: string;
  nonce: string;
  publisherId: string;
  publisherName: string;
  schemaVersion: number;
}

export interface CertSignature {
  algorithm: 'Ed25519';
  keyId: string;
  value: string; // base64
}

export interface CertEnvelope {
  cert: CertData;
  signature: CertSignature;
}

export type PackageCertificateType = 'Root' | 'Intermediate' | 'Publisher';

export interface PackageCertificateData {
  keyId: string;
  publicKey: string;
  signature?: string;
  issuerKeyId?: string;
  certificateType: PackageCertificateType;
  publisherId?: string;
  notBefore?: string;
  notAfter?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalisation (must stay in sync with CertificateManager.CanonicalizeJson
// in E:\Unity\YUCP-Dev-Tools\...\CertificateManager.cs)
// ─────────────────────────────────────────────────────────────────────────────

function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === 'object') {
    const sorted = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalizeValue(v)] as const);
    return Object.fromEntries(sorted);
  }
  return value;
}

export function canonicalizeCert(certData: CertData): string {
  return JSON.stringify(canonicalizeValue(certData));
}

export function canonicalizePackageCertificate(certData: PackageCertificateData): string {
  const fields: Array<[string, string]> = [];

  if (certData.keyId) fields.push(['keyId', JSON.stringify(certData.keyId)]);
  if (certData.publicKey) fields.push(['publicKey', JSON.stringify(certData.publicKey)]);
  if (certData.issuerKeyId) fields.push(['issuerKeyId', JSON.stringify(certData.issuerKeyId)]);
  fields.push(['certificateType', JSON.stringify(certData.certificateType)]);
  if (certData.publisherId) fields.push(['publisherId', JSON.stringify(certData.publisherId)]);
  if (certData.notBefore) fields.push(['notBefore', JSON.stringify(certData.notBefore)]);
  if (certData.notAfter) fields.push(['notAfter', JSON.stringify(certData.notAfter)]);

  fields.sort(([a], [b]) => a.localeCompare(b));
  return `{${fields.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signing / verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sign a CertData object using the YUCP root Ed25519 private key.
 * @param certData   - Cert fields to sign
 * @param privateKeyBase64 - 32-byte Ed25519 private key (base64)
 * @param keyId      - Human-readable key identifier (e.g. "yucp-root-2025")
 */
export async function signCertData(
  certData: CertData,
  privateKeyBase64: string,
  keyId: string
): Promise<CertEnvelope> {
  const canonical = canonicalizeCert(certData);
  const messageBytes = new TextEncoder().encode(canonical);
  const privateKeyBytes = base64ToBytes(privateKeyBase64);

  const signatureBytes = await ed.signAsync(messageBytes, privateKeyBytes);

  return {
    cert: certData,
    signature: {
      algorithm: 'Ed25519',
      keyId,
      value: bytesToBase64(signatureBytes),
    },
  };
}

export async function signPackageCertificateData(
  certData: PackageCertificateData,
  privateKeyBase64: string
): Promise<string> {
  const canonical = canonicalizePackageCertificate(certData);
  const messageBytes = new TextEncoder().encode(canonical);
  const privateKeyBytes = base64ToBytes(privateKeyBase64);
  const signatureBytes = await ed.signAsync(messageBytes, privateKeyBytes);
  return bytesToBase64(signatureBytes);
}

/**
 * Verify a CertEnvelope's signature against a known Ed25519 public key.
 * Returns false (never throws) on any error.
 */
export async function verifyCertEnvelope(
  envelope: CertEnvelope,
  publicKeyBase64: string
): Promise<boolean> {
  try {
    const canonical = canonicalizeCert(envelope.cert);
    const messageBytes = new TextEncoder().encode(canonical);
    const publicKeyBytes = base64ToBytes(publicKeyBase64);
    const signatureBytes = base64ToBytes(envelope.signature.value);
    return await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

/**
 * Derive the Ed25519 public key from a private key (async).
 */
export async function getPublicKeyFromPrivate(privateKeyBase64: string): Promise<string> {
  const privateKeyBytes = base64ToBytes(privateKeyBase64);
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);
  return bytesToBase64(publicKeyBytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// License JWT
// ─────────────────────────────────────────────────────────────────────────────

/** Claims embedded in a license gate JWT. */
export interface LicenseClaims {
  iss: string;
  aud: 'yucp-license-gate';
  /** SHA-256 hex of the raw license key (never log the raw key) */
  sub: string;
  jti: string;
  package_id: string;
  machine_fingerprint: string;
  provider: string;
  iat: number;
  exp: number;
}

function base64urlEncode(data: Uint8Array | string): string {
  let b64: string;
  if (typeof data === 'string') {
    b64 = btoa(data);
  } else {
    let binary = '';
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
    b64 = btoa(binary);
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(input: string): Uint8Array {
  let padded = input.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) {
    padded += '=';
  }
  return base64ToBytes(padded);
}

/**
 * Create a signed license JWT (EdDSA / Ed25519).
 * The client can parse the payload without signature verification, security
 * relies on: valid token only obtainable via server license check, machine
 * fingerprint binding, short TTL, and HMAC-authenticated on-disk cache.
 */
export async function signLicenseJwt(
  claims: LicenseClaims,
  privateKeyBase64: string,
  keyId: string
): Promise<string> {
  return signJwt(claims, privateKeyBase64, keyId);
}

export interface ProtectedUnlockClaims {
  iss: string;
  aud: 'yucp-protected-unlock';
  sub: string;
  jti: string;
  package_id: string;
  protected_asset_id: string;
  machine_fingerprint: string;
  project_id: string;
  unlock_mode: 'wrapped_content_key' | 'content_key_b64';
  wrapped_content_key?: string;
  content_key_b64?: string;
  content_hash: string;
  iat: number;
  exp: number;
}

export async function signProtectedUnlockJwt(
  claims: ProtectedUnlockClaims,
  privateKeyBase64: string,
  keyId: string
): Promise<string> {
  return signJwt(claims, privateKeyBase64, keyId);
}

export interface CouplingRuntimeClaims {
  iss: string;
  aud: 'yucp-coupling-runtime';
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
}

export interface CouplingRuntimePackageClaims {
  iss: string;
  aud: 'yucp-runtime-package';
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
  claims:
    | LicenseClaims
    | ProtectedUnlockClaims
    | CouplingRuntimeClaims
    | CouplingRuntimePackageClaims,
  privateKeyBase64: string,
  keyId: string
): Promise<string> {
  const header = { alg: 'EdDSA', crv: 'Ed25519', kid: keyId };
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;

  const messageBytes = new TextEncoder().encode(signingInput);
  const privateKeyBytes = base64ToBytes(privateKeyBase64);
  const signatureBytes = await ed.signAsync(messageBytes, privateKeyBytes);

  return `${signingInput}.${base64urlEncode(signatureBytes)}`;
}

async function verifyJwt<T extends { iss: string; aud: string; iat: number; exp: number }>(
  jwt: string,
  publicKeyBase64: string,
  expectedIssuer: string,
  expectedAudience: string
): Promise<T | null> {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;

    const headerJson = new TextDecoder().decode(base64urlDecode(parts[0]));
    const payloadJson = new TextDecoder().decode(base64urlDecode(parts[1]));
    const header = JSON.parse(headerJson) as { alg?: string; kid?: string };
    if (header.alg !== 'EdDSA' || !header.kid) return null;

    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signatureBytes = base64urlDecode(parts[2]);
    const publicKeyBytes = base64ToBytes(publicKeyBase64);
    const valid = await ed.verifyAsync(signatureBytes, signingInput, publicKeyBytes);
    if (!valid) return null;

    const claims = JSON.parse(payloadJson) as T;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (claims.iss !== expectedIssuer || claims.aud !== expectedAudience) return null;
    if (claims.exp <= nowSeconds || claims.iat > nowSeconds + 300) return null;
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
  return verifyJwt<LicenseClaims>(jwt, publicKeyBase64, expectedIssuer, 'yucp-license-gate');
}

export async function verifyProtectedUnlockJwt(
  jwt: string,
  publicKeyBase64: string,
  expectedIssuer: string
): Promise<ProtectedUnlockClaims | null> {
  return verifyJwt<ProtectedUnlockClaims>(
    jwt,
    publicKeyBase64,
    expectedIssuer,
    'yucp-protected-unlock'
  );
}

export async function verifyCouplingRuntimeJwt(
  jwt: string,
  publicKeyBase64: string,
  expectedIssuer: string
): Promise<CouplingRuntimeClaims | null> {
  return verifyJwt<CouplingRuntimeClaims>(
    jwt,
    publicKeyBase64,
    expectedIssuer,
    'yucp-coupling-runtime'
  );
}

export async function verifyCouplingRuntimePackageJwt(
  jwt: string,
  publicKeyBase64: string,
  expectedIssuer: string
): Promise<CouplingRuntimePackageClaims | null> {
  return verifyJwt<CouplingRuntimePackageClaims>(
    jwt,
    publicKeyBase64,
    expectedIssuer,
    'yucp-runtime-package'
  );
}
