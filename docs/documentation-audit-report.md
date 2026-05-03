# Documentation Audit Report

Date: 2026-05-02

## Scope

This report consolidates the current documentation problems found across root docs, guide docs, static HTML docs, and ops/internal runbooks.

## Highest-priority updates

These files are the most misleading today because they describe the wrong commands, environment contracts, or contributor workflow:

1. `README.md`
2. `ops\infisical\README.md`
3. `agents.md`
4. `docs\bot-e2e.md`
5. `docs\docs.html`
6. `docs\index.html`
7. `docs\privacypolicy.html`
8. `docs\termsofservice.html`

## Findings by file

### `README.md`

#### 1. Bot command documentation is stale
- **Current doc:** Describes setup, product, downloads, and analytics under Discord `/creator`, and presents the command table as Discord `/creator` commands.
- **Problem:** The bot now exposes two commands, `/creator` and `/creator-admin`. The registered subcommands also differ from the README. The current surface includes `identity`, `dashboard`, `forensics lookup`, `settings disconnect`, and `collab add`. `setup start` is conditional, and `autosetup` is not in the registered builder.
- **Update needed:** Split the command docs between `/creator` and `/creator-admin`, then rewrite the subcommand list to match the live registry.
- **Evidence:** `README.md:27,33,138-156`; `apps\bot\src\commands\index.ts:14-44,47-68,71-218`

#### 2. Provider coverage and architecture summary are outdated
- **Current doc:** Lists providers as Gumroad, Jinxxy, VRChat, Discord `(placeholder)`, and manual. The project layout only shows `apps/api`, `apps/bot`, `packages/providers`, `packages/policy`, and `packages/shared`.
- **Problem:** Provider descriptors now include `discord`, `fourthwall`, `gumroad`, `itchio`, `jinxxy`, `lemonsqueezy`, `manual`, `patreon`, `payhip`, and `vrchat`. Discord is active, not placeholder. The repo also has first-class `apps/web`, `packages/application`, and `packages/private-rpc` workspaces.
- **Update needed:** Refresh the provider list and status, and expand the project layout section to reflect the actual workspace structure.
- **Evidence:** `README.md:45-52,94-101`; `packages\providers\src\descriptors\index.ts:1-28`; `packages\providers\src\descriptors\discord.ts:3-18`; `package.json:5-8`; `apps\web\package.json:2`; `packages\application\package.json:2`; `packages\private-rpc\package.json:2`

#### 3. Quick start instructions no longer match the repo
- **Current doc:** Tells users to start API with `bun run dev --cwd apps/api`, start bot with `node ./apps/bot/dist/index.js`, and treat the web app as an extra step.
- **Problem:** The repo now provides root-level workflows for `dev:infisical`, `dev:api`, `dev:bot`, `dev:web`, and `convex:dev`. The preferred full-stack path is the supervisor flow, and the bot startup is Bun-based.
- **Update needed:** Replace the quick start with the root scripts, especially the Infisical-backed full-stack workflow and per-service dev commands.
- **Evidence:** `README.md:85-92,170-179`; `package.json:57-79`; `apps\api\package.json:6-16`; `apps\bot\package.json:6-15`; `ops\dev-supervisor.ts:46-62`

#### 4. Development validation is incomplete
- **Current doc:** Lists lint, typecheck, tests, and external integrations.
- **Problem:** CI also runs a security audit step before lint.
- **Update needed:** Add `bun audit` to the validation checklist and keep it aligned with CI behavior.
- **Evidence:** `README.md:158-169`; `.github\workflows\ci.yml:23-30`

### `CONTRIBUTING.md`

#### 1. The recommended development flow is stale
- **Current doc:** Recommends `bun run dev`, with `dev:api`, `dev:bot`, and `dev:web` as alternatives.
- **Problem:** The repo now has `dev:infisical` and Infisical-backed API, bot, and web workflows. The plain `dev` flow is now more of a fallback.
- **Update needed:** Recommend `bun run dev:infisical` by default when secrets are configured, and position `bun run dev` as the fallback.
- **Evidence:** `CONTRIBUTING.md:22-34`; `package.json:57-60,68-73`; `README.md:170-172`; `ops\dev-supervisor.ts:46-62`

#### 2. The documented audit command does not exactly match CI
- **Current doc:** Says GitHub CI runs `bun audit`, and the PR checklist repeats `bun audit`.
- **Problem:** The workflow currently runs `bun audit --ignore GHSA-4hxc-9384-m385 --ignore GHSA-2j6q-whv2-gh6w`.
- **Update needed:** Either document the exact CI command or explicitly note that local `bun audit` is stricter than CI at the moment.
- **Evidence:** `CONTRIBUTING.md:36-46,179-185`; `.github\workflows\ci.yml:23-30`

### `SECURITY.md`

No concrete stale or incorrect claims were verified during this audit.

### `docs\api-versioning.md`

#### 1. Version-skew detection wording is stale
- **Current doc:** Says the web dashboard polls `GET /api/version` and users see a `New version available - Reload` notification.
- **Problem:** The poller is mounted at the app root, not only the dashboard. The current toast copy is `Update ready` with `Reload to use the latest version.`
- **Update needed:** Rewrite this section to describe root-level polling and the current reload behavior.
- **Evidence:** `docs\api-versioning.md:64-66`; `apps\web\src\routes\__root.tsx:111`; `apps\web\src\lib\versionPoller.ts:56-60`

#### 2. Error-shape guidance is too broad
- **Current doc:** Says all error responses must keep a `{ error: string }` shape.
- **Problem:** Current routes already use multiple response envelopes, including `{ success: false, error, supportCode? }` and `{ error, details }`.
- **Update needed:** Narrow this rule so it preserves each endpoint family's established envelope instead of imposing one universal shape.
- **Evidence:** `docs\api-versioning.md:56-58`; `apps\api\src\verification\sessionManager.ts:777-823`; `apps\api\src\verification\sessionManager.ts:890-943`; `apps\api\src\routes\collab.ts:883-910`; `apps\api\test\verification.test.ts:157-170`

#### 3. Redirect guidance does not match current practice
- **Current doc:** Says old paths should keep redirecting with `301`.
- **Problem:** Current redirect helpers and route flows use `302`, not `301`.
- **Update needed:** Replace the blanket `301` rule with wording that preserves compatibility while allowing the route-appropriate redirect status.
- **Evidence:** `docs\api-versioning.md:52-55`; `apps\api\src\createServer.ts:116-120`; `apps\api\src\index.ts:110-120`; `apps\api\src\verification\sessionManager.ts:793-867`

#### 4. The guide is missing the current contract workflow
- **Current doc:** Covers API versioning generically.
- **Problem:** The repo now enforces a Bebop/private-RPC contract check in `bun run typecheck`, and `.bop` changes require regeneration.
- **Update needed:** Add a repo-specific note about `contracts:check`, `bun run bebop:regenerate`, and `bun run typecheck`.
- **Evidence:** `docs\api-versioning.md:19-60`; `package.json:31-34`

### `docs\bot-e2e.md`

#### 1. It contains machine-specific absolute paths
- **Current doc:** Links to `/Users/svalp/...` paths.
- **Problem:** Those links are not repo-relative and are wrong for other environments.
- **Update needed:** Replace them with repo-relative paths such as `.env.bot-e2e.example` and `.github/workflows/bot-e2e.yml`.
- **Evidence:** `docs\bot-e2e.md:15`; `docs\bot-e2e.md:88`

#### 2. The documented secret contract is inconsistent with code and CI
- **Current doc:** Lists `BOT_E2E_TENANT_ID` as required and does not mention `BOT_E2E_AUTH_USER_ID`.
- **Problem:** The shared loader requires `BOT_E2E_AUTH_USER_ID` and does not require `BOT_E2E_TENANT_ID`, while the workflow validates `BOT_E2E_TENANT_ID`. The docs, workflow, and code disagree.
- **Update needed:** Reconcile the doc with the actual required secrets and explain any workflow-only requirements.
- **Evidence:** `docs\bot-e2e.md:28-35`; `.env.bot-e2e.example:19-27`; `.github\workflows\bot-e2e.yml:36-43`; `.github\workflows\bot-e2e.yml:59-67`; `packages\shared\test\loadBotE2ESecrets.ts:40-63`; `packages\shared\test\loadBotE2ESecrets.ts:137-149`; `apps\bot\test\e2e\support.ts:471-555`; `apps\bot\test\e2e\support.ts:620-695`

#### 3. The storage-state capture command is broken
- **Current doc:** Tells users to run `bun run capture:discord-storage -- --out ...`.
- **Problem:** That script points at `ops/capture-discord-storage-state.ts`, which is missing.
- **Update needed:** Remove this step, correct the script path, or restore the missing script before documenting it.
- **Evidence:** `docs\bot-e2e.md:64-73`; `package.json:49-52`

#### 4. The "fail loudly" statement is inaccurate for local runs
- **Current doc:** Says missing secrets or fixtures should fail loudly instead of skipping.
- **Problem:** Local `bun run test:bot:e2e` currently skips when secrets are absent because the suite uses `describe.skip`. CI fails fast only because the workflow validates secrets before running.
- **Update needed:** Clarify the difference between local behavior and CI behavior.
- **Evidence:** `docs\bot-e2e.md:103`; `apps\bot\test\e2e\bot.e2e.test.ts:8-11`; `.github\workflows\bot-e2e.yml:24-85`

### `docs\fleet-bugfix-playbook.md`

#### 1. The repo finish-line checklist is stale
- **Current doc:** Treats `bun audit`, `bun run lint`, `bun run typecheck`, and `bun run test:ci` as the standard finish line, with `test:external-integrations` only for some incident work.
- **Problem:** Current CI always runs four jobs, including `bun run test:external-integrations`, on pushes and pull requests to `main` and `develop`.
- **Update needed:** Make `bun run test:external-integrations` part of the standard repo-level validation checklist.
- **Evidence:** `docs\fleet-bugfix-playbook.md:212-225`; `.github\workflows\ci.yml:3-7`; `.github\workflows\ci.yml:48-78`

#### 2. The documented audit command does not match CI
- **Current doc:** Lists `bun audit`.
- **Problem:** CI currently runs `bun audit --ignore GHSA-4hxc-9384-m385 --ignore GHSA-2j6q-whv2-gh6w`.
- **Update needed:** Mirror the current CI command or call out the temporary ignore list explicitly.
- **Evidence:** `docs\fleet-bugfix-playbook.md:214-219`; `.github\workflows\ci.yml:23-30`

### `docs\review-playbook.md`

#### 1. The provider runtime regression matrix is stale
- **Current doc:** Says the secondary home for provider runtime failures is `apps\api\test\providers\<provider>.backfill.test.ts`.
- **Problem:** `ops\production-regression-loop.ts` now uses bot consumer tests as the secondary homes, treats `apps\api\test\providers` as remediation, and adds `apps/api/src/routes/packages.backstage.test.ts` as a provider primary home.
- **Update needed:** Update the matrix to match the current source of truth in `ops\production-regression-loop.ts`.
- **Evidence:** `docs\review-playbook.md:383`; `docs\review-playbook.md:409-417`; `ops\production-regression-loop.ts:31-50`

#### 2. The verification regression matrix is incomplete
- **Current doc:** Lists `completeLicense.test.ts` or `connect.user-verify.behavior.test.ts` as the verification primary homes.
- **Problem:** The current source of truth also includes `convex\verificationIntents.realtest.ts`, `connect.user-verify.manual-license.test.ts`, `connect.user-verify.provider-link.test.ts`, and `hostedIntents.test.ts`.
- **Update needed:** Expand the verification row so it matches `ops\production-regression-loop.ts`.
- **Evidence:** `docs\review-playbook.md:383`; `docs\review-playbook.md:413-417`; `ops\production-regression-loop.ts:71-87`

### `ops\infisical\README.md`

#### 1. The required secret inventory is incomplete
- **Current doc:** Lists mostly Discord, Gumroad, Jinxxy, email, auth, infra, and CDNgine secrets.
- **Problem:** The current runtime also uses `ENCRYPTION_SECRET`, `CONVEX_SITE_URL`, `INTERNAL_SERVICE_AUTH_SECRET`, `CONVEX_API_SECRET` for the bot, YUCP signing keys, grant and envelope keys, and coupling-service secrets.
- **Update needed:** Rewrite the secret inventory by runtime surface: API, bot, Convex/auth, web worker, YUCP signing, coupling, and CDNgine.
- **Evidence:** `ops\infisical\README.md:48-158`; `convex\accountSecurity.ts:161-164`; `convex\auth.ts:47-58`; `apps\api\src\auth\index.ts:240-245`; `apps\bot\src\lib\env.ts:79-90`; `convex\yucpCertificates.ts:328-333`; `convex\lib\protectedMaterializationGrant.ts:46-50`; `convex\lib\couplingRuntimeEnvelope.ts:11-18`; `convex\lib\couplingServiceRuntimeArtifacts.ts:45-49`

#### 2. The bot env mapping is wrong
- **Current doc:** Says the bot needs `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_ID`, `HEARTBEAT_URL`, `CONVEX_URL`, and `INTERNAL_RPC_SHARED_SECRET`.
- **Problem:** The bot runtime currently requires `CONVEX_API_SECRET` and `INTERNAL_SERVICE_AUTH_SECRET`. `INTERNAL_RPC_SHARED_SECRET` is used, but it is not one of the required startup vars documented here.
- **Update needed:** Document the actual required startup env contract for the bot and separate optional/supporting vars from mandatory ones.
- **Evidence:** `ops\infisical\README.md:146-158`; `apps\bot\src\lib\env.ts:77-91`

#### 3. The local Infisical workflow is outdated
- **Current doc:** Tells contributors to log in manually, run `infisical run --env=dev --path=/api -- bun run dev`, and export secrets to `.env.local`.
- **Problem:** The repo now uses `.env.infisical`-based flows and exposes `dev:infisical`, `dev:api:infisical`, `dev:bot:infisical`, `dev:web:infisical`, `sync:convex:env`, and `infisical:convex`.
- **Update needed:** Replace the generic Infisical examples with the repo's actual commands and prerequisites.
- **Evidence:** `ops\infisical\README.md:160-180`; `package.json:57-77`; `ops\dev-supervisor.ts:55-61,465-507`; `packages\shared\src\infisical\fetchSecrets.ts:11-35`; `apps\api\src\lib\env.ts:230-275`; `ops\run-web-worker-infisical.ts:50-80`

#### 4. CI and deploy guidance are stale
- **Current doc:** Refers to `infisical run --env=$ENVIRONMENT --path=/api -- ./deploy.sh`.
- **Problem:** The repo uses explicit scripts for Convex sync and run, web worker deploy/setup, and separate API and bot production starts. There is no documented `deploy.sh` flow backing this section.
- **Update needed:** Replace this section with the current deploy primitives and when each one is used.
- **Evidence:** `ops\infisical\README.md:182-194`; `package.json:61-77`; `apps\web\package.json:11-17`

#### 5. The webhook-signing rotation runbook points at the wrong system
- **Current doc:** Says rotating `WEBHOOK_SIGNING_SECRET` requires updating webhook registrations in the Discord Developer Portal.
- **Problem:** That secret is used by the API's public V2 webhook system, not Discord interaction verification.
- **Update needed:** Rewrite this section around the app's public webhook consumers and verifiers instead of Discord portal setup.
- **Evidence:** `ops\infisical\README.md:254-260`; `apps\api\src\routes\publicV2\webhooks.ts:16,63-79,253,302`

#### 6. The support-code decode instructions reference a missing CLI
- **Current doc:** Tells contributors to run `bun ops/decode-support-token.ts <support-code>`.
- **Problem:** The repo contains shared decode logic but no `ops\decode-support-token.ts` entrypoint.
- **Update needed:** Either document the real supported path or add the missing wrapper before documenting it.
- **Evidence:** `ops\infisical\README.md:277-285`; `packages\shared\src\verificationSupport.ts:108-113,200-255`

### `agents.md`

#### 1. The typecheck section is inaccurate
- **Current doc:** Says `bun run typecheck` includes the Convex realtest compile gate in `convex/tsconfig.json`.
- **Problem:** Root `typecheck` runs `contracts:check`, `tsc -b tsconfig.solution.json`, and app package typechecks. `tsconfig.solution.json` does not include `convex\tsconfig.json`.
- **Update needed:** Describe `bun run typecheck` as Bebop generation plus workspace and app TypeScript checks, and keep Convex coverage under `test:convex`.
- **Evidence:** `agents.md:21-33`; `package.json:31-34`; `tsconfig.solution.json:1-9`

#### 2. The external-integration gate description is incomplete
- **Current doc:** Describes a narrower set of provider, API, router, and consumer tests.
- **Problem:** The actual gate also includes `apps/api/src/verification/hostedIntents.test.ts`, `apps/api/src/lib/subjectIdentity.test.ts`, `apps/api/src/routes/connectUserVerification.readSurface.test.ts`, `apps/api/src/routes/packages.backstage.test.ts`, and `apps/bot/test/commands/autosetup.test.ts`.
- **Update needed:** Define this gate using the concrete regression bundle in `ops\test-external-integrations.ts` instead of a narrower prose summary.
- **Evidence:** `agents.md:35-47`; `ops\test-external-integrations.ts:21-32`; `ops\production-regression-loop.ts:118-171`

#### 3. The `test:ci` description is stale
- **Current doc:** Says `test:ci` covers `@yucp/api`, `@yucp/policy`, `@yucp/providers`, and `@yucp/shared`, plus a Convex compile gate.
- **Problem:** `test:ci` now runs `test:ops` first and `test:fast:ci`, which includes `@yucp/application`. It does not run a Convex compile gate.
- **Update needed:** Rewrite the section so it matches the current `test:ci` script and package coverage.
- **Evidence:** `agents.md:49-64`; `package.json:36-47`; `apps\api\scripts\test-ci.ts:29-43`

### `docs\docs.html`

#### 1. Provider coverage and buyer-flow coverage are stale
- **Current doc:** Setup and introduction sections list Gumroad, itch.io, Jinxxy, Lemon Squeezy, Payhip, and VRChat, and the buyer and product sections treat itch.io as a license-key provider.
- **Problem:** The active provider registry also includes Patreon, and itch.io is currently account-link only rather than license-key verification.
- **Update needed:** Add Patreon to the supported-provider sections and rewrite itch.io guidance to describe OAuth or account-link verification instead of license-key verification.
- **Evidence:** `docs\docs.html:571-577`; `docs\docs.html:621-653`; `docs\docs.html:686-710`; `docs\docs.html:912-930`; `packages\providers\src\descriptors\index.ts:17-28`; `packages\providers\src\descriptors\patreon.ts:3-19`; `packages\providers\src\descriptors\itchio.ts:3-24`; `packages\providers\test\providerMetadataParity.test.ts:32-39`

#### 2. Collaborator documentation is still Jinxxy-only
- **Current doc:** Says collaborator invites are for other Jinxxy creators and require a Jinxxy API key.
- **Problem:** The current bot flow uses a provider selector for collaborator invites and add flows, and the shareable-provider coverage is broader than Jinxxy.
- **Update needed:** Document collaborators as provider-selectable, with the currently supported providers called out where needed.
- **Evidence:** `docs\docs.html:886-891`; `docs\docs.html:960-993`; `apps\bot\src\commands\collab.ts:38-73`; `apps\bot\src\commands\collab.ts:112-145`; `apps\api\src\routes\collab.auth.test.ts:186-199`; `packages\providers\src\descriptors\jinxxy.ts:31-35`; `packages\providers\src\descriptors\itchio.ts:18-23`; `packages\providers\src\descriptors\lemonsqueezy.ts:35-39`; `packages\providers\src\descriptors\payhip.ts:20-24`

#### 3. Cross-server verification is underspecified
- **Current doc:** Describes a Discord Role product as taking one source server ID and one required role ID.
- **Problem:** The current flow supports multiple source role IDs and an `any` or `all` match mode.
- **Update needed:** Rewrite the setup guidance to cover one-or-more source roles and the role-match mode.
- **Evidence:** `docs\docs.html:1009-1014`; `apps\bot\src\commands\product.ts:468-486`; `apps\bot\src\commands\product.ts:1115-1136`

#### 4. The forensics command description no longer matches the feature
- **Current doc:** Says `/creator-admin forensics lookup` returns metadata, linked accounts, and usage patterns.
- **Problem:** The command actually uploads a `.unitypackage` or `.zip` and returns coupling-trace attribution results for creator-owned packages and assets.
- **Update needed:** Describe the archive-upload attribution workflow instead of generic usage analytics.
- **Evidence:** `docs\docs.html:899-905`; `apps\bot\src\commands\forensics.ts:10-32`; `apps\bot\src\commands\forensics.ts:83-205`

#### 5. Analytics and stats claims are overstated
- **Current doc:** Says `/creator-admin stats` shows verified members, active products, roles assigned, and collaborators, and that `/creator-admin analytics` provides inline metrics and a server-filtered PostHog link.
- **Problem:** The stats command returns verified users, mapped products, and 24h, 7d, and 30d counts. The analytics command links to a fixed PostHog URL and does not build a server-specific PostHog link.
- **Update needed:** Narrow the stats and analytics descriptions to the actual summary metrics and current PostHog linking behavior.
- **Evidence:** `docs\docs.html:1076-1103`; `apps\bot\src\commands\stats.ts:72-119`; `apps\bot\src\commands\analytics.ts:14-45`

#### 6. Outgoing webhook docs are stale
- **Current doc:** Lists only four supported events, names the signature header `X-Signature-256`, and says failed deliveries can be replayed from the dashboard and API.
- **Problem:** The current webhook surface has a larger event catalog, sends `X-Yucp-Signature` and `X-Yucp-Delivery`, and exposes CRUD, rotate-secret, delivery listing, and test ping APIs, but not a public replay endpoint.
- **Update needed:** Point to the current event catalog, use the real header names, and stop promising replay from public surfaces unless that exists.
- **Evidence:** `docs\docs.html:1164-1209`; `apps\api\src\routes\publicV2\webhooks.ts:63-152`; `apps\api\src\routes\publicV2\webhooks.ts:285-468`; `convex\webhookDeliveryWorker.ts:168-183`; `convex\webhookDeliveries.ts:1-14`; `convex\webhookDeliveries.ts:82-120`; `convex\outbox_jobs.ts:325-360`

#### 7. The API access section is stale
- **Current doc:** Says Public API v2 has 56 endpoints, API keys live under `Account -> API Keys`, and `Authorization: Bearer ypsk_...` is the auth format.
- **Problem:** API keys now live under the dashboard integrations route. OpenAPI defines `x-api-key` for `ypsk_` keys, while bearer auth is a separate OAuth scheme. The current OpenAPI surface is also larger than 56 operations.
- **Update needed:** Point readers to Dashboard -> Integrations -> API Keys, document `x-api-key` for API keys, and update or remove the hardcoded endpoint count.
- **Evidence:** `docs\docs.html:1219-1239`; `apps\web\src\routes\_authenticated\dashboard\integrations.lazy.tsx:49-52`; `apps\web\src\routes\_authenticated\dashboard\integrations.lazy.tsx:592-618`; `apps\api\src\routes\publicV2\openapi.ts:4-22`; `apps\api\src\routes\publicV2\openapi.ts:23-36`

#### 8. Audit log documentation overpromises the dashboard
- **Current doc:** Says Dashboard -> Audit Logs is available now with filters by event type, user, and date range.
- **Problem:** The dashboard audit-log page is marked `In development`. The public API route exists, but its implemented filters are `type` and `subject_id`, not user and date-range filters.
- **Update needed:** Describe dashboard audit logs as not yet shipped, and point to the current API surface where needed.
- **Evidence:** `docs\docs.html:1253-1274`; `apps\web\src\routes\_authenticated\dashboard\audit-logs.lazy.tsx:3-57`; `apps\api\src\routes\publicV2\audit-log.ts:14-52`; `convex\audit_events.ts:71-112`

### `docs\index.html`

#### 1. Integration marketing copy is stale
- **Current doc:** Says users can connect Gumroad, Jinxxy, Lemon Squeezy, Payhip, VRChat, and Discord, and says connections are OAuth2 and webhook-based with sync on every new purchase or refund.
- **Problem:** The active provider registry also includes itch.io and Patreon. Authentication models differ by provider, and not every provider is webhook or refund driven.
- **Update needed:** Rewrite this section to describe the actual current provider set and avoid implying a single OAuth2-plus-webhooks model for every integration.
- **Evidence:** `docs\index.html:2578-2600`; `packages\providers\src\descriptors\index.ts:17-28`; `packages\providers\src\descriptors\jinxxy.ts:11-24`; `packages\providers\src\descriptors\payhip.ts:13-18`; `packages\providers\src\descriptors\vrchat.ts:11-16`; `packages\providers\src\descriptors\itchio.ts:11-15`; `packages\providers\src\descriptors\patreon.ts:11-18`

#### 2. Manual-license throughput is overstated
- **Current doc:** Says bulk import supports hundreds at once.
- **Problem:** The public API hard-limits manual-license bulk import to 100 licenses per request.
- **Update needed:** Replace the vague throughput claim with either a precise current limit or a more general statement that avoids overstating capacity.
- **Evidence:** `docs\index.html:3002-3006`; `apps\api\src\routes\publicV2\manual-licenses.ts:62-68`

#### 3. VRChat support is overstated
- **Current doc:** Says VRChat support covers avatar and world purchases plus active subscriptions.
- **Problem:** The current provider metadata and product input flow are avatar-listing and account-link focused, not world and subscription coverage.
- **Update needed:** Limit the copy to the currently shipped VRChat avatar ownership and account-link flow unless broader support is actually implemented.
- **Evidence:** `docs\index.html:3048-3058`; `packages\providers\src\descriptors\vrchat.ts:10-23`

#### 4. Cross-server trust is described as automatic inheritance
- **Current doc:** Says users verify once in the main server and sub-servers inherit trust automatically.
- **Problem:** Current behavior is policy-driven per product, using configured source guilds plus one-or-more required source roles with `any` or `all` matching.
- **Update needed:** Replace the automatic inheritance claim with the actual configured source-role proof model.
- **Evidence:** `docs\index.html:3411-3418`; `apps\bot\src\commands\discordRoleVerification.ts:39-74`; `apps\bot\src\commands\product.ts:468-486`; `apps\bot\src\commands\product.ts:1436-1443`

#### 5. The developer API endpoint count is stale
- **Current doc:** Says the platform has a full REST API with 56 endpoints.
- **Problem:** The current public OpenAPI surface is larger than that hardcoded count.
- **Update needed:** Update the number or remove the hardcoded endpoint count entirely.
- **Evidence:** `docs\index.html:3495-3509`; `apps\api\src\routes\publicV2\openapi.ts:4-22`; `apps\api\src\routes\publicV2\index.ts:44-146`

### `docs\privacypolicy.html`

#### 1. The service scope is too narrow
- **Current doc:** Frames the service mostly around websites, setup pages, dashboards, APIs, webhooks, bot, verification, Liened Downloads, collaborator sharing, and Unity runtime.
- **Problem:** The current product also includes account privacy and security, authorized apps, billing, certificates, package and VCC access, and OAuth consent and login surfaces.
- **Update needed:** Broaden the definition of the service to cover the currently shipped account, billing, certificate, and buyer access surfaces.
- **Evidence:** `docs\privacypolicy.html:206-210`; `apps\web\src\routeTree.gen.ts:29-58`; `apps\web\src\routeTree.gen.ts:292-433`; `apps\web\src\routes\_authenticated\account\security.lazy.tsx:48-60`; `apps\web\src\routes\_authenticated\account\authorized-apps.lazy.tsx:153-245`; `apps\web\src\routes\_authenticated\dashboard\billing.lazy.tsx:37-40`; `apps\web\src\routes\access.$catalogProductId.tsx:28-46`

#### 2. Provider coverage is outdated
- **Current doc:** Names only Discord, Gumroad, and Jinxxy in provider data and auth sections.
- **Problem:** The active provider/runtime coverage now also includes itch.io, Lemon Squeezy, Patreon, Payhip, and VRChat.
- **Update needed:** Replace the narrow provider list with the current provider set or use wording that allows the list to evolve safely.
- **Evidence:** `docs\privacypolicy.html:263-267`; `docs\privacypolicy.html:286-287`; `docs\privacypolicy.html:420-421`; `docs\privacypolicy.html:578-579`; `apps\api\src\providers\index.ts:11-18`; `apps\api\src\providers\index.ts:42-50`; `apps\api\src\providers\index.ts:60-67`; `packages\providers\src\descriptors\lemonsqueezy.ts:3-39`; `packages\providers\src\descriptors\payhip.ts:3-33`; `packages\providers\src\descriptors\itchio.ts:3-24`; `packages\providers\src\descriptors\patreon.ts:3-18`; `packages\providers\src\descriptors\vrchat.ts:3-24`

#### 3. The cookie and analytics section is stale
- **Current doc:** Says no analytics cookies are used today and that this would be disclosed in the future.
- **Problem:** The repo already ships opt-in diagnostics, a persisted privacy-preference cookie and local storage record, and HyperDX-powered error, performance, and session-replay diagnostics.
- **Update needed:** Document the current consent-backed diagnostics behavior and name the existing privacy-preference storage and HyperDX integration at a high level.
- **Evidence:** `docs\privacypolicy.html:391-400`; `apps\web\src\lib\privacyPreferences.ts:1-18`; `apps\web\src\lib\privacyPreferences.ts:176-188`; `apps\web\src\components\ui\CookiePreferencesPrompt.tsx:77-90`; `apps\web\src\components\ui\CookiePreferencesPrompt.tsx:112-117`; `apps\web\src\lib\hyperdx.ts:1-9`; `apps\web\src\lib\hyperdx.ts:102-149`; `apps\web\src\routes\legal\privacy-policy.tsx:331-336`

#### 4. The privacy request flow is misleading
- **Current doc:** Tells users to email `contact@yucp.club` for access, deletion, and privacy requests.
- **Problem:** The product now exposes self-serve export and deletion in `/account/privacy`, backed by dedicated API routes. The current privacy UI also points manual help to `privacy@yucp.club`.
- **Update needed:** Document the self-serve account controls and keep the email fallback aligned with the product.
- **Evidence:** `docs\privacypolicy.html:530-537`; `docs\privacypolicy.html:604-607`; `apps\web\src\routes\_authenticated\account\privacy.lazy.tsx:22-43`; `apps\web\src\routes\_authenticated\account\privacy.lazy.tsx:61-99`; `apps\web\src\routes\_authenticated\account\privacy.lazy.tsx:229-245`; `apps\web\src\routes\_authenticated\account\privacy.lazy.tsx:264-271`; `apps\web\src\routes\_authenticated\account\privacy.lazy.tsx:293-298`; `apps\api\src\routes\connectUserAccountRoutes.ts:188-281`; `apps\api\src\routes\connectUserAccountRoutes.ts:290-369`; `apps\api\src\index.ts:1123-1128`

#### 5. Third-party vendor references are stale
- **Current doc:** Names PostHog in the disclaimer and omits Polar in vendor and sharing sections.
- **Problem:** The repo now uses HyperDX for diagnostics and Polar for certificate billing, checkout, and portal flows.
- **Update needed:** Remove obsolete vendor references and mention current monitoring and billing vendors where the policy needs to name them.
- **Evidence:** `docs\privacypolicy.html:227`; `docs\privacypolicy.html:420-428`; `docs\privacypolicy.html:578-579`; `apps\web\src\lib\hyperdx.ts:1-9`; `apps\web\src\lib\hyperdx.ts:114-149`; `apps\web\src\routes\_authenticated\dashboard\billing.lazy.tsx:1-2`; `apps\web\src\routes\_authenticated\dashboard\billing.lazy.tsx:79-105`; `apps\web\src\routes\_authenticated\dashboard\billing.lazy.tsx:171-175`; `apps\api\src\routes\connectCertificateRoutes.ts:10`; `apps\api\src\routes\connectCertificateRoutes.ts:116-131`; `apps\api\src\routes\connectCertificateRoutes.ts:138-179`

### `docs\termsofservice.html`

#### 1. Connected-provider definitions are stale
- **Current doc:** Defines connected providers as Discord, Gumroad, and Jinxxy.
- **Problem:** Current provider coverage also includes Lemon Squeezy, Payhip, Patreon, itch.io, and VRChat.
- **Update needed:** Refresh the provider definition examples or stop freezing the definition to a three-provider list.
- **Evidence:** `docs\termsofservice.html:258-262`; `docs\termsofservice.html:399-427`; `apps\api\src\providers\index.ts:11-18`; `apps\api\src\providers\index.ts:42-50`; `apps\api\src\providers\index.ts:60-67`; `packages\providers\src\descriptors\index.ts:17-28`

#### 2. Command and setup descriptions are outdated
- **Current doc:** Describes `/creator (status, verify, refresh)` and an older `/creator-admin` surface, including `setup ... restart`.
- **Problem:** The current command surface includes `/creator identity`, `/creator docs`, `/creator-admin dashboard`, `forensics lookup`, `settings disconnect`, and `collab add`. There is no `setup restart` subcommand in the live definition.
- **Update needed:** Refresh the command list or avoid enumerating subcommands in legal text.
- **Evidence:** `docs\termsofservice.html:342-343`; `docs\termsofservice.html:453-459`; `apps\bot\src\commands\index.ts:14-44`; `apps\bot\src\commands\index.ts:47-68`; `apps\bot\src\commands\index.ts:92-116`; `apps\bot\src\commands\index.ts:148-161`; `apps\bot\src\commands\index.ts:199-217`

#### 3. The service description omits major current surfaces
- **Current doc:** Focuses on Discord verification, downloads, collaboration, and Unity runtime.
- **Problem:** The current repo also includes account security and recovery, authorized apps, billing, certificates, audit logs, package access, and Unity or VCC delivery routes.
- **Update needed:** Broaden the service definition so it matches the current shipped product surface.
- **Evidence:** `docs\termsofservice.html:212-215`; `docs\termsofservice.html:337-359`; `apps\web\src\routeTree.gen.ts:292-433`; `apps\web\src\routes\_authenticated\account\authorized-apps.lazy.tsx:153-245`; `apps\web\src\routes\_authenticated\account\security.lazy.tsx:48-60`; `apps\web\src\routes\access.$catalogProductId.tsx:28-46`; `apps\web\src\routes\get-in-unity.$creatorRef.$productRef.tsx:14-20`; `apps\web\src\routes\get-in-unity.$creatorRef.$productRef.tsx:60-76`

#### 4. Verification-method examples are incomplete
- **Current doc:** Describes verification mainly as Gumroad OAuth, Jinxxy, Discord-role, and manual-license flows.
- **Problem:** The current repo also supports itch.io linking and creator or provider setup flows for Lemon Squeezy, Payhip, Patreon, and VRChat.
- **Update needed:** Expand the verification examples so they reflect the active provider matrix.
- **Evidence:** `docs\termsofservice.html:453-459`; `apps\api\src\routes\connectUserVerification.ts:236-238`; `apps\api\src\routes\connectUserVerification.ts:261-279`; `apps\web\src\routeTree.gen.ts:21-29`; `apps\web\src\routeTree.gen.ts:104-125`; `apps\web\src\routeTree.gen.ts:208-214`; `apps\web\src\routeTree.gen.ts:407-411`; `packages\providers\src\descriptors\itchio.ts:3-24`; `packages\providers\src\descriptors\lemonsqueezy.ts:3-39`; `packages\providers\src\descriptors\payhip.ts:3-33`; `packages\providers\src\descriptors\patreon.ts:3-18`; `packages\providers\src\descriptors\vrchat.ts:3-24`

#### 5. The fees and billing section is no longer hypothetical
- **Current doc:** Says paid features may exist now or in the future and discusses billing generically.
- **Problem:** The repo already has live Polar-backed checkout, billing portal, plan capabilities, and billing-gated package and VCC access.
- **Update needed:** Rewrite the section to reflect that paid creator certificate and package features already exist.
- **Evidence:** `docs\termsofservice.html:730-747`; `apps\web\src\routes\_authenticated\dashboard\billing.lazy.tsx:1-2`; `apps\web\src\routes\_authenticated\dashboard\billing.lazy.tsx:79-105`; `apps\web\src\routes\_authenticated\dashboard\billing.lazy.tsx:171-175`; `apps\web\src\routes\_authenticated\dashboard\billing.lazy.tsx:303-313`; `apps\api\src\routes\connectCertificateRoutes.ts:116-131`; `apps\api\src\routes\connectCertificateRoutes.ts:138-179`; `apps\api\src\routes\connectCertificateRoutes.ts:182-188`; `apps\web\src\components\dashboard\PackageRegistryAccessGate.tsx:18-23`; `apps\web\src\components\dashboard\PackageRegistryAccessGate.tsx:45-52`

#### 6. Export, deletion, and account-control language is incomplete
- **Current doc:** Says creators may request export by emailing `contact@yucp.club`.
- **Problem:** The current product exposes self-serve user data export, OAuth grant revocation, and account deletion and privacy tooling directly in-product.
- **Update needed:** Distinguish creator offboarding from end-user self-serve controls and document the shipped account-management tools.
- **Evidence:** `docs\termsofservice.html:854-863`; `apps\web\src\routes\_authenticated\account\privacy.lazy.tsx:22-43`; `apps\web\src\routes\_authenticated\account\privacy.lazy.tsx:61-99`; `apps\web\src\routes\_authenticated\account\privacy.lazy.tsx:229-245`; `apps\web\src\routes\_authenticated\account\privacy.lazy.tsx:293-298`; `apps\web\src\routes\_authenticated\account\authorized-apps.lazy.tsx:43-56`; `apps\web\src\routes\_authenticated\account\authorized-apps.lazy.tsx:124-145`; `apps\api\src\routes\connectUserAccountRoutes.ts:133-185`; `apps\api\src\routes\connectUserAccountRoutes.ts:188-281`; `apps\api\src\routes\connectUserAccountRoutes.ts:290-369`

## Summary

The documentation problems cluster into five themes:

1. **Stale commands and startup flows**: root docs and ops docs still describe old dev, test, and deploy commands.
2. **Outdated environment contracts**: bot E2E and Infisical docs no longer match the required secrets or runtime expectations.
3. **Out-of-date architecture descriptions**: README and internal playbooks still describe an older provider and workspace layout.
4. **Playbooks drifted from the code-enforced source of truth**: versioning, review, incident, and CI guidance need to be re-aligned with scripts and regression matrices now in the repo.
5. **Static site and legal pages drifted with the product**: the HTML docs and legal pages still describe older providers, commands, privacy controls, billing assumptions, and API surfaces.
