// Test-only Worker globals. Production bindings come from Wrangler-generated types.
type Env = Record<string, unknown>;

interface R2ObjectBody {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
}

interface CacheStorage {
  readonly default: Cache;
}

interface ExportedHandler<Environment> {
  fetch(request: Request, env: Environment): Response | Promise<Response>;
}
