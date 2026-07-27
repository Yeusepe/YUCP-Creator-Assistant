# Package storage and delivery progress record

Date: 2026-07-26
Status: active planning record
Plan: [package-storage-delivery-implementation-plan.md](./package-storage-delivery-implementation-plan.md)
Architecture: [package-storage-delivery-architecture.md](./package-storage-delivery-architecture.md)

## 1. Purpose

Use this file as the durable handoff record for the package program.

Keep stable requirements in the implementation plan.

Keep current state, evidence, and blockers in this file.

Update this file at the end of each work session.

## 2. Status values

Use only these values:

| Value       | Meaning                                           |
| ----------- | ------------------------------------------------- |
| NOT STARTED | The task cannot start or has no assigned session. |
| READY       | All known dependencies are complete.              |
| ACTIVE      | One session currently owns the task.              |
| BLOCKED     | A recorded condition prevents useful progress.    |
| DONE        | The task passed its exit gate.                    |

Keep no more than one implementation task active.

Documentation review can run with one implementation task.

## 3. Current checkpoint

| Field                   | Value                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Current phase           | P6                                                                                                |
| Active task             | P6-04                                                                                             |
| Next task               | Complete the native identity broker cutover.                                                      |
| Last completed task     | P0-08                                                                                             |
| Last durable checkpoint | Importer 0.1.35 passes its complete EditMode suite. The native broker cutover remains incomplete. |
| Last update             | 2026-07-26                                                                                        |
| Implementation started  | Yes                                                                                               |

### Current work session

| Field                 | Value                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| Session ID            | P6-04-20260726-01                                                                       |
| Work item ID          | P6-04                                                                                   |
| Owner                 | Codex                                                                                   |
| Start time            | 2026-07-26                                                                              |
| End time              | Active                                                                                  |
| CreatorAssistant HEAD | Record before handoff.                                                                  |
| Transfer-helper HEAD  | Record before handoff.                                                                  |
| Coupling runtime HEAD | `d843b848a814b3d294e90aa378e405d465cd80ab`                                              |
| Unity-components HEAD | Record before handoff.                                                                  |
| Branch or worktree    | `feat/package-storage-vpm-lifecycle` and `feat/server-only-coupling`                    |
| Changed paths         | Upload, editions, VPM, broker, helper, importer, lifecycle tests, and program documents |
| Last command          | Importer EditMode suite                                                                 |
| Last result           | Importer 0.1.35 passed 92 tests.                                                        |
| Blocker               | The current user cannot inspect or control Hyper-V virtual machines.                    |
| Next exact action     | Complete the durable broker exchange and native IPC.                                    |

## 4. Repository state at plan creation

### 4.1 CreatorAssistant

Path: `E:\GitDevelopment\Development\CreatorAssistant`

The worktree already contained unrelated changes.

Observed tracked changes:

- `agents.md`
- `ops/storage-core/canonicalizer.ts`
- `package.json`

Observed untracked storage work:

- `ops/storage-core/desyncCaidx.realtest.ts`
- `ops/storage-core/desyncCorpus.realtest.ts`
- `ops/storage-core/desyncHttpStore.e2e.test.ts`
- `ops/storage-core/desyncPacking.e2e.test.ts`
- `ops/storage-core/desyncPackingTestSupport.ts`

Preserve these changes until ownership is confirmed.

### 4.2 Coupling service

Path: `E:\GitDevelopment\Development\ca-coupling`

This proprietary repository is separate from CreatorAssistant.

The service runs only on Linux servers.

CreatorAssistant owns only the provider-neutral materialization contracts.

The service contains real PNG and FBX materialization paths.

The service returns stable public errors and redacted failure telemetry.

The broker emits and verifies `MaterializationReceiptV2`.

### 4.3 Unity components

Path: `E:\Unity\Components\YUCP-Components`

The worktree already contains unrelated local changes.

The latest immutable importer artifact is version `0.1.35`.

The package supports Unity `2022.3`.

The repository has Unity Test Framework `1.1.33`.

The importer has importer-specific EditMode tests.

Preserve all unrelated Unity changes.

## 5. Baseline implementation facts

| ID    | Fact                                                                      | Evidence owner                                      |
| ----- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| B-001 | The web UI uses `tus-js-client` with 16 MiB chunks.                       | `apps/web/src/lib/upload.ts`                        |
| B-002 | The upload API checks session, ownership, billing, and catalog ownership. | `apps/api/src/routes/creatorUploads.ts`             |
| B-003 | The tus origin supports resumable uploads up to 5 GiB.                    | `ops/ingest-tus`                                    |
| B-004 | Upload completion currently performs synchronous assembly.                | `ops/ingest-tus`                                    |
| B-005 | The current canonicalizer operates on the complete outer archive.         | `ops/storage-core/canonicalizer.ts`                 |
| B-006 | The current CAS uses real `desync` v1.0.3.                                | `ops/storage-core/desyncCas.ts`                     |
| B-007 | The current catalog has outbox, retry, and `SKIP LOCKED` patterns.        | `ops/catalog`                                       |
| B-008 | The current scheduler uses a process-local timer.                         | `ops/scheduler/scheduler.ts`                        |
| B-009 | The delivery Worker uses HMAC URLs and JSON manifests.                    | `services/delivery-worker`                          |
| B-010 | The buyer test proves entitlement and byte-exact multi-chunk delivery.    | `apps/api/test/e2e/buyer-delivery-flow.e2e.test.ts` |
| B-011 | The buyer test does not use the creator upload UI.                        | Buyer test inspection                               |
| B-012 | The buyer test does not prove cross-version physical reuse.               | Buyer test inspection                               |
| B-013 | The TypeScript importer test does not launch Unity.                       | `ops/importer/importVersion.ts`                     |
| B-014 | The Unity installer downloads a complete archive synchronously.           | `AuthorizedVpmPackageInstaller.cs`                  |
| B-015 | The Unity rollback cannot restore overwritten preexisting files.          | `ImportedAssetRollbackService.cs`                   |
| B-016 | The current coupling bridge returns paths without a signed receipt.       | Importer coupling inspection                        |
| B-017 | The current coupling bootstrap is Windows-specific.                       | Importer coupling inspection                        |
| B-018 | VPM release workflows do not run importer tests.                          | Unity workflow inspection                           |
| B-019 | The Unity OAuth path uses PKCE and a loopback callback.                   | `CreatorIdentityOAuthService.cs`                    |
| B-020 | The Unity process owns access and refresh tokens.                         | Same-user extraction proof                          |
| B-021 | DPAPI does not isolate a token from another same-user Unity script.       | Same-user extraction proof                          |
| B-022 | The source project pins Unity `2022.3.22f1`.                              | `ProjectSettings/ProjectVersion.txt`                |

## 6. Work item board

Keep task names, requirements, and dependencies only in the implementation plan.

This board records mutable state only.

| ID     | State       | Owner or session  | Evidence                                                         |
| ------ | ----------- | ----------------- | ---------------------------------------------------------------- |
| P0-00  | DONE        | P0-00-20260722-01 | Documentation, human review, and repository gates pass.          |
| P0-01  | DONE        | P0-01-20260723-01 | Baseline results classify product and environment failures.      |
| P0-02  | DONE        | P0-02-20260723-01 | The profile decision has repeatable corpus evidence.             |
| P0-03  | DONE        | P0-03-20260723-01 | TypeScript and Unity verify the same signed vectors.             |
| P0-04  | BLOCKED     | None              | The configured B2 development bucket is not disposable.          |
| P0-05  | BLOCKED     | P0-05-20260723-01 | The purchased node and invoice evidence are unavailable.         |
| P0-06  | NOT STARTED | None              | Pending                                                          |
| P0-07  | NOT STARTED | None              | Pending                                                          |
| P0-08  | DONE        | P0-08-20260723-01 | Helper, coupling, VPM, platform, and Unity lifecycle gates pass. |
| P0-09  | NOT STARTED | None              | Pending                                                          |
| P0-10  | NOT STARTED | None              | Pending                                                          |
| P1-01  | NOT STARTED | None              | Pending                                                          |
| P1-02  | NOT STARTED | None              | Pending                                                          |
| P1-03  | NOT STARTED | None              | Pending                                                          |
| P1-04  | NOT STARTED | None              | Pending                                                          |
| P1-05  | NOT STARTED | None              | Pending                                                          |
| P2-01  | NOT STARTED | None              | Pending                                                          |
| P2-02  | NOT STARTED | None              | Pending                                                          |
| P2-03  | NOT STARTED | None              | Pending                                                          |
| P2-04  | NOT STARTED | None              | Pending                                                          |
| P3-01  | NOT STARTED | None              | Pending                                                          |
| P3-02  | NOT STARTED | None              | Pending                                                          |
| P3-03  | NOT STARTED | None              | Pending                                                          |
| P3-04  | NOT STARTED | None              | Pending                                                          |
| P4-01  | NOT STARTED | None              | Pending                                                          |
| P4-02  | NOT STARTED | None              | Pending                                                          |
| P4-03  | NOT STARTED | None              | Pending                                                          |
| P4-04  | NOT STARTED | None              | Pending                                                          |
| P4-05  | NOT STARTED | None              | Pending                                                          |
| P4-06  | NOT STARTED | None              | Pending                                                          |
| P5-01  | NOT STARTED | None              | Pending                                                          |
| P5-02  | NOT STARTED | None              | Pending                                                          |
| P5-03  | NOT STARTED | None              | Pending                                                          |
| P5-04  | NOT STARTED | None              | Pending                                                          |
| P6-01  | NOT STARTED | None              | Pending                                                          |
| P6-02  | NOT STARTED | None              | Pending                                                          |
| P6-03  | NOT STARTED | None              | Pending                                                          |
| P6-04  | ACTIVE      | P6-04-20260726-01 | Native broker cutover and credential removal are in progress.    |
| P7-01  | NOT STARTED | None              | Pending                                                          |
| P7-02  | NOT STARTED | None              | Pending                                                          |
| P7-03  | NOT STARTED | None              | Pending                                                          |
| P7-04  | NOT STARTED | None              | Pending                                                          |
| P8-00  | NOT STARTED | None              | Pending                                                          |
| P8-01  | NOT STARTED | None              | Pending                                                          |
| P8-02  | NOT STARTED | None              | Pending                                                          |
| P8-03  | NOT STARTED | None              | Pending                                                          |
| P8-04  | NOT STARTED | None              | Pending                                                          |
| P9-01  | NOT STARTED | None              | Pending                                                          |
| P9-02  | NOT STARTED | None              | Pending                                                          |
| P9-03  | NOT STARTED | None              | Pending                                                          |
| P9-04  | NOT STARTED | None              | Pending                                                          |
| P10-01 | NOT STARTED | None              | Pending                                                          |
| P10-02 | NOT STARTED | None              | Pending                                                          |
| P10-03 | NOT STARTED | None              | Pending                                                          |
| P10-04 | NOT STARTED | None              | Pending                                                          |
| P11-01 | NOT STARTED | None              | Pending                                                          |
| P11-02 | NOT STARTED | None              | Pending                                                          |
| P11-03 | NOT STARTED | None              | Pending                                                          |
| P11-04 | NOT STARTED | None              | Pending                                                          |
| P11-05 | NOT STARTED | None              | Pending                                                          |

## 7. Initial decision record

| ID    | Date       | Decision                                                                 | Status     |
| ----- | ---------- | ------------------------------------------------------------------------ | ---------- |
| D-001 | 2026-07-22 | Separate local lifecycle and real-provider acceptance.                   | ACCEPTED   |
| D-002 | 2026-07-22 | Use PostgreSQL for jobs and backpressure.                                | ACCEPTED   |
| D-003 | 2026-07-22 | Use fixed worker counts at launch.                                       | ACCEPTED   |
| D-004 | 2026-07-22 | Use five storage roles.                                                  | ACCEPTED   |
| D-005 | 2026-07-22 | Use file-oriented `desync` as the comparison baseline.                   | ACCEPTED   |
| D-006 | 2026-07-22 | Use the manual provider plugin in local acceptance.                      | ACCEPTED   |
| D-007 | 2026-07-22 | Use real passkey sign-in with a virtual authenticator.                   | ACCEPTED   |
| D-008 | 2026-07-22 | Use VPM CLI instead of VCC GUI automation.                               | ACCEPTED   |
| D-009 | 2026-07-22 | Use actual Unity EditMode tests for final import proof.                  | ACCEPTED   |
| D-010 | 2026-07-22 | Use a protected PNG as the first coupling fixture.                       | ACCEPTED   |
| D-011 | 2026-07-22 | Do not implement failover at launch.                                     | ACCEPTED   |
| D-012 | 2026-07-22 | Do not add custom chunk packing at launch.                               | ACCEPTED   |
| D-013 | 2026-07-23 | Use the `64:256:1024 KiB` file-oriented chunk profile.                   | ACCEPTED   |
| D-014 | 2026-07-23 | Use deterministic CBOR with purpose-separated COSE Ed25519 signatures.   | ACCEPTED   |
| D-015 | 2026-07-23 | Keep `alias-install-plan-v1` read-only.                                  | SUPERSEDED |
| D-016 | 2026-07-23 | Reject Longtail and retain file-oriented `desync`.                       | ACCEPTED   |
| D-017 | 2026-07-23 | Pin VPM CLI 0.1.28 in the repository tool manifest.                      | ACCEPTED   |
| D-018 | 2026-07-26 | Remove `alias-install-plan-v1` and keep one current alias contract.      | ACCEPTED   |
| D-019 | 2026-07-26 | Use explicit creator bindings as the only cross-store package authority. | ACCEPTED   |
| D-020 | 2026-07-26 | Keep VCC links and alias identity stable for one package.                | ACCEPTED   |
| D-021 | 2026-07-26 | Keep storefront identifiers outside the install authorization boundary.  | ACCEPTED   |
| D-022 | 2026-07-26 | Move OAuth, DPoP, grants, and transfer ownership into the native broker. | ACCEPTED   |
| D-023 | 2026-07-26 | Require a new sign-in and delete every Unity token path.                 | ACCEPTED   |
| D-024 | 2026-07-26 | Run final Unity acceptance in a checkpointed Hyper-V virtual machine.    | ACCEPTED   |

### 7.1 P0-02 chunk profile decision

The corpus contains two products and two versions.

The corpus uses Unity package, ZIP, and opaque SPP inputs.

The logical trees include reordered entries and renamed files.

The corpus proves exact reuse from 1 KiB through 64 KiB.

The selected profile stores 11,371,983 physical bytes in 68 chunk objects.

The selected profile stores 43.9 percent of the 25,926,128 cumulative input bytes.

The `16:64:256 KiB` profile stores 10,299,774 bytes in 189 objects.

The selected profile adds 10.4 percent more bytes than that profile.

The selected profile uses 64.0 percent fewer objects than that profile.

The `256:1024:4096 KiB` profile stores 14,447,921 bytes in 41 objects.

The selected profile uses 21.3 percent fewer bytes than that profile.

The selected profile uses 27 more objects than that profile.

The `1024:4096:16384 KiB` profile loses reuse for most localized changes.

The selected profile keeps reuse for every changed large corpus file.

Small files below 64 KiB use one direct content-addressed object.

The 64 KiB test file uses one CDC object with the selected profile.

ZIP and Unity inputs produce the same signed logical tree fixture.

The evidence path is `.orchestration/package-storage-evidence/P0-02-20260723-01`.

Use these repeatable commands:

1. Run `bun run test:storage:corpus-fixture`.
2. Run `bun run fixture:storage-corpus -- --output <corpus-path>`.
3. Set `YUCP_STORAGE_CORPUS_DIR` to `<corpus-path>`.
4. Set `YUCP_STORAGE_FILE_PROFILE_RESULTS_PATH` to `<results-path>`.
5. Run `bun run test:storage:file-profiles`.

### 7.2 P0-05 chunk-engine comparison

Longtail v0.4.4 reconstructed all 12 normalized corpus versions.

Longtail stored 11,169,893 physical bytes.

The selected `desync` profile stored 11,399,960 physical bytes.

Longtail reduced physical bytes by 2.02 percent.

The adoption gate requires a reduction of at least 15 percent.

Longtail also grouped small files inside block objects.

The architecture requires one exact content-addressed object for each small file.

Keep file-oriented `desync` v1.0.3 with the selected profile.

The evidence path is `.orchestration/package-storage-evidence/P0-05-20260723-01`.

### 7.3 P0-05 price snapshot

The price snapshot uses published prices from 2026-07-23.

It does not replace actual invoices or tax records.

| Item                    |                   Published floor | Included use or variable rate                                         | Status                                 |
| ----------------------- | --------------------------------: | --------------------------------------------------------------------- | -------------------------------------- |
| Hetzner CX43 in Europe  |      $18.49 each month before tax | Eight shared vCPUs, 16 GB RAM, 160 GB SSD, and at least 20 TB traffic | Candidate                              |
| Hetzner primary IPv4    |       $0.60 each month before tax | Optional. Primary IPv6 is free.                                       | Avoid if provider tests pass with IPv6 |
| Cloudflare Workers Paid |                     $5 each month | Ten million requests and 30 million CPU milliseconds                  | Current launch model                   |
| Backblaze B2            |        $6.95 per decimal TB-month | Free Class A, B, and C operations                                     | Variable bulk storage                  |
| Convex Professional     | $25 for each developer each month | Compact state only                                                    | Confirm actual plan                    |
| Infisical Pro           |  $18 for each identity each month | The Free plan supports five identities                                | Confirm actual plan                    |
| HyperDX Starter         |                    $20 each month | 50 GB ingested each month                                             | Confirm actual plan                    |

The compute and edge increment is $18.49 to $23.49 each month before tax.

Optional IPv4 increases the range by $0.60 each month.

The CX43 cost-optimized SKU has limited availability.

Phase 0 must benchmark the purchased instance.

Phase 0 must confirm taxes, backup, domains, signing, support, and existing subscriptions.

Use these sources:

- [Hetzner price notice](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [Hetzner cost-optimized SKUs](https://www.hetzner.com/cloud/cost-optimized)
- [Hetzner primary IP pricing](https://docs.hetzner.com/cloud/servers/primary-ips/overview/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing)
- [Convex pricing](https://www.convex.dev/pricing)
- [Infisical pricing](https://infisical.com/pricing)
- [HyperDX pricing](https://www.hyperdx.io/pricing)

### 7.4 P0-05 local capacity evidence

The full profile processed two five GiB Unity packages.

The test completed in 1,687.3 seconds.

The input artifact contained 5,369,581,619 bytes.

The normalized artifact contained 5,375,329,625 bytes.

The reconstructed normalized artifact was byte-exact.

Peak Bun resident memory was 503,472,128 bytes.

The 1.5 GiB Bun memory bound passed.

The second version added one chunk and 126,645 bytes.

The test retained no disposable container or scratch directory.

The reduced profile measured scratch usage every 500 milliseconds.

It measured 193,474,851 scratch bytes for a 67,120,804-byte input.

The 32 GiB scratch bound passed.

The Bun CPU values exclude child processes and storage containers.

The full profile ran before automatic scratch sampling existed.

Manual sampling observed at least 10.002 GiB during archive creation.

That value is not the full-profile maximum.

P0-05 still requires the purchased node benchmark.

The evidence path is `.orchestration/package-storage-evidence/P0-05-20260723-01`.

### 7.5 P0-08 helper and VPM evidence

The helper uses Go 1.26.5 and `go-tuf` 2.4.2.

It verifies deterministic CBOR and purpose-separated COSE Sign1 envelopes.

It rejects noncanonical encodings and cross-purpose signatures.

`FileTableShardV2` now records logical and encoded chunk evidence.

The hash frame uses an ASCII purpose and unsigned 64-bit field lengths.

The helper reconstructs common files into a new staging tree.

It verifies encoded SHA-256 values and domain-separated logical digests.

It rejects corrupt cache objects, protected sources, and path traversal.

The stripped Windows executable is 11,248,640 bytes.

The VPM CLI installs the public importer and alias.

Unity then detects the installed alias as a server-authorized package.

Evidence is in `.orchestration/package-storage-evidence/P0-08-20260723-01`.

### 7.6 P0-08 Linux materialization evidence

The broker derives one subject and release seed from a random master epoch key.

It derives separate file keys from each path and whole-file digest.

The codec receives only file keys and attribution tokens through standard input.

The Docker sandbox has no network, storage credential, signing key, or master key.

The real Linux native runtime encodes and decodes two protected PNG files.

Two buyer subjects produce different output trees.

The broker writes one personalized ZIP to the versioned rendition bucket.

The trusted verifier rejects substituted bytes before receipt creation.

It reads the original exact MinIO version and verifies every entry.

The broker then signs `MaterializationReceiptV2` with purpose-separated COSE.

The receipt binds the exact rendition version, file identifier, digest, and length.

Receipt modification fails signature verification.

Authorized attribution lookup returns the expected pseudonymous buyer.

The Linux runtime SHA-256 is `906db3ffbdbf52cd5987390e8789a01084fb7f664844ef89402df72bdbcffa7d`.

Evidence is in `.orchestration/package-storage-evidence/P0-08-20260723-01/linux-materialization.json`.

### 7.7 P0-08 Windows VPM lifecycle evidence

The acceptance used VPM CLI `0.1.28` and Unity `2022.3.22f1`.

VPM installed the public alias and the byte-exact importer package.

The alias contained no paid bytes, delivery URL, version identifier, or token.

The update used an explicit synthetic importer version from the disposable repository.

Only the test package manifest changed between importer versions.

VPM restored the locked importer after the test detected a corrupted TUF root.

The repair removed only the verified disposable package directory.

VPM then rolled the importer back to the byte-exact source version.

Uninstall removed the product alias and kept the generic importer available.

Each lifecycle phase used a new Unity process.

The original alias-trigger test used a separate Unity process.

Linux and macOS Editor values reject protected materialization.

The Windows Editor value passes the launch platform check.

The guard runs before runtime discovery, temporary request creation, or project mutation.

The Bun test passed forty checks in 78.86 seconds.

Seven Unity XML reports passed with no failed test.

Evidence is in `.orchestration/package-storage-evidence/P0-08-20260723-01`.

### 7.8 P0-08 real Jammr lifecycle evidence

The creator uploaded `JAMMR_2.1.7.unitypackage` twice through the visible UI.

The two published versions contain 1,396 logical files and 1,890 chunk references.

The second upload reused every exact common and protected object version.

It added no canonical object.

The common store contains 1,251 versions and 168,321,708 bytes.

The protected store contains 639 versions and 53,570,135 bytes.

The metadata store contains four versions and 2,815,338 bytes.

Each quarantine object contains 167,018,826 bytes.

The VPM repository groups both storefront identities under one product alias.

The alias contains no paid bytes or paid artifact URL.

VPM CLI `0.1.28` installed importer `0.1.28` and the product alias.

The Unity bootstrap completed the real RFC 8252 PKCE flow.

Unity installed 1,396 files with 330,627,294 verified bytes.

Every file matched its external SHA-256 digest.

The release root is `6f2d1c2bedc8558982b031dc8146ba0ae55bd60e277780fc2f9ed89760667910`.

The signed receipt identifier is `0ed362c8-c1da-49f2-ba86-876786d63e10`.

The trusted receipt key verified every protected output.

Leak Tracer identified the correct pseudonymous buyer from the complete coupled ZIP.

The API sends only stored candidate assets to the Linux coupling service.

It uses sequential request batches with a 24 MiB maximum.

The catalog returns one newest row for each deterministic attribution identifier.

Repeated materialization records remain durable but do not multiply candidate transport.

The full coupled ZIP contains 63,746,797 bytes.

The importer EditMode suite passed all 53 tests.

Evidence is in `.orchestration/live-jammr-evidence-v5`.

The installed project is in `.orchestration/package-lifecycle-runs/live-jammr-v23/unity-project`.

## 8. Observed validation state

These results were observed before the implementation plan was complete.

They are not final validation results for this documentation change.

| Command                              | Result | Observed issue                                                        |
| ------------------------------------ | ------ | --------------------------------------------------------------------- |
| `bun run lint`                       | PASS   | No issue observed.                                                    |
| `bun run typecheck`                  | PASS   | No issue observed.                                                    |
| `bun audit`                          | FAIL   | Three dependency advisories were present.                             |
| `bun run test:external-integrations` | FAIL   | Nested Polar SDK code could not resolve `zod/v4-mini`.                |
| `bun run test:ci`                    | FAIL   | Untracked real tests entered discovery and one Convex test timed out. |

The audit advisories named these areas:

- Jaeger propagation
- Better Auth OAuth provider support
- Sharp image processing

P0-01 must rerun all commands from a recorded clean scope.

Do not classify an observed failure as preexisting without a clean comparison.

### 8.1 P0-01 executable baseline

| Area                   | Result      | Classification        | Evidence                                                                     |
| ---------------------- | ----------- | --------------------- | ---------------------------------------------------------------------------- |
| Storage and delivery   | PASS        | Product path          | Ten local E2E suites pass.                                                   |
| Buyer VPM delivery     | FAIL        | Product compatibility | Better Auth 1.7 removes the provider used by the current Convex adapter.     |
| Importer compilation   | PASS        | Product path          | The fixed package compiles in a disposable Unity project.                    |
| Importer first compile | FAIL        | Product packaging     | The package omitted dependencies and relied on unrelated project assemblies. |
| Docker                 | PASS        | Environment           | Docker Engine 29.6.1 is available.                                           |
| Desync                 | PASS        | Environment           | The pinned executable runs storage suites.                                   |
| Unity                  | PASS        | Environment           | Unity 2022.3.22f1 compiles the importer.                                     |
| Go                     | UNAVAILABLE | Environment           | No Go executable is on `PATH`.                                               |
| .NET SDK               | PASS        | Environment           | Portable SDK 8.0.423 runs from `E:\YUCPTools`.                               |
| VPM CLI                | PASS        | Product path          | The repository manifest restores VPM CLI 0.1.28.                             |

The Better Auth release candidate closes the OAuth audience advisory.

The latest Convex adapter supports Better Auth versions below 1.7.

An application-owned bridge now supports Better Auth 1.7.

Focused adapter tests and the development deployment passed.

## 9. Open blockers and confirmations

| ID    | Item                                                   | Blocks        | Owner    | Next action                                                |
| ----- | ------------------------------------------------------ | ------------- | -------- | ---------------------------------------------------------- |
| O-005 | Confirm disposable B2 credentials.                     | P0-04, P11-01 | User     | Provide nonproduction credentials through secrets storage. |
| O-006 | Confirm disposable Cloudflare credentials.             | P11-01        | User     | Provide nonproduction credentials through secrets storage. |
| O-008 | Define helper signing-root custody.                    | P6-02         | Security | Record the operational owner and rotation process.         |
| O-010 | Provide the purchased fixed node and invoice evidence. | P0-05         | User     | Provide host access and actual invoice lines.              |

Do not put a credential value in this file.

## 10. Ponytail debt view

Keep `ponytail:` source comments as the only debt source.

Generate a read-only debt view when a session needs it.

Do not copy source debt into this record.

## 11. Evidence log

| Date       | Work item      | Command or artifact                                  | Result              | Evidence path                                                                                        |
| ---------- | -------------- | ---------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| 2026-07-22 | Planning       | Repository and importer inspection                   | COMPLETE            | This record and the implementation plan                                                              |
| 2026-07-22 | Planning       | Existing buyer lifecycle inspection                  | COMPLETE            | `apps/api/test/e2e/buyer-delivery-flow.e2e.test.ts`                                                  |
| 2026-07-22 | Planning       | Ponytail rule inspection                             | COMPLETE            | `C:\Users\svalp\Downloads\ponytail-main`                                                             |
| 2026-07-22 | P0-00          | `bun run docs:ste`                                   | PASS                | Terminal output                                                                                      |
| 2026-07-22 | P0-00          | `bun run test:docs:ste`                              | PASS                | Five focused tests                                                                                   |
| 2026-07-22 | P0-00          | `bun run typecheck:docs`                             | PASS                | Terminal output                                                                                      |
| 2026-07-23 | P0-00          | `bun audit`                                          | PASS                | No vulnerabilities                                                                                   |
| 2026-07-23 | P0-00          | `bun run lint`                                       | PASS                | Terminal output                                                                                      |
| 2026-07-23 | P0-00          | `bun run typecheck`                                  | PASS                | Terminal output                                                                                      |
| 2026-07-23 | P0-00          | `bun run test:external-integrations`                 | PASS                | Terminal output                                                                                      |
| 2026-07-23 | P0-00          | `bun run test:ci`                                    | PASS                | Terminal output                                                                                      |
| 2026-07-23 | P0-00          | Human Issue 9 review                                 | PASS                | Section 13                                                                                           |
| 2026-07-23 | P0-01          | `bun run test:storage:e2e`                           | PASS                | Ten local suites                                                                                     |
| 2026-07-23 | P0-01          | Authenticated package upload UI                      | PASS                | Local browser session                                                                                |
| 2026-07-23 | P0-01          | Worktree and tool inventory                          | COMPLETE            | Current session                                                                                      |
| 2026-07-23 | P0-01          | `bun run test:flow:e2e`                              | FAIL                | Better Auth adapter incompatibility                                                                  |
| 2026-07-23 | P0-01          | Standalone importer first compile                    | FAIL                | `unity-importer-compile.log`                                                                         |
| 2026-07-23 | P0-01          | Standalone importer fixed compile                    | PASS                | `unity-importer-compile-fixed.log`                                                                   |
| 2026-07-23 | P0-02          | `bun run test:storage:corpus-fixture`                | PASS                | One deterministic fixture test                                                                       |
| 2026-07-23 | P0-02          | `bun run fixture:storage-corpus`                     | COMPLETE            | `P0-02-20260723-01/corpus`                                                                           |
| 2026-07-23 | P0-02          | `bun run test:storage:corpus`                        | PASS                | `desync-corpus-results.json`                                                                         |
| 2026-07-23 | P0-02          | `bun run test:storage:file-profiles`                 | PASS                | `desync-file-profile-results.json`                                                                   |
| 2026-07-23 | P0-03          | `bun run test:package-contracts`                     | PASS                | Six tests and eleven checks                                                                          |
| 2026-07-23 | P0-03          | TypeScript and Unity vector digest comparison        | PASS                | SHA-256 `2EA466EF5CDF7BCC18EE78FEDB5EF3D873874D44E23D926A61972007892ACCB9`                           |
| 2026-07-23 | P0-03          | Unity importer clean compile                         | PASS                | `unity-vpm-contract-compile.log`                                                                     |
| 2026-07-23 | P0-03          | Unity importer EditMode tests                        | PASS                | `unity-vpm-contract-editmode.xml`                                                                    |
| 2026-07-23 | P0-03          | Legacy VPM mutation regression                       | PASS                | `unity-vpm-legacy-readonly-green.xml`                                                                |
| 2026-07-23 | P0-03          | `bun run docs:ste`                                   | PASS                | Terminal output                                                                                      |
| 2026-07-23 | P0-03          | `bun run test:docs:ste`                              | PASS                | Five focused tests                                                                                   |
| 2026-07-23 | P0-04          | Configured B2 target classification                  | BLOCKED             | Development bucket is not disposable                                                                 |
| 2026-07-23 | P0-05          | `bun run test:storage:longtail`                      | PASS WITH REJECTION | `P0-05-20260723-01/longtail-corpus-results.json`                                                     |
| 2026-07-23 | P0-05          | Longtail adoption matrix                             | REJECT              | Physical reduction was 2.02 percent                                                                  |
| 2026-07-23 | P0-05          | Browser uploads for versions 1.0.0 and 1.0.1         | PASS                | Both rows share canonical SHA-256 `bfeddf8b22795594fd640ec3c86e22199da720a715ac047e2f42f1d32d9b61b7` |
| 2026-07-23 | P0-05          | Immutable S3 index regression                        | PASS                | One physical index version after two identical writes                                                |
| 2026-07-23 | P0-05          | `bun run test:accept:5gb`                            | PASS                | `P0-05-20260723-01/accept-5gb-retry/stdout.log`                                                      |
| 2026-07-23 | P0-05          | Reduced capacity instrumentation                     | PASS                | 193,474,851 peak scratch bytes                                                                       |
| 2026-07-23 | P0-05          | Published price snapshot                             | COMPLETE            | Section 7.3                                                                                          |
| 2026-07-23 | P0-08          | Verified Go 1.26.5 portable toolchain                | PASS                | `E:\YUCPTools\go-1.26.5`                                                                             |
| 2026-07-23 | P0-08          | `go test ./...` and `go vet ./...`                   | PASS                | `P0-08-20260723-01/transfer-helper-tests.log`                                                        |
| 2026-07-23 | P0-08          | TUF rollback and freeze rejection                    | PASS                | Real signed HTTP repository tests                                                                    |
| 2026-07-23 | P0-08          | Signed package reconstruction                        | PASS                | Complete command and multi-file cache tests                                                          |
| 2026-07-23 | P0-08          | Corrupt cache and path rejection                     | PASS                | Transfer-helper negative tests                                                                       |
| 2026-07-23 | P0-08          | Windows stripped helper build                        | PASS                | 11,248,640 bytes                                                                                     |
| 2026-07-23 | P0-08          | `bun run test:vpm-cli:e2e`                           | PASS                | Forty checks and seven Unity reports                                                                 |
| 2026-07-23 | P0-08          | Unity VPM alias trigger                              | PASS                | `P0-08-20260723-01/vpm-alias-trigger-results.xml`                                                    |
| 2026-07-23 | P0-08          | VPM install, update, repair, rollback, and uninstall | PASS                | Five separate Unity processes                                                                        |
| 2026-07-23 | P0-08          | Unsupported protected materialization platforms      | PASS                | Linux and macOS Editor values fail closed                                                            |
| 2026-07-23 | P0-08          | Unity importer compile                               | PASS                | `P0-08-20260723-01/unity-transfer-helper-compile.log`                                                |
| 2026-07-23 | P0-08          | Unity package-contract tests                         | PASS                | `P0-08-20260723-01/unity-package-contract-editmode.xml`                                              |
| 2026-07-23 | P0-08          | `bun run test:coupling:linux`                        | PASS                | One real Linux test and thirteen checks                                                              |
| 2026-07-23 | P0-08          | Exact rendition substitution test                    | PASS                | Substituted bytes failed before signing                                                              |
| 2026-07-23 | P0-08          | Signed `MaterializationReceiptV2`                    | PASS                | Exact MinIO version and file identifier bound                                                        |
| 2026-07-23 | P0-08          | Per-file subkeys and attribution lookup              | PASS                | Two files and two pseudonymous buyers                                                                |
| 2026-07-23 | P0-08          | `bun run test:storage:e2e`                           | PASS                | Eleven storage and delivery commands                                                                 |
| 2026-07-23 | P0-08          | `bun audit` and `bun run lint`                       | PASS                | No vulnerability or lint failure                                                                     |
| 2026-07-23 | P0-08          | `bun run typecheck`                                  | PASS                | All solution and Worker checks passed                                                                |
| 2026-07-23 | P0-08          | `bun run test:external-integrations`                 | PASS                | All mandatory integration contracts passed                                                           |
| 2026-07-23 | P0-08          | `bun run test:ci`                                    | PASS                | 193 passed, seven todo, and zero failed                                                              |
| 2026-07-23 | Authentication | Better Auth 1.7 bridge tests and deployment          | PASS                | Application-owned Convex bridge                                                                      |
| 2026-07-23 | Tooling        | `.NET SDK 8.0.423`                                   | PASS                | `E:\YUCPTools\dotnet-8.0.423`                                                                        |
| 2026-07-23 | Tooling        | `bun run test:vpm-cli:e2e`                           | PASS                | One real VPM CLI bootstrap test                                                                      |
| 2026-07-25 | P0-08          | Real Jammr duplicate uploads                         | PASS                | Zero new canonical objects on the second upload                                                      |
| 2026-07-25 | P0-08          | Real RFC 8252 Unity bootstrap                        | PASS                | `live-jammr-evidence-v5/results/identity-bootstrap-v23.json`                                         |
| 2026-07-25 | P0-08          | Real Jammr Unity import                              | PASS                | `live-jammr-evidence-v5/results/install-v28.json`                                                    |
| 2026-07-25 | P0-08          | Signed protected receipt verification                | PASS                | 290 protected outputs matched                                                                        |
| 2026-07-25 | P0-08          | Visible Leak Tracer round trip                       | PASS                | Complete coupled ZIP identified the buyer                                                            |
| 2026-07-25 | P0-08          | Unity importer EditMode suite                        | PASS                | 53 passed and zero failed                                                                            |
| 2026-07-25 | P0-08          | Coupling `bun test` and type check                   | PASS                | 34 passed and zero failed                                                                            |
| 2026-07-25 | P0-08          | Native helper `go test ./...`                        | PASS                | All helper packages passed                                                                           |
| 2026-07-25 | P0-08          | `bun run test:storage:e2e`                           | PASS                | All twelve commands passed                                                                           |
| 2026-07-25 | P0-08          | `bun audit`                                          | PASS                | No vulnerabilities                                                                                   |
| 2026-07-25 | P0-08          | `bun run lint`                                       | PASS                | No errors                                                                                            |
| 2026-07-25 | P0-08          | `bun run typecheck`                                  | PASS                | All type checks passed                                                                               |
| 2026-07-25 | P0-08          | `bun run test:external-integrations`                 | PASS                | All contracts passed                                                                                 |
| 2026-07-25 | P0-08          | `bun run test:ci`                                    | PASS                | Zero failed                                                                                          |
| 2026-07-26 | P6-04          | Importer 0.1.35 EditMode suite                       | PASS                | 92 passed and zero failed                                                                            |
| 2026-07-26 | P6-04          | Importer 0.1.35 artifact                             | PASS                | SHA-256 `f77f9d4e642b19c2a1249b72ae53be12673ac043379798665b002f1a6ca38a87`                           |
| 2026-07-26 | P6-04          | Same-user Unity token extraction proof               | FAIL                | The existing DPAPI session is readable by same-user code.                                            |
| 2026-07-26 | P10-01         | Hyper-V control probe                                | BLOCKED             | The current user lacks Hyper-V permissions.                                                          |

Add exact commands and result paths after P0-01 begins.

## 12. Session history

| Session ID        | Start      | End        | Work item | Owner | HEADs and branch                                               | Changed paths                                              | Last result              | Blocker                                    | Next action                 |
| ----------------- | ---------- | ---------- | --------- | ----- | -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------ | ------------------------------------------ | --------------------------- |
| PLAN-20260722-01  | 2026-07-22 | 2026-07-22 | Planning  | Codex | Record in Git evidence before P0-00                            | Package program documentation                              | Plan created             | Mandatory checks pending                   | Start P0-00                 |
| P0-00-20260722-01 | 2026-07-22 | 2026-07-23 | P0-00     | Codex | CreatorAssistant detached at `794f5255`                        | Documentation, dependencies, web, and test paths           | All exit gates pass      | None                                       | Start P0-01                 |
| P0-01-20260723-01 | 2026-07-23 | 2026-07-23 | P0-01     | Codex | CreatorAssistant `794f5255`, Unity `ca8b6fe5`, coupling unborn | Baseline and importer paths                                | Baseline classified      | Better Auth adapter and missing tools      | Start P0-02                 |
| P0-02-20260723-01 | 2026-07-23 | 2026-07-23 | P0-02     | Codex | Same recorded repository heads                                 | Corpus evaluation paths                                    | Profile gate passed      | None                                       | Start P0-03                 |
| P0-03-20260723-01 | 2026-07-23 | 2026-07-23 | P0-03     | Codex | Same recorded repository heads                                 | Contract and importer paths                                | Contract gate passed     | None                                       | Inspect P0-04 prerequisites |
| P0-05-20260723-01 | 2026-07-23 | 2026-07-23 | P0-05     | Codex | Same recorded repository heads                                 | Capacity, cost, upload, and VPM paths                      | Local capacity passed    | Purchased node unavailable                 | Start P0-08                 |
| P0-08-20260723-01 | 2026-07-23 | 2026-07-23 | P0-08     | Codex | Recorded repository heads remain unchanged                     | Helper, contracts, VPM, Linux, and Unity paths             | P0-08 exit gate passes   | None                                       | Unblock P0-04               |
| P0-08-20260725-02 | 2026-07-24 | 2026-07-25 | P0-08     | Codex | Four recorded feature branches                                 | Real Jammr, coupling, VPM, importer, and attribution paths | Real lifecycle passes    | None                                       | Unblock P0-04               |
| P6-04-20260726-01 | 2026-07-26 | Active     | P6-04     | Codex | Feature branches have uncommitted work                         | Broker, helper, importer, UI, and lifecycle paths          | Broker cutover is active | Hyper-V permission blocks final acceptance | Complete the broker cutover |

## 13. ASD-STE100 Issue 9 review

Review date: 2026-07-26
Reviewer: Codex
Result: PENDING after the current document changes

This review does not claim independent ASD-STE100 certification.

| Review area           | Result         | Evidence                                                         |
| --------------------- | -------------- | ---------------------------------------------------------------- |
| Scope                 | PASS           | The gate uses four named files and the program directory.        |
| Vocabulary            | PASS           | Uncommon program terms have definitions or direct references.    |
| Term consistency      | PASS           | Each storage role and contract keeps one name.                   |
| Active voice          | PASS           | The reviewed instructions name the acting component.             |
| Imperative procedures | PASS           | Procedure steps start with an action.                            |
| Conditions            | PASS           | Required conditions occur before their actions.                  |
| Sentence length       | PENDING        | Run `bun run docs:ste` after the implementation settles.         |
| Paragraph topics      | PASS           | Each short paragraph contains one primary topic.                 |
| Noun clusters         | PASS           | Long technical groups use lists or defined contract names.       |
| Abbreviations         | PASS           | Terms define CDC, CAS, DPoP, TUF, VPM, and related forms.        |
| Punctuation           | PASS           | The mechanical punctuation checks pass.                          |
| Tables                | PASS           | Tables have headers, stable terms, and named units where needed. |
| Figures               | PASS           | Diagram labels use the same component names as the prose.        |
| Warnings              | NOT APPLICABLE | The current files contain no maintenance warning procedure.      |
| Work-item consistency | PASS           | The plan and board contain the same 60 identifiers.              |

Review these areas again after each program-document change.

## 14. Next session instructions

The functional Jammr evidence remains valid.

Use this sequence:

1. Read the plan and this record.
2. Inspect all three worktrees.
3. Complete the durable broker operation exchange.
4. Complete the native broker IPC.
5. Delete the Unity token owner and require a new sign-in.
6. Run importer compilation and the complete EditMode suite.
7. Obtain access to the pinned Hyper-V virtual machine.
8. Run the complete isolated lifecycle.
9. Run every mandatory repository gate.
10. Resume P0-04 with disposable provider resources.

Do not modify the unrelated worktree changes.
