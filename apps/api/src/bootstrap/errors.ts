/**
 * Error reporting.
 *
 * 12-devops-architecture.md §5: Sentry with release tracking and source maps. The SDK is
 * loaded dynamically and only when a DSN is configured, so development, tests and CI never
 * open a network connection to a vendor — and a missing DSN is a normal state rather than
 * a startup failure.
 */
import type { ServerEnv } from '@growth-os/config';
import { redact } from '@growth-os/logger';

let initialised = false;

export async function initErrorReporting(env: ServerEnv): Promise<void> {
  if (initialised || env.SENTRY_DSN === undefined || env.SENTRY_DSN === '') return;

  const sentry = await import('@sentry/node');
  sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENV,
    release: env.APP_VERSION,
    // Sampled, not exhaustive: full tracing on a busy API costs more than it tells us, and
    // OpenTelemetry already carries the detailed picture.
    tracesSampleRate: env.APP_ENV === 'production' ? 0.1 : 1.0,
    // Sentry must never become a second, unredacted log sink. Everything is passed through
    // the same redaction used by the logger (10-security-architecture.md §2).
    beforeSend(event) {
      return redact(event) as typeof event;
    },
    beforeBreadcrumb(breadcrumb) {
      return redact(breadcrumb) as typeof breadcrumb;
    },
  });

  initialised = true;
}
