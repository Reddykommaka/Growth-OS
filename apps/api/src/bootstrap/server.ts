/**
 * Composition root for apps/api.
 *
 * 03-repository-structure.md §4: wiring happens in exactly one place per app. Nothing else
 * in the codebase constructs an adapter, which is what makes every service testable with
 * fakes.
 */
import { randomUUID } from 'node:crypto';
import { loadServerEnv, type ServerEnv } from '@growth-os/config';
import { EXPECTED_SCHEMA_VERSION, KNOWN_MIGRATIONS } from '@growth-os/db';
import { NotFoundError, toProblemDetails } from '@growth-os/errors';
import { databaseCheck, schemaVersionCheck } from '@growth-os/health/checks';
import { createLogger, withCorrelationContext } from '@growth-os/logger';
import { currentTraceId } from '@growth-os/telemetry';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { registerHealthRoutes } from '../routes/health.js';
import { registerPingRoutes } from '../routes/ping.js';
import type { AppInstance } from '../routes/types.js';
import { createPool, schemaVersionSource } from './database.js';

export interface BuildServerOptions {
  readonly env?: ServerEnv;
  readonly pool?: Pool;
}

export interface BuiltServer {
  readonly app: AppInstance;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function buildServer(options: BuildServerOptions = {}): BuiltServer {
  const env = options.env ?? loadServerEnv();
  const pool = options.pool ?? createPool(env);

  const logger = createLogger({
    service: env.SERVICE_NAME,
    environment: env.APP_ENV,
    version: env.APP_VERSION,
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
  });

  const app = Fastify({
    // Our own logger owns redaction and correlation; Fastify's default would bypass both.
    loggerInstance: logger,
    // Trust the edge proxy for the client address, which rate limiting depends on.
    trustProxy: true,
    // Reject an oversized body before it is buffered.
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  // Every request runs inside a correlation scope, so request_id and trace_id appear on
  // every log line without the call site passing them (12-devops-architecture.md §5).
  app.addHook('onRequest', (request, _reply, done) => {
    const traceId = currentTraceId();
    withCorrelationContext(
      { requestId: String(request.id), ...(traceId === undefined ? {} : { traceId }) },
      done,
    );
  });

  // 10-security-architecture.md §2. The edge sets CSP for HTML; this API serves JSON only.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
    return payload;
  });

  // One error path for the whole app: RFC 9457, and never a leaked internal.
  app.setErrorHandler((error, request, reply) => {
    const problem = toProblemDetails(error, String(request.id));
    if (problem.status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    } else {
      request.log.info({ code: problem.code }, 'request rejected');
    }
    void reply
      .header('content-type', 'application/problem+json')
      .status(problem.status)
      .send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = toProblemDetails(new NotFoundError('Route not found.'), String(request.id));
    void reply.header('content-type', 'application/problem+json').status(404).send(problem);
  });

  registerHealthRoutes(app, {
    version: env.APP_VERSION,
    checks: [
      databaseCheck({ query: (sql: string) => pool.query(sql) }),
      schemaVersionCheck(schemaVersionSource(pool), EXPECTED_SCHEMA_VERSION, KNOWN_MIGRATIONS),
    ],
  });
  registerPingRoutes(app, env.APP_VERSION);

  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}
