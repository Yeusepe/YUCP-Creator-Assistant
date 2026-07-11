import { buildCookie, clearCookie, getCookieValue } from './browserSessions';
import { decrypt, encrypt } from './encrypt';
import type { StateStore } from './stateStore';

const PENDING_STATE_TTL_MS = 5 * 60 * 1000;

export type TimestampedPendingState<TPayload extends object> = TPayload & {
  createdAt: number;
  expiresAt: number;
};

export interface EncryptedPendingStateConfig<
  TPayload extends object,
  TValidationArgs extends unknown[],
> {
  cookieName: string;
  cookiePath: string;
  storagePrefix: string;
  purpose: string;
  payloadValidator: (value: unknown, ...args: TValidationArgs) => TPayload | null;
}

function getPendingSecret(): string {
  const secret = process.env.VRCHAT_PENDING_STATE_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV !== 'production' && process.env.BETTER_AUTH_SECRET) {
    return process.env.BETTER_AUTH_SECRET;
  }
  throw new Error('VRCHAT_PENDING_STATE_SECRET is required');
}

export function createEncryptedPendingState<
  TPayload extends object,
  TValidationArgs extends unknown[] = [],
>(config: EncryptedPendingStateConfig<TPayload, TValidationArgs>) {
  type State = TimestampedPendingState<TPayload>;

  function appendClearedCookie(headers: Headers, request: Request): void {
    headers.append(
      'Set-Cookie',
      clearCookie(config.cookieName, request, { path: config.cookiePath })
    );
  }

  async function create(store: StateStore, request: Request, payload: TPayload): Promise<string> {
    const now = Date.now();
    const state: State = {
      ...payload,
      createdAt: now,
      expiresAt: now + PENDING_STATE_TTL_MS,
    };
    const id = crypto.randomUUID();
    const encrypted = await encrypt(JSON.stringify(state), getPendingSecret(), config.purpose);
    await store.set(`${config.storagePrefix}${id}`, encrypted, PENDING_STATE_TTL_MS);
    return buildCookie(config.cookieName, id, request, {
      path: config.cookiePath,
      maxAgeSeconds: Math.floor(PENDING_STATE_TTL_MS / 1000),
    });
  }

  async function read(
    store: StateStore,
    request: Request,
    ...validationArgs: TValidationArgs
  ): Promise<{ id: string; state: State } | null> {
    const pendingId = getCookieValue(request, config.cookieName);
    if (!pendingId) return null;

    const encrypted = await store.get(`${config.storagePrefix}${pendingId}`);
    if (!encrypted) return null;

    try {
      const decrypted = await decrypt(encrypted, getPendingSecret(), config.purpose);
      const value = JSON.parse(decrypted) as unknown;
      const payload = config.payloadValidator(value, ...validationArgs);
      const state = value as Partial<State>;
      const { createdAt, expiresAt } = state;
      if (
        !payload ||
        typeof createdAt !== 'number' ||
        typeof expiresAt !== 'number' ||
        expiresAt < Date.now()
      ) {
        return null;
      }

      return {
        id: pendingId,
        state: {
          ...payload,
          createdAt,
          expiresAt,
        },
      };
    } catch {
      return null;
    }
  }

  async function clear(store: StateStore, request: Request, headers?: Headers): Promise<void> {
    const pendingId = getCookieValue(request, config.cookieName);
    if (pendingId) {
      await store.delete(`${config.storagePrefix}${pendingId}`);
    }
    if (headers) {
      appendClearedCookie(headers, request);
    }
  }

  return { appendClearedCookie, create, read, clear };
}
