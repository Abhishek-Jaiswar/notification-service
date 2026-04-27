import { createApp } from './app.ts';
import { testDatabaseConnection, closeDatabasePool } from './config/database.ts';
import { env } from './config/environment.ts';
import { testRedisConnection, closeRedisConnection } from './config/redis.ts';
import { setupGracefulShutdown, logger } from './utils/index.ts';

async function main(): Promise<void> {
  await testRedisConnection();

  const dbOk = await testDatabaseConnection();
  if (!dbOk) {
    logger.error('Database connection failed at startup — exiting');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info('HTTP server listening', { port: env.PORT, nodeEnv: env.NODE_ENV });
  });

  setupGracefulShutdown(server, async () => {
    await closeRedisConnection();
    await closeDatabasePool();
  });
}

main().catch((err: unknown) => {
  logger.error('Fatal startup error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
