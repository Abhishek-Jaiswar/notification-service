/**
 * =============================================================================
 * GRACEFUL SHUTDOWN HANDLER
 * =============================================================================
 *
 * This module provides a function to set up graceful shutdown behavior for
 * the notification service. When the process receives a termination signal,
 * it cleanly shuts down instead of abruptly killing all in-flight operations.
 *
 * WHY GRACEFUL SHUTDOWN?
 *
 * Without graceful shutdown, when you deploy a new version or scale down:
 * - In-flight HTTP requests get terminated mid-response → clients see errors.
 * - Database transactions get interrupted → data corruption or orphaned locks.
 * - BullMQ workers stop mid-job → jobs are left in "processing" state.
 * - Redis connections drop → potential data loss in pub/sub channels.
 *
 * With graceful shutdown:
 * 1. Stop accepting NEW connections (server.close()).
 * 2. Wait for in-flight requests to complete naturally.
 * 3. Close database connection pools (return connections to the server).
 * 4. Disconnect Redis clients cleanly.
 * 5. Shut down BullMQ workers (let active jobs finish).
 * 6. Exit the process with code 0 (success).
 *
 * SIGNALS EXPLAINED:
 *
 * - SIGTERM: "Please terminate." Sent by container orchestrators (Kubernetes,
 *   Docker, ECS) when they want to stop the container. This is the polite
 *   way to ask a process to shut down. Kubernetes sends SIGTERM, waits
 *   `terminationGracePeriodSeconds` (default 30s), then sends SIGKILL.
 *
 * - SIGINT: "Interrupt." Sent when you press Ctrl+C in the terminal.
 *   Useful during local development.
 *
 * TIMEOUT SAFETY NET:
 * We set a 30-second timeout for the cleanup process. If cleanup takes longer
 * than this (e.g., a database connection hangs), we force-exit with code 1
 * to avoid zombie processes. This timeout should be shorter than Kubernetes'
 * `terminationGracePeriodSeconds` to ensure we exit before SIGKILL.
 *
 * =============================================================================
 */

import type http from 'node:http';
import { logger } from './logger.js';

/* -------------------------------------------------------------------------- */
/*  CONSTANTS                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Maximum time (in milliseconds) to wait for graceful shutdown to complete.
 *
 * If cleanup takes longer than this, we force-exit the process with code 1.
 * 30 seconds is a common choice that works well with Kubernetes' default
 * `terminationGracePeriodSeconds` of 30 seconds (our cleanup should finish
 * before the orchestrator sends SIGKILL).
 *
 * WHY 30 SECONDS?
 * - Most HTTP requests complete within a few seconds.
 * - Database pool draining usually takes < 5 seconds.
 * - BullMQ worker shutdown takes < 10 seconds for most jobs.
 * - 30 seconds gives ample time while preventing zombie processes.
 */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/*  MAIN FUNCTION                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Sets up signal handlers for graceful shutdown of the HTTP server
 * and all associated resources.
 *
 * @param server  - The Node.js HTTP server instance (returned by `app.listen()`).
 *                  We call `server.close()` to stop accepting new connections.
 *
 * @param cleanup - An async function that closes all resources:
 *                  - PostgreSQL connection pool (`pool.end()`)
 *                  - Redis client (`redis.quit()`)
 *                  - BullMQ workers (`worker.close()`)
 *                  - Any other connections or resources
 *
 *                  This function is provided by the caller because the shutdown
 *                  handler doesn't know about specific resources — it just
 *                  knows how to orchestrate the shutdown sequence.
 *
 * USAGE EXAMPLE:
 *   ```ts
 *   import http from 'node:http';
 *   import { setupGracefulShutdown } from './utils/index.js';
 *
 *   const server = app.listen(3000);
 *
 *   setupGracefulShutdown(server, async () => {
 *     await pool.end();      // Close PostgreSQL connections
 *     await redis.quit();    // Close Redis connection
 *     await worker.close();  // Stop BullMQ worker
 *   });
 *   ```
 */
export function setupGracefulShutdown(
  server: http.Server,
  cleanup: () => Promise<void>,
): void {
  /**
   * Internal flag to prevent handling multiple signals simultaneously.
   *
   * Without this guard, if both SIGTERM and SIGINT arrive at roughly the
   * same time (which can happen during `docker stop`), we'd run the
   * shutdown sequence twice, potentially causing errors when trying to
   * close already-closed connections.
   *
   * Using `let` because we need to mutate this flag when shutdown begins.
   */
  let isShuttingDown = false;

  /**
   * The actual shutdown handler function. Called when SIGTERM or SIGINT
   * is received.
   *
   * @param signal - The name of the signal that triggered the shutdown
   *                 ('SIGTERM' or 'SIGINT'). Logged for debugging.
   */
  const shutdown = async (signal: string): Promise<void> => {
    // ---------------------------------------------------------------------
    // GUARD: Prevent duplicate shutdown sequences.
    // If we're already shutting down (from a previous signal), ignore
    // subsequent signals. This is important because:
    // - A user might press Ctrl+C multiple times impatiently.
    // - Docker sends SIGTERM then may send it again before SIGKILL.
    // ---------------------------------------------------------------------
    if (isShuttingDown) {
      logger.warn('Shutdown already in progress, ignoring duplicate signal', { signal });
      return;
    }

    isShuttingDown = true;
    logger.info('Received shutdown signal', { signal });

    // ---------------------------------------------------------------------
    // SAFETY NET: Set a timeout that force-kills the process if cleanup
    // takes too long. This prevents the process from hanging indefinitely
    // if a cleanup step gets stuck (e.g., waiting for a database that's
    // already down).
    //
    // `setTimeout` returns a `Timeout` object. We call `.unref()` on it
    // so that this timer alone doesn't keep the Node.js event loop alive.
    // Without `.unref()`, the process wouldn't exit even after cleanup
    // completes because the timer is still pending.
    //
    // `process.exit(1)` uses exit code 1 (error) because a forced exit
    // means cleanup didn't complete successfully.
    // ---------------------------------------------------------------------
    const forceExitTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit', {
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    // `.unref()` allows the process to exit naturally even if this timer
    // is still pending. This is a Node.js-specific API.
    forceExitTimer.unref();

    try {
      // -------------------------------------------------------------------
      // STEP 1: Stop accepting new connections.
      //
      // `server.close()` tells the HTTP server to stop accepting new
      // incoming connections. Existing connections that are already being
      // processed will continue until they complete naturally.
      //
      // We wrap it in a Promise because `server.close()` uses the older
      // Node.js callback pattern rather than Promises.
      //
      // The callback fires when all existing connections have been closed
      // (i.e., all in-flight requests have been served).
      // -------------------------------------------------------------------
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            // This error typically means the server wasn't running or
            // was already closed. We log it but don't abort shutdown.
            logger.error('Error closing HTTP server', {
              error: err.message,
            });
            reject(err);
          } else {
            logger.info('HTTP server closed — no longer accepting connections');
            resolve();
          }
        });
      });

      // -------------------------------------------------------------------
      // STEP 2: Clean up application resources.
      //
      // Call the cleanup function provided by the caller. This is where
      // database pools, Redis connections, BullMQ workers, etc. are closed.
      //
      // The cleanup function is async, so we await it to ensure all
      // resources are properly released before exiting.
      // -------------------------------------------------------------------
      await cleanup();
      logger.info('All resources cleaned up successfully');

      // -------------------------------------------------------------------
      // STEP 3: Exit successfully.
      //
      // `process.exit(0)` terminates the process with exit code 0 (success).
      // This tells the container orchestrator that the shutdown was clean.
      //
      // Kubernetes/Docker use exit codes to determine if a container
      // terminated normally (0) or crashed (non-zero).
      // -------------------------------------------------------------------
      process.exit(0);
    } catch (error) {
      // -------------------------------------------------------------------
      // ERROR HANDLING: If any cleanup step fails, log the error and
      // exit with code 1 (error). We don't re-throw because there's
      // no caller to catch it — we're in a signal handler.
      //
      // The `instanceof Error` check is a TypeScript best practice for
      // narrowing the `unknown` type in catch blocks. Not all thrown
      // values are Error instances (someone could `throw "string"`).
      // -------------------------------------------------------------------
      logger.error('Error during graceful shutdown', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      process.exit(1);
    }
  };

  // -----------------------------------------------------------------------
  // REGISTER SIGNAL HANDLERS
  // -----------------------------------------------------------------------
  //
  // `process.on('SIGTERM', ...)` registers an event listener for the SIGTERM
  // signal. Node.js's `process` object is an EventEmitter that emits signal
  // events when the operating system sends signals to the process.
  //
  // We use arrow functions to pass the signal name to the `shutdown` handler,
  // making it clear in logs which signal triggered the shutdown.
  //
  // SIGTERM: Sent by orchestrators (Kubernetes, Docker, systemd, etc.)
  // SIGINT:  Sent by terminal (Ctrl+C) during local development
  // -----------------------------------------------------------------------
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
