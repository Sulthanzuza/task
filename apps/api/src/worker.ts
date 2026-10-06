import { createServer, type Server } from 'node:http';
import { assertProductionConfig, env } from './config/env';
import { logger } from './lib/logger';
import { closeDatabase } from './db/client';
import { runWorker } from './jobs/runWorker';

/**
 * The background worker as a process of its own, for the Docker deployment.
 *
 * It runs the same code as the API, started from a different entry point, so jobs
 * reuse the services and rules rather than reimplementing them. On a host with a
 * single process, server.ts runs the same thing with RUN_MODE=all.
 */

/**
 * A worker has no HTTP interface of its own, but something has to be able to ask
 * whether it is running: a container health check, or a test runner waiting for
 * it before it starts.
 */
function startHealthEndpoint(): Server | null {
  if (!env.WORKER_HEALTH_PORT) return null;

  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/api/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ worker: 'ok' }));
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(env.WORKER_HEALTH_PORT, () => {
    logger.info({ port: env.WORKER_HEALTH_PORT }, 'Worker health endpoint listening.');
  });

  return server;
}

async function main(): Promise<void> {
  assertProductionConfig();
  logger.info('Worker started.');
  const health = startHealthEndpoint();
  const stopWorker = await runWorker();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down.');
    health?.close();
    await stopWorker();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Worker failed to start.');
  process.exit(1);
});
