# Reinventing the Wheel Audit

Date: 2026-07-14
Scope: `apps`, `packages`, `convex`, `ops`, workspace manifests, and dependency topology
Mode: Read-only repository analysis
Status: Findings and recommendations only; no implementation changes are included

## Purpose

This report identifies places where CreatorAssistant maintains custom implementations of problems already handled by mature packages, framework primitives, or existing dependencies in this repository.

The goal is not to maximize dependency count. The goal is to:

- consume maintained implementations for standards, protocols, accessibility, parsing, retries, and process management;
- coalesce repeated YUCP-specific logic into one internal owner;
- delete dead or inert infrastructure;
- preserve domain logic where an external abstraction would only add indirection;
- reduce security and correctness risk created by maintaining low-level protocol code.

Three parallel audit lanes covered the frontend, backend/providers/Convex, and shared/tooling surfaces. Package recommendations were checked against current official documentation where possible.

## Executive Summary

The clearest reinvention is concentrated in six areas:

1. **HTTP routing, validation, and OpenAPI:** more than 4,300 lines maintain parallel route trees, a test server, request parsing, and a hand-written OpenAPI document.
2. **Provider protocols:** the repository maintains large custom clients for Lemon Squeezy, VRChat, Jinxxy, Payhip, Discord, and Gumroad, including repeated retry, OAuth, cookie, and response-parsing machinery.
3. **Frontend accessibility primitives:** custom toast, select, menu, dialog, and drawer implementations duplicate behavior already available from the installed HeroUI library.
4. **Security standards:** OAuth/PKCE, JWT/JWS/JWE, cookie parsing, canonicalization, and encryption-envelope mechanics are implemented repeatedly.
5. **Tooling and archive handling:** process supervision, subprocess capture, ZIP creation, TAR parsing, SemVer parsing, and CSV parsing are maintained manually.
6. **Dependency governance:** several dependencies are declared in the wrong workspace, several appear unused, and some production imports have no direct dependency declaration.

The best near-term sequence is:

1. consume packages already installed but bypassed;
2. replace incorrect or security-sensitive protocol implementations;
3. add dependency governance with Knip;
4. coalesce repeated domain functions;
5. migrate the API routing stack incrementally;
6. migrate signed or encrypted wire formats last, with compatibility readers.

## Evaluation Criteria

Each opportunity is evaluated using:

- **Maintenance payoff:** expected reduction in code and behavioral surface owned by the project.
- **Migration risk:** likelihood of compatibility, persistence, security, or user-experience regressions.
- **Package trust:** preference for vendor SDKs, standards-focused packages, established ecosystem packages, or dependencies already used by the repository.
- **Architectural fit:** whether the package can sit behind existing provider, analytics, and application-service boundaries.

## Highest-Value Package Replacements

### 1. HTTP routing, validation, and OpenAPI

**Recommendation:** Adopt Hono, `@hono/zod-openapi`, and a direct Zod 4 dependency through an incremental migration.

**Maintenance payoff:** Very high
**Migration risk:** High
**Confidence:** High

Current infrastructure includes:

- `apps/api/src/index.ts`, a 1,507-line composition root and manual router;
- `apps/api/src/createServer.ts`, a second 477-line production-like route tree for tests;
- `apps/api/src/routes/publicV2/index.ts`, another manual sub-router;
- `apps/api/src/routes/publicV2/openapi.ts`, a 2,397-line hand-maintained OpenAPI object;
- repeated method checks, JSON parsing, body validation, response construction, and route matching.

Evidence:

- [`apps/api/src/index.ts`](../apps/api/src/index.ts#L484)
- [`apps/api/src/createServer.ts`](../apps/api/src/createServer.ts#L1)
- [`apps/api/src/routes/publicV2/index.ts`](../apps/api/src/routes/publicV2/index.ts#L27)
- [`apps/api/src/routes/publicV2/openapi.ts`](../apps/api/src/routes/publicV2/openapi.ts#L4)
- [`apps/api/src/routes/publicV2/manual-licenses.ts`](../apps/api/src/routes/publicV2/manual-licenses.ts#L47)

Hono runs on Bun and allows tests to call the same `app.fetch()` used in production. `@hono/zod-openapi` can derive request validation, response typing, and OpenAPI from the same route schema.

References:

- [Hono on Bun](https://hono.dev/docs/getting-started/bun)
- [Hono Zod OpenAPI](https://hono.dev/examples/zod-openapi)

Target architecture:

```text
createApiApp(dependencies)
  -> shared middleware for tracing, request IDs, security headers, CORS, and limits
  -> route modules with schemas and application-service calls
  -> generated OpenAPI
  -> production server and tests use the same app
```

Guardrails:

- preserve `withApiRequestSpan` and trace propagation as middleware;
- move transport-independent behavior into application services before migrating routes;
- do not allow generic routes to acquire provider-specific branches;
- migrate one route family at a time;
- retain current regression contracts throughout migration.

### 2. HeroUI primitives already installed

**Recommendation:** Replace custom toast, select, autocomplete/menu, modal, alert-dialog, and mobile drawer behavior with HeroUI v3 primitives.

**Maintenance payoff:** High
**Migration risk:** Low to medium
**Confidence:** Very high

The custom toast implementation owns identifiers, queues, timers, pause/resume behavior, ARIA regions, icons, actions, progress, animation, and almost 300 lines of CSS.

Evidence:

- [`apps/web/src/components/ui/Toast.tsx`](../apps/web/src/components/ui/Toast.tsx#L11)
- [`apps/web/src/styles/toast.css`](../apps/web/src/styles/toast.css#L1)
- [`apps/web/src/components/ui/Select.tsx`](../apps/web/src/components/ui/Select.tsx#L17)
- [`apps/web/src/components/account/AccountPage.tsx`](../apps/web/src/components/account/AccountPage.tsx#L96)
- [`apps/web/src/routes/_authenticated/dashboard/integrations.lazy.tsx`](../apps/web/src/routes/_authenticated/dashboard/integrations.lazy.tsx#L777)

HeroUI already provides the required queue, promise/loading, timeout, close, focus trap, keyboard, dismiss, scroll-lock, and screen-reader behavior.

References:

- [HeroUI Toast](https://heroui.com/en/docs/react/components/toast)
- [HeroUI Modal](https://heroui.com/en/docs/react/components/modal)
- [HeroUI component catalog](https://heroui.com/en/docs/react/components)

Recommended migration pattern:

1. keep the current `useToast()` API as a thin compatibility wrapper around HeroUI `toast`;
2. migrate callers incrementally;
3. remove the custom queue, timers, icons, and CSS;
4. migrate destructive confirmations to `AlertDialog`;
5. migrate mobile overlays to `Drawer` while keeping the persistent desktop layout.

Keep YUCP wrappers such as `YucpButton`, `YucpInput`, `StatusChip`, and `YucpSkeleton`. They are useful product-level boundaries over HeroUI.

### 3. Official Lemon Squeezy SDK

**Recommendation:** Replace the custom Lemon Squeezy client internals with `@lemonsqueezy/lemonsqueezy.js`.

**Maintenance payoff:** High
**Migration risk:** Medium
**Confidence:** High

The current client is approximately 754 lines and owns JSON:API types, pagination, request setup, timeouts, retry behavior, errors, webhooks, orders, products, and license calls.

Evidence:

- [`packages/providers/src/lemonsqueezy/client.ts`](../packages/providers/src/lemonsqueezy/client.ts#L53)
- [`packages/providers/src/lemonsqueezy/client.ts`](../packages/providers/src/lemonsqueezy/client.ts#L723)

The custom license request currently sends JSON, while Lemon Squeezy's License API requires form-encoded parameters. The vendor SDK exposes products, orders, webhooks, license validation, activation, and deactivation.

References:

- [Official Lemon Squeezy JavaScript SDK](https://github.com/lmsqueezy/lemonsqueezy.js)
- [Lemon Squeezy License API](https://docs.lemonsqueezy.com/api/license-api)

Keep custom:

- provider-to-YUCP domain mapping;
- credential retrieval and encryption;
- connection degradation on credential expiry;
- audit events and tracing;
- plugin capability declarations.

### 4. Installed VRChat SDK

**Recommendation:** Pilot the already-installed `vrchat` package behind the VRChat provider adapter.

**Maintenance payoff:** High
**Migration risk:** Medium
**Confidence:** High on duplication, medium on session compatibility

The workspace declares `vrchat`, but production source does not import it. The repository instead maintains two clients and supporting cookie, type, and guard modules.

Evidence:

- [`packages/providers/package.json`](../packages/providers/package.json#L21)
- [`packages/providers/src/vrchat/client.ts`](../packages/providers/src/vrchat/client.ts#L1)
- [`convex/lib/vrchat/client.ts`](../convex/lib/vrchat/client.ts#L1)
- [`convex/lib/vrchat/cookie.ts`](../convex/lib/vrchat/cookie.ts#L1)

The community SDK provides typed authentication, 2FA, users, avatars, licensed avatars, and product listings.

Reference: [VRChat JavaScript SDK](https://vrchat.community/javascript)

Before removing custom code, verify with a real-flow contract that the SDK supports:

- the current cookie/session persistence format;
- 2FA challenge and completion behavior;
- lazy credential decryption;
- the required application identification header;
- 401 mapping to degraded connection state;
- the runtime used by each consumer.

### 5. Existing rate-limiter-flexible implementation

**Recommendation:** Use the existing Redis-backed rate-limit service for every API route family.

**Maintenance payoff:** High
**Migration risk:** Low to medium
**Confidence:** Very high

Three rate-limiter implementations currently coexist:

- a global process-local map in the API router;
- a verification-specific map;
- a mature `rate-limiter-flexible` implementation supporting Redis and local development.

Evidence:

- [`apps/api/src/index.ts`](../apps/api/src/index.ts#L81)
- [`apps/api/src/index.ts`](../apps/api/src/index.ts#L209)
- [`apps/api/src/verification/verificationRouteSupport.ts`](../apps/api/src/verification/verificationRouteSupport.ts#L69)
- [`apps/api/src/lib/publicApiRateLimit.ts`](../apps/api/src/lib/publicApiRateLimit.ts#L1)

Create declarative route-family policies over the existing service. Preserve rate-limit headers, analytics, Redis fail-closed behavior in production, and explicit local-process behavior in development and tests.

Client-address extraction should also have one trusted-proxy policy. Current helpers disagree about whether forwarded headers are trustworthy.

### 6. Official TUS client

**Recommendation:** Replace manual TUS requests with `tus-js-client` in both browser and CLI publishing.

**Maintenance payoff:** High
**Migration risk:** Medium
**Confidence:** High

The current browser and CLI implementations send a single `PATCH` starting at offset zero. They do not implement upload discovery, resumption, retry delays, fingerprints, chunking, or recovery after process/page interruption.

Evidence:

- [`apps/web/src/lib/packages.ts`](../apps/web/src/lib/packages.ts#L366)
- [`ops/publish-backstage-package.ts`](../ops/publish-backstage-package.ts#L314)

`tus-js-client` is the official JavaScript client for the TUS protocol and supports browser and Node-compatible runtimes, retry, progress, and resumption.

Reference: [tus-js-client](https://tus.io/blog/2022/08/03/tus-js-client-300)

Keep current server-issued upload sessions and completion tokens. Replace only the client-side protocol implementation.

### 7. OAuth mechanics

**Recommendation:** Use `oauth4webapi` for OAuth authorization-code, PKCE, token exchange, refresh, revocation, and response validation.

**Maintenance payoff:** High
**Migration risk:** Medium to high
**Confidence:** High for protocol primitives

Repeated OAuth and PKCE mechanics exist in:

- [`packages/providers/src/gumroad/oauth.ts`](../packages/providers/src/gumroad/oauth.ts#L24)
- [`packages/providers/src/discord/oauth.ts`](../packages/providers/src/discord/oauth.ts#L63)
- [`apps/api/src/providers/patreon/connect.ts`](../apps/api/src/providers/patreon/connect.ts#L113)
- [`apps/api/src/providers/patreon/buyerLink.ts`](../apps/api/src/providers/patreon/buyerLink.ts#L220)
- [`apps/api/src/routes/connectDiscordRoleRoutes.ts`](../apps/api/src/routes/connectDiscordRoleRoutes.ts#L166)
- [`apps/api/src/routes/install.ts`](../apps/api/src/routes/install.ts#L192)
- [`apps/api/src/routes/collab.ts`](../apps/api/src/routes/collab.ts#L480)

The Discord and Gumroad random-string functions also use byte modulo alphabet length, which introduces avoidable modulo bias.

`oauth4webapi` is a zero-dependency, standards-focused implementation supporting Bun, browsers, Node.js, and Cloudflare-compatible runtimes.

Reference: [oauth4webapi](https://github.com/panva/oauth4webapi)

Target structure:

```text
provider plugin descriptor
  -> endpoints, scopes, client authentication, provider quirks
shared OAuth protocol adapter
  -> oauth4webapi
application service
  -> state persistence, encrypted credentials, tracing, audit
```

Every provider endpoint and response must still be verified against that provider's current official documentation during implementation.

### 8. JWT, JWS, and JWE

**Recommendation:** Declare `jose` directly and use it for standards-based signed and encrypted tokens.

**Maintenance payoff:** High
**Migration risk:** Medium to high
**Confidence:** High on package fit

Hand-written token formats and validation exist in:

- [`convex/lib/yucpCrypto.ts`](../convex/lib/yucpCrypto.ts#L249)
- [`convex/verificationIntents.ts`](../convex/verificationIntents.ts#L319)
- [`packages/shared/src/accountRecoveryPasskey.ts`](../packages/shared/src/accountRecoveryPasskey.ts#L33)
- [`packages/shared/src/apiActor.ts`](../packages/shared/src/apiActor.ts#L230)
- [`packages/shared/src/verificationSupport.ts`](../packages/shared/src/verificationSupport.ts#L69)
- [`apps/api/src/lib/setupSession.ts`](../apps/api/src/lib/setupSession.ts#L29)

`jose` provides `SignJWT`, `jwtVerify`, JWS, JWE, JWK/JWKS handling, and claim validation across Bun and Web Crypto runtimes.

Reference: [jose](https://github.com/panva/jose)

Guardrails:

- keep issuer, audience, purpose, algorithm, and domain claims explicit;
- retain HKDF domain separation where keys are derived;
- use golden byte/claim fixtures;
- version persisted formats;
- use dual-read migration until old tokens expire;
- do not silently change certificate canonicalization.

### 9. Provider HTTP transport

**Recommendation:** Build one plugin-facing HTTP transport using Ky.

**Maintenance payoff:** High
**Migration risk:** Medium
**Confidence:** High

Jinxxy, Lemon Squeezy, and Payhip independently implement `fetch`, timeout, `AbortController`, sleep, retry, `Retry-After`, JSON parsing, and error mapping. Another retry helper exists in provider core but is not shared consistently.

Evidence:

- [`packages/providers/src/jinxxy/client.ts`](../packages/providers/src/jinxxy/client.ts#L80)
- [`packages/providers/src/lemonsqueezy/client.ts`](../packages/providers/src/lemonsqueezy/client.ts#L53)
- [`packages/providers/src/payhip/client.ts`](../packages/providers/src/payhip/client.ts#L40)
- [`packages/providers/src/core/rateLimit.ts`](../packages/providers/src/core/rateLimit.ts#L1)

Ky supplies Fetch-compatible timeouts, retries, jitter, `Retry-After` handling, hooks, and structured HTTP errors.

Reference: [Ky](https://github.com/sindresorhus/ky)

The wrapper must:

- preserve `withProviderRequestSpan`;
- redact credentials;
- classify 401 as credential expiry when appropriate;
- never retry unsafe writes without provider guarantees;
- keep provider response schemas and semantics in provider plugins;
- leave durable job retry policy to Workpool or the persisted outbox.

Do not replace the frontend traced API client with Ky. Its request IDs, Server-Timing parsing, auth behavior, and HyperDX events are application architecture.

### 10. Runtime schemas and parsing

**Recommendation:** Use Zod 4 at untrusted boundaries, then use focused packages for established formats.

**Maintenance payoff:** High
**Migration risk:** Medium
**Confidence:** High

Large manual validators include:

- [`packages/shared/src/yucpAliasPackageContract.ts`](../packages/shared/src/yucpAliasPackageContract.ts#L77)
- [`packages/shared/src/backstagePackageMedia.ts`](../packages/shared/src/backstagePackageMedia.ts#L44)
- [`packages/shared/src/backstageVpmPackage.ts`](../packages/shared/src/backstageVpmPackage.ts#L52)
- [`packages/shared/src/backstageReleaseMaterialization.ts`](../packages/shared/src/backstageReleaseMaterialization.ts#L48)
- [`packages/shared/src/apiActor.ts`](../packages/shared/src/apiActor.ts#L59)
- [`packages/policy/src/defaults.ts`](../packages/policy/src/defaults.ts#L100)

At least twelve production files independently define `isRecord`.

Use:

- **Zod 4** for external request, persistence, and imported-data boundaries;
- **`semver`** instead of the partial parser in [`yucpAliasPackageContract.ts`](../packages/shared/src/yucpAliasPackageContract.ts#L451);
- **`csv-parse`** instead of line/comma splitting in [`manual/index.ts`](../packages/providers/src/manual/index.ts#L94);
- **`set-cookie-parser`** instead of three cookie parsers;
- **`entities`** and **`html-to-text`** where provider HTML is normalized.

Zod schemas should validate shape. Domain normalization should remain explicit and tested, especially where legacy aliases are intentionally accepted.

### 11. Archive parsing and creation

**Recommendation:** Use maintained archive libraries for decoding/encoding, while preserving Unity/VPM interpretation.

**Maintenance payoff:** Medium to high
**Migration risk:** Medium
**Confidence:** High

Two independent TAR parsers disagree about USTAR prefix handling and do not fully cover PAX records, long names, checksums, malformed entries, or truncation.

Evidence:

- [`packages/shared/src/backstagePackageMedia.ts`](../packages/shared/src/backstagePackageMedia.ts#L356)
- [`packages/shared/src/backstageReleaseMaterialization.ts`](../packages/shared/src/backstageReleaseMaterialization.ts#L149)

Additionally, [`publish-coupling-runtime-package.ts`](../ops/publish-coupling-runtime-package.ts#L174) invokes PowerShell ZIP APIs even though `fflate` is already installed.

Recommended direction:

- use `tar` for server-only archive parsing;
- if cross-runtime parsing is required, validate a cross-runtime package against the existing fixture corpus before adoption;
- use existing `fflate` for deterministic ZIP creation;
- keep custom Unity asset mapping, safe-path enforcement, manifest interpretation, and materialization rules.

### 12. Process supervision and command execution

**Recommendation:** Use installed `concurrently` for long-running development processes and an Execa-backed wrapper for finite commands.

**Maintenance payoff:** Medium to high
**Migration risk:** Medium
**Confidence:** High for `concurrently`, medium for Execa under Bun

[`ops/dev-supervisor.ts`](../ops/dev-supervisor.ts#L1) is nearly 600 lines and reimplements:

- named/colorized process prefixes;
- output multiplexing;
- shell selection;
- Windows process-tree traversal and termination;
- lifecycle and signal handling;
- kill-on-exit behavior.

The repository already installs and uses `concurrently` elsewhere.

Repeated finite process handling also appears in:

- [`ops/convex-real/manage.ts`](../ops/convex-real/manage.ts#L34)
- [`ops/convex-real/harness.ts`](../ops/convex-real/harness.ts#L68)
- [`ops/run-web-worker-infisical.ts`](../ops/run-web-worker-infisical.ts#L150)
- [`ops/cloudflare-web-config.ts`](../ops/cloudflare-web-config.ts#L214)
- the three remediation scripts;
- both coupling-runtime publishers.

Keep a thin project adapter for preflight, optional-service policy, redacted errors, and environment allowlisting. Delegate generic process behavior to the packages.

### 13. Discord REST and rate limiting

**Recommendation:** Use `@discordjs/rest` and `discord-api-types` directly for raw Discord requests.

**Maintenance payoff:** High
**Migration risk:** Medium
**Confidence:** High

The bot already depends on `discord.js`, but role sync implements a custom route limiter whose `updateFromHeaders` method is never called. It cannot learn Discord buckets.

Evidence:

- [`apps/bot/src/services/roleSync.ts`](../apps/bot/src/services/roleSync.ts#L300)
- [`apps/bot/src/services/roleSync.ts`](../apps/bot/src/services/roleSync.ts#L1915)

Raw Discord fetches also appear across API, bot, and Convex route code. The Discord REST package already owns global and per-route bucket handling.

Reference: [Discord REST package](https://discord.js.org/docs/packages/rest/main)

Keep durable outbox scheduling, partial-failure behavior, role-sync domain decisions, and audit state custom.

### 14. Bot TTL maps

**Recommendation:** Use `@isaacs/ttlcache` for ephemeral interaction state that is intentionally process-local.

**Maintenance payoff:** Medium
**Migration risk:** Low
**Confidence:** High

Manual timestamp maps and repeated expiry cleanup exist in autosetup, downloads, product, stats, and verification commands.

Evidence:

- [`apps/bot/src/commands/autosetup.ts`](../apps/bot/src/commands/autosetup.ts#L92)
- [`apps/bot/src/commands/downloads.ts`](../apps/bot/src/commands/downloads.ts#L43)
- [`apps/bot/src/commands/product.ts`](../apps/bot/src/commands/product.ts#L106)
- [`apps/bot/src/commands/stats.ts`](../apps/bot/src/commands/stats.ts#L27)
- [`apps/bot/src/commands/verify.ts`](../apps/bot/src/commands/verify.ts#L72)

Create one typed `ExpiringInteractionStore<T>` with TTL and capacity limits. This is only appropriate for disposable UI state. Anything that must survive restart or multiple bot instances belongs in Convex.

## Existing Frontend APIs That Should Be Used More Consistently

These opportunities mostly require consuming packages already present rather than adding new dependencies.

### TanStack Query option factories

Cache keys, options, invalidation targets, and polling intervals are repeated across dashboard routes and prefetch code.

Evidence:

- [`apps/web/src/lib/dashboardPrefetch.ts`](../apps/web/src/lib/dashboardPrefetch.ts#L20)
- [`apps/web/src/hooks/useCreatorCertificateWorkspace.ts`](../apps/web/src/hooks/useCreatorCertificateWorkspace.ts#L21)
- [`apps/web/src/routes/setup/jinxxy.lazy.tsx`](../apps/web/src/routes/setup/jinxxy.lazy.tsx#L190)
- [`apps/web/src/routes/setup/payhip.lazy.tsx`](../apps/web/src/routes/setup/payhip.lazy.tsx#L190)

Use feature-level `queryOptions()` factories for `useQuery`, prefetch, and invalidation. Use `refetchInterval` for network polling, with explicit enabled and stop conditions.

Reference: [TanStack Query options](https://tanstack.com/query/latest/docs/framework/react/reference/queryOptions)

### Better Auth reactive session hook

[`usePublicAuth.ts`](../apps/web/src/hooks/usePublicAuth.ts#L5) wraps `getSession()` in TanStack Query and duplicates sign-in/sign-out behavior. Use `authClient.useSession()` and one shared auth-actions hook. Keep `useConvexAuth()` where protected Convex queries need it.

Reference: [Better Auth client hooks](https://better-auth.com/docs/concepts/client)

### Lucide and Tailwind Variants

The web app declares `lucide-react`, `tailwind-merge`, and `tailwind-variants`, but still maintains many ordinary UI SVGs and hand-built class joins.

Use Lucide for standard interface glyphs and keep provider logos, brands, and custom illustrations. Create one shared `cn` export and use `tv` for component variant maps such as buttons and status chips.

Evidence:

- [`apps/web/src/components/ui/YucpButton.tsx`](../apps/web/src/components/ui/YucpButton.tsx#L19)
- [`apps/web/src/components/ui/StatusChip.tsx`](../apps/web/src/components/ui/StatusChip.tsx#L14)
- [`apps/web/src/routes/_authenticated/account.lazy.tsx`](../apps/web/src/routes/_authenticated/account.lazy.tsx#L22)

## Functions and Modules to Coalesce Internally

Not every duplication justifies a new package. The following logic should have one internal owner.

| Repeated concern                       | Evidence                                                                                                                                                             | Recommended owner                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Role-rule selection                    | Exact copies in [`apps/bot/src/services/roleSync.ts`](../apps/bot/src/services/roleSync.ts#L273) and [`convex/roleSyncActions.ts`](../convex/roleSyncActions.ts#L81) | `packages/policy` pure functions                    |
| Convex function-reference descriptions | Copies in API, bot, and Convex test helpers                                                                                                                          | Shared RPC/Convex utility with runtime-safe exports |
| Actor argument attachment              | `mergeActorArg` and `shouldAttachActor` repeated in bot, tests, and ops harness                                                                                      | Shared actor-request utility                        |
| HTTP timeout wrappers                  | `fetchWithTimeout` repeated in API routes, API libraries, bot, and provider clients                                                                                  | Provider transport or one server HTTP policy module |
| Buyer-link intent failure              | `markIntentFailed` repeated in Gumroad, itch.io, and Patreon buyer-link routes                                                                                       | Generic provider buyer-link orchestration           |
| Verification return URL safety         | Exact `getSafeReturnTo` copies in success and error routes                                                                                                           | Shared verification navigation helper               |
| Verification session storage           | Similar sessionStorage codecs in access and get-in-unity routes                                                                                                      | Schema-backed ephemeral store                       |
| Result page shells                     | Install and verification success/error layouts and animation CSS                                                                                                     | Shared `ResultPage`/`VerificationResultShell`       |
| Environment normalization              | `normalizeOptional`, `trimOptional`, and `getRequired` repeated across apps and ops                                                                                  | Shared environment schema helpers                   |
| Bounded body reading                   | Request, webhook, and response readers differ in safety and semantics                                                                                                | One bounded byte-stream primitive                   |
| TAR parsing                            | Two independent implementations                                                                                                                                      | Archive module backed by maintained parser          |
| Crypto envelope mechanics              | API, Convex, VRChat, and verification implementations                                                                                                                | `packages/shared/src/crypto` with purpose registry  |
| Convex environment synchronization     | `sync-convex-env` copied into `infisical-convex-run`                                                                                                                 | One environment-sync service                        |
| Coupling-runtime publishing            | Two publishers duplicate versioning, args, upload, activation, and cleanup                                                                                           | Descriptor-driven artifact publisher                |
| Process output capture                 | Exact `readProcessOutput` variants in remediation scripts                                                                                                            | One redacting ops process wrapper                   |
| Query retry policy                     | `noRetryOn4xx` repeated in web query consumers                                                                                                                       | Shared query policy                                 |
| Formatting helpers                     | Multiple date, relative-time, byte-size, error, hydration, and clipboard helpers                                                                                     | Small native web utility modules                    |

## Provider Architecture Reinvention

Some repetition exists because provider behavior is implemented outside provider systems rather than because a package is missing.

### Generic routes contain provider-specific semantics

[`apps/api/src/routes/providerPlatform.ts`](../apps/api/src/routes/providerPlatform.ts#L341) embeds Lemon Squeezy-specific catalog, credential, reconciliation, verification, and webhook behavior.

[`packages/shared/src/productParsers.ts`](../packages/shared/src/productParsers.ts#L15) branches on individual providers. The bot repeats provider branching in product and verification commands.

These should become provider capabilities such as:

```text
parseProductInput
connectCredential
createWebhook
syncCatalog
verifyPurchase
describeBuyerLink
renderInteractionCapabilities
```

Generic HTTP, RPC, bot, and UI orchestration should call capabilities without branching on provider IDs.

### Legacy adapter forces fake capabilities

[`packages/providers/src/legacyAdapter.ts`](../packages/providers/src/legacyAdapter.ts#L1) requires providers to implement purchase methods even when unsupported. Gumroad and Payhip satisfy this with empty or null implementations.

The newer capability contracts already model optional behavior correctly:

- [`packages/providers/src/contracts.ts`](../packages/providers/src/contracts.ts#L44)
- [`packages/providers/src/contracts.ts`](../packages/providers/src/contracts.ts#L93)
- [`packages/providers/src/contracts.ts`](../packages/providers/src/contracts.ts#L179)

Retire the legacy adapter after verifying its consumers. Providers should expose only capabilities they actually support.

### Provider setup pages repeat a framework

Jinxxy, Payhip, Lemon Squeezy, Discord, and itch.io setup flows repeat:

- setup-session bootstrap;
- URL and tenant parsing;
- wizard state and height measurement;
- polling;
- copy feedback;
- result/error shells;
- provider display metadata.

Extract:

```text
SetupSessionBootstrap
SetupWizardShell
useSetupPolling
useCopyFeedback
provider public descriptor
```

Provider-specific steps and API behavior must remain inside provider systems. Do not introduce XState until the extracted framework demonstrates that guarded transitions cannot be modeled cleanly with the current React/TanStack stack.

## Dead or Inert Infrastructure

Deletion is a larger maintenance win than replacing unused code with a package.

### Strong deletion candidates

- [`packages/providers/src/discord/oauth.ts`](../packages/providers/src/discord/oauth.ts#L52) is a complete OAuth implementation with no production constructor call found. Its consumers appear limited to tests and a barrel export.
- [`packages/shared/src/logging/audit.ts`](../packages/shared/src/logging/audit.ts#L1) appears to be consumed only by tests and re-exports. Convex uses separate audit paths.
- [`packages/shared/src/logging/correlation.ts`](../packages/shared/src/logging/correlation.ts#L25) has no production setup for its correlation storage, so logger correlation fields are inert.
- The bot's custom Discord rate limiter cannot learn buckets because `updateFromHeaders` has no caller.

These areas represent roughly 900 lines before counting the bot limiter. Confirm there are no unpublished package consumers before deletion.

## Dependency Governance

### Add Knip

Use [Knip](https://knip.dev/explanations/how-knip-works) first as a non-blocking report. Configure:

- TanStack generated route trees;
- generated Bebop files;
- dynamic provider entry points;
- ops scripts;
- test-only exports;
- configuration-loaded modules.

After false positives are resolved, gate:

- unused dependencies;
- unlisted dependencies;
- unused exports;
- unreachable files.

### Ownership problems found

- `@infisical/sdk` is declared in root, API, and bot, while the source import belongs to shared.
- Bebop is declared in multiple workspaces, while generated private RPC code is the actual consumer.
- root Tempo dependencies have no root consumer, while API imports Tempo without the corresponding direct ownership.
- API imports `fflate` and `tar` without direct declarations.
- shared imports `fflate` in production but does not declare it.
- Bun workspaces declare both `@types/bun` and `bun-types`; Bun's current TypeScript setup only requires `@types/bun`.

### Zero-import frontend candidates

A source/config/test scan found no imports for:

- `@gravity-ui/icons`;
- `@number-flow/react`;
- `embla-carousel`;
- `embla-carousel-react`;
- `motion`, while `framer-motion` is used;
- `react-resizable-panels`;
- `recharts`;
- `react-aria-components`.

Do not remove these solely from the textual scan. Confirm through Knip, build, and test because generated or configuration-based use may not appear as a normal import.

## Package Recommendations to Defer

### Pino

The custom logging stack could eventually use Pino for levels, child loggers, JSON output, serializers, and path redaction. However, logging shape and credential redaction are operational security contracts. First delete the unused audit/correlation systems and connect the existing logger to active OpenTelemetry trace/span IDs. Reassess Pino afterward.

### XState

Provider setup flows resemble state machines, but adopting XState before extracting shared bootstrap and shell behavior would combine architectural refactoring with a framework migration. Extract the common setup framework first.

### Casbin or Oso

The policy engine contains YUCP domain rules rather than generic access-control plumbing. An external policy engine would add a language and runtime boundary without clearly removing maintenance. Keep it custom and use Zod only for input validation.

### Lodash or date-fns

Small helpers such as `isRecord`, byte formatting, hydration state, relative time, and optional-string normalization do not justify broad utility dependencies. Coalesce them or use `Intl`, native JavaScript, and schemas.

## Code That Should Remain Custom

The following areas encode product behavior and should not be outsourced wholesale:

- provider capability contracts and registry lifecycle;
- provider response-to-domain mappings;
- identity ownership and subject resolution;
- entitlement and verification state machines;
- connection expiry and degradation transitions;
- audit-event semantics;
- credential purpose strings and access policy;
- analytics spans and trace propagation;
- persisted outbox and Workpool completion projections;
- Unity/VPM artifact interpretation and safe-path rules;
- public webhook event projections and subscription state;
- SSRF destination policy and network egress controls;
- package-certificate canonical field ordering;
- traced frontend and server API clients;
- Three.js product visuals;
- thin YUCP design-system wrappers.

External packages should own protocol mechanics. YUCP should own domain meaning.

## Recommended Delivery Plan

### Phase 0: Correctness and baseline

- repair outbound webhook retry selection;
- fix Lemon Squeezy license request encoding, preferably through the official SDK;
- remove production fake/no-op provider context;
- harden webhook delivery SSRF controls;
- remove executable subprocess-output parsing;
- repair the Polar/Zod dependency-resolution failure;
- update the vulnerable Better Auth OAuth provider dependency.

### Phase 1: Low-risk deletion and existing dependencies

- add Knip in report-only mode;
- delete confirmed dead OAuth/audit/correlation code;
- repair workspace dependency ownership;
- replace custom toast and modal behavior with HeroUI;
- unify rate limiting on the existing service;
- use Lucide and Tailwind Variants consistently;
- use Better Auth `useSession` and TanStack Query option factories;
- replace PowerShell ZIP creation with existing `fflate`.

### Phase 2: Provider and protocol packages

- migrate Lemon Squeezy to its official SDK;
- pilot the installed VRChat SDK;
- introduce the provider Ky transport;
- migrate OAuth mechanics to `oauth4webapi`;
- migrate raw Discord requests to the Discord REST stack;
- replace manual TUS uploads;
- replace CSV, SemVer, cookie, and archive parsers.

### Phase 3: Internal architecture

- move provider-specific routing into capability hooks;
- retire the legacy provider adapter;
- extract provider setup framework components;
- move role selection into `packages/policy`;
- extract application services used by HTTP and Tempo RPC;
- consolidate ops publishers and process execution.

### Phase 4: API framework

- introduce `createApiApp(dependencies)`;
- move route families incrementally to Hono and schemas;
- generate OpenAPI from route definitions;
- remove `createServer` route duplication;
- generate or infer web client contracts from the same API schemas.

### Phase 5: Cryptographic formats

- introduce direct `jose` ownership;
- establish claim and purpose registries;
- add golden compatibility fixtures;
- add versioned dual-read support;
- migrate one token/envelope format at a time;
- remove old readers only after all persisted values or tokens have expired or migrated.

## Adjacent Correctness and Security Findings

These findings were discovered while looking for reinvention and should be tracked independently.

### Outbound webhook retry loop is incomplete

`listPending` returns only `pending` deliveries, while retryable failures are changed to `failed`. No path returns them to `pending`, so `nextRetryAt` is never consumed.

Evidence:

- [`convex/webhookDeliveries.ts`](../convex/webhookDeliveries.ts#L12)
- [`convex/webhookDeliveries.ts`](../convex/webhookDeliveries.ts#L86)
- [`convex/webhookDeliveryWorker.ts`](../convex/webhookDeliveryWorker.ts#L50)
- [`convex/webhookDeliveryCron.ts`](../convex/webhookDeliveryCron.ts#L1)

Use a second named Workpool and retain `webhook_deliveries` as its audit/public projection.

### Production provider context contains stubs

[`convex/providers/shared.ts`](../convex/providers/shared.ts#L19) defines a no-op logger, fake runtime client methods that throw, and a fabricated context with empty secret/client values. Replace the universal context with capability-specific ports.

### Webhook SSRF protection is incomplete

Registration validates literal hostname syntax, but delivery does not enforce DNS/private-address or redirect-target policy.

Evidence:

- [`apps/api/src/routes/publicV2/webhooks.ts`](../apps/api/src/routes/publicV2/webhooks.ts#L18)
- [`convex/webhookDeliveryWorker.ts`](../convex/webhookDeliveryWorker.ts#L157)

### Remediation output parser executes code

[`ops/backstage-deliverable-remediation.ts`](../ops/backstage-deliverable-remediation.ts#L117) falls back from `JSON.parse` to `Function(...)`. Replace it with strict parsing.

## Verification Baseline

The audit did not intentionally modify source code. Required local checks were run against the audited snapshot:

| Check                                | Result                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun audit`                          | Failed with one moderate vulnerability in `@better-auth/oauth-provider@1.6.23`: [GHSA-p2fr-6hmx-4528](https://github.com/advisories/GHSA-p2fr-6hmx-4528) |
| `bun run lint`                       | Passed                                                                                                                                                   |
| `bun run typecheck`                  | Passed                                                                                                                                                   |
| `bun run test:external-integrations` | Passed                                                                                                                                                   |
| Ops tests                            | Passed                                                                                                                                                   |
| Fast CI package suites               | Passed                                                                                                                                                   |
| Boundary-mock ratchet                | Passed                                                                                                                                                   |
| Convex tests                         | 368 passed, 3 failed because `@polar-sh/sdk` could not resolve `zod/v4-mini`                                                                             |
| API integration tests                | 216 passed, 7 todo, 0 failed                                                                                                                             |

## Scope Limitation

This report is based on the local `main` checkout as of 2026-07-14. At audit time it was 43 commits behind `origin/main`. GitHub was not accessed or modified. Pre-existing `.gitignore` and `.idea/` workspace changes were not part of the audit.
