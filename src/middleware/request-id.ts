/**
 * =============================================================================
 * REQUEST ID MIDDLEWARE
 * =============================================================================
 *
 * This middleware ensures every incoming HTTP request has a unique identifier
 * (Request ID) attached to it. Request IDs are essential for:
 *
 * 1. DISTRIBUTED TRACING:
 *    In a microservices architecture, a single user action might trigger
 *    requests across multiple services (API → Queue → Worker → Email Provider).
 *    A shared Request ID lets you trace the entire chain in your logs.
 *
 * 2. LOG CORRELATION:
 *    When multiple requests are being processed concurrently, log lines from
 *    different requests get interleaved. The Request ID lets you filter logs
 *    for a specific request:
 *      grep "req-id:abc-123" application.log
 *
 * 3. SUPPORT & DEBUGGING:
 *    When a user reports an issue, they can provide the Request ID from the
 *    response header. Support engineers can then find all log entries for
 *    that specific request instantly.
 *
 * 4. IDEMPOTENCY:
 *    Some clients send a Request ID to ensure idempotent processing. If
 *    the same Request ID arrives twice, the server can detect the duplicate.
 *
 * HOW IT WORKS:
 * 1. Check if the incoming request already has an `X-Request-ID` header
 *    (set by an API gateway, load balancer, or the client itself).
 * 2. If not, generate a new UUID v4 (universally unique identifier).
 * 3. Attach the ID to both the request (for use in downstream middleware/handlers)
 *    and the response (so the client receives it back).
 *
 * HEADER CONVENTION:
 * `X-Request-ID` is the de facto standard header name. Some systems use
 * `X-Correlation-ID` or `X-Trace-ID` — they serve the same purpose.
 * The `X-` prefix historically meant "non-standard" (though this convention
 * is deprecated per RFC 6648, the header name persists by convention).
 *
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// UUID v4 generates random 128-bit identifiers like:
//   "550e8400-e29b-41d4-a716-446655440000"
//
// UUID v4 uses random bytes, so collisions are astronomically unlikely
// (you'd need to generate ~2.7 quintillion UUIDs to have a 50% chance of
// one collision). This makes them safe for distributed systems where
// multiple servers generate IDs independently without coordination.
// ---------------------------------------------------------------------------
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Type-only imports: these are erased at compile time (no runtime cost).
// `verbatimModuleSyntax: true` in tsconfig REQUIRES us to use `import type`
// when importing types that aren't used as values. This makes the intent
// explicit and ensures correct behavior with bundlers and TypeScript's
// module emit.
// ---------------------------------------------------------------------------
import type { Request, Response, NextFunction } from 'express';

/* =========================================================================== */
/*  EXPRESS TYPE AUGMENTATION (Module Augmentation / Declaration Merging)       */
/* =========================================================================== */

/**
 * TypeScript's "declaration merging" lets us add properties to existing
 * interfaces from third-party libraries without modifying their source code.
 *
 * Here, we're telling TypeScript: "The Express `Request` interface should
 * also have an optional `id` property of type string."
 *
 * HOW IT WORKS:
 * - `declare module 'express'` opens the existing 'express' module for merging.
 * - Inside, we re-declare the `Request` interface with our new property.
 * - TypeScript merges this declaration with the original Express `Request`
 *   interface, so `req.id` becomes a valid, typed property everywhere.
 *
 * WITHOUT THIS:
 *   req.id = requestId;  // TS Error: Property 'id' does not exist on type 'Request'
 *
 * WITH THIS:
 *   req.id = requestId;  // ✅ TypeScript knows about `req.id`
 *
 * WHY `id` AND NOT JUST HEADERS?
 * While we also store the ID in `req.headers['x-request-id']`, having `req.id`
 * provides a cleaner, typed API for downstream code:
 *   logger.info('Processing', { requestId: req.id });  // clean!
 *   logger.info('Processing', { requestId: req.headers['x-request-id'] });  // verbose
 */
declare module 'express' {
  interface Request {
    /**
     * Unique identifier for this request, either forwarded from the
     * `X-Request-ID` header or generated as a UUID v4.
     */
    id?: string | undefined;
  }
}

/* =========================================================================== */
/*  REQUEST ID HEADER CONSTANT                                                 */
/* =========================================================================== */

/**
 * The HTTP header name used for request IDs.
 *
 * Defined as a constant to avoid typos and ensure consistency between
 * reading and writing the header. A typo like 'X-Requst-ID' (missing 'e')
 * would silently fail — the constant prevents that class of bug.
 */
const REQUEST_ID_HEADER = 'X-Request-ID';

/* =========================================================================== */
/*  MIDDLEWARE FUNCTION                                                         */
/* =========================================================================== */

/**
 * Express middleware that attaches a unique Request ID to every request.
 *
 * @param req  - The incoming Express request object.
 * @param res  - The outgoing Express response object.
 * @param next - Callback to pass control to the next middleware in the stack.
 *
 * MIDDLEWARE FLOW:
 *   Client Request
 *       ↓
 *   [requestId middleware]  ← We are here
 *       ↓
 *   [other middleware: logging, auth, rate-limit, etc.]
 *       ↓
 *   [route handler]
 *       ↓
 *   Response (with X-Request-ID header)
 *
 * This middleware should be registered FIRST (or very early) in the middleware
 * stack so that all subsequent middleware and route handlers have access to
 * the Request ID for logging and tracing.
 *
 * Usage in app setup:
 *   import { requestId } from './middleware/index.ts';
 *   app.use(requestId);
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  // ---------------------------------------------------------------------------
  // STEP 1: Check for an existing Request ID from the client or upstream proxy.
  //
  // `req.headers` values can be `string | string[] | undefined`:
  // - `string` for single-value headers (the normal case).
  // - `string[]` if the same header appears multiple times.
  // - `undefined` if the header is not present.
  //
  // We use a type guard to handle all cases safely. If the header is an
  // array (rare, but possible), we take the first element.
  // ---------------------------------------------------------------------------
  const existingId = req.headers['x-request-id'];
  const id: string =
    typeof existingId === 'string' && existingId.length > 0
      ? existingId
      : Array.isArray(existingId) && existingId[0]
        ? existingId[0]
        : uuidv4();

  // ---------------------------------------------------------------------------
  // STEP 2: Attach the Request ID in three places:
  //
  // a) `req.id` — Our custom typed property (via module augmentation above).
  //    Provides a clean API for downstream code: `req.id`
  //
  // b) `req.headers['x-request-id']` — Overwrites the header on the request
  //    object so that any middleware reading headers directly will find it.
  //    This normalizes the case where no header was sent (now it's always there).
  //
  // c) `res.setHeader(...)` — Adds the header to the outgoing response so
  //    the client receives the Request ID back. This is critical for debugging:
  //    if a client reports an error, they can include this ID.
  // ---------------------------------------------------------------------------
  req.id = id;
  req.headers['x-request-id'] = id;
  res.setHeader(REQUEST_ID_HEADER, id);

  // ---------------------------------------------------------------------------
  // STEP 3: Pass control to the next middleware.
  //
  // `next()` is how Express middleware chains work. Without calling `next()`,
  // the request would hang indefinitely — no subsequent middleware or route
  // handler would execute, and the client would eventually get a timeout.
  // ---------------------------------------------------------------------------
  next();
}
