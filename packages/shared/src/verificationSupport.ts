import { createHash, randomUUID } from 'node:crypto';
import { generateCorrelationId, redactForLogging } from './logging';

const ENCODED_PREFIX = 'VFY1';
const PLAIN_PREFIX = 'VFY0';
const SUPPORT_TOKEN_VERSION = '1';
const MAX_ERROR_SUMMARY_LENGTH = 160;

type SupportCodeMode = 'encoded' | 'plain';

interface EncodedVerificationSupportTokenPayload {
  v: string;
  i: number;
  sf: string;
  st: string;
  t?: string;
  g?: string;
  d?: string;
  p?: string;
  a?: boolean;
  n?: string;
  e?: string;
}

export interface VerificationSupportTokenPayload {
  version: string;
  issuedAt: string;
  surface: string;
  stage: string;
  authUserId?: string;
  guildId?: string;
  discordUserId?: string;
  provider?: string;
  hadActivePanel?: boolean;
  errorName?: string;
  errorSummary?: string;
}

export interface VerificationSupportTokenInput {
  surface: string;
  stage: string;
  authUserId?: string | null;
  guildId?: string | null;
  discordUserId?: string | null;
  provider?: string | null;
  hadActivePanel?: boolean;
  errorName?: string | null;
  errorSummary?: string | null;
}

export interface EncodedVerificationSupportTokenResult {
  mode: SupportCodeMode;
  payload: VerificationSupportTokenPayload;
  supportCode: string;
}

export interface DecodedVerificationSupportTokenResult {
  mode: SupportCodeMode;
  payload?: VerificationSupportTokenPayload;
  supportCode: string;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4 || 4)) % 4;
  return new Uint8Array(Buffer.from(`${normalized}${'='.repeat(padLength)}`, 'base64'));
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = createHash('sha256').update(secret).digest();
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function normalizeField(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function sanitizeVerificationSupportErrorSummary(error: unknown): string | undefined {
  let message: string | undefined;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else if (error && typeof error === 'object' && 'message' in error) {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string') {
      message = maybeMessage;
    }
  }

  const normalized = message
    ?.replace(/\s+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  if (!normalized) return undefined;

  const redacted = String(redactForLogging(normalized));
  if (redacted.length <= MAX_ERROR_SUMMARY_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_ERROR_SUMMARY_LENGTH - 1)}…`;
}

export function resolveVerificationSupportSecret(secret?: string | null): string | undefined {
  return (
    normalizeField(secret) ??
    normalizeField(process.env.ERROR_REFERENCE_SECRET) ??
    normalizeField(process.env.BETTER_AUTH_SECRET)
  );
}

export function buildVerificationSupportPayload(
  input: VerificationSupportTokenInput
): VerificationSupportTokenPayload {
  return {
    version: SUPPORT_TOKEN_VERSION,
    issuedAt: new Date().toISOString(),
    surface: input.surface,
    stage: input.stage,
    authUserId: normalizeField(input.authUserId ?? undefined),
    guildId: normalizeField(input.guildId ?? undefined),
    discordUserId: normalizeField(input.discordUserId ?? undefined),
    provider: normalizeField(input.provider ?? undefined),
    hadActivePanel: input.hadActivePanel,
    errorName: normalizeField(input.errorName ?? undefined),
    errorSummary: normalizeField(input.errorSummary ?? undefined),
  };
}

function encodePayloadForToken(
  payload: VerificationSupportTokenPayload
): EncodedVerificationSupportTokenPayload {
  return {
    v: payload.version,
    i: Date.parse(payload.issuedAt),
    sf: payload.surface,
    st: payload.stage,
    t: payload.authUserId,
    g: payload.guildId,
    d: payload.discordUserId,
    p: payload.provider,
    a: payload.hadActivePanel,
    n: payload.errorName,
    e: payload.errorSummary,
  };
}

function decodePayloadFromToken(
  payload: EncodedVerificationSupportTokenPayload
): VerificationSupportTokenPayload {
  return {
    version: payload.v,
    issuedAt: new Date(payload.i).toISOString(),
    surface: payload.sf,
    stage: payload.st,
    authUserId: payload.t,
    guildId: payload.g,
    discordUserId: payload.d,
    provider: payload.p,
    hadActivePanel: payload.a,
    errorName: payload.n,
    errorSummary: payload.e,
  };
}

export async function encodeVerificationSupportToken(
  input: VerificationSupportTokenInput,
  options?: { secret?: string | null }
): Promise<EncodedVerificationSupportTokenResult> {
  const payload = buildVerificationSupportPayload(input);
  const secret = resolveVerificationSupportSecret(options?.secret);

  if (!secret) {
    return {
      mode: 'plain',
      payload,
      supportCode: `${PLAIN_PREFIX}-${generateCorrelationId()}`,
    };
  }

  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(encodePayloadForToken(payload)));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return {
    mode: 'encoded',
    payload,
    supportCode: `${ENCODED_PREFIX}-${toBase64Url(combined)}`,
  };
}

export async function decodeVerificationSupportToken(
  supportCode: string,
  options?: { secret?: string | null }
): Promise<DecodedVerificationSupportTokenResult> {
  const trimmed = supportCode.trim();

  if (trimmed.startsWith(`${PLAIN_PREFIX}-`)) {
    return {
      mode: 'plain',
      supportCode: trimmed,
    };
  }

  if (!trimmed.startsWith(`${ENCODED_PREFIX}-`)) {
    throw new Error('Unsupported verification support token format.');
  }

  const secret = resolveVerificationSupportSecret(options?.secret);
  if (!secret) {
    throw new Error(
      'ERROR_REFERENCE_SECRET or BETTER_AUTH_SECRET is required to decode this token.'
    );
  }

  const key = await deriveKey(secret);
  const combined = fromBase64Url(trimmed.slice(`${ENCODED_PREFIX}-`.length));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  if (iv.length !== 12 || ciphertext.length === 0) {
    throw new Error('Verification support token is malformed.');
  }

  let decrypted: string;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    decrypted = new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('Verification support token could not be decrypted.');
  }

  const parsed = JSON.parse(decrypted) as Partial<EncodedVerificationSupportTokenPayload>;
  if (
    typeof parsed.v !== 'string' ||
    typeof parsed.i !== 'number' ||
    typeof parsed.sf !== 'string' ||
    typeof parsed.st !== 'string'
  ) {
    throw new Error('Verification support token payload is invalid.');
  }

  return {
    mode: 'encoded',
    supportCode: trimmed,
    payload: decodePayloadFromToken(parsed as EncodedVerificationSupportTokenPayload),
  };
}

export function getVerificationSupportErrorDetails(error: unknown): {
  errorName?: string;
  errorSummary?: string;
} {
  const errorName = error instanceof Error ? normalizeField(error.name) : undefined;

  return {
    errorName,
    errorSummary: sanitizeVerificationSupportErrorSummary(error),
  };
}

export function formatVerificationSupportMessage(prefix: string, supportCode: string): string {
  return `${prefix}\n\nSupport code: \`${supportCode}\``;
}

export function createPlainVerificationSupportCode(): string {
  return `${PLAIN_PREFIX}-${randomUUID()}`;
}
