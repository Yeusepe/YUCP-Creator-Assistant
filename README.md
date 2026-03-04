![YUCP Creator Assistant](https://github.com/user-attachments/assets/5a8e13f1-aca0-4c7d-b3e0-c0d4cc328b69)

# YUCP Creator Assistant

**YUCP Creator Assistant** gives creators who sell on Gumroad, Jinxxy, or other storefronts a simple way to gate Discord access (or other benefits) for paying customers. Customers sign in once with Gumroad, Discord, or a single license verification for Gumroad or Jinxxy; the system then verifies all past and future purchases automatically. No repeated license entry. Discord-based verification can also confirm that a user is already verified in another server, so you can reuse that trust for avatar edits, distribution, or cross-server perks.

**What problem it solves**

- Creators sell products (courses, assets, access) on storefronts like Gumroad or Jinxxy.
- They run a Discord server and want **only buyers** to get certain roles (e.g. “Customer”, “Pro”, or product-specific roles).
- Doing this by hand does not scale; building custom webhooks and role logic per store is repetitive and error-prone.

**What this system does**

1. **Connects stores to Discord**: A creator links their Gumroad (or Jinxxy, or manual licenses) to their Discord server via a Discord bot and a small API.
2. **Receives purchase events**: When someone buys, the store sends a webhook to this API. The system records the purchase and links it to a “product” that you define.
3. **Maps products to Discord roles**: You configure which product (or product ID) gives which Discord role. One product can grant one role; you can have many product–role mappings.
4. **Verifies customers and assigns roles**: Customers use a verification flow (e.g. “Link your Gumroad” or “I bought product X”). The system checks their purchase against your rules, then grants or denies the corresponding Discord role. A background sync keeps roles in line with current entitlements (including revocations/refunds if you support that).
5. **Supports multiple creators**: The backend is multi-tenant: many Discord guilds (creators) can use the same deployment, each with their own products, role mappings, and policies.

**In short:** buy on Gumroad (or another supported store) → verify in Discord → get the right role. The bot, API, Convex backend, and policy engine handle webhooks, entitlements, and role assignment so creators don’t have to build this themselves.

## Summary

This repository contains the implementation of that platform: a **Discord bot** for setup and user commands (`/creator`), an **API** that handles Better Auth, webhook ingestion from Gumroad/Jinxxy, and connect/onboarding flows, **provider adapters** for those marketplaces (and manual licenses), a **Convex backend** for persistent state and server-side logic, and a **policy engine** that decides whether a user gets a role and what to do on deny (e.g. remediation steps).

Use this repo as a reference for architecture, integration patterns, and implementation details, not as a base for your own commercial or monetized product.

## Feature highlights

- **Discord bot**: Slash commands under `/creator` for onboarding, product–role mapping, verification, and analytics.
- **API service**: Better Auth, bot installation flows, verification callbacks, webhook ingestion, and connect/onboarding routes.
- **Provider adapters**: Gumroad, Jinxxy, Discord, and manual license management (token storage, webhooks, purchase verification).
- **Convex backend**: Persistent state, tenant and guild links, webhook ingestion, provider connection storage.
- **Role sync**: Timed service that keeps Discord roles in sync with verification state.
- **Policy engine**: Evaluates entitlement requests and returns deny decisions with remediation instructions.

## Architecture overview

| Component | Location | Notes |
|-----------|----------|--------|
| **Bot** | `apps/bot` | Entry: `apps/bot/src/index.ts`. Slash commands: `apps/bot/src/commands/index.ts`. RoleSyncService for verified users and role assignment. |
| **API** | `apps/api` | Entry: `apps/api/src/index.ts`. Install, webhooks, connect, Better Auth. |
| **Providers** | `packages/providers` | Adapters: Gumroad, Jinxxy, Discord (placeholder), manual. |
| **Policy** | `packages/policy` | Engine: `packages/policy/src/engine.ts`. Allow/deny, remediation, auto-verification and revocation timing. |
| **Secrets** | `ops/infisical` | Secret layout and rotation; see `ops/infisical/README.md`. |

**Tech stack:** Node / discord.js (bot), Bun HTTP server (API), Convex (data and server-side functions), Better Auth, TypeScript.

## Prerequisites

- Node (bot and packages), Bun (API)
- Convex deployment and API secret
- Infisical or equivalent for environment variables
- Discord application (bot token, OAuth client credentials)
- Gumroad / Jinxxy credentials if using those providers

## Quick start (reference)

1. Export secrets from Infisical or populate `.env.local` (see `ops/infisical/README.md`).
2. Install and build: `bun install` then `bun run build`.
3. Run API: `bun run dev --cwd apps/api`.
4. Run bot: `node ./apps/bot/dist/index.js` (after building).
5. Invite the bot via the URL logged on startup or the Discord Developer Portal.

## Project layout

```
apps/          bot (Discord), api (Bun HTTP API)
packages/      providers, policy, shared
convex/        schema and backend functions
ops/           infisical (secret docs and templates)
```

## Environment variables (reference)

| Variable | Used by | Purpose |
|----------|---------|---------|
| `DISCORD_BOT_TOKEN` | bot | Bot connection |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | api, bot | OAuth and installation |
| `CONVEX_URL`, `CONVEX_API_SECRET` | bot, api | Convex deployment and server API |
| `BETTER_AUTH_SECRET` | api | Better Auth session encryption |
| `GUMROAD_CLIENT_ID`, `GUMROAD_CLIENT_SECRET` | api | Gumroad OAuth and connect |
| `JINXXY_API_KEY` | api | Jinxxy integration |
| `INFISICAL_URL` | all | Infisical endpoint (optional) |

Do not commit real values; use env files or a secret store (all env files are gitignored).

## Discord `/creator` commands (reference)

| Group | Subcommand | Notes |
|-------|------------|--------|
| setup | start | Onboarding wizard |
| product | add, list, remove | Product–role mapping; sources: cross_server, discord_role, gumroad, jinxxy |
| stats | overview, verified, products, user | Stats and verification counts |
| (root) | verify-spawn | Spawn verify button (admin) |
| discord-role-verification | enable, disable, status | Cross-server role verification |
| analytics | link, summary | Dashboard and metrics |
| suspicious | mark, list, clear | Suspicious account handling |
| (root) | link, status, help | User linking and help |

Full options and catalog: `apps/bot/src/commands/index.ts`.

## Development and testing

- Lint: `bun run lint`. Typecheck: `bun run typecheck`. Tests: `bun run test` (or `bun run test:ci`).
- Full dev stack (Convex + API + bot + optional tunnel): `bun run dev` or `bun run dev:infisical`.
- Convex: `npx convex dev` / `npx convex deploy`. Unit tests live alongside implementations.

## Security (reference)

- Never commit secrets; use Infisical or gitignored env files.
- Webhook handlers validate payloads and signatures (e.g. Jinxxy HMAC). Gumroad webhooks are deduplicated.
- Protect `BETTER_AUTH_SECRET` and Convex API secrets.

---

## License and use

This repository is provided **for reference and educational use only**. The author intends to monetize this project. You may **not** use this code, or any work derived from it, for:

- Commercial purposes  
- Monetization or resale  
- Offering a competing product or service based on this code  

Permitted use is limited to reading, learning, and reference. Any other use requires explicit permission from the author.

See the **LICENSE** file in the repository root for full terms.
