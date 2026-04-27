import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.ts';
import { insertUser, findUserById, listUsers, updateUserPreferences } from '../repositories/users.repository.ts';
import type { CreateUserInput, UpdateUserPreferencesInput } from '../schemas/user.schema.ts';
import type { PaginatedResult, User } from '../types/index.ts';

export async function createUser(input: CreateUserInput): Promise<{ id: string; email: string }> {
  try {
    return await insertUser({
      email: input.email,
      phone: input.phone,
      device_token: input.device_token,
      preferred_channels: input.preferred_channels,
      timezone: input.timezone,
    });
  } catch (err: unknown) {
    const pgCode = typeof err === 'object' && err ? (err as any).code : undefined;
    if (pgCode === '23505') {
      throw new ConflictError('Email already exists');
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function getUser(id: string): Promise<User> {
  const user = await findUserById(id);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  return user;
}

export async function getUsersPage(params: {
  page: number;
  limit: number;
}): Promise<PaginatedResult<User>> {
  const { data, total } = await listUsers(params);
  const totalPages = Math.ceil(total / params.limit);
  return { data, total, page: params.page, limit: params.limit, totalPages };
}

export async function patchUserPreferences(
  id: string,
  input: UpdateUserPreferencesInput,
): Promise<User> {
  if (
    input.quiet_hours_start !== undefined &&
    input.quiet_hours_end === undefined
  ) {
    // Keep the learning contract strict: quiet hours are a window.
    throw new ValidationError('quiet_hours_end is required when quiet_hours_start is provided');
  }

  if (
    input.quiet_hours_end !== undefined &&
    input.quiet_hours_start === undefined
  ) {
    throw new ValidationError('quiet_hours_start is required when quiet_hours_end is provided');
  }

  const updated = await updateUserPreferences(id, input);
  if (!updated) {
    throw new NotFoundError('User not found');
  }
  return updated;
}

