import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/environment.ts';
import { errorHandler } from './middleware/error-handler.ts';
import { requestId } from './middleware/request-id.ts';
import { healthRouter } from './routes/health.ts';
import { notificationsRouter } from './routes/notifications.ts';
import { usersRouter } from './routes/users.ts';
import { NotFoundError } from './utils/errors.ts';
import { logger } from './utils/logger.ts';

export function createApp(): express.Express {
  const app = express();

  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.use(
    morgan('combined', {
      stream: {
        write: (line: string) => {
          logger.info(line.trim());
        },
      },
    }),
  );

  const limiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health' || req.originalUrl === '/health',
  });
  app.use(limiter);

  app.use('/health', healthRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/users', usersRouter);

  app.use((req, _res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
  });

  app.use(errorHandler);

  return app;
}
