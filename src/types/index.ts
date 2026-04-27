/**
 * =============================================================================
 * TYPE DEFINITIONS
 * =============================================================================
 *
 * This module contains all shared TypeScript types and interfaces used across
 * the notification service. Centralizing types in one place provides:
 *
 * - A single source of truth for data shapes (no duplicated interface defs).
 * - Easy discoverability — new developers can read this file to understand
 *   the core domain model of the entire application.
 * - Clean imports — any module can `import type { Notification } from '../types/index.js'`.
 *
 * ORGANIZATION:
 * 1. Type aliases (union literal types for enums)
 * 2. Core domain interfaces (User, Notification, NotificationTemplate)
 * 3. Infrastructure interfaces (DeadLetterNotification, NotificationJobData)
 * 4. API utility types (Pagination, ServiceResponse, HealthStatus)
 *
 * WHY TYPE ALIASES INSTEAD OF ENUMS?
 * We use union literal types (e.g., 'email' | 'sms') instead of TypeScript
 * enums because:
 * - They produce zero runtime JavaScript (enums generate objects).
 * - They work naturally with `verbatimModuleSyntax` (no import issues).
 * - They're simpler to use in type narrowing and pattern matching.
 * - They align with how PostgreSQL stores these values (as text/varchar).
 *
 * NOTE: All exports use `export type` because this file contains ONLY types
 * (no runtime values). With `verbatimModuleSyntax: true`, TypeScript enforces
 * that type-only exports are explicitly marked.
 * =============================================================================
 */

/* =========================================================================== */
/*  SECTION 1: TYPE ALIASES (Union Literal Types)                              */
/* =========================================================================== */

/**
 * NotificationChannel — The delivery mechanism for a notification.
 *
 * - 'email': Delivered via SMTP/email service (e.g., SendGrid, SES).
 * - 'sms': Delivered via SMS gateway (e.g., Twilio, SNS).
 * - 'push': Delivered via push notification service (e.g., FCM, APNs).
 * - 'in_app': Stored in the database and displayed within the application UI.
 *
 * A single notification type (e.g., "order_confirmed") might be sent through
 * multiple channels based on user preferences.
 */
export type NotificationChannel = 'email' | 'sms' | 'push' | 'in_app';

/**
 * NotificationStatus — Tracks the lifecycle of a notification.
 *
 * The state machine flow is typically:
 *   pending → queued → processing → sent → delivered
 *                                 ↘ failed (may retry → processing)
 *   Any state → cancelled (manual cancellation)
 *
 * - 'pending': Just created, not yet added to the job queue.
 * - 'queued': Added to BullMQ queue, waiting for a worker to pick it up.
 * - 'processing': A worker has picked it up and is attempting delivery.
 * - 'sent': Successfully handed off to the delivery provider (email/SMS/push).
 * - 'delivered': Confirmed delivery (e.g., delivery receipt from provider).
 * - 'failed': All retry attempts exhausted; moved to dead letter queue.
 * - 'cancelled': Manually cancelled before delivery (e.g., by admin or user).
 */
export type NotificationStatus =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'cancelled';

/**
 * NotificationPriority — Determines processing order in the job queue.
 *
 * BullMQ supports priority-based job ordering. Lower numeric priority values
 * are processed first. Our mapping:
 * - 'critical': Priority 1 — Security alerts, 2FA codes, password resets.
 * - 'high':     Priority 2 — Order confirmations, payment receipts.
 * - 'normal':   Priority 3 — General updates, activity notifications.
 * - 'low':      Priority 4 — Marketing, digests, non-urgent updates.
 */
export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';

/* =========================================================================== */
/*  SECTION 2: CORE DOMAIN INTERFACES                                          */
/* =========================================================================== */

/**
 * User — Represents a notification recipient in the system.
 *
 * This mirrors the `users` table in PostgreSQL. Each field maps to a column.
 *
 * Design decisions:
 * - `phone` and `device_token` are nullable because not all users have them.
 * - `preferred_channels` is an array, allowing users to opt into multiple
 *   delivery channels (stored as a PostgreSQL ARRAY or JSONB column).
 * - `quiet_hours_start/end` enable "Do Not Disturb" functionality — if set,
 *   notifications during these hours are deferred until the quiet period ends.
 * - `timezone` is stored as an IANA timezone string (e.g., 'America/New_York')
 *   to correctly calculate quiet hours relative to the user's local time.
 * - `is_active` allows soft-disabling all notifications for a user.
 */
export interface User {
  /** UUID primary key, generated by PostgreSQL using gen_random_uuid(). */
  id: string;

  /** User's email address — used for the 'email' channel. */
  email: string;

  /** User's phone number in E.164 format (e.g., +1234567890) — for 'sms'. */
  phone: string | null;

  /** Device token for push notifications (FCM/APNs token) — for 'push'. */
  device_token: string | null;

  /** Ordered list of channels the user prefers to receive notifications on. */
  preferred_channels: NotificationChannel[];

  /** Start of quiet hours in HH:MM format (24h), e.g., '22:00'. */
  quiet_hours_start: string | null;

  /** End of quiet hours in HH:MM format (24h), e.g., '08:00'. */
  quiet_hours_end: string | null;

  /** IANA timezone identifier, e.g., 'America/New_York', 'UTC'. */
  timezone: string;

  /** Whether the user should receive any notifications at all. */
  is_active: boolean;

  /** Timestamp when the user record was created. */
  created_at: Date;

  /** Timestamp when the user record was last updated. */
  updated_at: Date;
}

/**
 * Notification — The core entity representing a single notification.
 *
 * This mirrors the `notifications` table in PostgreSQL. It captures everything
 * needed to process, deliver, track, and retry a notification.
 *
 * Design decisions:
 * - `metadata` is a flexible JSON object for channel-specific data (e.g.,
 *   email attachments, push badge count, deep link URLs).
 * - `idempotency_key` prevents duplicate notifications — if the same key
 *   is submitted twice, the second request is ignored.
 * - `attempt_count` / `max_attempts` / `next_retry_at` support exponential
 *   backoff retry logic managed by BullMQ workers.
 * - Separate timestamp fields (sent_at, delivered_at, read_at) enable
 *   detailed analytics and SLA tracking.
 */
export interface Notification {
  /** UUID primary key. */
  id: string;

  /** Foreign key → users.id — the recipient of this notification. */
  user_id: string;

  /** Notification type identifier, e.g., 'order_confirmed', 'password_reset'. */
  type: string;

  /** The delivery channel used for this specific notification instance. */
  channel: NotificationChannel;

  /** Short title/subject line (used as email subject, push title, etc.). */
  title: string;

  /** Full notification body/message content. */
  body: string;

  /**
   * Arbitrary metadata as key-value pairs. Examples:
   * - { orderId: '12345', trackingUrl: 'https://...' }
   * - { attachments: [...], replyTo: 'support@example.com' }
   *
   * `Record<string, unknown>` is a safe type for JSON — values can be
   * strings, numbers, booleans, arrays, or nested objects.
   */
  metadata: Record<string, unknown>;

  /** Current lifecycle status of this notification. */
  status: NotificationStatus;

  /** Processing priority in the BullMQ queue. */
  priority: NotificationPriority;

  /**
   * Client-provided idempotency key to prevent duplicate sends.
   * If null, no deduplication is performed.
   */
  idempotency_key: string | null;

  /** How many delivery attempts have been made so far. */
  attempt_count: number;

  /** Maximum number of delivery attempts before giving up. */
  max_attempts: number;

  /** The error message from the most recent failed attempt. */
  last_error: string | null;

  /** When the next retry attempt should occur (null if not retrying). */
  next_retry_at: Date | null;

  /** When the notification is scheduled to be sent (null = send immediately). */
  scheduled_for: Date | null;

  /** Timestamp when the notification was handed off to the delivery provider. */
  sent_at: Date | null;

  /** Timestamp when delivery was confirmed by the provider. */
  delivered_at: Date | null;

  /** Timestamp when the user read/opened the notification. */
  read_at: Date | null;

  /** Timestamp when this notification record was created. */
  created_at: Date;

  /** Timestamp when this notification record was last updated. */
  updated_at: Date;
}

/**
 * NotificationTemplate — Reusable templates for generating notifications.
 *
 * Templates use placeholder syntax (e.g., Handlebars-style `{{userName}}`)
 * that gets interpolated with actual data at send time. This separates
 * content from logic and allows non-developers to edit notification copy.
 *
 * Example:
 *   title_template: "Hello, {{userName}}!"
 *   body_template:  "Your order #{{orderId}} has been shipped."
 */
export interface NotificationTemplate {
  /** UUID primary key. */
  id: string;

  /** Unique template name/identifier, e.g., 'order_shipped_email'. */
  name: string;

  /** Which channel this template is designed for. */
  channel: NotificationChannel;

  /** Title/subject template string with placeholders. */
  title_template: string;

  /** Body/content template string with placeholders. */
  body_template: string;

  /** Whether this template is currently active (soft-delete pattern). */
  is_active: boolean;

  /** Timestamp when the template was created. */
  created_at: Date;

  /** Timestamp when the template was last updated. */
  updated_at: Date;
}

/* =========================================================================== */
/*  SECTION 3: INFRASTRUCTURE INTERFACES                                       */
/* =========================================================================== */

/**
 * DeadLetterNotification — Records of notifications that exhausted all retries.
 *
 * When a notification fails after `max_attempts`, it's moved to the dead letter
 * queue (DLQ). This table preserves the failure details for debugging and
 * allows manual reprocessing after the underlying issue is fixed.
 *
 * WHY A DEAD LETTER QUEUE?
 * - Prevents failed jobs from being silently lost.
 * - Provides an audit trail for debugging delivery issues.
 * - Enables manual or automated reprocessing of failed notifications.
 */
export interface DeadLetterNotification {
  /** UUID primary key for the dead letter record. */
  id: string;

  /** Foreign key → notifications.id — the notification that failed. */
  notification_id: string;

  /** Human-readable error message describing why delivery failed. */
  error_message: string;

  /** Full error stack trace for debugging (may be null for non-Error throws). */
  error_stack: string | null;

  /** Timestamp when the notification was moved to the dead letter queue. */
  failed_at: Date;

  /** Whether this dead letter entry has been manually reprocessed. */
  reprocessed: boolean;
}

/**
 * NotificationJobData — The payload passed to BullMQ worker jobs.
 *
 * When we enqueue a notification for processing, we don't pass the entire
 * Notification object. Instead, we pass just the identifiers and routing
 * information needed for the worker to:
 * 1. Look up the full notification from the database.
 * 2. Route it to the correct channel handler (email, SMS, push, in-app).
 * 3. Apply priority-based ordering in the queue.
 *
 * WHY MINIMAL JOB DATA?
 * - Keeps Redis memory usage low (BullMQ stores job data in Redis).
 * - Ensures the worker always reads the latest notification state from the
 *   database (avoiding stale data issues).
 * - Reduces coupling between the queue and the database schema.
 */
export interface NotificationJobData {
  /** The notification's UUID — used to fetch full details from PostgreSQL. */
  notificationId: string;

  /** The recipient's UUID — used for user-specific logic (quiet hours, etc.). */
  userId: string;

  /** Which channel handler should process this job. */
  channel: NotificationChannel;

  /** Job priority for BullMQ queue ordering. */
  priority: NotificationPriority;
}

/* =========================================================================== */
/*  SECTION 4: API UTILITY TYPES                                               */
/* =========================================================================== */

/**
 * PaginationParams — Input parameters for paginated list endpoints.
 *
 * Used by API route handlers to accept pagination from query strings:
 *   GET /api/notifications?page=2&limit=25
 *
 * - `page`: 1-indexed page number (first page is 1, not 0).
 * - `limit`: Number of items per page (typically capped at 100).
 */
export interface PaginationParams {
  /** The page number to retrieve (1-indexed). */
  page: number;

  /** Maximum number of items to return per page. */
  limit: number;
}

/**
 * PaginatedResult<T> — Standard wrapper for paginated API responses.
 *
 * Generic type `T` represents the type of items in the list (e.g.,
 * `PaginatedResult<Notification>` for a list of notifications).
 *
 * Includes all the metadata a frontend needs to build pagination controls:
 * - Total item count for "Showing X of Y results".
 * - Total pages for "Page 2 of 5" display.
 * - Current page and limit for highlighting the active page.
 */
export interface PaginatedResult<T> {
  /** Array of items for the current page. */
  data: T[];

  /** Total number of items across all pages. */
  total: number;

  /** Current page number (mirrors the input). */
  page: number;

  /** Items per page (mirrors the input). */
  limit: number;

  /** Total number of pages: Math.ceil(total / limit). */
  totalPages: number;
}

/**
 * ServiceResponse<T> — Standard wrapper for service layer return values.
 *
 * Provides a consistent shape for all service method returns, making it
 * easy for controllers to check `response.success` and either use the
 * data or return the error.
 *
 * WHY NOT THROW ERRORS?
 * While we do throw for unexpected errors (which get caught by error
 * middleware), for expected/operational outcomes (e.g., "user not found"),
 * returning a result object avoids the performance overhead of exception
 * handling and makes the control flow more explicit.
 *
 * Generic type `T` is the shape of the successful response data.
 */
export interface ServiceResponse<T> {
  /** Whether the operation completed successfully. */
  success: boolean;

  /** The result data — present only when success is true. */
  data?: T;

  /** Error message — present only when success is false. */
  error?: string;
}

/**
 * HealthStatus — Response shape for the GET /health endpoint.
 *
 * Health checks are critical for:
 * - Container orchestrators (Kubernetes, ECS) to know if a pod is healthy.
 * - Load balancers to route traffic away from unhealthy instances.
 * - Monitoring dashboards to display service status.
 *
 * Status levels:
 * - 'healthy': All services connected and responsive.
 * - 'degraded': Some non-critical services down (e.g., Redis down but DB up).
 * - 'unhealthy': Critical services down (e.g., database unreachable).
 */
export interface HealthStatus {
  /** Overall health status of the service. */
  status: 'healthy' | 'degraded' | 'unhealthy';

  /** ISO 8601 timestamp of when this health check was performed. */
  timestamp: string;

  /** How long the process has been running, in seconds. */
  uptime: number;

  /**
   * Individual health status of each dependency.
   * `true` means the service is reachable and responsive.
   * `false` means the service is down or unreachable.
   */
  services: {
    /** Whether PostgreSQL is reachable (simple query succeeds). */
    database: boolean;

    /** Whether Redis is reachable (PING returns PONG). */
    redis: boolean;

    /** Whether the BullMQ queue is operational. */
    queue: boolean;
  };
}
