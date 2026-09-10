/**
 * Correlation context.
 *
 * 12-devops-architecture.md §5: every log line carries request_id, organization_id,
 * workspace_id, actor_id and job_id so a customer report resolves to one trace query
 * instead of an investigation. AsyncLocalStorage propagates it without threading a
 * parameter through every function.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface CorrelationContext {
  readonly requestId?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly actorId?: string;
  readonly jobId?: string;
  readonly automationRunId?: string;
  readonly traceId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export const getCorrelationContext = (): CorrelationContext => storage.getStore() ?? {};

/** Runs `fn` with the given context merged over any surrounding context. */
export const withCorrelationContext = <T>(context: CorrelationContext, fn: () => T): T =>
  storage.run({ ...getCorrelationContext(), ...context }, fn);
