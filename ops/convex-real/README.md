# Self-hosted Convex deploy gate

`bun run test:convex:deploy` provisions the self-hosted Convex deployment with
the shared real-backend env file, runs the required-env preflight, then runs the
actual `bun x convex deploy -y` command. It deliberately exercises analysis,
bundle generation, codegen, schema, and index deployment.

The production Zeabur image pipeline must run the same preflight after it syncs
the target deployment env and immediately before `bun x convex deploy`. This
turns a missing deployed secret into a clear preflight error instead of a later
`InvalidModules` deploy-analysis failure.
