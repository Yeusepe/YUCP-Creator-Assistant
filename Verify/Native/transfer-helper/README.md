# YUCP transfer helper

The helper downloads its own trusted releases through TUF.

The importer supplies the initial signed root metadata.

The helper rejects expired, rolled-back, oversized, or incorrectly signed metadata.

Verified targets use versioned paths.

The helper never overwrites an existing target.

The helper verifies signed `FileTableShardV2` recipes.

It reconstructs common files from the verified local chunk cache.

Protected source recipes fail before the helper creates a staging tree.

## Toolchain

Use Go 1.26.5.

The TUF client uses `go-tuf` v2.4.2.

API reference: [go-tuf updater](https://pkg.go.dev/github.com/theupdateframework/go-tuf/v2/metadata/updater)

## Build

1. Run `go test ./...`.
2. Run `go vet ./...`.
3. Run `go build ./cmd/yucp-transfer-helper`.

Use this production build command:

```text
go build -trimpath -ldflags="-s -w" -o dist/yucp-transfer-helper.exe ./cmd/yucp-transfer-helper
```

## Update command

Use the `update` command with a pinned root and direct repository URLs.

Remote URLs require HTTPS.

Loopback tests can use HTTP.

```text
yucp-transfer-helper update \
  --root <root-path> \
  --metadata-url <metadata-url> \
  --targets-url <targets-url> \
  --metadata-cache <cache-path> \
  --target <target-name> \
  --destination <versioned-path> \
  --trace-id <trace-id>
```

The command writes one JSON result to standard output.

The result includes the trace identifier, target digest, byte length, cache state, and final path.

## Reconstruct command

Use `reconstruct` with a signed file-table shard and trusted signing key.

The current profile reads uncompressed desync chunks from the local cache.

The helper verifies encoded SHA-256 values and domain-separated logical digests.

It publishes the staging tree only after all files pass verification.

```text
yucp-transfer-helper reconstruct \
  --signed-shard <cose-file-table-shard> \
  --public-key <ed25519-public-key-hex> \
  --key-id <trusted-key-id> \
  --chunk-cache <cache-root> \
  --destination <new-staging-tree> \
  --encoding-profile desync-uncompressed-sha256-v1 \
  --trace-id <trace-id>
```
