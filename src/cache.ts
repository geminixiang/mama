/**
 * In-memory resource cache with TTL expiry.
 *
 * Used to avoid redundant disk reads (memory files, skills) on every agent run.
 * With 200 concurrent users each triggering getMemory() + loadMamaSkills() on
 * every request, an uncached approach results in 400+ disk reads per request
 * batch. A 30-second TTL reduces this to at most ~2 reads per 30-second window
 * per channel.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class ResourceCache {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly ttlMs: number;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Remove a specific key immediately (e.g. after a write operation). */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** Remove all keys that start with the given prefix. */
  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Number of currently live (non-expired) entries. */
  size(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.cache.values()) {
      if (now <= entry.expiresAt) count++;
    }
    return count;
  }
}

/**
 * Singleton workspace-level cache shared across ALL runners in the process.
 * Skills and memory files are workspace/channel-scoped, so sharing across
 * threads is safe as long as invalidation happens after writes.
 */
export const globalResourceCache = new ResourceCache(30_000);

/** Replace the TTL on the global cache (call before any runners are created). */
export function configureResourceCache(ttlMs: number): void {
  // Reconstruct with new TTL — existing entries will expire naturally.
  Object.assign(globalResourceCache, new ResourceCache(ttlMs));
}
