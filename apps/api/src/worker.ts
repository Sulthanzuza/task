import { logger } from './lib/logger';
import { closeDatabase } from './db/client';
import { purgeExpired } from './modules/auth/service';

/**
 * The background worker. It runs the same code as the API, started from a different
 * entry point, so jobs reuse the services and rules rather than reimplementing them.
 *
 * Scheduled alerts, the daily digest and recurring tasks (prompts 13 and 16) register here.
 * For now it only does housekeeping, on a plain interval; pg-boss takes over when the
 * alert jobs land.
 */

const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;

async function housekeeping(): Promise<void> {
  const removed = await purgeExpired();
  if (removed.sessions > 0 || removed.resets > 0) {
    logger.info(removed, 'Purged expired sessions and reset tokens.');
  }
}

async function main(): Promise<void> {
  logger.info('Worker started.');
  await housekeeping();
  const timer = setInterval(() => {
    housekeeping().catch((error: unknown) => {
      logger.error({ err: error }, 'Housekeeping failed.');
    });
  }, HOUSEKEEPING_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down.');
    clearInterval(timer);
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
