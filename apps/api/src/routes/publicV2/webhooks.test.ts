import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AuthResult } from './auth';

// --- Module mocks (must appear before any import that transitively uses them) ---

const apiMock = {
  webhookSubscriptions: {
    list: 'webhookSubscriptions.list',
    create: 'webhookSubscriptions.create',
    getById: 'webhookSubscriptions.getById',
    update: 'webhookSubscriptions.update',
    deleteSubscription: 'webhookSubscriptions.deleteSubscription',
    rotateSecret: 'webhookSubscriptions.rotateSecret',
  },
  webhookDeliveries: {
    listBySubscription: 'webhookDeliveries.listBySubscription',
  },
  creatorEvents: {
    emitEvent: 'creatorEvents.emitEvent',
  },
} as const;

let queryImpl: (fn: unknown, args: unknown) => Promise<unknown>;
let mutationImpl: (fn: unknown, args: unknown) => Promise<unknown>;

const queryMock = mock((fn: unknown, args: unknown) => queryImpl(fn, args));
const mutationMock = mock((fn: unknown, args: unknown) => mutationImpl(fn, args));

mock.module('../../../../../convex/_generated/api', () => ({ api: apiMock }));

mock.module('../../lib/convex', () => ({
  getConvexClientFromUrl: () => ({ query: queryMock, mutation: mutationMock }),
}));

mock.module('../../lib/encrypt', () => ({
  encrypt: async (plaintext: string) => `encrypted_${plaintext}`,
}));

const { handleWebhooksRoutes } = await import('./webhooks');

const mockResolveAuth = async (): Promise<AuthResult> => ({
  authUserId: 'user_abc',
  scopes: ['webhooks:manage'],
});

// --- Shared fixtures ---

const config = {
  convexUrl: 'https://test.convex.cloud',
  convexApiSecret: 'test-secret',
  convexSiteUrl: 'https://test.convex.site',
  encryptionSecret: 'test-enc',
};

/** Thin wrapper that injects the mock auth resolver so tests don't need mock.module('./auth'). */
const routes = (request: Request, subPath: string) =>
  handleWebhooksRoutes(request, subPath, config, { resolveAuth: mockResolveAuth });

const sampleSubscription = {
  _id: 'wh_001',
  url: 'https://example.com/hook',
  events: ['entitlement.granted'],
  enabled: true,
  signingSecretPrefix: 'whsec_ab',
  signingSecretEnc: 'encrypted_secret',
  createdAt: 1_700_000_000_000,
};

function makeRequest(
  method: string,
  subPath: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Request {
  const url = `http://localhost/api/public/v2${subPath}`;
  return new Request(url, {
    method,
    headers: {
      authorization: 'Bearer test-token',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  queryMock.mockClear();
  mutationMock.mockClear();

  queryImpl = async (fn) => {
    if (fn === apiMock.webhookSubscriptions.list) return [];
    if (fn === apiMock.webhookSubscriptions.getById) return { ...sampleSubscription };
    throw new Error(`Unhandled query: ${String(fn)}`);
  };

  mutationImpl = async (fn) => {
    if (fn === apiMock.webhookSubscriptions.create) return { ...sampleSubscription };
    if (fn === apiMock.webhookSubscriptions.deleteSubscription) return undefined;
    if (fn === apiMock.webhookSubscriptions.update) return { ...sampleSubscription };
    if (fn === apiMock.webhookSubscriptions.rotateSecret) return { ...sampleSubscription };
    if (fn === apiMock.creatorEvents.emitEvent) return undefined;
    throw new Error(`Unhandled mutation: ${String(fn)}`);
  };
});

describe('handleWebhooksRoutes', () => {
  describe('GET /webhook-event-types', () => {
    it('returns 200', async () => {
      const res = await routes(
        makeRequest('GET', '/webhook-event-types'),
        '/webhook-event-types'
);
      expect(res.status).toBe(200);
    });

    it('body has object:list with event type objects', async () => {
      const res = await routes(
        makeRequest('GET', '/webhook-event-types'),
        '/webhook-event-types'
);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.object).toBe('list');
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('includes entitlement.granted in the event types', async () => {
      const res = await routes(
        makeRequest('GET', '/webhook-event-types'),
        '/webhook-event-types'
);
      const body = (await res.json()) as { data: Array<{ type: string; description: string }> };
      const types = body.data.map((e) => e.type);
      expect(types).toContain('entitlement.granted');
    });

    it('includes ping in the event types', async () => {
      const res = await routes(
        makeRequest('GET', '/webhook-event-types'),
        '/webhook-event-types'
);
      const body = (await res.json()) as { data: Array<{ type: string; description: string }> };
      const types = body.data.map((e) => e.type);
      expect(types).toContain('ping');
    });

    it('each event type entry has type and description fields', async () => {
      const res = await routes(
        makeRequest('GET', '/webhook-event-types'),
        '/webhook-event-types'
);
      const body = (await res.json()) as { data: Array<Record<string, unknown>> };
      for (const entry of body.data) {
        expect(typeof entry.type).toBe('string');
        expect(typeof entry.description).toBe('string');
      }
    });
  });

  describe('GET /webhooks', () => {
    it('returns 200 with list shape', async () => {
      const res = await routes(makeRequest('GET', '/webhooks'), '/webhooks');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.object).toBe('list');
    });

    it('calls convex.query to retrieve subscriptions', async () => {
      await routes(makeRequest('GET', '/webhooks'), '/webhooks');
      expect(queryMock.mock.calls).toHaveLength(1);
      expect(queryMock.mock.calls[0]?.[0]).toBe(apiMock.webhookSubscriptions.list);
    });

    it('strips signingSecretEnc from list items', async () => {
      queryImpl = async () => [{ ...sampleSubscription }];
      const res = await routes(makeRequest('GET', '/webhooks'), '/webhooks');
      const body = (await res.json()) as { data: Array<Record<string, unknown>> };
      if (body.data.length > 0) {
        expect(body.data[0]).not.toHaveProperty('signingSecretEnc');
      }
    });
  });

  describe('POST /webhooks — valid request', () => {
    it('returns 201', async () => {
      const res = await routes(
        makeRequest('POST', '/webhooks', {
          url: 'https://example.com/webhook',
          events: ['entitlement.granted'],
        }),
        '/webhooks'
);
      expect(res.status).toBe(201);
    });

    it('body includes a signingSecret starting with whsec_', async () => {
      const res = await routes(
        makeRequest('POST', '/webhooks', {
          url: 'https://example.com/webhook',
          events: ['entitlement.granted'],
        }),
        '/webhooks'
);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.signingSecret).toBe('string');
      expect((body.signingSecret as string).startsWith('whsec_')).toBe(true);
    });

    it('does not expose signingSecretEnc in the response', async () => {
      const res = await routes(
        makeRequest('POST', '/webhooks', {
          url: 'https://example.com/webhook',
          events: [],
        }),
        '/webhooks'
);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('signingSecretEnc');
    });
  });

  describe('POST /webhooks — validation errors', () => {
    it('returns 400 when url field is missing', async () => {
      const res = await routes(
        makeRequest('POST', '/webhooks', { events: [] }),
        '/webhooks'
);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('bad_request');
    });

    it('returns 400 when url is not an HTTPS URL', async () => {
      const res = await routes(
        makeRequest('POST', '/webhooks', {
          url: 'http://example.com/webhook',
          events: [],
        }),
        '/webhooks'
);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('bad_request');
    });

    it('returns 400 when url is an empty string', async () => {
      const res = await routes(
        makeRequest('POST', '/webhooks', { url: '', events: [] }),
        '/webhooks'
);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /webhooks/:id', () => {
    it('returns 200 with the subscription object', async () => {
      const res = await routes(
        makeRequest('GET', '/webhooks/wh_001'),
        '/webhooks/wh_001'
);
      expect(res.status).toBe(200);
    });

    it('strips signingSecretEnc from the response', async () => {
      const res = await routes(
        makeRequest('GET', '/webhooks/wh_001'),
        '/webhooks/wh_001'
);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('signingSecretEnc');
    });

    it('returns 404 when the subscription does not exist', async () => {
      queryImpl = async (fn) => {
        if (fn === apiMock.webhookSubscriptions.getById) return null;
        throw new Error(`Unhandled query: ${String(fn)}`);
      };
      const res = await routes(
        makeRequest('GET', '/webhooks/unknown_id'),
        '/webhooks/unknown_id'
);
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /webhooks/:id', () => {
    it('returns 200 with deleted:true', async () => {
      const res = await routes(
        makeRequest('DELETE', '/webhooks/wh_001'),
        '/webhooks/wh_001'
);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.deleted).toBe(true);
      expect(body.id).toBe('wh_001');
    });

    it('calls convex mutation to delete the subscription', async () => {
      await routes(
        makeRequest('DELETE', '/webhooks/wh_001'),
        '/webhooks/wh_001'
);
      expect(
        mutationMock.mock.calls.some(
          (call) => call[0] === apiMock.webhookSubscriptions.deleteSubscription
        )
      ).toBe(true);
    });
  });

  describe('unknown sub-paths', () => {
    it('returns 404 for an unrecognised sub-path', async () => {
      const res = await routes(
        makeRequest('GET', '/unknown-route'),
        '/unknown-route'
);
      expect(res.status).toBe(404);
    });
  });
});
