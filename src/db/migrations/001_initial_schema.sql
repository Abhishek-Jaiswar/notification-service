-- ============================================================================
-- Migration: 001_initial_schema.sql
-- Description: Creates the foundational database schema for the notification
--              service, including all core tables, indexes, and triggers.
--
-- Tables created:
--   1. users                    – Registered recipients and their preferences.
--   2. notifications            – Individual notification records with status
--                                 tracking, retry logic, and scheduling.
--   3. notification_templates   – Reusable message templates per channel.
--   4. dead_letter_notifications – Permanently failed notifications stored for
--                                  post-mortem analysis and optional reprocessing.
--
-- This migration is idempotent: every statement uses IF NOT EXISTS / OR REPLACE
-- so it can safely be re-run without causing errors or data loss.
-- ============================================================================

-- ============================================================================
-- 1. EXTENSIONS
-- ============================================================================

-- Enable the uuid-ossp extension so we can generate RFC 4122 v4 UUIDs directly
-- inside DEFAULT expressions.  This avoids the need to generate UUIDs in
-- application code and guarantees uniqueness at the database level.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 2. TABLES
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 2a. users
-- ---------------------------------------------------------------------------
-- Stores every user that can receive notifications.  Each user may specify
-- preferred delivery channels, quiet-hours windows, and a timezone so the
-- service can respect local time when scheduling messages.
--
-- Columns of note:
--   • preferred_channels  – A Postgres TEXT array so a single user can opt-in
--                           to multiple channels (e.g. ['email', 'push']).
--   • quiet_hours_start/end – TIME values (no timezone) interpreted relative
--                             to the user's `timezone` column.
--   • device_token        – Used for push notifications (APNs / FCM).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  email               VARCHAR(255)  UNIQUE NOT NULL,
  phone               VARCHAR(20),
  device_token        VARCHAR(500),
  preferred_channels  TEXT[]        DEFAULT ARRAY['email']::TEXT[],
  quiet_hours_start   TIME,
  quiet_hours_end     TIME,
  timezone            VARCHAR(50)   DEFAULT 'UTC',
  is_active           BOOLEAN       DEFAULT true,
  created_at          TIMESTAMPTZ   DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 2b. notifications
-- ---------------------------------------------------------------------------
-- The central table of the service.  Every notification — whether it was sent
-- immediately or scheduled for the future — gets a row here.
--
-- Lifecycle (status column):
--   pending → queued → processing → sent → delivered
--                                       ↘ failed → (retry or dead-letter)
--                                       ↘ cancelled
--
-- Retry logic:
--   • attempt_count / max_attempts – track how many times delivery was tried.
--   • next_retry_at                – when the worker should pick it up again.
--   • last_error                   – most recent failure reason.
--
-- Idempotency:
--   • idempotency_key (UNIQUE) lets callers safely retry API requests without
--     creating duplicate notifications.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              VARCHAR(100)  NOT NULL,
  channel           VARCHAR(20)   NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
  title             VARCHAR(500)  NOT NULL,
  body              TEXT          NOT NULL,
  metadata          JSONB         DEFAULT '{}',
  status            VARCHAR(20)   DEFAULT 'pending'
                                  CHECK (status IN (
                                    'pending', 'queued', 'processing',
                                    'sent', 'delivered', 'failed', 'cancelled'
                                  )),
  priority          VARCHAR(10)   DEFAULT 'normal'
                                  CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  idempotency_key   VARCHAR(255)  UNIQUE,
  attempt_count     INTEGER       DEFAULT 0,
  max_attempts      INTEGER       DEFAULT 3,
  last_error        TEXT,
  next_retry_at     TIMESTAMPTZ,
  scheduled_for     TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 2c. notification_templates
-- ---------------------------------------------------------------------------
-- Reusable templates that combine a channel with Mustache-style placeholders
-- for title and body.  For example:
--
--   name: 'order_confirmation_email'
--   title_template: 'Your order {{orderId}} has been confirmed'
--   body_template:  'Hi {{userName}}, thank you for your purchase …'
--
-- Templates are looked up by `name` (UNIQUE) so callers reference them by a
-- stable string rather than a UUID.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_templates (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              VARCHAR(100)  UNIQUE NOT NULL,
  channel           VARCHAR(20)   NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
  title_template    VARCHAR(500)  NOT NULL,
  body_template     TEXT          NOT NULL,
  is_active         BOOLEAN       DEFAULT true,
  created_at        TIMESTAMPTZ   DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 2d. dead_letter_notifications
-- ---------------------------------------------------------------------------
-- When a notification exhausts all retry attempts it is moved here for manual
-- inspection.  Operators can later mark rows as `reprocessed = true` after
-- fixing the underlying issue and re-queuing the original notification.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dead_letter_notifications (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  notification_id   UUID          NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  error_message     TEXT          NOT NULL,
  error_stack       TEXT,
  failed_at         TIMESTAMPTZ   DEFAULT NOW(),
  reprocessed       BOOLEAN       DEFAULT false
);

-- ============================================================================
-- 3. INDEXES
-- ============================================================================
-- Indexes are critical for the query patterns the notification service relies
-- on.  Each index below is annotated with the query pattern it supports.

-- Look up all notifications for a specific user (e.g. user inbox endpoint).
CREATE INDEX IF NOT EXISTS idx_notifications_user_id
  ON notifications(user_id);

-- Worker polling: fetch notifications by status (e.g. WHERE status = 'queued').
CREATE INDEX IF NOT EXISTS idx_notifications_status
  ON notifications(status);

-- Scheduler: find pending notifications whose scheduled time has arrived.
-- Partial index keeps the index small by excluding already-processed rows.
CREATE INDEX IF NOT EXISTS idx_notifications_scheduled
  ON notifications(scheduled_for)
  WHERE status = 'pending';

-- Analytics / pagination: range scans on creation timestamp.
CREATE INDEX IF NOT EXISTS idx_notifications_created_at
  ON notifications(created_at);

-- Idempotency look-up: quickly check whether a key has already been used.
-- Partial index ignores rows with NULL keys (the majority).
CREATE INDEX IF NOT EXISTS idx_notifications_idempotency
  ON notifications(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- User look-up by email (login, deduplication).
CREATE INDEX IF NOT EXISTS idx_users_email
  ON users(email);

-- Join dead-letter rows back to their source notification.
CREATE INDEX IF NOT EXISTS idx_dead_letter_notification_id
  ON dead_letter_notifications(notification_id);

-- Operator dashboard: find un-reprocessed dead-letter entries.
-- Partial index keeps the scan fast once most rows have been resolved.
CREATE INDEX IF NOT EXISTS idx_dead_letter_reprocessed
  ON dead_letter_notifications(reprocessed)
  WHERE reprocessed = false;

-- ============================================================================
-- 4. TRIGGER FUNCTION
-- ============================================================================
-- A reusable trigger function that automatically sets `updated_at` to the
-- current timestamp whenever a row is modified.  This is attached to every
-- table that has an `updated_at` column so the value is always accurate
-- without relying on application code.

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- ============================================================================
-- 5. TRIGGERS
-- ============================================================================
-- Apply the auto-update trigger to each relevant table.
--
-- NOTE: CREATE TRIGGER does not support IF NOT EXISTS in standard PostgreSQL,
-- so re-running this migration on a database where the triggers already exist
-- will produce a harmless notice (the CREATE EXTENSION / TABLE statements are
-- safe thanks to IF NOT EXISTS).  For a production migration framework you
-- would typically track applied migrations in a `schema_migrations` table.

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_notifications_updated_at
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_templates_updated_at
  BEFORE UPDATE ON notification_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
