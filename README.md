# notification-service

Learning-focused notification service built with **TypeScript**, **Express 5**, **PostgreSQL**, **Redis**, and **BullMQ**.

This repo is intentionally structured like a production service (config validation, middleware, graceful shutdown, migrations) while keeping provider integrations stubbed until later phases.

## Running locally (Phase A/B)

### Docker (recommended)

Start the API + Postgres + Redis:

```bash
docker compose up --build
```

In a second terminal, start the worker (Phase B):

```bash
pnpm dev:worker
```

Health check:
- `GET /health` → returns overall status + dependency checks

Create notification (Phase B “vertical slice”):

```bash
curl -X POST http://localhost:3000/api/notifications ^
  -H "Content-Type: application/json" ^
  -d "{\"user_id\":\"<uuid>\",\"type\":\"demo\",\"channel\":\"email\",\"title\":\"Hello\",\"body\":\"World\",\"metadata\":{},\"priority\":\"normal\"}"
```

Notes:
- `scheduled_for` (ISO string) will store as **pending** and will **not** enqueue yet (scheduler comes later).
- Delivery is currently a **stub send** (worker logs + marks DB `sent`). Real providers are added in later phases.

## API (current)

### Users

- `POST /api/users` — create a recipient user (email required; others optional)
- `GET /api/users?page=1&limit=20` — list users (paginated)
- `GET /api/users/:id` — fetch one user
- `PATCH /api/users/:id/preferences` — update `preferred_channels`, quiet hours, timezone

### Dev without Docker

1. Copy `.env.example` → `.env` and adjust `DATABASE_URL` / `REDIS_*`.
2. Run migrations: `pnpm db:migrate`
3. Start API: `pnpm dev`
4. Start worker: `pnpm dev:worker`

## Architecture

See `ARCHITECTURE.md` for the full system design, roadmap, and scale considerations.
