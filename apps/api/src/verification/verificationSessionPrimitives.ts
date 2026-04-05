/**
 * Shared PKCE, state, and redirect primitives for verification OAuth sessions.
 */

import { base64UrlEncode, bytesToHex, sha256Bytes } from '@yucp/shared/crypto';

export const SESSION_EXPIRY_MS = 15 * 60 * 1000;
export const PKCE_CODE_CHALLENGE_METHOD = 'S256';

const GUMROAD_VERIFICATION_STATE_PREFIX = 'verify_gumroad';
const PKCE_VERIFIER_PREFIX = 'pkce_verifier:';

/**
 * Generates a cryptographically secure random string.
 */
export function generateSecureRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Generates a cryptographically secure state parameter.
 */
export function generateState(): string {
  return generateSecureRandom(32);
}

/**
 * Generates a PKCE code verifier (43-128 characters).
 * RFC 7636 recommends 43-128 characters.
 */
export function generateCodeVerifier(): string {
  return generateSecureRandom(64);
}

/**
 * Computes PKCE code challenge from verifier.
 * code_challenge = BASE64URL(SHA256(code_verifier))
 */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256Bytes(verifier));
}

/**
 * Hashes the PKCE verifier for storage.
 * We store the hash, not the plaintext verifier.
 */
export async function hashVerifier(verifier: string): Promise<string> {
  return bytesToHex(await sha256Bytes(verifier));
}

export interface VerificationPkceBundle {
  codeVerifier: string;
  codeChallenge: string;
  verifierHash: string;
}

export async function createPkceBundle(): Promise<VerificationPkceBundle> {
  const codeVerifier = generateCodeVerifier();
  const [codeChallenge, verifierHash] = await Promise.all([
    computeCodeChallenge(codeVerifier),
    hashVerifier(codeVerifier),
  ]);
  return { codeVerifier, codeChallenge, verifierHash };
}

export function createVerificationState(authUserId: string, mode: string): string {
  const randomSuffix = generateSecureRandom(48);
  return mode === 'gumroad'
    ? `${GUMROAD_VERIFICATION_STATE_PREFIX}:${authUserId}:${randomSuffix}`
    : `${authUserId}:${randomSuffix}`;
}

export function parseVerificationState(state: string): { authUserId: string } | null {
  const parts = state.split(':');
  if (parts.length < 2) {
    return null;
  }

  return {
    authUserId: parts.length >= 3 ? (parts[1] ?? '') : (parts[0] ?? ''),
  };
}

export function getPkceVerifierStoreKey(state: string): string {
  return `${PKCE_VERIFIER_PREFIX}${state}`;
}

export function buildVerificationCallbackUri(
  baseUrl: string,
  mode: string,
  callbackPath: string
): string {
  return mode === 'gumroad'
    ? `${baseUrl}/api/connect/gumroad/callback`
    : `${baseUrl}${callbackPath}`;
}
