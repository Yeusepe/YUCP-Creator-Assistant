# Backstage Lore Delivery

Backstage package releases use Lore for durable, content-addressed source storage and delivery.

Each creator is assigned a deterministic `repositoryId` derived from the creator identity and the private `LORE_REPO_NAMESPACE_SALT`. Raw source and deliverable references contain that repository ID, the content-addressed Lore address, SHA-256 digest, byte size, upload timestamp, and creator tenant ID.

## Ingest and publish

Large package bytes do not pass through the Cloudflare Worker. Backstage artifacts can be 2 to 3 GB, so ingest uses the resumable TUS sidecar in `services/backstage-ingest`:

1. The browser hashes the source and requests `POST /api/packages/{packageId}/backstage/upload-authorization` with the version, delivery name, content type, SHA-256 digest, byte size, and optional materialization metadata.
2. The Worker derives the creator's `repositoryId` and returns a sidecar TUS endpoint plus a signed, short-lived upload token.
3. `tus-js-client` uploads directly to the sidecar. The sidecar resumably stages the source file.
4. The TUS `onUploadFinish` hook validates the upload token, size, and digest, then enqueues a BullMQ job and returns `{ ok: true, jobId }`.
5. A BullMQ worker reads the staged file, PUTs the raw source to Lore, materializes the installable artifact, PUTs that deliverable to the same creator repository, and signs an ingest-result bundle containing both Lore references and the verified artifact metadata.
6. The client polls `GET /jobs/{jobId}` on the sidecar with the upload token until the job reports `completed` and returns the signed result bundle. The browser and ops publisher derive this URL by replacing `/files/` in the completed TUS upload URL with `/jobs/`.
7. The client sends the signed bundle to `POST /api/packages/{packageId}/backstage/releases`. The Worker verifies its signature, expiry, creator, package, version, and repository ownership before persisting the release.

The Worker handles only authorization and signed result verification, avoiding Worker request-body and execution limits while keeping Lore credentials and repository ownership server-controlled. Lore addresses identify immutable bytes, and `zipSha256` remains the SHA-256 digest of the final installable ZIP.

Lore ingest uses `PUT /v1/repository/{repositoryId}/content`. Run `bun run verify:lore:real` for a live round-trip check covering the real PUT, a client-minted presigned URL, and byte-exact retrieval against a running loreserver.

## Known limitations / follow-ups

- The ops publisher still buffers the complete source before its TUS upload, so 2 to 3 GB packages can exhaust operator or CI host memory even though the browser path streams; upgrade it to use a file-stream upload source. Multi-GB `.zip` publish-materialize work can also exceed the synchronous Worker budget and needs an asynchronous publish handoff.

## Sidecar configuration

Configure the ingest sidecar with:

- `REDIS_URL`: connection string for the dedicated BullMQ Redis-compatible store, for example `redis://<your-queue-host>:6379`.
- `BACKSTAGE_INGEST_SECRET`: signing secret shared with the API authorization and result-verification flow.
- `LORE_API_BASE_URL`, `LORE_REPO_NAMESPACE_SALT`, `LORE_ACCESS_CLIENT_ID`, and `LORE_ACCESS_CLIENT_SECRET`: Lore endpoint, repository derivation salt, and service credentials. `LORE_TIMEOUT_MS` optionally overrides the Lore request timeout.
- `BACKSTAGE_INGEST_ALLOWED_ORIGINS`: comma-separated browser origins allowed to upload and poll jobs.
- `BACKSTAGE_INGEST_CONCURRENCY`: maximum simultaneous materialization jobs. The default is `1`.
- `BACKSTAGE_INGEST_QUEUE_PREFIX`: BullMQ key prefix. The default is `{backstage-ingest}`.

### Redis and Dragonfly

BullMQ requires a Redis-compatible store that does not evict queue keys. Use a dedicated Dragonfly instance launched with `--cluster_mode=emulated --lock_on_hashtags`. Do not share the application's state-store Dragonfly instance with the ingest queue.

`BACKSTAGE_INGEST_QUEUE_PREFIX` must be a Redis hashtag such as `{backstage-ingest}`. The braces ensure every BullMQ key shares one slot and one lock when Dragonfly runs with `--lock_on_hashtags`.

### Memory ceiling

Materialization currently has a per-job peak memory cost of approximately twice the package size. Total peak materialization memory is bounded by `BACKSTAGE_INGEST_CONCURRENCY`, so provision at least approximately twice the maximum package size multiplied by the configured concurrency. Streaming materialization is the future upgrade for reducing this ceiling.

### Durability and retries

The staged TUS file is the durable input to the queue worker. BullMQ retries failed processing up to three attempts with exponential backoff. Re-processing is idempotent because Lore storage is content-addressed, so repeated PUTs of the same bytes resolve to the same immutable content.

## Entitled delivery

Buyer download requests first resolve entitlement through the existing Backstage access model. After authorization, the API client mints a short-lived presigned Lore delivery URL using `LORE_PRESIGN_HMAC_KEY` and redirects the buyer to that URL. Token minting happens locally in the API, while Lore serves the immutable bytes from the creator's repository at the recorded address.

`LORE_PRESIGN_DEFAULT_TTL_SECONDS` controls the default URL lifetime, and `LORE_TIMEOUT_MS` bounds authenticated repository calls. Cloudflare Access service-token credentials protect sidecar-to-Lore ingest and API-to-Lore reads without exposing those credentials to uploaders or buyers.
