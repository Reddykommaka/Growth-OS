/**
 * Session lifetime and cookie policy.
 *
 * These rules decide how long a compromised session stays useful and how quickly a
 * revocation takes effect, so each is asserted rather than left to the shape of the code.
 */
import { describe, expect, it } from 'vitest';
import {
  impersonationExpiry,
  MAX_IMPERSONATION_MS,
  REAUTH_WINDOW_MS,
  renewedExpiry,
  requiresReauthentication,
  SESSION_ABSOLUTE_MS,
  SESSION_SLIDING_MS,
  type SessionRecord,
  sessionCookie,
  sessionState,
  startSession,
} from './sessions.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const ms = (n: number) => n;

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    expiresAt: new Date(NOW.getTime() + SESSION_SLIDING_MS),
    absoluteExpiresAt: new Date(NOW.getTime() + SESSION_ABSOLUTE_MS),
    revokedAt: null,
    mfaSatisfiedAt: NOW,
    ...overrides,
  };
}

describe('starting a session', () => {
  it('issues a token and both expiries', () => {
    const started = startSession(NOW);
    expect(started.token).toHaveLength(43);
    expect(started.expiresAt.getTime()).toBe(NOW.getTime() + SESSION_SLIDING_MS);
    expect(started.absoluteExpiresAt.getTime()).toBe(NOW.getTime() + SESSION_ABSOLUTE_MS);
  });

  it('sets the sliding expiry inside the absolute one', () => {
    const started = startSession(NOW);
    expect(started.expiresAt.getTime()).toBeLessThan(started.absoluteExpiresAt.getTime());
  });

  it('uses 30 and 90 days, per 06 §2', () => {
    expect(SESSION_SLIDING_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(SESSION_ABSOLUTE_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });
});

describe('classification', () => {
  it('reports an ordinary session as active', () => {
    expect(sessionState(session(), NOW)).toBe('active');
  });

  /**
   * Revocation is checked BEFORE expiry, and separately. Firing an employee must end access
   * now; a revoked-but-unexpired session reading as active for even one request is the
   * failure that makes server-side sessions worth their cost over a JWT.
   */
  it('reports a revoked session as revoked, even while otherwise valid', () => {
    expect(sessionState(session({ revokedAt: new Date(NOW.getTime() - 1) }), NOW)).toBe('revoked');
  });

  it('honours a revocation timestamped exactly now', () => {
    expect(sessionState(session({ revokedAt: NOW }), NOW)).toBe('revoked');
  });

  it('reports a lapsed sliding window as expired', () => {
    expect(sessionState(session({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe('expired');
  });

  it('reports a lapsed absolute ceiling distinctly from a sliding expiry', () => {
    const state = sessionState(
      session({
        expiresAt: new Date(NOW.getTime() + ms(1000)),
        absoluteExpiresAt: new Date(NOW.getTime() - 1),
      }),
      NOW,
    );
    // Distinct because the remedies differ: an expired session can be renewed by activity,
    // an absolute-expired one requires signing in again.
    expect(state).toBe('absolute_expired');
  });

  it('reports a lapsed impersonation window', () => {
    expect(
      sessionState(session({ impersonationExpiresAt: new Date(NOW.getTime() - 1) }), NOW),
    ).toBe('impersonation_expired');
  });

  it('ignores impersonation fields on an ordinary session', () => {
    expect(sessionState(session({ impersonationExpiresAt: null }), NOW)).toBe('active');
  });
});

describe('sliding renewal', () => {
  it('does not renew a session that was just issued', () => {
    expect(renewedExpiry(session(), NOW)).toBeUndefined();
  });

  it('renews one that has aged past the threshold', () => {
    const aged = session({
      expiresAt: new Date(NOW.getTime() + SESSION_SLIDING_MS - 2 * 60 * 60 * 1000),
    });
    expect(renewedExpiry(aged, NOW)?.getTime()).toBe(NOW.getTime() + SESSION_SLIDING_MS);
  });

  /**
   * The property that makes "absolute" mean something: a session used every day for a year
   * must still end at 90 days.
   */
  it('never renews past the absolute ceiling', () => {
    const nearCeiling = session({
      expiresAt: new Date(NOW.getTime() + 1000),
      absoluteExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    });
    expect(renewedExpiry(nearCeiling, NOW)?.getTime()).toBe(
      nearCeiling.absoluteExpiresAt.getTime(),
    );
  });
});

describe('re-authentication for sensitive actions', () => {
  it('is not required immediately after authenticating', () => {
    expect(requiresReauthentication(session(), NOW)).toBe(false);
  });

  it('is required once the window has passed', () => {
    const stale = session({ mfaSatisfiedAt: new Date(NOW.getTime() - REAUTH_WINDOW_MS - 1) });
    expect(requiresReauthentication(stale, NOW)).toBe(true);
  });

  it('is required when MFA was never satisfied', () => {
    expect(requiresReauthentication(session({ mfaSatisfiedAt: null }), NOW)).toBe(true);
  });
});

describe('impersonation is time-boxed', () => {
  it('defaults to the 60-minute maximum from 06 §2', () => {
    expect(impersonationExpiry(NOW).getTime()).toBe(NOW.getTime() + MAX_IMPERSONATION_MS);
    expect(MAX_IMPERSONATION_MS).toBe(60 * 60 * 1000);
  });

  it('honours a shorter request', () => {
    expect(impersonationExpiry(NOW, 5 * 60 * 1000).getTime()).toBe(NOW.getTime() + 5 * 60 * 1000);
  });

  it('clamps a longer one rather than trusting the caller', () => {
    expect(impersonationExpiry(NOW, 24 * 60 * 60 * 1000).getTime()).toBe(
      NOW.getTime() + MAX_IMPERSONATION_MS,
    );
  });

  it('never produces an expiry in the past', () => {
    expect(impersonationExpiry(NOW, -1).getTime()).toBe(NOW.getTime());
  });
});

describe('the session cookie', () => {
  const cookie = sessionCookie();

  /**
   * `__Host-` is enforced by the browser and REQUIRES Secure, Path=/ and NO Domain. That
   * last part is the point: it makes the cookie un-settable by a subdomain, so an XSS on a
   * customer-controlled subdomain cannot plant a session for the apex.
   */
  it('uses the __Host- prefix', () => {
    expect(cookie.name.startsWith('__Host-')).toBe(true);
  });

  it('is HttpOnly, Secure, SameSite=Lax and Path=/', () => {
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe('lax');
    expect(cookie.path).toBe('/');
  });

  it('carries no Domain attribute, which __Host- forbids', () => {
    expect(Object.keys(cookie)).not.toContain('domain');
  });

  it('expires with the sliding window', () => {
    expect(cookie.maxAge).toBe(SESSION_SLIDING_MS / 1000);
  });
});
