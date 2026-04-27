/**
 * =============================================================================
 * CUSTOM ERROR CLASSES
 * =============================================================================
 *
 * This module defines a hierarchy of custom error classes used throughout the
 * notification service. Instead of throwing generic `Error` objects or using
 * magic status code numbers scattered across the codebase, we use typed errors
 * that carry their own HTTP status codes and operational metadata.
 *
 * WHY CUSTOM ERROR CLASSES?
 *
 * 1. CENTRALIZED STATUS CODES:
 *    Each error class knows its own HTTP status code. The global error-handling
 *    middleware can simply read `error.statusCode` instead of maintaining a
 *    giant switch statement mapping error types to status codes.
 *
 * 2. OPERATIONAL VS. PROGRAMMING ERRORS:
 *    The `isOperational` flag distinguishes between:
 *    - Operational errors (expected failures): A user submits invalid data,
 *      a resource isn't found, a rate limit is exceeded. These are normal —
 *      we return an appropriate HTTP response and keep running.
 *    - Programming errors (bugs): A null pointer, a failed assertion, a
 *      database driver crash. These indicate a bug in our code — we should
 *      log the full stack trace, alert the team, and potentially restart.
 *
 * 3. INSTANCEOF CHECKS:
 *    Middleware and catch blocks can use `instanceof` to handle specific
 *    error types differently:
 *      if (error instanceof ValidationError) { ... }
 *      if (error instanceof NotFoundError) { ... }
 *
 * 4. SELF-DOCUMENTING CODE:
 *    `throw new NotFoundError('User not found')` is much clearer than
 *    `throw new Error('User not found')` — the intent is immediately obvious.
 *
 * ERROR HIERARCHY:
 *   Error (built-in)
 *     └── AppError (base class with statusCode + isOperational)
 *           ├── NotFoundError (404)
 *           ├── ValidationError (400)
 *           ├── ConflictError (409)
 *           ├── RateLimitError (429)
 *           └── DatabaseError (500, isOperational = false)
 *
 * =============================================================================
 */

/* =========================================================================== */
/*  BASE ERROR CLASS                                                           */
/* =========================================================================== */

/**
 * AppError — The base class for all application-specific errors.
 *
 * Extends the built-in `Error` class with two additional properties:
 * - `statusCode`: The HTTP status code to return to the client.
 * - `isOperational`: Whether this error is expected (true) or a bug (false).
 *
 * TECHNICAL NOTES:
 *
 * 1. We call `super(message)` to set the `message` property and build the
 *    stack trace (inherited from `Error`).
 *
 * 2. `Object.setPrototypeOf(this, new.target.prototype)` is required when
 *    extending built-in classes (Error, Array, Map, etc.) in TypeScript.
 *    Without this, `instanceof AppError` checks would fail because TypeScript
 *    compiles classes to ES5-style functions that don't correctly set up the
 *    prototype chain for built-in subclasses.
 *    See: https://github.com/microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
 *
 * 3. `Error.captureStackTrace(this, this.constructor)` (when available) cleans
 *    up the stack trace by removing the error constructor itself from the trace,
 *    making the stack start from the actual throw site. This is a V8-specific
 *    API (available in Node.js but not all JS engines).
 */
export class AppError extends Error {
  /**
   * The HTTP status code associated with this error.
   * Used by the error-handling middleware to set the response status.
   *
   * Common codes:
   *   400 = Bad Request (validation errors)
   *   404 = Not Found
   *   409 = Conflict (duplicate resource)
   *   429 = Too Many Requests (rate limiting)
   *   500 = Internal Server Error
   */
  public readonly statusCode: number;

  /**
   * Whether this is an expected, operational error (true) or a
   * programming bug (false).
   *
   * Operational errors:
   *   - Return a friendly error message to the client.
   *   - Don't trigger alerts or restarts.
   *   - Examples: invalid input, resource not found, rate limit exceeded.
   *
   * Programming errors:
   *   - Log the full stack trace for debugging.
   *   - May trigger alerts to the development team.
   *   - May warrant a process restart (in extreme cases).
   *   - Examples: null reference, unhandled promise rejection, DB driver crash.
   */
  public readonly isOperational: boolean;

  /**
   * @param message       - Human-readable error description.
   * @param statusCode    - HTTP status code (e.g., 400, 404, 500).
   * @param isOperational - true = expected error, false = programming bug.
   *                        Defaults to true because most thrown errors are operational.
   */
  constructor(message: string, statusCode: number, isOperational: boolean = true) {
    // -----------------------------------------------------------------------
    // Call the parent Error constructor to set `this.message` and generate
    // a stack trace. The `message` parameter becomes `error.message`.
    // -----------------------------------------------------------------------
    super(message);

    // -----------------------------------------------------------------------
    // Store the HTTP status code and operational flag as readonly properties.
    // `readonly` ensures these can't be accidentally modified after creation.
    // -----------------------------------------------------------------------
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    // -----------------------------------------------------------------------
    // Fix the prototype chain for built-in class extension.
    // `new.target` refers to the actual constructor that was called (e.g.,
    // NotFoundError, not AppError), so this works correctly for subclasses.
    // -----------------------------------------------------------------------
    Object.setPrototypeOf(this, new.target.prototype);

    // -----------------------------------------------------------------------
    // Clean up the stack trace (V8/Node.js specific).
    // Removes the constructor call itself from the trace so the stack
    // starts at the `throw new AppError(...)` call site.
    // The `if` check ensures this doesn't crash in non-V8 environments.
    // -----------------------------------------------------------------------
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/* =========================================================================== */
/*  SPECIFIC ERROR SUBCLASSES                                                  */
/* =========================================================================== */

/**
 * NotFoundError — HTTP 404 Not Found.
 *
 * Thrown when a requested resource doesn't exist in the database.
 *
 * Usage:
 *   const user = await findUserById(id);
 *   if (!user) throw new NotFoundError(`User with id ${id} not found`);
 *
 * The error-handling middleware catches this and returns:
 *   { "status": 404, "error": "User with id abc-123 not found" }
 */
export class NotFoundError extends AppError {
  /**
   * @param message - Description of what wasn't found.
   *                  Should be specific: "User not found" rather than "Not found".
   */
  constructor(message: string) {
    // Pass 404 status code, isOperational = true (this is an expected scenario).
    super(message, 404);
  }
}

/**
 * ValidationError — HTTP 400 Bad Request.
 *
 * Thrown when the client sends invalid data that fails validation.
 *
 * Usage:
 *   if (!isValidEmail(email)) throw new ValidationError('Invalid email format');
 *
 * Typically used in conjunction with Zod schema validation:
 *   try {
 *     const data = createNotificationSchema.parse(req.body);
 *   } catch (zodError) {
 *     throw new ValidationError(formatZodError(zodError));
 *   }
 *
 * The error-handling middleware catches this and returns:
 *   { "status": 400, "error": "Invalid email format" }
 */
export class ValidationError extends AppError {
  /**
   * @param message - Description of what validation rule was violated.
   *                  Should be actionable: "Email is required" rather than "Bad request".
   */
  constructor(message: string) {
    // Pass 400 status code, isOperational = true (client error, not our bug).
    super(message, 400);
  }
}

/**
 * ConflictError — HTTP 409 Conflict.
 *
 * Thrown when an operation would create a duplicate or violate a uniqueness
 * constraint.
 *
 * Usage:
 *   // Idempotency check: notification with this key already exists
 *   if (existing) throw new ConflictError(`Notification with idempotency key ${key} already exists`);
 *
 *   // Unique constraint: template name must be unique
 *   if (nameExists) throw new ConflictError(`Template named '${name}' already exists`);
 *
 * The error-handling middleware catches this and returns:
 *   { "status": 409, "error": "Notification with idempotency key abc-123 already exists" }
 */
export class ConflictError extends AppError {
  /**
   * @param message - Description of the conflict.
   *                  Should identify the duplicate: "Email already registered" rather than "Conflict".
   */
  constructor(message: string) {
    // Pass 409 status code, isOperational = true (client caused the conflict).
    super(message, 409);
  }
}

/**
 * RateLimitError — HTTP 429 Too Many Requests.
 *
 * Thrown when a client exceeds their allowed request rate.
 *
 * While `express-rate-limit` middleware handles most rate limiting automatically,
 * this error class is useful for:
 * - Custom rate limiting logic (e.g., per-user notification limits).
 * - Queue-based rate limiting (e.g., max notifications per hour per user).
 * - Programmatic rate limit enforcement in service methods.
 *
 * Usage:
 *   if (userNotificationsThisHour >= 50) {
 *     throw new RateLimitError('Maximum 50 notifications per hour exceeded');
 *   }
 *
 * The error-handling middleware catches this and returns:
 *   { "status": 429, "error": "Maximum 50 notifications per hour exceeded" }
 */
export class RateLimitError extends AppError {
  /**
   * @param message - Description of which limit was exceeded.
   *                  Should include the limit: "100 requests per 15 minutes" rather than "Too many requests".
   */
  constructor(message: string) {
    // Pass 429 status code, isOperational = true (client is sending too many requests).
    super(message, 429);
  }
}

/**
 * DatabaseError — HTTP 500 Internal Server Error.
 *
 * Thrown when a database operation fails unexpectedly (connection lost,
 * query timeout, constraint violation that shouldn't happen, etc.).
 *
 * IMPORTANT: `isOperational` is set to `false` by default because database
 * errors typically indicate infrastructure problems or bugs in our queries,
 * not something the client did wrong. These errors should:
 * - Be logged with full stack traces and query details.
 * - Trigger monitoring alerts.
 * - Return a generic "Internal Server Error" to the client (don't leak
 *   database details like table names or query structures).
 *
 * Usage:
 *   try {
 *     await pool.query(sql, params);
 *   } catch (err) {
 *     throw new DatabaseError(`Failed to insert notification: ${err.message}`);
 *   }
 *
 * The error-handling middleware catches this and returns:
 *   { "status": 500, "error": "Internal Server Error" }
 *   (The actual message is logged server-side but NOT sent to the client.)
 */
export class DatabaseError extends AppError {
  /**
   * @param message - Internal description for logging (NOT sent to clients).
   *                  Include relevant context: query name, table, error code.
   */
  constructor(message: string) {
    // Pass 500 status code, isOperational = false (this is a system-level failure).
    // The `false` flag tells the error handler to treat this as a serious issue.
    super(message, 500, false);
  }
}
