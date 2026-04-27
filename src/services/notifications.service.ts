import { ConflictError, ValidationError } from '../utils/errors.ts';
import { enqueueNotificationJob } from '../queue/notification.queue.ts';
import { insertNotification } from '../repositories/notifications.repository.ts';
import type { CreateNotificationInput } from '../schemas/notification.schema.ts';
import type { NotificationJobData, NotificationStatus } from '../types/index.ts';

/**
 * Service for creating notifications.
 *
 * Design intent:
 * - HTTP layer should be thin (validate + call service + return).
 * - Service coordinates DB + queue, and is the single place to apply rules
 *   like scheduled delivery vs immediate enqueueing.
 */
export async function createNotification(input: CreateNotificationInput): Promise<{
  id: string;
  status: NotificationStatus;
  enqueued: boolean;
}> {
  const shouldEnqueueNow = !input.scheduled_for;
  const initialStatus: NotificationStatus = shouldEnqueueNow ? 'queued' : 'pending';

  try {
    const row = await insertNotification(
      {
        user_id: input.user_id,
        type: input.type,
        channel: input.channel,
        title: input.title,
        body: input.body,
        metadata: input.metadata,
        priority: input.priority,
        idempotency_key: input.idempotency_key,
        scheduled_for: input.scheduled_for,
      },
      initialStatus,
    );

    if (!shouldEnqueueNow) {
      return { id: row.id, status: row.status, enqueued: false };
    }

    const jobData: NotificationJobData = {
      notificationId: row.id,
      userId: input.user_id,
      channel: input.channel,
      priority: input.priority,
    };

    await enqueueNotificationJob(jobData, { maxAttempts: 3, priority: input.priority });

    return { id: row.id, status: row.status, enqueued: true };
  } catch (err: unknown) {
    /**
     * The repository wraps unexpected DB errors into DatabaseError. For learning
     * ergonomics we also want to surface *expected* DB constraint failures
     * as client-friendly errors. `pg` errors carry `code` and `constraint`.
     */
    const pgCode = typeof err === 'object' && err ? (err as any).code : undefined;
    const message = err instanceof Error ? err.message : String(err);

    // Unique violation — likely idempotency_key already used.
    if (pgCode === '23505') {
      throw new ConflictError('Duplicate idempotency_key: notification already exists');
    }
    // Foreign key violation — user_id does not exist.
    if (pgCode === '23503') {
      throw new ValidationError('Invalid user_id: user does not exist');
    }

    throw err instanceof Error ? err : new Error(message);
  }
}

