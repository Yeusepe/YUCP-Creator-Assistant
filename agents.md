# Agent Instructions

`agents.md` is your memory.

## CI Checks — What GitHub Runs and How to Run Locally

GitHub CI runs four jobs on every push/PR to `main` or `develop`. **Before finishing any task, all four must pass locally.**

### 1. Lint (`bun audit` + `bun run lint`)

Checks for security vulnerabilities in dependencies and runs the Biome linter across all packages.

```bash
bun audit
bun run lint
```

- `bun audit` fails if any dependency has a known vulnerability. Fix by updating the `overrides` in the root `package.json` to a patched version, then run `bun install`.
- `bun run lint` runs `biome check` in every workspace. Formatting errors can be auto-fixed with `bun run --filter '*' lint:fix`. Lint rule errors must be fixed manually.

### 2. Type Check (`bun run typecheck`)

Checks that the generated Bebop RPC contract is up to date, then runs the repo TypeScript build and the explicit app package typechecks.

```bash
bun run typecheck
```

- If the `contracts:check` step fails, the schema `.bop` files have changed but `packages/private-rpc/src/generated.ts` was not regenerated. Fix it by running:
  ```bash
  bun run bebop:regenerate
  ```
  Then commit the updated `src/generated.ts`.
- `bun run typecheck` currently runs `bun run contracts:check`, `tsc -b tsconfig.solution.json --pretty false`, and the package `typecheck` scripts for `@yucp/api`, `@yucp/bot`, and `@yucp/web`.
- Convex realtest compilation stays under `bun run test:convex`, not under `bun run typecheck`.

### 3. External integration contracts (`bun run test:external-integrations`)

Runs the focused external-integration regression bundle defined in `ops/production-regression-loop.ts` plus the API internal RPC normalization test.

```bash
bun run test:external-integrations
```

- Provider and consumer coverage includes `ops/provider-live-smoke.test.ts`, provider module contracts, `apps/api/src/routes/packages.backstage.test.ts`, `apps/bot/test/lib/setupCatalog.test.ts`, and `apps/bot/test/commands/autosetup.test.ts`.
- API identity, verification, and backfill coverage includes `apps/api/src/verification/hostedIntents.test.ts`, `apps/api/src/lib/subjectIdentity.test.ts`, `apps/api/src/routes/connect.user-verify.manual-license.test.ts`, `apps/api/src/routes/providerPlatform.test.ts`, `apps/api/src/routes/connectUserVerification.readSurface.test.ts`, `apps/api/src/routes/connect.user-verify.behavior.test.ts`, `apps/api/src/routes/backfill.test.ts`, and `apps/api/src/verification/completeLicense.test.ts`.
- Web consumer coverage includes `apps/web/test/unit/account-connections.test.tsx`, `apps/web/test/unit/dashboard-connected-platforms.test.tsx`, `apps/web/test/unit/store-integrations-status-label.test.tsx`, and `apps/web/test/unit/purchase-verification-ui-state.test.ts`.
- RPC normalization still lives in `apps/api/src/internalRpc/router.test.ts`.
- Live smoke stays out of this gate. Keep `bun run smoke:providers` for manual or separately scheduled drift checks only.

### 4. Tests (`bun run test:ci`)

Runs `test:ops` first, then the fast CI package suites from `test:fast:ci`.

```bash
bun run test:ci
```

- `test:ops` covers the repo-level ops and regression harness tests under `./ops`.
- `test:fast:ci` currently runs the `test:ci` scripts for `@yucp/api`, `@yucp/application`, `@yucp/policy`, `@yucp/providers`, and `@yucp/shared`.
- `bun run test:ci` does not include a Convex compile gate. Keep Convex coverage under `bun run test:convex`.

Additional test suites (not part of CI fast path, but should pass before merging):

```bash
bun run test:all            # all fast + convex + integration + bot tests
bun run test:convex         # Convex realtest typecheck + backend tests (requires vitest)
bun run test:api:integration # API integration tests
bun run test:bot            # Bot command tests
```

### Pre-Finish Checklist

Before considering any task complete, run and verify all four CI checks pass:

```bash
bun audit                   # no vulnerabilities
bun run lint                # no errors (warnings are OK)
bun run typecheck           # exits 0
bun run test:external-integrations
bun run test:ci             # 0 fail across ops + fast CI package suites
```

---

## Bug Fixes — TDD Workflow

When fixing a bug, **always follow this order**:

1. **Write a failing test first.** Before touching any production code, write a test that reproduces the bug and confirm it fails for the right reason.
2. **Understand the failure.** Read the test output. Make sure the failure message matches the reported bug, not a different error.
3. **Implement the fix.** Only after the failing test is in place, modify production code to make it pass.
4. **Verify the test now passes.** Run the test again and confirm it goes green.
5. **Run the full suite.** Make sure no existing tests regressed.

This order is non-negotiable. Do not write the fix before writing the test.

## Production issue -> invariant -> regression loop

For any production incident in provider, identity, verification, account, or backfill surfaces:

1. write the broken invariant into `ops/production-regression-loop.ts`
2. add the failing regression in the listed primary contract home
3. add the nearest consumer regression so the user-visible symptom cannot return silently
4. add the listed remediation or Convex regression if persisted bad state is possible
5. run `bun run test:external-integrations`

Do not close the incident with a consumer-only test. The contract boundary and the public symptom must both stay covered.

## Prioritize architecture over ease of programming:
    - Design for extensibility — new features should slot in cleanly without touching existing code
    - Prefer modularity: clear separation of concerns, single-responsibility components
    - Favor patterns that let me "add and forget" (open/closed principle)
    - Avoid shortcuts that couple things unnecessarily or make future changes hard
    - If there are two approaches, choose the one with better long-term structure, even if more verbose now
    - Avoid baking values, make it as nicely extensible as possible.
    - If unsure, always search online for architecture tips, or how big companies (spotify, stripe, and more) do so.
    - If I ask about bleeding edge, search the latest of the latest. Tech that has come out in the past few months, or has had substantial new updates. Search research papers too.

# This is something very important that I NEED you to internalize. NEVER EVER, AND I MEAN EVER MOCK FUNCTIONALITY OR STUB IT. I would rather it ERROR than having a stub. NEVER MAKE STUBS. The ONLY allowable mock is in tests. And even in there, prefer running the whole thing than subbing functionality. Stubs are a terrible coding practice. 

# DO NOT TOUCH GITHUB UNLESS THE USER INSTRUCTS YOU TO.

## NEVER IMPLEMENT WORKAROUNDS:

A workaround is a change that produces the correct output for now but violates the architecture, bypasses the proper system, or creates hidden dependencies that will break later. Workarounds are NEVER acceptable. If you find yourself writing one, stop and design the proper solution.

Signs you are writing a workaround:
- You are special-casing a single provider/entity instead of using the general system
- You are reading data that "happens to be there" (e.g., buyer sessions) instead of the right source (e.g., creator sessions)
- You are duplicating logic that already exists somewhere else rather than calling it
- You are using a `"use node"` directive, a flag, or a conditional just to avoid a proper architectural change
- Your change works today but would silently break if the system around it changes

The correct response to a workaround situation is always: **design the proper flow, implement it properly, test it properly.**

## Security Principles (Stripe-aligned)

These apply to every provider that stores third-party credentials:

1. **Never log credential values.** Tokens, keys, passwords, and session values must NEVER appear in logs. Log the key name or a redacted placeholder (e.g., `[REDACTED]`), not the value.
2. **Encrypt credentials at rest.** Use HKDF with domain-separated purpose strings (e.g., `'gumroad-oauth-access-token'`, `'vrchat-creator-session'`) so each credential type has its own encryption context.
3. **Principle of least privilege.** Store only what is needed. Do not copy credentials to additional fields or pass them through layers that do not need them.
4. **Decrypt at use time only.** Credentials should be decrypted within the request that needs them and not held in memory beyond that request.
5. **Handle credential expiry explicitly.** When an API returns 401, detect this as credential expiry, mark the connection as `'degraded'` in Convex, and surface a reconnect prompt to the user. Do not silently swallow the error.
6. **Audit log connect/disconnect/expiry events.** Log who connected, when, and what changed, but always redact token values.

## External API Reference Rule

For ANY external API call (VRChat, Discord, Gumroad, Jinxxy, etc.), you MUST:

1. **Cite the documentation URL** in the code comment or in this plan before writing any code.
2. **Verify the endpoint is correct BEFORE implementing** — check the official or community spec (e.g., [vrchat.community/reference](https://vrchat.community/reference), [Discord API docs](https://discord.com/developers/docs)).
3. **Verify again AFTER implementing** — confirm the response shape matches what the code expects.

Never assume an endpoint path. Always look it up. A wrong endpoint path (e.g., `/products/listings` vs `/user/{userId}/listings`) wastes significant time and produces bugs that are hard to diagnose.

## Analytics-First Implementation Rule

The analytics and tracing we implemented are part of the architecture now, not an optional extra.

1. Every new request path, mutation, action, webhook, background job, verification flow, and provider integration should preserve or extend the existing analytics path so the work can be traced end-to-end.
2. When touching existing flows, prefer wiring them back into the shared observability utilities instead of adding isolated logic that bypasses tracing, timing, or correlated diagnostics.
3. If a change creates a new boundary between systems, propagate the trace context across that boundary and emit the relevant spans, timing, or diagnostics through the existing analytics stack.
4. Do not remove, bypass, or silently degrade analytics coverage unless the user explicitly asks for that tradeoff.
5. When choosing between equivalent implementations, prefer the one that keeps behavior observable in HyperDX/OpenTelemetry so debugging always leads back to analytics.

# When writing anything, avoid em dashes. If emojies are needed, use included graphics first then emojies. Never add emojies to logs or the backend code.

# Do not write provider specific code outside of plugins folder and their systems. Everything has to be extensible, and generic.
# This includes OAuth callback handling, buyer-link credential storage, entitlement materialization, verification checks, and any provider API semantics. Main routes and shared UI may orchestrate provider hooks, but they must not branch on individual providers or embed provider response handling inline.

## UI / Design System Rules

### Dark / Light Mode Rule
Every CSS class that sets a background color, border color, or text color **must** have a `.dark` counterpart. When you add a new styled class, always add the dark variant immediately after the light-mode rule. No exceptions.

### Async pending state (controls)
Any control that triggers async work must show a **visible pending state** while work is in flight (spinner, progress, or skeleton, whichever fits the control).

- Prefer **YucpButton** (`apps/web/src/components/ui/YucpButton.tsx`) with `isLoading` for HeroUI-backed buttons, or the shared `.btn-loading` / `.btn-loading-spinner` utilities from dashboard styles for legacy/native `<button>` markup.
- For primarily text buttons, use present-progressive copy when it helps ("Saving..."). Do not leave a control `disabled` with no indication of activity.

### Side-Color Rule
Never use colored side borders (e.g., `border-left: 3px solid green`) as status indicators on UI elements like cards, rows, or list items. Side-color accents are only acceptable inside selection controls (e.g., active tab indicators, selected sidebar items). For status indication, use text color, badges, or icon color instead.
Server icons must **never** be rendered as circles (`border-radius: 50%`). Use `border-radius: 8px` for 24px+ icons and `border-radius: 4px` for smaller ones (14-20px). User/collaborator avatars may remain circular.

## Laws of UX (reference)

[Laws of UX](https://lawsofux.com/) collects interface heuristics. Use them when proposing or reviewing UI. They inform judgment; they do not replace product requirements. Full articles: [lawsofux.com](https://lawsofux.com/).

**Aesthetic-Usability Effect:** Users often perceive aesthetically pleasing design as design that is more usable.

**Choice Overload:** The tendency for people to get overwhelmed when they are presented with a large number of options, often used interchangeably with the term paradox of choice.

**Chunking:** A process by which individual pieces of an information set are broken down and then grouped together in a meaningful whole.

**Cognitive Bias:** A systematic error of thinking or rationality in judgment that influence our perception of the world and our decision-making ability.

**Cognitive Load:** The amount of mental resources needed to understand and interact with an interface.

**Doherty Threshold:** Productivity soars when a computer and its users interact at a pace (under 400ms) that ensures that neither has to wait on the other.

**Fitts's Law:** The time to acquire a target is a function of the distance to and size of the target.

**Flow:** The mental state in which a person performing some activity is fully immersed in a feeling of energized focus, full involvement, and enjoyment in the process of the activity.

**Goal-Gradient Effect:** The tendency to approach a goal increases with proximity to the goal.

**Hick's Law:** The time it takes to make a decision increases with the number and complexity of choices.

**Jakob's Law:** Users spend most of their time on other sites. This means that users prefer your site to work the same way as all the other sites they already know.

**Law of Common Region:** Elements tend to be perceived into groups if they are sharing an area with a clearly defined boundary.

**Law of Proximity:** Objects that are near, or proximate to each other, tend to be grouped together.

**Law of Prägnanz:** People will perceive and interpret ambiguous or complex images as the simplest form possible, because it is the interpretation that requires the least cognitive effort of us.

**Law of Similarity:** The human eye tends to perceive similar elements as a complete picture, shape, or group, even if those elements are separated.

**Law of Uniform Connectedness:** Elements that are visually connected are perceived as more related than elements with no connection.

**Mental Model:** A compressed model based on what we think we know about a system and how it works.

**Miller's Law:** The average person can only keep 7 (plus or minus 2) items in their working memory.

**Occam's Razor:** Among competing hypotheses that predict equally well, the one with the fewest assumptions should be selected.

**Paradox of the Active User:** Users never read manuals but start using the software immediately.

**Pareto Principle:** The Pareto principle states that, for many events, roughly 80% of the effects come from 20% of the causes.

**Parkinson's Law:** Any task will inflate until all of the available time is spent.

**Peak-End Rule:** People judge an experience largely based on how they felt at its peak and at its end, rather than the total sum or average of every moment of the experience.

**Postel's Law:** Be liberal in what you accept, and conservative in what you send.

**Selective Attention:** The process of focusing our attention only to a subset of stimuli in an environment, usually those related to our goals.

**Serial Position Effect:** Users have a propensity to best remember the first and last items in a series.

**Tesler's Law:** Tesler's Law, also known as The Law of Conservation of Complexity, states that for any system there is a certain amount of complexity which cannot be reduced.

**Von Restorff Effect:** The Von Restorff effect, also known as The Isolation Effect, predicts that when multiple similar objects are present, the one that differs from the rest is most likely to be remembered.

**Working Memory:** A cognitive system that temporarily holds and manipulates information needed to complete tasks.

**Zeigarnik Effect:** People remember uncompleted or interrupted tasks better than completed tasks.

## Learned User Preferences

- Make loading skeletons representative of the final page structure instead of generic placeholders, especially in dashboard and account flows.
- In UI redesigns, prioritize responsive layouts and clear hierarchy; the `/account/security` page is a strong reference for the broader product direction.

## Learned Workspace Facts

- Deprecation warnings naming Better Auth's `oidc-provider` plugin on `/api/auth/get-session` can come from `@convex-dev/better-auth` internally using the legacy `oidcProvider` helper, not only from app-level `oauthProvider` configuration.
