import { issueRecoveryPasskeyContext, type RecoveryContextMethod, sha256Hex } from '@yucp/shared';
import { normalizeEmail } from '@yucp/shared/crypto';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import type { BackupCodeOptions } from 'better-auth/plugins';
import { ConvexError, v } from 'convex/values';
import { components } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, mutation, query } from './_generated/server';
import {
  BETTER_AUTH_BACKUP_CODE_OPTIONS,
  RECOVERY_PASSKEY_CONTEXT_TTL_MS,
} from './lib/accountSecurityConfig';
import { requireApiSecret } from './lib/apiAuth';
import { getAuthenticatedAuthUser } from './lib/authUser';
import {
  buildBetterAuthEqualityWhere,
  buildBetterAuthUserLookupWhere,
} from './lib/betterAuthAdapter';
import { PII_PURPOSES } from './lib/credentialKeys';
import { encryptPii } from './lib/piiCrypto';
import { decryptForPurpose } from './lib/vrchat/crypto';

const RECOVERY_CONTACT_KIND = 'recovery_email' as const;
const RECOVERY_CONTACT_STATUS = {
  pending: 'pending',
  verified: 'verified',
  compromised: 'compromised',
  removed: 'removed',
} as const;
const RECOVERY_SESSION_STATUS = {
  pending: 'pending',
  verified: 'verified',
  completed: 'completed',
  cancelled: 'cancelled',
  expired: 'expired',
} as const;
const RECOVERY_EMAIL_SESSION_TTL_MS = 10 * 60 * 1000;
const RECOVERY_BACKUP_CODE_MAX_ATTEMPTS = 5;
const RECOVERY_PROMPT_BASE_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;
const RECOVERY_PROMPT_JITTER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const RECOVERY_PROMPT_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

type RecoveryDeliveryMethod =
  | 'primary-email-otp'
  | 'recovery-email-otp'
  | 'backup-code'
  | 'support-review';

type BetterAuthUserRecord = {
  _id?: string;
  id?: string;
  name?: string | null;
  email?: string | null;
  emailVerified?: boolean | null;
  image?: string | null;
};

type BetterAuthPasskeyRecord = {
  _id?: string;
  id?: string;
  userId?: string;
  name?: string | null;
  credentialID?: string;
  deviceType?: string;
  backedUp?: boolean;
  createdAt?: number | Date | null;
};

type BetterAuthTwoFactorRecord = {
  _id?: string;
  id?: string;
  userId?: string;
  backupCodes?: string;
  verified?: boolean | null;
};

async function encodeBackupCodesForStorage(
  codes: string[],
  secret: string,
  options?: BackupCodeOptions
) {
  const json = JSON.stringify(codes);

  if (options?.storeBackupCodes === 'encrypted') {
    return symmetricEncrypt({
      data: json,
      key: secret,
    });
  }

  if (typeof options?.storeBackupCodes === 'object' && 'encrypt' in options.storeBackupCodes) {
    return options.storeBackupCodes.encrypt(json);
  }

  return json;
}

async function getBackupCodesFromStorage(
  backupCodes: string,
  secret: string,
  options?: BackupCodeOptions
) {
  try {
    if (options?.storeBackupCodes === 'encrypted') {
      return JSON.parse(
        await symmetricDecrypt({
          key: secret,
          data: backupCodes,
        })
      ) as string[];
    }

    if (typeof options?.storeBackupCodes === 'object' && 'decrypt' in options.storeBackupCodes) {
      return JSON.parse(await options.storeBackupCodes.decrypt(backupCodes)) as string[];
    }

    return JSON.parse(backupCodes) as string[];
  } catch {
    return null;
  }
}

async function verifyStoredBackupCode(
  data: {
    code: string;
    backupCodes: string;
  },
  secret: string,
  options?: BackupCodeOptions
) {
  const codes = await getBackupCodesFromStorage(data.backupCodes, secret, options);
  if (!codes) {
    return {
      status: false,
      updated: null,
    };
  }

  return {
    status: codes.includes(data.code),
    updated: codes.filter((code) => code !== data.code),
  };
}

function compactOptionalFields<T extends Record<string, unknown>>(value: T): T {
  const nextValue = { ...value };
  for (const [key, entry] of Object.entries(nextValue)) {
    if (entry === undefined) {
      delete nextValue[key as keyof T];
    }
  }
  return nextValue;
}

function requireBetterAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required');
  return secret;
}

function requireEncryptionSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET?.trim();
  if (!secret) throw new Error('ENCRYPTION_SECRET is required');
  return secret;
}

function requireRecoveryContextSecret(): string {
  const secret =
    process.env.ACCOUNT_RECOVERY_CONTEXT_SECRET?.trim() ?? process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required');
  return secret;
}

function getCanonicalAuthUserId(user: BetterAuthUserRecord | null): string | null {
  const candidate = user?.id ?? user?._id ?? null;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

function requireAuthenticatedUserId(
  authUser: Awaited<ReturnType<typeof getAuthenticatedAuthUser>>
): string {
  if (!authUser?.authUserId) {
    throw new ConvexError('Authentication required');
  }
  return authUser.authUserId;
}

function normalizeInputEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new ConvexError('A valid email address is required');
  return normalized;
}

function generateNonce(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('');
}

function computePromptJitterMs(authUserId: string): number {
  let hash = 0;
  for (const char of authUserId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % RECOVERY_PROMPT_JITTER_WINDOW_MS;
}

function computeNextRecoveryPromptAt(authUserId: string, now: number): number {
  return now + RECOVERY_PROMPT_BASE_INTERVAL_MS + computePromptJitterMs(authUserId);
}

function isVerifiedRecoveryContact(contact: {
  status: string;
  compromisedAt?: number | undefined;
  removedAt?: number | undefined;
}) {
  return (
    contact.status === RECOVERY_CONTACT_STATUS.verified &&
    contact.compromisedAt === undefined &&
    contact.removedAt === undefined
  );
}

async function listRecoveryContactsForAuthUser(ctx: any, authUserId: string) {
  return await ctx.db
    .query('account_recovery_contacts')
    .withIndex('by_auth_user', (q: any) => q.eq('authUserId', authUserId))
    .collect();
}

async function getSecurityState(ctx: any, authUserId: string) {
  return await ctx.db
    .query('account_security_state')
    .withIndex('by_auth_user', (q: any) => q.eq('authUserId', authUserId))
    .first();
}

async function upsertSecurityState(
  ctx: any,
  authUserId: string,
  patch: Record<string, unknown>,
  now: number
) {
  const existing = await getSecurityState(ctx, authUserId);
  if (existing) {
    const { _id, _creationTime, ...existingFields } = existing;
    await ctx.db.replace(
      existing._id,
      compactOptionalFields({
        ...existingFields,
        ...patch,
        updatedAt: now,
      })
    );
    return existing._id;
  }

  return await ctx.db.insert(
    'account_security_state',
    compactOptionalFields({
      authUserId,
      hasVerifiedRecoveryEmail: false,
      hasBackupCodes: false,
      hasPasskey: false,
      createdAt: now,
      updatedAt: now,
      ...patch,
    })
  );
}

async function recordAuditEvent(
  ctx: any,
  args: {
    authUserId: string;
    eventType:
      | 'account.security.prompt.shown'
      | 'account.security.prompt.dismissed'
      | 'account.security.passkey.added'
      | 'account.security.passkey.removed'
      | 'account.security.backup_codes.regenerated'
      | 'account.security.recovery_email.added'
      | 'account.security.recovery_email.verified'
      | 'account.security.recovery_email.removed'
      | 'account.security.recovery.initiated'
      | 'account.security.recovery.completed'
      | 'account.security.authenticator.compromised'
      | 'account.security.sessions.revoked';
    metadata?: Record<string, unknown>;
    createdAt?: number;
  }
) {
  await ctx.db.insert('audit_events', {
    authUserId: args.authUserId,
    eventType: args.eventType,
    actorType: 'system',
    metadata: args.metadata,
    createdAt: args.createdAt ?? Date.now(),
  });
}

async function getBetterAuthUserById(ctx: any, authUserId: string) {
  return (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: buildBetterAuthUserLookupWhere(authUserId),
    select: ['_id', 'id', 'name', 'email', 'emailVerified', 'image'],
  })) as BetterAuthUserRecord | null;
}

async function getBetterAuthUserByEmail(ctx: any, email: string) {
  const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: 'user',
    where: buildBetterAuthEqualityWhere([{ field: 'email', value: email }]),
    select: ['_id', 'id', 'name', 'email', 'emailVerified', 'image'],
    paginationOpts: { cursor: null, numItems: 1 },
  })) as { page?: BetterAuthUserRecord[] } | null;
  return result?.page?.[0] ?? null;
}

async function listUserPasskeys(ctx: any, authUserId: string) {
  const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: 'passkey',
    where: buildBetterAuthEqualityWhere([{ field: 'userId', value: authUserId }]),
    select: ['_id', 'id', 'userId', 'name', 'credentialID', 'deviceType', 'backedUp', 'createdAt'],
    paginationOpts: { cursor: null, numItems: 20 },
  })) as { page?: BetterAuthPasskeyRecord[] } | null;
  return result?.page ?? [];
}

async function getTwoFactorRecord(ctx: any, authUserId: string) {
  return (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'twoFactor',
    where: buildBetterAuthEqualityWhere([{ field: 'userId', value: authUserId }]),
    select: ['_id', 'id', 'userId', 'backupCodes', 'verified'],
  })) as BetterAuthTwoFactorRecord | null;
}

async function getAvailableBackupCodeCount(record: BetterAuthTwoFactorRecord | null) {
  if (!record?.backupCodes) {
    return 0;
  }

  const codes = await getBackupCodesFromStorage(
    record.backupCodes,
    requireBetterAuthSecret(),
    BETTER_AUTH_BACKUP_CODE_OPTIONS
  );
  return Array.isArray(codes) ? codes.length : 0;
}

async function isCreatorAccount(ctx: any, authUserId: string) {
  const creatorProfile = await ctx.db
    .query('creator_profiles')
    .withIndex('by_auth_user', (q: any) => q.eq('authUserId', authUserId))
    .first();
  return Boolean(creatorProfile);
}

async function decryptRecoveryContactEmail(emailEncrypted: string | undefined) {
  if (!emailEncrypted) {
    return null;
  }

  return await decryptForPurpose(
    emailEncrypted,
    requireEncryptionSecret(),
    PII_PURPOSES.recoveryContactEmail
  );
}

async function decryptRecoverySessionEmail(emailEncrypted: string | undefined) {
  if (!emailEncrypted) {
    return null;
  }

  return await decryptForPurpose(
    emailEncrypted,
    requireEncryptionSecret(),
    PII_PURPOSES.recoverySessionTargetEmail
  );
}

async function computeSecurityPosture(
  ctx: any,
  authUserId: string,
  stateOverride?: Record<string, unknown> | null
) {
  const now = Date.now();
  const [user, passkeys, twoFactorRecord, contacts, storedState, creatorAccount] =
    await Promise.all([
      getBetterAuthUserById(ctx, authUserId),
      listUserPasskeys(ctx, authUserId),
      getTwoFactorRecord(ctx, authUserId),
      listRecoveryContactsForAuthUser(ctx, authUserId),
      getSecurityState(ctx, authUserId),
      isCreatorAccount(ctx, authUserId),
    ]);

  const state = stateOverride ?? storedState;
  const verifiedContacts = contacts.filter(isVerifiedRecoveryContact);
  const backupCodeCount = await getAvailableBackupCodeCount(twoFactorRecord);
  const strongFactorCount =
    Number(passkeys.length > 0) + Number(backupCodeCount > 0) + Number(verifiedContacts.length > 0);
  const primaryEmail = user?.email ? normalizeEmail(user.email) : null;
  const primaryEmailRecoveryEligible = Boolean(primaryEmail) && !state?.primaryEmailCompromisedAt;
  const shouldShowPrompt =
    strongFactorCount === 0 &&
    (!state?.dismissedUntil || Number(state.dismissedUntil) <= now) &&
    (!state?.nextRecoveryPromptAt || Number(state.nextRecoveryPromptAt) <= now);

  const nextRecoveryPromptAt =
    strongFactorCount > 0
      ? null
      : typeof state?.nextRecoveryPromptAt === 'number'
        ? state.nextRecoveryPromptAt
        : now;

  const recoveryContacts = await Promise.all(
    contacts
      .filter((contact: any) => contact.status !== RECOVERY_CONTACT_STATUS.removed)
      .map(async (contact: any) => ({
        id: String(contact._id),
        kind: contact.kind,
        status: contact.status,
        email: await decryptRecoveryContactEmail(contact.emailEncrypted),
        verifiedAt: contact.verifiedAt ?? null,
        compromisedAt: contact.compromisedAt ?? null,
        addedAt: contact.addedAt,
        lastUsedAt: contact.lastUsedAt ?? null,
        removedAt: contact.removedAt ?? null,
      }))
  );

  return {
    authUserId,
    isCreatorAccount: creatorAccount,
    primaryEmail,
    primaryEmailVerified: Boolean(user?.emailVerified),
    primaryEmailRecoveryEligible,
    passkeyCount: passkeys.length,
    backupCodeCount,
    verifiedRecoveryEmailCount: verifiedContacts.length,
    hasPasskey: passkeys.length > 0,
    hasBackupCodes: backupCodeCount > 0,
    hasVerifiedRecoveryEmail: verifiedContacts.length > 0,
    strongFactorCount,
    shouldShowPrompt,
    nextRecoveryPromptAt,
    dismissedUntil: state?.dismissedUntil ?? null,
    lastRecoveryPromptAt: state?.lastRecoveryPromptAt ?? null,
    primaryEmailCompromisedAt: state?.primaryEmailCompromisedAt ?? null,
    discordCompromisedAt: state?.discordCompromisedAt ?? null,
    recoveryContacts,
  };
}

async function syncSecurityStateForUser(ctx: any, authUserId: string, now = Date.now()) {
  const posture = await computeSecurityPosture(ctx, authUserId);
  const existingState = await getSecurityState(ctx, authUserId);
  const patch: Record<string, unknown> = {
    hasVerifiedRecoveryEmail: posture.hasVerifiedRecoveryEmail,
    hasBackupCodes: posture.hasBackupCodes,
    hasPasskey: posture.hasPasskey,
  };

  if (posture.strongFactorCount > 0) {
    patch.nextRecoveryPromptAt = undefined;
    patch.dismissedUntil = undefined;
  } else if (posture.nextRecoveryPromptAt === null) {
    patch.nextRecoveryPromptAt = now;
  } else {
    patch.nextRecoveryPromptAt = posture.nextRecoveryPromptAt;
  }

  await upsertSecurityState(ctx, authUserId, patch, now);
  return await computeSecurityPosture(ctx, authUserId, {
    ...(existingState ?? {}),
    ...patch,
  });
}

async function cancelActiveRecoverySessions(ctx: any, authUserId: string, cancelledAt: number) {
  const sessions = await ctx.db
    .query('account_recovery_sessions')
    .withIndex('by_auth_user', (q: any) => q.eq('authUserId', authUserId))
    .collect();

  for (const session of sessions) {
    if (
      session.status === RECOVERY_SESSION_STATUS.pending ||
      session.status === RECOVERY_SESSION_STATUS.verified
    ) {
      await ctx.db.patch(session._id, {
        status: RECOVERY_SESSION_STATUS.cancelled,
        cancelledAt,
        updatedAt: cancelledAt,
      });
    }
  }
}

async function expireRecoverySessionIfNeeded(ctx: any, session: any, now: number) {
  if (!session || session.status === RECOVERY_SESSION_STATUS.expired || session.expiresAt > now) {
    return session;
  }

  await ctx.db.patch(session._id, {
    status: RECOVERY_SESSION_STATUS.expired,
    updatedAt: now,
  });
  return { ...session, status: RECOVERY_SESSION_STATUS.expired };
}

async function revokeAllSessionsForUser(ctx: any, authUserId: string) {
  await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
    input: {
      model: 'session',
      where: buildBetterAuthEqualityWhere([{ field: 'userId', value: authUserId }]),
    },
    paginationOpts: { cursor: null, numItems: 1000 },
  } as any);
}

async function createRecoverySession(
  ctx: any,
  args: {
    authUserId: string;
    lookupEmailHash?: string;
    deliveryMethod: RecoveryDeliveryMethod;
    challengeType: 'email-otp' | 'backup-code' | 'manual';
    targetEmail?: string | null;
    status?: keyof typeof RECOVERY_SESSION_STATUS;
    verifiedAt?: number;
    expiresAt: number;
    now: number;
    contextNonce?: string;
  }
) {
  const normalizedTargetEmail = args.targetEmail ? normalizeEmail(args.targetEmail) : null;
  const targetEmailEncrypted =
    normalizedTargetEmail === null
      ? undefined
      : await encryptPii(normalizedTargetEmail, PII_PURPOSES.recoverySessionTargetEmail);
  const targetEmailHash =
    normalizedTargetEmail === null ? undefined : await sha256Hex(normalizedTargetEmail);

  return await ctx.db.insert('account_recovery_sessions', {
    authUserId: args.authUserId,
    lookupEmailHash: args.lookupEmailHash,
    deliveryMethod: args.deliveryMethod,
    challengeType: args.challengeType,
    targetEmailHash,
    targetEmailEncrypted,
    status: args.status ?? RECOVERY_SESSION_STATUS.pending,
    contextNonce: args.contextNonce,
    expiresAt: args.expiresAt,
    verifiedAt: args.verifiedAt,
    attempts: 0,
    createdAt: args.now,
    updatedAt: args.now,
  });
}

async function getLatestActiveRecoverySessionByLookupEmail(
  ctx: any,
  lookupEmailHash: string,
  predicate?: (session: any) => boolean
) {
  const sessions = await ctx.db
    .query('account_recovery_sessions')
    .withIndex('by_lookup_email_hash', (q: any) => q.eq('lookupEmailHash', lookupEmailHash))
    .collect();

  const sorted = sessions.sort((left: any, right: any) => right.createdAt - left.createdAt);
  for (const session of sorted) {
    if (predicate && !predicate(session)) {
      continue;
    }
    if (
      session.status === RECOVERY_SESSION_STATUS.pending ||
      session.status === RECOVERY_SESSION_STATUS.verified
    ) {
      return session;
    }
  }
  return null;
}

async function getLatestRecoverySessionByLookupEmail(
  ctx: any,
  lookupEmailHash: string,
  predicate?: (session: any) => boolean
) {
  const sessions = await ctx.db
    .query('account_recovery_sessions')
    .withIndex('by_lookup_email_hash', (q: any) => q.eq('lookupEmailHash', lookupEmailHash))
    .collect();

  const sorted = sessions.sort((left: any, right: any) => right.createdAt - left.createdAt);
  for (const session of sorted) {
    if (!predicate || predicate(session)) {
      return session;
    }
  }
  return null;
}

async function issueRecoveryContext(session: {
  authUserId: string;
  contextNonce: string;
  deliveryMethod: RecoveryContextMethod;
  expiresAt: number;
}) {
  return await issueRecoveryPasskeyContext(
    {
      authUserId: session.authUserId,
      method: session.deliveryMethod,
      issuedAt: Date.now(),
      nonce: session.contextNonce,
      expiresAt: session.expiresAt,
    },
    requireRecoveryContextSecret()
  );
}

async function getLookupResolution(ctx: any, lookupEmail: string) {
  const normalizedLookupEmail = normalizeInputEmail(lookupEmail);
  const lookupEmailHash = await sha256Hex(normalizedLookupEmail);
  const matchingContacts = await ctx.db
    .query('account_recovery_contacts')
    .withIndex('by_email_hash', (q: any) => q.eq('emailHash', lookupEmailHash))
    .collect();

  const matchingRecoveryContact =
    matchingContacts
      .filter(isVerifiedRecoveryContact)
      .sort((left: any, right: any) => right.updatedAt - left.updatedAt)[0] ?? null;

  const userByEmail = await getBetterAuthUserByEmail(ctx, normalizedLookupEmail);
  const authUserId =
    matchingRecoveryContact?.authUserId ?? getCanonicalAuthUserId(userByEmail) ?? null;

  if (!authUserId) {
    return {
      authUserId: null,
      lookupEmailHash,
      lookupEmail: normalizedLookupEmail,
      user: null,
      recoveryContact: null,
      securityPosture: null,
    };
  }

  const user =
    getCanonicalAuthUserId(userByEmail) === authUserId
      ? userByEmail
      : await getBetterAuthUserById(ctx, authUserId);
  const securityPosture = await computeSecurityPosture(ctx, authUserId);

  return {
    authUserId,
    lookupEmailHash,
    lookupEmail: normalizedLookupEmail,
    user,
    recoveryContact: matchingRecoveryContact,
    securityPosture,
  };
}

function resolveRecoveryRoute(resolution: Awaited<ReturnType<typeof getLookupResolution>>) {
  if (!resolution.authUserId || !resolution.securityPosture) {
    return {
      emailDeliveryMethod: null,
      targetEmail: null,
      canUseBackupCode: false,
      requiresSupport: false,
    };
  }

  if (resolution.recoveryContact !== null) {
    const targetContact = resolution.securityPosture.recoveryContacts.find(
      (contact) => contact.id === String(resolution.recoveryContact?._id)
    );
    return {
      emailDeliveryMethod: 'recovery-email-otp' as const,
      targetEmail: targetContact?.email ?? null,
      canUseBackupCode: resolution.securityPosture.hasBackupCodes,
      requiresSupport: false,
    };
  }

  const primaryEmailMatches =
    resolution.securityPosture.primaryEmail !== null &&
    resolution.securityPosture.primaryEmail === resolution.lookupEmail;

  if (
    primaryEmailMatches &&
    resolution.securityPosture.primaryEmailRecoveryEligible &&
    !resolution.securityPosture.isCreatorAccount
  ) {
    return {
      emailDeliveryMethod: 'primary-email-otp' as const,
      targetEmail: resolution.securityPosture.primaryEmail,
      canUseBackupCode: resolution.securityPosture.hasBackupCodes,
      requiresSupport: false,
    };
  }

  return {
    emailDeliveryMethod: null,
    targetEmail: null,
    canUseBackupCode: resolution.securityPosture.hasBackupCodes,
    requiresSupport: Boolean(resolution.authUserId),
  };
}

export const getSecurityOverview = query({
  args: {},
  handler: async (ctx) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    const authUserId = requireAuthenticatedUserId(authUser);
    return await computeSecurityPosture(ctx, authUserId);
  },
});

export const syncSecurityState = mutation({
  args: {
    eventType: v.optional(
      v.union(
        v.literal('account.security.passkey.added'),
        v.literal('account.security.passkey.removed'),
        v.literal('account.security.backup_codes.regenerated')
      )
    ),
  },
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    const authUserId = requireAuthenticatedUserId(authUser);
    const posture = await syncSecurityStateForUser(ctx, authUserId);
    if (args.eventType) {
      await recordAuditEvent(ctx, {
        authUserId,
        eventType: args.eventType,
        metadata: {
          passkeyCount: posture.passkeyCount,
          backupCodeCount: posture.backupCodeCount,
          verifiedRecoveryEmailCount: posture.verifiedRecoveryEmailCount,
        },
      });
    }
    return posture;
  },
});

export const recordRecoveryPromptShown = mutation({
  args: {},
  handler: async (ctx) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    const authUserId = requireAuthenticatedUserId(authUser);
    const now = Date.now();
    await upsertSecurityState(
      ctx,
      authUserId,
      {
        lastRecoveryPromptAt: now,
        nextRecoveryPromptAt: computeNextRecoveryPromptAt(authUserId, now),
        dismissedUntil: undefined,
      },
      now
    );
    await recordAuditEvent(ctx, {
      authUserId,
      eventType: 'account.security.prompt.shown',
      createdAt: now,
    });
    return await syncSecurityStateForUser(ctx, authUserId, now);
  },
});

export const dismissRecoveryPrompt = mutation({
  args: {},
  handler: async (ctx) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    const authUserId = requireAuthenticatedUserId(authUser);
    const now = Date.now();
    await upsertSecurityState(
      ctx,
      authUserId,
      {
        dismissedUntil: now + RECOVERY_PROMPT_DISMISS_MS,
        nextRecoveryPromptAt: computeNextRecoveryPromptAt(authUserId, now),
      },
      now
    );
    await recordAuditEvent(ctx, {
      authUserId,
      eventType: 'account.security.prompt.dismissed',
      createdAt: now,
    });
    return await syncSecurityStateForUser(ctx, authUserId, now);
  },
});

export const prepareRecoveryContactEnrollment = mutation({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    const authUserId = requireAuthenticatedUserId(authUser);
    const now = Date.now();
    const email = normalizeInputEmail(args.email);
    const emailHash = await sha256Hex(email);
    const emailEncrypted = await encryptPii(email, PII_PURPOSES.recoveryContactEmail);
    if (!emailEncrypted) {
      throw new Error('Recovery email encryption failed');
    }
    const existing = await ctx.db
      .query('account_recovery_contacts')
      .withIndex('by_email_hash', (q: any) => q.eq('emailHash', emailHash))
      .collect();
    const existingForAnotherUser =
      existing.find((record: any) => record.authUserId !== authUserId) ?? null;
    if (existingForAnotherUser) {
      throw new ConvexError('Recovery email is already in use');
    }

    const existingPrimaryEmailOwnerId = getCanonicalAuthUserId(
      await getBetterAuthUserByEmail(ctx, email)
    );
    if (existingPrimaryEmailOwnerId && existingPrimaryEmailOwnerId !== authUserId) {
      throw new ConvexError('Recovery email is already in use');
    }

    const currentForUser = existing.find((record: any) => record.authUserId === authUserId) ?? null;
    if (currentForUser) {
      await ctx.db.patch(currentForUser._id, {
        kind: RECOVERY_CONTACT_KIND,
        emailEncrypted,
        enrollmentChallenge: undefined,
        status: RECOVERY_CONTACT_STATUS.pending,
        verifiedAt: undefined,
        compromisedAt: undefined,
        removedAt: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('account_recovery_contacts', {
        authUserId,
        kind: RECOVERY_CONTACT_KIND,
        emailHash,
        emailEncrypted,
        status: RECOVERY_CONTACT_STATUS.pending,
        addedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    await recordAuditEvent(ctx, {
      authUserId,
      eventType: 'account.security.recovery_email.added',
      metadata: { emailHash },
      createdAt: now,
    });

    return {
      email,
      emailHash,
    };
  },
});

export const verifyRecoveryContactEnrollment = mutation({
  args: {
    email: v.string(),
    challengeToken: v.optional(v.string()),
    otpAssertion: v.optional(v.string()),
  },
  handler: async () => {
    throw new ConvexError(
      'Recovery email verification must be completed through the account security API'
    );
  },
});

export const verifyRecoveryContactEnrollmentForApi = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const email = normalizeInputEmail(args.email);
    const emailHash = await sha256Hex(email);
    const matchingContacts = await ctx.db
      .query('account_recovery_contacts')
      .withIndex('by_email_hash', (q: any) => q.eq('emailHash', emailHash))
      .collect();
    const contact =
      matchingContacts.find((record: any) => record.authUserId === args.authUserId) ?? null;

    if (!contact) {
      throw new ConvexError('Recovery email enrollment not found');
    }

    await ctx.db.patch(contact._id, {
      status: RECOVERY_CONTACT_STATUS.verified,
      enrollmentChallenge: undefined,
      verifiedAt: now,
      compromisedAt: undefined,
      removedAt: undefined,
      updatedAt: now,
    });

    await recordAuditEvent(ctx, {
      authUserId: args.authUserId,
      eventType: 'account.security.recovery_email.verified',
      metadata: { emailHash },
      createdAt: now,
    });

    return await syncSecurityStateForUser(ctx, args.authUserId, now);
  },
});

export const removeRecoveryContact = mutation({
  args: {
    contactId: v.id('account_recovery_contacts'),
  },
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    const authUserId = requireAuthenticatedUserId(authUser);
    const now = Date.now();
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.authUserId !== authUserId) {
      throw new ConvexError('Recovery email not found');
    }

    await ctx.db.patch(contact._id, {
      status: RECOVERY_CONTACT_STATUS.removed,
      removedAt: now,
      updatedAt: now,
    });

    await recordAuditEvent(ctx, {
      authUserId,
      eventType: 'account.security.recovery_email.removed',
      metadata: { contactId: String(contact._id) },
      createdAt: now,
    });

    return await syncSecurityStateForUser(ctx, authUserId, now);
  },
});

export const markAuthenticatorCompromised = mutation({
  args: {
    kind: v.union(v.literal('primary-email'), v.literal('discord'), v.literal('recovery-email')),
    contactId: v.optional(v.id('account_recovery_contacts')),
  },
  handler: async (ctx, args) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    const authUserId = requireAuthenticatedUserId(authUser);
    const now = Date.now();

    if (args.kind === 'primary-email') {
      await upsertSecurityState(
        ctx,
        authUserId,
        {
          primaryEmailCompromisedAt: now,
        },
        now
      );
    } else if (args.kind === 'discord') {
      await upsertSecurityState(
        ctx,
        authUserId,
        {
          discordCompromisedAt: now,
        },
        now
      );
    } else {
      if (!args.contactId) {
        throw new ConvexError('Recovery contact is required');
      }
      const contact = await ctx.db.get(args.contactId);
      if (!contact || contact.authUserId !== authUserId) {
        throw new ConvexError('Recovery email not found');
      }
      await ctx.db.patch(contact._id, {
        status: RECOVERY_CONTACT_STATUS.compromised,
        compromisedAt: now,
        updatedAt: now,
      });
    }

    await cancelActiveRecoverySessions(ctx, authUserId, now);
    await revokeAllSessionsForUser(ctx, authUserId);
    await recordAuditEvent(ctx, {
      authUserId,
      eventType: 'account.security.authenticator.compromised',
      metadata: {
        kind: args.kind,
        contactId: args.contactId ? String(args.contactId) : null,
      },
      createdAt: now,
    });
    await recordAuditEvent(ctx, {
      authUserId,
      eventType: 'account.security.sessions.revoked',
      metadata: {
        reason: 'compromised-authenticator',
      },
      createdAt: now,
    });

    return await syncSecurityStateForUser(ctx, authUserId, now);
  },
});

export const revokeAllUserSessions = mutation({
  args: {},
  handler: async (ctx) => {
    const authUser = await getAuthenticatedAuthUser(ctx);
    const authUserId = requireAuthenticatedUserId(authUser);
    const now = Date.now();
    await revokeAllSessionsForUser(ctx, authUserId);
    await recordAuditEvent(ctx, {
      authUserId,
      eventType: 'account.security.sessions.revoked',
      createdAt: now,
    });
    return { success: true };
  },
});

export const resolveRecoveryLookupForApi = query({
  args: {
    apiSecret: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const resolution = await getLookupResolution(ctx, args.email);
    const route = resolveRecoveryRoute(resolution);

    return {
      authUserId: resolution.authUserId,
      lookupEmail: resolution.lookupEmail,
      lookupEmailHash: resolution.lookupEmailHash,
      canUseBackupCode: route.canUseBackupCode,
      emailDeliveryMethod: route.emailDeliveryMethod,
      targetEmail: route.targetEmail,
      requiresSupport: route.requiresSupport,
      isCreatorAccount: resolution.securityPosture?.isCreatorAccount ?? false,
    };
  },
});

export const beginEmailRecoveryForApi = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    lookupEmail: v.string(),
    deliveryMethod: v.union(v.literal('primary-email-otp'), v.literal('recovery-email-otp')),
    targetEmail: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const normalizedLookupEmail = normalizeInputEmail(args.lookupEmail);
    const normalizedTargetEmail = normalizeInputEmail(args.targetEmail);
    const lookupEmailHash = await sha256Hex(normalizedLookupEmail);
    await cancelActiveRecoverySessions(ctx, args.authUserId, now);
    const contextNonce = generateNonce();
    await createRecoverySession(ctx, {
      authUserId: args.authUserId,
      lookupEmailHash,
      deliveryMethod: args.deliveryMethod,
      challengeType: 'email-otp',
      targetEmail: normalizedTargetEmail,
      expiresAt: now + RECOVERY_EMAIL_SESSION_TTL_MS,
      now,
      contextNonce,
    });
    await recordAuditEvent(ctx, {
      authUserId: args.authUserId,
      eventType: 'account.security.recovery.initiated',
      metadata: {
        deliveryMethod: args.deliveryMethod,
        targetEmailHash: await sha256Hex(normalizedTargetEmail),
      },
      createdAt: now,
    });

    return {
      expiresAt: now + RECOVERY_EMAIL_SESSION_TTL_MS,
    };
  },
});

export const getPendingEmailRecoveryForApi = query({
  args: {
    apiSecret: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const lookupEmail = normalizeInputEmail(args.email);
    const lookupEmailHash = await sha256Hex(lookupEmail);
    const session = await expireRecoverySessionIfNeeded(
      ctx,
      await getLatestActiveRecoverySessionByLookupEmail(
        ctx,
        lookupEmailHash,
        (candidate) => candidate.challengeType === 'email-otp'
      ),
      Date.now()
    );

    if (!session || session.status !== RECOVERY_SESSION_STATUS.pending) {
      return null;
    }

    return {
      sessionId: String(session._id),
      authUserId: session.authUserId,
      deliveryMethod: session.deliveryMethod as RecoveryDeliveryMethod,
      targetEmail: await decryptRecoverySessionEmail(session.targetEmailEncrypted),
      expiresAt: session.expiresAt,
    };
  },
});

export const consumeEmailRecoveryForApi = mutation({
  args: {
    apiSecret: v.string(),
    email: v.string(),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const lookupEmailHash = await sha256Hex(normalizeInputEmail(args.email));
    const session = await expireRecoverySessionIfNeeded(
      ctx,
      await ctx.db.get(args.sessionId as Id<'account_recovery_sessions'>),
      now
    );

    if (
      !session ||
      session.lookupEmailHash !== lookupEmailHash ||
      session.challengeType !== 'email-otp' ||
      session.status !== RECOVERY_SESSION_STATUS.pending ||
      !session.contextNonce
    ) {
      return null;
    }

    await ctx.db.patch(session._id, {
      status: RECOVERY_SESSION_STATUS.verified,
      verifiedAt: now,
      updatedAt: now,
    });

    if (session.deliveryMethod === 'recovery-email-otp' && session.targetEmailHash) {
      const contact = await ctx.db
        .query('account_recovery_contacts')
        .withIndex('by_email_hash', (q: any) => q.eq('emailHash', session.targetEmailHash))
        .first();
      if (contact) {
        await ctx.db.patch(contact._id, {
          lastUsedAt: now,
          updatedAt: now,
        });
      }
    }

    return {
      authUserId: session.authUserId,
      recoveryPasskeyContext: await issueRecoveryContext({
        authUserId: session.authUserId,
        contextNonce: session.contextNonce,
        deliveryMethod: session.deliveryMethod,
        expiresAt: Math.min(session.expiresAt, now + RECOVERY_PASSKEY_CONTEXT_TTL_MS),
      }),
      expiresAt: Math.min(session.expiresAt, now + RECOVERY_PASSKEY_CONTEXT_TTL_MS),
    };
  },
});

export const consumeBackupCodeRecoveryForApi = mutation({
  args: {
    apiSecret: v.string(),
    email: v.string(),
    backupCode: v.string(),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const now = Date.now();
    const resolution = await getLookupResolution(ctx, args.email);
    const route = resolveRecoveryRoute(resolution);

    if (!resolution.authUserId || !resolution.securityPosture || !route.canUseBackupCode) {
      return null;
    }

    const twoFactorRecord = await getTwoFactorRecord(ctx, resolution.authUserId);
    if (!twoFactorRecord?._id || !twoFactorRecord.backupCodes) {
      return null;
    }

    const latestAttemptSession = await expireRecoverySessionIfNeeded(
      ctx,
      await getLatestRecoverySessionByLookupEmail(
        ctx,
        resolution.lookupEmailHash,
        (candidate) =>
          candidate.challengeType === 'backup-code' &&
          candidate.deliveryMethod === 'backup-code' &&
          candidate.authUserId === resolution.authUserId
      ),
      now
    );

    if (
      latestAttemptSession?.status === RECOVERY_SESSION_STATUS.cancelled &&
      latestAttemptSession.attempts >= RECOVERY_BACKUP_CODE_MAX_ATTEMPTS
    ) {
      return null;
    }

    const attemptSessionId =
      latestAttemptSession?.status === RECOVERY_SESSION_STATUS.pending
        ? latestAttemptSession._id
        : await createRecoverySession(ctx, {
            authUserId: resolution.authUserId,
            lookupEmailHash: resolution.lookupEmailHash,
            deliveryMethod: 'backup-code',
            challengeType: 'backup-code',
            expiresAt: now + RECOVERY_EMAIL_SESSION_TTL_MS,
            now,
          });

    const attemptSession = (await ctx.db.get(attemptSessionId)) as any;
    if (!attemptSession || attemptSession.status !== RECOVERY_SESSION_STATUS.pending) {
      return null;
    }
    if (attemptSession.attempts >= RECOVERY_BACKUP_CODE_MAX_ATTEMPTS) {
      await ctx.db.patch(attemptSession._id, {
        status: RECOVERY_SESSION_STATUS.cancelled,
        cancelledAt: attemptSession.cancelledAt ?? now,
        updatedAt: now,
      });
      return null;
    }

    const nextAttemptCount = attemptSession.attempts + 1;
    await ctx.db.patch(attemptSession._id, {
      attempts: nextAttemptCount,
      lastAttemptAt: now,
      updatedAt: now,
    });

    const verified = await verifyStoredBackupCode(
      {
        code: args.backupCode.trim(),
        backupCodes: twoFactorRecord.backupCodes,
      },
      requireBetterAuthSecret(),
      BETTER_AUTH_BACKUP_CODE_OPTIONS
    );

    if (!verified.status || !verified.updated) {
      if (nextAttemptCount >= RECOVERY_BACKUP_CODE_MAX_ATTEMPTS) {
        await ctx.db.patch(attemptSession._id, {
          status: RECOVERY_SESSION_STATUS.cancelled,
          cancelledAt: now,
          updatedAt: now,
        });
      }
      return null;
    }

    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'twoFactor',
        where: [{ field: '_id', operator: 'eq', value: twoFactorRecord._id }],
        update: {
          backupCodes: await encodeBackupCodesForStorage(
            verified.updated,
            requireBetterAuthSecret(),
            BETTER_AUTH_BACKUP_CODE_OPTIONS
          ),
        },
      },
    } as any);

    await cancelActiveRecoverySessions(ctx, resolution.authUserId, now);
    const contextNonce = generateNonce();
    await createRecoverySession(ctx, {
      authUserId: resolution.authUserId,
      lookupEmailHash: resolution.lookupEmailHash,
      deliveryMethod: 'backup-code',
      challengeType: 'backup-code',
      status: RECOVERY_SESSION_STATUS.verified,
      verifiedAt: now,
      expiresAt: now + RECOVERY_PASSKEY_CONTEXT_TTL_MS,
      now,
      contextNonce,
    });
    await recordAuditEvent(ctx, {
      authUserId: resolution.authUserId,
      eventType: 'account.security.recovery.initiated',
      metadata: {
        deliveryMethod: 'backup-code',
      },
      createdAt: now,
    });
    await syncSecurityStateForUser(ctx, resolution.authUserId, now);

    return {
      authUserId: resolution.authUserId,
      recoveryPasskeyContext: await issueRecoveryContext({
        authUserId: resolution.authUserId,
        contextNonce,
        deliveryMethod: 'backup-code',
        expiresAt: now + RECOVERY_PASSKEY_CONTEXT_TTL_MS,
      }),
      expiresAt: now + RECOVERY_PASSKEY_CONTEXT_TTL_MS,
    };
  },
});

export const completeRecoveryPasskeyEnrollment = internalMutation({
  args: {
    authUserId: v.string(),
    contextNonce: v.string(),
    method: v.union(
      v.literal('primary-email-otp'),
      v.literal('recovery-email-otp'),
      v.literal('backup-code'),
      v.literal('support-review')
    ),
    completedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('account_recovery_sessions')
      .withIndex('by_context_nonce', (q: any) => q.eq('contextNonce', args.contextNonce))
      .first();

    if (!session || session.authUserId !== args.authUserId) {
      return { completed: false };
    }
    if (
      session.deliveryMethod !== args.method ||
      (session.status !== RECOVERY_SESSION_STATUS.pending &&
        session.status !== RECOVERY_SESSION_STATUS.verified) ||
      session.expiresAt <= args.completedAt
    ) {
      return { completed: false };
    }

    await ctx.db.patch(session._id, {
      status: RECOVERY_SESSION_STATUS.completed,
      completedAt: args.completedAt,
      updatedAt: args.completedAt,
    });
    await cancelActiveRecoverySessions(ctx, args.authUserId, args.completedAt);
    await revokeAllSessionsForUser(ctx, args.authUserId);
    await recordAuditEvent(ctx, {
      authUserId: args.authUserId,
      eventType: 'account.security.passkey.added',
      metadata: {
        viaRecovery: true,
        method: session.deliveryMethod,
      },
      createdAt: args.completedAt,
    });
    await recordAuditEvent(ctx, {
      authUserId: args.authUserId,
      eventType: 'account.security.recovery.completed',
      metadata: {
        method: session.deliveryMethod,
      },
      createdAt: args.completedAt,
    });
    await recordAuditEvent(ctx, {
      authUserId: args.authUserId,
      eventType: 'account.security.sessions.revoked',
      metadata: {
        reason: 'recovery-completed',
      },
      createdAt: args.completedAt,
    });
    await syncSecurityStateForUser(ctx, args.authUserId, args.completedAt);
    return { completed: true };
  },
});
