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
import {
  base64ToBytes,
  base64UrlDecodeToBytes as base64urlDecode,
  base64UrlEncode as base64urlEncode,
  bytesToBase64,
} from '@yucp/shared/crypto';
import {
  getYucpJwkSetFromRoots,
  getYucpRootByKeyId,
  resolveConfiguredYucpTrustBundle,
  type YucpPinnedRoot,
  type YucpTrustBundleConfig,
  type YucpTrustJwk,
} from '@yucp/shared/yucpTrust';
export { base64ToBytes, bytesToBase64 };

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

const TRUST_BUNDLE_AUDIENCE = 'yucp-trust-bundle';

function getConfiguredYucpTrustBundle(): YucpTrustBundleConfig {
  return resolveConfiguredYucpTrustBundle(process.env.YUCP_TRUST_BUNDLE_JSON);
}

function getConfiguredYucpRoots(): readonly YucpPinnedRoot[] {
  return getConfiguredYucpTrustBundle().roots;
}

function getConfiguredYucpRootByKeyId(keyId: string | null | undefined): YucpPinnedRoot | null {
  return getYucpRootByKeyId(getConfiguredYucpRoots(), keyId);
}

export function getConfiguredYucpJwkSet(): YucpTrustJwk[] {
  return getYucpJwkSetFromRoots(getConfiguredYucpRoots());
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

export async function verifyCertEnvelopeAgainstPinnedRoots(
  envelope: CertEnvelope
): Promise<boolean> {
  const rootPublicKeyBase64 = getConfiguredYucpRootByKeyId(
    envelope.signature.keyId
  )?.publicKeyBase64;
  if (!rootPublicKeyBase64) {
    return false;
  }
  return await verifyCertEnvelope(envelope, rootPublicKeyBase64);
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

export interface YucpTrustBundleClaims {
  iss: string;
  aud: typeof TRUST_BUNDLE_AUDIENCE;
  iat: number;
  exp: number;
  version: number;
  keys: YucpTrustJwk[];
}

export async function signProtectedUnlockJwt(
  claims: ProtectedUnlockClaims,
  privateKeyBase64: string,
  keyId: string
): Promise<string> {
  return signJwt(claims, privateKeyBase64, keyId);
}

export async function signYucpTrustBundleJwt(
  args: {
    issuer: string;
    version: number;
    keys: YucpTrustJwk[];
    issuedAt?: number;
    expiresAt?: number;
  },
  privateKeyBase64: string,
  keyId: string
): Promise<string> {
  const issuedAt = args.issuedAt ?? Math.floor(Date.now() / 1000);
  const expiresAt = args.expiresAt ?? issuedAt + 300;
  return signJwt(
    {
      iss: args.issuer,
      aud: TRUST_BUNDLE_AUDIENCE,
      iat: issuedAt,
      exp: expiresAt,
      version: args.version,
      keys: args.keys,
    },
    privateKeyBase64,
    keyId
  );
}

async function signJwt(
  claims: LicenseClaims | ProtectedUnlockClaims | YucpTrustBundleClaims,
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

async function verifyJwtWithPublicKeyResolver<
  T extends { iss: string; aud: string; iat: number; exp: number },
>(
  jwt: string,
  resolvePublicKeyBase64: (keyId: string) => string | null | undefined,
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

    const publicKeyBase64 = resolvePublicKeyBase64(header.kid);
    if (!publicKeyBase64) {
      return null;
    }

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

async function verifyJwt<T extends { iss: string; aud: string; iat: number; exp: number }>(
  jwt: string,
  publicKeyBase64: string,
  expectedIssuer: string,
  expectedAudience: string
): Promise<T | null> {
  return await verifyJwtWithPublicKeyResolver<T>(
    jwt,
    () => publicKeyBase64,
    expectedIssuer,
    expectedAudience
  );
}

export async function verifyLicenseJwt(
  jwt: string,
  publicKeyBase64: string,
  expectedIssuer: string
): Promise<LicenseClaims | null> {
  return verifyJwt<LicenseClaims>(jwt, publicKeyBase64, expectedIssuer, 'yucp-license-gate');
}

export async function verifyLicenseJwtAgainstPinnedRoots(
  jwt: string,
  expectedIssuer: string
): Promise<LicenseClaims | null> {
  return await verifyJwtWithPublicKeyResolver<LicenseClaims>(
    jwt,
    (keyId) => getConfiguredYucpRootByKeyId(keyId)?.publicKeyBase64,
    expectedIssuer,
    'yucp-license-gate'
  );
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

export async function verifyProtectedUnlockJwtAgainstPinnedRoots(
  jwt: string,
  expectedIssuer: string
): Promise<ProtectedUnlockClaims | null> {
  return await verifyJwtWithPublicKeyResolver<ProtectedUnlockClaims>(
    jwt,
    (keyId) => getConfiguredYucpRootByKeyId(keyId)?.publicKeyBase64,
    expectedIssuer,
    'yucp-protected-unlock'
  );
}

export async function verifyYucpTrustBundleJwt(
  jwt: string,
  trustedRoots: readonly YucpPinnedRoot[],
  expectedIssuer: string
): Promise<YucpTrustBundleClaims | null> {
  return await verifyJwtWithPublicKeyResolver<YucpTrustBundleClaims>(
    jwt,
    (keyId) => getYucpRootByKeyId(trustedRoots, keyId)?.publicKeyBase64,
    expectedIssuer,
    TRUST_BUNDLE_AUDIENCE
  );
}

export async function resolvePinnedYucpSigningRoot(
  privateKeyBase64: string,
  configuredKeyId?: string | null
): Promise<YucpPinnedRoot> {
  const derivedPublicKey = await getPublicKeyFromPrivate(privateKeyBase64);
  const configuredRoots = getConfiguredYucpRoots();
  const matchingRoots = configuredRoots.filter(
    (root) => root.publicKeyBase64 === derivedPublicKey && root.algorithm === 'Ed25519'
  );

  if (matchingRoots.length === 0) {
    throw new Error('YUCP_ROOT_PRIVATE_KEY does not match any configured YUCP trust root');
  }

  const normalizedConfiguredKeyId = configuredKeyId?.trim();
  if (!normalizedConfiguredKeyId) {
    return (
      matchingRoots.find((root) => root.keyId === configuredRoots[0]?.keyId) ?? matchingRoots[0]
    );
  }

  const matchingConfiguredRoot = matchingRoots.find(
    (root) => root.keyId === normalizedConfiguredKeyId
  );
  if (!matchingConfiguredRoot) {
    throw new Error(
      `Configured YUCP root key ID '${normalizedConfiguredKeyId}' is not present in the active trust bundle`
    );
  }

  return matchingConfiguredRoot;
}
