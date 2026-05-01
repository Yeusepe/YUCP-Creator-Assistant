![YUCP Creator Assistant](https://github.com/user-attachments/assets/592a7c28-0bec-4673-9a43-0656d2a9ca6c)

---
[![status](https://status.yucp.club/badge/_/status)
](https://status.yucp.club/)

**YUCP Creator Assistant** gives creators who sell on Gumroad, Jinxxy, VRChat, or other storefronts a simple way to gate Discord access (or other benefits) for paying customers. Customers sign in once with Gumroad, Discord, or a single license verification for Gumroad or Jinxxy; the system then verifies all past and future purchases automatically. No repeated license entry. Discord-based verification can also confirm that a user is already verified in another server, so you can reuse that trust for avatar edits, distribution, or cross-server perks.

**What problem it solves**

- Creators sell products (courses, assets, access) on storefronts like Gumroad, Jinxxy, or VRChat.
- They run a Discord server and want **only buyers** to get certain roles (e.g. “Customer”, “Pro”, or product-specific roles).
- Doing this by hand does not scale; building custom webhooks and role logic per store is repetitive and error-prone.

**What this system does**

1. **Connects stores to Discord**: A creator links their Gumroad (or Jinxxy, or manual licenses) to their Discord server via a Discord bot and a small API.
2. **Receives purchase events**: When someone buys, the store sends a webhook to this API. The system records the purchase and links it to a “product” that you define.
3. **Maps products to Discord roles**: You configure which product (or product ID) gives which Discord role. One product can grant one role; you can have many product–role mappings.
4. **Verifies customers and assigns roles**: Customers use a verification flow (e.g. “Link your Gumroad” or “I bought product X”). The system checks their purchase against your rules, then grants or denies the corresponding Discord role. A background sync keeps roles in line with current entitlements (including revocations/refunds if you support that).
5. **Supports multiple creators**: The backend is multi-tenant: many Discord guilds (creators) can use the same deployment, each with their own products, role mappings, and policies.

**In short:** buy on Gumroad, Jinxxy, or VRChat (or another supported store) → verify in Discord → get the right role. The bot, API, Convex backend, and policy engine handle webhooks, entitlements, and role assignment so creators don’t have to build this themselves.

## Summary

This repository contains the implementation of that platform: a **Discord bot** for setup and user commands (`/creator`), an **API** that handles Better Auth, webhook ingestion from Gumroad/Jinxxy, and connect/onboarding flows, **provider adapters** for those marketplaces (and manual licenses), a **Convex backend** for persistent state and server-side logic, and a **policy engine** that decides whether a user gets a role and what to do on deny (e.g. remediation steps).

Use this repo as a reference for architecture, integration patterns, and implementation details, not as a base for your own commercial or monetized product.

## Feature highlights

- **Discord bot**: Slash commands under `/creator` for onboarding, product–role mapping, verification, and analytics.
- **API service**: Better Auth, bot installation flows, verification callbacks, webhook ingestion, and connect/onboarding routes.
- **Provider adapters**: Gumroad, Jinxxy, VRChat, Discord, and manual license management (token storage, webhooks, purchase verification).
- **Convex backend**: Persistent state, tenant and guild links, webhook ingestion, provider connection storage.
- **Role sync**: Timed service that keeps Discord roles in sync with verification state.
- **Policy engine**: Evaluates entitlement requests and returns deny decisions with remediation instructions.
- **Liened Downloads**: Role-gated file delivery in Discord. Files posted in configured channels are secured and replaced with a Download button; only members with the required roles can access them. Supports FBX, Unity packages, archives, and Substance files. Includes backfill for existing messages and Autofix for forum posts.
- **Collaborators**: Invite other creators to share their Jinxxy API key for cross-store license verification. Buyers from both stores get verified in your Discord. Invite flow uses Discord OAuth for identity verification; collaborators can link via account (with webhook) or API key.

## Architecture overview


| Component     | Location             | Notes                                                                                                                      |
| ------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Bot**       | `apps/bot`           | Entry: `apps/bot/src/index.ts`. Slash commands: `apps/bot/src/commands/index.ts`. RoleSyncService, LienedDownloadsService. |
| **API**       | `apps/api`           | Entry: `apps/api/src/index.ts`. Install, webhooks, connect, Better Auth, collaborator invite flow (`/api/collab/`*).       |
| **Providers** | `packages/providers` | Adapters: Gumroad, Jinxxy, VRChat, Discord (placeholder), manual.                                                          |
| **Policy**    | `packages/policy`    | Engine: `packages/policy/src/engine.ts`. Allow/deny, remediation, auto-verification and revocation timing.                 |
| **Convex**    | `convex/`            | Schema, entitlements, downloads, collaboratorInvites, webhooks.                                                            |
| **Secrets**   | `ops/infisical`      | Secret layout and rotation; see `ops/infisical/README.md`.                                                                 |


**Tech stack:** Node / discord.js (bot), Bun HTTP server (API), Convex (data and server-side functions), Better Auth, TypeScript.

### Liened Downloads

Role-gated file delivery for Discord. When members post files in configured channels, the system:

1. **Secures** matching attachments (FBX, Unity packages, zip, blend, Substance, etc.) and archives them to a private channel.
2. **Replaces** the original message with a Download button. Only members with the required roles can access the files.
3. **Delivers** files privately via Discord DMs when access is confirmed.

Use `/creator-admin downloads setup` to create a route (source channel, archive channel, roles, file types). Use `/creator-admin downloads manage` to toggle, edit, or remove routes. Backfill secures existing messages; Autofix replaces forum posts that still show original attachments.

### Collaborators

Cross-store license verification. A server owner can invite another creator (who sells on Jinxxy) to share their store’s licenses. Buyers from either store then get verified in the owner’s Discord.

1. Owner runs `/creator-admin collab invite` and shares the generated link.
2. Collaborator opens the link, signs in with Discord OAuth, and submits their Jinxxy API key.
3. The system links the collaborator’s store for verification. Owner can list and remove connections with `/creator-admin collab list`.

Supports **account linking** (with webhook for real-time purchases) or **API key linking** (periodic sync).

## Prerequisites

- Node (bot and packages), Bun (API)
- Convex deployment and API secret
- Infisical for environment variables and secrets
- Discord application (bot token, OAuth client credentials). **Enable "Server Members Intent"** in [Discord Developer Portal](https://discord.com/developers/applications) → Your App → Bot → Privileged Gateway Intents. **Role sync requires**: bot has "Manage Roles" permission and its role is above the verified role in Server Settings → Roles.
- Gumroad / Jinxxy / VRChat credentials if using those providers

## Quick start (reference)

1. Load secrets through Infisical (see `ops/infisical/README.md`). `.env.local` is only a gitignored local bootstrap fallback for non-secret values such as `CDNGINE_DIR`; local runs warn when Infisical is not active, and production API startup refuses to run if Infisical secrets do not load.
2. Install and build: `bun install` then `bun run build`.
3. Run API: `bun run dev --cwd apps/api`.
4. Run bot: `node ./apps/bot/dist/index.js` (after building).
5. Invite the bot via the URL logged on startup or the Discord Developer Portal.
6. For local Worker-based frontend development, run `bun run --filter @yucp/web worker:env:dev` once, then `bun run --filter @yucp/web worker:dev`. If `apps/web/.dev.vars` is absent, `worker:dev` falls back to the repo root `.env.local` and writes `apps/web/.dev.vars` for the local Worker runtime.

## Project layout

```
apps/          bot (Discord), api (Bun HTTP API)
packages/      providers, policy, shared
convex/        schema and backend functions
ops/           infisical (secret docs and templates)
```

## Environment variables (reference)


| Variable                                     | Used by  | Purpose                          |
| -------------------------------------------- | -------- | -------------------------------- |
| `SITE_URL`                                   | api      | Public app/frontend origin       |
| `DISCORD_BOT_TOKEN`                          | bot      | Bot connection                   |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | api, bot | OAuth and installation           |
| `CONVEX_URL`, `CONVEX_API_SECRET`            | bot, api | Convex deployment and server API |
| `CONVEX_SITE_URL`                            | api      | Better Auth host on Convex       |
| `BETTER_AUTH_SECRET`                         | api      | Better Auth session encryption   |
| `GUMROAD_CLIENT_ID`, `GUMROAD_CLIENT_SECRET` | api      | Gumroad OAuth and connect        |
| `JINXXY_API_KEY`                             | api      | Jinxxy integration               |
| `CDNGINE_DIR`                                | dev      | Optional checkout path for `bun run dev` to launch `cdngine` |
| `CDNGINE_API_BASE_URL`, `CDNGINE_PUBLIC_API_BASE_URL` | api, convex | CDNgine API origin for Backstage delivery upload and authorization |
| `CDNGINE_ACCESS_TOKEN`, `CDNGINE_API_TOKEN`  | api, convex | CDNgine bearer token for Backstage delivery upload and authorization |
| `CDNGINE_BACKSTAGE_REQUIRED`                 | api, convex | Legacy compatibility flag; Backstage package artifacts now require CDNgine |
| `CDNGINE_BACKSTAGE_SERVICE_NAMESPACE_ID`     | convex   | CDNgine namespace for published Backstage assets; defaults to `yucp-backstage` |
| `CDNGINE_BACKSTAGE_DELIVERY_SCOPE_ID`        | api, convex | CDNgine delivery scope for Backstage downloads; defaults to `paid-downloads` |
| `CDNGINE_BACKSTAGE_VARIANT`                  | api, convex | CDNgine delivery variant for Backstage packages; defaults to `vpm-package` |
| `YUCP_ALLOW_LEGACY_CONVEX_BACKSTAGE_UPLOADS` | convex      | Emergency/test-only escape hatch for legacy Convex Backstage upload functions; leave unset in production |
| `CDNGINE_BACKSTAGE_TIMEOUT_MS`               | api, convex | Bounds CDNgine publish and authorization calls |
| `INFISICAL_URL`                              | all      | Infisical endpoint (optional)    |


Do not commit real values. Infisical is the source of truth for deploy and production env; gitignored env files are local fallback only and should not be treated as production configuration.

### Auth URL model

- Better Auth runs on Convex at `${CONVEX_SITE_URL}/api/auth`.
- The app/frontend runs on `SITE_URL`.
- Discord social login callback must be `${CONVEX_SITE_URL}/api/auth/callback/discord`.
- OAuth clients that use your provider must register their own `redirect_uri` values on the client side. Those are separate from the Discord callback above.
- `FRONTEND_URL` remains a legacy alias for `SITE_URL`, and `BETTER_AUTH_URL` remains a legacy alias for the auth host. New config should use `SITE_URL` and `CONVEX_SITE_URL`.

## Discord `/creator` commands (reference)


| Group      | Subcommand                    | Notes                                                                                           |
| ---------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| setup      | start                         | Get links to connect Gumroad/Jinxxy and configure (opens in browser)                            |
| autosetup  | -                             | Legacy path behind a feature flag. Use `setup start` to open the setup dashboard instead.        |
| product    | add, list, remove             | Product–role mapping; sources: cross_server, discord_role, gumroad, jinxxy, vrchat              |
| downloads  | setup, manage                 | **Liened Downloads**: liened file routes; setup creates routes, manage toggles/edits/removes |
| collab     | invite, list                  | **Collaborators**: invite creators to share Jinxxy store; list active connections               |
| stats      | -                             | Verification statistics                                                                         |
| (root)     | spawn-verify                  | Spawn verify button (admin)                                                                     |
| settings   | cross-server                  | Cross-server role verification                                                                  |
| analytics  | -                             | Dashboard and metrics                                                                           |
| moderation | mark, list, clear, unverify   | Suspicious account handling; unverify removes product from user                                 |
| (root)     | status, verify, refresh, docs | User verification status, license verification, role refresh, documentation link                 |


Full options and catalog: `apps/bot/src/commands/index.ts`.

## Development and testing

- Playbooks:
  - `docs/review-playbook.md`: multi-pass review, regression placement, and risky-change validation.
  - `docs/fleet-bugfix-playbook.md`: bug-fix workflow, GPT-5.4 fleet decomposition, SQL lane coordination, and combined-branch validation.
- Lint: `bun run lint`. Typecheck: `bun run typecheck`. Tests: `bun run test` (or `bun run test:ci`).
- External integration contract gate: `bun run test:external-integrations`. This is the fast PR-facing slice for provider/runtime/API/consumer hardening. It now explicitly covers the production-incident surfaces in `ops/production-regression-loop.ts`: provider contracts, identity boundaries, verification flows, account surfaces, and backfill paths.
- Production issue -> invariant -> regression loop: when a prod bug lands in any of those surfaces, update `ops/production-regression-loop.ts`, write the invariant it broke, add the primary regression in the listed contract home, add the nearest consumer regression, and run `bun run test:external-integrations`. If bad state may already exist, add the listed remediation or Convex regression too. The loop is enforced by `ops/production-regression-loop.test.ts`, so missing homes or uncovered surfaces fail in `bun run test:ops`.
- Manual live-smoke drift checks stay out of normal CI. Use `bun run smoke:providers -- --provider gumroad --strict` for low-impact read/verify probes, then `bun run smoke:providers:refresh-fixtures -- --provider gumroad --case gumroad-products,gumroad-license-verify` to write sanitized fixture payloads into `packages/providers/test/fixtures/live-smoke/` for review. Current Gumroad coverage targets the post-connect `/v2/user` readback, catalog `/v2/products`, and manual verification `/v2/licenses/verify` boundaries. Provide smoke-only secrets via env (`GUMROAD_SMOKE_ACCESS_TOKEN`, `GUMROAD_SMOKE_LICENSE_PRODUCT_ID`, `GUMROAD_SMOKE_LICENSE_KEY`) and review fixture diffs before feeding them back into deterministic tests.
- Backstage repo smoke stays manual too. Use `bun run smoke:backstage-repo -- --addRepoUrl="vcc://vpm/addRepo?..." --packageDir="C:\\Users\\svalp\\OneDrive\\Documents\\PACKAGES"` to fetch the repo with its embedded headers, probe every package endpoint, and optionally assert that the repo exposes the display-name and version pairs inferred from a configurable local fixture directory. You can also use `--repositoryUrl` plus `--repoToken` instead of an add-repo URL, or set the same values through `YUCP_BACKSTAGE_ADD_REPO_URL`, `YUCP_BACKSTAGE_REPOSITORY_URL`, `YUCP_BACKSTAGE_REPO_TOKEN`, `YUCP_BACKSTAGE_REPO_TOKEN_HEADER`, and `YUCP_BACKSTAGE_PACKAGE_DIR`.
- Backstage CDNgine delivery is production-wired as the package artifact store. Browser uploads hash the selected file in chunks, request a signed CDNgine upload session from the API, send package bytes directly to the returned TUS target, and call the signed completion URL. This supports Unity package files up to 5 GiB without relaying package bytes through the Gumroad API or Convex. Publish records only CDNgine source/delivery coordinates in Convex; the uploaded CDNgine source version is reused as the delivery asset instead of being downloaded and re-uploaded by the API. Buyer download requests still resolve entitlement in Convex, then authorize `POST /v1/assets/{assetId}/versions/{versionId}/deliveries/{deliveryScopeId}/authorize` from the API route and redirect to CDNgine. If CDNgine has the uploaded version in canonical source state but has not materialized a delivery variant yet, the package route authorizes `POST /v1/assets/{assetId}/versions/{versionId}/source/authorize` and still redirects to CDNgine bytes. Existing legacy artifacts that already have Convex storage IDs can still be read during migration, but new Backstage package artifacts require CDNgine configuration and package bytes do not touch Convex storage.
- Live smoke is not a pull request gate. Keep `bun run smoke:providers` for manual drift checks and any separate scheduled/manual automation, while `bun run test:external-integrations` stays deterministic and safe for normal CI.
- Full dev stack (Convex + API + bot + HyperDX + optional tunnel): prefer `bun run dev:infisical`. The non-Infisical `bun run dev` path is a local fallback and logs a warning before using process env plus `.env.local`. In the Infisical path, the web leg now runs through `infisical run --watch` so frontend secret changes restart the local Worker loop with fresh bindings. Optional helpers like the Tailscale tunnel and `cdngine` now log and exit without tearing down the main app processes if they fail after startup begins.
- To have the dev supervisor launch `cdngine`, set `CDNGINE_DIR` in Infisical, `.env.infisical`, `.env.local`, or your shell env to the checkout you want to run, for example `CDNGINE_DIR=C:\\Users\\svalp\\OneDrive\\Documents\\Development\\antiwork\\cdngine`. The default startup mode is `CDNGINE_START_MODE=server`, which starts the local platform and then runs the long-lived CDNgine public runtime server without the demo frontend. When `CDNGINE_DIR` is set and no explicit CDNgine API vars are present, local dev injects `CDNGINE_API_BASE_URL=http://localhost:4000` and a local runtime bearer token for the Gumroad API process. Production must provide `CDNGINE_API_BASE_URL`/`CDNGINE_ACCESS_TOKEN` through Infisical. Both `bun run dev` and `bun run dev:infisical` print whether `cdngine` is enabled and which mode it will use, and if `CDNGINE_DIR` is set to a bad path they fail immediately instead of silently skipping `cdngine` before the supervisor starts.
- Local Cloudflare Worker frontend loop: `bun run --filter @yucp/web worker:env:dev` to write `apps/web/.dev.vars`, then `bun run --filter @yucp/web worker:dev`. For an Infisical-backed local loop, use `bun run dev:web:infisical` so the Worker dev server is wrapped in `infisical run --watch`. When the watched process restarts, `worker:dev` rewrites `apps/web/.dev.vars` from the injected env before starting Vite. Use `bun run --filter @yucp/web worker:preview` for a Wrangler-local deploy-shape check.
- Infisical Cloudflare Workers sync setup: `bun run --env-file=.env.infisical --filter @yucp/web worker:sync:setup -- --connectionId=<cloudflare-connection-id> --projectId=<infisical-project-id> --env=prod --path=/`. The setup script logs in with Infisical Universal Auth, creates or updates the Cloudflare Workers sync for the Worker name in `apps/web/wrangler.jsonc`, and triggers an immediate secret sync.
- Cloudflare deploy flow for `apps/web`: `bun run --filter @yucp/web worker:deploy` builds the web Worker bundle and then deploys it with Wrangler while preserving the Worker bindings already managed in Cloudflare by the Infisical sync. Add `-- --prod` to mark the build as production and `-- --worker-env=<name>` if you use a named Wrangler environment. For non-production Worker Builds branches, use `bun run --filter @yucp/web worker:version:upload` so the same build step runs before `wrangler versions upload`. These deploy paths do not call `infisical export`, do not sync secrets from the repo, and do not require an Infisical CLI login.
- Local HyperDX UI: `http://localhost:8080`. OTLP endpoints: `http://localhost:4318` (HTTP) and `localhost:4317` (gRPC).
- `bun run dev:infisical` now prefers the local ClickStack endpoints that it starts, even if Infisical already contains hosted HyperDX URLs. To actually ingest browser/API/bot telemetry, create a HyperDX ingest key in `http://localhost:8080` under Team Settings -> API Keys and store it as `HYPERDX_API_KEY` in Infisical. The API and bot derive `OTEL_EXPORTER_OTLP_HEADERS=Authorization=<key>` from that value automatically, matching ClickStack's OTEL collector auth model. Set `HYPERDX_DEV_USE_REMOTE=true` only when you intentionally want the dev supervisor to keep using the hosted HyperDX endpoints instead of the local ClickStack collector.
- On Windows, the local ClickStack runner uses Docker **named volumes** by default. This avoids ClickHouse `Permission denied` rename failures that can happen on NTFS or OneDrive-backed bind mounts. Set `HYPERDX_DEV_VOLUME_MODE=bind` only if you explicitly want bind mounts instead.
- If Docker Desktop is not running, the dev stack stays up and logs that HyperDX was skipped.
- Convex: `npx convex dev` / `npx convex deploy`. Unit tests live alongside implementations.

## Security (reference)

- Never commit secrets; use Infisical or gitignored env files.
- Webhook handlers validate payloads and signatures (e.g. Jinxxy HMAC). Gumroad webhooks are deduplicated.
- Protect `BETTER_AUTH_SECRET` and Convex API secrets.
- Third-party credentials (VRChat sessions, Gumroad/Jinxxy API keys) are encrypted at rest with HKDF using provider-specific, domain-separated purpose strings. Credentials are never logged and are decrypted only within the request that needs them.
- Session/credential expiry is handled explicitly: a 401 from an external API marks the connection as `'degraded'` in Convex and surfaces a reconnect prompt to the creator. Silent swallowing is never acceptable.

---

## License and use

This repository is provided **for reference and educational use only**. The author intends to monetize this project. You may **not** use this code, or any work derived from it, for:

- Commercial purposes  
- Monetization or resale  
- Offering a competing product or service based on this code

Permitted use is limited to reading, learning, and reference. Any other use requires explicit permission from the author.

See the **LICENSE** file in the repository root for full terms.
