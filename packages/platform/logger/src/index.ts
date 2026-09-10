/**
 * @growth-os/logger — structured JSON logging with serializer-level redaction.
 */
import {
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as PinoOptions,
  pino,
} from 'pino';
import { getCorrelationContext } from './context.js';
import { REDACTED, redact, redactString } from './redaction.js';

export * from './context.js';
export { isSensitiveKey, REDACTED_KEYS, redact, redactString } from './redaction.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly service: string;
  readonly environment: string;
  readonly version?: string;
  /** Pretty output is for a developer's terminal only; production always emits JSON. */
  readonly pretty?: boolean;
  /**
   * Where log lines are written. Defaults to stdout. Tests pass a capture stream so they
   * exercise this exact configuration rather than a reconstruction of it — a redaction test
   * that builds its own logger proves nothing about the one we ship.
   */
  readonly destination?: DestinationStream;
}

export type Logger = PinoLogger;

export function createLogger(options: LoggerOptions): Logger {
  const config: PinoOptions = {
    level: options.level ?? 'info',
    base: {
      service: options.service,
      environment: options.environment,
      ...(options.version === undefined ? {} : { version: options.version }),
    },
    // Correlation ids are attached at serialisation time, so a caller cannot forget them.
    mixin: () => getCorrelationContext(),
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    // Defence in depth: pino's own fast-path redaction for known key paths, plus the
    // recursive serializer below for everything else.
    redact: {
      paths: [
        'password',
        '*.password',
        '*.*.password',
        'token',
        '*.token',
        '*.*.token',
        'secret',
        '*.secret',
        '*.*.secret',
        'authorization',
        '*.authorization',
        'headers.authorization',
        'headers.cookie',
        '*.headers.cookie',
        'apiKey',
        '*.apiKey',
        'api_key',
        '*.api_key',
        'refreshToken',
        '*.refreshToken',
        'refresh_token',
        '*.refresh_token',
        'accessToken',
        '*.accessToken',
        'access_token',
        '*.access_token',
      ],
      censor: REDACTED,
    },
    serializers: {
      err: (e: unknown) => redact(e),
      error: (e: unknown) => redact(e),
    },
    hooks: {
      // Every log call passes through here, so redaction cannot be bypassed by logging an
      // object shape nobody anticipated.
      logMethod(this: PinoLogger, args: unknown[], method: (...a: unknown[]) => void) {
        const redacted = args.map((arg) =>
          typeof arg === 'string' ? redactString(arg) : redact(arg),
        );
        method.apply(this, redacted);
      },
    },
    ...(options.pretty === true && options.destination === undefined
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  };

  return options.destination === undefined ? pino(config) : pino(config, options.destination);
}

/** A no-op logger for tests that must not emit output. */
export const silentLogger: Logger = pino({ level: 'silent' });
