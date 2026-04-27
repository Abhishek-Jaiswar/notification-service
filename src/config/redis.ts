/**
 * @file src/config/redis.ts
 * @description Redis connection setup using the `ioredis` library.
 *
 * This module creates, configures, and exports a singleton Redis client that is
 * shared across the entire application (HTTP layer, BullMQ workers, cache
 * service, etc.).
 *
 * Key design decisions
 * ────────────────────
 * • **lazyConnect: true** – the TCP socket is NOT opened at import time.
 *   Consumers must call `redis.connect()` (or `testRedisConnection()`) during
 *   the application bootstrap phase so that startup can fail fast if Redis is
 *   unreachable.
 *
 * • **maxRetriesPerRequest: null** – required by BullMQ.  Without this setting
 *   BullMQ throws a `MaxRetriesPerRequestError` after the default 20 retries.
 *
 * • **Exponential back-off** – the `retryStrategy` doubles the delay on each
 *   reconnect attempt, capped at 2 000 ms, so we don't flood a recovering
 *   Redis instance with connection attempts.
 *
 * • **enableReadyCheck: true** – after the TCP connection is established ioredis
 *   sends a background `INFO` command and only emits the `ready` event once
 *   Redis reports it can accept commands (important when connecting to a replica
 *   that is still loading data).
 */

/* ------------------------------------------------------------------ */
/*  Imports                                                            */
/* ------------------------------------------------------------------ */

import { Redis } from 'ioredis';
import { env } from './environment.ts';
import { logger } from '../utils/logger.ts';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Maximum delay (in ms) between reconnection attempts. */
const MAX_RETRY_DELAY_MS = 2_000;

/** Base delay (in ms) for the first reconnection attempt. */
const BASE_RETRY_DELAY_MS = 50;

/* ------------------------------------------------------------------ */
/*  Redis client instance                                              */
/* ------------------------------------------------------------------ */

/**
 * Singleton Redis client.
 *
 * The instance is created with `lazyConnect: true` so importing this module
 * does **not** trigger a network call.  Call {@link testRedisConnection} (or
 * `redis.connect()`) during application startup.
 */
const redis = new Redis({
  /* ── Connection ──────────────────────────────────────────────── */
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,

  /* ── BullMQ requirement ─────────────────────────────────────── */
  maxRetriesPerRequest: null,

  /* ── Resilience ─────────────────────────────────────────────── */

  /**
   * Exponential back-off retry strategy.
   *
   * @param times - The 1-based number of the current reconnection attempt.
   * @returns Delay in milliseconds before the next attempt, capped at
   *          {@link MAX_RETRY_DELAY_MS}.
   *
   * Formula: min(2^(times-1) × BASE_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS)
   *
   * Attempt 1 →   50 ms
   * Attempt 2 →  100 ms
   * Attempt 3 →  200 ms
   * Attempt 4 →  400 ms
   * Attempt 5 →  800 ms
   * Attempt 6 → 1600 ms
   * Attempt 7 → 2000 ms  (capped)
   */
  retryStrategy(times: number): number {
    const delay = Math.min(
      BASE_RETRY_DELAY_MS * Math.pow(2, times - 1),
      MAX_RETRY_DELAY_MS,
    );
    logger.warn('Redis reconnecting', { attempt: times, delayMs: delay });
    return delay;
  },

  /* ── Health checks ──────────────────────────────────────────── */
  enableReadyCheck: true,

  /* ── Lazy connection ────────────────────────────────────────── */
  lazyConnect: true,
});

/* ------------------------------------------------------------------ */
/*  Event handlers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fired when the underlying TCP socket has connected to Redis.
 * At this point the client has NOT yet confirmed Redis is ready to accept
 * commands (see the `ready` event).
 */
redis.on('connect', () => {
  logger.info('Redis connection established (TCP socket open)');
});

/**
 * Fired after the ready-check succeeds.  The client is now fully operational
 * and can execute commands.
 */
redis.on('ready', () => {
  logger.info('Redis client ready – accepting commands', {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  });
});

/**
 * Fired on any connection or command error.  ioredis handles reconnection
 * automatically via the `retryStrategy` above, so we only log here.
 */
redis.on('error', (err: Error) => {
  logger.error('Redis client error', {
    message: err.message,
    stack: err.stack,
  });
});

/**
 * Fired when the connection is fully closed (either by us or by the server).
 */
redis.on('close', () => {
  logger.warn('Redis connection closed');
});

/* ------------------------------------------------------------------ */
/*  Exported helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Gracefully disconnect from Redis.
 *
 * Should be called during application shutdown (e.g. inside a SIGTERM handler)
 * to allow in-flight commands to complete before the socket is torn down.
 *
 * Uses `redis.quit()` which sends the `QUIT` command, waits for outstanding
 * replies, and then closes the connection.  If the client is already
 * disconnected this is a no-op.
 */
export async function closeRedisConnection(): Promise<void> {
  try {
    await redis.quit();
    logger.info('Redis connection closed gracefully');
  } catch (err) {
    logger.error('Error while closing Redis connection', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Open the connection (if not already open) and verify it with a PING/PONG
 * exchange.
 *
 * Call this during application startup to fail fast when Redis is unreachable.
 *
 * @throws {Error} if the PING does not return "PONG".
 */
export async function testRedisConnection(): Promise<void> {
  try {
    /* Ensure the lazy connection is actually opened. */
    if (redis.status === 'wait') {
      await redis.connect();
    }

    const response = await redis.ping();

    if (response !== 'PONG') {
      throw new Error(`Unexpected PING response: ${response}`);
    }

    logger.info('Redis PING/PONG health-check passed');
  } catch (err) {
    logger.error('Redis health-check failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Non-throwing Redis check for HTTP health endpoints (frequent polling).
 *
 * @returns `true` if PING returns PONG, `false` on any failure.
 */
export async function isRedisHealthy(): Promise<boolean> {
  try {
    if (redis.status === 'wait') {
      await redis.connect();
    }
    const response = await redis.ping();
    return response === 'PONG';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default redis;
