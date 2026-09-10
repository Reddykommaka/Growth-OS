import { describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  ProviderUnavailableError,
  RateLimitedError,
  toProblemDetails,
  ValidationError,
} from './index.js';

describe('problem details never leak internals', () => {
  it('replaces a 5xx message with a generic detail', () => {
    const internal = new InternalError(
      'relation "organizations" does not exist at /srv/app/db/query.ts:42',
    );
    const problem = toProblemDetails(internal, 'req-1');
    expect(problem.status).toBe(500);
    expect(problem.detail).not.toContain('organizations');
    expect(problem.detail).not.toContain('/srv/app');
    expect(problem.requestId).toBe('req-1');
  });

  it('discards a non-AppError entirely', () => {
    // An unhandled throw may carry a query fragment, a file path or a credential.
    const raw = new Error('connect ECONNREFUSED postgres://app:hunter2@10.0.0.5:5432');
    const problem = toProblemDetails(raw, 'req-2');
    expect(problem.status).toBe(500);
    expect(problem.code).toBe('internal_error');
    expect(JSON.stringify(problem)).not.toContain('hunter2');
    expect(JSON.stringify(problem)).not.toContain('10.0.0.5');
  });

  it('discards a thrown non-Error value', () => {
    expect(toProblemDetails({ secret: 'leak' }, 'req-3').detail).not.toContain('leak');
    expect(toProblemDetails('a raw string', 'req-3').code).toBe('internal_error');
  });

  it('keeps a provider failure opaque to the caller', () => {
    const problem = toProblemDetails(
      new ProviderUnavailableError('LinkedIn returned 503 for app id 8812345'),
    );
    expect(problem.detail).not.toContain('8812345');
  });

  it('does not attach meta on a 5xx even when present', () => {
    const problem = toProblemDetails(
      new InternalError('boom', { meta: { internalHost: 'db-primary-1' } }),
    );
    expect(JSON.stringify(problem)).not.toContain('db-primary-1');
  });
});

describe('4xx details describe the caller request and are returned', () => {
  it('keeps a validation message and its field issues', () => {
    const problem = toProblemDetails(
      new ValidationError('Invalid request body.', [
        { path: 'email', message: 'Must be a valid email address.' },
      ]),
    );
    expect(problem.status).toBe(422);
    expect(problem.detail).toBe('Invalid request body.');
    expect(problem.issues?.[0]?.path).toBe('email');
  });

  it('exposes retryAfter on a rate limit', () => {
    const problem = toProblemDetails(new RateLimitedError('Slow down.', 30));
    expect(problem.status).toBe(429);
    expect(problem.retryAfter).toBe(30);
  });

  it.each([
    [new ForbiddenError(), 403, 'forbidden'],
    [new NotFoundError(), 404, 'not_found'],
  ])('maps %s', (error, status, code) => {
    const problem = toProblemDetails(error);
    expect(problem.status).toBe(status);
    expect(problem.code).toBe(code);
    expect(problem.type).toContain(code);
  });
});

describe('retryability is declared, not guessed', () => {
  it.each([
    [new RateLimitedError(), true],
    [new ProviderUnavailableError('x'), true],
    [new InternalError(), true],
    [new ValidationError('x'), false],
    [new ForbiddenError(), false],
    [new NotFoundError(), false],
  ])('%s', (error, retryable) => {
    expect(error.retryable).toBe(retryable);
  });
});
