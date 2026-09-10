/**
 * Exit criterion #11 (18-phase-0-plan.md): /readyz fails when the migration version does
 * not match the code's expectation.
 */
import { describe, expect, it, vi } from 'vitest';
import { databaseCheck, redisCheck, schemaVersionCheck } from './checks.js';
import { type HealthCheck, readinessHttpStatus, runReadiness } from './index.js';

const KNOWN = ['0001_a.sql', '0002_b.sql', '0003_c.sql'];
const version = '1.0.0';

const source = (current: string | null) => ({ currentVersion: async () => current });

describe('schema version check', () => {
  it('passes when the database matches the build', async () => {
    const check = schemaVersionCheck(source('0003_c.sql'), '0003_c.sql', KNOWN);
    await expect(check.run(new AbortController().signal)).resolves.toMatchObject({
      status: 'pass',
    });
  });

  it('FAILS when the database is behind the build', async () => {
    // The dangerous direction: the code will query a column that does not exist yet.
    const check = schemaVersionCheck(source('0001_a.sql'), '0003_c.sql', KNOWN);
    const result = await check.run(new AbortController().signal);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('0002_b.sql');
    expect(result.detail).toContain('0003_c.sql');
    expect(result.detail).toMatch(/migration job/);
  });

  it('PASSES when the database is ahead of the build', async () => {
    // The normal state mid-rolling-deploy. Expand/contract guarantees every migration is
    // safe against the previous application version, so failing here would take the old
    // replicas out of service and turn a routine deploy into an outage.
    const check = schemaVersionCheck(source('0003_c.sql'), '0001_a.sql', KNOWN);
    const result = await check.run(new AbortController().signal);
    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/ahead of this build/);
  });

  it('fails when no migrations have been applied at all', async () => {
    const check = schemaVersionCheck(source(null), '0001_a.sql', KNOWN);
    await expect(check.run(new AbortController().signal)).resolves.toMatchObject({
      status: 'fail',
    });
  });

  it('is critical — a schema mismatch must remove the replica from service', () => {
    expect(schemaVersionCheck(source('x'), 'x', KNOWN).critical).toBe(true);
  });
});

describe('readiness aggregation', () => {
  const passing: HealthCheck = {
    name: 'ok',
    critical: true,
    run: async () => ({ status: 'pass' }),
  };
  const failingCritical: HealthCheck = {
    name: 'db',
    critical: true,
    run: async () => ({ status: 'fail', detail: 'connection refused' }),
  };
  const failingOptional: HealthCheck = {
    name: 'cache',
    critical: false,
    run: async () => ({ status: 'fail', detail: 'connection refused' }),
  };

  it('returns 200 when everything passes', async () => {
    const report = await runReadiness({ checks: [passing], version });
    expect(report.status).toBe('pass');
    expect(readinessHttpStatus(report)).toBe(200);
  });

  it('returns 503 when a critical check fails', async () => {
    const report = await runReadiness({ checks: [passing, failingCritical], version });
    expect(report.status).toBe('fail');
    expect(readinessHttpStatus(report)).toBe(503);
  });

  it('stays in service when only a NON-critical check fails', async () => {
    // Redis is not a system of record. Removing every replica because a cache is down
    // converts a degradation into an outage.
    const report = await runReadiness({ checks: [passing, failingOptional], version });
    expect(report.status).toBe('warn');
    expect(readinessHttpStatus(report)).toBe(200);
  });

  it('treats a thrown check as a failure rather than crashing the probe', async () => {
    const thrower: HealthCheck = {
      name: 'boom',
      critical: true,
      run: async () => {
        throw new Error('unexpected');
      },
    };
    const report = await runReadiness({ checks: [thrower], version });
    expect(report.status).toBe('fail');
    expect(report.checks['boom']?.detail).toBe('unexpected');
  });

  it('runs checks concurrently, not serially', async () => {
    // A probe polled every few seconds cannot afford to serialise four one-second checks.
    const slow = (name: string): HealthCheck => ({
      name,
      critical: true,
      run: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { status: 'pass' };
      },
    });
    const started = Date.now();
    await runReadiness({ checks: [slow('a'), slow('b'), slow('c'), slow('d')], version });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('aborts a check that exceeds the timeout', async () => {
    const hanging: HealthCheck = {
      name: 'hangs',
      critical: true,
      run: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const report = await runReadiness({ checks: [hanging], version, timeoutMs: 40 });
    expect(report.status).toBe('fail');
  });

  it('records a duration for every check', async () => {
    const report = await runReadiness({ checks: [passing], version });
    expect(report.checks['ok']?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('individual checks', () => {
  it('database check round-trips a query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const result = await databaseCheck({ query }).run(new AbortController().signal);
    expect(result.status).toBe('pass');
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('redis check is non-critical', () => {
    expect(redisCheck({ ping: async () => 'PONG' }).critical).toBe(false);
  });

  it('redis check warns on an unexpected reply', async () => {
    const result = await redisCheck({ ping: async () => 'nope' }).run(new AbortController().signal);
    expect(result.status).toBe('warn');
  });
});
