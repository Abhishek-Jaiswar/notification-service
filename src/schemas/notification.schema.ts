/**
 * =============================================================================
 * NOTIFICATION VALIDATION SCHEMAS
 * =============================================================================
 *
 * This module defines Zod validation schemas for all notification-related API
 * inputs in the notification service. These schemas validate request bodies
 * and query parameters before they reach the service layer, ensuring that
 * only well-formed data enters the processing pipeline.
 *
 * WHY SEPARATE FROM USER SCHEMAS?
 * Notification schemas are in their own file because:
 * - They have different concerns (delivery routing vs. user identity).
 * - They change independently (new notification fields don't affect users).
 * - It keeps each file focused and easier to navigate.
 * - Import paths are more descriptive:
 *     import { createNotificationSchema } from './notification.schema.ts'
 *     import { createUserSchema } from './user.schema.ts'
 *
 * SCHEMAS IN THIS MODULE:
 * 1. createNotificationSchema — Validates POST /api/notifications bodies.
 * 2. bulkNotificationSchema   — Validates POST /api/notifications/bulk bodies.
 * 3. paginationSchema         — Validates pagination query parameters.
 *
 * NOTE: We use `export type` for type-only exports because the project has
 * `verbatimModuleSyntax: true` in tsconfig.json, which requires type exports
 * to be explicitly marked as such.
 * =============================================================================
 */

// --------------------------------------------------------------------------
// Import Zod 4 from the v4 subpath. The 'zod' package ships both v3 (at 'zod')
// and v4 (at 'zod/v4') to allow incremental migration. We use v4 exclusively.
// --------------------------------------------------------------------------
import { z } from 'zod/v4';

/* =========================================================================== */
/*  SHARED ENUMS                                                               */
/* =========================================================================== */

/**
 * Notification channel enum — the delivery mechanism for a notification.
 *
 * Matches the `NotificationChannel` type defined in `src/types/index.ts`:
 *   'email' | 'sms' | 'push' | 'in_app'
 *
 * Each channel has its own delivery handler in the worker layer:
 * - 'email': Routes to SMTP/email service provider (e.g., SendGrid, SES).
 * - 'sms': Routes to SMS gateway (e.g., Twilio, Amazon SNS).
 * - 'push': Routes to push service (e.g., Firebase Cloud Messaging, APNs).
 * - 'in_app': Stored directly in the database for in-application display.
 */
const notificationChannelEnum = z.enum(['email', 'sms', 'push', 'in_app']);

/**
 * Notification priority enum — determines processing order in the BullMQ queue.
 *
 * Matches the `NotificationPriority` type defined in `src/types/index.ts`:
 *   'low' | 'normal' | 'high' | 'critical'
 *
 * BullMQ processes higher-priority jobs first. Our priority-to-number mapping:
 * - 'critical' → 1 (processed first) — 2FA codes, security alerts.
 * - 'high'     → 2 — Order confirmations, payment receipts.
 * - 'normal'   → 3 — General updates, activity notifications.
 * - 'low'      → 4 (processed last) — Marketing, digests, newsletters.
 *
 * Critical notifications also bypass quiet hours, ensuring time-sensitive
 * messages (like password reset codes) are delivered immediately.
 */
const notificationPriorityEnum = z.enum(['low', 'normal', 'high', 'critical']);

/* =========================================================================== */
/*  SCHEMA 1: CREATE NOTIFICATION                                              */
/* =========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * createNotificationSchema — Validates the request body for sending a single
 * notification to a user.
 * ---------------------------------------------------------------------------
 *
 * Used by: POST /api/notifications
 *
 * This is the primary schema for the notification service's core operation:
 * accepting a notification request, validating it, and enqueuing it for
 * asynchronous delivery via BullMQ.
 *
 * Field-by-field breakdown:
 *
 * - `user_id` (required): UUID of the recipient user. Validated as a proper
 *   UUID v4 format to prevent SQL injection and ensure referential integrity
 *   before hitting the database.
 *
 * - `type` (required): A string identifier for the notification category,
 *   e.g., 'order_confirmed', 'password_reset', 'payment_received'. Used for:
 *   - Routing to the correct template.
 *   - Analytics (notification volume by type).
 *   - User preferences (users might mute specific types).
 *   Max 100 characters to keep it concise and indexable.
 *
 * - `channel` (required): Which delivery channel to use for this notification.
 *   While users have `preferred_channels`, the API caller explicitly chooses
 *   the channel per notification. This allows sending the same notification
 *   type through different channels (e.g., email + push for order updates).
 *
 * - `title` (required): The notification title/subject line. Used as:
 *   - Email subject line.
 *   - Push notification title.
 *   - In-app notification heading.
 *   - SMS: typically prepended to the body or omitted.
 *   Max 500 characters — long enough for descriptive subjects, short enough
 *   to display well on mobile devices.
 *
 * - `body` (required): The full notification content/message. No max length
 *   constraint because email bodies can be quite long (HTML content).
 *
 * - `metadata` (optional with default): A flexible key-value object for
 *   channel-specific or notification-specific data. Examples:
 *     { orderId: '12345', trackingUrl: 'https://...' }
 *     { templateId: 'welcome_v2', locale: 'en-US' }
 *     { badge: 5, sound: 'default', deepLink: 'myapp://orders/123' }
 *   Uses `z.record(z.string(), z.unknown())` — keys must be strings,
 *   values can be anything JSON-serializable. Defaults to `{}`.
 *
 * - `priority` (optional with default): Processing priority in the queue.
 *   Defaults to 'normal'. Most notifications don't need elevated priority —
 *   use 'high' or 'critical' sparingly to avoid priority inversion.
 *
 * - `idempotency_key` (optional, nullable): A client-provided unique key
 *   to prevent duplicate notification sends. If two requests arrive with
 *   the same idempotency_key, the second is silently ignored. Max 255
 *   characters (fits in a VARCHAR(255) index). Common patterns:
 *     `${userId}-${eventType}-${eventId}` (e.g., 'usr_123-order_shipped-ord_456')
 *
 * - `scheduled_for` (optional, nullable): ISO 8601 datetime string for
 *   delayed/scheduled delivery. If provided, the notification is stored
 *   with status 'pending' and not enqueued until the scheduled time arrives.
 *   Uses `.datetime()` validator which accepts ISO 8601 format:
 *     '2025-01-15T09:00:00Z'
 *     '2025-01-15T09:00:00.000Z'
 *     '2025-01-15T09:00:00+05:30'
 *   If null or omitted, the notification is sent immediately.
 * ---------------------------------------------------------------------------
 */
export const createNotificationSchema = z.object({
  /** UUID of the recipient user — must be a valid UUID v4 format. */
  user_id: z.string().uuid('Invalid user ID format'),

  /**
   * Notification type identifier (e.g., 'order_confirmed', 'password_reset').
   * Used for template routing, analytics, and user preference filtering.
   */
  type: z.string().min(1, 'Notification type is required').max(100),

  /** Delivery channel for this notification instance. */
  channel: notificationChannelEnum,

  /**
   * Notification title/subject. Displayed as email subject, push title, etc.
   * Must be non-empty and at most 500 characters.
   */
  title: z.string().min(1, 'Title is required').max(500),

  /**
   * Full notification body/message content.
   * No max length — email bodies may contain lengthy HTML.
   */
  body: z.string().min(1, 'Body is required'),

  /**
   * Arbitrary key-value metadata for channel-specific or context-specific data.
   * Stored as JSONB in PostgreSQL. Defaults to an empty object.
   */
  metadata: z.record(z.string(), z.unknown()).default({}),

  /**
   * Processing priority in the BullMQ job queue.
   * Defaults to 'normal'. Use 'critical' sparingly — only for security-sensitive
   * or time-critical notifications (2FA, password resets).
   */
  priority: notificationPriorityEnum.default('normal'),

  /**
   * Client-provided idempotency key to prevent duplicate sends.
   * If two requests share the same key, only the first is processed.
   */
  idempotency_key: z.string().max(255).nullable().optional(),

  /**
   * ISO 8601 datetime for scheduled/delayed delivery.
   * If null or omitted, the notification is sent immediately.
   * Example: '2025-07-20T14:30:00Z'
   */
  scheduled_for: z.string().datetime().nullable().optional(),
});

/* =========================================================================== */
/*  SCHEMA 2: BULK NOTIFICATIONS                                               */
/* =========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * bulkNotificationSchema — Validates the request body for sending multiple
 * notifications in a single API call.
 * ---------------------------------------------------------------------------
 *
 * Used by: POST /api/notifications/bulk
 *
 * This schema wraps `createNotificationSchema` in an array, allowing clients
 * to submit up to 1000 notifications in one request. This is useful for:
 * - Broadcasting announcements to multiple users.
 * - Sending multi-channel notifications (email + push for the same event).
 * - Batch processing from background jobs or integrations.
 *
 * Constraints:
 * - `.min(1)`: At least one notification must be in the array (prevents
 *   empty requests that would waste resources).
 * - `.max(1000)`: Upper bound to prevent abuse and memory issues. Processing
 *   1000 notifications means creating 1000 database rows and 1000 BullMQ
 *   jobs — a reasonable upper limit for a single HTTP request.
 *
 * Each element in the array is independently validated against the full
 * `createNotificationSchema`, so all individual field validations apply.
 * If any single notification in the batch is invalid, the entire request
 * is rejected (atomic validation — no partial processing).
 * ---------------------------------------------------------------------------
 */
export const bulkNotificationSchema = z.object({
  /**
   * Array of notification payloads to send. Each element is validated
   * against `createNotificationSchema`. Min 1, max 1000 per request.
   */
  notifications: z.array(createNotificationSchema).min(1).max(1000),
});

/* =========================================================================== */
/*  SCHEMA 3: PAGINATION                                                       */
/* =========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * paginationSchema — Validates pagination query parameters for list endpoints.
 * ---------------------------------------------------------------------------
 *
 * Used by: GET /api/notifications, GET /api/users, and other list endpoints.
 *
 * Query parameters arrive as strings (from the URL), so we use `z.coerce.number()`
 * to convert them to numbers before validation. For example:
 *   GET /api/notifications?page=2&limit=25
 *   → page: "2" → coerce → 2 (number) → validate (int, ≥1) → ✅
 *
 * Field-by-field breakdown:
 *
 * - `page` (optional with default): 1-indexed page number. Defaults to 1
 *   (first page). Must be a positive integer. Using 1-indexed pages is more
 *   intuitive for API consumers (page 1 = first page, not page 0).
 *   `z.coerce.number()` handles the string-to-number conversion, `.int()`
 *   ensures no fractional pages, `.min(1)` prevents zero/negative pages.
 *
 * - `limit` (optional with default): Number of items per page. Defaults to 20
 *   which is a reasonable batch size for most UIs. `.min(1)` prevents zero-item
 *   pages, `.max(100)` caps the upper bound to prevent clients from requesting
 *   enormous result sets that could strain the database (ORDER BY + LIMIT 10000
 *   is expensive).
 *
 * WHY z.coerce.number() INSTEAD OF z.number()?
 * Express (and most HTTP frameworks) parse query parameters as strings.
 * `z.number()` would reject "2" because it's a string, not a number.
 * `z.coerce.number()` first calls `Number(value)` to convert the string,
 * then applies the numeric validations. This is the standard pattern for
 * validating query parameters and form data with Zod.
 * ---------------------------------------------------------------------------
 */
export const paginationSchema = z.object({
  /**
   * Page number (1-indexed). Coerced from string to number.
   * Defaults to 1 (first page).
   */
  page: z.coerce.number().int().min(1).default(1),

  /**
   * Number of items per page. Coerced from string to number.
   * Defaults to 20. Capped at 100 to protect database performance.
   */
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/* =========================================================================== */
/*  INFERRED TYPES                                                             */
/* =========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * TYPE EXPORTS
 * ---------------------------------------------------------------------------
 *
 * These types are automatically inferred from the Zod schemas above using
 * `z.infer<>`. This eliminates the need for manually maintaining parallel
 * type definitions — the types are always perfectly in sync with the
 * validation rules.
 *
 * We use `export type` (not `export`) because `verbatimModuleSyntax` is
 * enabled in tsconfig.json. This flag requires that type-only exports are
 * explicitly annotated — TypeScript will error if you use a plain `export`
 * for something that only exists at the type level.
 * ---------------------------------------------------------------------------
 */

/**
 * CreateNotificationInput — The validated and defaulted shape of a "send
 * notification" request body. After parsing:
 * - `user_id` is a valid UUID string.
 * - `type` is a non-empty string (≤100 chars).
 * - `channel` is one of 'email' | 'sms' | 'push' | 'in_app'.
 * - `title` is a non-empty string (≤500 chars).
 * - `body` is a non-empty string.
 * - `metadata` is a Record<string, unknown> (default: {}).
 * - `priority` is one of 'low' | 'normal' | 'high' | 'critical' (default: 'normal').
 * - `idempotency_key` is a string (≤255 chars), null, or undefined.
 * - `scheduled_for` is an ISO 8601 datetime string, null, or undefined.
 */
export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;

/**
 * BulkNotificationInput — An object containing an array of 1–1000 notification
 * payloads, each individually validated against `createNotificationSchema`.
 */
export type BulkNotificationInput = z.infer<typeof bulkNotificationSchema>;

/**
 * PaginationInput — The validated and coerced shape of pagination query params.
 * After parsing:
 * - `page` is a positive integer (default: 1).
 * - `limit` is a positive integer between 1 and 100 (default: 20).
 */
export type PaginationInput = z.infer<typeof paginationSchema>;
