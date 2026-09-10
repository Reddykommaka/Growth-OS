/**
 * Environment schema.
 *
 * 12-devops-architecture.md §1: configuration differs between environments by *value*,
 * never by code path, and a process fails to boot on a missing or invalid variable rather
 * than surfacing it as a runtime surprise later.
 *
 * The schema is split in two. Anything in `serverEnvSchema` is secret-bearing and must
 * never reach a browser bundle; `clientEnvSchema` accepts only `NEXT_PUBLIC_`-prefixed
 * keys, which is what makes the build-time leak check in ./guard.ts decidable.
 */
import { z } from 'zod';

export const ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const url = z.string().url();
const nonEmpty = z.string().min(1);

/** A secret must be long enough to be a secret; a short one is almost always a placeholder. */
const secret = z.string().min(32, 'Secrets must be at least 32 characters.');

const port = z.coerce.number().int().min(1).max(65_535);

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(ENVIRONMENTS).default('development'),
  SERVICE_NAME: nonEmpty.default('growth-os'),
  APP_VERSION: z.string().default('0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),

  PORT: port.default(3000),

  // Database. The application connects as the RLS-enforced role; the migrator URL is used
  // only by the migration job and must never be present in an application process
  // (06-identity-and-access.md §4).
  DATABASE_URL: url,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),

  REDIS_URL: url.optional(),

  SESSION_COOKIE_SECRET: secret,
  ENCRYPTION_MASTER_KEY: secret,

  OTEL_EXPORTER_OTLP_ENDPOINT: url.optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  SENTRY_DSN: url.optional(),

  STORAGE_BUCKET: z.string().optional(),
  STORAGE_REGION: z.string().optional(),
  /** User content is served from a separate origin so a stored payload cannot reach app cookies. */
  USER_CONTENT_ORIGIN: url.optional(),
});

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_ENV: z.enum(ENVIRONMENTS).default('development'),
  NEXT_PUBLIC_APP_URL: url.default('http://localhost:3000'),
  NEXT_PUBLIC_SENTRY_DSN: url.optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type ClientEnv = z.infer<typeof clientEnvSchema>;

/** Keys that may appear in a browser bundle. Everything else is server-only by definition. */
export const CLIENT_ENV_KEYS: readonly string[] = Object.keys(clientEnvSchema.shape);
export const SERVER_ENV_KEYS: readonly string[] = Object.keys(serverEnvSchema.shape);
