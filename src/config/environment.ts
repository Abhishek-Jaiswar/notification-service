/**
 * =============================================================================
 * ENVIRONMENT CONFIGURATION
 * =============================================================================
 *
 * This module is responsible for loading, validating, and exporting all
 * environment variables used throughout the notification service.
 *
 * WHY USE ZOD FOR ENVIRONMENT VARIABLES?
 * - Environment variables are always strings (from `process.env`), so we need
 *   type coercion (e.g., converting "3000" to the number 3000).
 * - Zod validates at runtime, catching misconfigurations immediately on startup
 *   rather than failing unpredictably later during execution.
 * - The parsed result is fully typed, giving us IntelliSense and compile-time
 *   safety everywhere we reference `env.PORT`, `env.DATABASE_URL`, etc.
 *
 * HOW IT WORKS:
 * 1. `import 'dotenv/config'` loads variables from a `.env` file into
 *    `process.env` as a side effect (must come before schema parsing).
 * 2. We define a Zod schema describing every expected variable, its type,
 *    whether it's required or optional, and any default values.
 * 3. We call `envSchema.parse(process.env)` which either returns a fully
 *    typed, validated object or throws a descriptive ZodError.
 * 4. We export the result as `env` for use across the entire application.
 *
 * IMPORTANT: Zod 4 is imported from 'zod/v4' (not 'zod' which points to v3).
 * =============================================================================
 */

// --------------------------------------------------------------------------
// Side-effect import: loads .env file variables into process.env.
// This MUST come before we reference process.env below.
// The 'dotenv/config' entry point auto-calls dotenv.config() on import.
// --------------------------------------------------------------------------
import 'dotenv/config';

// --------------------------------------------------------------------------
// Import Zod 4 from the v4 subpath. In Zod 4, the package publishes both
// v3 (at 'zod') and v4 (at 'zod/v4') to allow incremental migration.
// --------------------------------------------------------------------------
import { z } from 'zod/v4';

/**
 * ---------------------------------------------------------------------------
 * ENVIRONMENT VARIABLE SCHEMA
 * ---------------------------------------------------------------------------
 *
 * Each key corresponds to an environment variable name. Zod validates the
 * value and applies coercion/defaults as needed.
 *
 * Key patterns used:
 *
 * - `z.enum([...])` — Restricts to a set of allowed string values.
 *   Great for NODE_ENV where only specific values make sense.
 *
 * - `z.string().default('value')` — Expects a string; if `undefined`,
 *   uses the provided default. This is ideal for optional config with
 *   sensible fallbacks.
 *
 * - `z.coerce.number()` — First coerces the input to a number (since
 *   process.env values are always strings), then validates it's a valid
 *   number. Combined with `.default()`, we provide a fallback before
 *   coercion occurs.
 *
 * - `z.string().optional()` — The value may be undefined. No default is
 *   set, so the resulting type is `string | undefined`.
 *
 * - `z.string()` (no default, no optional) — The value is REQUIRED.
 *   If missing, `.parse()` will throw immediately, preventing the app
 *   from starting with incomplete configuration.
 * ---------------------------------------------------------------------------
 */
const envSchema = z.object({
  /**
   * NODE_ENV — Determines the application's runtime mode.
   * - 'development': verbose logging, relaxed security, hot-reload friendly.
   * - 'production': optimized, minimal logging, strict security.
   * - 'test': used during automated testing, may use in-memory stores.
   *
   * Defaults to 'development' so developers don't need a .env file to start.
   */
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  /**
   * PORT — The TCP port the Express HTTP server listens on.
   *
   * `z.coerce.number()` converts the string "3000" from process.env into
   * the number 3000. The `.default(3000)` provides a fallback if PORT is
   * not set in the environment.
   */
  PORT: z.coerce.number().default(3000),

  /**
   * DATABASE_URL — PostgreSQL connection string.
   *
   * Format: postgresql://user:password@host:port/database
   *
   * This is REQUIRED (no .default() or .optional()). If missing, the app
   * will refuse to start — we can't function without a database.
   */
  DATABASE_URL: z.string(),

  /**
   * REDIS_HOST — Hostname or IP address of the Redis server.
   *
   * Redis is used for:
   * - BullMQ job queue backend (stores job state, manages workers)
   * - Caching (notification deduplication, rate limiting state)
   *
   * Defaults to 'localhost' for local development convenience.
   */
  REDIS_HOST: z.string().default('localhost'),

  /**
   * REDIS_PORT — Port number the Redis server listens on.
   *
   * The standard Redis port is 6379. We coerce from string to number
   * since all process.env values are strings.
   */
  REDIS_PORT: z.coerce.number().default(6379),

  /**
   * REDIS_PASSWORD — Optional password for Redis authentication.
   *
   * In development, Redis often runs without a password. In production,
   * authentication should always be enabled. Using `.optional()` means
   * the type will be `string | undefined`, and we can conditionally
   * pass it to the ioredis constructor.
   */
  REDIS_PASSWORD: z.string().optional(),

  /**
   * RATE_LIMIT_WINDOW_MS — The time window (in milliseconds) for the
   * rate limiter to track requests.
   *
   * Default: 900000ms = 15 minutes.
   * Within this window, each client IP can make up to RATE_LIMIT_MAX_REQUESTS.
   * After the window resets, the counter starts over.
   */
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900_000),

  /**
   * RATE_LIMIT_MAX_REQUESTS — Maximum number of requests allowed per
   * client IP within the RATE_LIMIT_WINDOW_MS time window.
   *
   * Default: 100 requests per 15-minute window.
   * Exceeding this limit returns a 429 Too Many Requests response.
   */
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),

  /**
   * LOG_LEVEL — Controls the minimum severity of log messages that get output.
   *
   * Levels (from least to most severe): debug < info < warn < error
   * - 'debug': logs everything (very verbose, for local development)
   * - 'info': logs info, warn, and error (good for production)
   * - 'warn': logs only warnings and errors
   * - 'error': logs only errors (minimal output)
   *
   * Default: 'info' — a balanced choice for most environments.
   */
  LOG_LEVEL: z.string().default('info'),

  /**
   * CORS_ORIGIN — The Access-Control-Allow-Origin header value.
   *
   * Controls which origins can make cross-origin requests to our API.
   * - '*' allows all origins (convenient for development, risky in production)
   * - A specific origin like 'https://app.example.com' restricts access
   *
   * Default: '*' for development ease. Override in production!
   */
  CORS_ORIGIN: z.string().default('*'),
});

/**
 * ---------------------------------------------------------------------------
 * PARSE AND VALIDATE
 * ---------------------------------------------------------------------------
 *
 * `envSchema.parse(process.env)` does the following:
 *
 * 1. Iterates over every key defined in our schema.
 * 2. Looks up the corresponding value in `process.env`.
 * 3. Applies defaults for missing values (where `.default()` is specified).
 * 4. Coerces types (e.g., string "3000" → number 3000 for `.coerce.number()`).
 * 5. Validates constraints (e.g., NODE_ENV must be one of the enum values).
 *
 * If ANY validation fails, Zod throws a `ZodError` with detailed information
 * about which variables failed and why. This causes the application to crash
 * immediately on startup with a clear error message — much better than
 * discovering a missing DATABASE_URL when the first query runs minutes later.
 *
 * The result is a fully typed object. TypeScript knows:
 *   env.PORT is `number` (not `string | undefined`)
 *   env.NODE_ENV is `'development' | 'production' | 'test'`
 *   env.REDIS_PASSWORD is `string | undefined`
 *   etc.
 * ---------------------------------------------------------------------------
 */
export const env = envSchema.parse(process.env);

/**
 * ---------------------------------------------------------------------------
 * EXPORTED TYPE
 * ---------------------------------------------------------------------------
 *
 * `Env` is the TypeScript type inferred from the Zod schema. This is useful
 * if other modules need to accept the env config as a parameter or annotate
 * variables with the full environment type.
 *
 * `z.infer<typeof envSchema>` uses Zod's type inference to derive the TS type
 * automatically from the schema — no manual type duplication needed!
 *
 * We use `export type` because `verbatimModuleSyntax` is enabled in tsconfig,
 * which requires type-only exports to be explicitly marked.
 * ---------------------------------------------------------------------------
 */
export type Env = z.infer<typeof envSchema>;
