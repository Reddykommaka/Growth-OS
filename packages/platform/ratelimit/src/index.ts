/**
 * @growth-os/ratelimit — token-bucket port and an in-memory adapter.
 *
 * Used for API rate limits and, critically, for outbound provider quotas
 * (07-integration-architecture.md §4): a job waits on the bucket rather than failing, so a
 * provider limit costs latency instead of a dead-lettered publish.
 */
import type { Clock } from '@growth-os/types';
import { systemClock } from '@growth-os/types';

export interface RateLimitPolicy {
  /** Tokens available per window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the next token is available. Zero when allowed. */
  readonly retryAfterSeconds: number;
  readonly resetAt: Date;
}

export interface RateLimitPort {
  consume(key: string, policy: RateLimitPolicy, cost?: number): Promise<RateLimitDecision>;
  reset(key: string): Promise<void>;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Token bucket with continuous refill.
 *
 * Continuous rather than fixed-window: a fixed window lets a caller spend the whole quota
 * in the last instant of one window and again in the first instant of the next, producing
 * a burst of twice the intended rate exactly when a provider is least tolerant of it.
 */
export class InMemoryRateLimiter implements RateLimitPort {
  readonly #buckets = new Map<string, Bucket>();
  readonly #clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  async consume(key: string, policy: RateLimitPolicy, cost = 1): Promise<RateLimitDecision> {
    const nowMs = this.#clock.now().getTime();
    const refillPerMs = policy.limit / (policy.windowSeconds * 1000);

    const bucket = this.#buckets.get(key) ?? { tokens: policy.limit, lastRefillMs: nowMs };
    const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(policy.limit, bucket.tokens + elapsed * refillPerMs);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.#buckets.set(key, bucket);
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterSeconds: 0,
        resetAt: new Date(nowMs + ((policy.limit - bucket.tokens) / refillPerMs || 0)),
      };
    }

    this.#buckets.set(key, bucket);
    const deficit = cost - bucket.tokens;
    const waitMs = Math.ceil(deficit / refillPerMs);
    return {
      allowed: false,
      remaining: Math.floor(bucket.tokens),
      retryAfterSeconds: Math.ceil(waitMs / 1000),
      resetAt: new Date(nowMs + waitMs),
    };
  }

  async reset(key: string): Promise<void> {
    this.#buckets.delete(key);
  }

  clear(): void {
    this.#buckets.clear();
  }
}
