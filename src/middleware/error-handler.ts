import type { ErrorRequestHandler, Request } from 'express';

import { AppError } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';

function getRequestId(req: Request): string | undefined {
  const h = req.headers['x-request-id'];
  if (typeof h === 'string' && h.length > 0) {
    return h;
  }
  if (Array.isArray(h) && h[0]) {
    return h[0];
  }
  return undefined;
}

/**
 * Global Express error handler. Must be registered after all routes.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = getRequestId(req);

  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error('Non-operational error', {
        message: err.message,
        stack: err.stack,
        requestId,
      });
    }

    const body: { error: string; status: number; requestId?: string } = {
      error: err.message,
      status: err.statusCode,
    };
    if (requestId) {
      body.requestId = requestId;
    }

    res.status(err.statusCode).json(body);
    return;
  }

  logger.error('Unhandled error', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    requestId,
  });

  res.status(500).json({
    error: 'Internal Server Error',
    status: 500,
    ...(requestId ? { requestId } : {}),
  });
};
