# Cost guardrails — R2 + Worker coupling delivery

Numeric ceilings enforced by tests, the models behind them, and the operator
alerts that back them up. Billing rates used throughout: Workers CPU
$0.02/M CPU-ms, R2 Class A $4.50/M, Class B $0.36/M, storage $0.015/GB-month,
container `standard-4` ≈ $0.40/hr. Reference package: 2530 files / 3603
chunks / 325 protected PNGs / ~314 MB.

## Tested ceilings

| Scenario | Bound | Test |
|---|---|---|
| 25 concurrent same-buyer requests, one file | 1 stored object ever (R2 conditional put single-flight); duplicate racers derive identical bytes, ≤ 1 Class A attempt each, no retry amplification; repeat requests do zero coupling work | `ca-coupling/src/couplingCostBounds.test.ts` |
| 20 buyers × 3 requests | exactly 20 couplings / 20 Class A puts — work scales with buyers, never requests; outputs strictly buyer-scoped | same |
| Same job run twice concurrently | lease serializes the runs: couplings == file count, loser is pure cache hits, completions byte-identical (minus lease generation/proof) | same |
| Crash mid-shard, then re-run | redo ≤ one shard (8 files); files stored before the crash are never re-coupled | same |
| Projected day: 200 buyers × 325 protected files | **byte-anchored worst case ≈ $3.84/day, asserted < $10/day**; literal per-file CPU ceiling pinned at $19.50/day (see below) | same |
| Duplicate `createInstallJob` (sequential and concurrent) | exactly one outbox row and one job row per job id | `ops/materialization/dispatchConcurrency.integration.test.ts` |
| Two concurrent `claim(10)` over 15 jobs | disjoint sets, union covers every row once (`FOR UPDATE SKIP LOCKED`) | same |
| 30 jobs PENDING → DISPATCHING → DISPATCHED/RETRY | each acceptance happens exactly once; failures back off (no hot retry loop) and retry cleanly | same |
| Ingest chunk I/O, two concurrent multi-file workloads | process-wide pool ≤ 32 concurrent puts across all uploads (32 MiB payload ceiling), no starvation | `ops/storage-core/chunkPoolBound.test.ts` |
| Upload memory | 5 GiB ingest peaks < 700 MiB RSS | `bun run test:accept:5gb` |

## Daily spend model (200 buyers/day × 325 protected files)

| Component | Ops or units / day | $/day |
|---|---|---|
| Coupling executions (buyers × files, never requests) | 65,000 | — |
| R2 Class A (output puts) | 65,000 | $0.29 |
| R2 Class B (cache heads + chunk reads) | ~916,000 | $0.33 |
| Workers CPU, byte-anchored worst case (15 s per 48 MiB applied to 314 MB/buyer) | ~19.6M CPU-ms | $0.39 |
| R2 storage, 90-day standing cache (200/day × 90 × 0.314 GB ≈ 5.7 TB) | — | $2.83 |
| **Total (asserted < $10/day)** | | **≈ $3.84** |

The literal per-file ceiling — all 325 files billed at the 15 s worst-case
CPU budget — is 975M CPU-ms = **$19.50/day CPU** (total ≈ $22.95, asserted
< $25 to pin the number). That model is physically unreachable for a 314 MB
package (it implies 15.6 GB of protected sources), but it matters because
**nothing in the platform caps daily worker-lane CPU**: coupling cost is
linear in new-buyer volume with no in-code daily budget. The billing alert
below is the enforcement for that model.

## Steady-state cache growth

Coupled outputs are cached per `(keyEpoch, buyer, releaseRoot, sourceSha256)`
and are deterministic, so each buyer pays coupling CPU once per file, ever.
Standing bytes = buyers-in-TTL-window × protected-output bytes per buyer
(bounded by package size), expiring via the bucket's **90-day TTL** lifecycle
rule; a cache miss after expiry re-couples on demand.

- Expected load (~200 installs/month): ≈ 600 standing buyers × ≤ 0.314 GB ≈
  190 GB ≈ $2.83/mo.
- Sustained 200 new buyers/day: ≈ 5.7 TB standing ≈ $85/mo = $2.83/day — the
  dominant steady-state cost; the TTL is the knob that caps it.

## Structural bounds (platform-capped, not test-assertable)

- **Containers**: `SLOT_COUNT = 30` in the MaterializerPool DO and
  `max_instances = 30` cap the worst-case container burn at 30 × standard-4 ×
  $0.40/hr = **$12/hr = $288/day**, only reachable if every slot runs a
  container-lane job around the clock. Sustained saturation means real demand
  or a stuck-job bug (leases renew during work; the 30-minute execution
  deadline bounds runaway containers). Pure worker-lane jobs start no
  container at all.
- **Quarantine backstop**: 30-day TTL lifecycle rule caps orphaned raw
  uploads if GC ever wedges.

## Operator actions (configure once — these page when tests can't)

1. **Billing notification** — dash.cloudflare.com → Manage account →
   Billing → Notifications: create a monthly-spend notification (suggested:
   $150/month ≈ $5/day headroom over the $3.84/day worst-case projection).
   This is the backstop for the uncapped worker-lane CPU model above.
2. **R2 storage alert** — dash.cloudflare.com → Notifications → Add → R2 →
   storage-utilization threshold on `yucp-coupled-cache` (suggested: 125% of
   the expected standing set — 250 GB at today's volume; re-derive from the
   model above when volume changes) and account-wide (suggested: 500 GB).
   Also verify the bucket lifecycle rule exists: R2 → bucket → Settings →
   Object lifecycle rules → delete `coupled/` objects after 90 days.
3. **Workers CPU anomaly** — dash.cloudflare.com → Notifications → Add →
   Workers → usage alert on the materializer worker (suggested: daily CPU-ms
   > 25M ≈ 125% of the byte-anchored worst case). Sustained breach at flat
   buyer volume means duplicate coupling work or a codec regression, not
   growth.

Review thresholds whenever the package profile, buyer volume, or Cloudflare
pricing changes; the pinned constants in `couplingCostBounds.test.ts` fail on
pricing drift in code, but dashboard thresholds only move by hand.
