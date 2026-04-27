/**
 * =============================================================================
 * VALIDATION MIDDLEWARE (Zod Schema Validation)
 * =============================================================================
 *
 * This module provides generic, reusable middleware factories that validate
 * incoming request data (body, query parameters, route parameters) against
 * Zod schemas before the request reaches your route handler.
 *
 * WHY VALIDATE AT THE MIDDLEWARE LEVEL?
 *
 * 1. SEPARATION OF CONCERNS:
 *    Route handlers focus on business logic, not input checking. Validation
 *    is a cross-cutting concern that belongs in middleware.
 *
 * 2. FAIL FAST:
 *    Invalid requests are rejected immediately with a clear 400 error,
 *    before any business logic, database queries, or side effects execute.
 *    This saves resources and prevents corrupt data from entering the system.
 *
 * 3. TYPE SAFETY:
 *    After validation, `req.body` is replaced with the Zod-parsed result,
 *    which is fully typed. This means your route handler can trust that
 *    `req.body.email` is a valid string (not undefined, not a number).
 *
 * 4. CONSISTENT ERROR FORMAT:
 *    All validation errors across every endpoint return the same structured
 *    JSON format. Clients can write generic error handling code.
 *
 * 5. DRY (Don't Repeat Yourself):
 *    Instead of writing validation logic in every route handler, you define
 *    a Zod schema once and wrap it with `validate(schema)`.
 *
 * USAGE EXAMPLE:
 *
 *   import { z } from 'zod/v4';
 *   import { validate, validateQuery } from '../middleware/validate.ts';
 *
 *   // Define a schema for the request body
 *   const createNotificationSchema = z.object({
 *     channel: z.enum(['email', 'sms', 'push']),
 *     recipient: z.string().email(),
 *     subject: z.string().min(1).max(200),
 *     body: z.string().min(1),
 *   });
 *
 *   // Use as route middleware — validation happens BEFORE the handler
 *   router.post(
 *     '/notifications',
 *     validate(createNotificationSchema),  // ← validates req.body
 *     async (req, res) => {
 *       // req.body is now fully typed and guaranteed to be valid!
 *       const { channel, recipient, subject, body } = req.body;
 *       // ... create notification ...
 *     }
 *   );
 *
 * ZOD 4 NOTE:
 *   We import from 'zod/v4' (not 'zod' which is v3). Zod 4 supports both
 *   `schema.safeParse(data)` (method style) and `z.safeParse(schema, data)`
 *   (standalone function style). We use the method style here as it's more
 *   concise and familiar to most developers.
 *
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// Zod 4 import: the schema validation library.
//
// Zod lets you define schemas that validate data at runtime AND infer
// TypeScript types at compile time. It's the bridge between runtime
// safety and compile-time type checking.
//
// We import the `z` namespace which contains all schema constructors
// (z.string(), z.object(), z.enum(), etc.) and utility types (z.ZodType,
// z.ZodError, z.infer, etc.).
// ---------------------------------------------------------------------------
import { z } from 'zod/v4';

// ---------------------------------------------------------------------------
// Type-only imports from Express. These are erased at compile time.
// Required by `verbatimModuleSyntax: true` in tsconfig.
// ---------------------------------------------------------------------------
import type { Request, Response, NextFunction } from 'express';

/* =========================================================================== */
/*  HELPER: FORMAT ZOD ERRORS                                                  */
/* =========================================================================== */

/**
 * Transforms a Zod error into a structured, client-friendly format.
 *
 * @param error - The ZodError thrown when schema validation fails.
 * @returns An array of objects, each describing one validation issue.
 *
 * Zod errors contain an `issues` array where each issue has:
 * - `path`: Array of keys leading to the invalid field (e.g., ['address', 'zip'])
 * - `message`: Human-readable description of what went wrong
 * - `code`: Machine-readable error code (e.g., 'invalid_type', 'too_small')
 *
 * We transform this into a simpler format with a dot-notation `field` string:
 *   { field: "address.zip", message: "Expected string, received number" }
 *
 * WHY DOT NOTATION?
 * The original `path` array ['address', 'zip'] requires the client to join
 * it themselves. Dot notation ('address.zip') is immediately usable for
 * displaying errors next to the correct form field in a UI.
 *
 * EXAMPLE OUTPUT:
 *   [
 *     { field: "email", message: "Invalid email address" },
 *     { field: "age", message: "Expected number, received string" }
 *   ]
 */
function formatZodErrors(error: z.ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    // -----------------------------------------------------------------------
    // `issue.path` is an array like ['notifications', 0, 'channel'].
    // `.join('.')` converts it to 'notifications.0.channel'.
    // If the path is empty (root-level error), this produces an empty string.
    // -----------------------------------------------------------------------
    field: issue.path.map(String).join('.'),

    // -----------------------------------------------------------------------
    // The human-readable error message from Zod.
    // Examples: "Required", "Expected string, received number",
    //           "String must contain at least 1 character(s)"
    // -----------------------------------------------------------------------
    message: issue.message,
  }));
}

/* =========================================================================== */
/*  BODY VALIDATION MIDDLEWARE                                                  */
/* =========================================================================== */

/**
 * Creates middleware that validates `req.body` against a Zod schema.
 *
 * This is a HIGHER-ORDER FUNCTION (a function that returns a function).
 * The outer function accepts configuration (the schema), and the inner
 * function is the actual Express middleware.
 *
 * This pattern is called a "middleware factory" and is extremely common
 * in Express applications:
 *   - `cors(options)` → returns middleware
 *   - `rateLimit(config)` → returns middleware
 *   - `validate(schema)` → returns middleware  (ours!)
 *
 * @param schema - Any Zod schema (z.object, z.array, z.string, etc.).
 *                 The generic type `T` preserves the specific schema type,
 *                 enabling TypeScript to infer the output type of parsed data.
 *
 * @returns Express middleware function that validates req.body.
 *
 * TYPE PARAMETER `T extends z.ZodType`:
 *   `z.ZodType` is the base type for ALL Zod schemas. Using a generic `T`
 *   that extends it means this function works with any Zod schema while
 *   preserving the specific type information for type inference.
 */
export function validate<T extends z.ZodType>(schema: T) {
  /**
   * The returned middleware function — this is what Express actually calls.
   *
   * @param req  - Express request object (contains the body to validate).
   * @param res  - Express response object (used to send 400 errors).
   * @param next - Callback to pass control to the next middleware/handler.
   */
  return (req: Request, res: Response, next: NextFunction): void => {
    // -----------------------------------------------------------------------
    // SAFE PARSING: `schema.safeParse()` vs `schema.parse()`
    //
    // - `schema.parse(data)` throws a ZodError if validation fails.
    //   You'd need a try/catch block around it.
    //
    // - `schema.safeParse(data)` NEVER throws. Instead, it returns a
    //   discriminated union:
    //     { success: true, data: T }    — validation passed
    //     { success: false, error: ZodError }  — validation failed
    //
    // We use `safeParse` because:
    // 1. It's more explicit — no implicit exception flow.
    // 2. It's type-safe — TypeScript narrows the type after checking `success`.
    // 3. It avoids the overhead of try/catch for expected validation failures.
    //
    // Zod 4 also supports `z.safeParse(schema, data)` as a standalone function,
    // but the method style `schema.safeParse(data)` is more concise.
    // -----------------------------------------------------------------------
    const result = schema.safeParse(req.body);

    // -----------------------------------------------------------------------
    // CHECK VALIDATION RESULT
    // -----------------------------------------------------------------------
    if (!result.success) {
      // ---------------------------------------------------------------------
      // VALIDATION FAILED: Return a 400 Bad Request response.
      //
      // We send a structured JSON response with:
      // - `success: false` — a consistent flag for clients to check.
      // - `error: 'Validation failed'` — a generic top-level message.
      // - `details` — an array of specific field-level errors.
      //
      // We call `res.status(400).json(...)` and return immediately.
      // We do NOT call `next()` — the request stops here.
      //
      // IMPORTANT: We cast to `void` because `res.json()` returns the
      // Response object (for chaining), but our function signature
      // declares a `void` return type. The explicit `void` cast signals
      // our intent: we're discarding the return value on purpose.
      // ---------------------------------------------------------------------
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: formatZodErrors(result.error),
      });
      return;
    }

    // -----------------------------------------------------------------------
    // VALIDATION PASSED: Replace req.body with the parsed data.
    //
    // WHY REPLACE req.body?
    // Zod's `.safeParse()` doesn't just validate — it also TRANSFORMS:
    // - Strips unknown/extra properties (by default for z.object).
    // - Applies `.default()` values for missing optional fields.
    // - Coerces types when using `z.coerce.*` schemas.
    //
    // By replacing `req.body` with `result.data`, downstream code works
    // with clean, validated, transformed data — not the raw, messy input.
    //
    // EXAMPLE:
    //   Input:  { email: "a@b.com", name: "Alice", hackAttempt: "<script>" }
    //   Schema: z.object({ email: z.string().email(), name: z.string() })
    //   Result: { email: "a@b.com", name: "Alice" }  // hackAttempt stripped!
    // -----------------------------------------------------------------------
    req.body = result.data;

    // -----------------------------------------------------------------------
    // Pass control to the next middleware or route handler.
    // At this point, req.body is guaranteed to be valid and typed.
    // -----------------------------------------------------------------------
    next();
  };
}

/* =========================================================================== */
/*  QUERY PARAMETER VALIDATION MIDDLEWARE                                       */
/* =========================================================================== */

/**
 * Creates middleware that validates `req.query` against a Zod schema.
 *
 * Query parameters come from the URL after the `?`:
 *   GET /notifications?status=pending&page=1&limit=20
 *   → req.query = { status: 'pending', page: '1', limit: '20' }
 *
 * IMPORTANT: All query parameter values are STRINGS (or string arrays if
 * repeated). If your schema expects numbers, use `z.coerce.number()` to
 * convert them:
 *   const querySchema = z.object({
 *     page: z.coerce.number().min(1).default(1),
 *     limit: z.coerce.number().min(1).max(100).default(20),
 *     status: z.enum(['pending', 'sent', 'failed']).optional(),
 *   });
 *
 * @param schema - Zod schema to validate query parameters against.
 * @returns Express middleware that validates req.query.
 */
export function validateQuery<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: formatZodErrors(result.error),
      });
      return;
    }

    // -----------------------------------------------------------------------
    // Replace req.query with the parsed (and potentially coerced) data.
    // This is especially important for query params because it converts
    // string values like "1" to the number 1 when using z.coerce.number().
    //
    // TypeScript note: We use `as typeof req.query` to satisfy Express's
    // type for req.query (ParsedQs). The parsed data is actually more
    // specific, but Express's middleware signature expects the original type.
    // -----------------------------------------------------------------------
    req.query = result.data as typeof req.query;

    next();
  };
}

/* =========================================================================== */
/*  ROUTE PARAMETER VALIDATION MIDDLEWARE                                       */
/* =========================================================================== */

/**
 * Creates middleware that validates `req.params` against a Zod schema.
 *
 * Route parameters come from URL path segments defined with `:paramName`:
 *   GET /notifications/:id
 *   → For URL /notifications/abc-123: req.params = { id: 'abc-123' }
 *
 * COMMON USE CASES:
 * - Validate that an ID parameter is a valid UUID format.
 * - Validate that a numeric ID is actually a number.
 * - Validate that a slug matches an expected pattern.
 *
 * EXAMPLE:
 *   const paramsSchema = z.object({
 *     id: z.string().uuid('Invalid notification ID format'),
 *   });
 *
 *   router.get(
 *     '/notifications/:id',
 *     validateParams(paramsSchema),
 *     async (req, res) => {
 *       // req.params.id is guaranteed to be a valid UUID string
 *     }
 *   );
 *
 * @param schema - Zod schema to validate route parameters against.
 * @returns Express middleware that validates req.params.
 */
export function validateParams<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid route parameters',
        details: formatZodErrors(result.error),
      });
      return;
    }

    // -----------------------------------------------------------------------
    // Replace req.params with the parsed data.
    // Same pattern as body and query — ensures downstream code works with
    // clean, validated, potentially transformed data.
    // -----------------------------------------------------------------------
    req.params = result.data as typeof req.params;

    next();
  };
}
