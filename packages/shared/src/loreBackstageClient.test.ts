import { afterEach, describe, expect, it } from 'bun:test';
import { blake3 } from '@noble/hashes/blake3.js';

import {
  assertSecureLoreUrl,
  type ConfiguredLoreBackstageConfig,
  LoreApiRequestError,
  loreRepositoryIdForCreator,
  mintLorePresignedUrl,
  putBackstageBytesToLore,
  requireLoreBackstageConfig,
} from './loreBackstageClient';

const originalFetch = globalThis.fetch;
const repositoryId = '0123456789abcdef0123456789abcdef';
const address = `${'a'.repeat(64)}-${'b'.repeat(32)}`;
const keyHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function configuredLore(overrides: Partial<ConfiguredLoreBackstageConfig> = {}) {
  return requireLoreBackstageConfig({
    apiBaseUrl: 'https://lore.test/',
    presignHmacKey: keyHex,
    repoNamespaceSalt: 'backstage-test',
    accessClientId: 'access-client-id',
    accessClientSecret: 'access-client-secret',
    ...overrides,
  });
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlNoPad(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('mintLorePresignedUrl', () => {
  it('requires a presign key when a PUT-only config attempts to presign', async () => {
    const config = requireLoreBackstageConfig({
      apiBaseUrl: 'https://lore.test',
      repoNamespaceSalt: 'salt',
      accessClientId: 'client-id',
      accessClientSecret: 'client-secret',
    });

    await expect(mintLorePresignedUrl({ config, repositoryId, address })).rejects.toThrow(
      'LORE_PRESIGN_HMAC_KEY'
    );
  });

  it('mints a token whose payload and HMAC are independently verifiable', async () => {
    const ttlSeconds = 900;
    const before = Math.floor(Date.now() / 1000);
    const minted = await mintLorePresignedUrl({
      config: configuredLore(),
      repositoryId,
      address,
      ttlSeconds,
    });
    const after = Math.floor(Date.now() / 1000);

    const url = new URL(minted.url);
    expect(url.origin).toBe('https://lore.test');
    expect(url.pathname).toBe(`/v1/presigned/${repositoryId}/${address}`);
    const token = url.searchParams.get('token');
    expect(token).not.toBeNull();
    const tokenParts = token?.split('.') ?? [];
    expect(tokenParts).toHaveLength(2);
    const [encodedPayload, encodedSignature] = tokenParts as [string, string];

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const keyBytes = Uint8Array.from(Buffer.from(keyHex, 'hex'));
    const expectedKeyId = toHex(blake3(keyBytes)).slice(0, 16);
    expect(payload.key_id).toBe(expectedKeyId);

    const hmacKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const expectedSignature = new Uint8Array(
      await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(encodedPayload))
    );
    expect(encodedSignature).toBe(base64UrlNoPad(expectedSignature));
    expect(payload.version).toBe(1);
    expect(payload.repository).toBe(repositoryId);
    expect(payload.address).toBe(address);
    expect(payload.expires_at).toBe(minted.expiresAt);
    expect(minted.expiresAt).toBeGreaterThanOrEqual(before + ttlSeconds);
    expect(minted.expiresAt).toBeLessThanOrEqual(after + ttlSeconds);
    expect(Number.isInteger(payload.expires_at)).toBe(true);
    expect(payload).not.toHaveProperty('content_type');
    expect(payload).not.toHaveProperty('content_disposition');

    const withContentType = await mintLorePresignedUrl({
      config: configuredLore(),
      repositoryId,
      address,
      ttlSeconds,
      contentType: 'application/zip',
      contentDisposition: 'attachment; filename="package.zip"',
    });
    const contentPayload = JSON.parse(
      Buffer.from(
        new URL(withContentType.url).searchParams.get('token')?.split('.')[0] ?? '',
        'base64url'
      ).toString('utf8')
    ) as Record<string, unknown>;
    expect(contentPayload.content_type).toBe('application/zip');
    expect(contentPayload.content_disposition).toBe('attachment; filename="package.zip"');
  });
});

describe('loreRepositoryIdForCreator', () => {
  it('is deterministic, namespaced by salt and creator, and lowercase hexadecimal', () => {
    const first = loreRepositoryIdForCreator('auth-user-1', 'salt-1');
    expect(loreRepositoryIdForCreator('auth-user-1', 'salt-1')).toBe(first);
    expect(loreRepositoryIdForCreator('auth-user-1', 'salt-2')).not.toBe(first);
    expect(loreRepositoryIdForCreator('auth-user-2', 'salt-1')).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('putBackstageBytesToLore', () => {
  it('uploads raw bytes with Access headers and returns the parsed address and digest', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`https://lore.test/v1/repository/${repositoryId}/content`);
      expect(init?.method).toBe('PUT');
      const headers = new Headers(init?.headers);
      expect(headers.get('CF-Access-Client-Id')).toBe('access-client-id');
      expect(headers.get('CF-Access-Client-Secret')).toBe('access-client-secret');
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(bytes);
      return Response.json({ data: { address } });
    }) as typeof fetch;

    await expect(
      putBackstageBytesToLore({ config: configuredLore(), repositoryId, bytes })
    ).resolves.toEqual({
      address,
      sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
      byteSize: 4,
    });
  });

  it('throws LoreApiRequestError with status and a bounded response detail for non-2xx', async () => {
    globalThis.fetch = (async () =>
      new Response('repository unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
      })) as unknown as typeof fetch;

    const error = await putBackstageBytesToLore({
      config: configuredLore(),
      repositoryId,
      bytes: new Uint8Array([1]),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LoreApiRequestError);
    expect((error as LoreApiRequestError).status).toBe(503);
    expect((error as LoreApiRequestError).detail).toContain('repository unavailable');
  });

  it('normalizes network and timeout failures to LoreApiRequestError', async () => {
    const failures = [new TypeError('fetch failed'), new DOMException('timed out', 'AbortError')];

    for (const failure of failures) {
      globalThis.fetch = (async () => {
        throw failure;
      }) as unknown as typeof fetch;

      const error = await putBackstageBytesToLore({
        config: configuredLore(),
        repositoryId,
        bytes: new Uint8Array([1]),
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(LoreApiRequestError);
      expect((error as LoreApiRequestError).detail).toBe(failure.message);
    }
  });
});

describe('requireLoreBackstageConfig', () => {
  it('requires HTTPS for public hosts while allowing trusted HTTP hosts', () => {
    expect(assertSecureLoreUrl('https://x.example', 'testUrl').href).toBe('https://x.example/');
    expect(assertSecureLoreUrl('http://localhost:41339', 'testUrl').href).toBe(
      'http://localhost:41339/'
    );
    expect(assertSecureLoreUrl('http://10.0.0.5', 'testUrl').href).toBe('http://10.0.0.5/');
    expect(assertSecureLoreUrl('http://sidecar.svc.cluster.local', 'testUrl').href).toBe(
      'http://sidecar.svc.cluster.local/'
    );
    expect(() => assertSecureLoreUrl('http://public.example.com', 'testUrl')).toThrow(
      'testUrl must use HTTPS'
    );
  });

  it('normalizes the base URL and applies timeout and presign TTL defaults', () => {
    expect(configuredLore()).toMatchObject({
      apiBaseUrl: 'https://lore.test',
      timeoutMs: 30_000,
      defaultTtlSeconds: 3_600,
    });
  });

  it('rejects query and fragment components in the base URL', () => {
    expect(() => configuredLore({ apiBaseUrl: 'https://x.example/base?y=1' })).toThrow(
      'LORE_API_BASE_URL must not contain a query string or fragment.'
    );
    expect(() => configuredLore({ apiBaseUrl: 'https://x.example/base#z' })).toThrow(
      'LORE_API_BASE_URL must not contain a query string or fragment.'
    );
  });

  it('preserves a base path while normalizing trailing slashes', () => {
    expect(configuredLore({ apiBaseUrl: 'https://x.example/base/' }).apiBaseUrl).toBe(
      'https://x.example/base'
    );
  });

  it('rejects presign keys shorter than 32 bytes', () => {
    expect(() =>
      requireLoreBackstageConfig({
        apiBaseUrl: 'https://lore.test',
        presignHmacKey: 'ab'.repeat(31),
        repoNamespaceSalt: 'salt',
        accessClientId: 'client-id',
        accessClientSecret: 'client-secret',
      })
    ).toThrow('at least 32 bytes');
  });

  it('allows PUT-only clients to omit the presign key', () => {
    expect(
      requireLoreBackstageConfig({
        apiBaseUrl: 'https://lore.test',
        repoNamespaceSalt: 'salt',
        accessClientId: 'client-id',
        accessClientSecret: 'client-secret',
      }).presignHmacKey
    ).toBeUndefined();
  });

  it('rejects every missing required field', () => {
    const completeConfig = {
      apiBaseUrl: 'https://lore.test',
      repoNamespaceSalt: 'salt',
      accessClientId: 'client-id',
      accessClientSecret: 'client-secret',
    };

    for (const field of Object.keys(completeConfig) as Array<keyof typeof completeConfig>) {
      const incompleteConfig: Record<string, string | undefined> = { ...completeConfig };
      incompleteConfig[field] = undefined;
      expect(() => requireLoreBackstageConfig(incompleteConfig as typeof completeConfig)).toThrow();
    }
  });
});
