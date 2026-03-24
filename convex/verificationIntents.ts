import * as ed from '@noble/ed25519';
import { v } from 'convex/values';
import { api, internal } from './_generated/api';
import { action, internalMutation, mutation, query } from './_generated/server';
import { signLicenseJwt } from './lib/yucpCrypto';
import { requireApiSecret } from './lib/apiAuth';
import { ProviderV } from './lib/providers';

ed.etc.sha512Async = async (...messages: Uint8Array[]) => {
  const data = ed.etc.concatBytes(...messages);
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
  const hash = await crypto.subtle.digest('SHA-512', buffer);
  return new Uint8Array(hash);
};

const INTENT_EXPIRY_MS = 15 * 60 * 1000;
const GRANT_EXPIRY_MS = 5 * 60 * 1000;
const GRANT_AUDIENCE = 'yucp-verification-intent';
const LICENSE_AUDIENCE = 'yucp-license-gate';

const VerificationIntentRequirementKindV = v.union(
  v.literal('existing_entitlement'),
  v.literal('manual_license')
);

const VerificationIntentRequirementV = v.object({
  methodKey: v.string(),
  providerKey: ProviderV,
  kind: VerificationIntentRequirementKindV,
  title: v.string(),
  description: v.optional(v.string()),
  creatorAuthUserId: v.optional(v.string()),
  productId: v.optional(v.string()),
  providerProductRef: v.optional(v.string()),
});

const VerificationIntentStatusV = v.union(
  v.literal('pending'),
  v.literal('verified'),
  v.literal('redeemed'),
  v.literal('failed'),
  v.literal('expired'),
  v.literal('cancelled')
);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function base64urlEncode(data: Uint8Array | string): string {
  let b64: string;
  if (typeof data === 'string') {
    b64 = btoa(data);
  } else {
    let binary = '';
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
    b64 = btoa(binary);
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecodeToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  return base64ToBytes(padded);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64urlEncode(new Uint8Array(digest));
}

function generateHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function validateReturnUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('returnUrl must be an absolute URL');
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  const isLoopback =
    parsed.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (!isLoopback) {
    throw new Error('returnUrl must use https or an HTTP loopback address');
  }
}

function validateRequirements(
  requirements: Array<{
    methodKey: string;
    providerKey: string;
    kind: 'existing_entitlement' | 'manual_license';
    creatorAuthUserId?: string;
    productId?: string;
    providerProductRef?: string;
  }>
) {
  if (requirements.length === 0) {
    throw new Error('At least one verification requirement is required');
  }

  const seen = new Set<string>();
  for (const requirement of requirements) {
    if (!requirement.methodKey || !requirement.providerKey || !requirement.kind) {
      throw new Error('Each verification requirement must include methodKey, providerKey, and kind');
    }
    if (seen.has(requirement.methodKey)) {
      throw new Error(`Duplicate verification methodKey: ${requirement.methodKey}`);
    }
    seen.add(requirement.methodKey);

    if (requirement.kind === 'existing_entitlement') {
      if (!requirement.creatorAuthUserId || !requirement.productId) {
        throw new Error(
          `existing_entitlement method '${requirement.methodKey}' requires creatorAuthUserId and productId`
        );
      }
    }

    if (requirement.kind === 'manual_license' && !requirement.providerProductRef) {
      throw new Error(
        `manual_license method '${requirement.methodKey}' requires providerProductRef`
      );
    }
  }
}

interface VerificationGrantClaims {
  iss: string;
  aud: typeof GRANT_AUDIENCE;
  sub: string;
  jti: string;
  intent_id: string;
  package_id: string;
  method_key: string;
  iat: number;
  exp: number;
}

async function signVerificationGrantJwt(
  claims: VerificationGrantClaims,
  privateKeyBase64: string,
  keyId: string
): Promise<string> {
  const header = { alg: 'EdDSA', crv: 'Ed25519', kid: keyId, typ: 'JWT' };
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signatureBytes = await ed.signAsync(
    new TextEncoder().encode(signingInput),
    base64ToBytes(privateKeyBase64)
  );
  return `${signingInput}.${base64urlEncode(signatureBytes)}`;
}

async function verifyVerificationGrantJwt(
  token: string,
  publicKeyBase64: string
): Promise<VerificationGrantClaims | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = base64urlDecodeToBytes(parts[2]);
    const verified = await ed.verifyAsync(
      signature,
      new TextEncoder().encode(signingInput),
      base64ToBytes(publicKeyBase64)
    );
    if (!verified) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(base64urlDecodeToBytes(parts[1]))
    ) as VerificationGrantClaims;
    if (payload.aud !== GRANT_AUDIENCE) return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const getIntentRecord = query({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    intentId: v.id('verification_intents'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const doc = await ctx.db.get(args.intentId);
    if (!doc || doc.authUserId !== args.authUserId) {
      return null;
    }
    return doc;
  },
});

export const createVerificationIntent = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    packageId: v.string(),
    packageName: v.optional(v.string()),
    machineFingerprint: v.string(),
    codeChallenge: v.string(),
    returnUrl: v.string(),
    idempotencyKey: v.optional(v.string()),
    requirements: v.array(VerificationIntentRequirementV),
  },
  returns: v.object({
    intentId: v.id('verification_intents'),
    status: VerificationIntentStatusV,
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    validateReturnUrl(args.returnUrl);
    validateRequirements(args.requirements);

    const now = Date.now();
    const expiresAt = now + INTENT_EXPIRY_MS;
    const subject = await ctx.db
      .query('subjects')
      .withIndex('by_auth_user', (q) => q.eq('authUserId', args.authUserId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .first();

    if (args.idempotencyKey) {
      const existing = await ctx.db
        .query('verification_intents')
        .withIndex('by_auth_user_idempotency', (q) =>
          q.eq('authUserId', args.authUserId).eq('idempotencyKey', args.idempotencyKey)
        )
        .first();
      if (
        existing &&
        existing.packageId === args.packageId &&
        existing.machineFingerprint === args.machineFingerprint &&
        existing.status !== 'redeemed' &&
        existing.status !== 'cancelled' &&
        existing.expiresAt > now
      ) {
        return {
          intentId: existing._id,
          status: existing.status,
          expiresAt: existing.expiresAt,
        };
      }
    }

    const intentId = await ctx.db.insert('verification_intents', {
      authUserId: args.authUserId,
      subjectId: subject?._id,
      packageId: args.packageId,
      packageName: args.packageName,
      machineFingerprint: args.machineFingerprint,
      codeChallenge: args.codeChallenge,
      returnUrl: args.returnUrl,
      requirements: args.requirements,
      status: 'pending',
      idempotencyKey: args.idempotencyKey,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    return {
      intentId,
      status: 'pending',
      expiresAt,
    };
  },
});

export const markIntentVerified = internalMutation({
  args: {
    intentId: v.id('verification_intents'),
    methodKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (!intent) {
      throw new Error(`Verification intent not found: ${args.intentId}`);
    }
    const now = Date.now();
    await ctx.db.patch(args.intentId, {
      status: 'verified',
      verifiedMethodKey: args.methodKey,
      verificationGrantJti: generateHex(16),
      verificationGrantExpiresAt: now + GRANT_EXPIRY_MS,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: now,
    });
    return null;
  },
});

export const markIntentFailed = internalMutation({
  args: {
    intentId: v.id('verification_intents'),
    errorCode: v.string(),
    errorMessage: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (!intent) {
      throw new Error(`Verification intent not found: ${args.intentId}`);
    }
    await ctx.db.patch(args.intentId, {
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const cancelVerificationIntent = mutation({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    intentId: v.id('verification_intents'),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.authUserId !== args.authUserId) {
      return { success: false };
    }
    await ctx.db.patch(args.intentId, {
      status: 'cancelled',
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

export const expireVerificationIntent = internalMutation({
  args: {
    intentId: v.id('verification_intents'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (!intent) {
      throw new Error(`Verification intent not found: ${args.intentId}`);
    }
    await ctx.db.patch(args.intentId, {
      status: 'expired',
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const cleanupExpiredVerificationIntents = internalMutation({
  args: {},
  returns: v.object({ cleaned: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const docs = await ctx.db
      .query('verification_intents')
      .withIndex('by_status_expires', (q) => q.eq('status', 'pending').lt('expiresAt', now))
      .collect();

    const verified = await ctx.db
      .query('verification_intents')
      .withIndex('by_status_expires', (q) => q.eq('status', 'verified').lt('expiresAt', now))
      .collect();

    let cleaned = 0;
    for (const doc of [...docs, ...verified]) {
      await ctx.db.patch(doc._id, {
        status: 'expired',
        updatedAt: now,
      });
      cleaned++;
    }
    return { cleaned };
  },
});

export const getVerificationIntent = action({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    intentId: v.id('verification_intents'),
  },
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const intent = await ctx.runQuery(api.verificationIntents.getIntentRecord, {
      apiSecret: args.apiSecret,
      authUserId: args.authUserId,
      intentId: args.intentId,
    });
    if (!intent) {
      return null;
    }

    const now = Date.now();
    if (
      (intent.status === 'pending' || intent.status === 'verified') &&
      intent.expiresAt <= now
    ) {
      await ctx.runMutation(internal.verificationIntents.expireVerificationIntent, {
        intentId: args.intentId,
      });
      return {
        ...intent,
        status: 'expired',
        grantToken: null,
      };
    }

    let grantToken: string | null = null;
    if (
      intent.status === 'verified' &&
      intent.verificationGrantJti &&
      intent.verificationGrantExpiresAt &&
      !intent.verificationGrantUsedAt
    ) {
      const privateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
      if (!privateKey) {
        throw new Error('YUCP_ROOT_PRIVATE_KEY not configured');
      }
      const siteUrl = process.env.CONVEX_SITE_URL?.replace(/\/$/, '') ?? '';
      const nowSeconds = Math.floor(now / 1000);
      const expSeconds = Math.floor(intent.verificationGrantExpiresAt / 1000);
      grantToken = await signVerificationGrantJwt(
        {
          iss: `${siteUrl}/api/auth`,
          aud: GRANT_AUDIENCE,
          sub: intent.authUserId,
          jti: intent.verificationGrantJti,
          intent_id: String(intent._id),
          package_id: intent.packageId,
          method_key: intent.verifiedMethodKey ?? 'unknown',
          iat: nowSeconds,
          exp: expSeconds,
        },
        privateKey,
        process.env.YUCP_ROOT_KEY_ID ?? 'yucp-root'
      );
    }

    return {
      ...intent,
      grantToken,
    };
  },
});

export const verifyIntentWithExistingEntitlement = action({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    intentId: v.id('verification_intents'),
    methodKey: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const intent = await ctx.runQuery(api.verificationIntents.getIntentRecord, {
      apiSecret: args.apiSecret,
      authUserId: args.authUserId,
      intentId: args.intentId,
    });
    if (!intent) {
      return {
        success: false,
        errorCode: 'not_found',
        errorMessage: 'Verification intent not found',
      };
    }
    if (intent.status !== 'pending') {
      return {
        success: false,
        errorCode: 'invalid_state',
        errorMessage: `Verification intent is ${intent.status}`,
      };
    }
    if (intent.expiresAt <= Date.now()) {
      return {
        success: false,
        errorCode: 'expired',
        errorMessage: 'Verification intent has expired',
      };
    }
    const requirement = intent.requirements.find(
      (entry) => entry.methodKey === args.methodKey && entry.kind === 'existing_entitlement'
    );
    if (!requirement?.creatorAuthUserId || !requirement.productId) {
      return {
        success: false,
        errorCode: 'invalid_method',
        errorMessage: 'Verification method does not support entitlement lookup',
      };
    }
    const subject =
      intent.subjectId != null
        ? { _id: intent.subjectId }
        : await ctx.runQuery(internal.yucpLicenses.getSubjectByAuthUser, {
            authUserId: args.authUserId,
          });
    if (!subject?._id) {
      await ctx.runMutation(internal.verificationIntents.markIntentFailed, {
        intentId: args.intentId,
        errorCode: 'subject_not_found',
        errorMessage: 'No linked buyer subject was found for this YUCP account.',
      });
      return {
        success: false,
        errorCode: 'subject_not_found',
        errorMessage: 'No linked buyer subject was found for this YUCP account.',
      };
    }
    const hasEntitlement = await ctx.runQuery(internal.yucpLicenses.checkSubjectEntitlement, {
      authUserId: requirement.creatorAuthUserId,
      subjectId: subject._id,
      productId: requirement.productId,
    });
    if (!hasEntitlement) {
      await ctx.runMutation(internal.verificationIntents.markIntentFailed, {
        intentId: args.intentId,
        errorCode: 'entitlement_missing',
        errorMessage: 'No active entitlement was found for this verification method.',
      });
      return {
        success: false,
        errorCode: 'entitlement_missing',
        errorMessage: 'No active entitlement was found for this verification method.',
      };
    }
    await ctx.runMutation(internal.verificationIntents.markIntentVerified, {
      intentId: args.intentId,
      methodKey: args.methodKey,
    });
    return { success: true };
  },
});

export const verifyIntentWithManualLicense = action({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    intentId: v.id('verification_intents'),
    methodKey: v.string(),
    licenseKey: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const intent = await ctx.runQuery(api.verificationIntents.getIntentRecord, {
      apiSecret: args.apiSecret,
      authUserId: args.authUserId,
      intentId: args.intentId,
    });
    if (!intent) {
      return {
        success: false,
        errorCode: 'not_found',
        errorMessage: 'Verification intent not found',
      };
    }
    if (intent.status !== 'pending') {
      return {
        success: false,
        errorCode: 'invalid_state',
        errorMessage: `Verification intent is ${intent.status}`,
      };
    }
    if (intent.expiresAt <= Date.now()) {
      return {
        success: false,
        errorCode: 'expired',
        errorMessage: 'Verification intent has expired',
      };
    }
    const requirement = intent.requirements.find(
      (entry) => entry.methodKey === args.methodKey && entry.kind === 'manual_license'
    );
    if (!requirement?.providerProductRef) {
      return {
        success: false,
        errorCode: 'invalid_method',
        errorMessage: 'Verification method does not support manual license proof',
      };
    }

    const proof = await ctx.runAction(internal.yucpLicenses.verifyLicenseProof, {
      packageId: intent.packageId,
      licenseKey: args.licenseKey,
      provider: requirement.providerKey,
      productPermalink: requirement.providerProductRef,
    });

    if (!proof.success) {
      await ctx.runMutation(internal.verificationIntents.markIntentFailed, {
        intentId: args.intentId,
        errorCode: 'invalid_proof',
        errorMessage: proof.error ?? 'License verification failed',
      });
      return {
        success: false,
        errorCode: 'invalid_proof',
        errorMessage: proof.error ?? 'License verification failed',
      };
    }

    await ctx.runMutation(internal.verificationIntents.markIntentVerified, {
      intentId: args.intentId,
      methodKey: args.methodKey,
    });
    return { success: true };
  },
});

export const redeemVerificationIntent = action({
  args: {
    apiSecret: v.string(),
    authUserId: v.string(),
    intentId: v.id('verification_intents'),
    codeVerifier: v.string(),
    machineFingerprint: v.string(),
    grantToken: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    token: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    requireApiSecret(args.apiSecret);
    const intent = await ctx.runQuery(api.verificationIntents.getIntentRecord, {
      apiSecret: args.apiSecret,
      authUserId: args.authUserId,
      intentId: args.intentId,
    });
    if (!intent) {
      return { success: false, error: 'Verification intent not found' };
    }
    if (intent.status !== 'verified') {
      return { success: false, error: `Verification intent is ${intent.status}` };
    }
    if (intent.expiresAt <= Date.now()) {
      return { success: false, error: 'Verification intent has expired' };
    }
    if (intent.machineFingerprint !== args.machineFingerprint) {
      return { success: false, error: 'Machine fingerprint does not match this verification intent' };
    }
    if (intent.verificationGrantUsedAt) {
      return { success: false, error: 'Verification grant has already been redeemed' };
    }
    const expectedChallenge = await computeCodeChallenge(args.codeVerifier);
    if (expectedChallenge !== intent.codeChallenge) {
      return { success: false, error: 'Verification code challenge mismatch' };
    }

    const privateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('YUCP_ROOT_PRIVATE_KEY not configured');
    }
    const publicKey = await ed.getPublicKeyAsync(base64ToBytes(privateKey));
    const grantClaims = await verifyVerificationGrantJwt(args.grantToken, bytesToBase64(publicKey));
    if (!grantClaims) {
      return { success: false, error: 'Verification grant is invalid or expired' };
    }
    if (
      grantClaims.intent_id !== String(intent._id) ||
      grantClaims.package_id !== intent.packageId ||
      grantClaims.sub !== args.authUserId ||
      grantClaims.jti !== intent.verificationGrantJti
    ) {
      return { success: false, error: 'Verification grant does not match this intent' };
    }

    const method =
      intent.requirements.find((entry) => entry.methodKey === intent.verifiedMethodKey) ??
      intent.requirements[0];
    if (!method) {
      return { success: false, error: 'Verification intent has no resolved verification method' };
    }

    const siteUrl = process.env.CONVEX_SITE_URL?.replace(/\/$/, '') ?? '';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const exp = nowSeconds + 3600;
    const subHash = await sha256Hex(`${intent._id}:${method.methodKey}:${args.authUserId}`);
    const token = await signLicenseJwt(
      {
        iss: `${siteUrl}/api/auth`,
        aud: LICENSE_AUDIENCE,
        sub: subHash,
        jti: grantClaims.jti,
        package_id: intent.packageId,
        machine_fingerprint: args.machineFingerprint,
        provider: method.providerKey,
        iat: nowSeconds,
        exp,
      },
      privateKey,
      process.env.YUCP_ROOT_KEY_ID ?? 'yucp-root'
    );

    await ctx.runMutation(internal.verificationIntents.consumeVerificationGrant, {
      intentId: args.intentId,
    });

    return { success: true, token, expiresAt: exp };
  },
});

export const consumeVerificationGrant = internalMutation({
  args: {
    intentId: v.id('verification_intents'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (!intent) {
      throw new Error(`Verification intent not found: ${args.intentId}`);
    }
    await ctx.db.patch(args.intentId, {
      status: 'redeemed',
      verificationGrantUsedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});
