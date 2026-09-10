import { fixedClock } from '@growth-os/types';
import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter, type RateLimitPolicy } from './index.js';

const policy: RateLimitPolicy = { limit: 10, windowSeconds: 60 };

describe('InMemoryRateLimiter', () => {
  it('allows up to the limit then denies', async () => {
    const limiter = new InMemoryRateLimiter(fixedClock(new Date('2026-01-01T00:00:00Z')));
    for (let i = 0; i < 10; i++) {
      expect((await limiter.consume('k', policy)).allowed).toBe(true);
    }
    const denied = await limiter.consume('k', policy);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refills continuously rather than in fixed windows', async () => {
    // A fixed window permits the whole quota at the end of one window and again at the
    // start of the next — a burst of twice the intended rate, exactly when a provider is
    // least tolerant of it.
    const clock = fixedClock(new Date('2026-01-01T00:00:00Z'));
    const limiter = new InMemoryRateLimiter(clock);

    for (let i = 0; i < 10; i++) await limiter.consume('k', policy);
    expect((await limiter.consume('k', policy)).allowed).toBe(false);

    // 6 seconds = one tenth of the window = one token.
    clock.advance(6_000);
    expect((await limiter.consume('k', policy)).allowed).toBe(true);
    expect((await limiter.consume('k', policy)).allowed).toBe(false);
  });

  it('never accumulates more than the limit while idle', async () => {
    const clock = fixedClock(new Date('2026-01-01T00:00:00Z'));
    const limiter = new InMemoryRateLimiter(clock);
    clock.advance(3_600_000);
    for (let i = 0; i < 10; i++) {
      expect((await limiter.consume('k', policy)).allowed).toBe(true);
    }
    expect((await limiter.consume('k', policy)).allowed).toBe(false);
  });

  it('reports a retryAfter a caller can actually wait on', async () => {
    const clock = fixedClock(new Date('2026-01-01T00:00:00Z'));
    const limiter = new InMemoryRateLimiter(clock);
    for (let i = 0; i < 10; i++) await limiter.consume('k', policy);

    const denied = await limiter.consume('k', policy);
    clock.advance(denied.retryAfterSeconds * 1000);
    expect((await limiter.consume('k', policy)).allowed).toBe(true);
  });

  it('keys are independent', async () => {
    const limiter = new InMemoryRateLimiter(fixedClock(new Date('2026-01-01T00:00:00Z')));
    for (let i = 0; i < 10; i++) await limiter.consume('connection-a', policy);
    expect((await limiter.consume('connection-a', policy)).allowed).toBe(false);
    expect((await limiter.consume('connection-b', policy)).allowed).toBe(true);
  });

  it('supports a cost greater than one', async () => {
    const limiter = new InMemoryRateLimiter(fixedClock(new Date('2026-01-01T00:00:00Z')));
    expect((await limiter.consume('k', policy, 10)).allowed).toBe(true);
    expect((await limiter.consume('k', policy, 1)).allowed).toBe(false);
  });
});
