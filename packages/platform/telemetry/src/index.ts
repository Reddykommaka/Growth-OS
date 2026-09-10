/**
 * @growth-os/telemetry — OpenTelemetry bootstrap and span helpers.
 *
 * 02-technology-stack.md §7: we instrument against the vendor-neutral OpenTelemetry API and
 * export to a collector, never against a vendor SDK. Changing observability backend is then
 * a collector configuration change, not a code change across the repository.
 */
import {
  type Attributes,
  context,
  DiagLogLevel,
  diag,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
  /** When absent, tracing is configured but exports nowhere — correct for tests and local runs. */
  readonly otlpEndpoint?: string;
}

let sdk: NodeSDK | null = null;

export function startTelemetry(options: TelemetryOptions): void {
  if (sdk !== null) return;

  // Telemetry must never take the process down. The SDK reports export failures through
  // diag; with no handler installed they surface as unhandled rejections, so an unreachable
  // collector becomes a crash — exactly backwards, since tracing is the least important
  // thing the process does.
  diag.setLogger(
    {
      error: (message: string) => {
        process.stderr.write(`[otel] ${message}\n`);
      },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
    },
    DiagLogLevel.ERROR,
  );

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_VERSION]: options.serviceVersion,
    'deployment.environment.name': options.environment,
  });

  const instrumentations = [
    getNodeAutoInstrumentations({
      // Filesystem spans are pure noise at this cardinality.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ];

  if (options.otlpEndpoint === undefined) {
    // No endpoint configured — the normal state in development, tests and CI.
    //
    // NodeSDK installs DEFAULT OTLP exporters for both traces and metrics, pointed at
    // localhost:4318, whenever none is supplied. Omitting traceExporter is not enough:
    // the failed flush on shutdown crashed the process with ECONNREFUSED, and the metrics
    // reader kept dialling a collector that does not exist on every interval.
    //
    // These env vars are the SDK's own documented opt-out, and cover both signals without
    // pulling in a no-op exporter dependency.
    process.env['OTEL_TRACES_EXPORTER'] ??= 'none';
    process.env['OTEL_METRICS_EXPORTER'] ??= 'none';
    process.env['OTEL_LOGS_EXPORTER'] ??= 'none';
    sdk = new NodeSDK({ resource, spanProcessors: [], instrumentations });
  } else {
    sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter({ url: `${options.otlpEndpoint}/v1/traces` }),
      instrumentations,
    });
  }

  sdk.start();
}

/**
 * Flushes and stops. Never throws: a failed flush during shutdown would turn a clean
 * SIGTERM into a non-zero exit, and every rolling deploy would look like a crash loop.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk === null) return;
  const current = sdk;
  sdk = null;
  try {
    await current.shutdown();
  } catch (error) {
    process.stderr.write(
      `[otel] shutdown failed (ignored): ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

const tracer = () => trace.getTracer('growth-os');

/**
 * Runs `fn` inside a span, recording exceptions and setting an error status.
 *
 * Every application-service call is a span (04-domain-architecture.md §3), which is what
 * makes "my post did not publish at 09:00" answerable from one trace query.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Attributes = {},
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'unknown error',
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** The active trace id, for stamping onto logs and problem responses. */
export function currentTraceId(): string | undefined {
  const span = trace.getSpan(context.active());
  const id = span?.spanContext().traceId;
  return id === undefined || id === '00000000000000000000000000000000' ? undefined : id;
}

export type { Attributes, Span } from '@opentelemetry/api';
export { SpanStatusCode, trace } from '@opentelemetry/api';
