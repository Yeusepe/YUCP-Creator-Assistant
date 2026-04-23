# Multi-Pass Review and Testing Playbook

This document describes a disciplined way to review, implement, and validate risky fixes or cross-cutting changes from beginning to end. It is based on a high-signal workflow:

1. investigate the real failure
2. write the failing tests first
3. split work into well-owned scopes
4. run multiple review passes with different goals
5. validate narrowly, then broadly
6. do not stop at the first "looks good"

Use this playbook for bug fixes, security-sensitive work, auth changes, data ownership issues, migrations, and any fix where the obvious happy path is not enough.

If you are coordinating a multi-lane GPT-5.4 bug-fix effort, pair this with `docs/fleet-bugfix-playbook.md` for fleet decomposition, SQL lane coordination, and combined-branch integration guidance.

## Core principles

- **TDD first for bugs.** Reproduce the bug in tests before changing production code.
- **Review in layers.** Root cause, boundary contracts, write paths, read surfaces, migrations, and regressions each need their own pass.
- **Use multiple review passes.** One pass will miss things. Deliberately change the question each pass asks.
- **Separate implementation from verification.** The person or agent that writes code should not be the only one deciding it is correct.
- **Test the bug class, not just the bug instance.** If one identity mixup happened once, look for every nearby place the same pattern can happen.
- **Treat cleanup as part of the fix.** If bad data may already exist, detection and remediation are part of done.

## End-to-end procedure

## 1. Frame the failure precisely

Start with the observed symptom, not a guessed solution.

- What was visible to the user?
- What data was wrong?
- Which surface exposed it?
- What should have happened instead?

Write the problem in one sentence. Then write the strongest invariant that was violated.

Example invariant:

- "A signed-in user must never see another user's linked accounts."

That invariant becomes the backbone for tests and reviews.

## 2. Trace the full path before editing

Read the full chain that could produce the symptom:

1. UI or API read surface
2. route or handler boundary
3. orchestration helper
4. write mutation or persistence layer
5. related read models
6. existing tests around each boundary

Do not stop at the first suspicious file. Cross-layer bugs often come from a correct read surface sitting on top of an incorrect write path.

## 3. Audit why tests missed it

Before writing new code, explain why the existing test suite allowed the bug through.

Look for gaps like:

- isolated unit tests with no end-to-end actor separation
- tests that cover creation but not later reads
- tests that assume one actor owns every identity in the flow
- mocks that hide real ownership, auth, or data-shape constraints
- missing negative-path and cross-tenant assertions

This step turns one bug fix into a durable testing improvement.

## 4. Write the failing tests first

Add the narrowest failing tests that prove the bug is real.

For a risky fix, write more than one failing test:

1. **symptom test**: proves the user-visible failure
2. **boundary test**: proves the wrong contract crossing a route or helper
3. **write-path test**: proves the bad data is written under the wrong owner
4. **migration/remediation test**: proves cleanup logic is safe

Good bug tests usually follow this pattern:

- creator A owns the resource
- buyer B performs the action
- buyer B receives the resulting state
- creator A does not

That pattern generalizes to any ownership bug. Always separate actors in test data.

## 5. Make a plan before broad changes

For anything cross-cutting, plan the work in explicit scopes:

1. contract change
2. core write-path fix
3. regression tests
4. adjacent flow audit
5. remediation or migration
6. final signoff

If using subagents, split by scope, not by file count. Each agent should own one coherent problem.

## 6. Use subagents deliberately

Subagents are best when the work naturally splits into independent tracks.

Use them like this:

1. **one agent for implementation of the main contract change**
2. **one agent for targeted test additions**
3. **one agent for remediation or migration logic**
4. **one code-review agent for high-signal review only**

Rules:

- give each agent full context
- tell each agent exactly what it owns
- avoid overlapping scopes
- do not redo the same investigation yourself while the agent owns it
- when you want deep review quality, run review agents after code exists

## 7. Implement the smallest architectural fix, not a workaround

Fix the contract that made the bug possible.

Typical signs you are fixing the right layer:

- ambiguous identity fields become explicit
- generic helpers stop overloading one field for multiple meanings
- ownership is encoded in types and function parameters
- callers cannot accidentally thread the wrong actor through

Typical signs you are writing a workaround:

- special-casing one provider
- branching on one user type in the route
- silently falling back to the wrong owner
- keeping the same ambiguous contract and only patching one path

Prefer the change that makes future mistakes harder to express.

## 8. Run the first review pass: correctness review

After the first implementation, do a review pass focused only on whether the logic is correct.

Ask:

- Does each layer receive the correct actor?
- Are creator-owned reads and buyer-owned writes clearly separated?
- Can stale fallback behavior still route data to the wrong owner?
- Do reads now reflect the corrected ownership model?

Ignore style. Hunt for wrong behavior only.

## 9. Run the second review pass: edge-case review

Now assume the primary fix is correct and look for nearby edge cases.

Ask:

- What happens if the subject exists but is unlinked?
- What if duplicate records already exist?
- What if a prior bad record is revoked or stale?
- What if a provider user ID collides across records?
- What if a session partially succeeds and later steps fail?
- What if retries happen?

Every important issue found here should get:

1. a failing regression test
2. a targeted fix
3. a re-run of focused validation

## 10. Run the third review pass: data repair and state transition review

If production data may already be wrong, review cleanup separately from the write-path fix.

Ask:

- How do we detect corrupted records?
- Can we distinguish high-confidence cases from ambiguous ones?
- What gets repaired automatically?
- What gets reported but intentionally not auto-fixed?
- How do revoked, duplicate, or partially migrated rows behave?

Then review future transitions:

- What happens when a temporary identity becomes a real account?
- Which records must move?
- Which records must stay in creator scope?
- What can remain as historical residue, and what cannot?

This pass is where long-term correctness is usually won or lost.

## 11. Run a signoff review

Once the fix and regressions look solid, run a final signoff review with a fresh lens.

The signoff reviewer should not be asked "is this okay?"

Ask instead:

- find real bugs
- ignore style
- focus on correctness, security, state transitions, and regressions
- only report issues that matter

This pass is for catching what everyone else normalized after staring at the same code too long.

## 12. Validate in widening rings

Do not jump straight to the full repo suite. Validate from the center out:

1. new failing tests now pass
2. neighboring focused tests still pass
3. data-layer or real integration tests pass
4. typecheck passes
5. repo CI suite passes
6. lint passes, or known unrelated blockers are documented
7. dependency audit status is known

If a repo-level check fails for unrelated reasons, say so plainly. Do not hide it, and do not pretend your change is blocked if it is not.

## Review passes used in this workflow

The following sequence is a strong default for risky work:

### Pass 1: root-cause review

Goal:

- identify the actual source of truth mismatch

Method:

- trace symptom -> read surface -> route -> helper -> mutation -> stored records

Output:

- a precise failure statement and the ownership invariant that was broken

### Pass 2: test-gap review

Goal:

- explain why the test suite missed the bug

Method:

- inspect existing tests at UI, route, helper, mutation, and integration layers

Output:

- a map of missing test boundaries

### Pass 3: TDD review

Goal:

- prove the bug before implementing

Method:

- add failing symptom and boundary tests first

Output:

- reproducible red tests for the real failure

### Pass 4: implementation review

Goal:

- confirm the contract fix is architectural, not tactical

Method:

- review signatures, ownership fields, call boundaries, and write semantics

Output:

- explicit actor separation and safer contracts

### Pass 5: edge-case review

Goal:

- catch nearby failures that the primary fix did not cover

Method:

- look for revoked rows, duplicates, retries, shared external IDs, and partial failures

Output:

- new regressions and hardening fixes

### Pass 6: remediation review

Goal:

- make production cleanup safe

Method:

- separate detect-only cases from auto-repair cases and test both

Output:

- repair logic that does not create fresh corruption

### Pass 7: final signoff review

Goal:

- get a fresh, high-signal bug hunt after the system appears stable

Method:

- independent review focused on correctness only

Output:

- either final issues or a meaningful "no significant issues found"

## Generic testing checklist for risky changes

Use this list for almost any substantial fix.

### Symptom coverage

- test the exact user-visible bug
- test the corrected read surface

### Boundary coverage

- route input normalization
- helper contract mapping
- internal RPC or service boundaries
- public vs internal actor handling

### Data ownership coverage

- creator-owned state stays creator-owned
- buyer-owned state stays buyer-owned
- cross-tenant or cross-user leakage is impossible

### Negative paths

- invalid input
- missing links
- duplicate submissions
- partial failures
- expired or revoked records

### State transitions

- first-time create
- retry/idempotent repeat
- upgrade or migration path
- cleanup or revoke path

### Remediation coverage

- detect-only mode
- safe repair mode
- ambiguous cases intentionally skipped

### Suite coverage

- targeted tests
- real integration or data-layer tests where possible
- repo typecheck
- repo CI tests
- repo lint status
- dependency audit status

## Production error taxonomy to regression home

When a production incident lands, classify it by the **first broken contract**, not by the loudest symptom.

The repo source of truth for this loop is `ops/production-regression-loop.ts`. Update it when a new incident class, regression home, or remediation path becomes required. `ops/production-regression-loop.test.ts` fails if one of the owned production surfaces loses a concrete regression home or falls out of the fast gate.

Use this workflow:

1. capture the exact production symptom and error string
2. write the strongest invariant that production just disproved
3. find the first boundary that could have rejected, normalized, or translated it correctly
4. add the primary regression at that boundary
5. add one secondary regression at the next public consumer so the user-visible symptom cannot silently return
6. if bad state may already exist, add a Convex or remediation test as well
7. run `bun run test:external-integrations`

### Repo enforcement rule

A provider, identity, verification, account, or backfill incident is not done until all of the following are true:

1. `ops/production-regression-loop.ts` names the invariant and the regression homes
2. the contract-layer regression is added in the primary home
3. the symptom-layer regression is added in the secondary home
4. remediation coverage exists when persisted bad state is part of the incident
5. `bun run test:external-integrations` passes locally

### Taxonomy matrix

| Error class | Typical failure signature | Primary regression home | Secondary regression home | Incident anchors |
| --- | --- | --- | --- | --- |
| Provider runtime contract failure | provider pagination loops, unsafe `next_page_url`, provider response shape drift, expired upstream credential mapped incorrectly | `packages\providers\test\<provider>\module.test.ts` or `packages\providers\test\<provider>\adapter.test.ts` | `apps\api\test\providers\<provider>.backfill.test.ts` when ingestion or backfill pagination also depends on the same contract | Gumroad pagination and provider-products failure starts here. Use `packages\providers\test\gumroad\module.test.ts` as the first stop. |
| API route normalization and tenant scoping failure | query/body params choose the wrong actor, route reads buyer data through creator context, disconnect/reconcile calls target the wrong auth user | `apps\api\src\routes\connectUserVerification.readSurface.test.ts` or the owning route test file such as `apps\api\src\routes\providerPlatform.test.ts` | one consumer test proving the wrong route result is surfaced correctly, usually in `apps\web\test\unit\account-connections.test.tsx` or `apps\web\test\unit\dashboard-connected-platforms.test.tsx` | Disconnect reconciliation regression belongs here first. The route must prove it reconciles and revokes using the signed-in actor, not a requested actor. |
| Internal-RPC adapter translation failure | Tempo adapter drops `error`, rewrites `undefined` fields incorrectly, picks the wrong RPC base URL, or normalizes product payloads into lossy shapes | `apps\api\src\internalRpc\router.test.ts` when the normalization contract itself changed | the first command/helper that consumes the adapter, usually `apps\bot\test\lib\setupCatalog.test.ts`, `apps\bot\test\commands\autosetup.test.ts`, or `apps\bot\test\commands\product.test.ts` | The recent provider-products failure crossed this boundary because the bot-side aggregation lost `error` information before UX could react. |
| Helper and identity boundary failure | helper resolves the wrong auth user, bypasses the public mutation path, materializes buyer identity in the wrong layer, or mixes creator and buyer ownership | `apps\api\src\lib\subjectIdentity.test.ts` for the helper contract itself | `apps\api\src\routes\providerPlatform.test.ts`, `apps\api\src\verification\completeLicense.test.ts`, or a Convex real test such as `convex\licenseVerification.realtest.ts` when the bug depends on subject materialization or persisted ownership | The subject-auth helper regression belongs here. The minimum guard is a helper test plus one route or integration test that proves the HTTP path still materializes the buyer auth user correctly. |
| Verification flow and entitlement ownership failure | verification resolves the wrong buyer subject, writes entitlements to the wrong auth user, or hides retry guidance after a provider verification failure | `apps\api\src\verification\completeLicense.test.ts` or `apps\api\src\routes\connect.user-verify.behavior.test.ts` | `apps\web\test\unit\purchase-verification-ui-state.test.ts` or the nearest bot/web verification consumer | Treat verification as its own public contract. One regression must lock the write path, and one regression must keep the retry or degraded-state UX visible. |
| Consumer UX and state interpretation failure | expired, degraded, disconnected, or empty states render the wrong CTA or hide the recovery path from the user | bot: `apps\bot\test\lib\setupCatalog.test.ts` and `apps\bot\test\commands\autosetup.test.ts`; web: `apps\web\test\unit\account-connections.test.tsx` and `apps\web\test\unit\store-integrations-status-label.test.tsx` | whichever upstream route or adapter supplied the state, so both the source contract and the user-facing copy are locked down | Disconnect reconciliation and provider-products incidents both need this layer. Users must still see the link to disconnect, reconnect, or retry instead of a generic empty state. |
| Backfill and remediation failure | internal backfill accepts the wrong secret, replays provider pages into the wrong tenant, or repair tooling mutates records without an explicit dry-run/apply split | `apps\api\src\routes\backfill.test.ts` or `apps\api\test\providers\*.backfill.test.ts` | `ops\buyer-attribution-remediation.test.ts`, `ops\subject-ownership-remediation.test.ts`, or a Convex migration real test when persisted damage is possible | Backfill incidents are not done until both the ingestion boundary and the repair path are locked down. |

Use `bun run test:external-integrations` as the deterministic PR gate for this matrix. Its steps are driven by `ops/production-regression-loop.ts`, so the fast gate stays aligned with provider runtime contracts, API and RPC boundary translation, verification flows, account consumers, and backfill coverage. Do not replace it with live smoke. `bun run smoke:providers` remains manual or separately scheduled drift coverage outside the pull request gate.

### How to place regressions for the recent incident set

1. **Subject-auth helper regression**
   - primary home: `apps\api\src\lib\subjectIdentity.test.ts`
   - required follow-up: one route or verification test that proves the public HTTP path still materializes the buyer auth user, not just the helper in isolation
   - add a Convex real or remediation test when the bug can corrupt persisted ownership

2. **Disconnect reconciliation regression**
   - primary home: `apps\api\src\routes\connectUserVerification.readSurface.test.ts`
   - required follow-up: `apps\web\test\unit\account-connections.test.tsx`
   - add Convex coverage only if reconciliation semantics or revoke state transitions changed

3. **Gumroad pagination and provider-products failure**
    - primary home for pagination and provider response safety: `packages\providers\test\gumroad\module.test.ts`
    - primary home for error and payload preservation across the adapter boundary: `apps\api\src\internalRpc\router.test.ts`
    - required follow-up: `apps\bot\test\lib\setupCatalog.test.ts` and `apps\bot\test\commands\autosetup.test.ts`

### Placement rule

Do not stop at the consumer test alone.

- if the wrong bytes came from the provider, fix and test the provider module
- if the route selected the wrong actor, fix and test the route
- if the adapter dropped the signal, fix and test the adapter
- if the helper broke identity semantics, fix and test the helper
- then add the closest consumer regression so the production symptom stays visible in tests

## How to use subagents well during reviews

Use this template:

1. **Implementation agent**
   - owns one architectural change
   - updates code and tests in its scope

2. **Research or audit agent**
   - traces adjacent flows for the same bug class
   - reports only relevant risks

3. **Code-review agent**
   - reviews changes after implementation
   - only reports correctness, security, logic, and data risks

4. **Verification agent**
   - reruns focused validations after fixes
   - confirms regressions and neighboring paths

Best practices:

- keep prompts specific
- state the exact bug class
- list relevant files
- define what is in and out of scope
- require concrete findings, not vague advice

## Common failure modes to avoid

- stopping after the first passing happy path
- fixing only the write path and not the read surface
- fixing the current symptom but leaving the ambiguous contract intact
- writing tests where creator and buyer are the same actor
- skipping cleanup for already-corrupted production data
- trusting one review pass
- letting mocks hide ownership or auth constraints
- claiming success before repo-level validation is understood

## Practical exit criteria

The work is ready when:

1. the original bug is reproduced by tests and then fixed
2. adjacent bug-class regressions are covered
3. remediation or migration is safe
4. at least one fresh review pass finds no material issues
5. repo-level validation is green, or remaining failures are clearly unrelated and documented

## Short version

If you need the compressed procedure:

1. trace the real bug
2. explain why tests missed it
3. write failing tests first
4. split work into explicit scopes
5. fix the contract, not the symptom
6. review correctness
7. review edge cases
8. review remediation and migration
9. run final signoff review
10. validate from focused tests to repo-wide checks

That is the repeatable way to get from "we found a bad bug in prod" to "we fixed the class of bug, covered the gaps, and did not stop too early."
