export interface PackageInstallSessionConfig {
  audience: string;
  keyId: string;
  privateKey: Uint8Array;
}

type PackageInstallSessionEnvironment = {
  PACKAGE_DELIVERY_AUDIENCE?: string;
  PACKAGE_INSTALL_SIGNING_KEY_ID?: string;
  PACKAGE_INSTALL_SIGNING_PRIVATE_KEY?: string;
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function requireOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PACKAGE_DELIVERY_AUDIENCE must be an absolute origin');
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
    throw new Error('PACKAGE_DELIVERY_AUDIENCE must be an HTTPS or loopback HTTP origin');
  }
  return parsed.origin;
}

export function loadPackageInstallSessionConfig(
  env: PackageInstallSessionEnvironment
): PackageInstallSessionConfig | null {
  const audience = env.PACKAGE_DELIVERY_AUDIENCE?.trim();
  const keyId = env.PACKAGE_INSTALL_SIGNING_KEY_ID?.trim();
  const encodedPrivateKey = env.PACKAGE_INSTALL_SIGNING_PRIVATE_KEY?.trim();
  const configuredCount = [audience, keyId, encodedPrivateKey].filter(Boolean).length;
  if (configuredCount === 0) {
    return null;
  }
  if (configuredCount !== 3) {
    throw new Error(
      'PACKAGE_DELIVERY_AUDIENCE, PACKAGE_INSTALL_SIGNING_KEY_ID, and PACKAGE_INSTALL_SIGNING_PRIVATE_KEY must be configured together'
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
  return {
    audience: requireOrigin(audience as string),
    keyId,
    privateKey: Uint8Array.from(privateKey),
  };
}
