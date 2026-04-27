import { pool } from '../config/database.ts';
import { DatabaseError } from '../utils/errors.ts';
import type { NotificationChannel, User } from '../types/index.ts';

export interface CreateUserRowInput {
  email: string;
  phone?: string | null | undefined;
  device_token?: string | null | undefined;
  preferred_channels: NotificationChannel[];
  timezone: string;
}

export async function insertUser(input: CreateUserRowInput): Promise<Pick<User, 'id' | 'email'>> {
  try {
    const result = await pool.query<{ id: string; email: string }>(
      `
      INSERT INTO users (email, phone, device_token, preferred_channels, timezone)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, email;
    `,
      [
        input.email,
        input.phone ?? null,
        input.device_token ?? null,
        input.preferred_channels,
        input.timezone,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new DatabaseError('Insert user returned no rows');
    }
    return row;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to insert user: ${message}`);
  }
}

export async function findUserById(id: string): Promise<User | null> {
  const result = await pool.query<{
    id: string;
    email: string;
    phone: string | null;
    device_token: string | null;
    preferred_channels: NotificationChannel[];
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    timezone: string;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `
    SELECT
      id, email, phone, device_token, preferred_channels,
      to_char(quiet_hours_start, 'HH24:MI') as quiet_hours_start,
      to_char(quiet_hours_end, 'HH24:MI') as quiet_hours_end,
      timezone, is_active, created_at, updated_at
    FROM users
    WHERE id = $1;
  `,
    [id],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    device_token: row.device_token,
    preferred_channels: row.preferred_channels,
    quiet_hours_start: row.quiet_hours_start,
    quiet_hours_end: row.quiet_hours_end,
    timezone: row.timezone,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listUsers(params: {
  page: number;
  limit: number;
}): Promise<{ data: User[]; total: number }> {
  const offset = (params.page - 1) * params.limit;

  const [countResult, rowsResult] = await Promise.all([
    pool.query<{ count: string }>(`SELECT COUNT(*)::text as count FROM users;`),
    pool.query<{
      id: string;
      email: string;
      phone: string | null;
      device_token: string | null;
      preferred_channels: NotificationChannel[];
      quiet_hours_start: string | null;
      quiet_hours_end: string | null;
      timezone: string;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `
      SELECT
        id, email, phone, device_token, preferred_channels,
        to_char(quiet_hours_start, 'HH24:MI') as quiet_hours_start,
        to_char(quiet_hours_end, 'HH24:MI') as quiet_hours_end,
        timezone, is_active, created_at, updated_at
      FROM users
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2;
    `,
      [params.limit, offset],
    ),
  ]);

  const total = Number(countResult.rows[0]?.count ?? '0');
  const data: User[] = rowsResult.rows.map((row) => ({
    id: row.id,
    email: row.email,
    phone: row.phone,
    device_token: row.device_token,
    preferred_channels: row.preferred_channels,
    quiet_hours_start: row.quiet_hours_start,
    quiet_hours_end: row.quiet_hours_end,
    timezone: row.timezone,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  return { data, total };
}

export async function updateUserPreferences(
  id: string,
  patch: {
    preferred_channels?: NotificationChannel[] | undefined;
    quiet_hours_start?: string | null | undefined; // HH:MM or null
    quiet_hours_end?: string | null | undefined;
    timezone?: string | undefined;
  },
): Promise<User | null> {
  const result = await pool.query<{
    id: string;
    email: string;
    phone: string | null;
    device_token: string | null;
    preferred_channels: NotificationChannel[];
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
    timezone: string;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `
    UPDATE users
    SET
      preferred_channels = COALESCE($2, preferred_channels),
      quiet_hours_start = CASE WHEN $3::text IS NULL THEN quiet_hours_start ELSE $3::time END,
      quiet_hours_end   = CASE WHEN $4::text IS NULL THEN quiet_hours_end   ELSE $4::time END,
      timezone = COALESCE($5, timezone),
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id, email, phone, device_token, preferred_channels,
      to_char(quiet_hours_start, 'HH24:MI') as quiet_hours_start,
      to_char(quiet_hours_end, 'HH24:MI') as quiet_hours_end,
      timezone, is_active, created_at, updated_at;
  `,
    [
      id,
      patch.preferred_channels ?? null,
      patch.quiet_hours_start ?? null,
      patch.quiet_hours_end ?? null,
      patch.timezone ?? null,
    ],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    device_token: row.device_token,
    preferred_channels: row.preferred_channels,
    quiet_hours_start: row.quiet_hours_start,
    quiet_hours_end: row.quiet_hours_end,
    timezone: row.timezone,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

