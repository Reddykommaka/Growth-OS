/**
 * Exit criteria #10 and #11 (18-phase-0-plan.md).
 *
 * Runs the real Fastify app against a real PostgreSQL cluster, so /readyz is exercised
 * against actual migration state rather than a stub. The deployed-staging half of criterion
 * #10 cannot be verified here (no cloud credentials); everything up to the container
 * boundary is.
 */

import type { ServerEnv } from '@growth-os/config';
import { EXPECTED_SCHEMA_VERSION } from '@growth-os/db';
import { acquireTestDatabase, stopSharedCluster, type TestDatabase } from '@growth-os/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BuiltServer, buildServer } from '../bootstrap/server.js';

let db: TestDatabase;
let server: BuiltServer;

const env = (overrides: Partial<ServerEnv> = {}): ServerEnv =>
  ({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    SERVICE_NAME: 'growth-os-api',
    APP_VERSION: '0.0.0-test',
    LOG_LEVEL: 'error',
    LOG_PRETTY: false,
    PORT: 0,
    DATABASE_URL: db.url,
    DATABASE_POOL_MAX: 4,
    DATABASE_STATEMENT_TIMEOUT_MS: 5_000,
    SESSION_COOKIE_SECRET: 'x'.repeat(32),
    ENCRYPTION_MASTER_KEY: 'y'.repeat(32),
    ...overrides,
  }) as ServerEnv;

beforeAll(async () => {
  db = await acquireTestDatabase();
  server = buildServer({ env: env(), pool: new Pool({ connectionString: db.url, max: 4 }) });
  await server.app.ready();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await db?.close();
  await stopSharedCluster();
});

describe('/healthz — liveness', () => {
  it('returns 200 without touching any dependency', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', version: '0.0.0-test' });
  });

  it('stays healthy even when the database is unreachable', async () => {
    // The point of separating the probes: a database blip must not cause the orchestrator
    // to restart every replica, which is worse than the blip itself.
    const broken = buildServer({
      env: env(),
      pool: new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', max: 1 }),
    });
    await broken.app.ready();
    const response = await broken.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    await broken.app.close();
  });
});

describe('/readyz — readiness', () => {
  it('returns 200 when the database is reachable and the schema matches', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('pass');
    expect(body.checks.database.status).toBe('pass');
    expect(body.checks['schema-version']).toMatchObject({
      status: 'pass',
      observedValue: EXPECTED_SCHEMA_VERSION,
    });
  });

  it('returns 503 when the database is unreachable', async () => {
    const broken = buildServer({
      env: env(),
      pool: new Pool({
        connectionString: 'postgres://nobody@127.0.0.1:1/none',
        max: 1,
        connectionTimeoutMillis: 500,
      }),
    });
    await broken.app.ready();
    const response = await broken.app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json().checks.database.status).toBe('fail');
    await broken.app.close();
  });

  it('FAILS when the database is behind the schema this build expects', async () => {
    // Exit criterion #11, against a real database: the migration ledger is rewound so the
    // deployed schema is genuinely older than the build.
    const admin = new Pool({ connectionString: db.adminUrl, max: 1 });
    await admin.query('DELETE FROM schema_migrations WHERE name = $1', [EXPECTED_SCHEMA_VERSION]);
    try {
      const response = await server.app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      const check = response.json().checks['schema-version'];
      expect(check.status).toBe('fail');
      expect(check.detail).toContain(EXPECTED_SCHEMA_VERSION);
      expect(check.detail).toMatch(/migration job/);
    } finally {
      await admin.query(
        'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, 0)',
        [EXPECTED_SCHEMA_VERSION, 'restored-by-test'],
      );
      await admin.end();
    }
  });

  it('recovers once the migration is applied', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
  });

  it('is never cached — a cached readiness response keeps a failed replica in rotation', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/readyz' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('/v1/ping — pipeline smoke route', () => {
  it('responds', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/v1/ping' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ pong: true, version: '0.0.0-test' });
  });

  it('returns problem+json for a modelled error, with a correlation id', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/v1/ping/error' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = response.json();
    expect(body.code).toBe('not_found');
    expect(body.requestId).toBeTruthy();
  });

  it('returns problem+json for an unknown route', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
  });
});

describe('security headers', () => {
  it.each([
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
  ])('sets %s', async (header, value) => {
    const response = await server.app.inject({ method: 'GET', url: '/v1/ping' });
    expect(response.headers[header]).toBe(value);
  });

  it('sets HSTS', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/v1/ping' });
    expect(response.headers['strict-transport-security']).toContain('max-age=');
  });
});
