import { Router, type IRouter } from 'express';
import { z } from 'zod/v4';

import { validate, validateQuery, validateParams } from '../middleware/validate.ts';
import { createUserSchema, paginationSchema, updateUserPreferencesSchema } from '../schemas/index.ts';
import { createUser, getUser, getUsersPage, patchUserPreferences } from '../services/users.service.ts';

export const usersRouter: IRouter = Router();

usersRouter.post('/', validate(createUserSchema), async (req, res, next) => {
  try {
    const user = await createUser(req.body);
    res.status(201).json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

usersRouter.get('/', validateQuery(paginationSchema), async (req, res, next) => {
  try {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    const result = await getUsersPage({ page, limit });
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

usersRouter.get(
  '/:id',
  validateParams(z.object({ id: z.string().uuid('Invalid user ID format') })),
  async (req, res, next) => {
    try {
      const id = (req.params as unknown as { id: string }).id;
      const user = await getUser(id);
      res.status(200).json({ success: true, user });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.patch(
  '/:id/preferences',
  validateParams(z.object({ id: z.string().uuid('Invalid user ID format') })),
  validate(updateUserPreferencesSchema),
  async (req, res, next) => {
    try {
      const id = (req.params as unknown as { id: string }).id;
      const user = await patchUserPreferences(id, req.body);
      res.status(200).json({ success: true, user });
    } catch (err) {
      next(err);
    }
  },
);

