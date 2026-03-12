/**
 * YUCP Certificate Authority — Ed25519 signing utilities.
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

/**
 * Create a signed license JWT (EdDSA / Ed25519).
 * The client can parse the payload without signature verification — security
 * relies on: valid token only obtainable via server license check, machine
 * fingerprint binding, short TTL, and HMAC-authenticated on-disk cache.
 */
export async function signLicenseJwt(
  claims: LicenseClaims,
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
