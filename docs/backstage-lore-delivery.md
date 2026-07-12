# Backstage Lore Delivery

Backstage package releases use Lore for durable, content-addressed source storage and delivery.

Each creator is assigned a deterministic `repositoryId` derived from the creator identity and the private `LORE_REPO_NAMESPACE_SALT`. Raw source and deliverable references contain that repository ID, the content-addressed Lore address, SHA-256 digest, byte size, upload timestamp, and creator tenant ID.

## Ingest and publish

Large package bytes do not pass through the Cloudflare Worker. Backstage artifacts can be 2 to 3 GB, so ingest uses the resumable TUS sidecar in `services/backstage-ingest`:

1. The browser hashes the source and requests `POST /api/packages/{packageId}/backstage/upload-authorization` with the version, delivery name, content type, SHA-256 digest, byte size, and optional materialization metadata.
2. The Worker derives the creator's `repositoryId` and returns a sidecar TUS endpoint plus a signed, short-lived upload token.
3. `tus-js-client` uploads directly to the sidecar. The sidecar verifies the token, resumably receives the source, verifies its size and digest, PUTs the raw source to Lore, materializes the installable artifact, and PUTs that deliverable to the same creator repository.
4. The sidecar returns a signed ingest-result bundle containing the raw and deliverable Lore references and verified artifact metadata.
5. The browser sends that bundle to `POST /api/packages/{packageId}/backstage/releases`. The Worker verifies its signature, expiry, creator, package, version, and repository ownership before persisting the release.

The Worker handles only authorization and signed result verification, avoiding Worker request-body and execution limits while keeping Lore credentials and repository ownership server-controlled. Lore addresses identify immutable bytes, and `zipSha256` remains the SHA-256 digest of the final installable ZIP.

## Entitled delivery

Buyer download requests first resolve entitlement through the existing Backstage access model. After authorization, the API client mints a short-lived presigned Lore delivery URL using `LORE_PRESIGN_HMAC_KEY` and redirects the buyer to that URL. Token minting happens locally in the API, while Lore serves the immutable bytes from the creator's repository at the recorded address.

`LORE_PRESIGN_DEFAULT_TTL_SECONDS` controls the default URL lifetime, and `LORE_TIMEOUT_MS` bounds authenticated repository calls. Cloudflare Access service-token credentials protect sidecar-to-Lore ingest and API-to-Lore reads without exposing those credentials to uploaders or buyers.
