# Backstage Lore Delivery

Backstage package releases use Lore for durable, content-addressed source storage and delivery.

Each creator is assigned a deterministic `repositoryId` derived from the creator identity and the private `LORE_REPO_NAMESPACE_SALT`. Source and deliverable records store a `LoreBackstageArtifactReference` containing that repository ID, the content-addressed Lore `address`, the SHA-256 digest, byte size, upload timestamp, and creator tenant ID. The API rejects source references that do not belong to the authenticated creator's repository.

## Ingest and publish

The API worker proxies package ingest so Lore credentials and repository ownership remain server-controlled:

1. The client hashes the source file and sends its raw bytes to `POST /api/packages/{packageId}/backstage/upload` with `sha256`, `deliveryName`, and `sourceContentType` query parameters.
2. The API verifies the declared digest, derives the creator's repository ID, writes the bytes to Lore, and returns the `loreSource` reference.
3. The publish request sends that `loreSource` to the Backstage releases endpoint. The API verifies ownership and digest, materializes the installable package, writes the result to the same Lore repository, and persists the resulting Lore delivery reference.

Lore addresses are content-addressed, so references identify immutable bytes. `zipSha256` keeps its existing meaning: it is the SHA-256 digest of the final installable ZIP and remains part of the published release contract.

## Entitled delivery

Buyer download requests first resolve entitlement through the existing Backstage access model. After authorization, the API client mints a short-lived presigned Lore delivery URL using `LORE_PRESIGN_HMAC_KEY` and redirects the buyer to that URL. Token minting happens locally in the API, while Lore serves the immutable bytes from the creator's repository at the recorded address.

`LORE_PRESIGN_DEFAULT_TTL_SECONDS` controls the default URL lifetime, and `LORE_TIMEOUT_MS` bounds authenticated repository calls. Cloudflare Access service-token credentials protect API-to-Lore ingest and read operations without exposing those credentials to uploaders or buyers.
