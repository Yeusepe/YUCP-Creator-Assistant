/**
 * YUCP Certificate Authority, Convex functions for certificate lifecycle.
 *
 * Certificate issuance flow:
 *   1. Creator completes YUCP OAuth (PKCE flow in Unity Editor)
 *   2. Access token is validated via JWKS in the httpAction (http.ts)
 *   3. `issueCertificate` action builds CertData, signs with root Ed25519 key, persists
 *   4. Cert envelope (JSON) returned to creator for embedding in Unity project
 *
 * Short-lived certificates: 90-day TTL (Layer 5 defense).
 * Rate limit: 1 cert per YUCP account per 30 days.
 *
 * Identity anchor: Better Auth user ID (yucpUserId), stable across provider
 * reconnects, not tied to any single storefront (Gumroad, Jinxxy, etc.).
 *
 * References:
 *   Sigstore cert transparency  https://docs.sigstore.dev/logging/overview/
 *   RFC 9700 OAuth best practice https://www.ietf.org/rfc/rfc9700.html
 */

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { type CertData, type CertEnvelope, signCertData } from './lib/yucpCrypto';

const CERT_TTL_DAYS = 90;
const RATE_LIMIT_DAYS = 30;
const NEW_KEY_RATE_LIMIT = 5; // max new machine keys per 30 days per account
const RENEWAL_OVERLAP_WINDOW_DAYS = 14;
const ISSUER = 'YUCP Certificate Authority';

type StoredCertificate = {
  certData: string;
  certNonce: string;
  createdAt: number;
  devPublicKey: string;
  expiresAt: number;
  issuedAt: number;
  publisherId: string;
  publisherName: string;
  status: 'active' | 'revoked' | 'expired';
  updatedAt: number;
  yucpUserId: string;
};

export function isWithinRenewalOverlapWindow(expiresAt: number, now = Date.now()): boolean {
  return expiresAt > now && expiresAt - now <= RENEWAL_OVERLAP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

export function selectLatestActiveCertificate<T extends StoredCertificate>(
  certificates: T[],
  now = Date.now()
): T | null {
  return (
    certificates
      .filter((certificate) => certificate.status === 'active' && certificate.expiresAt > now)
      .sort((left, right) => right.issuedAt - left.issuedAt)[0] ?? null
  );
}

export function summarizeActiveCertificatesByDevice<T extends StoredCertificate>(
  certificates: T[],
  now = Date.now()
): T[] {
  const latestByDevice = new Map<string, T>();
  for (const certificate of certificates) {
    if (certificate.status !== 'active' || certificate.expiresAt <= now) continue;
    const existing = latestByDevice.get(certificate.devPublicKey);
    if (!existing || certificate.issuedAt > existing.issuedAt) {
      latestByDevice.set(certificate.devPublicKey, certificate);
    }
  }

  return [...latestByDevice.values()].sort((left, right) => right.issuedAt - left.issuedAt);
}

export function countDistinctActiveDeviceKeys<
  T extends Pick<StoredCertificate, 'devPublicKey' | 'expiresAt' | 'status'>,
>(certificates: T[], now = Date.now()): number {
  return new Set(
    certificates
      .filter((certificate) => certificate.status === 'active' && certificate.expiresAt > now)
      .map((certificate) => certificate.devPublicKey)
  ).size;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal mutations
// ─────────────────────────────────────────────────────────────────────────────

export const storeCertificate = internalMutation({
  args: {
    publisherId: v.string(),
    publisherName: v.string(),
    /** Better Auth user ID */
    yucpUserId: v.string(),
    discordUserId: v.optional(v.string()),
    devPublicKey: v.string(),
    certNonce: v.string(),
    certData: v.string(),
    schemaVersion: v.number(),
    issuedAt: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert('yucp_certificates', {
      ...args,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const autoRevokeActiveForPublisher = internalMutation({
  args: { publisherId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('yucp_certificates')
      .withIndex('by_publisher_id', (q) => q.eq('publisherId', args.publisherId))
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    const now = Date.now();
    await Promise.all(
      existing.map((cert) =>
        ctx.db.patch(cert._id, {
          status: 'revoked',
          revocationReason: args.reason,
          revokedAt: now,
          updatedAt: now,
        })
      )
    );
    return existing.length;
  },
});

export const revokeCertByNonce = internalMutation({
  args: { certNonce: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const cert = await ctx.db
      .query('yucp_certificates')
      .withIndex('by_cert_nonce', (q) => q.eq('certNonce', args.certNonce))
      .first();
    if (!cert) return { revoked: false };
    await ctx.db.patch(cert._id, {
      status: 'revoked',
      revocationReason: args.reason,
      revokedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { revoked: true };
  },
});

export const revokeOwnedCertByNonce = internalMutation({
  args: { yucpUserId: v.string(), certNonce: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const cert = await ctx.db
      .query('yucp_certificates')
      .withIndex('by_cert_nonce', (q) => q.eq('certNonce', args.certNonce))
      .first();
    if (!cert) return { revoked: false, notFound: true as const };
    if (cert.yucpUserId !== args.yucpUserId) return { revoked: false, forbidden: true as const };
    await ctx.db.patch(cert._id, {
      status: 'revoked',
      revocationReason: args.reason,
      revokedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { revoked: true as const };
  },
});

export const recordIssuance = internalMutation({
  args: {
    yucpUserId: v.string(),
    publisherId: v.string(),
    devPublicKey: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('cert_issuance_log', {
      ...args,
      issuedAt: Date.now(),
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal queries
// ─────────────────────────────────────────────────────────────────────────────

export const checkRateLimit = internalQuery({
  args: { yucpUserId: v.string(), devPublicKey: v.string() },
  handler: async (ctx, args) => {
    // Same-key re-request (same machine, new project or cert refresh): always allowed.
    // The key is already registered, this is not a new key registration.
    const existingForKey = await ctx.db
      .query('yucp_certificates')
      .withIndex('by_dev_public_key', (q) => q.eq('devPublicKey', args.devPublicKey))
      .first();
    if (existingForKey?.yucpUserId === args.yucpUserId) {
      return { exceeded: false, isRenewal: true };
    }

    // New key: count how many distinct new keys this account registered in the last 30 days.
    const cutoff = Date.now() - RATE_LIMIT_DAYS * 24 * 60 * 60 * 1000;
    const recentIssuances = await ctx.db
      .query('cert_issuance_log')
      .withIndex('by_yucp_user_id', (q) => q.eq('yucpUserId', args.yucpUserId))
      .filter((q) => q.gte(q.field('issuedAt'), cutoff))
      .collect();

    // Count distinct new keys (exclude the current key if somehow already in log)
    const distinctNewKeys = new Set(
      recentIssuances.filter((r) => r.devPublicKey !== args.devPublicKey).map((r) => r.devPublicKey)
    );

    return {
      exceeded: distinctNewKeys.size >= NEW_KEY_RATE_LIMIT,
      isRenewal: false,
      newKeysUsed: distinctNewKeys.size,
      newKeysLimit: NEW_KEY_RATE_LIMIT,
    };
  },
});

export const getCertByPublisherId = internalQuery({
  args: { publisherId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db
      .query('yucp_certificates')
      .withIndex('by_publisher_id', (q) => q.eq('publisherId', args.publisherId))
      .filter((q) => q.and(q.eq(q.field('status'), 'active'), q.gt(q.field('expiresAt'), now)))
      .first();
  },
});

export const getCertByDevPublicKey = internalQuery({
  args: { devPublicKey: v.string() },
  handler: async (ctx, args) => {
    const certs = await ctx.db
      .query('yucp_certificates')
      .withIndex('by_dev_public_key', (q) => q.eq('devPublicKey', args.devPublicKey))
      .collect();
    return certs.sort((left, right) => right.issuedAt - left.issuedAt)[0] ?? null;
  },
});

export const getCertByNonce = internalQuery({
  args: { certNonce: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('yucp_certificates')
      .withIndex('by_cert_nonce', (q) => q.eq('certNonce', args.certNonce))
      .first();
  },
});

export const getActiveCertForUser = internalQuery({
  args: { yucpUserId: v.string(), devPublicKey: v.string() },
  handler: async (ctx, args) => {
    const certs = await ctx.db
      .query('yucp_certificates')
      .withIndex('by_dev_public_key', (q) => q.eq('devPublicKey', args.devPublicKey))
      .filter((q) => q.eq(q.field('yucpUserId'), args.yucpUserId))
      .collect();
    return selectLatestActiveCertificate(certs);
  },
});

export const countActiveCertsForUser = internalQuery({
  args: { yucpUserId: v.string() },
  handler: async (ctx, args) => {
    const certs = await ctx.db
      .query('yucp_certificates')
      .withIndex('by_yucp_user_id', (q) => q.eq('yucpUserId', args.yucpUserId))
      .collect();

    return countDistinctActiveDeviceKeys(certs);
  },
});

export const listActiveCertsForUser = internalQuery({
  args: { yucpUserId: v.string() },
  handler: async (ctx, args) => {
    const certs = await ctx.db
      .query('yucp_certificates')
      .withIndex('by_yucp_user_id', (q) => q.eq('yucpUserId', args.yucpUserId))
      .collect();

    return summarizeActiveCertificatesByDevice(certs);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Certificate issuance action
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Issue a signed YUCP publisher certificate.
 *
 * Identity is anchored to `yucpUserId` (Better Auth user ID) + `discordUserId`
 * from the subject record, not to any specific storefront account.
 *
 * Environment variables required:
 *   YUCP_ROOT_PRIVATE_KEY , 32-byte Ed25519 private key (base64)
 *   YUCP_KEY_ID           , key identifier string (default "yucp-root-2025")
 */
export const issueCertificate = internalAction({
  args: {
    publisherName: v.string(),
    devPublicKey: v.string(),
    /** Better Auth user ID (from verified OAuth token) */
    yucpUserId: v.string(),
    discordUserId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CertEnvelope> => {
    const now = new Date();
    const rootPrivateKey = process.env.YUCP_ROOT_PRIVATE_KEY;
    const keyId = process.env.YUCP_KEY_ID ?? 'yucp-root-2025';
    if (!rootPrivateKey) throw new Error('YUCP_ROOT_PRIVATE_KEY not configured');

    // Rate limit: same-key renewals (same machine) are always free.
    // New key registrations (new machine) are limited to 5 per 30 days.
    const rateLimit = await ctx.runQuery(internal.yucpCertificates.checkRateLimit, {
      yucpUserId: args.yucpUserId,
      devPublicKey: args.devPublicKey,
    });
    if (rateLimit.exceeded) {
      throw new Error(
        `Rate limit: you have registered ${rateLimit.newKeysUsed} new machines in the last ${RATE_LIMIT_DAYS} days (limit ${rateLimit.newKeysLimit}). Please wait before adding another machine.`
      );
    }

    const existingActive = await ctx.runQuery(internal.yucpCertificates.getActiveCertForUser, {
      yucpUserId: args.yucpUserId,
      devPublicKey: args.devPublicKey,
    });
    if (existingActive) {
      const existingEnvelope = JSON.parse(existingActive.certData) as CertEnvelope;
      const existingIssuedAt = Date.parse(existingEnvelope.cert.issuedAt);
      if (
        !isWithinRenewalOverlapWindow(existingActive.expiresAt) ||
        (Number.isFinite(existingIssuedAt) &&
          now.getTime() - existingIssuedAt < 24 * 60 * 60 * 1000)
      ) {
        return existingEnvelope;
      }
    }

    // Reuse publisherId for the same devPublicKey (key rotation keeps identity stable)
    const existingByKey = await ctx.runQuery(internal.yucpCertificates.getCertByDevPublicKey, {
      devPublicKey: args.devPublicKey,
    });

    // c73: Prevent cross-user publisherId hijacking. If a devPublicKey is already
    // registered under a different user, it must be revoked first.
    if (existingByKey && existingByKey.yucpUserId !== args.yucpUserId) {
      throw new ConvexError('devPublicKey is already registered to a different user');
    }

    const publisherId = existingByKey?.publisherId ?? crypto.randomUUID();

    const expiresAt = new Date(now.getTime() + CERT_TTL_DAYS * 24 * 60 * 60 * 1000);
    const certNonce = crypto.randomUUID();

    const certData: CertData = {
      devPublicKey: args.devPublicKey,
      expiresAt: expiresAt.toISOString(),
      yucpUserId: args.yucpUserId,
      identityAnchors: {
        yucpUserId: args.yucpUserId,
        ...(args.discordUserId !== undefined && { discordUserId: args.discordUserId }),
      },
      issuedAt: now.toISOString(),
      issuer: ISSUER,
      nonce: certNonce,
      publisherId,
      publisherName: args.publisherName,
      schemaVersion: 2,
    };

    const envelope = await signCertData(certData, rootPrivateKey, keyId);

    await ctx.runMutation(internal.yucpCertificates.storeCertificate, {
      publisherId,
      publisherName: args.publisherName,
      yucpUserId: args.yucpUserId,
      discordUserId: args.discordUserId,
      devPublicKey: args.devPublicKey,
      certNonce,
      certData: JSON.stringify(envelope),
      schemaVersion: 2,
      issuedAt: now.getTime(),
      expiresAt: expiresAt.getTime(),
    });

    await ctx.runMutation(internal.yucpCertificates.recordIssuance, {
      yucpUserId: args.yucpUserId,
      publisherId,
      devPublicKey: args.devPublicKey,
    });

    return envelope;
  },
});
