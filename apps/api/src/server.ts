import { createServer } from 'node:http';
import { createApp } from './app';
import { assertProductionConfig, env, unsafeProductionSettings } from './config/env';
import { logger } from './lib/logger';
import { closeDatabase } from './db/client';
import { closeRealtime, createRealtimeGateway } from './realtime/gateway';

const app = createApp();
const server = createServer(app);

// Shares the HTTP server, so the Vite proxy and Nginx forward /socket.io on the
// same origin as the API.
createRealtimeGateway(server);

// A misconfigured production process must not serve at all.
assertProductionConfig();

// Say so loudly if a relaxed test setting has reached production.
for (const warning of unsafeProductionSettings()) {
  logger.warn({ setting: warning }, 'Unsafe setting for production.');
}

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening.');
});

/** Finish in-flight requests before the process goes away. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down.');
  server.close(() => {
    void closeRealtime();
    closeDatabase()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
