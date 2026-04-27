/**
 * =============================================================================
 * USER VALIDATION SCHEMAS
 * =============================================================================
 *
 * This module defines Zod validation schemas for all user-related API inputs
 * in the notification service. Schemas validate and transform incoming request
 * data before it reaches the service layer.
 *
 * WHY VALIDATE WITH ZOD?
 * - Runtime safety: TypeScript types are erased at runtime. Zod ensures that
 *   data from external sources (HTTP requests, message queues) actually matches
 *   the expected shape before we operate on it.
 * - Coercion & defaults: Zod can set default values (e.g., preferred_channels
 *   defaults to ['email']) and coerce types — transforming raw request data
 *   into a clean, predictable format for downstream code.
 * - Descriptive errors: Zod produces structured error objects with paths and
 *   messages, making it easy to return 422 responses with field-level details.
 * - Type inference: `z.infer<typeof schema>` derives TypeScript types directly
 *   from the schema, eliminating manual type definitions and keeping them in
 *   sync automatically.
 *
 * SCHEMAS IN THIS MODULE:
 * 1. createUserSchema        — Validates POST /api/users request bodies.
 * 2. updateUserPreferencesSchema — Validates PATCH /api/users/:id/preferences.
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
 * Notification channel enum — reusable across multiple schemas.
 *
 * Matches the `NotificationChannel` type defined in `src/types/index.ts`:
 *   'email' | 'sms' | 'push' | 'in_app'
 *
 * Using `z.enum()` rather than `z.string()` ensures that only valid channel
 * identifiers are accepted. Any other string will produce a validation error.
 */
const notificationChannelEnum = z.enum(['email', 'sms', 'push', 'in_app']);

/* =========================================================================== */
/*  SCHEMA 1: CREATE USER                                                      */
/* =========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * createUserSchema — Validates the request body for creating a new user.
 * ---------------------------------------------------------------------------
 *
 * Used by: POST /api/users
 *
 * This schema enforces the minimum data required to register a notification
 * recipient. Only `email` is strictly required — all other fields have
 * sensible defaults or are optional/nullable.
 *
 * Field-by-field breakdown:
 *
 * - `email` (required): The user's email address. Validated using Zod's
 *   built-in `.email()` validator which checks for a valid email format
 *   (RFC 5322 simplified). This is the only required field because email
 *   is the default (and most universal) notification channel.
 *
 * - `phone` (optional, nullable): The user's phone number for SMS delivery.
 *   Must be in E.164 international format (e.g., +1234567890). The regex
 *   `^\+[1-9]\d{1,14}$` enforces:
 *     - Starts with `+` followed by a non-zero digit (no +0... numbers)
 *     - 2–15 digits total (per ITU-T E.164 specification)
 *   `.nullable()` allows explicit `null` (user has no phone).
 *   `.optional()` allows the field to be omitted entirely.
 *
 * - `device_token` (optional, nullable): The push notification token from
 *   FCM (Firebase Cloud Messaging) or APNs (Apple Push Notification service).
 *   Max 500 characters accommodates both FCM (~152 chars) and APNs (~64 chars)
 *   with generous headroom for future token format changes.
 *
 * - `preferred_channels` (optional with default): An array of channels the
 *   user wants to receive notifications on. Defaults to `['email']` since
 *   every user must provide an email. Users can later update this via the
 *   preferences endpoint.
 *
 * - `timezone` (optional with default): IANA timezone string (e.g.,
 *   'America/New_York', 'Europe/London'). Defaults to 'UTC'. Used to
 *   calculate quiet hours relative to the user's local time.
 * ---------------------------------------------------------------------------
 */
export const createUserSchema = z.object({
  /** User's email address — the primary identifier and default channel. */
  email: z.string().email('Invalid email address'),

  /**
   * Phone number in E.164 format for SMS notifications.
   * E.164 format: + followed by country code and subscriber number.
   * Examples: +14155552671 (US), +442071234567 (UK), +81312345678 (JP)
   */
  phone: z
    .string()
    .regex(/^\+[1-9]\d{1,14}$/, 'Phone must be in E.164 format')
    .nullable()
    .optional(),

  /**
   * Push notification device token (FCM registration token or APNs device token).
   * Capped at 500 characters to prevent abuse while accommodating all known formats.
   */
  device_token: z.string().max(500).nullable().optional(),

  /**
   * Ordered list of preferred notification delivery channels.
   * When sending a notification, the system respects this preference order.
   * Defaults to ['email'] — the most universally available channel.
   */
  preferred_channels: z
    .array(notificationChannelEnum)
    .default(['email']),

  /**
   * IANA timezone identifier for the user's local time.
   * Used to enforce quiet hours in the user's timezone.
   * Defaults to 'UTC' when not provided.
   */
  timezone: z.string().default('UTC'),
});

/* =========================================================================== */
/*  SCHEMA 2: UPDATE USER PREFERENCES                                          */
/* =========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * updateUserPreferencesSchema — Validates the request body for updating
 * a user's notification preferences.
 * ---------------------------------------------------------------------------
 *
 * Used by: PATCH /api/users/:id/preferences
 *
 * This is a partial update schema — all fields are optional. The client only
 * needs to send the fields they want to change. Omitted fields remain
 * unchanged in the database.
 *
 * Field-by-field breakdown:
 *
 * - `preferred_channels` (optional): Replace the user's channel preference
 *   list entirely. To add/remove a single channel, the client must send
 *   the complete updated array.
 *
 * - `quiet_hours_start` (optional, nullable): The start time of the user's
 *   "Do Not Disturb" window in 24-hour HH:MM format. During quiet hours,
 *   non-critical notifications are deferred until the window ends.
 *   Setting to `null` disables quiet hours.
 *   Regex `^([01]\d|2[0-3]):([0-5]\d)$` validates:
 *     - Hours: 00–23 (24-hour format)
 *     - Minutes: 00–59
 *     - Separator: colon
 *   Examples: '22:00', '08:30', '00:00', '23:59'
 *
 * - `quiet_hours_end` (optional, nullable): The end time of the quiet hours
 *   window. Same format and validation as `quiet_hours_start`. The end time
 *   can be "earlier" than the start time to span midnight (e.g., start=22:00,
 *   end=07:00 means quiet from 10 PM to 7 AM).
 *
 * - `timezone` (optional): Update the user's timezone. Affects quiet hours
 *   calculation. If the user moves to a different timezone, updating this
 *   ensures quiet hours remain correct for their new location.
 * ---------------------------------------------------------------------------
 */
export const updateUserPreferencesSchema = z.object({
  /** Updated list of preferred notification channels. */
  preferred_channels: z.array(notificationChannelEnum).optional(),

  /**
   * Start of quiet hours in HH:MM 24-hour format.
   * Set to null to disable quiet hours entirely.
   */
  quiet_hours_start: z
    .string()
    .regex(
      /^([01]\d|2[0-3]):([0-5]\d)$/,
      'Must be HH:MM format',
    )
    .nullable()
    .optional(),

  /**
   * End of quiet hours in HH:MM 24-hour format.
   * Can be "before" quiet_hours_start to span midnight.
   */
  quiet_hours_end: z
    .string()
    .regex(
      /^([01]\d|2[0-3]):([0-5]\d)$/,
      'Must be HH:MM format',
    )
    .nullable()
    .optional(),

  /** IANA timezone identifier (e.g., 'America/Chicago', 'Asia/Tokyo'). */
  timezone: z.string().optional(),
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
 * `z.infer<>`. This means:
 * - No manual type definitions to maintain.
 * - Types are always perfectly in sync with validation rules.
 * - Changes to the schema automatically update the types.
 *
 * We use `export type` (not `export`) because `verbatimModuleSyntax` is
 * enabled in tsconfig.json. This flag requires that type-only exports are
 * explicitly annotated — TypeScript will error if you use a plain `export`
 * for something that only exists at the type level.
 * ---------------------------------------------------------------------------
 */

/**
 * CreateUserInput — The fully validated and defaulted shape of a "create user"
 * request body. After parsing through `createUserSchema`, you're guaranteed:
 * - `email` is a valid email string.
 * - `phone` is either a valid E.164 string, null, or undefined.
 * - `device_token` is either a string (≤500 chars), null, or undefined.
 * - `preferred_channels` is a non-empty array of valid channels (default: ['email']).
 * - `timezone` is a string (default: 'UTC').
 */
export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * UpdateUserPreferencesInput — The validated shape of a "update preferences"
 * request body. All fields are optional (partial update). After parsing,
 * only the fields the client explicitly sent will be present.
 */
export type UpdateUserPreferencesInput = z.infer<typeof updateUserPreferencesSchema>;
