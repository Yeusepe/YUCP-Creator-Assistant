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

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ExportedHandler<TEnvironment> {
  fetch(request: Request, env: TEnvironment): Response | Promise<Response>;
}
