export class TtlCache<K, V> {
  private readonly entries = new Map<K, { expiresAt: number; value: V }>();

  constructor(private readonly maxEntries: number) {}

  get(key: K, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number, now = Date.now()): void {
    this.sweepExpired(now);
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { expiresAt: now + ttlMs, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  private sweepExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
