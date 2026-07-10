# Self-hosted Convex deploy gate

`bun run test:convex:deploy` provisions the self-hosted Convex deployment with
the shared real-backend env file, runs the required-env preflight, then runs the
actual `bun x convex deploy -y` command. It deliberately exercises analysis,
bundle generation, codegen, schema, and index deployment.

The production Zeabur image pipeline must run the same preflight after it syncs
the target deployment env and immediately before `bun x convex deploy`. This
turns a missing deployed secret into a clear preflight error instead of a later
`InvalidModules` deploy-analysis failure.

The Docker backend and dashboard are pinned to the matching immutable digests
for Convex revision `1bd6910bc0b4066a918809912670d42afc8fdfb0`. The gate is
therefore reproducible and does not silently pull a changed upstream image.

`bun run test:convex:images:freshness` compares those pins with the published
`latest` manifests. It runs in a separate scheduled workflow, rather than PR
CI, and fails when either image has moved so the pair can be reviewed and bumped
deliberately. The deploy command leaves Convex codegen and TypeScript checking
enabled, so an internal component function used through `components.*` fails
this local gate before merge.
