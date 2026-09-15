/**
 * @growth-os/errors — the error taxonomy and its RFC 9457 (problem+json) representation.
 *
 * Two rules govern this package:
 *  1. Every error carries a machine-readable `code` so callers branch on a value, not on a
 *     message string.
 *  2. `toProblemDetails` never leaks internals. Messages on 5xx errors are replaced with a
 *     generic string; only the correlation id crosses the boundary, so an operator can find
 *     the detail in the logs while an attacker learns nothing
 *     (10-security-architecture.md §2).
 */

export type ErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'budget_exceeded'
  | 'entitlement_required'
  | 'precondition_failed'
  | 'provider_unavailable'
  | 'capability_unsupported'
  | 'internal_error';

export interface ErrorContext {
  /** Correlates a client-visible failure with the server logs and traces. */
  readonly requestId?: string;
  /** Structured, non-sensitive detail safe to return to the caller. */
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;
  /** Whether the same call could succeed if retried unchanged. */
  abstract readonly retryable: boolean;
  readonly requestId: string | undefined;
  readonly meta: Readonly<Record<string, unknown>>;

  /**
   * Public, not protected.
   *
   * `AppError` is abstract, so `new AppError(...)` is already impossible — `protected`
   * restricted nothing that `abstract` did not, while making every subclass that did not
   * declare its own constructor UNCONSTRUCTIBLE. Seven of the thirteen were: ConflictError,
   * PreconditionFailedError, QuotaExceededError, BudgetExceededError,
   * EntitlementRequiredError, ProviderUnavailableError and CapabilityUnsupportedError. They
   * typechecked, shipped, and could not be thrown. A test now constructs every one.
   */
  constructor(message: string, context: ErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = new.target.name;
    this.requestId = context.requestId;
    this.meta = context.meta ?? {};
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  readonly code = 'validation_failed' as const;
  readonly status = 422;
  readonly retryable = false;
  /** Field-level failures, safe to return: they describe the caller's own input. */
  readonly issues: readonly { path: string; message: string }[];

  constructor(
    message: string,
    issues: readonly { path: string; message: string }[] = [],
    context: ErrorContext = {},
  ) {
    super(message, context);
    this.issues = issues;
  }
}

export class UnauthenticatedError extends AppError {
  readonly code = 'unauthenticated' as const;
  readonly status = 401;
  readonly retryable = false;
  constructor(message = 'Authentication required.', context: ErrorContext = {}) {
    super(message, context);
  }
}

export class ForbiddenError extends AppError {
  readonly code = 'forbidden' as const;
  readonly status = 403;
  readonly retryable = false;
  constructor(
    message = 'You do not have permission to perform this action.',
    context: ErrorContext = {},
  ) {
    super(message, context);
  }
}

export class NotFoundError extends AppError {
  readonly code = 'not_found' as const;
  readonly status = 404;
  readonly retryable = false;
  constructor(message = 'Resource not found.', context: ErrorContext = {}) {
    super(message, context);
  }
}

export class ConflictError extends AppError {
  readonly code = 'conflict' as const;
  readonly status = 409;
  readonly retryable = false;
}

export class PreconditionFailedError extends AppError {
  readonly code = 'precondition_failed' as const;
  readonly status = 412;
  readonly retryable = false;
}

export class RateLimitedError extends AppError {
  readonly code = 'rate_limited' as const;
  readonly status = 429;
  readonly retryable = true;
  readonly retryAfterSeconds: number | undefined;
  constructor(
    message = 'Rate limit exceeded.',
    retryAfterSeconds?: number,
    context: ErrorContext = {},
  ) {
    super(message, context);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class QuotaExceededError extends AppError {
  readonly code = 'quota_exceeded' as const;
  readonly status = 429;
  readonly retryable = false;
}

/** AI spend guard (ADR-0016). Distinct from a quota: it protects cost, not throughput. */
export class BudgetExceededError extends AppError {
  readonly code = 'budget_exceeded' as const;
  readonly status = 402;
  readonly retryable = false;
}

export class EntitlementRequiredError extends AppError {
  readonly code = 'entitlement_required' as const;
  readonly status = 402;
  readonly retryable = false;
}

export class ProviderUnavailableError extends AppError {
  readonly code = 'provider_unavailable' as const;
  readonly status = 502;
  readonly retryable = true;
}

export class CapabilityUnsupportedError extends AppError {
  readonly code = 'capability_unsupported' as const;
  readonly status = 501;
  readonly retryable = false;
}

export class InternalError extends AppError {
  readonly code = 'internal_error' as const;
  readonly status = 500;
  readonly retryable = true;
  constructor(message = 'An unexpected error occurred.', context: ErrorContext = {}) {
    super(message, context);
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

/** RFC 9457 problem details. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: ErrorCode;
  readonly requestId?: string;
  readonly issues?: readonly { path: string; message: string }[];
  readonly retryAfter?: number;
  readonly meta?: Readonly<Record<string, unknown>>;
}

const PROBLEM_BASE = 'https://docs.growth-os.dev/problems';
const GENERIC_5XX_DETAIL =
  'An unexpected error occurred. Quote the request id when contacting support.';

/**
 * Converts any thrown value into a client-safe problem document.
 *
 * Anything that is not an `AppError` is an unhandled defect: its message and stack may
 * contain query fragments, file paths or credentials, so they are discarded here and only
 * ever recorded by the logger.
 */
export function toProblemDetails(error: unknown, requestId?: string): ProblemDetails {
  if (!isAppError(error)) {
    return {
      type: `${PROBLEM_BASE}/internal_error`,
      title: 'Internal Server Error',
      status: 500,
      detail: GENERIC_5XX_DETAIL,
      code: 'internal_error',
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  const id = error.requestId ?? requestId;
  const serverSide = error.status >= 500;

  return {
    type: `${PROBLEM_BASE}/${error.code}`,
    title: error.name.replace(/Error$/, '').replace(/([a-z])([A-Z])/g, '$1 $2') || 'Error',
    status: error.status,
    // A 5xx message describes our internals; a 4xx message describes the caller's request.
    detail: serverSide ? GENERIC_5XX_DETAIL : error.message,
    code: error.code,
    ...(id === undefined ? {} : { requestId: id }),
    ...(error instanceof ValidationError && error.issues.length > 0
      ? { issues: error.issues }
      : {}),
    ...(error instanceof RateLimitedError && error.retryAfterSeconds !== undefined
      ? { retryAfter: error.retryAfterSeconds }
      : {}),
    ...(!serverSide && Object.keys(error.meta).length > 0 ? { meta: error.meta } : {}),
  };
}
