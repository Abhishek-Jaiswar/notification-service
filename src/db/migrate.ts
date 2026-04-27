/**
 * @file src/db/migrate.ts
 * @description Standalone migration runner for the notification service.
 *
 * This script reads the raw SQL migration file(s) from the `migrations/`
 * directory and executes them against the PostgreSQL database configured via
 * the `DATABASE_URL` environment variable.
 *
 * Usage (via pnpm):
 *   pnpm db:migrate
 *
 * Or directly with tsx:
 *   npx tsx src/db/migrate.ts
 *
 * How it works:
 *   1. Resolve the path to `001_initial_schema.sql` relative to *this* file
 *      using `import.meta.url` (the ESM equivalent of `__dirname`).
 *   2. Read the SQL into a string with `fs/promises`.
 *   3. Execute the entire string as a single statement via the shared pool.
 *   4. Log success or failure, then close the pool and exit.
 *
 * The migration SQL is intentionally idempotent (IF NOT EXISTS / OR REPLACE)
 * so this script can be run multiple times without side-effects.  For a
 * production-grade migration framework you would add a `schema_migrations`
 * tracking table — this lightweight approach is sufficient for bootstrapping.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { pool, closeDatabasePool } from '../config/database.ts';
import { logger } from '../utils/logger.ts';

/* -------------------------------------------------------------------------- */
/*  Path resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Derive the directory of the current module.
 *
 * In ESM there is no global `__dirname`; instead we convert `import.meta.url`
 * (a file:// URL) to a filesystem path and then take its directory.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Absolute path to the SQL migration file.
 *
 * Using `path.join` keeps this cross-platform (Windows back-slashes, etc.).
 */
const MIGRATION_FILE = path.join(
  __dirname,
  'migrations',
  '001_initial_schema.sql',
);

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Reads the migration SQL and executes it against the database.
 *
 * The function is `async` because both `readFile` and `pool.query` return
 * Promises.  All errors are caught so we can guarantee the pool is closed
 * and the process exits with a meaningful code.
 */
async function main(): Promise<void> {
  logger.info('Starting database migration …', { file: MIGRATION_FILE });

  try {
    /* -------------------------------------------------------------------- */
    /*  Step 1 – Read the SQL file from disk                                 */
    /* -------------------------------------------------------------------- */
    const sql = await readFile(MIGRATION_FILE, 'utf-8');

    logger.info('Migration SQL loaded', {
      bytes: sql.length,
      file: path.basename(MIGRATION_FILE),
    });

    /* -------------------------------------------------------------------- */
    /*  Step 2 – Execute the SQL against the database                        */
    /* -------------------------------------------------------------------- */
    await pool.query(sql);

    logger.info('✅ Database migration completed successfully.');
  } catch (err: unknown) {
    /* -------------------------------------------------------------------- */
    /*  Error handling – log and set a non-zero exit code                     */
    /* -------------------------------------------------------------------- */
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    logger.error('❌ Database migration failed', { message, stack });

    /*
     * Setting the exit code here (rather than calling `process.exit(1)`
     * immediately) allows the `finally` block to run and clean up the pool
     * before the process terminates.
     */
    process.exitCode = 1;
  } finally {
    /* -------------------------------------------------------------------- */
    /*  Cleanup – always close the pool so the process can exit              */
    /* -------------------------------------------------------------------- */
    await closeDatabasePool();
  }
}

/* -------------------------------------------------------------------------- */
/*  Entry-point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Invoke `main()` immediately when the script is executed.
 *
 * This pattern makes the module both:
 *   • Runnable as a standalone script (`npx tsx src/db/migrate.ts`)
 *   • Importable in tests if you ever need to run migrations programmatically
 */
main();
