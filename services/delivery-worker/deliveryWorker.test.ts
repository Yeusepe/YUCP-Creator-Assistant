import { afterEach, describe, expect, it, mock } from 'bun:test';
import { signDeliveryUrl } from '../../ops/storage-core/deliverySigning';
import worker from './src/index';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('delivery worker manifest fetch', () => {
  it('passes the origin timeout signal to the manifest storage request', async () => {
    const abortController = new AbortController();
    const timeoutMock = mock((_milliseconds: number) => abortController.signal);
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    let storageRequest: Request | undefined;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      storageRequest = new Request(input);
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: timeoutMock,
    });

    const hmacKey = 'delivery-worker-test-hmac-key-32-bytes';
    const versionId = 'manifest-timeout-version';
    const signed = await signDeliveryUrl({
      expiresAt: Date.now() + 60_000,
      key: hmacKey,
      versionId,
    });
    const url = new URL(`https://delivery.test/d/${versionId}`);
    url.searchParams.set('exp', signed.exp);
    url.searchParams.set('sig', signed.sig);

    let response: Response;
    try {
      response = await worker.fetch(
        new Request(url),
        {
          CAS_S3_ENDPOINT: 'http://127.0.0.1:9000',
          CAS_S3_REGION: 'us-east-1',
          CAS_S3_BUCKET: 'delivery-test',
          CAS_S3_READONLY_ACCESS_KEY_ID: 'delivery-test-access-key',
          CAS_S3_READONLY_SECRET_ACCESS_KEY: 'delivery-test-secret-key',
          CAS_INDEX_PREFIX: 'cas-index/',
          CAS_CHUNK_PREFIX: 'cas-chunks/',
          DELIVERY_HMAC_KEY: hmacKey,
          STORAGE_FORMAT_VERSION: 'desync-v1',
        } as Env,
        {} as ExecutionContext
      );
    } finally {
      if (timeoutDescriptor) {
        Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
      } else {
        Reflect.deleteProperty(AbortSignal, 'timeout');
      }
    }

    expect(response.status).toBe(404);
    expect(timeoutMock).toHaveBeenCalledWith(30_000);
    abortController.abort();
    expect(storageRequest?.signal.aborted).toBe(true);
  });
});
