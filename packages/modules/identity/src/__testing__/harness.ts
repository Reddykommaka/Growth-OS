/**
 * Shared wiring for the identity integration suites.
 *
 * Builds the real services over real PostgreSQL repositories — no mocks for anything that
 * touches a security boundary. The only substituted pieces are the clock (so expiry is
 * testable without waiting) and an in-memory audit sink (platform/audit is a later work
 * item; the port exists so the services are already recording).
 */
import { createSecretCipher, generateSecretKey } from '@growth-os/authn';
import type { Pool } from 'pg';
import type { AuditEntry, AuditSink, AuthRateLimiter, Clock } from '../application/ports.js';
import {
  createMfaRepository,
  createSessionRepository,
  createUserRepository,
  createUserTokenRepository,
} from '../infrastructure/index.js';

/** A clock the test drives, so expiry and lockout windows do not require real waiting. */
export class TestClock implements Clock {
  private current: Date;
  constructor(start = new Date('2026-09-15T12:00:00.000Z')) {
    this.current = start;
  }
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(at: Date): void {
    this.current = at;
  }
}

export class RecordingAuditSink implements AuditSink {
  readonly events: AuditEntry[] = [];
  async record(event: AuditEntry): Promise<void> {
    this.events.push(event);
  }
  actions(): string[] {
    return this.events.map((e) => e.action);
  }
  find(action: string): AuditEntry | undefined {
    return this.events.find((e) => e.action === action);
  }
  clear(): void {
    this.events.length = 0;
  }
}

/** A counting limiter, so the rate-limited paths are exercised rather than assumed. */
export class CountingRateLimiter implements AuthRateLimiter {
  private readonly counts = new Map<string, number>();
  constructor(private readonly limit: number) {}
  async consume(key: string): Promise<boolean> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next <= this.limit;
  }
  async reset(key: string): Promise<void> {
    this.counts.delete(key);
  }
}

export function buildIdentity(pool: Pool) {
  const clock = new TestClock();
  const audit = new RecordingAuditSink();
  const cipher = createSecretCipher(generateSecretKey());
  return {
    clock,
    audit,
    cipher,
    users: createUserRepository(pool),
    sessions: createSessionRepository(pool),
    tokens: createUserTokenRepository(pool),
    mfa: createMfaRepository(pool),
  };
}

export type IdentityHarness = ReturnType<typeof buildIdentity>;
