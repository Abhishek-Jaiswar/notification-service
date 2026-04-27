/**
 * =============================================================================
 * SCHEMA BARREL FILE
 * =============================================================================
 *
 * This module re-exports all Zod validation schemas and their inferred types
 * from the individual schema files. It serves as a single entry point for
 * importing any schema or type related to request validation.
 *
 * Usage:
 *   import { createUserSchema, paginationSchema } from '../schemas/index.ts';
 *   import type { CreateNotificationInput } from '../schemas/index.ts';
 *
 * WHY A BARREL FILE?
 * - Simplifies imports: consumers don't need to know which sub-file a schema
 *   lives in. One import path covers everything.
 * - Encapsulates internal structure: if we reorganize schemas into different
 *   files later, consumers' import paths don't change.
 * - Provides a clear inventory: reading this file shows every public schema
 *   and type the module exposes.
 *
 * IMPORTANT — `export type` vs `export`:
 * This project uses `verbatimModuleSyntax: true` in tsconfig.json. This means
 * TypeScript does NOT erase type-only re-exports automatically — we must
 * explicitly use `export type` for anything that only exists at the type level.
 *
 * - `export { createUserSchema }` — Runtime value (Zod schema object). ✅
 * - `export type { CreateUserInput }` — Type-only (inferred TS type). ✅
 * - `export { CreateUserInput }` — ❌ Would fail with verbatimModuleSyntax!
 *
 * RELATIVE IMPORTS:
 * All relative imports use `.ts` extensions as required by the project's
 * tsconfig settings (`allowImportingTsExtensions` and
 * `rewriteRelativeImportExtensions`). At build time, TypeScript rewrites
 * `.ts` → `.js` in the emitted output.
 * =============================================================================
 */

/* =========================================================================== */
/*  USER SCHEMAS & TYPES                                                       */
/* =========================================================================== */

/**
 * Runtime schema exports — these are actual Zod schema objects used at runtime
 * for parsing and validating request data.
 */
export {
  createUserSchema,
  updateUserPreferencesSchema,
} from './user.schema.ts';

/**
 * Type-only exports — these are TypeScript types inferred from the Zod schemas.
 * They exist only at compile time and are erased from the JavaScript output.
 * Must use `export type` due to `verbatimModuleSyntax: true`.
 */
export type {
  CreateUserInput,
  UpdateUserPreferencesInput,
} from './user.schema.ts';

/* =========================================================================== */
/*  NOTIFICATION SCHEMAS & TYPES                                               */
/* =========================================================================== */

/**
 * Runtime schema exports — Zod schema objects for notification validation.
 */
export {
  createNotificationSchema,
  bulkNotificationSchema,
  paginationSchema,
} from './notification.schema.ts';

/**
 * Type-only exports — TypeScript types inferred from the notification schemas.
 * Must use `export type` due to `verbatimModuleSyntax: true`.
 */
export type {
  CreateNotificationInput,
  BulkNotificationInput,
  PaginationInput,
} from './notification.schema.ts';
