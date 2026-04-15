import { base64ToBytes, bytesToBase64, bytesToHex, timingSafeStringEqual } from './crypto';

export const API_ACTOR_TTL_MS = 5 * 60 * 1000;
const API_ACTOR_PREFIX = 'yucp-api-actor.v1';
const API_ACTOR_VERSION = 1;
const API_ACTOR_MAX_CLOCK_SKEW_MS = 30 * 1000;
const API_ACTOR_MAX_PAYLOAD_LENGTH = 4_096;
const API_ACTOR_SIGNATURE_HEX_LENGTH = 64;
const API_ACTOR_SIGNATURE_HEX_RE = /^[0-9a-f]{64}$/i;
const apiActorSigningKeys = new Map<string, Promise<CryptoKey>>();

export type ApiActorScope =
  | 'creator:delegate'
  | 'downloads:service'
  | 'entitlements:service'
  | 'manual-licenses:service'
  | 'subjects:service'
  | 'verification-intents:service'
  | 'verification-sessions:service';

export interface ApiActorBinding {
  payload: string;
  signature: string;
}

export interface AuthUserApiActor {
  version: 1;
  kind: 'auth_user';
  authUserId: string;
  source: 'api_key' | 'oauth' | 'session';
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  keyId?: string;
}

export interface ServiceApiActor {
  version: 1;
  kind: 'service';
  service: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  authUserId?: string;
}

export type ApiActor = AuthUserApiActor | ServiceApiActor;

export const API_ACTOR_PROTECTED_MODULE_PREFIXES = [
  'downloads.',
  'entitlements.',
  'manualLicenses.',
  'packageRegistry.',
  'subjects.',
  'verificationIntents.',
  'verificationSessions.',
] as const;

function getNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeValue(entry));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, canonicalizeValue(entryValue)])
    );
  }
  return value;
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!value || /[^A-Za-z0-9\-_]/.test(value)) {
    return null;
  }

  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  const padded =
    padding === 0 ? normalized : normalized.padEnd(normalized.length + (4 - padding), '=');

  try {
    return base64ToBytes(padded);
  } catch {
    return null;
  }
}

function normalizeAuthUserActor(actor: AuthUserApiActor): AuthUserApiActor {
  return {
    version: API_ACTOR_VERSION,
    kind: 'auth_user',
    authUserId: actor.authUserId.trim(),
    source: actor.source,
    scopes: normalizeScopes(actor.scopes),
    issuedAt: actor.issuedAt,
    expiresAt: actor.expiresAt,
    keyId: getNonEmptyString(actor.keyId),
  };
}

function normalizeServiceActor(actor: ServiceApiActor): ServiceApiActor {
  return {
    version: API_ACTOR_VERSION,
    kind: 'service',
    service: actor.service.trim(),
    scopes: normalizeScopes(actor.scopes),
    issuedAt: actor.issuedAt,
    expiresAt: actor.expiresAt,
    authUserId: getNonEmptyString(actor.authUserId),
  };
}

function normalizeApiActor(actor: ApiActor): ApiActor {
  return actor.kind === 'auth_user' ? normalizeAuthUserActor(actor) : normalizeServiceActor(actor);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseApiActorPayload(payload: string): ApiActor | null {
  const decoded = fromBase64Url(payload);
  if (!decoded) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }

  const record = parseJsonRecord(parsed);
  if (!record) {
    return null;
  }

  const version = record.version;
  const kind = record.kind;
  const issuedAt = getFiniteNumber(record.issuedAt);
  const expiresAt = getFiniteNumber(record.expiresAt);

  if (
    version !== API_ACTOR_VERSION ||
    issuedAt === undefined ||
    expiresAt === undefined ||
    issuedAt > expiresAt
  ) {
    return null;
  }

  if (kind === 'auth_user') {
    const authUserId = getNonEmptyString(record.authUserId);
    const source = record.source;
    if (!authUserId || (source !== 'api_key' && source !== 'oauth' && source !== 'session')) {
      return null;
    }

    return normalizeAuthUserActor({
      version: API_ACTOR_VERSION,
      kind: 'auth_user',
      authUserId,
      source,
      scopes: Array.isArray(record.scopes)
        ? record.scopes.filter((entry): entry is string => typeof entry === 'string')
        : [],
      issuedAt,
      expiresAt,
      keyId: getNonEmptyString(record.keyId),
    });
  }

  if (kind === 'service') {
    const service = getNonEmptyString(record.service);
    if (!service) {
      return null;
    }

    return normalizeServiceActor({
      version: API_ACTOR_VERSION,
      kind: 'service',
      service,
      scopes: Array.isArray(record.scopes)
        ? record.scopes.filter((entry): entry is string => typeof entry === 'string')
        : [],
      issuedAt,
      expiresAt,
      authUserId: getNonEmptyString(record.authUserId),
    });
  }

  return null;
}

export function serializeApiActorPayload(actor: ApiActor): string {
  const normalized = normalizeApiActor(actor);
  return toBase64Url(new TextEncoder().encode(JSON.stringify(canonicalizeValue(normalized))));
}

async function signApiActorValue(secret: string, value: string): Promise<string> {
  let keyPromise = apiActorSigningKeys.get(secret);
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    apiActorSigningKeys.set(secret, keyPromise);
  }
  const key = await keyPromise;
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(signature));
}

export async function createApiActorBinding(
  actor: ApiActor,
  secret: string
): Promise<ApiActorBinding> {
  const payload = serializeApiActorPayload(actor);
  const signature = await signApiActorValue(secret, `${API_ACTOR_PREFIX}.${payload}`);
  return { payload, signature };
}

export async function verifyApiActorBinding(
  binding: ApiActorBinding,
  secret: string,
  now = Date.now()
): Promise<ApiActor | null> {
  const payload = getNonEmptyString(binding.payload);
  const signature = getNonEmptyString(binding.signature);
  if (
    !payload ||
    payload.length > API_ACTOR_MAX_PAYLOAD_LENGTH ||
    !signature ||
    !API_ACTOR_SIGNATURE_HEX_RE.test(signature) ||
    signature.length !== API_ACTOR_SIGNATURE_HEX_LENGTH
  ) {
    return null;
  }

  const actor = parseApiActorPayload(payload);
  if (!actor) {
    return null;
  }

  const expectedSignature = await signApiActorValue(secret, `${API_ACTOR_PREFIX}.${payload}`);
  if (!timingSafeStringEqual(signature, expectedSignature)) {
    return null;
  }

  if (actor.issuedAt > now + API_ACTOR_MAX_CLOCK_SKEW_MS) {
    return null;
  }
  if (actor.expiresAt < now - API_ACTOR_MAX_CLOCK_SKEW_MS) {
    return null;
  }

  return actor;
}

export function createAuthUserApiActor(input: {
  authUserId: string;
  source: AuthUserApiActor['source'];
  scopes?: readonly string[];
  keyId?: string;
  now?: number;
  ttlMs?: number;
}): AuthUserApiActor {
  const now = input.now ?? Date.now();
  return normalizeAuthUserActor({
    version: API_ACTOR_VERSION,
    kind: 'auth_user',
    authUserId: input.authUserId,
    source: input.source,
    scopes: Array.from(input.scopes ?? []),
    issuedAt: now,
    expiresAt: now + (input.ttlMs ?? API_ACTOR_TTL_MS),
    keyId: input.keyId,
  });
}

export function createServiceApiActor(input: {
  service: string;
  scopes: readonly string[];
  authUserId?: string;
  now?: number;
  ttlMs?: number;
}): ServiceApiActor {
  const now = input.now ?? Date.now();
  return normalizeServiceActor({
    version: API_ACTOR_VERSION,
    kind: 'service',
    service: input.service,
    scopes: Array.from(input.scopes),
    issuedAt: now,
    expiresAt: now + (input.ttlMs ?? API_ACTOR_TTL_MS),
    authUserId: input.authUserId,
  });
}

export function isApiActorProtectedFunction(functionName: string): boolean {
  const normalized = functionName.replace(/:/g, '.');
  return API_ACTOR_PROTECTED_MODULE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
