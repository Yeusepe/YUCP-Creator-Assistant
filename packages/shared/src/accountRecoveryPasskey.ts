const RECOVERY_CONTEXT_VERSION = 'v1';
const RECOVERY_CONTEXT_PURPOSE = 'account-recovery-passkey';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type RecoveryContextMethod =
  | 'primary-email-otp'
  | 'recovery-email-otp'
  | 'backup-code'
  | 'support-review';

export interface RecoveryPasskeyContextPayload {
  authUserId: string;
  method: RecoveryContextMethod;
  expiresAt: number;
  issuedAt: number;
  nonce: string;
}

const RECOVERY_CONTEXT_METHODS: readonly RecoveryContextMethod[] = [
  'primary-email-otp',
  'recovery-email-otp',
  'backup-code',
  'support-review',
];

function isRecoveryContextMethod(value: unknown): value is RecoveryContextMethod {
  return (
    typeof value === 'string' && RECOVERY_CONTEXT_METHODS.includes(value as RecoveryContextMethod)
  );
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
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

async function verifyPayloadSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  return crypto.subtle.verify(
    'HMAC',
    key,
    toArrayBuffer(fromBase64Url(signature)),
    encoder.encode(payload)
  );
}

export async function issueRecoveryPasskeyContext(
  payload: RecoveryPasskeyContextPayload,
  secret: string
): Promise<string> {
  const serializedPayload = JSON.stringify({
    ...payload,
    purpose: RECOVERY_CONTEXT_PURPOSE,
    version: RECOVERY_CONTEXT_VERSION,
  });
  const encodedPayload = toBase64Url(encoder.encode(serializedPayload));
  const signature = await signPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function verifyRecoveryPasskeyContext(
  token: string,
  secret: string,
  now = Date.now()
): Promise<RecoveryPasskeyContextPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return null;
  }

  const isValidSignature = await verifyPayloadSignature(encodedPayload, signature, secret);
  if (!isValidSignature) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      decoder.decode(fromBase64Url(encodedPayload))
    ) as RecoveryPasskeyContextPayload & {
      purpose?: string;
      version?: string;
    };

    if (
      parsed.purpose !== RECOVERY_CONTEXT_PURPOSE ||
      parsed.version !== RECOVERY_CONTEXT_VERSION ||
      typeof parsed.authUserId !== 'string' ||
      !parsed.authUserId.trim() ||
      !isRecoveryContextMethod(parsed.method) ||
      typeof parsed.expiresAt !== 'number' ||
      typeof parsed.issuedAt !== 'number' ||
      typeof parsed.nonce !== 'string' ||
      !parsed.nonce.trim()
    ) {
      return null;
    }

    if (parsed.expiresAt <= now || parsed.issuedAt > now + 60_000) {
      return null;
    }

    return {
      authUserId: parsed.authUserId,
      method: parsed.method,
      expiresAt: parsed.expiresAt,
      issuedAt: parsed.issuedAt,
      nonce: parsed.nonce,
    };
  } catch {
    return null;
  }
}
