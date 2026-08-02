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
      'Provider adapters and internal RPC boundaries must reject or normalize upstream drift without looping pagination, mis-scaling provider currency units, dropping credential expiry, silently rewriting response shape, hanging dashboard catalog surfaces when live reconciliation stalls, or violating transport contracts such as int64 serialization. A collaborator-capable provider must list active collaborator-store products even when the creator workspace has no owner-store credential. Public catalog URLs must come from provider-supplied storefront data or a documented canonical slug template, never from opaque provider API product IDs.',
    primaryRegressionHomes: [
      'packages/providers/test/providerMetadata.test.ts',
      'packages/providers/test/gumroad/module.test.ts',
      'packages/providers/test/jinxxy/module.test.ts',
      'packages/providers/test/lemonsqueezy/module.test.ts',
      'packages/providers/test/vrchat/module.test.ts',
      'apps/api/src/routes/products.test.ts',
      'apps/api/src/internalRpc/router.test.ts',
    ],
    secondaryRegressionHomes: [
      'apps/bot/test/lib/internalRpc.test.ts',
      'apps/bot/test/lib/setupCatalog.test.ts',
      'apps/bot/test/commands/autosetup.test.ts',
      'apps/bot/test/commands/product.test.ts',
    ],
    remediationHomes: [
      'apps/api/test/providers',
      'convex/migrations.realtest.ts',
      'convex/catalogMaterialization.realtest.ts',
      'convex/packageRegistry.realtest.ts',
      'ops/catalog-product-url-remediation.test.ts',
    ],
  },
  {
    id: 'attestation',
    label: 'Hardware-attested anti-ripper identity',
    invariant:
      'A protected unlock must be refused when the buyer resolves to an identity node carrying an active block, an attestation challenge nonce must be single-use and fresh so a captured submit cannot be replayed, a claimed TPM that fails endorsement-chain or challenge-signature verification must be flagged rather than silently trusted, an identity block must require at least two durable anchors (TPM and/or payment) so a reused or forged soft label alone cannot ban a real customer, and only salted hashes (never raw identifiers) may be persisted.',
    primaryRegressionHomes: ['convex/attestation.realtest.ts'],
    secondaryRegressionHomes: ['convex/couplingForensics.realtest.ts'],
    remediationHomes: ['convex/attestation.realtest.ts'],
  },
  {
    id: 'identity',
    label: 'Identity and ownership boundaries',
    invariant:
      'Buyer and creator identities must stay explicit at every helper, route, and persistence boundary so one actor can never materialize or mutate another actor’s state. Public API-key verification must authenticate only managed public-api records whose stored Better Auth owner matches the metadata auth user, so key metadata can never impersonate another tenant. Better Auth and its Convex adapter must use a mutually supported database contract so social sign-in never sends fields that the persisted account validator rejects, and atomic refresh-token rotation must treat an omitted optional Convex field as the nullable Better Auth field it represents without allowing a second rotation. The versioned compatibility bridge must stay narrow, atomic, and replaceable through official adapter interfaces. Package broker OAuth must use the provider RFC 8252 loopback implementation without an application-owned redirect proxy, and protected resource verification behind a reverse proxy must bind DPoP htu to the required canonical API origin instead of the browser frontend, an internal service origin, a localhost fallback, or an untrusted forwarded header. Durable DPoP replay prevention must accept the verifier’s bounded future clock skew while still rejecting the same proof twice. An otherwise-valid proof outside that clock window must receive an RFC 9449 server-time nonce challenge, and its nonce-bound retry must retain token hash, public key, method, URL, signature, and shared replay enforcement so client clock skew never becomes an authentication loop. Package broker request verification must distinguish an unavailable replay, key, or database dependency from invalid credentials and return service unavailable instead of starting another OAuth loop.',
    primaryRegressionHomes: [
      'ops/better-auth-package-broker-loopback.contract.test.ts',
      'ops/storage-core/dpopNonce.test.ts',
      'apps/api/src/lib/oauthAccessToken.test.ts',
      'apps/api/src/lib/publicRuntimeOrigins.test.ts',
      'apps/api/src/lib/subjectIdentity.test.ts',
      'apps/api/src/routes/providerPlatform.test.ts',
      'convex/identitySync.realtest.ts',
      'convex/betterAuthApiKeys.realtest.ts',
      'convex/betterAuth/adapter.realtest.ts',
      'ops/convex-better-auth-compat.test.ts',
      'ops/catalog/catalog.integration.test.ts',
    ],
    secondaryRegressionHomes: [
      'apps/api/src/verification/completeLicense.test.ts',
      'apps/api/src/routes/publicV2/auth.test.ts',
      'apps/api/src/routes/packageInstallSessions.test.ts',
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
      "Verification must resolve the buyer subject, keep creator-scoped session context separate from buyer auth ownership, write entitlements and account-link records for the canonical buyer auth user, and attach the canonical catalog product before marking a provider license intent verified. A provider response that identifies a different product must never unlock the requested product. The VPM repository must consume only these canonical catalog identities. Verification must expose entitlements through stable read DTOs instead of raw persisted rows, preserve degraded or failure signals all the way to the public surface, advertise provider-owned manual license proof through actual hosted product requirements so a manual buyer can reach the entitlement funnel, report an OAuth-JWT Suite subject as verified only when it has at least one active entitlement, commit manual-license revocation before a bounded, idempotent entitlement-and-role-removal cascade runs so high-redemption reusable licenses remain revokable, charge each Workpool role-removal dispatch its full durable write cost when sizing that cascade, reject direct service revocation through status updates so the dedicated revoke flow always schedules cleanup, keep provider source idempotency scoped to the granted product so multi-product orders can assign every role, complete role-sync jobs only after every configured product role is satisfied, surface role-sync failures even when product-driven jobs discover the guild during processing, keep actor-protected Convex helper contracts aligned with the API service actor envelope, route API-originated verification state changes through public validated Convex actions instead of calling internal functions over the client boundary, grant buyer product access from active entitlements across every active linked subject while preserving product-level grants that predate catalog product attribution, scope human-friendly buyer access URLs to the creator profile before resolving product aliases so another creator's slug or duplicated product reference cannot be substituted, rate-limit public buyer access lookups before database work, return one stable buyer-and-creator VPM source from every product page for that creator, derive its package set dynamically from the buyer's active entitlements and the creator's enabled packages, and publish each package under the uploaded install ID and release version, never issue or serve a creator-private VPM repository through the shared VPM origin when its creator hostname is unavailable or unconfigured, remove verification grants from browser URLs immediately after reading return state, omit public creator and product references from telemetry, keep the main package list limited to products with ready package history while the upload picker exposes products before their first package upload and collapses equivalent cross-provider entries without discarding their provider records, durably materialize upload targets after either an owner store or collaborator store connects so a creator with no store can still publish, retain catalog rows whenever package or entitlement history still references them, accept deletion of a version that never reached the Convex reference catalog so one absent tombstone cannot poison the ordered outbox and block every later Ready package, and let a newer Ready event replace immutable release data only after that durable version identity was explicitly deleted so clean re-uploads can publish without weakening active-release immutability. Signed-in package installation must return a trusted product verification URL when entitlement is absent. Native package operations must never translate a DPoP replay rejection into interactive OAuth; only an explicit sign-in action may launch OAuth, and an authenticated user without entitlement must receive one verification URL. Native refresh-token rotation must tolerate a bounded retry from the same client, scopes, resource, and DPoP key so a lost response does not erase the saved sign-in. Each preflight and mutating package operation must use its own idempotency key, while a retry of the same semantic operation may carry fresh tracing context and must replay the original authorization instead of conflicting. Package-install renewal claims and their signed grants must use the same whole-second timestamp precision so the persisted renewal fence can commit an otherwise valid replacement grant. Native delivery manifest validation must stay aligned with the complete VPM bootstrap media contract, including banners, icons, galleries, and payload-less or image-backed product links. Creator package enablement must remain stable until an authenticated owner revokes it.",
    primaryRegressionHomes: [
      'convex/entitlements.realtest.ts',
      'convex/entitlements.buyer-holder.realtest.ts',
      'convex/manualLicenses.realtest.ts',
      'convex/outboxJobs.realtest.ts',
      'convex/catalogMaterialization.realtest.ts',
      'convex/packageRegistry.realtest.ts',
      'convex/packageVersions.realtest.ts',
      'convex/creatorVpmLinks.realtest.ts',
      'convex/buyerCreatorVpmRepositories.realtest.ts',
      'convex/roleRules.realtest.ts',
      'convex/verificationIntents.realtest.ts',
      'apps/bot/test/lib/roleSync.test.ts',
      'apps/api/src/routes/connect.user-verify.manual-license.test.ts',
      'apps/api/src/routes/connect.user-verify.provider-link.test.ts',
      'apps/api/src/verification/hostedIntents.test.ts',
      'apps/api/src/verification/completeLicense.test.ts',
      'apps/api/src/verification/sessionManager.accountLink.test.ts',
      'apps/api/src/routes/connect.user-verify.behavior.test.ts',
      'apps/api/src/routes/packageInstallSessions.test.ts',
      'apps/api/src/routes/vpm.test.ts',
      'apps/api/test/e2e/user-journeys.test.ts',
      'apps/api/src/routes/suite.test.ts',
      'ops/catalog/catalog.integration.test.ts',
      // The Go delivery, broker, dpop and lifecycle regressions moved to the ca-coupling repo
      // together with the transfer-helper module; that repo owns their regression surface now.
    ],
    secondaryRegressionHomes: [
      'apps/api/src/routes/connectUserProductAccess.test.ts',
      'apps/bot/test/commands/verify.test.ts',
      'apps/bot/test/lib/setupCatalog.test.ts',
      'apps/web/test/unit/buyer-product-access-route.test.tsx',
      'apps/web/test/unit/purchase-verification-ui-state.test.ts',
      'apps/web/test/unit/get-in-unity-route.test.tsx',
      'apps/web/test/unit/dashboard-packages-route.test.tsx',
      'apps/web/test/unit/packages-client.test.ts',
      'apps/web/test/unit/product-access-diagnostics.test.ts',
    ],
    remediationHomes: [
      'convex/entitlements.realtest.ts',
      'convex/migrations.realtest.ts',
      'convex/outboxJobs.realtest.ts',
      'convex/verificationIntents.realtest.ts',
      'ops/catalog-product-url-remediation.test.ts',
    ],
  },
  {
    id: 'account',
    label: 'Account and connection surfaces',
    invariant:
      'Account connection surfaces must show the signed-in user’s real provider state and always preserve reconnect, disconnect, and retry actions for degraded records. Activating an owner or collaborator store connection must enqueue idempotent catalog materialization for that creator workspace. First-party native OAuth grants must remain visible and revocable from the website so users can sign installed applications out without access to Unity. Creator activation must revalidate the durable signed-in session, resolve the canonical linked Discord identity when a cookie session omits it, treat an existing active creator profile as success, and never reuse an account shell forever after creator or session state changes.',
    primaryRegressionHomes: [
      'apps/api/src/routes/connect.guildChannels.test.ts',
      'apps/api/src/routes/connectUserVerification.readSurface.test.ts',
      'apps/web/test/unit/account-creator-activation.test.ts',
      'apps/web/test/unit/account-connections.test.tsx',
    ],
    secondaryRegressionHomes: [
      'apps/web/test/unit/account-ui-contracts.test.ts',
      'apps/web/test/unit/dashboard-connected-platforms.test.tsx',
      'apps/web/test/unit/store-integrations-status-label.test.tsx',
    ],
    remediationHomes: [
      'convex/providerConnections.realtest.ts',
      'convex/catalogMaterialization.realtest.ts',
    ],
  },
  {
    id: 'backfill',
    label: 'Backfill and repair paths',
    invariant:
      'Backfill and repair jobs must authenticate correctly, preserve tenant ownership, replay provider state without creating duplicate or cross-tenant records, enqueue missing catalog materialization for active owner and collaborator stores, and repair fabricated catalog storefront links without replacing them with another unverified URL.',
    primaryRegressionHomes: ['apps/api/src/routes/backfill.test.ts', 'apps/api/test/providers'],
    secondaryRegressionHomes: [
      'ops/buyer-attribution-remediation.test.ts',
      'ops/catalog-product-url-remediation.test.ts',
      'ops/subject-ownership-remediation.test.ts',
    ],
    remediationHomes: [
      'convex/migrations.realtest.ts',
      'convex/catalogMaterialization.realtest.ts',
    ],
  },
];

export const EXTERNAL_INTEGRATION_GATE_STEPS: ExternalIntegrationGateStep[] = [
  {
    id: 'unity-oauth-loopback-contract',
    description: 'Package broker OAuth provider ownership regression',
    cwdRelativeToRepoRoot: '.',
    args: [
      'test',
      './ops/better-auth-package-broker-loopback.contract.test.ts',
      './ops/materialization/dpop.test.ts',
      './ops/storage-core/dpopNonce.test.ts',
    ],
    covers: ['identity'],
  },
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
      './convex/betterAuthApiKeys.realtest.ts',
      './convex/betterAuth/adapter.realtest.ts',
    ],
    covers: ['identity', 'attestation'],
  },
  {
    id: 'convex-verification-entitlement-realtests',
    description:
      'Convex entitlement and manual-license revocation regressions for verification incidents',
    cwdRelativeToRepoRoot: '.',
    args: [
      'x',
      'vitest',
      'run',
      '--config',
      'convex/vitest.config.ts',
      './convex/entitlements.realtest.ts',
      './convex/entitlements.buyer-holder.realtest.ts',
      './convex/manualLicenses.realtest.ts',
      './convex/catalogSyncIdentity.realtest.ts',
      './convex/catalogMaterialization.realtest.ts',
      './convex/migrations.realtest.ts',
      './convex/outboxJobs.realtest.ts',
      './convex/packageRegistry.realtest.ts',
      './convex/packageVersions.realtest.ts',
      './convex/creatorVpmLinks.realtest.ts',
      './convex/buyerCreatorVpmRepositories.realtest.ts',
      './convex/roleRules.realtest.ts',
      './convex/verificationIntents.realtest.ts',
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
      './ops/catalog-product-url-remediation.test.ts',
      './packages/providers/test/providerMetadata.test.ts',
      './packages/providers/test/gumroad/module.test.ts',
      './packages/providers/test/jinxxy/module.test.ts',
      './packages/providers/test/lemonsqueezy/module.test.ts',
      './packages/providers/test/vrchat/module.test.ts',
      './apps/api/src/routes/products.test.ts',
      './apps/bot/test/lib/roleSync.test.ts',
      './apps/bot/test/lib/setupCatalog.test.ts',
      './apps/bot/test/commands/autosetup.test.ts',
      './apps/bot/test/commands/product.test.ts',
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
      './src/lib/oauthAccessToken.test.ts',
      './src/lib/subjectIdentity.test.ts',
      './src/routes/connect.user-verify.manual-license.test.ts',
      './src/routes/providerPlatform.test.ts',
      './src/routes/connectUserVerification.readSurface.test.ts',
      './src/routes/connect.user-verify.behavior.test.ts',
      './src/routes/backfill.test.ts',
      './src/verification/completeLicense.test.ts',
      './src/verification/sessionManager.accountLink.test.ts',
      './src/routes/suite.test.ts',
      './src/routes/publicV2/auth.test.ts',
      './src/routes/packageInstallSessions.test.ts',
    ],
    covers: ['identity', 'verification', 'account', 'backfill'],
  },
  {
    id: 'api-account-creator-activation',
    description: 'API creator-account activation regressions',
    cwdRelativeToRepoRoot: 'apps/api',
    args: ['test', './src/routes/connect.guildChannels.test.ts'],
    covers: ['account'],
  },
  {
    id: 'api-vpm-bootstrap',
    description: 'API VPM bootstrap and creator repository regressions',
    cwdRelativeToRepoRoot: 'apps/api',
    args: ['test', './src/routes/vpm.test.ts'],
    covers: ['account'],
  },
  {
    id: 'api-buyer-product-access',
    description: 'API buyer product access entitlement regressions',
    cwdRelativeToRepoRoot: 'apps/api',
    args: ['test', './src/routes/connectUserProductAccess.test.ts'],
    covers: ['verification'],
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
      './test/unit/account-creator-activation.test.ts',
      './test/unit/account-connections.test.tsx',
      './test/unit/account-ui-contracts.test.ts',
      './test/unit/buyer-product-access-route.test.tsx',
      './test/unit/dashboard-connected-platforms.test.tsx',
      './test/unit/store-integrations-status-label.test.tsx',
      './test/unit/purchase-verification-ui-state.test.ts',
      './test/unit/get-in-unity-route.test.tsx',
      './test/unit/dashboard-packages-route.test.tsx',
      './test/unit/packages-client.test.ts',
      './test/unit/product-access-diagnostics.test.ts',
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
