/**
 * Simple in-memory TTL cache.
 * Critical for staying within Klaviyo reporting rate limits (1/s burst, 2/m steady).
 */
export class TTLCache<T> {
  private cache = new Map<string, { value: T; expires: number }>();

  /**
   * @param defaultTTL Default time-to-live in milliseconds
   */
  constructor(private defaultTTL: number) {}

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttl?: number): void {
    this.cache.set(key, {
      value,
      expires: Date.now() + (ttl ?? this.defaultTTL),
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    // Clean expired entries before reporting size
    for (const [key, entry] of this.cache) {
      if (Date.now() > entry.expires) {
        this.cache.delete(key);
      }
    }
    return this.cache.size;
  }
}

/**
 * Build a stable cache key from an endpoint and params object.
 * Sorts keys to ensure consistent ordering.
 */
export function buildCacheKey(
  endpoint: string,
  params: Record<string, unknown>,
): string {
  const sorted = Object.keys(params)
    .sort()
    .reduce(
      (acc, key) => {
        acc[key] = params[key];
        return acc;
      },
      {} as Record<string, unknown>,
    );
  return `${endpoint}:${JSON.stringify(sorted)}`;
}
