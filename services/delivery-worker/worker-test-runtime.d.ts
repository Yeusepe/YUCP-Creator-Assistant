// Test-only Worker globals. Production bindings come from Wrangler-generated types.
type Env = {};

interface CacheStorage {
  readonly default: Cache;
}

interface ExportedHandler<Environment> {
  fetch(request: Request, env: Environment): Response | Promise<Response>;
}
