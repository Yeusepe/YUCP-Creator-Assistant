import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProductionRegressionSurfaceId =
  | 'provider'
  | 'identity'
  | 'verification'
  | 'account'
  | 'backfill'
  | 'attestation';

export interface ProductionRegressionSurface {
  id: ProductionRegressionSurfaceId;
  label: string;
  invariant: string;
  primaryRegressionHomes: string[];
  secondaryRegressionHomes: string[];
  remediationHomes: string[];
}

export interface ExternalIntegrationGateStep {
  id: string;
  description: string;
  cwdRelativeToRepoRoot: string;
  args: string[];
  covers: ProductionRegressionSurfaceId[];
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const PRODUCTION_REGRESSION_SURFACES: ProductionRegressionSurface[] = [
  {
    id: 'provider',
    label: 'Provider runtime contracts',
    invariant:
      'Provider adapters and internal RPC boundaries must reject or normalize upstream drift without looping pagination, mis-scaling provider currency units, dropping credential expiry, silently rewriting response shape, hanging dashboard catalog surfaces when live reconciliation stalls, violating transport contracts such as int64 serialization, publishing Backstage repo manifests that drop synthesized alias metadata and importer requirements for metadata-less or previously persisted releases, storing canonical CDNgine source coordinates as delivery references, or persisting Backstage CDNgine delivery references before CDNgine publication is visible.',
    primaryRegressionHomes: [
      'packages/providers/test/gumroad/module.test.ts',
      'packages/providers/test/jinxxy/module.test.ts',
      'packages/providers/test/lemonsqueezy/module.test.ts',
      'packages/providers/test/vrchat/module.test.ts',
      'apps/api/src/internalRpc/router.test.ts',
      'apps/api/src/routes/packages.backstage.test.ts',
    ],
    secondaryRegressionHomes: [
      'apps/bot/test/lib/internalRpc.test.ts',
      'apps/bot/test/lib/setupCatalog.test.ts',
      'apps/bot/test/commands/autosetup.test.ts',
    ],
    remediationHomes: ['apps/api/test/providers', 'convex/packageRegistry.realtest.ts'],
  },
  {
    id: 'attestation',
    label: 'Hardware-attested anti-ripper identity',
    invariant:
      'A protected unlock must be refused when the buyer resolves to an identity node carrying an active block, an attestation challenge nonce must be single-use and fresh so a captured submit cannot be replayed, a claimed TPM that fails endorsement-chain or challenge-signature verification must be flagged rather than silently trusted, an identity block must require at least two durable anchors (TPM and/or payment) so a reused or forged soft label alone cannot ban a real customer, and only salted hashes (never raw identifiers) may be persisted.',
    primaryRegressionHomes: [
      'convex/attestation.realtest.ts',
    ],
    secondaryRegressionHomes: ['convex/couplingJobAndReveal.realtest.ts'],
    remediationHomes: ['convex/attestation.realtest.ts'],
  },
  {
    id: 'identity',
    label: 'Identity and ownership boundaries',
    invariant:
      'Buyer and creator identities must stay explicit at every helper, route, and persistence boundary so one actor can never materialize or mutate another actor’s state.',
    primaryRegressionHomes: [
      'apps/api/src/lib/subjectIdentity.test.ts',
      'apps/api/src/routes/providerPlatform.test.ts',
      'convex/identitySync.realtest.ts',
    ],
    secondaryRegressionHomes: [
      'apps/api/src/verification/completeLicense.test.ts',
      'convex/licenseVerification.realtest.ts',
    ],
    remediationHomes: [
      'ops/subject-ownership-remediation.test.ts',
      'ops/buyer-attribution-remediation.test.ts',
    ],
  },
  {
    id: 'verification',
    label: 'Verification flows',
    invariant:
      'Verification must resolve the buyer subject, keep creator-scoped session context separate from buyer auth ownership, write entitlements and account-link records for the canonical buyer auth user, expose entitlements through stable read DTOs instead of raw persisted rows, preserve degraded or failure signals all the way to the public surface, keep provider source idempotency scoped to the granted product so multi-product orders can assign every role, complete role-sync jobs only after every configured product role is satisfied, surface role-sync failures even when product-driven jobs discover the guild during processing, keep actor-protected Convex helper contracts aligned with the API service actor envelope, and route API-originated verification state changes through public validated Convex actions instead of calling internal functions over the client boundary.',
    primaryRegressionHomes: [
      'convex/entitlements.realtest.ts',
      'convex/outboxJobs.realtest.ts',
      'convex/verificationIntents.realtest.ts',
      'apps/bot/test/lib/roleSync.test.ts',
      'apps/api/src/routes/connect.user-verify.manual-license.test.ts',
      'apps/api/src/routes/connect.user-verify.provider-link.test.ts',
      'apps/api/src/verification/hostedIntents.test.ts',
      'apps/api/src/verification/completeLicense.test.ts',
      'apps/api/src/verification/sessionManager.accountLink.test.ts',
      'apps/api/src/routes/connect.user-verify.behavior.test.ts',
    ],
    secondaryRegressionHomes: [
      'apps/bot/test/commands/verify.test.ts',
      'apps/bot/test/lib/setupCatalog.test.ts',
      'apps/web/test/unit/purchase-verification-ui-state.test.ts',
    ],
    remediationHomes: [
      'convex/entitlements.realtest.ts',
      'convex/outboxJobs.realtest.ts',
      'convex/verificationIntents.realtest.ts',
    ],
  },
  {
    id: 'account',
    label: 'Account and connection surfaces',
    invariant:
      'Account connection surfaces must show the signed-in user’s real provider state and always preserve reconnect, disconnect, and retry actions for degraded records.',
    primaryRegressionHomes: [
      'apps/api/src/routes/connectUserVerification.readSurface.test.ts',
      'apps/web/test/unit/account-connections.test.tsx',
    ],
    secondaryRegressionHomes: [
      'apps/web/test/unit/dashboard-connected-platforms.test.tsx',
      'apps/web/test/unit/store-integrations-status-label.test.tsx',
    ],
    remediationHomes: ['convex/providerConnections.realtest.ts'],
  },
  {
    id: 'backfill',
    label: 'Backfill and repair paths',
    invariant:
      'Backfill and repair jobs must authenticate correctly, preserve tenant ownership, and replay provider state without creating duplicate or cross-tenant records.',
    primaryRegressionHomes: ['apps/api/src/routes/backfill.test.ts', 'apps/api/test/providers'],
    secondaryRegressionHomes: [
      'ops/buyer-attribution-remediation.test.ts',
      'ops/subject-ownership-remediation.test.ts',
    ],
    remediationHomes: ['convex/migrations.realtest.ts'],
  },
];

export const EXTERNAL_INTEGRATION_GATE_STEPS: ExternalIntegrationGateStep[] = [
  {
    id: 'convex-identity-ownership-realtests',
    description: 'Convex identity ownership and attestation regressions',
    cwdRelativeToRepoRoot: '.',
    args: [
      'x',
      'vitest',
      'run',
      '--config',
      'convex/vitest.config.ts',
      './convex/identitySync.realtest.ts',
      './convex/attestation.realtest.ts',
    ],
    covers: ['identity', 'attestation'],
  },
  {
    id: 'convex-verification-entitlement-realtests',
    description: 'Convex entitlement read regressions for verification incidents',
    cwdRelativeToRepoRoot: '.',
    args: [
      'x',
      'vitest',
      'run',
      '--config',
      'convex/vitest.config.ts',
      './convex/entitlements.realtest.ts',
      './convex/outboxJobs.realtest.ts',
    ],
    covers: ['verification'],
  },
  {
    id: 'provider-runtime-and-consumers',
    description:
      'provider runtime contracts plus bot consumer regressions for provider and verification incidents',
    cwdRelativeToRepoRoot: '.',
    args: [
      'test',
      './ops/provider-live-smoke.test.ts',
      './packages/providers/test/gumroad/module.test.ts',
      './packages/providers/test/jinxxy/module.test.ts',
      './packages/providers/test/lemonsqueezy/module.test.ts',
      './packages/providers/test/vrchat/module.test.ts',
      './apps/api/src/routes/packages.backstage.test.ts',
      './apps/bot/test/lib/roleSync.test.ts',
      './apps/bot/test/lib/setupCatalog.test.ts',
      './apps/bot/test/commands/autosetup.test.ts',
    ],
    covers: ['provider', 'verification'],
  },
  {
    id: 'bot-verify-consumer',
    description: 'bot verification panel consumer regressions',
    cwdRelativeToRepoRoot: '.',
    args: ['test', './apps/bot/test/commands/verify.test.ts'],
    covers: ['verification'],
  },
  {
    id: 'api-identity-verification-and-backfill',
    description:
      'API identity, verification, route-scoping, and backfill regressions for production incidents',
    cwdRelativeToRepoRoot: 'apps/api',
    args: [
      'test',
      './src/verification/hostedIntents.test.ts',
      './src/lib/subjectIdentity.test.ts',
      './src/routes/connect.user-verify.manual-license.test.ts',
      './src/routes/providerPlatform.test.ts',
      './src/routes/connectUserVerification.readSurface.test.ts',
      './src/routes/connect.user-verify.behavior.test.ts',
      './src/routes/backfill.test.ts',
      './src/verification/completeLicense.test.ts',
      './src/verification/sessionManager.accountLink.test.ts',
    ],
    covers: ['identity', 'verification', 'account', 'backfill'],
  },
  {
    id: 'web-account-consumers',
    description: 'web account and degraded-state consumer regressions',
    cwdRelativeToRepoRoot: 'apps/web',
    args: [
      'x',
      'vitest',
      'run',
      '--config',
      'vitest.config.ts',
      './test/unit/account-connections.test.tsx',
      './test/unit/dashboard-connected-platforms.test.tsx',
      './test/unit/store-integrations-status-label.test.tsx',
      './test/unit/purchase-verification-ui-state.test.ts',
    ],
    covers: ['verification', 'account'],
  },
];

export function getRepoPath(relativePath: string) {
  return join(repoRoot, relativePath);
}

export function regressionPathExists(relativePath: string) {
  return existsSync(getRepoPath(relativePath));
}
