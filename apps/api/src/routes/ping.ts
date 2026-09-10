/**
 * The Phase 0 smoke route (18-phase-0-plan.md work item 0.8).
 *
 * It exists to prove the pipeline end to end — build, deploy, trace, error report — and is
 * NOT a product feature. It carries no tenant context and touches no data.
 */
import { NotFoundError } from '@growth-os/errors';
import type { AppInstance } from './types.js';

export function registerPingRoutes(app: AppInstance, version: string): void {
  app.get('/v1/ping', async () => ({
    pong: true,
    version,
    at: new Date().toISOString(),
  }));

  // Deliberately reachable: proves the error taxonomy, the problem+json shape and the
  // Sentry path all work in a deployed environment. It returns a modelled 404, not a crash.
  app.get('/v1/ping/error', async () => {
    throw new NotFoundError('This route exists to verify error reporting.');
  });
}
