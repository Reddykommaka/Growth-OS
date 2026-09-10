/**
 * Fail-fast configuration loading.
 */
import type { z } from 'zod';
import { type ClientEnv, clientEnvSchema, type ServerEnv, serverEnvSchema } from './schema.js';

export class ConfigurationError extends Error {
  readonly issues: readonly { path: string; message: string }[];
  constructor(issues: readonly { path: string; message: string }[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((i) => `  - ${i.path}: ${i.message}`)
        .join('\n')}\n\nSee .env.example for the required variables.`,
    );
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

function parse<T extends z.ZodType>(schema: T, source: Record<string, unknown>): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    // The raised error names the offending keys but never echoes their values: an invalid
    // secret is still a secret, and boot logs are widely readable.
    throw new ConfigurationError(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

let cachedServerEnv: ServerEnv | null = null;

/**
 * Parses and caches server configuration. Throws on the first invalid value, so a
 * misconfigured process never reaches the point of serving traffic.
 */
export function loadServerEnv(source: Record<string, unknown> = process.env): ServerEnv {
  if (cachedServerEnv !== null && source === process.env) return cachedServerEnv;
  const parsed = parse(serverEnvSchema, source);
  if (source === process.env) cachedServerEnv = parsed;
  return parsed;
}

export function loadClientEnv(source: Record<string, unknown> = process.env): ClientEnv {
  return parse(clientEnvSchema, source);
}

/** Test-only: clears the memoised configuration. */
export function resetServerEnvCache(): void {
  cachedServerEnv = null;
}
