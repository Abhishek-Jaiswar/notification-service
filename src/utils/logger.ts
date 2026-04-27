/**
 * =============================================================================
 * STRUCTURED JSON LOGGER
 * =============================================================================
 *
 * A lightweight, zero-dependency structured logger that outputs JSON to stdout
 * and stderr. Every log entry is a single JSON line, making it easy to parse
 * with log aggregation tools (ELK Stack, Datadog, CloudWatch, Loki, etc.).
 *
 * WHY NOT USE WINSTON/PINO/BUNYAN?
 * For a learning project, building our own logger helps us understand:
 * - How structured logging works under the hood.
 * - How log levels filter output.
 * - How JSON log lines are consumed by infrastructure tooling.
 *
 * In a production project, you'd likely use Pino (fastest) or Winston
 * (most feature-rich). But this simple logger covers 90% of use cases.
 *
 * LOG LEVELS (from least to most severe):
 *   debug (0) < info (1) < warn (2) < error (3)
 *
 * The LOG_LEVEL environment variable controls the minimum severity that gets
 * output. For example, LOG_LEVEL=warn means only warn and error messages
 * are printed; debug and info are silently discarded.
 *
 * OUTPUT FORMAT (one JSON object per line):
 *   {"timestamp":"2024-01-15T10:30:00.000Z","level":"info","message":"Server started","port":3000}
 *
 * This format is called "NDJSON" (Newline Delimited JSON) and is the standard
 * for structured logging in containerized environments.
 * =============================================================================
 */

import { env } from '../config/index.js';

/* -------------------------------------------------------------------------- */
/*  LOG LEVEL CONFIGURATION                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Numeric mapping of log level names to their severity values.
 *
 * This allows us to compare levels numerically:
 *   if (LOG_LEVELS['debug'] >= LOG_LEVELS[currentLevel]) { ... }
 *
 * Using `as const` makes TypeScript infer literal types for the values,
 * which provides better type safety and enables the `LogLevel` type below.
 *
 * The `Record<string, number>` type signature allows indexing with any string
 * (needed because `env.LOG_LEVEL` is typed as `string`, not a union literal).
 */
const LOG_LEVELS: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

/**
 * The current minimum log level, read from environment configuration.
 *
 * Any log call with a severity below this number will be silently discarded.
 * For example, if LOG_LEVEL=info (1), then debug (0) messages are skipped,
 * but info (1), warn (2), and error (3) are output.
 *
 * The `?? 1` fallback ensures we default to 'info' level if the configured
 * LOG_LEVEL string doesn't match any key in LOG_LEVELS (defensive coding).
 */
const currentLevel: number = LOG_LEVELS[env.LOG_LEVEL] ?? 1;

/* -------------------------------------------------------------------------- */
/*  LOG ENTRY FORMATTING                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Formats and outputs a structured JSON log entry.
 *
 * @param level   - The severity level string ('debug', 'info', 'warn', 'error').
 * @param message - The human-readable log message.
 * @param meta    - Optional key-value pairs for structured context data.
 *                  Examples: { userId: '123', duration: 45, endpoint: '/api/notifications' }
 *
 * HOW IT WORKS:
 * 1. Checks if the log level is high enough to be output (level filtering).
 * 2. Constructs a JSON object with timestamp, level, message, and any metadata.
 * 3. Serializes to a single JSON string using JSON.stringify().
 * 4. Outputs to the appropriate stream:
 *    - error level → console.error (writes to stderr)
 *    - warn level  → console.warn  (writes to stderr in most environments)
 *    - all others  → console.log   (writes to stdout)
 *
 * WHY SEPARATE STDOUT AND STDERR?
 * In containerized environments (Docker, Kubernetes), stdout and stderr can be
 * routed to different destinations. Errors going to stderr allows monitoring
 * tools to detect and alert on error conditions without parsing log content.
 */
function log(
  level: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  // -------------------------------------------------------------------------
  // LEVEL FILTERING
  // -------------------------------------------------------------------------
  // Compare the requested level's numeric value against the configured minimum.
  // If the requested level is below the threshold, skip output entirely.
  // This is the core mechanism that makes LOG_LEVEL=warn suppress debug/info.
  //
  // The `?? 0` fallback treats unknown levels as debug (lowest priority).
  // -------------------------------------------------------------------------
  const levelValue = LOG_LEVELS[level] ?? 0;
  if (levelValue < currentLevel) {
    return;
  }

  // -------------------------------------------------------------------------
  // CONSTRUCT THE LOG ENTRY
  // -------------------------------------------------------------------------
  // We build a plain object and then spread `meta` into it. The spread
  // operator (`...meta`) merges all key-value pairs from `meta` into the
  // top-level log entry, producing flat JSON rather than nested:
  //
  //   GOOD (flat):   {"timestamp":"...","level":"info","message":"Request","userId":"123"}
  //   AVOID (nested): {"timestamp":"...","level":"info","message":"Request","meta":{"userId":"123"}}
  //
  // Flat JSON is easier to query in log aggregation tools (e.g., searching
  // for `userId:123` in Kibana or Datadog).
  //
  // `new Date().toISOString()` produces an ISO 8601 timestamp in UTC:
  //   "2024-01-15T10:30:00.000Z"
  // This is the standard timestamp format for structured logging.
  // -------------------------------------------------------------------------
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  // -------------------------------------------------------------------------
  // SERIALIZE AND OUTPUT
  // -------------------------------------------------------------------------
  // `JSON.stringify()` converts the object to a single JSON string.
  // Each log entry occupies exactly one line (no pretty-printing), which is
  // essential for NDJSON format and line-based log parsing.
  //
  // We route to different console methods based on severity:
  // - console.error → stderr (for errors that need immediate attention)
  // - console.warn  → stderr (for warnings that might indicate problems)
  // - console.log   → stdout (for normal informational output)
  // -------------------------------------------------------------------------
  const output = JSON.stringify(entry);

  switch (level) {
    case 'error':
      console.error(output);
      break;
    case 'warn':
      console.warn(output);
      break;
    default:
      console.log(output);
      break;
  }
}

/* -------------------------------------------------------------------------- */
/*  EXPORTED LOGGER OBJECT                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The main logger object used throughout the application.
 *
 * Usage examples:
 *
 *   import { logger } from '../utils/index.js';
 *
 *   // Simple message
 *   logger.info('Server started');
 *
 *   // Message with structured context
 *   logger.info('Request completed', { method: 'GET', path: '/api/notifications', duration: 45 });
 *
 *   // Error logging (include error details in meta)
 *   logger.error('Database query failed', { error: err.message, query: 'SELECT ...' });
 *
 *   // Debug logging (only visible when LOG_LEVEL=debug)
 *   logger.debug('Cache hit', { key: 'user:123', ttl: 300 });
 *
 * Each method is a thin wrapper around the `log()` function, pre-filling
 * the level parameter. This provides a clean, conventional API:
 *   logger.info(...)  instead of  log('info', ...)
 */
export const logger = {
  /**
   * Log a debug message — the most verbose level.
   * Use for detailed internal state that's useful during development
   * but too noisy for production (e.g., cache lookups, SQL queries).
   */
  debug: (message: string, meta?: Record<string, unknown>): void => {
    log('debug', message, meta);
  },

  /**
   * Log an informational message — the default level for production.
   * Use for significant events in the application lifecycle
   * (e.g., server started, job completed, user created).
   */
  info: (message: string, meta?: Record<string, unknown>): void => {
    log('info', message, meta);
  },

  /**
   * Log a warning — something unexpected happened but the app can continue.
   * Use for degraded performance, deprecated feature usage, retry attempts
   * (e.g., "Redis connection lost, retrying...", "Rate limit approaching").
   */
  warn: (message: string, meta?: Record<string, unknown>): void => {
    log('warn', message, meta);
  },

  /**
   * Log an error — something went wrong that needs attention.
   * Use for unhandled exceptions, failed external service calls,
   * database errors (e.g., "Failed to send email", "DB pool exhausted").
   *
   * Note: Outputs to stderr so monitoring tools can detect errors
   * without parsing the log content.
   */
  error: (message: string, meta?: Record<string, unknown>): void => {
    log('error', message, meta);
  },
};
