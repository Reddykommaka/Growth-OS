/**
 * Liveness and readiness (12-devops-architecture.md §5).
 *
 * Neither endpoint is public: both are excluded from the edge router and exist for the
 * orchestrator. /readyz returns operator-facing detail, which is why it must not be exposed.
 */
import { type HealthCheck, readinessHttpStatus, runReadiness } from '@growth-os/health';
import type { AppInstance } from './types.js';

export interface HealthRoutesOptions {
  readonly checks: readonly HealthCheck[];
  readonly version: string;
}

export function registerHealthRoutes(app: AppInstance, options: HealthRoutesOptions): void {
  /**
   * Liveness. Deliberately checks nothing external: a failing dependency must not cause the
   * orchestrator to restart an otherwise healthy process, which would turn a database blip
   * into a rolling restart of every replica.
   */
  app.get('/healthz', async () => ({ status: 'ok', version: options.version }));

  app.get('/readyz', async (_request, reply) => {
    const report = await runReadiness(options);
    // No-store: a cached readiness response is worse than none, because it keeps a failed
    // replica in rotation.
    reply.header('cache-control', 'no-store');
    return reply.status(readinessHttpStatus(report)).send(report);
  });
}
