# Backstage ingest sidecar

This Bun service handles resumable Backstage package ingest and publish-time deliverable materialization. It stages tus uploads on disk, runs heavy work in BullMQ, and stores both raw sources and published deliverables in content-addressed Lore.

For the end-to-end architecture, see [Backstage Lore delivery](../../docs/backstage-lore-delivery.md).

## Jobs

The dedicated `backstage-ingest` BullMQ queue carries two job types:

- `ingest-upload`: validates the staged source, derives its source kind and managed paths, stores the raw source in Lore, and returns a signed upload result.
- `materialize`: builds and stores the publishable deliverable in Lore, then returns a signed materialize result. A `.unitypackage` becomes a small importer shim built from managed paths without another raw-source download. A `.zip` is retrieved from Lore and normalized into a repacked deliverable.

The worker retries failed jobs up to three times with exponential backoff. Worker concurrency applies across both job types.

## HTTP endpoints

| Endpoint | Purpose |
| --- | --- |
| `/files/*` | tus resumable upload creation, transfer, resume, and completion. A completed upload enqueues `ingest-upload`. |
| `POST /materialize` | Verifies an API-signed materialize token, enqueues `materialize`, and returns `jobId` plus a signed `pollToken`. |
| `GET /jobs/:id` | Returns `processing`, `completed`, or `failed` for an authorized upload or materialize job. |
| `GET /health` | Returns `{ "ok": true }` when the HTTP process is running. |

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BACKSTAGE_INGEST_SECRET` | Yes | None | Hex signing secret shared with the API. It must contain at least 64 hex characters, or 32 bytes. |
| `REDIS_URL` | Yes | None | ioredis connection string for the dedicated BullMQ Redis-compatible store. |
| `BACKSTAGE_INGEST_ALLOWED_ORIGINS` | No | None | Comma-separated browser origins allowed to upload and poll. When unset, cross-origin requests are rejected. |
| `BACKSTAGE_INGEST_CONCURRENCY` | No | `1` | Maximum concurrent jobs across upload ingest and materialize work. |
| `BACKSTAGE_INGEST_QUEUE_PREFIX` | No | `{backstage-ingest}` | BullMQ key prefix. The braces form the Redis/Dragonfly hashtag. |
| `BACKSTAGE_INGEST_TUS_DIR` | No | `/data/tus` | Persistent directory for staged tus uploads. |
| `BACKSTAGE_INGEST_UPLOAD_TTL_MS` | No | `86400000` | Time before an abandoned tus upload is eligible for sweeping, in milliseconds. |
| `LORE_API_BASE_URL` | Yes | None | Lore API origin used to store and retrieve package bytes. |
| `LORE_REPO_NAMESPACE_SALT` | Yes | None | Private salt used to derive deterministic per-creator Lore repository IDs. |
| `LORE_ACCESS_CLIENT_ID` | Yes | None | Cloudflare Access service-token client ID for Lore. |
| `LORE_ACCESS_CLIENT_SECRET` | Yes | None | Cloudflare Access service-token client secret for Lore. |
| `LORE_TIMEOUT_MS` | No | `1800000` | Lore request timeout for sidecar jobs, in milliseconds. |
| `PORT` | No | `8080` | HTTP listening port. |

## Local development

Install the repository dependencies, start a Redis-compatible queue, provide the required environment variables above, and run the service:

```bash
bun install
docker run --rm --name backstage-ingest-redis -p 6379:6379 redis:7-alpine
```

In another shell:

```bash
bun run --filter @yucp/backstage-ingest start
```

Set `REDIS_URL=redis://localhost:6379` for that local Redis container. A local Dragonfly instance can be used instead.

## Production queue

Use a dedicated Dragonfly instance launched with:

```text
--cluster_mode=emulated --lock_on_hashtags
```

The queue store must be non-evicting, internal-only, and isolated from the application state store. Keep the default hashtagged prefix or configure another prefix that remains a Redis hashtag.

## Known limitations

- Publish currently polls materialize work synchronously with a 120-second deadline. Retrieving and repacking a multi-GB `.zip` can exceed that budget and needs the planned asynchronous publish handoff.
- The browser upload path streams through `tus-js-client`, but the ops publisher still buffers the full source before upload. Ops and CI publishing need a file-stream upload source for multi-GB packages.
