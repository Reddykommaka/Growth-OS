/**
 * @growth-os/cache — cache port and an in-memory adapter.
 *
 * Redis is never a system of record (02-technology-stack.md §4): losing it costs
 * throughput, not data. That is a design constraint on every consumer, and the port makes
 * it explicit — a cache miss is always a legal outcome.
 *
 * The in-memory adapter exists because the test environment has no Redis server
 * (00-assessment.md §2), so unit and integration tests must be able to exercise
 * cache-dependent code without one.
 */
import type { Clock } from '@growth-os/types';
import { systemClock } from '@growth-os/types';

export interface CachePort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes every key under a prefix — used for eager invalidation on a role change. */
  deletePrefix(prefix: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

interface Entry {
  readonly value: unknown;
  readonly expiresAtMs: number | null;
}

/**
 * In-memory cache with real TTL semantics.
 *
 * Time comes from an injected Clock so a test can advance it rather than sleeping; a suite
 * that sleeps to test expiry is slow and flaky.
 */
export class InMemoryCache implements CachePort {
  readonly #entries = new Map<string, Entry>();
  readonly #clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  #live(key: string): Entry | null {
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.#clock.now().getTime()) {
      this.#entries.delete(key);
      return null;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.#live(key);
    return entry === null ? null : (entry.value as T);
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.#entries.set(key, {
      value,
      expiresAtMs:
        ttlSeconds === undefined ? null : this.#clock.now().getTime() + ttlSeconds * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }

  async has(key: string): Promise<boolean> {
    return this.#live(key) !== null;
  }

  /** Test helper: number of live entries. */
  get size(): number {
    for (const key of [...this.#entries.keys()]) this.#live(key);
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}
