import { pool } from '../config/database.ts';
import { DatabaseError } from '../utils/errors.ts';
import type { Notification, NotificationStatus, NotificationPriority } from '../types/index.ts';

export interface CreateNotificationRowInput {
  user_id: string;
  type: string;
  channel: 'email' | 'sms' | 'push' | 'in_app';
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  priority: NotificationPriority;
  idempotency_key?: string | null | undefined;
  scheduled_for?: string | null | undefined; // ISO string from schema; stored as timestamptz
}

/**
 * Repository layer for `notifications`.
 *
 * Intent:
 * - Keep SQL close to the DB schema (easy to audit + optimize).
 * - Return plain domain objects; business rules live in services.
 */
export async function insertNotification(
  input: CreateNotificationRowInput,
  initialStatus: NotificationStatus,
): Promise<Pick<Notification, 'id' | 'status' | 'created_at'>> {
  const sql = `
    INSERT INTO notifications (
      user_id, type, channel, title, body, metadata,
      status, priority, idempotency_key, scheduled_for
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10
    )
    RETURNING id, status, created_at;
  `;

  try {
    const result = await pool.query<{
      id: string;
      status: NotificationStatus;
      created_at: Date;
    }>(sql, [
      input.user_id,
      input.type,
      input.channel,
      input.title,
      input.body,
      input.metadata,
      initialStatus,
      input.priority,
      input.idempotency_key ?? null,
      input.scheduled_for ?? null,
    ]);

    const row = result.rows[0];
    if (!row) {
      throw new DatabaseError('Insert notification returned no rows');
    }
    return row;
  } catch (err: unknown) {
    // Let services translate known PG codes (FK/unique) into client errors.
    const message = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to insert notification: ${message}`);
  }
}

export async function markNotificationProcessing(notificationId: string): Promise<void> {
  const sql = `
    UPDATE notifications
    SET status = 'processing', updated_at = NOW()
    WHERE id = $1;
  `;
  await pool.query(sql, [notificationId]);
}

export async function markNotificationSent(notificationId: string): Promise<void> {
  const sql = `
    UPDATE notifications
    SET status = 'sent', sent_at = NOW(), updated_at = NOW()
    WHERE id = $1;
  `;
  await pool.query(sql, [notificationId]);
}

export async function markNotificationFailed(
  notificationId: string,
  failure: { errorMessage: string; attemptsMade: number; maxAttempts: number },
): Promise<{ becameDeadLetter: boolean }> {
  const isFinalAttempt = failure.attemptsMade >= failure.maxAttempts;

  await pool.query(
    `
    UPDATE notifications
    SET
      status = $2,
      attempt_count = $3,
      max_attempts = $4,
      last_error = $5,
      updated_at = NOW()
    WHERE id = $1;
  `,
    [
      notificationId,
      isFinalAttempt ? 'failed' : 'queued',
      failure.attemptsMade,
      failure.maxAttempts,
      failure.errorMessage,
    ],
  );

  if (!isFinalAttempt) {
    return { becameDeadLetter: false };
  }

  await pool.query(
    `
    INSERT INTO dead_letter_notifications (notification_id, error_message, error_stack)
    VALUES ($1, $2, $3);
  `,
    [notificationId, failure.errorMessage, null],
  );

  return { becameDeadLetter: true };
}

