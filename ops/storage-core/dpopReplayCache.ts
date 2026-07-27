export interface BoundedDpopReplayCacheOptions {
  maxEntries: number;
  sweepLimit: number;
}

export class BoundedDpopReplayCache {
  readonly #expirations = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #sweepLimit: number;

  constructor(options: BoundedDpopReplayCacheOptions) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.sweepLimit) || options.sweepLimit <= 0) {
      throw new RangeError('sweepLimit must be a positive safe integer');
    }
    this.#maxEntries = options.maxEntries;
    this.#sweepLimit = options.sweepLimit;
  }

  get size(): number {
    return this.#expirations.size;
  }

  reserve(input: { expiresAtMs: number; key: string; nowMs?: number }): boolean {
    const nowMs = input.nowMs ?? Date.now();
    if (
      !input.key ||
      !Number.isFinite(nowMs) ||
      !Number.isFinite(input.expiresAtMs) ||
      input.expiresAtMs <= nowMs
    ) {
      return false;
    }

    const existingExpiration = this.#expirations.get(input.key);
    if (existingExpiration !== undefined) {
      if (existingExpiration > nowMs) {
        return false;
      }
      this.#expirations.delete(input.key);
    }

    let inspected = 0;
    for (const [key, expiration] of this.#expirations) {
      if (expiration <= nowMs) {
        this.#expirations.delete(key);
      }
      inspected += 1;
      if (inspected >= this.#sweepLimit) {
        break;
      }
    }
    while (this.#expirations.size >= this.#maxEntries) {
      const oldestKey = this.#expirations.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.#expirations.delete(oldestKey);
    }
    this.#expirations.set(input.key, input.expiresAtMs);
    return true;
  }
}
