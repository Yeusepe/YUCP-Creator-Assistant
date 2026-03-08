import { decrypt, encrypt } from '../lib/encrypt';
import type { StateStore } from '../lib/stateStore';
import type { TwoFactorAuthType } from '@yucp/providers';

const PENDING_COOKIE_NAME = 'yucp_vrchat_pending';
const PENDING_STATE_PREFIX = 'vrchat_pending:';
const PENDING_STATE_TTL_MS = 5 * 60 * 1000;

export interface VrchatPendingState {
  verificationToken: string;
  pendingState: string;
  types: TwoFactorAuthType[];
  createdAt: number;
  expiresAt: number;
}

function getPendingSecret(): string {
  const secret = process.env.VRCHAT_PENDING_STATE_SECRET;
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV !== 'production' && process.env.BETTER_AUTH_SECRET) {
    return process.env.BETTER_AUTH_SECRET;
  }
  throw new Error('VRCHAT_PENDING_STATE_SECRET is required');
}

function parseCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(';')) {
    const [rawName, ...rest] = entry.trim().split('=');
    if (rawName === name) {
      return rest.join('=');
    }
  }
  return null;
}

function buildCookie(request: Request, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${PENDING_COOKIE_NAME}=${value}`,
    'Path=/api/verification/vrchat-verify',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (new URL(request.url).protocol === 'https:') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function appendClearedPendingCookie(headers: Headers, request: Request): void {
  headers.append('Set-Cookie', buildCookie(request, '', 0));
}

export async function createPendingVrchatState(
  store: StateStore,
  request: Request,
  payload: Omit<VrchatPendingState, 'createdAt' | 'expiresAt'>
): Promise<string> {
  const now = Date.now();
  const state: VrchatPendingState = {
    ...payload,
    createdAt: now,
    expiresAt: now + PENDING_STATE_TTL_MS,
  };
  const id = crypto.randomUUID();
  const encrypted = await encrypt(JSON.stringify(state), getPendingSecret());
  await store.set(`${PENDING_STATE_PREFIX}${id}`, encrypted, PENDING_STATE_TTL_MS);
  return buildCookie(request, id, Math.floor(PENDING_STATE_TTL_MS / 1000));
}

export async function readPendingVrchatState(
  store: StateStore,
  request: Request,
  verificationToken: string
): Promise<{ id: string; state: VrchatPendingState } | null> {
  const pendingId = parseCookieValue(request.headers.get('cookie'), PENDING_COOKIE_NAME);
  if (!pendingId) {
    return null;
  }

  const encrypted = await store.get(`${PENDING_STATE_PREFIX}${pendingId}`);
  if (!encrypted) {
    return null;
  }

  try {
    const decrypted = await decrypt(encrypted, getPendingSecret());
    const state = JSON.parse(decrypted) as Partial<VrchatPendingState>;
    const validTypes = Array.isArray(state.types)
      ? state.types.filter(
        (type): type is TwoFactorAuthType =>
          type === 'totp' || type === 'emailOtp' || type === 'otp'
      )
      : [];

    if (
      typeof state.pendingState !== 'string'
      || typeof state.verificationToken !== 'string'
      || state.verificationToken !== verificationToken
      || typeof state.createdAt !== 'number'
      || typeof state.expiresAt !== 'number'
      || state.expiresAt < Date.now()
      || validTypes.length === 0
    ) {
      return null;
    }

    return {
      id: pendingId,
      state: {
        verificationToken: state.verificationToken,
        pendingState: state.pendingState,
        types: validTypes,
        createdAt: state.createdAt,
        expiresAt: state.expiresAt,
      },
    };
  } catch {
    return null;
  }
}

export async function clearPendingVrchatState(
  store: StateStore,
  request: Request,
  headers?: Headers
): Promise<void> {
  const pendingId = parseCookieValue(request.headers.get('cookie'), PENDING_COOKIE_NAME);
  if (pendingId) {
    await store.delete(`${PENDING_STATE_PREFIX}${pendingId}`);
  }
  if (headers) {
    appendClearedPendingCookie(headers, request);
  }
}
