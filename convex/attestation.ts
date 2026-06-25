/**
 * Hardware-attested anti-ripper identity: OPEN-SERVER storage only.
 *
 * This file is part of the open-source server, so it deliberately contains NO attestation secrets:
 * no TPM verification, no channel decryption, no salting, no component weighting, and no block
 * thresholds. All of that lives in the closed coupling-service. Here we only:
 *   - issue and consume opaque challenge nonces (a generic anti-replay primitive),
 *   - persist already-hashed anchors and an opaque verdict the closed service computed,
 *   - resolve those opaque anchor hashes to an identity node by exact-equality lookup,
 *   - expose a blocked-status lookup keyed on licenseSubject for the unlock gate, and
 *   - let an admin flip a node's block status after manual review.
 *
 * Every value stored here is a salted hash produced by the closed service with a salt this server
 * never sees, so reading this source (or the database) reveals nothing about how identities are
 * fingerprinted or matched. The closed service authenticates through the internal relay endpoint.
 */

import type { GenericMutationCtx } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import type { DataModel, Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery } from './_generated/server';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Merge one identity node into another: repoint every anchor AND every attestation row, mark the
 * absorbed node merged, and propagate a blocked status either way (a block on either side wins). This
 * keeps the licenseSubject -> attestation -> node lookup correct after a merge so a blocked person
 * cannot escape by landing on a freshly created node.
 */
async function absorbNode(
  ctx: GenericMutationCtx<DataModel>,
  fromId: Id<'identity_nodes'>,
  intoId: Id<'identity_nodes'>,
  now: number
): Promise<void> {
  if (fromId === intoId) return;
  const fromNode = await ctx.db.get(fromId);
  const intoNode = await ctx.db.get(intoId);
  const anchors = await ctx.db
    .query('identity_node_anchors')
    .withIndex('by_node', (q) => q.eq('nodeId', fromId))
    .collect();
  for (const a of anchors) {
    await ctx.db.patch(a._id, { nodeId: intoId });
  }
  const atts = await ctx.db
    .query('machine_attestations')
    .withIndex('by_identity_node', (q) => q.eq('identityNodeId', fromId))
    .collect();
  for (const att of atts) {
    await ctx.db.patch(att._id, { identityNodeId: intoId });
  }
  const proofs = await ctx.db
    .query('coupling_proofs')
    .withIndex('by_identity_node', (q) => q.eq('identityNodeId', fromId))
    .collect();
  for (const proof of proofs) {
    await ctx.db.patch(proof._id, { identityNodeId: intoId });
  }
  const blocks = await ctx.db
    .query('blocked_identities')
    .withIndex('by_identity_node', (q) => q.eq('identityNodeId', fromId))
    .collect();
  const existingIntoBlocks = await ctx.db
    .query('blocked_identities')
    .withIndex('by_identity_node', (q) => q.eq('identityNodeId', intoId))
    .collect();
  const hasActiveBlock =
    blocks.some((block) => block.status === 'active') ||
    existingIntoBlocks.some((block) => block.status === 'active');
  for (const block of blocks) {
    await ctx.db.patch(block._id, { identityNodeId: intoId, updatedAt: now });
  }
  await ctx.db.patch(fromId, { status: 'active', mergedFromNodeId: intoId, updatedAt: now });
  if (fromNode?.status === 'blocked' || intoNode?.status === 'blocked' || hasActiveBlock) {
    await ctx.db.patch(intoId, { status: 'blocked', updatedAt: now });
  }
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Durable anchor types. Kept here only so resolution can tag edges; the closed service decides policy. */
const DURABLE_ANCHOR_TYPES = new Set(['tpm_ek', 'payment']);

async function getLatestAttestationForLicenseSubject(
  ctx: GenericMutationCtx<DataModel>,
  licenseSubject: string
): Promise<Doc<'machine_attestations'> | null> {
  return await ctx.db
    .query('machine_attestations')
    .withIndex('by_license_subject_created_at', (q) => q.eq('licenseSubject', licenseSubject))
    .order('desc')
    .first();
}

async function linkPendingCouplingProofsForLicenseSubject(
  ctx: GenericMutationCtx<DataModel>,
  licenseSubject: string,
  correlationId: string,
  identityNodeId: Id<'identity_nodes'>
): Promise<void> {
  const proofs = await ctx.db
    .query('coupling_proofs')
    .withIndex('by_correlation', (q) => q.eq('correlationId', correlationId))
    .collect();
  for (const proof of proofs) {
    if (!proof.identityNodeId && proof.licenseSubject === licenseSubject) {
      await ctx.db.patch(proof._id, { identityNodeId });
    }
  }
}

/** Mint a fresh single-use challenge nonce. Generic anti-replay; carries no attestation secret. */
export const issueChallenge = internalMutation({
  args: { correlationId: v.string() },
  handler: async (ctx, args) => {
    const nonce = randomHex(32);
    const now = Date.now();
    await ctx.db.insert('attestation_challenges', {
      nonce,
      correlationId: args.correlationId,
      issuedAt: now,
      expiresAt: now + CHALLENGE_TTL_MS,
    });
    return { nonce, expiresAt: now + CHALLENGE_TTL_MS };
  },
});

/** Consume a challenge nonce exactly once, enforcing TTL. Throws on replay or expiry. */
export const consumeChallenge = internalMutation({
  args: { nonce: v.string() },
  handler: async (ctx, args) => {
    const challenge = await ctx.db
      .query('attestation_challenges')
      .withIndex('by_nonce', (q) => q.eq('nonce', args.nonce))
      .first();
    if (!challenge) {
      throw new ConvexError('Unknown attestation challenge');
    }
    if (challenge.consumedAt) {
      throw new ConvexError('Attestation challenge already used');
    }
    if (Date.now() > challenge.expiresAt) {
      throw new ConvexError('Attestation challenge expired');
    }
    await ctx.db.patch(challenge._id, { consumedAt: Date.now() });
    return { correlationId: challenge.correlationId };
  },
});

/**
 * Persist an attestation the closed service already verified and hashed.
 * Inputs are opaque salted hashes plus an opaque verdict. Resolution is a generic exact-match graph
 * lookup: if any durable anchor hash already maps to a node, reuse (merging implicated nodes);
 * otherwise create a node. Returns the node id and its current block status only.
 */
export const recordResolution = internalMutation({
  args: {
    anchors: v.array(
      v.object({
        anchorType: v.union(
          v.literal('tpm_ek'),
          v.literal('payment'),
          v.literal('usr'),
          v.literal('email'),
          v.literal('auth_user'),
          v.literal('os_machine')
        ),
        anchorHash: v.string(),
      })
    ),
    attestation: v.object({
      ekHash: v.optional(v.string()),
      akPubHash: v.optional(v.string()),
      tpmVerified: v.boolean(),
      flags: v.array(
        v.union(
          v.literal('no_tpm'),
          v.literal('spoof_suspected'),
          v.literal('vm'),
          v.literal('low_confidence')
        )
      ),
      fingerprintVector: v.array(
        v.object({ component: v.string(), hash: v.string(), weight: v.number() })
      ),
      osAnchorHashes: v.array(v.string()),
      networkAnchorHash: v.optional(v.string()),
      paymentFingerprintHash: v.optional(v.string()),
      usrIdHash: v.optional(v.string()),
      licenseSubject: v.optional(v.string()),
      machineFingerprintHash: v.optional(v.string()),
      authUserId: v.optional(v.string()),
      usrIdConfidence: v.optional(v.string()),
      correlationId: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const durableMatches = new Set<Id<'identity_nodes'>>();
    for (const anchor of args.anchors) {
      const existing = await ctx.db
        .query('identity_node_anchors')
        .withIndex('by_type_hash', (q) =>
          q.eq('anchorType', anchor.anchorType).eq('anchorHash', anchor.anchorHash)
        )
        .first();
      if (existing && DURABLE_ANCHOR_TYPES.has(anchor.anchorType)) {
        durableMatches.add(existing.nodeId);
      }
    }

    let nodeId: Id<'identity_nodes'>;
    if (durableMatches.size === 0) {
      nodeId = await ctx.db.insert('identity_nodes', {
        status: 'active',
        durableAnchorCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const ids = Array.from(durableMatches);
      nodeId = ids[0];
      for (let i = 1; i < ids.length; i++) {
        await absorbNode(ctx, ids[i], nodeId, now);
      }
    }

    for (const anchor of args.anchors) {
      const present = await ctx.db
        .query('identity_node_anchors')
        .withIndex('by_type_hash', (q) =>
          q.eq('anchorType', anchor.anchorType).eq('anchorHash', anchor.anchorHash)
        )
        .first();
      if (present && present.nodeId === nodeId) {
        continue;
      }
      if (present && present.nodeId !== nodeId) {
        if (DURABLE_ANCHOR_TYPES.has(anchor.anchorType)) {
          await ctx.db.patch(present._id, { nodeId });
        } else {
          await ctx.db.insert('identity_node_anchors', {
            nodeId,
            anchorType: anchor.anchorType,
            anchorHash: anchor.anchorHash,
            isDurable: false,
            createdAt: now,
          });
        }
        continue;
      }
      await ctx.db.insert('identity_node_anchors', {
        nodeId,
        anchorType: anchor.anchorType,
        anchorHash: anchor.anchorHash,
        isDurable: DURABLE_ANCHOR_TYPES.has(anchor.anchorType),
        createdAt: now,
      });
    }

    const nodeAnchors = await ctx.db
      .query('identity_node_anchors')
      .withIndex('by_node', (q) => q.eq('nodeId', nodeId))
      .collect();
    const durableAnchorCount = nodeAnchors.filter((a) => a.isDurable).length;
    await ctx.db.patch(nodeId, { durableAnchorCount, updatedAt: now });

    await ctx.db.insert('machine_attestations', {
      ekHash: args.attestation.ekHash,
      akPubHash: args.attestation.akPubHash,
      tpmVerified: args.attestation.tpmVerified,
      flags: args.attestation.flags,
      fingerprintVector: args.attestation.fingerprintVector,
      osAnchorHashes: args.attestation.osAnchorHashes,
      networkAnchorHash: args.attestation.networkAnchorHash,
      paymentFingerprintHash: args.attestation.paymentFingerprintHash,
      usrIdHash: args.attestation.usrIdHash,
      licenseSubject: args.attestation.licenseSubject,
      machineFingerprintHash: args.attestation.machineFingerprintHash,
      authUserId: args.attestation.authUserId,
      identityNodeId: nodeId,
      usrIdConfidence: args.attestation.usrIdConfidence,
      correlationId: args.attestation.correlationId,
      createdAt: now,
    });
    if (args.attestation.licenseSubject) {
      await linkPendingCouplingProofsForLicenseSubject(
        ctx,
        args.attestation.licenseSubject,
        args.attestation.correlationId,
        nodeId
      );
    }

    const node = await ctx.db.get(nodeId);
    return { nodeId, blocked: node?.status === 'blocked', durableAnchorCount };
  },
});

/**
 * Unlock gate lookup. Keyed on licenseSubject (a plain SHA-256 join key the open server already
 * holds, same as coupling_trace_records), so this reveals nothing about the fingerprint salt.
 * Resolves licenseSubject -> attestation -> node and reports an active block.
 */
export const isIdentityBlocked = internalQuery({
  args: { licenseSubject: v.optional(v.string()), machineFingerprintHash: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.licenseSubject) {
      return { blocked: false, attested: false };
    }
    const attestations = args.machineFingerprintHash
      ? await ctx.db
          .query('machine_attestations')
          .withIndex('by_license_subject_machine', (q) =>
            q
              .eq('licenseSubject', args.licenseSubject)
              .eq('machineFingerprintHash', args.machineFingerprintHash)
          )
          .collect()
      : await ctx.db
          .query('machine_attestations')
          .withIndex('by_license_subject', (q) => q.eq('licenseSubject', args.licenseSubject))
          .collect();
    const currentMachineAttested = attestations.length > 0;
    for (const att of attestations) {
      if (!att.identityNodeId) {
        continue;
      }
      const node = await ctx.db.get(att.identityNodeId);
      if (node?.status === 'blocked') {
        return { blocked: true, attested: true };
      }
    }
    return { blocked: false, attested: currentMachineAttested };
  },
});

/**
 * Attach a payment durable anchor to the node behind a licenseSubject. The closed service salts the
 * payment instrument fingerprint (so this receives only an opaque hash). This is the anchor that
 * survives a new machine, because rippers reuse the same card or PayPal: if the same payment hash is
 * already on a different node, the two nodes are merged (same person, two machines).
 */
export const attachPaymentAnchor = internalMutation({
  args: { licenseSubject: v.string(), paymentFingerprintHash: v.string() },
  handler: async (ctx, args) => {
    const att = await getLatestAttestationForLicenseSubject(ctx, args.licenseSubject);
    if (!att?.identityNodeId) {
      return { attached: false };
    }
    const now = Date.now();
    const nodeId = att.identityNodeId;

    const existing = await ctx.db
      .query('identity_node_anchors')
      .withIndex('by_type_hash', (q) =>
        q.eq('anchorType', 'payment').eq('anchorHash', args.paymentFingerprintHash)
      )
      .first();

    if (existing && existing.nodeId !== nodeId) {
      // Same card seen on a different node: merge that node into this one (same person, two machines).
      await absorbNode(ctx, existing.nodeId, nodeId, now);
    } else if (!existing) {
      await ctx.db.insert('identity_node_anchors', {
        nodeId,
        anchorType: 'payment',
        anchorHash: args.paymentFingerprintHash,
        isDurable: true,
        createdAt: now,
      });
    }

    const nodeAnchors = await ctx.db
      .query('identity_node_anchors')
      .withIndex('by_node', (q) => q.eq('nodeId', nodeId))
      .collect();
    await ctx.db.patch(nodeId, {
      durableAnchorCount: nodeAnchors.filter((a) => a.isDurable).length,
      updatedAt: now,
    });
    return { attached: true, nodeId };
  },
});

/**
 * Persist a coupling proof the closed service already verified. Opaque hashes only. When a license
 * subject resolves to an existing identity node, the proof is linked to it (so "this person's import
 * did/did not couple" is answerable for review). Nonce single-use is enforced by the caller (route).
 */
export const recordCouplingProof = internalMutation({
  args: {
    correlationId: v.string(),
    tpmVerified: v.boolean(),
    flags: v.array(
      v.union(
        v.literal('no_tpm'),
        v.literal('spoof_suspected'),
        v.literal('vm'),
        v.literal('low_confidence')
      )
    ),
    assets: v.array(v.object({ pathHash: v.string(), contentSha256: v.string() })),
    selfHashRef: v.optional(v.string()),
    licenseSubject: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let identityNodeId: Id<'identity_nodes'> | undefined;
    if (args.licenseSubject) {
      const att = await getLatestAttestationForLicenseSubject(ctx, args.licenseSubject);
      identityNodeId = att?.identityNodeId ?? undefined;
    }
    const proofId = await ctx.db.insert('coupling_proofs', {
      correlationId: args.correlationId,
      tpmVerified: args.tpmVerified,
      flags: args.flags,
      assets: args.assets,
      selfHashRef: args.selfHashRef,
      licenseSubject: args.licenseSubject,
      identityNodeId,
      createdAt: Date.now(),
    });
    return { proofId, identityNodeId };
  },
});

/** Flag a node for manual review on a confirmed trace. The closed service supplies the evidence. */
export const flagIdentityForReview = internalMutation({
  args: {
    identityNodeId: v.id('identity_nodes'),
    reason: v.string(),
    evidenceRef: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert('blocked_identities', {
      identityNodeId: args.identityNodeId,
      status: 'pending',
      reason: args.reason,
      evidenceRef: args.evidenceRef,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Apply a review decision. The eligibility policy (durable-anchor threshold) is enforced by the
 * closed service before this is called; here we only flip status so the open server holds no policy.
 */
export const reviewIdentityBlock = internalMutation({
  args: {
    blockId: v.id('blocked_identities'),
    decision: v.union(v.literal('active'), v.literal('reversed')),
    reviewedByUserId: v.string(),
    appeal: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const block = await ctx.db.get(args.blockId);
    if (!block) {
      throw new ConvexError('Unknown block record');
    }
    const now = Date.now();
    await ctx.db.patch(args.blockId, {
      status: args.decision,
      reviewedByUserId: args.reviewedByUserId,
      appeal: args.appeal,
      updatedAt: now,
    });
    const nodeBlocks = await ctx.db
      .query('blocked_identities')
      .withIndex('by_identity_node', (q) => q.eq('identityNodeId', block.identityNodeId))
      .collect();
    const hasActiveBlock = nodeBlocks.some((candidate) => candidate.status === 'active');
    await ctx.db.patch(block.identityNodeId, {
      status: hasActiveBlock ? 'blocked' : 'active',
      updatedAt: now,
    });
  },
});
