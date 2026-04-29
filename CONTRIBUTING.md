# Contributing to YUCP Creator Assistant

Thanks for helping improve YUCP Creator Assistant. This repository handles Discord roles, creator storefront integrations, verification flows, buyer entitlements, webhooks, Convex state, and provider credentials, so contributions must be careful, tested, documented, and easy to review.

This guide explains the human contribution workflow. `AGENTS.md` is the working contract for coding agents and also describes the engineering bar expected from human contributors.

## Before you contribute

### Respect the license

Read `LICENSE` before using or modifying the repository. This project is provided for reference, education, review, and permitted self-hosting uses under its license.

### Report security issues privately

Do not open a public issue, pull request, discussion, or Discord post for suspected vulnerabilities.

Report suspected vulnerabilities through one of these private channels:

1. Email `contact@yucp.club` with the subject `[Security Report] <short summary>`.
2. Use the GitHub private security advisory flow for this repository.

For more information, check the [Security](https://github.com/Yeusepe/YUCP-Creator-Assistant/blob/main/SECURITY.md) info of this repo

### Choose the right contribution path

Use an issue first when the change affects architecture, security, data ownership, public APIs, provider integrations, Discord permissions, billing, entitlements, migrations, operations, or user-visible behavior.

A pull request without a prior issue is fine for small documentation fixes, typo fixes, small test improvements, and narrowly scoped bug fixes that explain the bug clearly in the PR body.

## Engineering principles

Every meaningful change must be grounded in three things:

1. Local repository docs and architecture.
2. Official upstream documentation for every external dependency involved.
3. Executable tests written before or alongside the implementation.

The contribution bar is:

1. Read the governing docs before coding.
2. Use TDD for bugs and behavior changes.
3. Write the smallest correct change that fits the existing architecture.
4. Use official SDKs, framework primitives, and installed library features before adding custom code.
5. Never add fake production behavior, production stubs, silent fallbacks, or workaround paths.
6. Preserve or extend observability for request paths, jobs, workflows, webhooks, verification flows, provider integrations, and mutations.
7. Validate external input at the first trusted boundary.
8. Keep secrets, tokens, credentials, personal data, and session material out of logs, errors, tests, snapshots, and commits.
9. Update docs when behavior, contracts, architecture, data models, operations, or security posture changes.
10. Report exactly which checks were run.

## Repository map

The README describes the main components:

| Area            | Path                                                            | Notes                                                                                  |
| --------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Discord bot     | `apps/bot`                                                      | Slash commands, setup flows, role sync, Liened Downloads, Discord-facing behavior.     |
| API             | `apps/api`                                                      | Better Auth, webhooks, connect flows, onboarding routes, collaborator invite flows.    |
| Web app         | `apps/web`                                                      | Dashboard and creator-facing web UI.                                                   |
| Providers       | `packages/providers`                                            | Gumroad, Jinxxy, VRChat, Discord, manual license adapters.                             |
| Policy          | `packages/policy`                                               | Entitlement policy decisions, allow and deny behavior, remediation guidance.           |
| Shared packages | `packages/shared`, `packages/application`, and related packages | Cross-cutting domain utilities and application logic.                                  |
| Convex backend  | `convex`                                                        | Schema, backend functions, entitlements, downloads, webhooks, collaborator invites.    |
| Operations      | `ops`                                                           | Infisical, dev supervisor, regression loops, local observability, remediation tooling. |
| Documentation   | `docs`                                                          | Review playbooks, architecture notes, workflow docs, and task-specific guidance.       |

## Required reading before coding

Start with the closest governing docs for the area you touch. At minimum, read:

1. `README.md`
2. `AGENTS.md`
3. `docs/review-playbook.md` for risky fixes, regressions, security-sensitive work, auth changes, data ownership issues, migrations, and cross-cutting changes.
4. `docs/fleet-bugfix-playbook.md` when coordinating parallel or delegated work.
5. `SECURITY.md` for vulnerability handling.
6. `ops/infisical/README.md` when local development or secrets are involved.
7. The nearest package, module, route, command, or operations documentation for the code you are changing.

When no governing doc exists for a meaningful change, add the minimum useful documentation needed to make the change reviewable and maintainable.

## Local setup

Prerequisites:

1. Node.js `>=18`.
2. Bun `>=1.1`.
3. A Convex deployment and API secret when working on backend flows.
4. Infisical or a local gitignored environment file when secrets are required.
5. Discord, Gumroad, Jinxxy, or VRChat credentials only when the change needs those integrations.

Install dependencies:

```bash
bun install
```

Build the repo:

```bash
bun run build
```

Run the default development stack:

```bash
bun run dev
```

Run with Infisical-backed environment variables:

```bash
bun run dev:infisical
```

Run individual services when needed:

```bash
bun run dev:api
bun run dev:bot
bun run dev:web
npx convex dev
```

Never commit real `.env` files, secrets, tokens, OAuth credentials, API keys, session values, database dumps, production logs, or raw provider payloads containing sensitive data.

## How to make a pull request

### 1. Fork or branch from the right base

External contributors should fork the repository on GitHub, then clone their fork:

```bash
git clone https://github.com/<your-user>/YUCP-Creator-Assistant.git
cd YUCP-Creator-Assistant
git remote add upstream https://github.com/Yeusepe/YUCP-Creator-Assistant.git
```

Maintainers with write access may branch directly from the repository.

Start from the current target branch, normally `main` unless a maintainer says otherwise:

```bash
git fetch upstream
git checkout main
git pull upstream main
```

### 2. Create a focused branch

Use a short branch name that explains the work:

```bash
git checkout -b fix/provider-pagination-contract
```

Good branch names:

1. `fix/discord-role-sync-retry`
2. `feat/jinxxy-collab-remediation`
3. `docs/provider-contracts`
4. `test/verification-boundary-regressions`

### 3. Frame the change before editing

Write down:

1. The problem or requirement.
2. The invariant that must hold.
3. The local docs that govern the work.
4. The upstream docs or installed package types you need to verify.
5. The tests that should fail before the implementation.
6. The operational, security, or migration implications.

For bugs, reproduce the bug in a failing test before production code changes. For features, update docs or contracts before or alongside implementation when behavior changes. For more information on this, check the review playbook.

### 4. Read upstream docs before integration work

Before changing code that calls an external API, SDK, framework, service, protocol, or library:

1. Read official upstream documentation.
2. Inspect installed package types, generated clients, source, or local API definitions.
3. Verify named exports, method signatures, return types, error shapes, configuration keys, component props, event names, and version-specific behavior.
4. Prefer official SDKs, generated clients, companion packages, framework primitives, and built-in middleware.
5. Write thin adapters only for repository-specific gaps.

Do not guess API names, endpoint paths, configuration shapes, component props, or response formats.

### 5. Write tests first where practical

Test at the layer where the behavior is owned.

| Change area                                 | Good first test location                                            |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Provider contracts                          | `packages/providers/test`                                           |
| Policy decisions                            | `packages/policy/test`                                              |
| API routes and verification flows           | `apps/api/test` or the nearest route test beside the implementation |
| Bot commands and Discord UX                 | `apps/bot/test`                                                     |
| Web UI behavior                             | `apps/web/test`                                                     |
| Convex schema, mutations, and backend state | `convex` tests or Convex real tests                                 |
| Operational tooling and regression loops    | `ops` tests                                                         |

Prefer integration tests with real local services, emulators, containers, official sandboxes, or installed library behavior when validating system boundaries. Mocks are acceptable in tests only when they are the correct level of isolation.

### 6. Implement the smallest architectural fix

A good implementation:

1. Fits the existing architecture.
2. Makes ownership, authorization, invariants, and state transitions explicit.
3. Fails clearly when a required real dependency cannot be wired.
4. Uses shared resilience, validation, logging, tracing, metrics, and error utilities.
5. Avoids duplicated logic.
6. Avoids provider, customer, entity, or path-specific special cases unless the domain docs define them.
7. Keeps behavior observable and diagnosable.

### 7. Update documentation and traceability

Update docs when the change affects:

1. Architecture.
2. Public or internal contracts.
3. API, RPC, route, command, webhook, job, or workflow behavior.
4. Data models, migrations, persistence, ownership, or concurrency.
5. Security or authorization posture.
6. Observability, operations, deployment, secrets, or rollback behavior.
7. User-visible behavior.

For every new source file or major module, add a concise header or nearby documentation with:

1. Purpose.
2. Governing local docs.
3. Upstream external references.
4. Tests that prove it works.

Example:

```ts
/**
 * Purpose: Verifies marketplace purchases for entitlement decisions.
 * Governing docs:
 *   - docs/provider-contracts.md
 *   - docs/review-playbook.md
 * External references:
 *   - https://example-provider.com/docs/api
 * Tests:
 *   - packages/providers/test/example/module.test.ts
 */
```

### 8. Run checks before opening the PR

Use the scripts from `package.json` as the command source of truth.

Common checks:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

Broader validation:

```bash
bun run test:ci
bun run test:all
```

Focused checks:

```bash
bun run test:ops
bun run test:convex
bun run test:api:integration
bun run test:bot
bun run test:api:e2e
bun run test:bot:e2e
```

Run the narrowest relevant tests first, then widen to repo-level checks. If a repo-level check fails for a reason unrelated to your change, include the command, failure summary, and why it is unrelated in the PR body.

### 9. Commit clearly

Keep commits focused. A good commit message explains the changed area and the result:

```bash
git add .
git commit -m "fix(api): preserve provider error details"
```

Use one PR for one coherent change. Split unrelated cleanup, formatting-only work, package upgrades, and behavior changes into separate PRs.

### 10. Push and open the PR

Push your branch:

```bash
git push origin fix/provider-pagination-contract
```

Open a pull request with the GitHub web UI or GitHub CLI.

With GitHub CLI:

```bash
gh pr create --base main --head <your-user>:fix/provider-pagination-contract --title "fix(api): preserve provider error details" --body-file .github/PULL_REQUEST_TEMPLATE.md
```

Use a draft PR when the work needs early feedback or CI visibility before it is ready for review. Mark it ready only after tests, docs, and the PR checklist are complete.

## Pull request requirements

A PR is reviewable when it includes:

1. A clear problem statement.
2. The invariant or contract being protected.
3. The implementation approach.
4. Governing local docs.
5. Official upstream references for external behavior.
6. Tests added or changed.
7. Checks run, with exact commands.
8. Documentation updates, or a clear explanation for why no docs changed.
9. Security, privacy, observability, migration, and operational impact notes.
10. Screenshots, logs, traces, or recordings when they help review UI, Discord UX, webhook behavior, or operational flows.

### Suggested PR title format

Use this format when it fits:

```text
<type>(<scope>): <short summary>
```

Types:

1. `fix`
2. `feat`
3. `docs`
4. `test`
5. `refactor`
6. `chore`
7. `security`
8. `ops`

Examples:

1. `fix(api): preserve degraded provider reconnect state`
2. `test(policy): cover revoked entitlement denial`
3. `docs(ops): document Convex rollback expectations`

### Suggested PR body

Copy this into the PR description when no repository template is present:

````markdown
## Summary

Describe what changed in plain language.

## Why

Issue, requirement, incident, or invariant this PR addresses.

## Governing docs

- `README.md`
- `AGENTS.md`
- `docs/...`

## Upstream references

- Official docs or API references used for any external dependency.
- Installed package types, generated client, or source inspected.

## Tests

- [ ] Added or updated tests at the correct layer.
- [ ] Failure was reproduced first for bug fixes where practical.
- [ ] Positive path covered.
- [ ] Negative path covered.
- [ ] Authorization, tenant, identity, retry, idempotency, or replay path covered when relevant.

Commands run:

```bash
bun run ...
````

## Documentation

* [ ] Updated docs or contracts.
* [ ] Added source/module reference headers where appropriate.
* [ ] No docs needed because: ...

## Security and privacy

* [ ] No secrets or sensitive data committed.
* [ ] Inputs are validated at the first boundary.
* [ ] Authorization is enforced at a trusted boundary.
* [ ] Logs, errors, traces, metrics, and snapshots redact sensitive values.

## Observability and operations

* [ ] Existing logs, metrics, traces, and analytics are preserved.
* [ ] New system boundaries propagate useful context.
* [ ] Migration, rollback, remediation, or runbook changes are documented when relevant.

## Risk

Known risks, rollout notes, follow-up work, or unrelated failing checks.

## Definition of done

A change is done when all of these are true:

1. Governing docs were identified.
2. Docs were updated when behavior, architecture, contracts, operations, security, or data models changed.
3. Official upstream docs and installed types were checked for every external dependency used.
4. Tests exist at the correct layer.
5. Relevant tests pass.
6. Relevant linting, formatting, type-checking, build, and security checks pass.
7. Production code uses real dependencies and real control flow.
8. No workaround path, production stub, fake implementation, silent fallback, broad catch, or swallowed promise was introduced.
9. Observability coverage was preserved or extended.
10. Security and authorization expectations were tested where relevant.
11. The PR body explains what changed, why it changed, which docs govern it, which upstream behavior it relies on, which tests prove it, and what risks remain.

## Review process

Maintainers review for correctness, architecture, tests, documentation, operations, and security.

Expect reviewers to ask:

1. Does this fit the existing architecture?
2. Are the right docs updated?
3. Does the test suite prove the invariant rather than only the implementation shape?
4. Are failure paths, retries, idempotency, tenant boundaries, and authorization covered where relevant?
5. Are external APIs and installed types verified?
6. Does the code use upstream capabilities before custom code?
7. Are logs, metrics, traces, and errors useful without exposing secrets?
8. Can this be diagnosed in production?

When responding to review:

1. Push follow-up commits instead of force-pushing during active review unless asked.
2. Answer questions with links to code, docs, tests, or upstream references.
3. Re-run focused checks after changes.
4. Re-run broader checks when the change touches shared contracts or cross-cutting code.
5. Do not resolve conversations until the concern has been addressed or the maintainer accepts the explanation.

## What will block a PR

A PR can be blocked for any of these reasons:

1. Missing tests for meaningful behavior.
2. Tests written only after implementation for a bug that could have been reproduced first.
3. Production stubs, fake implementations, or code paths that simulate success without real dependencies.
4. Workarounds that bypass the existing architecture.
5. Integration code written from memory without official docs or installed type verification.
6. Custom code that duplicates an official SDK, framework primitive, companion package, or existing repository utility.
7. Missing documentation for changed contracts, behavior, operations, security, or data models.
8. Missing traceability for new source files or major modules.
9. Silent fallbacks, broad catches, swallowed promises, or hidden failure modes.
10. Secrets, credentials, sensitive personal data, raw production payloads, or unsafe logs in commits.
11. Authorization or tenant boundary changes without positive and negative tests.
12. Observability removed, bypassed, or degraded without documented approval.
13. PR body missing the checks run.
14. Unrelated changes bundled into the same PR.

## Guidance by change type

### Bug fixes

1. State the production or user-visible symptom.
2. State the invariant that was violated.
3. Explain why existing tests missed it.
4. Add the failing regression first where practical.
5. Fix the contract or boundary that allowed the bug.
6. Add consumer coverage so the symptom stays visible in tests.
7. Add remediation or migration coverage when bad state may already exist.
8. Use `docs/review-playbook.md` for risky bugs.

### Provider and external integration changes

1. Read the official provider or SDK docs.
2. Inspect installed types, generated clients, or source.
3. Verify request, response, pagination, error, webhook, signature, retry, and credential expiry behavior.
4. Use official SDKs or generated clients when appropriate.
5. Validate and narrow responses before using them.
6. Treat provider credentials as sensitive and redact them everywhere.
7. Test degraded, expired, revoked, malformed, duplicate, and retry cases.
8. Keep reconnect or remediation guidance visible to users.

### Auth, authorization, identity, and tenant work

1. Enforce access control at a trusted server boundary.
2. Deny by default when context is missing or ambiguous.
3. Keep creator-owned state and buyer-owned state explicit.
4. Test positive and negative authorization cases.
5. Test cross-tenant and cross-user isolation.
6. Avoid client-only checks for protected actions.

### Database, Convex, migration, and persistence work

1. Document canonical state versus derived state.
2. Document migration, transaction, isolation, lock, concurrency, and rollback expectations where relevant.
3. Test idempotency, retries, duplicate submissions, partial failure, and replay behavior.
4. Add dry-run and apply modes for remediation tooling when production data may change.
5. Keep durable completion evidence for mutating workflows.

### UI and Discord UX changes

1. Follow existing design and command patterns.
2. Verify installed component APIs, command option shapes, interaction flows, and Discord permission requirements.
3. Preserve accessibility and useful error copy.
4. Show remediation guidance for degraded, expired, disconnected, denied, or empty states.
5. Include screenshots or recordings when the reviewer benefits from seeing the behavior.

### Observability and operations changes

1. Use shared logging, tracing, metrics, and analytics utilities.
2. Propagate trace context across system boundaries.
3. Add useful context to errors without exposing secrets.
4. Bound I/O and remote calls with explicit timeouts.
5. Retry only safe and idempotent operations with bounded backoff.
6. Update runbooks or operation docs when behavior changes.

## AI-assisted contributions

AI tools are allowed, but the contributor owns the result. It needs to be CLEAR that it was made with AI.

When using an AI coding agent:

1. Include the relevant parts of `AGENTS.md` in the prompt.
2. Require the agent to read governing local docs before coding.
3. Require official upstream docs and installed type verification for integrations.
4. Require tests before or alongside implementation.
5. Require real dependencies in production code.
6. Require documentation and traceability updates.
7. Require a report of commands run.
8. Review every generated line before opening the PR.

Do not submit AI-generated code that you cannot explain, validate, maintain, or support during review.

## Maintainer expectations

Maintainers may edit this guide as the repository evolves. When `AGENTS.md`, package scripts, architecture docs, or security procedures change, update this file in the same PR when contributor expectations change.

The goal is simple: every accepted contribution should be understandable, testable, secure, observable, aligned with the repository architecture, and kind to the next maintainer.
