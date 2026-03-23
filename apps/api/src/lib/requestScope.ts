type RequestScopeStore = Map<string, Promise<unknown>>;

const requestScopeStores = new WeakMap<Request, RequestScopeStore>();

function getRequestScopeStore(request: Request): RequestScopeStore {
  let store = requestScopeStores.get(request);
  if (!store) {
    store = new Map<string, Promise<unknown>>();
    requestScopeStores.set(request, store);
  }
  return store;
}

function normalizeCacheKeyPart(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(normalizeCacheKeyPart);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeCacheKeyPart(entryValue)])
    );
  }
  return value;
}

export function requestScopeKey(namespace: string, key?: unknown): string {
  if (key === undefined) {
    return namespace;
  }

  return `${namespace}:${JSON.stringify(normalizeCacheKeyPart(key))}`;
}

/**
 * Memoize and coalesce identical async work for a single Request object.
 * Callers that arrive while the first load is still in flight join the same promise.
 */
export function loadRequestScoped<T>(
  request: Request,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const store = getRequestScopeStore(request);
  const existing = store.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const pending = Promise.resolve()
    .then(load)
    .catch((error) => {
      if (store.get(key) === pending) {
        store.delete(key);
      }
      throw error;
    });

  store.set(key, pending);
  return pending;
}
