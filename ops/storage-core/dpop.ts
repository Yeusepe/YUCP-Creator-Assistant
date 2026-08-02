// RFC 9449 defines DPoP proof claims and verification.
// Reference: https://www.rfc-editor.org/rfc/rfc9449#section-4.3
// RFC 7638 defines the JWK thumbprint calculation.
// Reference: https://www.rfc-editor.org/rfc/rfc7638#section-3
// Cloudflare documents ECDSA support through the Workers Web Crypto API.
// Reference: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_PROOF_LENGTH = 8_192;
const DEFAULT_CLOCK_WINDOW_SECONDS = 300;
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const textEncoder = new TextEncoder();

type JsonObject = Record<string, unknown>;

export type VerifiedDpopProof = {
  iat: number;
  jti: string;
  nonceBound: boolean;
  thumbprint: Uint8Array;
};

export interface DpopReplayStore {
  reserve(input: { expiresAt: Date; key: string; now: Date }): boolean | Promise<boolean>;
}

export interface DpopNonceVerifier {
  verify(nonce: string, now?: Date): Promise<{ expiresAt: Date } | null>;
}

export class DpopNonceRequiredError extends Error {
  readonly proofClockOffsetSeconds: number;

  constructor(proofClockOffsetSeconds: number) {
    super('DPoP proof requires a server nonce');
    this.name = 'DpopNonceRequiredError';
    this.proofClockOffsetSeconds = proofClockOffsetSeconds;
  }
}

function decodeBase64Url(value: string, name: string): Uint8Array {
  if (!value || !BASE64URL.test(value)) {
    throw new Error(`${name} must use unpadded base64url`);
  }
  let decoded: string;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  } catch {
    throw new Error(`${name} is not valid base64url`);
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function parseBase64UrlJson(value: string, name: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(decodeBase64Url(value, name)));
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function requireText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value || textEncoder.encode(value).byteLength > maxBytes) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireP256PublicJwk(value: unknown): JsonWebKey & {
  crv: 'P-256';
  kty: 'EC';
  x: string;
  y: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DPoP JWK is invalid');
  }
  const jwk = value as JsonObject;
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string' ||
    'd' in jwk
  ) {
    throw new Error('DPoP JWK must be a public P-256 key');
  }
  for (const [name, coordinate] of [
    ['x', jwk.x],
    ['y', jwk.y],
  ] as const) {
    if (!BASE64URL.test(coordinate) || decodeBase64Url(coordinate, name).byteLength !== 32) {
      throw new Error(`DPoP JWK ${name} coordinate is invalid`);
    }
  }
  return {
    crv: 'P-256',
    kty: 'EC',
    x: jwk.x,
    y: jwk.y,
  };
}

function canonicalTargetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DPoP target URL is invalid');
  }
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password
  ) {
    throw new Error('DPoP target URL must use HTTPS or loopback HTTP');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export async function verifyDpopProof(input: {
  acceptedFutureSkewSeconds?: number;
  accessToken: string;
  clockWindowSeconds?: number;
  expectedThumbprint?: Uint8Array;
  method: string;
  nonceVerifier?: DpopNonceVerifier;
  now?: Date;
  proof: string;
  replayStore?: DpopReplayStore;
  url: string;
}): Promise<VerifiedDpopProof> {
  if (!input.proof || input.proof.length > MAX_PROOF_LENGTH) {
    throw new Error('DPoP proof length is invalid');
  }
  const parts = input.proof.split('.');
  if (parts.length !== 3 || parts.some((part) => !part || !BASE64URL.test(part))) {
    throw new Error('DPoP proof must be one compact JWS');
  }
  const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = parts;
  const header = parseBase64UrlJson(encodedHeader, 'DPoP protected header');
  const payload = parseBase64UrlJson(encodedPayload, 'DPoP payload');
  if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256') {
    throw new Error('DPoP protected header is not an accepted proof type');
  }
  const jwk = requireP256PublicJwk(header.jwk);
  const signature = decodeBase64Url(encodedSignature, 'DPoP signature');
  if (signature.byteLength !== 64) {
    throw new Error('DPoP signature length is invalid');
  }
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  if (
    !(await crypto.subtle.verify(
      { hash: 'SHA-256', name: 'ECDSA' },
      publicKey,
      copyArrayBuffer(signature),
      textEncoder.encode(`${encodedHeader}.${encodedPayload}`)
    ))
  ) {
    throw new Error('DPoP signature is invalid');
  }
  if (payload.htm !== input.method.toUpperCase()) {
    throw new Error('DPoP HTTP method does not match');
  }
  const expectedUrl = canonicalTargetUrl(input.url);
  const proofUrl = canonicalTargetUrl(requireText(payload.htu, 'DPoP htu', 2_048));
  if (proofUrl !== expectedUrl) {
    throw new Error('DPoP target URL does not match');
  }
  const iat = payload.iat;
  if (!Number.isSafeInteger(iat) || Number(iat) < 0) {
    throw new Error('DPoP creation time is invalid');
  }
  const clockWindowSeconds = input.clockWindowSeconds ?? DEFAULT_CLOCK_WINDOW_SECONDS;
  const acceptedFutureSkewSeconds = input.acceptedFutureSkewSeconds ?? clockWindowSeconds;
  if (
    !Number.isSafeInteger(clockWindowSeconds) ||
    clockWindowSeconds < 1 ||
    clockWindowSeconds > DEFAULT_CLOCK_WINDOW_SECONDS ||
    !Number.isSafeInteger(acceptedFutureSkewSeconds) ||
    acceptedFutureSkewSeconds < 0 ||
    acceptedFutureSkewSeconds > DEFAULT_CLOCK_WINDOW_SECONDS
  ) {
    throw new Error('DPoP clock window is invalid');
  }
  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (!Number.isFinite(nowSeconds)) {
    throw new Error('DPoP verification time is invalid');
  }
  const expectedAth = new Uint8Array(
    await crypto.subtle.digest('SHA-256', textEncoder.encode(input.accessToken))
  );
  const actualAth = decodeBase64Url(
    requireText(payload.ath, 'DPoP access token hash', 64),
    'DPoP access token hash'
  );
  if (!constantTimeBytesEqual(actualAth, expectedAth)) {
    throw new Error('DPoP access token hash does not match');
  }
  const jti = requireText(payload.jti, 'DPoP proof identifier', 128);
  const thumbprint = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      textEncoder.encode(
        JSON.stringify({
          crv: jwk.crv,
          kty: jwk.kty,
          x: jwk.x,
          y: jwk.y,
        })
      )
    )
  );
  if (input.expectedThumbprint && !constantTimeBytesEqual(thumbprint, input.expectedThumbprint)) {
    throw new Error('DPoP proof key does not match the bound token');
  }

  const proofClockOffsetSeconds = Number(iat) - nowSeconds;
  let nonceBound = false;
  let replayExpiresAt = new Date((Number(iat) + clockWindowSeconds) * 1_000);
  // A valid server nonce supplies freshness independently of the client's clock, per RFC 9449
  // section 11.1. All other proof bindings and the shared jti replay reservation remain required.
  if (input.nonceVerifier && payload.nonce !== undefined) {
    const nonce = requireText(payload.nonce, 'DPoP nonce', 512);
    const verification = await input.nonceVerifier.verify(nonce, now);
    if (
      !verification ||
      !Number.isFinite(verification.expiresAt.getTime()) ||
      verification.expiresAt.getTime() <= now.getTime()
    ) {
      throw new DpopNonceRequiredError(proofClockOffsetSeconds);
    }
    nonceBound = true;
    replayExpiresAt = verification.expiresAt;
  }
  if (
    !nonceBound &&
    (nowSeconds - Number(iat) > clockWindowSeconds ||
      proofClockOffsetSeconds > acceptedFutureSkewSeconds)
  ) {
    // Nonce-less proofs remain the normal path while iat is inside the asymmetric clock window.
    // Only otherwise-valid proofs outside that window receive a server-time nonce challenge.
    if (input.nonceVerifier) {
      throw new DpopNonceRequiredError(proofClockOffsetSeconds);
    }
    throw new Error('DPoP proof is outside the permitted clock window');
  }
  if (input.replayStore) {
    const replayInput = `${encodeBase64Url(thumbprint)}\n${input.method.toUpperCase()}\n${expectedUrl}\n${jti}`;
    const replayKey = encodeBase64Url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(replayInput)))
    );
    if (!(await input.replayStore.reserve({ expiresAt: replayExpiresAt, key: replayKey, now }))) {
      throw new Error('DPoP proof identifier has already been used');
    }
  }
  return { iat: Number(iat), jti, nonceBound, thumbprint };
}

export async function dpopAccessTokenHash(accessToken: string): Promise<string> {
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(accessToken)))
  );
}
