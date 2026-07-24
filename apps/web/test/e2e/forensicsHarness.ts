import type { Auth, SessionData } from '../../../api/src/auth';
import { createMaterializationControlClient } from '../../../api/src/lib/materializationControlClient';
import { startFakeConvexServer } from '../../../api/test/helpers/fakeConvex';
import { startTestServer } from '../../../api/test/helpers/testServer';

const TEST_AUTH_USER_ID = 'user-forensics-e2e';
const TEST_PACKAGE_ID = 'novaspil-kitbash-test';
const TEST_INTERNAL_SECRET = 'test-internal-rpc-secret-32-chars!!';
const TEST_COUPLING_SECRET = 'test-coupling-secret';
const TEST_MATERIALIZATION_SECRET = 'test-materialization-shared-secret';
const AUTH_PORT = 3210;
const API_PORT = 3211;
const COUPLING_PORT = 3212;
const CONVEX_PORT = 3213;
const MATERIALIZATION_PORT = 3214;

const refs = {
  ensureCatalogFresh: 'certificateBillingSync:ensureCatalogFresh',
  getAccountOverview: 'certificateBilling:getAccountOverview',
  getShellBrandingForAuthUser: 'certificateBilling:getShellBrandingForAuthUser',
  getConnectionStatus: 'providerConnections:getConnectionStatus',
  getUserGuilds: 'guildLinks:getUserGuilds',
  listConnectionsForUser: 'providerConnections:listConnectionsForUser',
  authorizeCouplingForensicsLookupForAuthUser:
    'couplingForensics:authorizeCouplingForensicsLookupForAuthUser',
  listOwnedPackageSummariesForAuthUser: 'couplingForensics:listOwnedPackageSummariesForAuthUser',
  recordLookupAudit: 'couplingForensics:recordLookupAudit',
} as const;

function makeWebSessionAuth(userId: string): Auth {
  const session: SessionData = {
    user: {
      id: userId,
      email: 'forensics-e2e@example.com',
      name: 'Forensics E2E',
      image: null,
    },
    discordUserId: null,
  };

  return {
    getSession: async () => session,
    getDiscordUserId: async () => null,
  } as unknown as Auth;
}

function hasForwardedSessionCookie(request: Request) {
  const cookieHeader = request.headers.get('cookie') ?? '';
  return /(?:^|;\s*)(?:yucp\.session_token|__Secure-yucp\.session_token)=/.test(cookieHeader);
}

const authServer = Bun.serve({
  port: AUTH_PORT,
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/auth/get-session') {
      if (!hasForwardedSessionCookie(request)) {
        return Response.json({ user: null, session: null }, { status: 200 });
      }

      return Response.json({
        user: {
          id: TEST_AUTH_USER_ID,
          email: 'forensics-e2e@example.com',
          name: 'Forensics E2E',
          image: null,
        },
        session: {
          id: 'session-forensics-e2e',
        },
      });
    }

    if (url.pathname === '/api/auth/convex/token') {
      if (!hasForwardedSessionCookie(request)) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }

      return Response.json({
        token: 'forensics-e2e-convex-token',
      });
    }

    if (url.pathname === '/api/auth/ok') {
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  },
});

const couplingServer = Bun.serve({
  port: COUPLING_PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (
      url.pathname !== '/v2/internal/coupling/attribution/evaluate' ||
      request.method !== 'POST'
    ) {
      return new Response('Not found', { status: 404 });
    }

    if ((request.headers.get('authorization') ?? '') !== `Bearer ${TEST_COUPLING_SECRET}`) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const payload = (await request.json()) as {
      assets?: Array<{ assetPath?: string; assetType?: string; contentBase64?: string }>;
      candidates?: Array<{
        attributionId?: string;
        attributionTokenHash?: string;
        normalizedPath?: string;
      }>;
      schemaVersion?: number;
    };
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const hasText = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
    const hasInvalidAsset = assets.some(
      (asset) => !hasText(asset.assetPath) || !hasText(asset.contentBase64)
    );
    const hasInvalidCandidate = candidates.some(
      (candidate) =>
        !hasText(candidate.attributionId) ||
        !hasText(candidate.attributionTokenHash) ||
        !hasText(candidate.normalizedPath)
    );

    if (assets.length === 0 || candidates.length === 0 || hasInvalidAsset || hasInvalidCandidate) {
      return Response.json({ error: 'Missing attribution inputs' }, { status: 400 });
    }

    return Response.json({
      results: assets.map((asset) => ({
        assetPath: asset.assetPath ?? '',
        assetType: asset.assetType ?? 'fbx',
        matched: false,
      })),
      schemaVersion: 2,
    });
  },
});

const materializationServer = Bun.serve({
  port: MATERIALIZATION_PORT,
  fetch(request) {
    const url = new URL(request.url);
    if (
      url.pathname !== '/v2/internal/materialization-attribution/candidates' ||
      request.method !== 'POST'
    ) {
      return new Response('Not found', { status: 404 });
    }
    if (request.headers.get('authorization') !== `Bearer ${TEST_MATERIALIZATION_SECRET}`) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    return Response.json({
      candidateLimit: 512,
      candidates: [
        {
          algorithmVersion: 'fbx-coupling-v2',
          attributionId: 'forensics-e2e-attribution',
          attributionTokenHash: 'b'.repeat(64),
          buyerSubjectPseudonym: Buffer.alloc(32, 0x77).toString('base64url'),
          capabilityId: 'forensics-e2e-capability',
          createdAt: 2_000_000_000_000,
          creatorId: TEST_AUTH_USER_ID,
          jobId: 'forensics-e2e-job',
          keyEpoch: 1,
          leaseGeneration: 1,
          materializerType: 'fbx',
          normalizedPath: 'Assets/Forensics/HarnessFixture.fbx',
          outputFormat: 'zip',
          pluginVersion: 'fbx-plugin-2',
          protectedSourceRoot: '2'.repeat(64),
          releaseRoot: '3'.repeat(64),
          sourceSha256: '4'.repeat(64),
        },
      ],
      truncated: false,
    });
  },
});

const convex = startFakeConvexServer({
  port: CONVEX_PORT,
  query: {
    [refs.getAccountOverview]: () => ({
      workspaceKey: 'creator',
      creatorProfileId: 'creator_profile_forensics_e2e',
      billing: {
        billingEnabled: true,
        status: 'active',
        allowEnrollment: true,
        allowSigning: true,
        planKey: 'studio-plus',
        productId: 'prod_studio_plus',
        deviceCap: 10,
        activeDeviceCount: 1,
        signQuotaPerPeriod: 100,
        auditRetentionDays: 30,
        supportTier: 'standard',
        currentPeriodEnd: null,
        graceUntil: null,
        reason: null,
        capabilities: [
          {
            capabilityKey: 'coupling_traceability',
            status: 'active',
          },
        ],
      },
      devices: [],
      availablePlans: [],
      meters: [],
    }),
    [refs.getConnectionStatus]: () => ({}),
    [refs.getShellBrandingForAuthUser]: () => ({
      isPlus: true,
      billingStatus: 'active',
    }),
    [refs.getUserGuilds]: () => [
      {
        authUserId: TEST_AUTH_USER_ID,
        guildId: 'guild-forensics-e2e',
        name: 'Forensics Guild',
        icon: null,
      },
    ],
    [refs.listConnectionsForUser]: () => [],
    [refs.listOwnedPackageSummariesForAuthUser]: () => ({
      packages: [
        {
          packageId: TEST_PACKAGE_ID,
          packageName: 'Novaspil Test Package',
          registeredAt: 1,
          updatedAt: 1,
        },
      ],
    }),
    [refs.authorizeCouplingForensicsLookupForAuthUser]: () => ({
      capabilityEnabled: true,
      packageOwned: true,
    }),
  },
  mutation: {
    [refs.recordLookupAudit]: () => null,
  },
  action: {
    [refs.ensureCatalogFresh]: () => null,
  },
});

process.env.INTERNAL_RPC_SHARED_SECRET = TEST_INTERNAL_SECRET;

const apiServer = await startTestServer({
  port: API_PORT,
  auth: makeWebSessionAuth(TEST_AUTH_USER_ID),
  convexUrl: convex.url,
  convexSiteUrl: convex.url,
  convexApiSecret: 'test-api-secret-min-32-characters!!',
  couplingServiceBaseUrl: `http://127.0.0.1:${COUPLING_PORT}`,
  couplingServiceSharedSecret: TEST_COUPLING_SECRET,
  materializationControl: createMaterializationControlClient({
    baseUrl: `http://127.0.0.1:${MATERIALIZATION_PORT}`,
    sharedSecret: TEST_MATERIALIZATION_SECRET,
  }),
  baseUrl: `http://127.0.0.1:${API_PORT}`,
  frontendUrl: 'http://localhost:3100',
});

function shutdown(exitCode = 0) {
  apiServer.stop();
  convex.stop();
  authServer.stop(true);
  couplingServer.stop(true);
  materializationServer.stop(true);
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(
  JSON.stringify({
    authUrl: `http://127.0.0.1:${AUTH_PORT}`,
    apiUrl: apiServer.url,
    convexUrl: convex.url,
    couplingUrl: `http://127.0.0.1:${COUPLING_PORT}`,
    internalSecret: TEST_INTERNAL_SECRET,
  })
);
console.log('Forensics harness ready');

await new Promise(() => {});
