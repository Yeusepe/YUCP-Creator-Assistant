import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProductionRegressionSurfaceId =
  | 'provider'
  | 'identity'
  | 'verification'
  | 'account'
  | 'backfill';

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
      'Provider adapters and internal RPC boundaries must reject or normalize upstream drift without looping pagination, mis-scaling provider currency units, dropping credential expiry, silently rewriting response shape, or violating transport contracts such as int64 serialization.',
    primaryRegressionHomes: [
      'packages/providers/test/gumroad/module.test.ts',
      'packages/providers/test/jinxxy/module.test.ts',
      'packages/providers/test/lemonsqueezy/module.test.ts',
      'packages/providers/test/vrchat/module.test.ts',
      'apps/api/src/internalRpc/router.test.ts',
    ],
    secondaryRegressionHomes: [
      'apps/bot/test/lib/internalRpc.test.ts',
      'apps/bot/test/lib/setupCatalog.test.ts',
      'apps/bot/test/commands/autosetup.test.ts',
    ],
    remediationHomes: ['apps/api/test/providers'],
  },
  {
    id: 'identity',
    label: 'Identity and ownership boundaries',
    invariant:
      'Buyer and creator identities must stay explicit at every helper, route, and persistence boundary so one actor can never materialize or mutate another actor’s state.',
    primaryRegressionHomes: [
      'apps/api/src/lib/subjectIdentity.test.ts',
      'apps/api/src/routes/providerPlatform.test.ts',
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
      'Verification must resolve the buyer subject, write entitlements for the correct auth user, and preserve degraded or failure signals all the way to the public surface.',
    primaryRegressionHomes: [
      'apps/api/src/verification/completeLicense.test.ts',
      'apps/api/src/routes/connect.user-verify.behavior.test.ts',
    ],
    secondaryRegressionHomes: [
      'apps/bot/test/lib/setupCatalog.test.ts',
      'apps/web/test/unit/purchase-verification-ui-state.test.ts',
    ],
    remediationHomes: ['convex/verificationIntents.realtest.ts'],
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
      './apps/bot/test/lib/setupCatalog.test.ts',
      './apps/bot/test/commands/autosetup.test.ts',
    ],
    covers: ['provider', 'verification'],
  },
  {
    id: 'api-identity-verification-and-backfill',
    description:
      'API identity, verification, route-scoping, and backfill regressions for production incidents',
    cwdRelativeToRepoRoot: 'apps/api',
    args: [
      'test',
      './src/lib/subjectIdentity.test.ts',
      './src/routes/providerPlatform.test.ts',
      './src/routes/connectUserVerification.readSurface.test.ts',
      './src/routes/connect.user-verify.behavior.test.ts',
      './src/routes/backfill.test.ts',
      './src/verification/completeLicense.test.ts',
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
