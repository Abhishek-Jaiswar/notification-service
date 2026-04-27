import { Worker } from 'bullmq';

import redis, { testRedisConnection, closeRedisConnection } from './config/redis.ts';
import { closeDatabasePool } from './config/database.ts';
import { NOTIFICATION_JOB_NAME, NOTIFICATION_QUEUE_NAME } from './queue/notification.queue.ts';
import type { NotificationJobData } from './types/index.ts';
import { logger, setupGracefulShutdown } from './utils/index.ts';
import {
  markNotificationFailed,
  markNotificationProcessing,
  markNotificationSent,
} from './repositories/notifications.repository.ts';

/**
 * Phase B worker: consumes notification jobs and performs a stub “send”.
 *
 * Why a stub sender?
 * - It lets us validate the end-to-end reliability plumbing (DB ↔ queue ↔ worker)
 *   before introducing provider-specific complexity and credentials.
 * - It gives us a safe default for learning and local testing.
 */
async function sendViaStubChannel(data: NotificationJobData): Promise<void> {
  logger.info('Stub send notification', {
    notificationId: data.notificationId,
    userId: data.userId,
    channel: data.channel,
    priority: data.priority,
  });
}

async function main(): Promise<void> {
  await testRedisConnection();

  const worker = new Worker<NotificationJobData>(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      if (job.name !== NOTIFICATION_JOB_NAME) {
        return;
      }

      await markNotificationProcessing(job.data.notificationId);
      await sendViaStubChannel(job.data);
      await markNotificationSent(job.data.notificationId);
    },
    {
      connection: redis,
      concurrency: 10,
    },
  );

  worker.on('completed', (job) => {
    logger.info('Job completed', { jobId: job.id, name: job.name });
  });

  worker.on('failed', async (job, err) => {
    if (!job) {
      logger.error('Job failed (no job instance)', { error: err.message });
      return;
    }

    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? 3;
    const errorMessage = err.message;

    logger.warn('Job failed', {
      jobId: job.id,
      name: job.name,
      attemptsMade,
      maxAttempts,
      error: errorMessage,
    });

    try {
      await markNotificationFailed(job.data.notificationId, {
        errorMessage,
        attemptsMade,
        maxAttempts,
      });
    } catch (e) {
      logger.error('Failed to update notification failure state', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // Keep the process alive; BullMQ worker maintains an active event loop.
  logger.info('Worker started', { queue: NOTIFICATION_QUEUE_NAME, job: NOTIFICATION_JOB_NAME });

  // Reuse the same shutdown orchestration to ensure Redis/DB close cleanly.
  // We create a minimal HTTP server just to leverage the existing helper.
  const http = await import('node:http');
  const server = http.createServer((_req, res) => res.end('worker'));
  server.listen(0);
  setupGracefulShutdown(server, async () => {
    await worker.close();
    await closeRedisConnection();
    await closeDatabasePool();
  });
}

main().catch((err: unknown) => {
  logger.error('Worker fatal error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});

