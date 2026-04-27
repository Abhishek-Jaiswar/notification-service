/**
 * @file src/services/cache.service.ts
 * @description Application-level caching layer built on top of the shared Redis
 * connection.
 *
 * Implements the **Cache-Aside** (lazy-loading) pattern:
 *
 *   1. The caller asks for data via `cacheService.get()` or `getOrSet()`.
 *   2. On a **hit** the cached value is returned immediately.
 *   3. On a **miss** the caller (or the `factory` callback) fetches the
 *      authoritative data, stores it in Redis with a TTL, and returns it.
 *
 * Every public method is wrapped in a try/catch so that a Redis outage
 * degrades the application to "uncached" mode rather than crashing it.
 *
 * ## Cache key conventions
 *
 * All keys are namespaced with a descriptive prefix (`user:`, `notification:`,
 * etc.) and built via the helper functions in {@link CACHE_KEYS} to avoid typos
 * and ensure consistency.
 *
 * ## TTL conventions
 *
 * Default TTL values live in {@link CACHE_TTL} (in seconds).  Callers may
 * override them on a per-call basis.
 */

/* ------------------------------------------------------------------ */
/*  Imports                                                            */
/* ------------------------------------------------------------------ */

import redis from '../config/redis.ts';
import { logger } from '../utils/logger.ts';

/* ------------------------------------------------------------------ */
/*  Cache key builders                                                 */
/* ------------------------------------------------------------------ */

/**
 * Centralised cache-key factory functions.
 *
 * Using functions instead of raw template strings prevents accidental
 * key collisions and makes it trivial to search the codebase for every
 * place a given key pattern is used.
 */
export const CACHE_KEYS = {
  /** Profile / account data for a single user. */
  user: (id: string) => `user:${id}`,

  /** Notification delivery preferences for a user. */
  userPreferences: (id: string) => `user:prefs:${id}`,

  /** A single notification document. */
  notification: (id: string) => `notification:${id}`,

  /** A page of notifications belonging to a user. */
  userNotifications: (userId: string, page: number) =>
    `notifications:user:${userId}:page:${page}`,

  /** Idempotency guard – ensures a request is processed at most once. */
  idempotency: (key: string) => `idempotency:${key}`,

  /** Compiled / rendered notification template. */
  template: (name: string) => `template:${name}`,
} as const;

/* ------------------------------------------------------------------ */
/*  Default TTLs (seconds)                                             */
/* ------------------------------------------------------------------ */

/**
 * Sensible default TTL values (in **seconds**) for each cache category.
 *
 * | Constant             | Seconds | Human-readable |
 * |----------------------|--------:|----------------|
 * | USER                 |     300 | 5 min          |
 * | USER_PREFERENCES     |     300 | 5 min          |
 * | NOTIFICATION         |     120 | 2 min          |
 * | USER_NOTIFICATIONS   |      60 | 1 min          |
 * | IDEMPOTENCY          |   86400 | 24 h           |
 * | TEMPLATE             |     600 | 10 min         |
 */
export const CACHE_TTL = {
  /** TTL for individual user records. */
  USER: 300,

  /** TTL for user notification-preference objects. */
  USER_PREFERENCES: 300,

  /** TTL for a single notification document. */
  NOTIFICATION: 120,

  /** TTL for a paginated list of user notifications. */
  USER_NOTIFICATIONS: 60,

  /** TTL for idempotency keys – 24 hours. */
  IDEMPOTENCY: 86400,

  /** TTL for compiled notification templates. */
  TEMPLATE: 600,
} as const;

/* ------------------------------------------------------------------ */
/*  Cache service                                                      */
/* ------------------------------------------------------------------ */

/**
 * Stateless cache service.
 *
 * All methods are intentionally **fire-and-forget-safe**: a Redis failure is
 * logged but never re-thrown, so the caller can fall through to the primary
 * data source without additional error handling.
 */
export const cacheService = {
  /* ---------------------------------------------------------------- */
  /*  get                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Retrieve a cached value by key.
   *
   * The raw string stored in Redis is parsed with `JSON.parse` and cast to
   * the generic type `T`.
   *
   * @typeParam T - Expected shape of the cached value.
   * @param key  - The Redis key to look up.
   * @returns The parsed value on a cache **hit**, or `null` on a **miss** or
   *          any error (network, parse, etc.).
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await redis.get(key);

      /* Cache miss – key does not exist. */
      if (raw === null) {
        logger.debug('Cache miss', { key });
        return null;
      }

      logger.debug('Cache hit', { key });
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.error('Cache get error', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },

  /* ---------------------------------------------------------------- */
  /*  set                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Store a value in the cache with a mandatory TTL.
   *
   * The value is serialised with `JSON.stringify` and stored using the Redis
   * `SET key value EX ttl` command so it expires automatically.
   *
   * @param key        - Redis key.
   * @param value      - Any JSON-serialisable value.
   * @param ttlSeconds - Time-to-live in **seconds**.
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      const serialised = JSON.stringify(value);
      await redis.set(key, serialised, 'EX', ttlSeconds);
      logger.debug('Cache set', { key, ttlSeconds });
    } catch (err) {
      logger.error('Cache set error', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /* ---------------------------------------------------------------- */
  /*  del                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Remove a single key from the cache.
   *
   * This is a no-op if the key does not exist.
   *
   * @param key - Redis key to delete.
   */
  async del(key: string): Promise<void> {
    try {
      await redis.del(key);
      logger.debug('Cache del', { key });
    } catch (err) {
      logger.error('Cache del error', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /* ---------------------------------------------------------------- */
  /*  delPattern                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Delete all keys matching a glob-style pattern (e.g. `user:42:*`).
   *
   * Uses the `SCAN` command (cursor-based iteration) instead of `KEYS` to
   * avoid blocking the Redis event loop on large key-spaces.  Matching keys
   * are deleted in batches of 100 using `DEL`.
   *
   * @param pattern - Redis glob pattern (e.g. `notifications:user:123:*`).
   */
  async delPattern(pattern: string): Promise<void> {
    try {
      /** Running total of deleted keys – used for the final log line. */
      let totalDeleted = 0;

      /**
       * SCAN cursor.  Redis returns `'0'` when the full iteration is
       * complete.  We start with `'0'` as well (the initial cursor).
       */
      let cursor = '0';

      do {
        /*
         * SCAN returns a tuple:
         *   [0] – the next cursor (string)
         *   [1] – an array of matching keys (may be empty)
         *
         * COUNT 100 is a *hint* to Redis – it may return more or fewer
         * keys per iteration.
         */
        const [nextCursor, keys] = await redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );

        cursor = nextCursor;

        /* Delete the batch if any keys were returned. */
        if (keys.length > 0) {
          await redis.del(...keys);
          totalDeleted += keys.length;
        }
      } while (cursor !== '0');

      logger.debug('Cache delPattern complete', { pattern, totalDeleted });
    } catch (err) {
      logger.error('Cache delPattern error', {
        pattern,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /* ---------------------------------------------------------------- */
  /*  exists                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Check whether a key currently exists in the cache.
   *
   * @param key - Redis key to check.
   * @returns `true` if the key exists, `false` otherwise (including on error).
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await redis.exists(key);

      /*
       * `redis.exists()` returns the *number* of keys that exist (0 or 1
       * when called with a single key).
       */
      return result === 1;
    } catch (err) {
      logger.error('Cache exists error', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  /* ---------------------------------------------------------------- */
  /*  getOrSet  (Cache-Aside)                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Cache-Aside convenience method.
   *
   * 1. Attempt to read `key` from the cache.
   * 2. On a **hit** → return the cached value immediately.
   * 3. On a **miss** → invoke the `factory` callback to fetch fresh data,
   *    store the result in the cache with the given TTL, and return it.
   *
   * If the `factory` itself throws, the error propagates to the caller (it is
   * **not** swallowed) because the caller presumably cannot continue without
   * the data.
   *
   * @typeParam T      - Shape of the cached / produced value.
   * @param key        - Redis key.
   * @param ttlSeconds - TTL in seconds for newly cached values.
   * @param factory    - Async function that produces the value on a cache miss.
   * @returns The cached or freshly-produced value.
   */
  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    factory: () => Promise<T>,
  ): Promise<T> {
    /* 1. Try the cache first. */
    const cached = await this.get<T>(key);

    if (cached !== null) {
      return cached;
    }

    /* 2. Cache miss – call the factory to produce the value. */
    const freshValue = await factory();

    /* 3. Store the fresh value (fire-and-forget – set() already catches). */
    await this.set(key, freshValue, ttlSeconds);

    return freshValue;
  },
} as const;

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default cacheService;
