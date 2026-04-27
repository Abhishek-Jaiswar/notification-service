/**
 * =============================================================================
 * CONFIG BARREL FILE
 * =============================================================================
 *
 * A "barrel file" (index.ts) re-exports from sibling modules so that consumers
 * can import from the directory path rather than specifying individual files:
 *
 *   import { env } from './config/index.js';   // with explicit index
 *   import { env } from './config/index.js';   // same thing
 *
 * WHY USE BARREL FILES?
 * - Cleaner import paths throughout the codebase.
 * - Single place to control what's publicly exposed from a module group.
 * - If we add more config files later (e.g., database.ts, redis.ts), we
 *   just add another export line here — consumers don't need to change.
 *
 * NOTE ON `export type`:
 * With `verbatimModuleSyntax: true` in tsconfig, TypeScript requires that
 * type-only re-exports use `export type`. The `Env` type is a type-only
 * export, while `env` is a runtime value export.
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// Re-export the validated environment configuration object (`env`) and
// its inferred TypeScript type (`Env`) from the environment module.
//
// `export { env }` — re-exports the runtime value (the parsed env object).
// `export type { Env }` — re-exports only the TypeScript type (erased at
//   runtime). We must use `export type` here because of verbatimModuleSyntax.
// ---------------------------------------------------------------------------
export { env } from './environment.ts';
export type { Env } from './environment.ts';
