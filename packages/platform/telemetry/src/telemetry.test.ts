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

describe('telemetry never takes the process down', () => {
  it('does not install a default exporter when no endpoint is configured', async () => {
    // Regression test. NodeSDK installs default OTLP exporters aimed at localhost:4318 for
    // traces, metrics and logs whenever none is supplied. The failed flush on shutdown
    // crashed apps/api with ECONNREFUSED on SIGTERM, so every rolling deploy would have
    // recorded a non-zero exit. Found by running the built binary, not by any unit test.
    const { shutdownTelemetry, startTelemetry } = await import('./index.js');

    startTelemetry({
      serviceName: 'test',
      serviceVersion: '0.0.0',
      environment: 'test',
      // deliberately no otlpEndpoint
    });

    expect(process.env['OTEL_TRACES_EXPORTER']).toBe('none');
    expect(process.env['OTEL_METRICS_EXPORTER']).toBe('none');

    // Must resolve, not reject, with no collector listening anywhere.
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('shutdown is idempotent', async () => {
    const { shutdownTelemetry } = await import('./index.js');
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
