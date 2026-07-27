# Infisical Secret Management

This repo uses [Infisical](https://infisical.com) as the source of truth for local development, Convex env sync, and Cloudflare Worker secret sync.

## Environments

| Environment | Purpose |
|-------------|---------|
| `dev` | Local development and feature branches |
| `preview` | Preview deployments when a target uses preview secrets |
| `prod` | Production workloads |

## Current access model

- API and bot startup fetch secrets by key name from the configured Infisical project. The repo no longer relies on per-service `infisical run --path=/api` or `/bot` examples.
- `.env.infisical` is the local bootstrap file for Infisical access and optional local overrides. It is what `dev:infisical`, `dev:api:infisical`, `dev:bot:infisical`, `dev:web:infisical`, `sync:convex:env`, and `infisical:convex` read first.
- Cloudflare Worker sync can optionally scope exports with `INFISICAL_WEB_SECRETS_PATH`, but that is for Worker secret sync only.

## Secret inventory by runtime surface

### API runtime

- Core startup secrets:
  - `CONVEX_URL`
  - `CONVEX_SITE_URL`
  - `CONVEX_API_SECRET`
  - `SITE_URL` or one of its legacy fallbacks (`FRONTEND_URL`, `BETTER_AUTH_URL`)
  - `BETTER_AUTH_SECRET`
  - `ENCRYPTION_SECRET`
- Production-only guards:
  - `INTERNAL_SERVICE_AUTH_SECRET`
  - `VRCHAT_PENDING_STATE_SECRET`
  - `YUCP_COUPLING_SERVICE_BASE_URL`
  - `YUCP_COUPLING_SERVICE_SHARED_SECRET` or legacy `COUPLING_SERVICE_SECRET`
- Feature and provider secrets used when those surfaces are enabled:
  - `DISCORD_CLIENT_ID`
  - `DISCORD_CLIENT_SECRET`
  - `DISCORD_BOT_TOKEN`
  - `GUMROAD_ACCESS_TOKEN`
  - `GUMROAD_CLIENT_ID`
  - `GUMROAD_CLIENT_SECRET`
  - `ITCHIO_CLIENT_ID`
  - `PATREON_CLIENT_ID`
  - `PATREON_CLIENT_SECRET`
  - `JINXXY_API_BASE_URL`
  - `JINXXY_API_KEY`
  - `JINXXY_SECRET_KEY`
  - `RESEND_API_KEY`
  - `EMAIL_FROM`
  - `POLAR_ACCESS_TOKEN`
  - `POLAR_WEBHOOK_SECRET`
  - `POLAR_SERVER`
- Shared optional security and observability vars:
  - `ERROR_REFERENCE_SECRET`
  - `PUBLIC_API_KEY_PEPPER`
  - `PUBLIC_OAUTH_TRUSTED_CLIENTS_JSON`
  - `INTERNAL_RPC_SHARED_SECRET`
  - `HYPERDX_API_KEY`
  - `HYPERDX_APP_URL`
  - `HYPERDX_OTLP_HTTP_URL`
  - `HYPERDX_OTLP_GRPC_URL`
  - `OTEL_EXPORTER_OTLP_ENDPOINT`
  - `OTEL_EXPORTER_OTLP_HEADERS`
  - `OTEL_EXPORTER_OTLP_PROTOCOL`

### Bot runtime

`apps/bot/src/lib/env.ts` currently validates this exact required startup contract:

- `DISCORD_BOT_TOKEN`
- `CONVEX_URL`
- `CONVEX_API_SECRET`
- `INTERNAL_SERVICE_AUTH_SECRET`

Common supporting vars:

- `INTERNAL_RPC_SHARED_SECRET` for explicit internal RPC auth. In non-production local dev, the shared helper falls back to the built-in local dev secret when this is unset.
- `API_BASE_URL` and `API_INTERNAL_URL`
- `DISCORD_GUILD_ID`
- `HEARTBEAT_URL` and `HEARTBEAT_INTERVAL_MINUTES`
- `BETTER_AUTH_SECRET` and `ERROR_REFERENCE_SECRET` for support-code handling
- `HYPERDX_*`, `OTEL_EXPORTER_OTLP_*`, `POSTHOG_API_KEY`, `POSTHOG_HOST`

### Phase 4 storage and delivery runtimes

The Phase 4 inventory uses one declaration per key. Recursive runtime fetches preserve the key
names consumed by apps/api, ingest-tus, the scheduler, and the delivery Worker.

| Infisical path | Names | Consumers |
|---|---|---|
| `/storage/ingest/shared/` | `UPLOAD_HMAC_KEY`, `INGEST_TUS_URL` | apps/api and ingest-tus |
| `/storage/ingest/runtime/` | `INGEST_UPLOAD_DIR`, `INGEST_MAX_BYTES`, `INGEST_ALLOWED_ORIGIN` (optional) | ingest-tus only |
| `/storage/catalog/` | `CATALOG_DATABASE_URL` | ingest-tus and scheduler |
| `/storage/common/configuration/` | `COMMON_S3_ENDPOINT`, `COMMON_S3_REGION`, `COMMON_S3_BUCKET`, `COMMON_CHUNK_PREFIX`, `COMMON_S3_REQUEST_TIMEOUT_MS`, `STORAGE_FORMAT_VERSION` | ingest-tus, scheduler, and common delivery Worker |
| `/storage/common/write/` | `COMMON_S3_ACCESS_KEY_ID`, `COMMON_S3_SECRET_ACCESS_KEY` | ingest-tus and scheduler |
| `/storage/common/read/` | `COMMON_S3_READONLY_ACCESS_KEY_ID`, `COMMON_S3_READONLY_SECRET_ACCESS_KEY` | common delivery Worker |
| `/storage/metadata/configuration/` | `METADATA_S3_ENDPOINT`, `METADATA_S3_REGION`, `METADATA_S3_BUCKET`, `METADATA_INDEX_PREFIX`, `METADATA_S3_REQUEST_TIMEOUT_MS` | API, scheduler, and metadata delivery runtimes |
| `/storage/metadata/write/` | `METADATA_S3_ACCESS_KEY_ID`, `METADATA_S3_SECRET_ACCESS_KEY` | API and scheduler |
| `/storage/metadata/read/` | `METADATA_S3_READONLY_ACCESS_KEY_ID`, `METADATA_S3_READONLY_SECRET_ACCESS_KEY` | metadata delivery runtimes |
| `/storage/protected/configuration/` | `PROTECTED_S3_ENDPOINT`, `PROTECTED_S3_REGION`, `PROTECTED_S3_BUCKET`, `PROTECTED_CHUNK_PREFIX`, `PROTECTED_S3_REQUEST_TIMEOUT_MS` | ingest-tus, scheduler, and materialization source Worker |
| `/storage/protected/write/` | `PROTECTED_S3_ACCESS_KEY_ID`, `PROTECTED_S3_SECRET_ACCESS_KEY` | ingest-tus and scheduler |
| `/storage/protected/read/` | `PROTECTED_S3_READONLY_ACCESS_KEY_ID`, `PROTECTED_S3_READONLY_SECRET_ACCESS_KEY` | materialization source Worker |
| `/storage/quarantine/configuration/` | `QUARANTINE_S3_ENDPOINT`, `QUARANTINE_S3_REGION`, `QUARANTINE_S3_BUCKET`, `QUARANTINE_S3_REQUEST_TIMEOUT_MS` | ingest-tus |
| `/storage/quarantine/write/` | `QUARANTINE_S3_ACCESS_KEY_ID`, `QUARANTINE_S3_SECRET_ACCESS_KEY` | ingest-tus |
| `/storage/renditions/configuration/` | `RENDITION_S3_ENDPOINT`, `RENDITION_S3_REGION`, `RENDITION_S3_BUCKET`, `RENDITION_S3_REQUEST_TIMEOUT_MS` | Linux materializer and rendition Worker |
| `/storage/renditions/write/` | `RENDITION_S3_ACCESS_KEY_ID`, `RENDITION_S3_SECRET_ACCESS_KEY` | Linux materializer |
| `/storage/renditions/read/` | `RENDITION_S3_READONLY_ACCESS_KEY_ID`, `RENDITION_S3_READONLY_SECRET_ACCESS_KEY` | rendition Worker |
| `/storage/materialization/capacity/` | `MATERIALIZATION_CHUNK_CACHE_MAX_BYTES`, `MATERIALIZATION_EMERGENCY_DISK_FLOOR_BYTES` | Linux materializer |
| `/storage/delivery/shared/` | `DELIVERY_HMAC_KEY` | apps/api, VPM, and curated delivery Worker sync |
| `/storage/delivery/api/` | `DELIVERY_BASE_URL`, `VPM_BASE_URL`, `VPM_PUBLIC_INDEX_URL` | apps/api and VPM only |
| `/infra/convex/` | `CONVEX_URL`, `CONVEX_API_SECRET` | apps/api, Convex, bot, and scheduler |
| `/infra/signing/service-auth/` | `INTERNAL_SERVICE_AUTH_SECRET` | apps/api, Convex, bot, and scheduler |

`UPLOAD_HMAC_KEY` must remain identical between the apps/api mint side and ingest-tus verification
side. `DELIVERY_HMAC_KEY` must remain identical between apps/api, VPM signing, and the delivery
Worker. Each is declared once in Infisical so consumers cannot receive independently maintained
copies.

### Convex auth and backend env sync

`bun run sync:convex:env` and `bun run infisical:convex` sync these keys into Convex:

```text
BETTER_AUTH_SECRET
ENCRYPTION_SECRET
INTERNAL_SERVICE_AUTH_SECRET
VRCHAT_PROVIDER_SESSION_SECRET
BETTER_AUTH_URL
API_BASE_URL
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
FRONTEND_URL
SITE_URL
BACKFILL_API_URL
YUCP_ROOT_PRIVATE_KEY
YUCP_KEY_ID
POLAR_ACCESS_TOKEN
POLAR_WEBHOOK_SECRET
POLAR_SERVER
YUCP_BROKER_SHARED_SECRET
YUCP_GRANT_SEAL_KEY
YUCP_COUPLING_HMAC_KEY
YUCP_RELEASE_ENVELOPE_KEY
```

Deployment credentials for the sync itself are separate and stay in the shell or Infisical export:

- `CONVEX_DEPLOY_KEY` or `CONVEX_API_SECRET` for dev sync
- `CONVEX_DEPLOY_KEY_PROD` for prod sync
- `CONVEX_DEPLOYMENT` or `CONVEX_DEPLOYMENT_PROD` when targeting a specific deployment explicitly

### Web worker

The Cloudflare Worker uses Infisical export plus Wrangler sync helpers.

Runtime vars passed through generated Wrangler config:

```text
API_BASE_URL
BUILD_ID
CONVEX_SITE_URL
CONVEX_URL
FRONTEND_URL
HYPERDX_APP_URL
HYPERDX_OTLP_GRPC_URL
HYPERDX_OTLP_HTTP_URL
NODE_ENV
OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_PROTOCOL
SITE_URL
```

Secret bindings synced to Cloudflare:

```text
HYPERDX_API_KEY
INTERNAL_RPC_SHARED_SECRET
OTEL_EXPORTER_OTLP_HEADERS
```

### Delivery Worker

`bun run delivery:worker:secrets:sync --prod` exports from Infisical through the existing Worker
sync machinery, selects only the delivery Worker's required bindings, and bulk-syncs them to
`yucp-delivery-worker`:

```text
COMMON_S3_ENDPOINT
COMMON_S3_REGION
COMMON_S3_BUCKET
COMMON_S3_READONLY_ACCESS_KEY_ID
COMMON_S3_READONLY_SECRET_ACCESS_KEY
COMMON_CHUNK_PREFIX
METADATA_S3_ENDPOINT
METADATA_S3_REGION
METADATA_S3_BUCKET
METADATA_S3_READONLY_ACCESS_KEY_ID
METADATA_S3_READONLY_SECRET_ACCESS_KEY
METADATA_INDEX_PREFIX
PACKAGE_DELIVERY_AUDIENCE
PACKAGE_INSTALL_ISSUER
PACKAGE_INSTALL_SIGNING_KEY_ID
PACKAGE_INSTALL_SIGNING_PUBLIC_KEY
STORAGE_FORMAT_VERSION
```

Write-capable common and metadata credentials are excluded.
The API and VPM consume their own public origins.

### YUCP signing and protected delivery

These keys back certificate issuance, protected materialization grants, broker auth, and runtime artifact envelopes:

- `YUCP_ROOT_PRIVATE_KEY`
- `YUCP_KEY_ID` or `YUCP_ROOT_KEY_ID`
- `YUCP_GRANT_SEAL_KEY`
- `YUCP_RELEASE_ENVELOPE_KEY`
- `YUCP_BROKER_SHARED_SECRET`
- `YUCP_COUPLING_HMAC_KEY`

### Coupling service

- `YUCP_COUPLING_SERVICE_BASE_URL`
- `YUCP_COUPLING_SERVICE_SHARED_SECRET` or legacy `COUPLING_SERVICE_SECRET`

## Local workflows

### Bootstrap `.env.infisical`

Keep the Infisical bootstrap values in `.env.infisical`:

```dotenv
INFISICAL_PROJECT_ID=...
INFISICAL_ENV=dev
INFISICAL_CLIENT_ID=...
INFISICAL_CLIENT_SECRET=...

# Optional
INFISICAL_URL=https://app.infisical.com
INFISICAL_WEB_SECRETS_PATH=/
```

If you already have an `INFISICAL_TOKEN`, you can use that instead of `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET`.

### Preferred local commands

```bash
# Full stack dev with Infisical-backed services
bun run dev:infisical

# Individual services
bun run dev:api:infisical
bun run dev:bot:infisical
bun run dev:web:infisical

# Sync Convex env from Infisical
bun run sync:convex:env
bun run sync:convex:env --prod

# Inject Infisical env into arbitrary Convex commands
bun run infisical:convex -- bun x convex dev --once
bun run infisical:convex --prod -- bun x convex deploy
```

Notes:

- `bun run dev:infisical` loads `.env.infisical`, applies local defaults, runs `bun run sync:convex:env`, then starts the supervisor stack with the Infisical-backed API, bot, web, HyperDX, and coupling-service commands.
- `bun run dev` is the non-Infisical fallback. It uses `process.env` plus `.env.local`.
- Do not follow the old `infisical export > .env.local` flow as the primary repo workflow.

## Deploy and secret-sync primitives

Use the explicit repo scripts instead of the old `deploy.sh` example:

```bash
# API and bot production starts
bun run start:api:infisical
bun run start:bot:infisical

# Phase 4 Node runtimes
bun run ingest:tus:serve
bun run scheduler:serve

# Local preview of the built web app
bun run start:web

# Convex sync and deploy helpers
bun run sync:convex:env --prod
bun run infisical:convex --prod -- bun x convex deploy

# Cloudflare Worker setup and deploy
bun run --filter @yucp/web worker:sync:setup
bun run --filter @yucp/web worker:secrets:sync
bun run --filter @yucp/web worker:deploy
bun run --filter @yucp/web worker:version:upload

# Curated delivery Worker secret binding sync
bun run delivery:worker:secrets:sync --prod
```

What each command does:

- `sync:convex:env` pushes the curated Convex env list from Infisical into the target Convex deployment.
- `infisical:convex` either runs that sync inline or injects Infisical secrets into any command after `--`.
- `worker:sync:setup` creates or updates the Infisical to Cloudflare Worker sync definition.
- `worker:secrets:sync` uploads current Worker secret bindings to Cloudflare.
- `worker:deploy` builds `apps/web` and deploys with Cloudflare-managed bindings.
- `worker:version:upload` uploads a Worker version without replacing this deploy guidance.
- `delivery:worker:secrets:sync` syncs the exact delivery Worker binding allowlist, including the
  same `DELIVERY_HMAC_KEY` declaration consumed by apps/api.

## Secret rotation guidance

### General rules

- Rotate provider client secrets and API keys in the upstream provider first, then update Infisical, then redeploy the affected runtime.
- Rotate Convex-backed secrets by updating Infisical and rerunning the relevant Convex sync command before deployment.
- Rotate Worker secrets by updating Infisical and rerunning `worker:secrets:sync` before or with `worker:deploy`.

### Public webhook signing secrets

There is no repo-wide `WEBHOOK_SIGNING_SECRET` env contract anymore.

- Public V2 webhook subscriptions generate a unique `whsec_...` secret per subscription when the API creates or rotates that subscription.
- The API stores those per-subscription secrets encrypted with `ENCRYPTION_SECRET`.
- To rotate a webhook secret, call `POST /webhooks/:id/rotate-secret`, update the downstream consumer with the newly returned signing secret, then verify delivery with a test event or delivery replay.
- Do not use the Discord Developer Portal for this flow. Discord interaction verification is controlled separately by `DISCORD_PUBLIC_KEY`.

## Decoding verification support codes

There is no checked-in `ops/decode-support-token.ts` wrapper.

Use the shared helper directly after loading `ERROR_REFERENCE_SECRET` or `BETTER_AUTH_SECRET`:

```bash
bun --env-file=.env.infisical --eval "import { decodeVerificationSupportToken } from './packages/shared/src/verificationSupport.ts'; const result = await decodeVerificationSupportToken(process.argv[1]); console.log(JSON.stringify(result, null, 2));" <support-code>
```

For plain `VFY0-...` codes this prints the plain token metadata. For encoded `VFY1-...` codes it also decrypts the embedded payload when the secret is available.

## Security practices

1. Never commit secrets or checked-in `.env` files with live values.
2. Keep Infisical machine identity credentials in `.env.infisical`, not in app-specific docs or ad hoc shell history.
3. Do not log secret values. Log key names or redacted placeholders only.
4. Use the smallest runtime surface possible when syncing secrets to Convex or Cloudflare.
5. Rotate immediately on suspected compromise and document the downstream systems that also need redeploy or resync.
