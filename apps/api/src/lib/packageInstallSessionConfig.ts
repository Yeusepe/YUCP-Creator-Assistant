import { timingSafeEqual } from 'node:crypto';

export interface PackageInstallSessionConfig {
  audience: string;
  dpopNonceSecret: Uint8Array;
  issuer: string;
  keyId: string;
  privateKey: Uint8Array;
}

type PackageInstallSessionEnvironment = {
  PACKAGE_DELIVERY_AUDIENCE?: string;
  PACKAGE_INSTALL_DPOP_NONCE_SECRET?: string;
  PACKAGE_INSTALL_ISSUER?: string;
  PACKAGE_INSTALL_SIGNING_KEY_ID?: string;
  PACKAGE_INSTALL_SIGNING_PRIVATE_KEY?: string;
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function requireOrigin(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute origin`);
  }
  const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !loopbackHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an HTTPS or loopback HTTP origin`);
  }
  return parsed.origin;
}

export function loadPackageInstallSessionConfig(
  env: PackageInstallSessionEnvironment
): PackageInstallSessionConfig | null {
  const audience = env.PACKAGE_DELIVERY_AUDIENCE?.trim();
  const encodedDpopNonceSecret = env.PACKAGE_INSTALL_DPOP_NONCE_SECRET?.trim();
  const issuer = env.PACKAGE_INSTALL_ISSUER?.trim();
  const keyId = env.PACKAGE_INSTALL_SIGNING_KEY_ID?.trim();
  const encodedPrivateKey = env.PACKAGE_INSTALL_SIGNING_PRIVATE_KEY?.trim();
  const configuredCount = [
    audience,
    encodedDpopNonceSecret,
    issuer,
    keyId,
    encodedPrivateKey,
  ].filter(Boolean).length;
  if (configuredCount === 0) {
    return null;
  }
  if (configuredCount !== 5) {
    throw new Error(
      'PACKAGE_DELIVERY_AUDIENCE, PACKAGE_INSTALL_DPOP_NONCE_SECRET, PACKAGE_INSTALL_ISSUER, PACKAGE_INSTALL_SIGNING_KEY_ID, and PACKAGE_INSTALL_SIGNING_PRIVATE_KEY must be configured together'
    );
  }
  if (!keyId || new TextEncoder().encode(keyId).byteLength > 64) {
    throw new Error('PACKAGE_INSTALL_SIGNING_KEY_ID must contain 1 through 64 UTF-8 bytes');
  }

  let privateKey: Buffer;
  try {
    privateKey = Buffer.from(encodedPrivateKey as string, 'base64url');
  } catch {
    throw new Error('PACKAGE_INSTALL_SIGNING_PRIVATE_KEY must use base64url');
  }
  if (privateKey.byteLength !== 32 || privateKey.toString('base64url') !== encodedPrivateKey) {
    throw new Error('PACKAGE_INSTALL_SIGNING_PRIVATE_KEY must encode one 32-byte Ed25519 seed');
  }

  let dpopNonceSecret: Buffer;
  try {
    dpopNonceSecret = Buffer.from(encodedDpopNonceSecret as string, 'base64url');
  } catch {
    throw new Error('PACKAGE_INSTALL_DPOP_NONCE_SECRET must use base64url');
  }
  if (
    dpopNonceSecret.byteLength !== 32 ||
    dpopNonceSecret.toString('base64url') !== encodedDpopNonceSecret
  ) {
    throw new Error('PACKAGE_INSTALL_DPOP_NONCE_SECRET must encode 32 random bytes');
  }
  if (timingSafeEqual(dpopNonceSecret, privateKey)) {
    throw new Error('PACKAGE_INSTALL_DPOP_NONCE_SECRET must not reuse the package signing seed');
  }
  return {
    audience: requireOrigin(audience as string, 'PACKAGE_DELIVERY_AUDIENCE'),
    dpopNonceSecret: Uint8Array.from(dpopNonceSecret),
    issuer: requireOrigin(issuer as string, 'PACKAGE_INSTALL_ISSUER'),
    keyId,
    privateKey: Uint8Array.from(privateKey),
  };
}
