import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import {
  computeOutputTreeRootV2,
  encodeDeliveryGrantV2,
  encodeMaterializationReceiptV2,
  PACKAGE_CONTRACT_PURPOSES,
  packageContractKeyId,
  signPackageContract,
} from '../../ops/storage-core/packageContractsV2';
import worker, { fetchWithResponseHeaderTimeout } from './src/index';

const originalFetch = globalThis.fetch;
const installPrivateKey = new Uint8Array(32).fill(0x31);
const receiptPrivateKey = new Uint8Array(32).fill(0x41);
const installKeyId = packageContractKeyId('install-test-2026-01');
const receiptKeyId = packageContractKeyId('receipt-test-2026-01');
const jobId = 'job-protected-1';
const grantId = 'grant-protected-1';
const sharedSecret = 'rendition-shared-secret-test';
const materializerOrigin = 'https://materializer.example.test';
const renditionFileUrl = `${materializerOrigin}/v2/internal/rendition-files/${jobId}`;
const renditionBytes = new TextEncoder().encode('verified rendition zip bytes');
const renditionSha256 = createHash('sha256').update(renditionBytes).digest();

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function proofThumbprint(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' });
  return createHash('sha256')
    .update(
      JSON.stringify({
        crv: jwk.crv,
        kty: jwk.kty,
        x: jwk.x,
        y: jwk.y,
      })
    )
    .digest();
}

function createProof(input: {
  accessToken: string;
  jti?: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  url: string;
}): string {
  const header = encodeJson({
    alg: 'ES256',
    jwk: input.publicKey.export({ format: 'jwk' }),
    typ: 'dpop+jwt',
  });
  const payload = encodeJson({
    ath: createHash('sha256').update(input.accessToken, 'ascii').digest('base64url'),
    htm: 'POST',
    htu: input.url,
    iat: Math.floor(Date.now() / 1_000),
    jti: input.jti ?? randomUUID(),
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
    dsaEncoding: 'ieee-p1363',
    key: input.privateKey,
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function credentials(url: string, proofJti?: string, fileIdentifier = `${jobId}.zip`) {
  const proofKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Math.floor(Date.now() / 1_000);
  const releaseRoot = new Uint8Array(32).fill(0x11);
  const outputFile = {
    attributionId: 'attribution-1',
    normalizedPath: 'Assets/Jammr/a.png',
    outputBytes: 100,
    outputSha256: new Uint8Array(32).fill(0x66),
  };
  const grant = await signPackageContract({
    keyId: installKeyId,
    payload: encodeDeliveryGrantV2({
      audience: 'https://delivery.example.test',
      bindingRoot: new Uint8Array(32).fill(0x22),
      buyerId: 'buyer-1',
      creatorId: 'creator-1',
      deviceKeyThumbprint: proofThumbprint(proofKey.publicKey),
      expiresAt: now + 300,
      grantId,
      installSessionId: 'session-1',
      issuedAt: now,
      issuer: 'https://api.example.test',
      notBefore: now,
      productId: 'com.yucp.jammr',
      releaseRoot,
      scopes: [`materialization:${jobId}:read`, 'package:version-jammr-123:read'],
    }),
    privateKey: installPrivateKey,
    purpose: PACKAGE_CONTRACT_PURPOSES.deliveryGrant,
  });
  const receipt = await signPackageContract({
    keyId: receiptKeyId,
    payload: encodeMaterializationReceiptV2({
      buyerSubjectPseudonym: 'buyer-pseudonym-1',
      capabilityId: 'capability-1',
      codecBuild: 'codec-build-1',
      createdPaths: [outputFile.normalizedPath],
      creatorId: 'creator-1',
      expiresAt: now + 7 * 24 * 60 * 60,
      grantId,
      helperBuild: 'helper-build-1',
      issuedAt: now,
      jobId,
      keyEpoch: 1,
      leaseGeneration: 1,
      materializationAlgorithm: 'png-dct-qim-v2',
      materializerId: 'linux-data-node-1',
      outputFiles: [outputFile],
      outputTreeRoot: computeOutputTreeRootV2([outputFile]),
      pluginVersion: 'png-plugin-2',
      productId: 'com.yucp.jammr',
      protectedSourceRoot: new Uint8Array(32).fill(0x33),
      pseudonymMethod: 'hmac-sha256-hkdf-v2',
      receiptId: 'receipt-1',
      releaseRoot,
      rendition: {
        fileIdentifier,
        objectBytes: renditionBytes.byteLength,
        objectSha256: renditionSha256,
      },
      runtimeBuild: 'runtime-build-1',
      traceId: 'trace-1',
    }),
    privateKey: receiptPrivateKey,
    purpose: PACKAGE_CONTRACT_PURPOSES.materializationReceipt,
  });
  const grantToken = Buffer.from(grant.coseSign1).toString('base64url');
  return {
    body: JSON.stringify({
      receipt: Buffer.from(receipt.coseSign1).toString('base64url'),
    }),
    headers: {
      Authorization: `DPoP ${grantToken}`,
      'Content-Type': 'application/json',
      DPoP: createProof({
        accessToken: grantToken,
        ...(proofJti ? { jti: proofJti } : {}),
        privateKey: proofKey.privateKey,
        publicKey: proofKey.publicKey,
        url,
      }),
    },
  };
}

async function testEnv() {
  return {
    MATERIALIZER_ORIGIN_URL: materializerOrigin,
    MATERIALIZER_RENDITION_SHARED_SECRET: sharedSecret,
    PACKAGE_DELIVERY_AUDIENCE: 'https://delivery.example.test',
    PACKAGE_INSTALL_ISSUER: 'https://api.example.test',
    PACKAGE_INSTALL_SIGNING_KEY_ID: 'install-test-2026-01',
    PACKAGE_INSTALL_SIGNING_PUBLIC_KEY: Buffer.from(
      await ed25519.getPublicKeyAsync(installPrivateKey)
    ).toString('base64url'),
    RENDITION_RECEIPT_KEY_ID: 'receipt-test-2026-01',
    RENDITION_RECEIPT_PUBLIC_KEY: Buffer.from(
      await ed25519.getPublicKeyAsync(receiptPrivateKey)
    ).toString('base64url'),
  };
}

function originHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  return new Headers(input instanceof Request ? input.headers : init?.headers);
}

describe('personalized rendition Worker', () => {
  it('rejects an unauthorized request before any materializer origin read', async () => {
    let originReads = 0;
    globalThis.fetch = mock(async () => {
      originReads += 1;
      throw new Error('must not read the materializer origin');
    }) as unknown as typeof fetch;
    const response = await worker.fetch(
      new Request(`https://delivery.example.test/v2/renditions/${jobId}`, {
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
      await testEnv()
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('x-rendition-storage-fetches')).toBe('0');
    expect(originReads).toBe(0);
  });

  it('rejects a receipt for a different ephemeral rendition file', async () => {
    let originReads = 0;
    globalThis.fetch = mock(async () => {
      originReads += 1;
      return new Response(renditionBytes);
    }) as unknown as typeof fetch;
    const url = `https://delivery.example.test/v2/renditions/${jobId}`;
    const authorized = await credentials(url, undefined, 'another-job.zip');

    const response = await worker.fetch(
      new Request(url, {
        body: authorized.body,
        headers: authorized.headers,
        method: 'POST',
      }),
      await testEnv()
    );

    expect(response.status).toBe(403);
    expect(originReads).toBe(0);
  });

  it('streams the full rendition from the materializer origin with the shared secret', async () => {
    const url = `https://delivery.example.test/v2/renditions/${jobId}`;
    let originReads = 0;
    let originUrl = '';
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      originReads += 1;
      originUrl = input instanceof Request ? input.url : String(input);
      const headers = originHeaders(input, init);
      expect(headers.get('x-yucp-rendition-secret')).toBe(sharedSecret);
      expect(headers.get('range')).toBeNull();
      return new Response(renditionBytes, {
        headers: {
          'Content-Length': String(renditionBytes.byteLength),
          'Content-Type': 'application/zip',
        },
      });
    }) as unknown as typeof fetch;
    const authorized = await credentials(url);
    const response = await worker.fetch(
      new Request(url, { ...authorized, method: 'POST' }),
      await testEnv()
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('x-rendition-storage-fetches')).toBe('1');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(renditionBytes);
    expect(originReads).toBe(1);
    expect(originUrl).toBe(renditionFileUrl);
  });

  it('serves only the exact remaining bytes for a verified resume request', async () => {
    const url = `https://delivery.example.test/v2/renditions/${jobId}`;
    const resumeOffset = 7;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = originHeaders(input, init);
      expect(headers.get('x-yucp-rendition-secret')).toBe(sharedSecret);
      expect(headers.get('range')).toBe(`bytes=${resumeOffset}-`);
      return new Response(renditionBytes.slice(resumeOffset), {
        headers: {
          'Content-Length': String(renditionBytes.byteLength - resumeOffset),
          'Content-Range': `bytes ${resumeOffset}-${renditionBytes.byteLength - 1}/${
            renditionBytes.byteLength
          }`,
          'Content-Type': 'application/zip',
        },
        status: 206,
      });
    }) as unknown as typeof fetch;
    const authorized = await credentials(url);
    const response = await worker.fetch(
      new Request(url, {
        ...authorized,
        headers: {
          ...authorized.headers,
          Range: `bytes=${resumeOffset}-`,
        },
        method: 'POST',
      }),
      await testEnv()
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe(
      `bytes ${resumeOffset}-${renditionBytes.byteLength - 1}/${renditionBytes.byteLength}`
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      renditionBytes.slice(resumeOffset)
    );
  });

  it('rejects a malformed client range before any materializer origin read', async () => {
    const url = `https://delivery.example.test/v2/renditions/${jobId}`;
    let originReads = 0;
    globalThis.fetch = mock(async () => {
      originReads += 1;
      throw new Error('must not read the materializer origin');
    }) as unknown as typeof fetch;
    const authorized = await credentials(url);
    const response = await worker.fetch(
      new Request(url, {
        ...authorized,
        headers: {
          ...authorized.headers,
          Range: 'bytes=1-4,8-',
        },
        method: 'POST',
      }),
      await testEnv()
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('x-rendition-storage-fetches')).toBe('0');
    expect(originReads).toBe(0);
  });

  it('rejects an overlapping origin range without streaming its body', async () => {
    const url = `https://delivery.example.test/v2/renditions/${jobId}`;
    const resumeOffset = 7;
    let originReads = 0;
    globalThis.fetch = mock(async () => {
      originReads += 1;
      return new Response(renditionBytes.slice(resumeOffset - 1), {
        headers: {
          'Content-Length': String(renditionBytes.byteLength - resumeOffset),
          'Content-Range': `bytes ${resumeOffset - 1}-${
            renditionBytes.byteLength - 1
          }/${renditionBytes.byteLength}`,
          'Content-Type': 'application/zip',
        },
        status: 206,
      });
    }) as unknown as typeof fetch;
    const authorized = await credentials(url);
    const response = await worker.fetch(
      new Request(url, {
        ...authorized,
        headers: {
          ...authorized.headers,
          Range: `bytes=${resumeOffset}-`,
        },
        method: 'POST',
      }),
      await testEnv()
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('x-rendition-storage-fetches')).toBe('1');
    expect(originReads).toBe(1);
    expect(await response.text()).not.toContain('verified rendition');
  });

  it('returns 502 when the materializer origin fails', async () => {
    const url = `https://delivery.example.test/v2/renditions/${jobId}`;
    let originReads = 0;
    globalThis.fetch = mock(async () => {
      originReads += 1;
      return new Response('materializer offline', { status: 500 });
    }) as unknown as typeof fetch;
    const authorized = await credentials(url);
    const response = await worker.fetch(
      new Request(url, { ...authorized, method: 'POST' }),
      await testEnv()
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('x-rendition-storage-fetches')).toBe('1');
    expect(originReads).toBe(1);
  });

  it('reports an unreachable materializer origin as 502, not an authorization denial', async () => {
    const url = `https://delivery.example.test/v2/renditions/${jobId}`;
    globalThis.fetch = mock(async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    const authorized = await credentials(url);
    const response = await worker.fetch(
      new Request(url, { ...authorized, method: 'POST' }),
      await testEnv()
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('x-rendition-storage-fetches')).toBe('1');
  }, // seconds before giving up. // The SlowDown backoff schedule retries thrown network errors for several
  20_000);

  it('rejects a replayed DPoP proof before a second materializer origin read', async () => {
    const url = `https://delivery.example.test/v2/renditions/${jobId}`;
    let originReads = 0;
    globalThis.fetch = mock(async () => {
      originReads += 1;
      return new Response(renditionBytes, {
        headers: {
          'Content-Length': String(renditionBytes.byteLength),
          'Content-Type': 'application/zip',
        },
      });
    }) as unknown as typeof fetch;
    const authorized = await credentials(url, 'replayed-rendition-proof');

    const first = await worker.fetch(
      new Request(url, { ...authorized, method: 'POST' }),
      await testEnv()
    );
    const replay = await worker.fetch(
      new Request(url, { ...authorized, method: 'POST' }),
      await testEnv()
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(replay.headers.get('x-rendition-storage-fetches')).toBe('0');
    expect(originReads).toBe(1);
  });

  it('keeps streaming the origin body after its response-header timer elapses', async () => {
    const url = `https://delivery.example.test/v2/renditions/${jobId}`;
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
      nativeSetTimeout(handler, 5, ...args)) as typeof setTimeout;
    globalThis.fetch = mock(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new Error('body signal was aborted')),
                { once: true }
              );
              nativeSetTimeout(() => {
                controller.enqueue(renditionBytes);
                controller.close();
              }, 20);
            },
          }),
          {
            headers: {
              'Content-Length': String(renditionBytes.byteLength),
              'Content-Type': 'application/zip',
            },
          }
        )
    ) as unknown as typeof fetch;
    try {
      const authorized = await credentials(url);
      const response = await worker.fetch(
        new Request(url, { ...authorized, method: 'POST' }),
        await testEnv()
      );

      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(renditionBytes);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
    }
  });

  it('disarms the origin header timeout before streaming the response body', async () => {
    let requestSignal: AbortSignal | undefined;
    const response = await fetchWithResponseHeaderTimeout(
      async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await Bun.sleep(20);
              if (requestSignal?.aborted) {
                controller.error(new Error('body signal was aborted'));
                return;
              }
              controller.enqueue(renditionBytes);
              controller.close();
            },
          })
        );
      },
      'https://materializer.example.test/v2/internal/rendition-files/job-1',
      {},
      5
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(renditionBytes);
    expect(requestSignal?.aborted).toBeFalse();
  });
});
