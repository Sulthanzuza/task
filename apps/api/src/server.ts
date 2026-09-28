import { createServer } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { closeDatabase } from './db/client';

const app = createApp();
const server = createServer(app);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening.');
});

/** Finish in-flight requests before the process goes away. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down.');
  server.close(() => {
    closeDatabase()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
