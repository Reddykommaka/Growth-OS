/**
 * The concrete Fastify instance type for this app.
 *
 * Passing our pino logger as `loggerInstance` parameterises FastifyInstance over pino's
 * Logger rather than the default FastifyBaseLogger, so route registrars must accept that
 * exact shape. Naming it once here is preferable to widening with a cast, which would
 * discard the logger's typed child/bindings API at every call site.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { Logger } from 'pino';

export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;
