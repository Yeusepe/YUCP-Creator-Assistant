# Fleet Bug-Fix and Deployment Playbook

This playbook explains how to fix bugs and deploy GPT-5.4 fleets without turning a real incident into a pile of reactive one-off changes.

Use it when the work is risky, cross-cutting, time-sensitive, or naturally decomposes into parallel lanes.

## What this playbook optimizes for

- reproduce the real failure before changing production code
- map the issue back to an invariant, not just a symptom
- split work into independent lanes without overlapping ownership
- run GPT-5.4 fleets with precise prompts and explicit scope boundaries
- integrate everything on the combined branch and validate the system as a whole
- avoid calling a lane "done" before the repo is actually green

## Non-negotiable rules

1. **Failing test first.** For bug fixes, write the test that proves the bug before editing production code.
2. **Invariant first.** State the rule that production disproved. That invariant drives tests, review, and validation.
3. **Architectural fix first.** Fix the contract or ownership model that allowed the bug. Do not patch a single symptom.
4. **Independent lanes only.** Parallelize by coherent scopes, not by random file chunks.
5. **Combined-branch validation.** Per-lane success is not repo success. The combined branch is the source of truth.

## 1. Start from the production failure

Write down:

1. the exact symptom
2. who observed it
3. the first user-visible wrong behavior
4. the strongest invariant that should have prevented it

Examples of strong invariants:

- a buyer must never receive another buyer's state
- a creator-owned record must not be written through a buyer-scoped path
- a degraded provider connection must surface reconnect guidance, not silently look healthy

If you cannot state the invariant cleanly, you are not ready to split work yet.

## 2. Trace the path that can violate the invariant

Before changing code, trace the full path:

1. symptom surface
2. route or command boundary
3. helper or adapter translation
4. write path
5. persisted state or downstream contract
6. read surface that exposed the damage

Also answer: **why did the current tests miss this?**

Common reasons:

- tests asserted source shape instead of business invariants
- mocks hid the real boundary contract
- only one actor existed in the fixture, so ownership bugs stayed invisible
- tests covered happy-path create but not later reads, retries, or degraded state

## 3. Write failing tests first

Do not write a reactive test that only mirrors the current implementation. Write the test that would have caught the incident.

Strong bug-fix coverage usually includes:

1. **symptom test** for the real user-visible failure
2. **contract or boundary test** for the first layer that should reject or normalize the bad state
3. **write-path test** if the bug can persist incorrect state
4. **consumer regression** so the broken UX or output cannot silently return
5. **remediation test** when old bad data may already exist

In risky areas, prefer invariant-driven tests over source-shape tests.

Bad:

- "returns field `x` and field `y` from helper `z`"

Better:

- "creator A's action cannot cause buyer B's account surface to show creator-owned linkage"

## 4. Decompose into independent lanes

Use lanes when the work can proceed independently after the invariant and failure path are understood.

Good lane boundaries:

1. primary contract or write-path fix
2. regression tests and consumer coverage
3. adjacent flow audit for the same bug class
4. remediation or migration safety
5. final high-signal review

Bad lane boundaries:

- "you take left side of file, I take right side"
- multiple lanes editing the same contract with different assumptions
- a test lane inventing expectations before the root invariant is agreed

Each lane should have:

- one owner
- one clear outcome
- explicit files or surfaces in scope
- explicit out-of-scope areas
- a required validation target

## 5. Deploy GPT-5.4 fleets correctly

A fleet is a set of sub-agents working in parallel on non-overlapping lanes.

Deploy fleets only after the invariant, failure path, and lane boundaries are clear.

### Fleet shape

Recommended pattern:

1. **implementation lane**: fixes the primary contract or write path
2. **test lane**: adds failing regressions and locks the symptom plus boundary
3. **audit lane**: searches adjacent flows for the same class of bug
4. **review lane**: reviews combined output for correctness only

### Prompting rules

Each sub-agent prompt should include:

- the exact bug or incident
- the invariant that must hold
- the files or surfaces it owns
- the files or surfaces it must not touch
- what counts as done
- what validations it must run
- the requirement to report concrete findings, not vague advice

### Coordination rules

- do not give two lanes the same ownership boundary
- do not let one lane redefine the invariant mid-flight
- do not treat exploratory findings as implemented fixes
- do not merge lane output mentally; integrate it on the branch and validate it there

## 6. Coordinate with SQL, not memory alone

When multiple lanes are active, track them explicitly. A lightweight SQL todo table is enough.

Useful fields:

- lane id
- title
- owner
- status: pending, in_progress, done, blocked
- dependencies
- validation status

Example lifecycle:

1. create the lane rows
2. mark a lane `in_progress` before work starts
3. mark it `done` only after its claimed validations pass
4. keep integration or combined-branch validation as its own lane

Important: a lane can be `done` while the overall incident is still not done.

## 7. Avoid reactive one-off fixes

A reactive fix usually has these smells:

- it special-cases the exact failing provider or user instead of the general contract
- it patches a read surface while leaving the corrupt write path intact
- it adds a test that only matches the new implementation shape
- it mocks the risky boundary instead of exercising it
- it declares victory because one lane turned green

The correct move is to ask:

1. what contract made this bug expressible?
2. what invariant should have made it impossible?
3. what nearby flows can fail the same way?
4. what persisted bad state now needs repair or detection?

## 8. Integrate sub-agent output on the combined branch

This is where many fleet efforts fail.

Per-lane success is a local signal. The combined branch is the real system.

After lane work lands together:

1. review the merged diff for contract conflicts and overlapping assumptions
2. rerun the failing tests that originally proved the bug
3. run neighboring targeted tests for touched boundaries
4. run repo-level checks required by this repo
5. confirm consumers still reflect the corrected behavior
6. verify remediation or degraded-state handling if production data can already be wrong

Do not assume:

- passing lane tests mean the merged branch is correct
- a good audit report means the code is integrated correctly
- a correct write-path fix means the user-visible read surface is fixed

## 9. Validate in widening rings

Use this order:

1. original failing test now passes
2. nearby targeted regressions pass
3. integration or real boundary tests pass
4. combined branch passes required repo checks

For this repo, the standard finish line is:

```bash
bun audit
bun run lint
bun run typecheck
bun run test:ci
```

For production-incident style work that touches provider, identity, verification, account, or backfill boundaries, also run the relevant targeted regression gate such as:

```bash
bun run test:external-integrations
```

## 10. Common pitfalls

Avoid these failure modes:

- **reactive tests** that only pin the new implementation shape
- **source-shape tests in risky areas** instead of invariant checks
- **mocked-boundary blind spots** where the real contract is never exercised
- **single-lane tunnel vision** where one owner stops at their local success
- **missing combined-branch validation**
- **not mapping production issues back to invariants**
- **assuming remediation is optional** when bad state may already exist
- **treating review as style feedback** instead of a fresh bug hunt

## 11. Practical templates

### Lane prompt template

Use a prompt shaped like this:

1. incident summary
2. invariant that must hold
3. owned scope
4. out-of-scope surfaces
5. required files or likely files
6. required tests or validations
7. expected deliverable

### Integration checklist

- are all lane assumptions still compatible after merge?
- did the failing tests start red and finish green?
- do consumer surfaces still show the correct state?
- were adjacent bug-class regressions added?
- was remediation or detect-only coverage added if needed?
- did the combined branch pass the required checks?

## Exit criteria

The work is only done when all of the following are true:

1. the real incident was reproduced with failing tests first
2. the fix enforces the invariant at the right boundary
3. parallel lanes covered implementation, regressions, and adjacent risk cleanly
4. combined-branch validation passed
5. repo-level success is known, not assumed
6. the team did not stop at per-lane green status

## Short version

1. map the incident to an invariant
2. trace the real failure path
3. write failing tests first
4. split into independent lanes
5. deploy GPT-5.4 sub-agents with precise prompts
6. integrate on the combined branch
7. validate from focused regressions to repo-wide checks
8. only call it done when the whole repo, not just each lane, is actually green
