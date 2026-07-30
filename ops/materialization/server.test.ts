import { describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createMaterializationControlPlaneHandler } from './server';

const endpoint = 'https://control.example.test/v2/internal/materialization-capabilities/consume';
const capabilityToken = Buffer.from('signed-capability').toString('base64url');
const now = 2_000_000_000;
const apiSecret = 'test-api-shared-secret-that-is-long';
const materializerSecret = 'test-materializer-secret-that-is-long';
const signingPrivateKey = new Uint8Array(32).fill(0x11);

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function createProof(target = endpoint, jti = 'proof-1', accessToken = capabilityToken) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const header = encodeJson({ alg: 'ES256', jwk, typ: 'dpop+jwt' });
  const payload = encodeJson({
    ath: createHash('sha256').update(accessToken, 'ascii').digest('base64url'),
    htm: 'POST',
    htu: target,
    iat: now,
    jti,
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
    dsaEncoding: 'ieee-p1363',
    key: privateKey,
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('materialization control-plane HTTP boundary', () => {
  it('serves authenticated package-installer TUF objects beside the catalog', async () => {
    const reads: string[] = [];
    const events: Array<{ event: string; status: string; traceId: string }> = [];
    const handler = createMaterializationControlPlaneHandler({
      broker: {
        claimNextJob: async () => {
          throw new Error('must not run');
        },
        completeRendition: async () => {
          throw new Error('must not run');
        },
        createInstallJob: async () => {
          throw new Error('must not run');
        },
        consumeCapability: async () => {
          throw new Error('must not run');
        },
        renewClaimLease: async () => {
          throw new Error('must not run');
        },
        failCapabilityJob: async () => {
          throw new Error('must not run');
        },
        getJobStatus: async () => {
          throw new Error('must not run');
        },
        issueCapability: async () => {
          throw new Error('must not run');
        },
      },
      apiSharedSecret: apiSecret,
      capabilityKeyId: new Uint8Array([1]),
      capabilityLifetimeSeconds: 300,
      capabilityPrivateKey: signingPrivateKey,
      capabilityPublicKey: new Uint8Array(32).fill(0x22),
      keyEpoch: 1,
      materializationAlgorithm: 'png-dct-qim-v2',
      materializerSharedSecret: materializerSecret,
      onEvent: (event) => events.push(event),
      packageInstallerTufRepository: {
        async read(role, repositoryPath) {
          reads.push(`${role}/${repositoryPath}`);
          return {
            body: new TextEncoder().encode('{"signed":"timestamp"}'),
            contentType: 'application/json',
          };
        },
      },
      pluginVersion: 'png-plugin-2',
      publicBaseUrl: 'https://control.example.test',
    });
    const url =
      'https://control.example.test/v2/internal/package-installer/tuf/metadata/timestamp.json';
    const unauthorized = await handler(new Request(url));
    expect(unauthorized.status).toBe(401);
    expect(reads).toEqual([]);

    const accepted = await handler(
      new Request(url, {
        headers: {
          Authorization: `Bearer ${apiSecret}`,
          traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
        },
      })
    );
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('private, no-store');
    expect(accepted.headers.get('content-type')).toBe('application/json');
    expect(accepted.headers.get('x-trace-id')).toBe('a'.repeat(32));
    expect(await accepted.text()).toBe('{"signed":"timestamp"}');
    expect(reads).toEqual(['metadata/timestamp.json']);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        event: 'package_installer.tuf.read',
        status: 'accepted',
        traceId: 'a'.repeat(32),
      })
    );
  });

  it('authenticates the Linux materializer before it consumes work', async () => {
    let calls = 0;
    const handler = createMaterializationControlPlaneHandler({
      broker: {
        claimNextJob: async () => {
          throw new Error('must not run');
        },
        completeRendition: async () => {
          throw new Error('must not run');
        },
        createInstallJob: async () => {
          throw new Error('must not run');
        },
        consumeCapability: async (input) => {
          calls += 1;
          expect(input.materializerId).toBe('data-node-1');
          expect(input.proofJti).toBe(calls === 1 ? 'proof-1' : 'proof-large');
          expect(input.verifiedProofKeyThumbprint).toHaveLength(32);
          return {
            algorithmVersion: 'png-dct-qim-v2',
            buyerSubjectPseudonym: 'buyer-pseudonym-1',
            capabilityId: 'capability-1',
            creatorDomain: 'creator-1',
            jobId: 'job-1',
            keyEpoch: 1,
            leaseGeneration: 1,
            outputFormat: 'zip',
            pluginVersion: 'png-plugin-2',
            protectedFiles: [],
            protectedSourceRoot: '2'.repeat(64),
            releaseRoot: '1'.repeat(64),
            sourceTree: {
              expiresAt: new Date((now + 300) * 1_000).toISOString(),
              grant: 'signed-source-grant',
              logicalBytes: 100,
              logicalFiles: 1,
              manifestSha256: '3'.repeat(64),
              manifestUrl:
                'https://delivery.example.test/v2/internal/materialization-sources/version-1/manifest',
              versionId: 'version-1',
            },
            success: true,
          };
        },
        renewClaimLease: async () => {
          throw new Error('must not run');
        },
        failCapabilityJob: async () => {
          throw new Error('must not run');
        },
        getJobStatus: async () => {
          throw new Error('must not run');
        },
        issueCapability: async () => {
          throw new Error('must not run');
        },
      },
      apiSharedSecret: apiSecret,
      capabilityKeyId: new Uint8Array([1]),
      capabilityLifetimeSeconds: 300,
      capabilityPrivateKey: signingPrivateKey,
      capabilityPublicKey: new Uint8Array(32).fill(0x22),
      keyEpoch: 1,
      materializationAlgorithm: 'png-dct-qim-v2',
      materializerSharedSecret: materializerSecret,
      now: () => new Date(now * 1_000),
      pluginVersion: 'png-plugin-2',
      publicBaseUrl: 'https://control.example.test',
    });
    const body = JSON.stringify({
      capability: capabilityToken,
      materializerId: 'data-node-1',
      proof: createProof(),
    });
    const unauthorized = await handler(
      new Request(endpoint, {
        body,
        headers: {
          Authorization: 'Bearer wrong-secret',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(unauthorized.status).toBe(401);
    expect(calls).toBe(0);

    const accepted = await handler(
      new Request(endpoint, {
        body,
        headers: {
          Authorization: `Bearer ${materializerSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(await accepted.json()).toMatchObject({
      capabilityId: 'capability-1',
      success: true,
    });
    expect(calls).toBe(1);

    const largeCapability = 'A'.repeat(256 * 1_024);
    const largeAccepted = await handler(
      new Request(endpoint, {
        body: JSON.stringify({
          capability: largeCapability,
          materializerId: 'data-node-1',
          proof: createProof(endpoint, 'proof-large', largeCapability),
        }),
        headers: {
          Authorization: `Bearer ${materializerSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(largeAccepted.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('rejects an oversized or malformed request before capability verification', async () => {
    let calls = 0;
    const handler = createMaterializationControlPlaneHandler({
      broker: {
        claimNextJob: async () => {
          throw new Error('must not run');
        },
        completeRendition: async () => {
          throw new Error('must not run');
        },
        createInstallJob: async () => {
          throw new Error('must not run');
        },
        consumeCapability: async () => {
          calls += 1;
          throw new Error('must not run');
        },
        renewClaimLease: async () => {
          throw new Error('must not run');
        },
        failCapabilityJob: async () => {
          throw new Error('must not run');
        },
        getJobStatus: async () => {
          throw new Error('must not run');
        },
        issueCapability: async () => {
          throw new Error('must not run');
        },
      },
      apiSharedSecret: apiSecret,
      capabilityKeyId: new Uint8Array([1]),
      capabilityLifetimeSeconds: 300,
      capabilityPrivateKey: signingPrivateKey,
      capabilityPublicKey: new Uint8Array(32).fill(0x22),
      keyEpoch: 1,
      materializationAlgorithm: 'png-dct-qim-v2',
      materializerSharedSecret: materializerSecret,
      pluginVersion: 'png-plugin-2',
      publicBaseUrl: 'https://control.example.test',
    });
    const response = await handler(
      new Request(endpoint, {
        body: '{}',
        headers: {
          Authorization: `Bearer ${materializerSecret}`,
          'Content-Length': String(2 * 1_024 * 1_024 + 1),
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(response.status).toBe(413);
    expect(calls).toBe(0);
  });

  it('binds completion requests to fresh DPoP proofs', async () => {
    const completionEndpoint =
      'https://control.example.test/v2/internal/materialization-renditions/complete';
    const calls: string[] = [];
    const handler = createMaterializationControlPlaneHandler({
      broker: {
        claimNextJob: async () => {
          throw new Error('must not run');
        },
        completeRendition: async (input) => {
          calls.push(`complete:${input.proofJti}`);
          expect(input.materializerId).toBe('data-node-1');
          expect(input.verifiedProofKeyThumbprint).toHaveLength(32);
          expect(input.outputFiles[0]?.normalizedPath).toBe('Assets/Product/a.png');
          expect(input.renditionBytes).toBe(100);
          expect(input.renditionSha256).toBe('a'.repeat(64));
          return {
            receipt: 'signed-receipt',
            receiptId: 'receipt-1',
            success: true,
          };
        },
        consumeCapability: async () => {
          throw new Error('must not run');
        },
        createInstallJob: async () => {
          throw new Error('must not run');
        },
        renewClaimLease: async () => {
          throw new Error('must not run');
        },
        failCapabilityJob: async () => {
          throw new Error('must not run');
        },
        getJobStatus: async () => {
          throw new Error('must not run');
        },
        issueCapability: async () => {
          throw new Error('must not run');
        },
      },
      apiSharedSecret: apiSecret,
      capabilityKeyId: new Uint8Array([1]),
      capabilityLifetimeSeconds: 300,
      capabilityPrivateKey: signingPrivateKey,
      capabilityPublicKey: new Uint8Array(32).fill(0x22),
      keyEpoch: 1,
      materializationAlgorithm: 'png-dct-qim-v2',
      materializerSharedSecret: materializerSecret,
      now: () => new Date(now * 1_000),
      pluginVersion: 'png-plugin-2',
      publicBaseUrl: 'https://control.example.test',
    });

    const completion = await handler(
      new Request(completionEndpoint, {
        body: JSON.stringify({
          attributionRecords: [
            {
              attributionId: 'attribution-1',
              attributionTokenHash: 'b'.repeat(64),
              normalizedPath: 'Assets/Product/a.png',
              sourceSha256: 'c'.repeat(64),
            },
          ],
          builds: {
            codec: 'codec-2',
            helper: 'host-2',
            runtime: 'runtime-2',
          },
          capability: capabilityToken,
          capabilityId: 'capability-1',
          jobId: 'job-1',
          leaseGeneration: 1,
          materializerId: 'data-node-1',
          outputFiles: [
            {
              attributionId: 'attribution-1',
              normalizedPath: 'Assets/Product/a.png',
              outputBytes: 20,
              outputSha256: 'd'.repeat(64),
            },
          ],
          outputTreeRoot: 'e'.repeat(64),
          proof: createProof(completionEndpoint, 'proof-complete-1'),
          renditionBytes: 100,
          renditionSha256: 'a'.repeat(64),
        }),
        headers: {
          Authorization: `Bearer ${materializerSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(completion.status).toBe(200);
    expect(await completion.json()).toEqual({
      receipt: 'signed-receipt',
      receiptId: 'receipt-1',
      success: true,
    });
    expect(calls).toEqual(['complete:proof-complete-1']);
  });

  it('accepts v3 coupled completions without weakening v2 validation', async () => {
    const completionEndpoint =
      'https://control.example.test/v2/internal/materialization-renditions/complete';
    const inputs: unknown[] = [];
    const handler = createMaterializationControlPlaneHandler({
      broker: {
        claimNextJob: async () => {
          throw new Error('must not run');
        },
        completeRendition: async (input) => {
          inputs.push(input);
          return {
            receipt: 'signed-coupled-receipt',
            receiptId: 'receipt-coupled-1',
            success: true,
          };
        },
        consumeCapability: async () => {
          throw new Error('must not run');
        },
        createInstallJob: async () => {
          throw new Error('must not run');
        },
        renewClaimLease: async () => {
          throw new Error('must not run');
        },
        failCapabilityJob: async () => {
          throw new Error('must not run');
        },
        getJobStatus: async () => {
          throw new Error('must not run');
        },
        issueCapability: async () => {
          throw new Error('must not run');
        },
      },
      apiSharedSecret: apiSecret,
      capabilityKeyId: new Uint8Array([1]),
      capabilityLifetimeSeconds: 300,
      capabilityPrivateKey: signingPrivateKey,
      capabilityPublicKey: new Uint8Array(32).fill(0x22),
      keyEpoch: 1,
      materializationAlgorithm: 'png-dct-qim-v2',
      materializerSharedSecret: materializerSecret,
      now: () => new Date(now * 1_000),
      pluginVersion: 'png-plugin-2',
      publicBaseUrl: 'https://control.example.test',
    });
    const post = (body: Record<string, unknown>) =>
      handler(
        new Request(completionEndpoint, {
          body: JSON.stringify(body),
          headers: {
            Authorization: `Bearer ${materializerSecret}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
        })
      );
    const v2Fields = {
      attributionRecords: [
        {
          attributionId: 'attribution-1',
          attributionTokenHash: 'b'.repeat(64),
          normalizedPath: 'Assets/Product/a.png',
          sourceSha256: 'c'.repeat(64),
        },
      ],
      builds: { codec: 'codec-2', helper: 'host-2', runtime: 'runtime-2' },
      capability: capabilityToken,
      capabilityId: 'capability-1',
      jobId: 'job-1',
      leaseGeneration: 1,
      materializerId: 'data-node-1',
      outputFiles: [
        {
          attributionId: 'attribution-1',
          normalizedPath: 'Assets/Product/a.png',
          outputBytes: 20,
          outputSha256: 'd'.repeat(64),
        },
      ],
      outputTreeRoot: 'e'.repeat(64),
    };

    const coupled = await post({
      ...v2Fields,
      completionSchema: 'v3',
      coupledJobManifestKey: 'coupled-jobs/job-1.v1.json',
      proof: createProof(completionEndpoint, 'proof-coupled-1'),
    });
    expect(coupled.status).toBe(200);
    expect(await coupled.json()).toEqual({
      receipt: 'signed-coupled-receipt',
      receiptId: 'receipt-coupled-1',
      success: true,
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      completionSchema: 'v3',
      coupledJobManifestKey: 'coupled-jobs/job-1.v1.json',
      jobId: 'job-1',
    });
    expect(inputs[0]).not.toHaveProperty('renditionBytes');
    expect(inputs[0]).not.toHaveProperty('renditionSha256');

    const v2MissingRendition = await post({
      ...v2Fields,
      proof: createProof(completionEndpoint, 'proof-coupled-2'),
    });
    expect(v2MissingRendition.status).toBe(400);
    expect(await v2MissingRendition.json()).toEqual({ error: 'body_fields_invalid' });

    const coupledWithRendition = await post({
      ...v2Fields,
      completionSchema: 'v3',
      coupledJobManifestKey: 'coupled-jobs/job-1.v1.json',
      proof: createProof(completionEndpoint, 'proof-coupled-3'),
      renditionBytes: 100,
      renditionSha256: 'a'.repeat(64),
    });
    expect(coupledWithRendition.status).toBe(400);
    expect(await coupledWithRendition.json()).toEqual({ error: 'body_fields_invalid' });

    const invalidSchema = await post({
      ...v2Fields,
      completionSchema: 'v2',
      coupledJobManifestKey: 'coupled-jobs/job-1.v1.json',
      proof: createProof(completionEndpoint, 'proof-coupled-4'),
    });
    expect(invalidSchema.status).toBe(400);
    expect(await invalidSchema.json()).toEqual({ error: 'completion_schema_invalid' });

    const manyFiles = Array.from({ length: 600 }, (_, index) => ({
      attributionId: `attribution-${index.toString(16).padStart(4, '0')}`,
      normalizedPath: `Assets/Product/${index.toString(16).padStart(4, '0')}.png`,
      outputBytes: 20,
      outputSha256: 'd'.repeat(64),
    }));
    const largeCoupled = await post({
      ...v2Fields,
      attributionRecords: manyFiles.map((file) => ({
        attributionId: file.attributionId,
        attributionTokenHash: 'b'.repeat(64),
        normalizedPath: file.normalizedPath,
        sourceSha256: 'c'.repeat(64),
      })),
      completionSchema: 'v3',
      coupledJobManifestKey: 'coupled-jobs/job-1.v1.json',
      outputFiles: manyFiles,
      proof: createProof(completionEndpoint, 'proof-coupled-5'),
    });
    expect(largeCoupled.status).toBe(200);

    const largeV2 = await post({
      ...v2Fields,
      attributionRecords: manyFiles.map((file) => ({
        attributionId: file.attributionId,
        attributionTokenHash: 'b'.repeat(64),
        normalizedPath: file.normalizedPath,
        sourceSha256: 'c'.repeat(64),
      })),
      outputFiles: manyFiles,
      proof: createProof(completionEndpoint, 'proof-coupled-6'),
      renditionBytes: 100,
      renditionSha256: 'a'.repeat(64),
    });
    expect(largeV2.status).toBe(400);
    expect(await largeV2.json()).toEqual({ error: 'attribution_records_invalid' });
    expect(inputs).toHaveLength(2);
  });

  it('separates API job control from Linux materializer work claims', async () => {
    const createEndpoint = 'https://control.example.test/v2/internal/materialization-jobs/create';
    const claimEndpoint = 'https://control.example.test/v2/internal/materialization-jobs/claim';
    const renewEndpoint = 'https://control.example.test/v2/internal/materialization-jobs/renew';
    const progressEndpoint =
      'https://control.example.test/v2/internal/materialization-jobs/progress';
    const statusEndpoint = 'https://control.example.test/v2/internal/materialization-jobs/status';
    const attributionEndpoint =
      'https://control.example.test/v2/internal/materialization-attribution/candidates';
    const failEndpoint = 'https://control.example.test/v2/internal/materialization-jobs/fail';
    const calls: string[] = [];
    const rejectedEvents: Array<{ errorCode?: string; status: string }> = [];
    let rejectCreate = false;
    const handler = createMaterializationControlPlaneHandler({
      apiSharedSecret: apiSecret,
      broker: {
        claimNextJob: async (input) => {
          calls.push(`claim:${input.leaseOwner}:${input.jobId}`);
          return {
            jobId: 'job-1',
            leaseExpiresAt: new Date((now + 600) * 1_000),
            leaseGeneration: 3,
            status: 'claimed',
          };
        },
        completeRendition: async () => {
          throw new Error('must not run');
        },
        consumeCapability: async () => {
          throw new Error('must not run');
        },
        createInstallJob: async (input) => {
          if (rejectCreate) {
            throw new Error(
              'Materialization source does not match the ready canonical package version'
            );
          }
          calls.push(`create:${input.buyerId}:${input.materializationAlgorithm}`);
          expect(input.outputFormat).toBe('zip');
          expect(input).not.toHaveProperty('protectedFiles');
        },
        failCapabilityJob: async (input) => {
          calls.push(`fail:${input.materializerId}:${input.proofJti}`);
        },
        getJobStatus: async () => ({
          queuePosition: 2,
          state: 'QUEUED',
          status: 'pending',
        }),
        issueCapability: async (input) => {
          calls.push(`issue:${input.leaseOwner}:${input.leaseGeneration}`);
          return {
            capability: { capabilityId: 'capability-1' } as never,
            coseSign1: Buffer.from('issued-capability'),
          };
        },
        reportJobProgress: async (input) => {
          calls.push(
            `progress:${input.leaseOwner}:${input.leaseGeneration}:${input.progress.sequence}:${input.progress.completedLogicalBytes}`
          );
          return {
            sequence: input.progress.sequence,
            status: 'accepted',
          };
        },
        renewClaimLease: async (input) => {
          calls.push(`renew:${input.leaseOwner}:${input.leaseGeneration}`);
          return {
            jobId: input.jobId,
            leaseExpiresAt: new Date((now + 600) * 1_000),
            leaseGeneration: input.leaseGeneration,
            sourceAuthorization: {
              expiresAt: new Date((now + 300) * 1_000),
              grant: 'renewed-source-grant',
            },
            status: 'renewed',
          };
        },
        listAttributionCandidates: async (input) => {
          calls.push(
            `attribution:${input.creatorId}:${input.productId}:${input.candidateLimit}:${input.cursor}`
          );
          return {
            candidateLimit: input.candidateLimit ?? 512,
            candidates: [],
            nextCursor: 'next-cursor-1',
            truncated: false,
          };
        },
      },
      capabilityKeyId: new Uint8Array([1]),
      capabilityLifetimeSeconds: 300,
      capabilityPrivateKey: signingPrivateKey,
      capabilityPublicKey: new Uint8Array(32).fill(0x22),
      keyEpoch: 7,
      materializationAlgorithm: 'png-dct-qim-v2',
      materializerSharedSecret: materializerSecret,
      now: () => new Date(now * 1_000),
      onEvent: (event) => {
        if (event.status === 'rejected') {
          rejectedEvents.push(event);
        }
      },
      pluginVersion: 'png-plugin-2',
      publicBaseUrl: 'https://control.example.test',
    });
    const createBody = JSON.stringify({
      bindingRoot: '2'.repeat(64),
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      grantJti: 'grant-1',
      jobId: 'job-1',
      productId: 'product-1',
      protectedSourceRoot: '3'.repeat(64),
      releaseRoot: '1'.repeat(64),
      sourceLogicalBytes: 100,
      sourceLogicalFiles: 1,
      sourceManifestSha256: '5'.repeat(64),
      sourceVersionId: '018f8c03-3880-7d40-a8d5-b190a64141cc',
    });
    const wrongBoundary = await handler(
      new Request(createEndpoint, {
        body: createBody,
        headers: {
          Authorization: `Bearer ${materializerSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(wrongBoundary.status).toBe(401);
    const created = await handler(
      new Request(createEndpoint, {
        body: createBody,
        headers: {
          Authorization: `Bearer ${apiSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual({ jobId: 'job-1', status: 'queued' });

    rejectCreate = true;
    const rejectedCreate = await handler(
      new Request(createEndpoint, {
        body: JSON.stringify({
          ...JSON.parse(createBody),
          jobId: 'job-invalid-source',
        }),
        headers: {
          Authorization: `Bearer ${apiSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    rejectCreate = false;
    expect(rejectedCreate.status).toBe(403);
    expect(rejectedEvents.at(-1)?.errorCode).toBe('materialization_source_mismatch');

    const claimed = await handler(
      new Request(claimEndpoint, {
        body: JSON.stringify({
          jobId: 'job-1',
          lane: 'large',
          leaseDurationMs: 600_000,
          materializerId: 'data-node-1',
          proofKeyThumbprint: Buffer.from(new Uint8Array(32).fill(0x77)).toString('base64url'),
        }),
        headers: {
          Authorization: `Bearer ${materializerSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({
      capability: Buffer.from('issued-capability').toString('base64url'),
      capabilityId: 'capability-1',
      jobId: 'job-1',
      leaseGeneration: 3,
      status: 'claimed',
    });
    const renewed = await handler(
      new Request(renewEndpoint, {
        body: JSON.stringify({
          jobId: 'job-1',
          leaseDurationMs: 600_000,
          leaseGeneration: 3,
          materializerId: 'data-node-1',
        }),
        headers: {
          Authorization: `Bearer ${materializerSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toEqual({
      jobId: 'job-1',
      leaseExpiresAt: new Date((now + 600) * 1_000).toISOString(),
      leaseGeneration: 3,
      sourceAuthorization: {
        expiresAt: new Date((now + 300) * 1_000).toISOString(),
        grant: 'renewed-source-grant',
      },
      status: 'renewed',
    });
    const progress = await handler(
      new Request(progressEndpoint, {
        body: JSON.stringify({
          jobId: 'job-1',
          leaseGeneration: 3,
          materializerId: 'data-node-1',
          progress: {
            completedFiles: 25,
            completedLogicalBytes: 1_024,
            sequence: 7,
            stage: 'source_assembly',
            status: 'progress',
            totalFiles: 100,
            totalLogicalBytes: 4_096,
          },
        }),
        headers: {
          Authorization: `Bearer ${materializerSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(progress.status).toBe(200);
    expect(await progress.json()).toEqual({ sequence: 7, status: 'accepted' });
    expect(calls).toContain('progress:data-node-1:3:7:1024');

    const obsoleteUploadProgress = await handler(
      new Request(progressEndpoint, {
        body: JSON.stringify({
          jobId: 'job-1',
          leaseGeneration: 3,
          materializerId: 'data-node-1',
          progress: {
            sequence: 8,
            stage: 'rendition_upload',
            status: 'started',
          },
        }),
        headers: {
          Authorization: `Bearer ${materializerSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(obsoleteUploadProgress.status).toBe(400);
    expect(await obsoleteUploadProgress.json()).toEqual({
      error: 'progress_stage_invalid',
    });

    const status = await handler(
      new Request(statusEndpoint, {
        body: JSON.stringify({ grantJti: 'grant-1', jobId: 'job-1' }),
        headers: {
          Authorization: `Bearer ${apiSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ queuePosition: 2, status: 'pending' });

    const attribution = await handler(
      new Request(attributionEndpoint, {
        body: JSON.stringify({
          candidateLimit: 128,
          creatorId: 'creator-1',
          cursor: 'cursor-1',
          productId: 'product-1',
        }),
        headers: {
          Authorization: `Bearer ${apiSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(attribution.status).toBe(200);
    expect(await attribution.json()).toEqual({
      candidateLimit: 128,
      candidates: [],
      nextCursor: 'next-cursor-1',
      truncated: false,
    });
    const oversizedAttributionPage = await handler(
      new Request(attributionEndpoint, {
        body: JSON.stringify({
          candidateLimit: 513,
          creatorId: 'creator-1',
          productId: 'product-1',
        }),
        headers: {
          Authorization: `Bearer ${apiSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(oversizedAttributionPage.status).toBe(400);

    const failed = await handler(
      new Request(failEndpoint, {
        body: JSON.stringify({
          capability: capabilityToken,
          capabilityId: 'capability-1',
          errorCode: 'CODEC_REJECTED',
          jobId: 'job-1',
          leaseGeneration: 3,
          materializerId: 'data-node-1',
          proof: createProof(failEndpoint, 'proof-fail-1'),
        }),
        headers: {
          Authorization: `Bearer ${materializerSecret}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })
    );
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ status: 'failed' });
    expect(calls).toEqual([
      'create:buyer-1:png-dct-qim-v2',
      'claim:data-node-1:job-1',
      'issue:data-node-1:3',
      'renew:data-node-1:3',
      'progress:data-node-1:3:7:1024',
      'attribution:creator-1:product-1:128:cursor-1',
      'fail:data-node-1:proof-fail-1',
    ]);
  });
});
