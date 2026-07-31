# The Go transfer-helper moved

The `github.com/yucp/transfer-helper` module — the transfer helper, the package broker, the TUF
command line tools and every Go test that covers them — now lives in the **ca-coupling** repo:

    https://github.com/Yeusepe/ca-coupling  →  transfer-helper/

It moved so the whole Go project is tracked in one place, beside the rest of the native code
(`yucp_coupling`, the coupling service, the coupling runtime), instead of being the single native
module carved out into this TypeScript repo. Its CI moved with it, to
`.github/workflows/native-transfer-helper.yml` in that repo.

## What still points here

Local development and release tooling in this repo builds that module from your ca-coupling
checkout. It is expected to sit beside this repo:

    E:\GitDevelopment\Development\
      CreatorAssistant\      ← this repo
      ca-coupling\           ← the Go module, under transfer-helper/

If yours is somewhere else, set `YUCP_TRANSFER_HELPER_ROOT` to the module directory. Everything
resolves the path through `ops/transferHelperRoot.ts`.

## The one contract that spans both repos

`ops/storage-core/fixtures/package-contracts-v2.json` holds the COSE/CBOR golden vectors. This
repo generates them; the Go module verifies the same bytes from a vendored copy at
`internal/packagecontract/testdata/package-contracts-v2.json`.

The two copies must stay byte-identical. `ops/storage-core/packageContractsV2.test.ts` fails when
they drift, but only on a machine that has both repos checked out — so after regenerating the
vectors here, copy them over before you trust a green run.
