import { describe, expect, it } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { makeTestConvex } from './testHelpers';

/**
 * Open-server attestation store invariants. Everything here operates on already-hashed opaque values
 * (the closed coupling-service does the TPM verification and salting), so these tests exercise the
 * identity-graph resolution, the licenseSubject block lookup used by the unlock gate, the manual
 * review flow, and the single-use challenge nonce. No raw identifier or secret is involved.
 */

type TestConvex = ReturnType<typeof makeTestConvex>;

function minimalAttestation(overrides: {
  licenseSubject?: string;
  correlationId?: string;
  tpmVerified?: boolean;
}) {
  return {
    tpmVerified: overrides.tpmVerified ?? true,
    flags: [] as Array<'no_tpm' | 'spoof_suspected' | 'vm' | 'low_confidence'>,
    fingerprintVector: [] as Array<{ component: string; hash: string; weight: number }>,
    osAnchorHashes: [] as string[],
    correlationId: overrides.correlationId ?? 'corr-1',
    licenseSubject: overrides.licenseSubject,
  };
}

async function record(
  t: TestConvex,
  opts: { ekHash?: string; licenseSubject?: string; correlationId?: string }
): Promise<{ nodeId: Id<'identity_nodes'>; blocked: boolean; durableAnchorCount: number }> {
  const anchors = opts.ekHash ? [{ anchorType: 'tpm_ek' as const, anchorHash: opts.ekHash }] : [];
  return await t.mutation(internal.attestation.recordResolution, {
    anchors,
    attestation: minimalAttestation({
      licenseSubject: opts.licenseSubject,
      correlationId: opts.correlationId,
    }),
  });
}

async function flagBlock(t: TestConvex, nodeId: Id<'identity_nodes'>): Promise<Id<'blocked_identities'>> {
  await t.mutation(internal.attestation.flagIdentityForReview, {
    identityNodeId: nodeId,
    reason: 'confirmed coupling trace',
    evidenceRef: 'trace-1',
  });
  return await t.run(async (ctx) => {
    const blocks = await ctx.db
      .query('blocked_identities')
      .withIndex('by_identity_node', (q) => q.eq('identityNodeId', nodeId))
      .collect();
    const block = blocks.find((candidate) => candidate.status === 'pending');
    return block?._id as Id<'blocked_identities'>;
  });
}

async function blockNode(
  t: TestConvex,
  nodeId: Id<'identity_nodes'>
): Promise<Id<'blocked_identities'>> {
  const blockId = await flagBlock(t, nodeId);
  await t.mutation(internal.attestation.reviewIdentityBlock, {
    blockId,
    decision: 'active',
    reviewedByUserId: 'reviewer-1',
  });
  return blockId;
}

describe('attestation identity graph', () => {
  it('collapses a second submit sharing a TPM anchor into the same node', async () => {
    const t = makeTestConvex();
    const first = await record(t, { ekHash: 'ek-shared', licenseSubject: 'lic-1' });
    const second = await record(t, { ekHash: 'ek-shared', licenseSubject: 'lic-2' });
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.durableAnchorCount).toBe(1);
  });

  it('creates distinct nodes for distinct durable anchors', async () => {
    const t = makeTestConvex();
    const a = await record(t, { ekHash: 'ek-a', licenseSubject: 'lic-a' });
    const b = await record(t, { ekHash: 'ek-b', licenseSubject: 'lic-b' });
    expect(b.nodeId).not.toBe(a.nodeId);
  });

  it('is not blocked before review and is blocked after review promotes the node', async () => {
    const t = makeTestConvex();
    const { nodeId } = await record(t, { ekHash: 'ek-1', licenseSubject: 'lic-block' });

    const before = await t.query(internal.attestation.isIdentityBlocked, {
      licenseSubject: 'lic-block',
    });
    expect(before.blocked).toBe(false);

    await blockNode(t, nodeId);

    const after = await t.query(internal.attestation.isIdentityBlocked, {
      licenseSubject: 'lic-block',
    });
    expect(after.blocked).toBe(true);
  });

  it('inherits the block for a new account on the same blocked hardware', async () => {
    const t = makeTestConvex();
    const { nodeId } = await record(t, { ekHash: 'ek-same', licenseSubject: 'lic-old' });
    await blockNode(t, nodeId);

    // New account (new licenseSubject) on the same TPM resolves to the same blocked node.
    const fresh = await record(t, { ekHash: 'ek-same', licenseSubject: 'lic-new' });
    expect(fresh.nodeId).toBe(nodeId);

    const lookup = await t.query(internal.attestation.isIdentityBlocked, {
      licenseSubject: 'lic-new',
    });
    expect(lookup.blocked).toBe(true);
  });

  it('blocks a license subject if any of its attestations resolve to a blocked node', async () => {
    const t = makeTestConvex();
    await record(t, { ekHash: 'ek-before-block', licenseSubject: 'lic-reused' });
    const blocked = await record(t, { ekHash: 'ek-after-block', licenseSubject: 'lic-reused' });
    await blockNode(t, blocked.nodeId);

    const lookup = await t.query(internal.attestation.isIdentityBlocked, {
      licenseSubject: 'lic-reused',
    });
    expect(lookup.blocked).toBe(true);
  });

  it('reverses a block on appeal', async () => {
    const t = makeTestConvex();
    const { nodeId } = await record(t, { ekHash: 'ek-appeal', licenseSubject: 'lic-appeal' });
    await blockNode(t, nodeId);

    const blockId = await t.run(async (ctx) => {
      const block = await ctx.db
        .query('blocked_identities')
        .withIndex('by_identity_node', (q) => q.eq('identityNodeId', nodeId))
        .first();
      return block?._id as Id<'blocked_identities'>;
    });
    await t.mutation(internal.attestation.reviewIdentityBlock, {
      blockId,
      decision: 'reversed',
      reviewedByUserId: 'reviewer-1',
      appeal: 'verified legitimate owner',
    });

    const after = await t.query(internal.attestation.isIdentityBlocked, {
      licenseSubject: 'lic-appeal',
    });
    expect(after.blocked).toBe(false);
  });

  it('keeps a node blocked while another active block record remains', async () => {
    const t = makeTestConvex();
    const { nodeId } = await record(t, { ekHash: 'ek-multi-block', licenseSubject: 'lic-multi-block' });
    const firstBlockId = await blockNode(t, nodeId);
    const secondBlockId = await flagBlock(t, nodeId);
    await t.mutation(internal.attestation.reviewIdentityBlock, {
      blockId: secondBlockId,
      decision: 'active',
      reviewedByUserId: 'reviewer-2',
    });

    await t.mutation(internal.attestation.reviewIdentityBlock, {
      blockId: firstBlockId,
      decision: 'reversed',
      reviewedByUserId: 'reviewer-1',
      appeal: 'first evidence reversed',
    });

    const afterFirstReversal = await t.query(internal.attestation.isIdentityBlocked, {
      licenseSubject: 'lic-multi-block',
    });
    expect(afterFirstReversal.blocked).toBe(true);

    await t.mutation(internal.attestation.reviewIdentityBlock, {
      blockId: secondBlockId,
      decision: 'reversed',
      reviewedByUserId: 'reviewer-2',
      appeal: 'second evidence reversed',
    });

    const afterAllReversed = await t.query(internal.attestation.isIdentityBlocked, {
      licenseSubject: 'lic-multi-block',
    });
    expect(afterAllReversed.blocked).toBe(false);
  });

  it('reports no block for an unknown licenseSubject', async () => {
    const t = makeTestConvex();
    const lookup = await t.query(internal.attestation.isIdentityBlocked, {
      licenseSubject: 'never-seen',
    });
    expect(lookup.blocked).toBe(false);
  });

  it('stores only the opaque hashes it was given (no raw values)', async () => {
    const t = makeTestConvex();
    await t.mutation(internal.attestation.recordResolution, {
      anchors: [{ anchorType: 'tpm_ek', anchorHash: 'ek-opaque' }],
      attestation: {
        ...minimalAttestation({ licenseSubject: 'lic-opaque' }),
        ekHash: 'ek-opaque',
        usrIdHash: 'usr-opaque',
        fingerprintVector: [{ component: 'cpuid', hash: 'h-cpuid', weight: 3 }],
      },
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('machine_attestations')
        .withIndex('by_license_subject', (q) => q.eq('licenseSubject', 'lic-opaque'))
        .first()
    );
    expect(row?.ekHash).toBe('ek-opaque');
    expect(row?.usrIdHash).toBe('usr-opaque');
    expect(row?.fingerprintVector[0]?.hash).toBe('h-cpuid');
  });
});

describe('attestation payment anchor', () => {
  it('attaches a payment anchor and raises the durable count to two', async () => {
    const t = makeTestConvex();
    await record(t, { ekHash: 'ek-pay', licenseSubject: 'lic-pay' });
    const result = await t.mutation(internal.attestation.attachPaymentAnchor, {
      licenseSubject: 'lic-pay',
      paymentFingerprintHash: 'card-hash-1',
    });
    expect(result.attached).toBe(true);
    const node = await t.run(async (ctx) => ctx.db.get(result.nodeId as Id<'identity_nodes'>));
    expect(node?.durableAnchorCount).toBe(2); // tpm_ek + payment
  });

  it('merges two machines that share a payment instrument into one node', async () => {
    const t = makeTestConvex();
    await record(t, { ekHash: 'ek-m1', licenseSubject: 'lic-m1' });
    await record(t, { ekHash: 'ek-m2', licenseSubject: 'lic-m2' });

    await t.mutation(internal.attestation.attachPaymentAnchor, {
      licenseSubject: 'lic-m1',
      paymentFingerprintHash: 'shared-card',
    });
    await t.mutation(internal.attestation.attachPaymentAnchor, {
      licenseSubject: 'lic-m2',
      paymentFingerprintHash: 'shared-card',
    });

    // Both license subjects now resolve to the same node.
    const n1 = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('machine_attestations')
            .withIndex('by_license_subject', (q) => q.eq('licenseSubject', 'lic-m1'))
            .first()
        )?.identityNodeId
    );
    const n2 = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('machine_attestations')
            .withIndex('by_license_subject', (q) => q.eq('licenseSubject', 'lic-m2'))
            .first()
        )?.identityNodeId
    );
    expect(n1).toBe(n2);
  });

  it('propagates an existing block across a payment merge', async () => {
    const t = makeTestConvex();
    const { nodeId } = await record(t, { ekHash: 'ek-b1', licenseSubject: 'lic-b1' });
    await blockNode(t, nodeId);
    await record(t, { ekHash: 'ek-b2', licenseSubject: 'lic-b2' });

    await t.mutation(internal.attestation.attachPaymentAnchor, {
      licenseSubject: 'lic-b1',
      paymentFingerprintHash: 'card-block',
    });
    await t.mutation(internal.attestation.attachPaymentAnchor, {
      licenseSubject: 'lic-b2',
      paymentFingerprintHash: 'card-block',
    });

    // The second machine, merged via the shared card into the blocked node, is now blocked too.
    const lookup = await t.query(internal.attestation.isIdentityBlocked, {
      licenseSubject: 'lic-b2',
    });
    expect(lookup.blocked).toBe(true);
  });

  it('moves active block records to the surviving node during a payment merge', async () => {
    const t = makeTestConvex();
    const blocked = await record(t, { ekHash: 'ek-merge-blocked', licenseSubject: 'lic-merge-blocked' });
    const blockId = await blockNode(t, blocked.nodeId);
    await t.mutation(internal.attestation.attachPaymentAnchor, {
      licenseSubject: 'lic-merge-blocked',
      paymentFingerprintHash: 'card-merge-review',
    });
    const survivor = await record(t, { ekHash: 'ek-merge-survivor', licenseSubject: 'lic-merge-survivor' });

    await t.mutation(internal.attestation.attachPaymentAnchor, {
      licenseSubject: 'lic-merge-survivor',
      paymentFingerprintHash: 'card-merge-review',
    });

    const movedBlock = await t.run(async (ctx) => ctx.db.get(blockId));
    expect(movedBlock?.identityNodeId).toBe(survivor.nodeId);

    await t.mutation(internal.attestation.reviewIdentityBlock, {
      blockId,
      decision: 'reversed',
      reviewedByUserId: 'reviewer-1',
      appeal: 'merged block reviewed',
    });

    const lookup = await t.query(internal.attestation.isIdentityBlocked, {
      licenseSubject: 'lic-merge-survivor',
    });
    expect(lookup.blocked).toBe(false);
  });
});

describe('attestation challenge nonce', () => {
  it('issues a fresh nonce and consumes it exactly once', async () => {
    const t = makeTestConvex();
    const { nonce } = await t.mutation(internal.attestation.issueChallenge, {
      correlationId: 'corr-nonce',
    });
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);

    await t.mutation(internal.attestation.consumeChallenge, { nonce });
    await expect(t.mutation(internal.attestation.consumeChallenge, { nonce })).rejects.toThrow();
  });

  it('rejects an unknown nonce', async () => {
    const t = makeTestConvex();
    await expect(
      t.mutation(internal.attestation.consumeChallenge, { nonce: 'deadbeef' })
    ).rejects.toThrow();
  });
});

describe('coupling proof record', () => {
  it('persists opaque hashes and links to an existing identity node by licenseSubject', async () => {
    const t = makeTestConvex();
    // An attestation already resolved this licenseSubject to a node.
    const node = await record(t, { ekHash: 'ek-coupling', licenseSubject: 'lic-coupling' });

    const result = await t.mutation(internal.attestation.recordCouplingProof, {
      correlationId: 'corr-coupling',
      tpmVerified: true,
      flags: [],
      assets: [{ pathHash: 'p-hash', contentSha256: 'a'.repeat(64) }],
      selfHashRef: 'self-hash',
      licenseSubject: 'lic-coupling',
    });

    expect(result.identityNodeId).toBe(node.nodeId);
    const stored = await t.run(async (ctx) => ctx.db.get(result.proofId));
    expect(stored?.assets[0]?.contentSha256).toBe('a'.repeat(64));
    // Only hashes are stored - no raw path/bytes.
    expect(stored?.assets[0]?.pathHash).toBe('p-hash');
  });

  it('enforces single-use nonce so a captured coupling proof cannot be replayed', async () => {
    const t = makeTestConvex();
    const { nonce } = await t.mutation(internal.attestation.issueChallenge, {
      correlationId: 'corr-replay',
    });
    // First submit consumes the nonce; a replay of the same nonce is rejected.
    await t.mutation(internal.attestation.consumeChallenge, { nonce });
    await expect(
      t.mutation(internal.attestation.consumeChallenge, { nonce })
    ).rejects.toThrow();
  });
});
