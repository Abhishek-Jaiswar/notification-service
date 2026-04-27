/**
 * @file src/config/database.ts
 * @description PostgreSQL connection pool configuration for the notification service.
 *
 * This module initialises a single `pg.Pool` instance that is shared across the
 * entire application.  Every module that needs to talk to Postgres should import
 * `pool` from here rather than creating its own connection — this ensures we
 * stay within the configured connection limit and can cleanly shut down all
 * connections during graceful termination.
 *
 * Key design decisions:
 *   • The pool is configured with a maximum of 20 connections, which is a good
 *     default for a mid-sized Node.js service (remember: Node is single-threaded,
 *     so you rarely need more than ~2× your CPU count).
 *   • Idle connections are reaped after 30 seconds to avoid hogging server-side
 *     slots in the PostgreSQL backend.
 *   • A 5-second connection timeout ensures the service fails fast if the
 *     database is unreachable, instead of hanging indefinitely.
 *   • An `error` listener is attached so unexpected backend disconnects are
 *     logged centrally rather than throwing unhandled exceptions.
 *
 * Exports:
 *   - `pool`                   – The shared `pg.Pool` instance.
 *   - `closeDatabasePool()`    – Gracefully drains and closes every connection.
 *   - `testDatabaseConnection()` – Quick health-check that runs `SELECT NOW()`.
 */

import { Pool } from 'pg';
import { env } from './environment.ts';
import { logger } from '../utils/logger.ts';

/* -------------------------------------------------------------------------- */
/*  Pool instantiation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Shared PostgreSQL connection pool.
 *
 * Uses the `DATABASE_URL` connection string from the environment configuration
 * which typically follows the format:
 *   postgresql://user:password@host:port/database?sslmode=require
 *
 * All query / transaction helpers throughout the app should use this single
 * pool so that connection limits and idle timeouts are managed in one place.
 */
export const pool = new Pool({
  /**
   * Full connection string.  `pg` will parse the host, port, user, password,
   * database name, and any query-string options (e.g. `sslmode`) from this URL.
   */
  connectionString: env.DATABASE_URL,

  /**
   * Maximum number of clients the pool will hold.
   * 20 is a sensible default — high enough to handle bursty traffic but low
   * enough to avoid saturating a typical PostgreSQL `max_connections` setting
   * (usually 100–200) when multiple service replicas are running.
   */
  max: 20,

  /**
   * How long (in milliseconds) a client can sit idle in the pool before being
   * closed and removed.  30 seconds keeps the pool responsive while freeing
   * resources during quiet periods.
   */
  idleTimeoutMillis: 30_000,

  /**
   * Maximum time (in milliseconds) to wait for a new connection to be
   * established.  If the database is unreachable for longer than 5 seconds the
   * query will reject immediately — this prevents cascading timeouts upstream.
   */
  connectionTimeoutMillis: 5_000,
});

/* -------------------------------------------------------------------------- */
/*  Background error handler                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Handles unexpected errors on idle clients.
 *
 * When a client sitting in the pool receives an error from the PostgreSQL
 * backend (e.g. the server was restarted), `pg` emits an `'error'` event on
 * the pool.  Without this listener the process would crash with an unhandled
 * error.  Instead, we log the event so operators can investigate.
 */
pool.on('error', (err: Error) => {
  logger.error('Unexpected error on idle PostgreSQL client', {
    message: err.message,
    stack: err.stack,
  });
});

/* -------------------------------------------------------------------------- */
/*  Lifecycle helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Gracefully closes every connection in the pool.
 *
 * Call this during application shutdown (e.g. in a SIGTERM handler) to make
 * sure in-flight queries finish and all TCP sockets are properly released.
 *
 * After calling `closeDatabasePool` the pool can **not** be reused — any
 * subsequent `pool.query()` call will reject.
 *
 * @example
 * ```ts
 * process.on('SIGTERM', async () => {
 *   await closeDatabasePool();
 *   process.exit(0);
 * });
 * ```
 */
export async function closeDatabasePool(): Promise<void> {
  logger.info('Closing PostgreSQL connection pool …');

  try {
    await pool.end();
    logger.info('PostgreSQL connection pool closed successfully.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Error while closing PostgreSQL connection pool', { message });
  }
}

/* -------------------------------------------------------------------------- */
/*  Health-check helper                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Verifies that the database is reachable by executing a trivial query.
 *
 * Returns `true` when the query succeeds and `false` otherwise.  This is
 * intentionally lenient (no throw) so it can be used in HTTP health-check
 * endpoints without extra try / catch boiler-plate.
 *
 * @param options.silent - When `true`, skips success logging (use for frequent
 *                         `/health` polls). Errors are always logged.
 *
 * @returns `true` if the database responded to `SELECT NOW()`, `false` on any
 *          error.
 *
 * @example
 * ```ts
 * app.get('/health', async (_req, res) => {
 *   const dbOk = await testDatabaseConnection({ silent: true });
 *   res.status(dbOk ? 200 : 503).json({ database: dbOk });
 * });
 * ```
 */
export async function testDatabaseConnection(options?: {
  silent?: boolean;
}): Promise<boolean> {
  const silent = options?.silent ?? false;

  try {
    const result = await pool.query('SELECT NOW()');

    if (!silent) {
      logger.info('Database connection test passed', {
        serverTime: result.rows[0]?.now,
      });
    }

    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    logger.error('Database connection test failed', { message });

    return false;
  }
}
