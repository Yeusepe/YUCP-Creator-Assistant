import type { DeliveryManifest } from './deliveryManifest';

export type CachedManifest = {
  bindingRoot: string;
  body: string;
  manifest: DeliveryManifest;
  releaseRoot: string;
};

type StoredManifest = CachedManifest & { expiresAtMs: number };

export type BoundedManifestCacheOptions = {
  maxBodyBytes: number;
  maxEntries: number;
  now?: () => number;
  ttlMs: number;
};

// Delivery manifests are immutable per versionId in steady state; a republished
// manifest self-heals because callers compare the cached publication roots against
// the (signature-verified) delivery grant and reload from storage on mismatch.
// The TTL bounds how long a republished manifest can keep serving grants that
// were bound to it, and the entry cap bounds isolate memory alongside the byte
// budget (body length approximates bytes; parsed objects add a small multiple).
export class BoundedManifestCache {
  private readonly entries = new Map<string, StoredManifest>();
  private readonly maxBodyBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private totalBodyBytes = 0;
  private readonly ttlMs: number;

  constructor(options: BoundedManifestCacheOptions) {
    if (
      !Number.isSafeInteger(options.maxBodyBytes) ||
      options.maxBodyBytes <= 0 ||
      !Number.isSafeInteger(options.maxEntries) ||
      options.maxEntries <= 0 ||
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs <= 0
    ) {
      throw new Error('manifest cache bounds must be positive integers');
    }
    this.maxBodyBytes = options.maxBodyBytes;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs;
  }

  get(versionId: string): CachedManifest | undefined {
    const entry = this.entries.get(versionId);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAtMs <= this.now()) {
      this.delete(versionId);
      return undefined;
    }
    this.entries.delete(versionId);
    this.entries.set(versionId, entry);
    return entry;
  }

  set(versionId: string, entry: CachedManifest): void {
    this.delete(versionId);
    if (entry.body.length > this.maxBodyBytes) {
      return;
    }
    this.entries.set(versionId, {
      ...entry,
      expiresAtMs: this.now() + this.ttlMs,
    });
    this.totalBodyBytes += entry.body.length;
    for (const [key, existing] of this.entries) {
      if (this.totalBodyBytes <= this.maxBodyBytes && this.entries.size <= this.maxEntries) {
        break;
      }
      this.entries.delete(key);
      this.totalBodyBytes -= existing.body.length;
    }
  }

  delete(versionId: string): void {
    const entry = this.entries.get(versionId);
    if (entry) {
      this.entries.delete(versionId);
      this.totalBodyBytes -= entry.body.length;
    }
  }
}
