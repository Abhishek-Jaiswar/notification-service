import { Queue } from 'bullmq';

import redis from '../config/redis.ts';
import type { NotificationJobData, NotificationPriority } from '../types/index.ts';

/**
 * BullMQ processes lower numeric priority values first.
 *
 * We keep the mapping in one place so API + workers agree on ordering.
 */
function toBullMqPriority(priority: NotificationPriority): number {
  switch (priority) {
    case 'critical':
      return 1;
    case 'high':
      return 2;
    case 'normal':
      return 3;
    case 'low':
      return 4;
    default: {
      // Exhaustiveness guard: if the union changes, TS will complain here.
      const _exhaustive: never = priority;
      return _exhaustive;
    }
  }
}

export const NOTIFICATION_QUEUE_NAME = 'notifications';
export const NOTIFICATION_JOB_NAME = 'send-notification';

/**
 * Singleton queue instance used by the HTTP API for enqueueing work.
 *
 * Notes:
 * - We pass the shared ioredis client so the whole service uses one connection
 *   configuration (and we centralize reconnect behavior).
 * - Jobs are retried with exponential backoff so transient provider/network
 *   issues don't immediately create dead letters.
 */
export const notificationQueue = new Queue<NotificationJobData>(NOTIFICATION_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 60 * 60, count: 10_000 },
    removeOnFail: { age: 24 * 60 * 60, count: 50_000 },
  },
});

export async function enqueueNotificationJob(
  data: NotificationJobData,
  options?: { maxAttempts?: number; priority?: NotificationPriority },
): Promise<void> {
  const attempts = options?.maxAttempts ?? 3;
  const priority = options?.priority ?? data.priority;

  await notificationQueue.add(NOTIFICATION_JOB_NAME, data, {
    attempts,
    priority: toBullMqPriority(priority),
  });
}

