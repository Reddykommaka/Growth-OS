import { describe, expect, it } from 'vitest';
import { currentTraceId, withSpan } from './index.js';

describe('withSpan', () => {
  it('returns the wrapped value', async () => {
    await expect(withSpan('test.op', async () => 42)).resolves.toBe(42);
  });

  it('propagates the original error rather than swallowing it', async () => {
    const boom = new Error('boom');
    await expect(
      withSpan('test.op', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('still ends the span when the body throws', async () => {
    // A leaked span would keep a trace open forever and distort latency reporting.
    let ended = false;
    await expect(
      withSpan('test.op', async (span) => {
        const original = span.end.bind(span);
        span.end = () => {
          ended = true;
          original();
        };
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(ended).toBe(true);
  });
});

describe('currentTraceId', () => {
  it('returns undefined outside a recording span rather than a zeroed id', () => {
    // The all-zero trace id is OpenTelemetry's "no trace" sentinel; returning it verbatim
    // would put a meaningless correlation id on logs and problem responses.
    expect(currentTraceId()).toBeUndefined();
  });
});
