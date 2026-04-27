import { Router, type IRouter } from 'express';

import { testDatabaseConnection } from '../config/database.ts';
import { isRedisHealthy } from '../config/redis.ts';
import type { HealthStatus } from '../types/index.ts';

export const healthRouter: IRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const [database, redis] = await Promise.all([
    testDatabaseConnection({ silent: true }),
    isRedisHealthy(),
  ]);

  /** BullMQ not wired yet — reported as `false` until Phase B. */
  const queue = false;

  const services = { database, redis, queue };

  let status: HealthStatus['status'];
  if (!database || !redis) {
    status = 'unhealthy';
  } else if (!queue) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  const body: HealthStatus = {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services,
  };

  const httpStatus = status === 'unhealthy' ? 503 : 200;
  res.status(httpStatus).json(body);
});
