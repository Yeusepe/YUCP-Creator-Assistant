# API Versioning Policy

This document defines the rules all engineers must follow when changing API contracts. The goal is to prevent **version skew** — the period after a deployment where old web clients are still talking to the new server (or vice-versa).

---

## The Problem: Version Skew

When a new version of the app is deployed:

- Old browser sessions still have the previous JS bundle loaded
- The new server may have changed request/response shapes
- If the change is not backward-compatible, old clients will break

Big platforms (Stripe, Google, Amazon) all have explicit policies to manage this. Ours follows the same proven patterns.

---

## Rules

### 1. All field additions must be optional

You may **never** add a required field to an existing request body or response body in the same release as the code that depends on it.

Correct two-phase approach:
1. **Phase 1**: Ship the server change with the new field marked optional, with a sensible default.
2. **Wait** for the phase-1 deployment to complete and its rollback window to pass.
3. **Phase 2**: Ship client code that sends/expects the new field.

### 2. Fields are never removed within a minor version

If you want to remove a field:
1. Mark it `@deprecated` in the TypeScript type and in a JSDoc comment.
2. Keep it functional for at least one full release cycle.
3. Remove it only after confirming no client sends or reads it.

### 3. New request shapes must be additive

Do not change the *meaning* of an existing field. If you must change semantics, add a new field and deprecate the old one.

**Bad:**
```typescript
// Before: mode = "strict" | "loose"
// After: mode = "strict" | "loose" | "off"   ← fine (additive)
// After: mode = "enabled" | "disabled"        ← BAD: breaks old clients that send "strict"
```

### 4. HTTP status codes are stable

Do not change the HTTP status code returned by an existing endpoint. Old clients may have specific `if (res.status === 200)` checks.

### 5. Route paths are stable

Do not rename or remove route paths without a deprecation period. If you must restructure, add the new path while keeping the old path serving compatible behavior or redirecting with the route-appropriate status code until callers migrate. In this repo, browser verification and frontend handoff flows currently use `302`, so do not hard-code a `301` rule into new compatibility guidance.

### 6. Error response shapes are stable

Do not swap an existing endpoint onto a different error envelope in the same release.

Preserve the established envelope family for that endpoint:

- `{ success: false, error, supportCode? }` stays that shape
- `{ error, details? }` stays that shape
- new optional fields are fine when they are additive

What must stay stable is the envelope each caller already parses, not one universal repo-wide error object.

---

## Version Skew Detection

The web app mounts a version poller at the root, not only on the dashboard. While the browser tab is visible, it polls `GET /api/version` every 5 minutes. When the `buildId` changes, users see a persistent `Update ready` toast with the description `Reload to use the latest version.` and a `Reload` action.

This covers the gap between deployment and the user reloading. During this window, the above rules ensure the old client still works correctly with the new server.

---

## Repo-specific contract workflow

In this repo, versioning policy applies to both public HTTP routes and the Bebop-backed private RPC contract shared by the API, bot, and web packages.

When you change `.bop` schema files or private-RPC payload shapes:

1. make the contract change additively first
2. run `bun run bebop:regenerate`
3. commit the regenerated `packages/private-rpc/src/generated.ts`
4. run `bun run typecheck`

`bun run typecheck` starts with `contracts:check`, then runs the workspace TypeScript build plus the app package typechecks. If `contracts:check` fails, the generated Bebop output is stale and must be regenerated before the change is safe to ship.

---

## Reference

- [Stripe API versioning](https://stripe.com/docs/api/versioning)
- [Google protobuf field rules](https://protobuf.dev/programming-guides/proto3/#updating)
- [Version Skew — Industrial Empathy](https://www.industrialempathy.com/posts/version-skew/)
- [Vercel Skew Protection](https://vercel.com/docs/deployments/skew-protection)
