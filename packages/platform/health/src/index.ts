/**
 * @growth-os/health — liveness and readiness.
 *
 * 12-devops-architecture.md §5. The two endpoints answer different questions, and
 * conflating them is a common and costly mistake:
 *
 *   /healthz  Is the process alive? Checks NOTHING external. A failing dependency must not
 *             cause the orchestrator to restart a healthy process — that turns a database
 *             blip into a rolling restart of every replica, which is worse than the blip.
 *
 *   /readyz   Should this replica receive traffic? Checks the database, Redis and the
 *             deployed schema version. A failing readiness check removes one replica from
 *             the load balancer; it does not kill it.
 */

export type HealthStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  readonly status: HealthStatus;
  readonly detail?: string;
  readonly observedValue?: string;
}

export interface HealthCheck {
  readonly name: string;
  /** A failing non-critical check degrades the report to "warn" but keeps the replica in service. */
  readonly critical: boolean;
  run(signal: AbortSignal): Promise<CheckResult>;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checks: Readonly<Record<string, CheckResult & { durationMs: number }>>;
  readonly version: string;
  readonly checkedAt: string;
}

export interface ReadinessOptions {
  readonly checks: readonly HealthCheck[];
  readonly version: string;
  /** A readiness probe that hangs is indistinguishable from one that fails, but takes longer. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Runs every check concurrently and aggregates.
 *
 * Concurrent rather than sequential: readiness is polled every few seconds, and serialising
 * four checks that each take a second means a probe that cannot finish inside its own
 * interval.
 */
export async function runReadiness(options: ReadinessOptions): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const results = await Promise.all(
    options.checks.map(async (check) => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await check.run(controller.signal);
        return [check, { ...result, durationMs: Date.now() - started }] as const;
      } catch (error) {
        return [
          check,
          {
            status: 'fail' as const,
            // The message is operator-facing only; /readyz is never public.
            detail: error instanceof Error ? error.message : 'check threw a non-Error',
            durationMs: Date.now() - started,
          },
        ] as const;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const checks: Record<string, CheckResult & { durationMs: number }> = {};
  let status: HealthStatus = 'pass';
  for (const [check, result] of results) {
    checks[check.name] = result;
    if (result.status === 'fail') {
      status = check.critical ? 'fail' : status === 'fail' ? 'fail' : 'warn';
    } else if (result.status === 'warn' && status === 'pass') {
      status = 'warn';
    }
  }

  return { status, checks, version: options.version, checkedAt: new Date().toISOString() };
}

/** HTTP status for a report. "warn" still serves traffic. */
export const readinessHttpStatus = (report: HealthReport): number =>
  report.status === 'fail' ? 503 : 200;
