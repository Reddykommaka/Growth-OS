import { fixedClock } from '@growth-os/types';
import { describe, expect, it } from 'vitest';
import { InMemoryCache } from './index.js';

describe('InMemoryCache', () => {
  it('stores and retrieves a value', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', { a: 1 });
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });
  });

  it('returns null for a miss — a miss is always a legal outcome', async () => {
    expect(await new InMemoryCache().get('absent')).toBeNull();
  });

  it('expires an entry once its TTL has passed', async () => {
    // Time is injected, so expiry is tested without sleeping.
    const clock = fixedClock(new Date('2026-01-01T00:00:00Z'));
    const cache = new InMemoryCache(clock);
    await cache.set('k', 'v', 60);

    clock.advance(59_000);
    expect(await cache.get('k')).toBe('v');

    clock.advance(2_000);
    expect(await cache.get('k')).toBeNull();
  });

  it('treats a TTL-less entry as permanent', async () => {
    const clock = fixedClock(new Date('2026-01-01T00:00:00Z'));
    const cache = new InMemoryCache(clock);
    await cache.set('k', 'v');
    clock.advance(86_400_000);
    expect(await cache.get('k')).toBe('v');
  });

  it('deletes by prefix for eager invalidation', async () => {
    // How a role or membership change invalidates every cached permission set for a tenant
    // (06-identity-and-access.md §3).
    const cache = new InMemoryCache();
    await cache.set('perm:org1:user1', ['a']);
    await cache.set('perm:org1:user2', ['b']);
    await cache.set('perm:org2:user3', ['c']);

    await cache.deletePrefix('perm:org1:');

    expect(await cache.get('perm:org1:user1')).toBeNull();
    expect(await cache.get('perm:org1:user2')).toBeNull();
    expect(await cache.get('perm:org2:user3')).toEqual(['c']);
  });

  it('reports has() correctly across expiry', async () => {
    const clock = fixedClock(new Date('2026-01-01T00:00:00Z'));
    const cache = new InMemoryCache(clock);
    await cache.set('k', 1, 10);
    expect(await cache.has('k')).toBe(true);
    clock.advance(11_000);
    expect(await cache.has('k')).toBe(false);
  });
});
