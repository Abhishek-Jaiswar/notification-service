import { Router, type IRouter } from 'express';

import { validate } from '../middleware/validate.ts';
import { createNotificationSchema } from '../schemas/notification.schema.ts';
import { createNotification } from '../services/notifications.service.ts';

export const notificationsRouter: IRouter = Router();

/**
 * POST /api/notifications
 *
 * Contract (Phase B):
 * - Validates the payload and persists the notification intent.
 * - If `scheduled_for` is absent → enqueue immediately and return `{ enqueued: true }`.
 * - If `scheduled_for` is present → store as `pending` and return `{ enqueued: false }`.
 */
notificationsRouter.post('/', validate(createNotificationSchema), async (req, res, next) => {
  try {
    const result = await createNotification(req.body);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

