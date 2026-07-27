# YUCP License-Sharing Detection & Attribution — Implementation Plan

**Status:** proposal, ready to execute
**Owner:** platform/anti-piracy
**Scope:** Convex backend (`convex/`), API relay (`apps/api/`), closed coupling service, Unity importer (`com.yucp.importer`), new native collection DLL
**Non-scope:** watermark algorithm changes, delivery/storage layer changes

> Verified against the codebase before writing. Local identifier locations (VRChat `usr_` sources, `unity.cloud_userid`, `CloudProjectSettings.userName/userId`) confirmed on-disk and against Unity/VRChat docs.

---

## 0. Verified starting state (corrections to the brief)

Read the code before planning against it. Three assumptions in the original brief are wrong, and one of the errors is the single highest-value finding in this document:

1. **`isIdentityBlocked` is dead code.** `convex/attestation.ts:313` is referenced *only* by `convex/attestation.realtest.ts`. No unlock path, no delivery gate, no license-verify handler calls it. The entire identity-graph/block apparatus currently has **no enforcement point**. Everything downstream of it (weighted scores, velocity detection, reconciliation) is decoration until this is wired. → P0-1.
2. **`/v1/licenses/verify` *does* have a rate limit — a useless one.** `convex/http.ts:1322-1338` limits on `fingerprint:${sha256(machineFingerprint)}`, where `machineFingerprint` is a **client-supplied string**. An attacker rotates one field per request and the limit never fires. It also bypasses the shared `applyHttpRateLimit` helper (`convex/http.ts:182`), so it is invisible to the common rate-limit surface. `/v1/licenses/verify-discord` (`convex/http.ts:1372`) has **no rate limit at all**. → P0-2.
3. **The license-verify nonce is client-generated.** `checkAndConsumeNonce` (`convex/yucpLicenses.ts:788`) only records the nonce in `used_nonces` for replay detection. Freshness rests entirely on a ±120s timestamp window. There is no server-issued challenge on the license path, even though `attestation_challenges` + `issueChallenge`/`consumeChallenge` already exist for the attestation path. → P0-3.

Existing pieces we will **reuse rather than rebuild** (do not reinvent these):

| Need | Existing |
|---|---|
| Single-use server nonce + TTL | `attestation_challenges`, `internal.attestation.issueChallenge` / `consumeChallenge` |
| HTTP rate limiting | `applyHttpRateLimit` (`convex/http.ts:182`) → `internal.lib.httpRateLimit.checkAndIncrement` |
| Envelope decryption (HKDF→AES-GCM) | `convex/lib/hkdfAesGcm.ts` |
| Field-level PII encryption + purpose separation | `encryptPii` / `PII_PURPOSES` (`convex/lib/credentialKeys.ts`, `convex/lib/piiCrypto.ts`) |
| VRChat API access | `VrchatWebClient` (`convex/lib/vrchat/client.ts`) — has `getAvatarById`, `getLicensedAvatars` |
| Leaked-asset → buyer attribution | `runCouplingAttribution` (`apps/api/src/lib/couplingForensicsService.ts:479`) + `apps/api/src/routes/forensics.ts` |
| Forensic join key | `licenseSubject = SHA256(licenseKey)`, `machine_attestations.by_license_subject*` indexes |

---

## 1. Threat model & non-goals

### Attacker
A competent Unity user on their own Windows machine. They have: the open-source importer source (`com.yucp.importer`), a debugger, a hex editor, the ability to run any DLL under instrumentation, full control of the registry, filesystem, network stack, and OS. They are not a nation-state; they are motivated by a free avatar and by clout in a reselling Discord.

### Honest floor
- **Every client-side signal is forgeable.** The VRChat `usr_` id, `unity.cloud_userid`, MachineGuid, CPU string, and the entire collection payload are attacker-writable. The native DLL raises the cost of forging them coherently; it does not make them true.
- **Obfuscation is a speed bump, priced in hours.** Assume the DLL is reverse-engineered within weeks of a determined attempt, and that a working bypass circulates privately afterward.
- **TLS + payload encryption does not protect against the machine owner.** They hold the plaintext by definition. It protects honest users from network attackers and protects the *scheme* from casual traffic inspection. Nothing more.
- **We cannot prevent redistribution.** Once bytes are on a buyer's disk, they can be copied.

### Therefore the goal is not prevention
The goal is **attribution, revocation, and velocity**:
- **Attribution** — a leaked asset traces back to a `licenseSubject`, and via the identity graph to a person, with evidence strong enough to survive a human reviewer and an appeal.
- **Revocation** — deny-by-default delivery means a confirmed leaker's *future* unlocks fail, across all creators.
- **Velocity** — a shared license shows a statistical signature (one license, many `usr_`/installs) that an honest buyer does not.
- **Consistency cost** — a forger must now keep VRChat registry, VRChat AppData, VRChat logs, Unity install id, Unity account, TPM, and the eventual *public upload identity* all mutually consistent, forever, across every purchase. Most won't. Those who do are a small, high-effort tail we accept.

### Explicit non-goals
- Blocking VMs, blocking modified clients, or "detecting cheaters" in real time.
- Any automated block. Every block is human-reviewed (also a GDPR Art. 22 requirement — see P5).
- Kernel drivers, anti-debug escalation, self-modifying code, or anything that could be mistaken for a rootkit by an AV vendor.
- Surveillance beyond the identifiers in §7. We collect an id to resolve identity, never a history of what the user does.

---

## 2. Phase 0 — Server-side wins (no client change)

Nothing here needs the DLL, the Unity package, or a release. Ship it first; it is the majority of the actual security value.

### P0-1 — Wire the block gate (blocking, do first)
`isIdentityBlocked` must be consulted on every path that mints a license JWT or grants delivery.

- `convex/yucpLicenses.ts::verifyLicense` (~line 841): after `licenseKeyHash` is computed and before the JWT is signed, call `internal.attestation.isIdentityBlocked({ licenseSubject: licenseKeyHash, machineFingerprintHash })`.
- `convex/yucpLicenses.ts::issueAliasInstallLicenseToken` (line 1026) and `resolveAliasInstallLicenseContext` (line 983): same check against `context.licenseSubject`.
- `/v1/licenses/verify-discord` (`convex/http.ts:1372`): check against `sha256(discordUserId)`.
- On `blocked: true`, return a **generic** 403 (`"This license cannot be verified. Contact support."`) with an appeal URL. Never reveal the reason, the anchor, or that an identity graph exists — that is a free oracle for probing the graph.

```ts
// convex/yucpLicenses.ts, before token signing
const gate = await ctx.runQuery(internal.attestation.isIdentityBlocked, {
  licenseSubject: licenseKeyHash,
  machineFingerprintHash,
});
if (gate.blocked) return { success: false, error: LICENSE_BLOCKED_MESSAGE, appealUrl };
```

**Acceptance:**
- New `convex/attestation.realtest.ts` cases: node blocked → `verifyLicense` returns failure and issues **no** JWT; node reversed → verify succeeds again; unattested subject (`attested:false`) → verify succeeds (fail-open on absence of data, fail-closed only on an active block).
- A test asserts the block response body is byte-identical to the generic-failure body (no oracle).
- Grep test in CI: every call site that signs a license JWT is preceded by a gate call (enforce by routing all signing through one helper, `issueLicenseTokenGated`, rather than by grep if practical).

### P0-2 — Rate limit keyed on the license, not on client input
Replace `convex/http.ts:1322-1338` with the shared helper, keyed on `licenseSubject` (server-derived from the license key, not attacker-chosen) **and** keep a coarser IP limit.

```ts
const licenseSubject = await sha256HexHttp(licenseKey);
const limited =
  (await applyHttpRateLimit(ctx, request, 'license-verify-subject',
     { identity: licenseSubject, limit: 10, windowMs: 60_000, message: RL_MSG })) ??
  (await applyHttpRateLimit(ctx, request, 'license-verify-ip',
     { limit: 60, windowMs: 60_000, message: RL_MSG }));
if (limited) return limited;
```

Add the same to `/v1/licenses/verify-discord`, keyed on `sha256(discordUserId)` (available at line ~1424) plus IP.

**Acceptance:** `convex/httpSurface.behavior.test.ts` — 11 verifies of the same license key from *different* fabricated `machineFingerprint` values → the 11th returns 429 (this test fails against today's code, which is the point). Distinct license keys from one IP are limited at the IP threshold, not the subject threshold.

### P0-3 — Server-issued nonce on the license path
New public route `POST /v1/licenses/challenge` → `internal.attestation.issueChallenge` (reuse; do not add a second nonce table).

- Returns `{ nonce, expiresAt, correlationId }`.
- `/v1/licenses/verify` and `/v1/licenses/verify-discord` require that `nonce`, consume it via `internal.attestation.consumeChallenge`, and require the returned `correlationId` to equal the body's — the exact pattern already used at `convex/http.ts:1932-1940`.
- Rate-limit the challenge endpoint by IP (`limit: 30/min`).
- Keep `used_nonces` acceptance for one importer release cycle behind an env flag `LICENSE_REQUIRE_SERVER_NONCE`, then delete the client-nonce path.
- The same `correlationId` now spans challenge → verify → attestation submit → coupling proof, which is what makes P3/P4 joinable.

**Acceptance:** verify with a fabricated nonce → 422; replayed nonce → 422; expired (>5 min) nonce → 422; a nonce issued for correlation A submitted with correlation B → 422. Flag off → legacy path still works (migration safety).

### P0-4 — `licenseSubject` join into coupling attribution
`recordCouplingProof` (`convex/attestation.ts:399`) links to a node only via the *latest* attestation for the subject. Tighten to the attestation with a matching `correlationId` first, falling back to latest:

```ts
const att = (await byCorrelation(ctx, args.correlationId)) ??
            (await getLatestAttestationForLicenseSubject(ctx, licenseSubject));
```

`machine_attestations` already has `by_correlation`. Also add `licenseSubject` to the attribution candidate shape returned by `runCouplingAttribution` so a forensics hit resolves to a node in one hop.

**Acceptance:** two concurrent unlocks for the same `licenseSubject` on two machines → each coupling proof binds to *its own* attestation's node, not both to the latest.

---

## 3. Phase 1 — Identity graph: new anchors, weighted blocking

### P1-1 — New anchor types
`convex/schema.ts` `IdentityAnchorType` gains `unity_account`, `unity_install`. `usr` already exists. Mirror in the `v.union` at `convex/attestation.ts:168` and in `ATTESTATION_ANCHOR_TYPES` (`convex/http.ts:1535`).

### P1-2 — Confidence on the edge, weight in code
`identity_node_anchors` gains `confidence: v.optional(v.number())` (0–1, set by the closed service from cross-source agreement). Keep `isDurable` — it becomes *derived* (`weight >= DURABLE_THRESHOLD`) so nothing existing breaks. `identity_nodes` gains `anchorScore: v.number()`; keep writing `durableAnchorCount` for back-compat and for the existing admin UI.

```ts
// convex/attestation.ts — replaces DURABLE_ANCHOR_TYPES as policy input
const ANCHOR_WEIGHT: Record<AnchorType, number> = {
  tpm_ek:        1.0,
  payment:       1.0,
  usr:           0.8,  // × confidence; 3-source agreement ⇒ ~0.8, single-source ⇒ ~0.3
  unity_account: 0.7,
  unity_install: 0.5,
  os_machine:    0.3,
  email:         0.2,
  auth_user:     0.1,
};
const MERGE_MIN_WEIGHT = 0.5;   // anchor may collapse two nodes
const BLOCK_MIN_SCORE  = 1.6;   // score needed to sustain a block
// score = Σ over DISTINCT anchor types of (weight × confidence). Same-type duplicates
// do not stack: ten usr_ ids is evidence of sharing, not of certainty.
```

### P1-3 — Merge on corroborated anchors
`recordResolution` (`convex/attestation.ts:205`) currently merges only on `DURABLE_ANCHOR_TYPES`. Change the merge predicate to `effectiveWeight(anchor) >= MERGE_MIN_WEIGHT`. A `usr` anchor with `confidence < 0.6` (single source) attaches but does **not** merge — this is the guard against a forged `usr_` being used to poison-merge a victim's node into the attacker's.

Anti-poisoning rules (write these as tests, they are the failure mode that gets us sued):
- An anchor may merge nodes only if it is corroborated by ≥2 independent local sources (registry / AppData / logs) *and* the submitting machine already shares ≥1 hardware anchor with one of the two nodes.
- If a merge would join two nodes that each hold a **different** `tpm_ek`, do not merge silently — record the conflict and flag for review. Two distinct TPMs plus one shared `usr_` is either a family/second PC or an account handoff; a human decides which.

### P1-4 — Weighted block gate
`reviewIdentityBlock` (`convex/attestation.ts:481`) currently hard-fails on `durableAnchorCount < 2`. Replace with `node.anchorScore < BLOCK_MIN_SCORE`, keeping the error message shape. Effect: `usr` (0.8, corroborated) + `unity_account` (0.7) + `os_machine` (0.3) = 1.8 ≥ 1.6 can now sustain a block on a machine with no TPM, which is the whole point.

**Acceptance (extend `convex/attestation.realtest.ts`):**
- tpm+payment (2.0) → block allowed (unchanged behaviour).
- corroborated usr + unity_account + os_machine (1.8) → block allowed.
- single-source usr alone (0.24) → block refused.
- five `usr` anchors on one node → score counts one; block refused. (No stacking.)
- forged usr with no shared hardware anchor → attaches, does **not** merge; victim's node untouched.
- conflicting `tpm_ek` merge → flagged, not merged.
- Migration test: existing rows with no `confidence` default to 1.0 for `tpm_ek`/`payment`, 0.3 otherwise; existing blocked nodes stay blocked.

---

## 4. Phase 2 — Native collection DLL + sealed payload

The DLL is a **cost multiplier, not a boundary**. Write that in its header comment so no future engineer mistakes it for security.

### P2-1 — `yucp_collect.dll` (C, obfuscated, Windows x64)
Single export, no network, no login, no API calls, no persistence:

```c
// returns a sealed envelope (see P2-3); caller passes the server nonce in.
int yucp_collect(const char* nonce_hex, char* out_b64, size_t out_cap);
```

Sources, all local, all read-only (paths verified on-disk):

| Signal | Source |
|---|---|
| VRChat `usr_` (A) | `HKCU\Software\VRChat\VRChat` — value **names** contain `usr_...` (~40 occurrences); extract the id from names, not values |
| VRChat `usr_` (B) | `%LOCALAPPDATA%Low\VRChat\VRChat\OSC\usr_*` and `LocalAvatarData\usr_*` directory names |
| VRChat `usr_` (C) | `%LOCALAPPDATA%Low\VRChat\VRChat\output_log_*.txt` — bounded scan, most recent N logs, first-match only, **never** ship log contents |
| `unity.cloud_userid` | same VRChat registry key; survives VRChat account switching |
| Unity account | `CloudProjectSettings.userName` (account email) / `userId` (email-derived handle) via in-Editor API; email **only as a hash computed in-process** |
| Hardware | via the existing signed helper (`deviceKeyThumbprint`, `TransferHelperClient`), TPM EK where present |

Cross-source logic:
- ≥2 of {A,B,C} agree → `usrIdConfidence: "corroborated"`, confidence 0.8.
- Exactly 1 source present → `"single"`, confidence 0.3 (attaches, never merges, never blocks alone).
- Sources **disagree** (two different `usr_` ids across A/B/C, ignoring stale-account cases) → `"conflict"` + flag `spoof_suspected`. This is the highest-signal output of the whole DLL. Do not block on it; it feeds review.

Hardening (all cheap, none load-bearing): control-flow flattening + string encryption via the obfuscator, no exported symbol names beyond the one entry point, integrity self-hash reported as `selfHashRef` (already in `coupling_proofs`), build reproducibly and pin the hash server-side per release.

**Explicitly not doing:** anti-debug/anti-VM tripwires that break honest users on Parallels or in CI, kernel components, injecting into VRChat, or reading anything from a running VRChat process.

### P2-2 — Importer wiring
`MachineFingerprintService.cs` today is `SHA256(processorType + deviceUniqueIdentifier)` — keep it (it stays the JWT `machine_fingerprint` claim; changing it invalidates live tokens). Add a *separate* path: `CollectionClient.cs` P/Invokes `yucp_collect(nonce)`, gets an opaque base64 envelope, and posts it. The importer stays open source and **never sees plaintext** — a reader of the C# learns only that a sealed blob is produced. The Unity account read (`CloudProjectSettings.userName/userId`) happens in managed C# and is passed into the DLL for sealing, or hashed in-process before sealing; raw email never leaves the machine.

DLL missing / load failure / unsigned → degrade to today's behaviour (attest with hardware anchors only). No hard dependency; a failed collection must never block a paying customer's install.

### P2-3 — Sealed envelope (hybrid ECDH → AES-GCM)
WebCrypto exposes no HPKE primitive ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html) is not in `SubtleCrypto`), so implement the equivalent construction with what the codebase already uses: ephemeral **ECDH P-256** → **HKDF-SHA256** → **AES-256-GCM**, mirroring `convex/lib/hkdfAesGcm.ts`.

```jsonc
{
  "v": 1,
  "kid": "collect-2026-07",          // pinned server key id, rotatable
  "epk": "<base64 ephemeral P-256 public key>",
  "iv":  "<base64 12-byte>",
  "aad": { "nonce": "<server nonce hex>", "kid": "collect-2026-07", "v": 1 },
  "ct":  "<base64 AES-256-GCM ciphertext of the plaintext below>"
}
```

```jsonc
// plaintext — decrypted ONLY inside the closed coupling service
{
  "nonce": "<server nonce hex>",       // MUST equal aad.nonce; round-trip binding
  "correlationId": "…",
  "collectedAt": 1753400000,
  "usr": { "sources": { "registry": "usr_ab12…", "appdata": "usr_ab12…", "logs": null },
           "agreement": "corroborated" },
  "unity": { "cloudUserId": "…", "accountId": "…", "accountEmailSha256": "…" },
  "hardware": { "deviceKeyThumbprint": "…", "tpmEkPresent": true },
  "selfHash": "<sha256 of the loaded DLL image>"
}
```

- Private key half lives in the **closed service's KMS**, never in Convex (Convex is open source; it must be structurally incapable of reading these payloads). Convex continues to receive only salted hashes + opaque verdicts via the existing `/v1/attestation/internal/record` relay.
- Key pinned in the DLL, `kid`-versioned, with a documented rotation runbook. **Pinning is anti-MITM, not anti-owner** — the machine owner can swap the pinned key; that is expected and not a defect.
- Decryption rejects any envelope whose `aad.nonce` ≠ inner `nonce`, or whose nonce is unknown/consumed/expired.

**Acceptance:**
- Golden-vector test: fixture envelope decrypts to expected plaintext; single-bit ciphertext flip → GCM auth failure, no partial parse.
- AAD/inner nonce mismatch → rejected.
- Replayed envelope (nonce already consumed) → 422, no row written.
- Windows integration test on a machine with all three `usr_` sources present → `corroborated`; with only AppData → `single`; with a hand-planted conflicting registry name → `conflict` + `spoof_suspected`.
- DLL absent → install still succeeds, attestation records hardware anchors only.
- Convex-side test asserting no code path in `convex/` can decrypt an envelope (no private key material in Convex env).

---

## 5. Phase 3 — Velocity & graph detection

New table (this one genuinely needs to exist — the queries are fan-out over time windows, not point lookups):

```ts
// convex/schema.ts
const identity_velocity_signals = defineTable({
  kind: v.union(
    v.literal('license_many_usr'),      // one licenseSubject ↔ N distinct usr_
    v.literal('license_many_install'),  // one licenseSubject ↔ N distinct unity_install
    v.literal('usr_many_license'),      // one usr_ ↔ N distinct licenses  (reseller signature)
    v.literal('install_many_license'),
    v.literal('usr_source_conflict'),   // DLL cross-source disagreement
    v.literal('watermark_usr_mismatch') // P4
  ),
  subjectHash: v.string(),              // salted hash of the pivot value
  identityNodeId: v.optional(v.id('identity_nodes')),
  distinctCount: v.number(),
  windowStart: v.number(),
  windowEnd: v.number(),
  score: v.number(),                    // 0–1, normalised
  evidenceRef: v.optional(v.string()),
  createdAt: v.number(),
})
  .index('by_kind_subject', ['kind', 'subjectHash'])
  .index('by_identity_node', ['identityNodeId'])
  .index('by_kind_score', ['kind', 'score']);
```

- **Job:** Convex cron, hourly, rolling 30-day window. Thresholds start deliberately loose and are tuned against real data before anything reaches a reviewer: `license_many_usr >= 3`, `usr_many_license >= 5`, any `usr_source_conflict`.
- **Baseline first.** Run in **shadow mode for ≥30 days** — signals written, nothing surfaced, no reviews created. Legitimate multi-machine and household-shared cases must be measured before a threshold is set. Publish the observed distribution before enabling P3-2.
- **P3-2 — Review UX:** signals above threshold create a `blocked_identities` row with `status: 'pending'` via the existing `flagIdentityForReview`, never `active`. The admin surface shows: node score breakdown by anchor type, contributing signals with counts and windows, coupling proofs, and a one-click "reverse" honouring the existing appeal path. Reviewer identity recorded (`reviewedByUserId`, already present).

**Acceptance:**
- Synthetic fixture: one license across 4 `usr_` in 30 days → exactly one `license_many_usr` signal, score in range, `pending` block created, node status still `active`.
- Same license across 4 `usr_` spanning 90 days → no signal (window respected).
- A node whose `anchorScore < BLOCK_MIN_SCORE` → signal created, block creation still allowed as `pending`, but `reviewIdentityBlock('active')` refuses. Velocity never bypasses the evidence gate.
- No code path sets `identity_nodes.status = 'blocked'` without a human `reviewedByUserId` — assert by test.

---

## 6. Phase 4 — Watermark ↔ `usr_` reconciliation (the loop-closer)

The asset is watermarked per buyer, then uploaded **publicly** to VRChat under some `usr_`. If the uploading `usr_` ≠ the `usr_` claimed at unlock, either the buyer lied about their identity or the asset was shared. Either way it is the strongest signal available, because it is corroborated **outside** the attacker's machine.

```ts
const watermark_sightings = defineTable({
  source: v.union(v.literal('creator_report'), v.literal('public_scan'), v.literal('takedown')),
  assetContentSha256: v.optional(v.string()),
  attributedLicenseSubject: v.optional(v.string()),   // from runCouplingAttribution
  attributedIdentityNodeId: v.optional(v.id('identity_nodes')),
  observedUsrHash: v.optional(v.string()),            // salted hash of the uploading usr_
  claimedUsrHash: v.optional(v.string()),             // usr_ anchored at unlock
  verdict: v.union(v.literal('match'), v.literal('mismatch'), v.literal('unknown')),
  evidenceRef: v.optional(v.string()),
  createdAt: v.number(),
}).index('by_node', ['attributedIdentityNodeId']).index('by_verdict', ['verdict']);
```

**Flow:** creator reports a leak through the existing `apps/api/src/routes/forensics.ts` upload → `runCouplingAttribution` yields `licenseSubject` (P0-4 made this a single hop) → resolve `identityNodeId` → compare against the `usr` anchor(s) on that node → write a sighting → `mismatch` emits a `watermark_usr_mismatch` velocity signal → `flagIdentityForReview` with the sighting as `evidenceRef`.

Sourcing the observed `usr_`: primarily the creator's own report (they saw the world/avatar). Automated scanning uses `VrchatWebClient` under the **creator's own authenticated session** only. Treat VRChat API access as rate-limited, unofficial, and ToS-bound — identify with a proper User-Agent, back off aggressively, and never scrape at volume ([community API docs](https://vrchatapi.github.io/)). If a creator has not linked VRChat (`getVrchatProviderUserIdsForCreator`, `convex/yucpLicenses.ts:410`), the manual-report path is the only path.

**Acceptance:**
- Fixture leak whose watermark attributes to subject X, uploaded under X's anchored `usr_` → `match`, no signal.
- Same, uploaded under a different `usr_` → `mismatch`, signal, `pending` block, node still `active`.
- Attribution below the confidence floor → `unknown`, **no** signal, no flag. A weak watermark decode must never produce an accusation.
- Deleted/erased subject (P5) → reconciliation skips, no orphan sighting.

---

## 7. Data inventory

Everything is salted-HMAC'd by the closed service before it reaches Convex; Convex never holds a salt or a raw identifier. `licenseSubject` is the deliberate exception — it is a plain SHA-256 already used platform-wide as the join key.

| Field | Source | Why needed | At-rest form | Retention | Lawful basis |
|---|---|---|---|---|---|
| VRChat `usr_` id | HKCU registry value names; LocalLow OSC/LocalAvatarData dir names; output logs | Primary durable identity for merge + the P4 loop-closer | HMAC-SHA256, service salt (KMS) | 18 mo rolling from last activity | Consent (ePrivacy 5(3) read) + LI (fraud) |
| `usr_` source agreement | derived, in-DLL | Confidence weighting; conflict = tamper signal | enum on `machine_attestations.usrIdConfidence` | with attestation | LI |
| `unity.cloud_userid` | VRChat registry key | Survives VRChat account switching | HMAC-SHA256 | 18 mo | Consent + LI |
| Unity account id | `CloudProjectSettings.userId` (in-Editor) | Durable cross-machine anchor | HMAC-SHA256 | 18 mo | Consent + LI |
| Unity account **email** | `CloudProjectSettings.userName` (in-Editor) | Corroborator only | **SHA-256 in-process, raw never leaves the machine**, then HMAC server-side; `PII_PURPOSES.unityAccountEmail` if ever stored reversibly | 12 mo (shorter — higher sensitivity) | Consent (explicit, separately toggleable) |
| TPM EK / AK pub | TPM via signed helper | Strongest hardware anchor | HMAC-SHA256 (`ekHash`, `akPubHash`) | 18 mo | LI |
| `deviceKeyThumbprint` | signed helper | Machine anchor without TPM | HMAC-SHA256 | 18 mo | LI |
| OS MachineGuid / SID | Windows | Soft corroborator | HMAC-SHA256 (`osAnchorHashes`) | 18 mo | Consent + LI |
| CPU / board strings | `SystemInfo` | Weighted fingerprint components | HMAC-SHA256 (`fingerprintVector`) | 18 mo | LI |
| IP / ASN bucket | request | Velocity corroborator | **bucketed then** HMAC (`networkAnchorHash`) — no raw IP | 90 days | LI |
| Payment fingerprint | provider webhook | Durable anchor; survives new machine | HMAC-SHA256 | 24 mo (aligns with chargeback windows) | LI + contract |
| `licenseSubject` | SHA-256(licenseKey) | The forensic join key | SHA-256 (existing) | life of entitlement + 24 mo | Contract Art. 6(1)(b) |
| License key (raw) | buyer input | Re-verification with the provider | `encryptPii` / `PII_PURPOSES.forensicsLicenseKey` (existing) | life of entitlement | Contract |
| Coupling proof hashes | native runtime | Proves which bytes were watermarked | SHA-256 + salted path hashes (existing) | 24 mo | LI |
| Watermark sighting | creator report / scan | The loop-closer | hashes only | life of block + 12 mo | LI |
| Challenge nonce | server | Anti-replay | plaintext, single-use | 24 h purge | LI |
| Block record + appeal | review | Enforcement + audit | as-is | life of block + 12 mo (for appeals/audit) | LI + legal claims necessity |

**Never collected:** browsing history, installed program inventory, VRChat friends/social graph, log *contents*, world-visit history, files outside the Unity project, keystrokes, screenshots, anything from a running VRChat process.

---

## 8. Phase 5 — GDPR / privacy (ships **with** P2, not after)

Hard gate: **the collection DLL does not ship until P5-1, P5-2, P5-4 and P5-5 are live.** Collecting first and papering over it later is the failure mode that converts an anti-piracy feature into a regulatory incident.

### P5-1 — Lawful basis + LIA
- Processing basis: **Art. 6(1)(f) legitimate interest** — fraud prevention is named in [Recital 47](https://gdpr-info.eu/recitals/no-47/); the operative rules are in [Art. 6](https://gdpr-info.eu/art-6-gdpr/). License verification itself rests on **Art. 6(1)(b) contract**.
- Write a **Legitimate Interests Assessment** (purpose / necessity / balancing), following [EDPB Guidelines 1/2024 on Art. 6(1)(f)](https://www.edpb.europa.eu/our-work-tools/documents/public-consultations/2024/guidelines-12024-processing-personal-data_en). Store it in `docs/privacy/lia-sharing-detection.md`, versioned, reviewed annually and on any change to §7.
- The balancing test must honestly address: buyers are not the infringers in the vast majority of cases; the identifiers are persistent; the data subject would not reasonably expect a marketplace to read their VRChat and Unity account ids. That is exactly *why* consent gates the device-storage reads (P5-2), and why retention and minimisation are tight.

### P5-2 — Consent for device-storage reads
Reading the registry, AppData and local credential stores is "storing information, or gaining access to information stored, in the terminal equipment of a subscriber" → **ePrivacy Art. 5(3)** applies independently of the GDPR basis ([Directive 2002/58/EC](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32002L0058); scope clarified by [EDPB Guidelines 2/2023](https://www.edpb.europa.eu/our-work-tools/documents/public-consultations/2023/guidelines-22023-technical-scope-art-53-eprivacy_en)). The "strictly necessary" exemption is not available: the product functions without this collection.

Therefore:
- First-run modal in the Unity importer **and** an installer screen, listing in plain language exactly what is read (§7), why, and for how long. No pre-ticked boxes, no dark patterns, decline is one click and equally prominent.
- **Granular:** hardware/TPM anchors, VRChat id, Unity account id, and Unity account email are four separately declinable toggles.
- Declining is not a service denial. Declined signals are simply absent; the identity node carries a lower `anchorScore` and consequently cannot sustain a block. That is the correct, honest trade — and it is what makes the consent genuinely free.
- New table `collection_consents` — `{ authUserId | licenseSubject, scopes: string[], version, grantedAt, withdrawnAt?, ipHash, uiVersion }`. Withdrawal is as easy as granting, from the importer and from the web account page, and takes effect on the next unlock.
- The closed service **rejects** any envelope containing a scope the current consent record does not cover, and logs the rejection. Consent is enforced server-side, not by the client's good manners.

### P5-3 — Minimisation (Art. 5(1)(c))
- Collect the id, never the history: log files are scanned for the first `usr_` match and closed; no log content is transmitted; directory listings yield names only.
- Unity email is hashed **in-process, before it leaves the machine** — the server never receives a reversible email.
- IP is bucketed to ASN before hashing; raw IPs are never persisted in this subsystem.
- Bounded payload: reject envelopes over 8 KB. There is no legitimate reason for this payload to be large, and a size cap is a cheap exfiltration tripwire.

### P5-4 — Retention & erasure
- Implement the §7 columns as a Convex cron sweeper (`convex/crons.ts`), one job, per-table cutoffs. Deletion is real deletion, not a `deletedAt` flag.
- Nonces purge at 24 h. Velocity signals purge with their window.
- **DSAR ([Art. 15](https://gdpr-info.eu/art-15-gdpr/)) / erasure ([Art. 17](https://gdpr-info.eu/art-17-gdpr/)):** an internal mutation, given an `authUserId` or `licenseSubject`, exports every row across `machine_attestations`, `identity_node_anchors`, `identity_nodes`, `coupling_proofs`, `identity_velocity_signals`, `watermark_sightings`, `collection_consents`, and erases them, cascading through `mergedFromNodeId`. Because values are salted hashes, subject access returns *what categories are held and their derived verdicts*, not a decoding — say so in the response.
- Erasure vs. an active block: Art. 17(3)(e) permits retention for legal claims. Retain the **minimum** — block record, decision, reviewer, evidence ref — and erase the rest. Document this carve-out in the privacy policy; do not use it as a blanket excuse to keep everything.
- Existing salted-hash + KMS-separated-key pattern (`PII_PURPOSES`, `convex/lib/piiCrypto.ts`) is the model; add `unityAccountEmail` and `collectionPayload` purposes. Hashes remain personal data (pseudonymised, not anonymised) — treat them as such.

### P5-5 — Transparency & no automated decisions
- Privacy policy section covering every §7 row, the retention periods, the LI basis + right to object (Art. 21), and the appeal route.
- **No solely-automated block** ([Art. 22](https://gdpr-info.eu/art-22-gdpr/)) — every `active` block requires a named human reviewer; that is already enforced by `reviewIdentityBlock` and must stay enforced by test.
- Blocked users get a meaningful appeal path (`blocked_identities.appeal`, already present) with a human response SLA.
- Record this subsystem in the **Art. 30 processing register**, and run a **DPIA** — systematic monitoring + persistent device identifiers put it squarely in scope.

**Acceptance:**
- Declining VRChat-id consent → envelope omits it → server rejects any envelope that includes it anyway → node score reflects the absence → block cannot be sustained on that node alone.
- Withdrawal at T → next unlock collects nothing in that scope; prior data purged within 30 days by the sweeper (test with a clock shim).
- DSAR export for a fixture buyer returns rows from all relevant tables; erasure removes all but the retained block minimum; a second DSAR shows only that minimum.
- Retention sweeper test: rows at cutoff-1day survive, cutoff+1day are gone.
- Consent UI screenshot test asserting decline is not visually de-emphasised (or a manual sign-off checklist item, if snapshotting the Unity IMGUI is impractical).

---

## 9. What we explicitly do NOT do (anti-theater)

- **Obfuscation is not security.** The DLL raises reverse-engineering cost. It is never the reason an unlock is trusted. Any design that becomes unsafe once the DLL is understood is rejected.
- **Codenaming fields is not a compliance control.** Calling a column `usrIdHash` instead of `vrchatUserId` changes nothing under the GDPR — it is still personal data, still needs a basis, still needs retention. Codenames are for keeping the open-source repo from doubling as a bypass tutorial; they are documented honestly in the privacy policy and in §7.
- **Key pinning does not stop the machine owner.** It stops network attackers. Stated in the code comments so nobody later builds a trust assumption on top of it.
- **No auto-blocks.** Velocity and reconciliation produce `pending` only. Ever.
- **No blocking on `usr_` alone**, and no blocking on a single-source `usr_` under any circumstance. The forge cost is one registry write.
- **No "spoof detected ⇒ block".** `spoof_suspected` is a review input. False positives here are ordinary users with a fresh Windows install, a repaired VRChat install, or a shared family PC.
- **No collecting more "while we're in there."** Program lists, friends, world history, log bodies — all out. Every added field costs a DPIA line and buys almost nothing.
- **No hard dependency on the DLL.** A load failure degrades gracefully. Breaking installs for paying customers to catch a thief is a net loss on any honest accounting.
- **No error-message oracle.** Blocked responses are indistinguishable from generic failures.
- **No second nonce system, no second rate limiter, no second crypto helper.** `attestation_challenges`, `applyHttpRateLimit`, and `hkdfAesGcm` already exist; reuse them.

---

## 10. Open questions

1. **Baseline unknown.** What fraction of honest buyers legitimately show 2–3 `usr_` ids (second PC, alt account, household)? P3 shadow mode answers this; thresholds are unset until it does.
2. **Unity account email hash — worth it?** It is the most sensitive field in §7 and its marginal value over `unity.cloud_userid` + Unity account id is unclear. Default recommendation: **ship without it**, add only if the account id proves insufficiently stable in practice.
3. **VRChat ToS.** Does automated P4 scanning under a creator's own session risk their account? Needs a written answer before any scanner runs; the manual-report path is unaffected and should ship first.
4. **Weight calibration.** The `ANCHOR_WEIGHT` numbers and `BLOCK_MIN_SCORE = 1.6` are first-guess. They need tuning against the P3 baseline; the code should read them from a config document so tuning is not a code deploy.
5. **DLL distribution.** Signed how, updated how, and does an unsigned/unknown-hash DLL degrade or refuse? (Recommendation: degrade, and record the hash mismatch as a review signal.)
6. **Anchor conflict semantics.** Two TPMs + one `usr_` — family PC or account resale? Currently flagged for review; is there a rule that separates them without a human?
7. **Consent under 16.** VRChat skews young. Art. 8 raises the consent-age question for the ePrivacy toggles; needs legal input on whether a parental-consent path is required or whether LI-only (no device reads) is the correct posture for minors.
8. **Cross-creator block scope.** An active block currently refuses unlocks *everywhere*. Is a platform-wide ban proportionate for a first confirmed leak, or should the first block be creator-scoped? This is a policy decision with a real fairness dimension, and it should be made before P0-1 turns the gate on.

---

## 11. Suggested sequencing

| Phase | Depends on | Rough size | Ship independently? |
|---|---|---|---|
| P0 | — | ~3 days | Yes — do this week |
| P1 | P0-1 | ~4 days | Yes |
| P5-1/2/4 (consent, LIA, retention) | P1 | ~1 week + legal | **Must precede P2** |
| P2 (DLL + envelope) | P5 gates | ~2–3 weeks | No |
| P3 (shadow mode) | P1, P2 | ~3 days build + **30 days observation** | Yes (shadow) |
| P4 | P0-4, P2 | ~1 week | Yes (manual-report path first) |
| P5-3/5 (policy, DPIA, DSAR) | P3, P4 | ~1 week | Rolling |

P0 alone closes a live enforcement gap (a blocked identity is currently not blocked from anything) and a live rate-limit bypass. Everything after it is incremental evidence quality.
