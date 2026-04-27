/**
 * =============================================================================
 * UTILS BARREL FILE
 * =============================================================================
 *
 * Re-exports all utility modules so consumers can import from a single path:
 *
 *   import { logger, AppError, NotFoundError, setupGracefulShutdown } from '../utils/index.js';
 *
 * Instead of importing from individual files:
 *
 *   import { logger } from '../utils/logger.js';
 *   import { AppError } from '../utils/errors.js';
 *   import { setupGracefulShutdown } from '../utils/graceful-shutdown.js';
 *
 * BARREL FILE BEST PRACTICES:
 * - Only re-export the public API of each module.
 * - Use `export *` to forward all named exports from a module.
 * - Don't add new logic here — this file is purely for re-exporting.
 * - Keep the file alphabetically ordered for easy scanning.
 *
 * NOTE: All items exported from these modules are runtime values (classes,
 * functions, objects), not types, so we use regular `export` (not `export type`).
 * If any module exported types, we'd need a separate `export type` line
 * due to `verbatimModuleSyntax: true` in tsconfig.
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// ERRORS MODULE
// ---------------------------------------------------------------------------
// Re-exports all custom error classes:
// - AppError (base class)
// - NotFoundError (404)
// - ValidationError (400)
// - ConflictError (409)
// - RateLimitError (429)
// - DatabaseError (500)
//
// `export *` forwards every named export from the module. If errors.ts
// adds a new error class later, it's automatically available here too —
// no need to update this barrel file.
// ---------------------------------------------------------------------------
export * from './errors.js';

// ---------------------------------------------------------------------------
// GRACEFUL SHUTDOWN MODULE
// ---------------------------------------------------------------------------
// Re-exports: setupGracefulShutdown(server, cleanup)
//
// This function is typically called once in the application entry point
// (src/index.ts) after the server starts listening.
// ---------------------------------------------------------------------------
export * from './graceful-shutdown.js';

// ---------------------------------------------------------------------------
// LOGGER MODULE
// ---------------------------------------------------------------------------
// Re-exports: logger (the structured JSON logger object)
//
// The logger is used throughout the entire application for structured
// logging with level filtering (debug, info, warn, error).
// ---------------------------------------------------------------------------
export * from './logger.js';
