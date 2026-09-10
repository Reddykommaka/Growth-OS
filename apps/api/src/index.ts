/**
 * @growth-os/app-api — Fastify public REST API and provider webhook receivers.
 *
 * Deployment unit, not an architectural boundary (ADR-0001). Apps may import a module's
 * ./contracts only; business logic lives in packages/modules/*.
 */
import { loadServerEnv } from '@growth-os/config';
import { shutdownTelemetry, startTelemetry } from '@growth-os/telemetry';
import { initErrorReporting } from './bootstrap/errors.js';
import { buildServer } from './bootstrap/server.js';

export { type BuiltServer, buildServer } from './bootstrap/server.js';

async function main(): Promise<void> {
  const env = loadServerEnv();

  // Telemetry starts before the server so the first request is already traced, and error
  // reporting before that so a failure during startup is reported rather than lost to
  // stderr in a container nobody is watching.
  startTelemetry({
    serviceName: env.OTEL_SERVICE_NAME ?? env.SERVICE_NAME,
    serviceVersion: env.APP_VERSION,
    environment: env.APP_ENV,
    ...(env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
      ? {}
      : { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT }),
  });
  await initErrorReporting(env);

  const server = buildServer({ env });

  // Graceful shutdown: stop accepting, drain what is in flight, then close the pool.
  // Without this a rolling deploy severs live requests instead of finishing them.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        server.app.log.info({ signal }, 'shutting down');
        await server.close();
        await shutdownTelemetry();
        process.exit(0);
      })();
    });
  }

  await server.app.listen({ port: env.PORT, host: '0.0.0.0' });
}

// Only run when executed directly; importing this module for tests must not start a
// listener.
if (process.argv[1]?.endsWith('index.js') === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`Failed to start apps/api: ${String(error)}\n`);
    process.exit(1);
  });
}
