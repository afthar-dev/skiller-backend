# skiller-backend

NestJS 11 + Prisma (PostgreSQL 16) + Redis 7 + BullMQ backend for the Skiller platform. Two processes share one codebase:

- **API** (`dist/main.js`): HTTP, everything under `/v1`.
- **Worker** (`dist/worker.js`): BullMQ processors (mail, media transcoding to HLS, outbox relay, cleanup). Needs `ffmpeg`/`ffprobe`.

A Cloudflare Worker in `edge/playback-gate` gates private HLS playback (see its own tests via `pnpm test:edge`).

## Setup

Requirements: Node 24, pnpm 10.17.1 (`corepack enable`), Docker (tests start Postgres, Redis and MinIO with Testcontainers).

```bash
pnpm install
cp .env.example .env            # fill in secrets; see the table below
pnpm db:generate                # prisma client
# local Postgres + Redis (Redis must be noeviction, see Operations notes)
docker run -d --name skiller-pg -e POSTGRES_USER=skiller -e POSTGRES_PASSWORD=skiller -e POSTGRES_DB=skiller -p 5432:5432 postgres:16-alpine
docker run -d --name skiller-redis -p 6379:6379 redis:7-alpine redis-server --maxmemory-policy noeviction
pnpm prisma migrate deploy && pnpm db:seed   # schema + permissions, system roles, SUPER_ADMIN_EMAIL user
pnpm dev                        # API with watch, http://localhost:4000/v1/docs (Swagger UI, non-production only)
pnpm start:worker               # after `pnpm build`
```

## Environment variables

Validated at boot (`src/common/config/config.schema.ts`); the process exits with a `ConfigError` listing every problem.

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | no | `development` (default), `test`, `production`. Production: JSON logs, no Swagger UI, hidden 5xx messages. |
| `PORT` | no | Default `4000`. |
| `DATABASE_URL`, `REDIS_URL` | yes | Postgres / Redis connection URLs. |
| `JWT_SECRET`, `OTP_PEPPER`, `PLAYBACK_SECRET` | yes | Each at least 32 random characters. Rotating `JWT_SECRET` signs everyone out; `PLAYBACK_SECRET` must match the edge gate. |
| `CORS_ORIGINS` | yes | Comma-separated allowed web origins (credentials are allowed). |
| `WEB_BASE_URL` | yes | Public web app URL, used for links in emails. |
| `COOKIE_DOMAIN` | yes | Domain of the `skiller_rt` refresh cookie. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | yes | Cloudflare R2 (or MinIO) credentials. |
| `R2_PUBLIC_BUCKET`, `R2_PRIVATE_BUCKET` | yes | Public assets (avatars, logos, ...) and private sources / lesson HLS. |
| `R2_PUBLIC_BASE_URL` | yes | Public URL prefix of the public bucket. |
| `R2_PLAYBACK_BASE_URL` | yes | Base URL of the edge playback gate. |
| `R2_ENDPOINT` | no | S3 endpoint override (MinIO locally). |
| `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `RESEND_WEBHOOK_SECRET` | yes | Transactional mail and its delivery webhook (`POST /v1/webhooks/resend`). |
| `SUPER_ADMIN_EMAIL` | yes | Gets the `super_admin` role at seed time. |
| `TRUST_PROXY` | no | Reverse-proxy hops in front of the API (default `0`). |
| `SENTRY_DSN` | no | Enables Sentry. Only server errors (status >= 500) are reported. |
| `LOG_LEVEL` | no | Pino level, default `info`. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | no | Worker only; default `ffmpeg` / `ffprobe` on `PATH`. |

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` / `pnpm start:worker` | Run, compile (`dist/`, plus `dist/release/` with the seed and permission sync), start. |
| `pnpm lint` | ESLint, including the module-boundary rules. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm test` | Unit tests. `pnpm test:int` integration, `pnpm test:e2e` end-to-end (Docker required). On Windows add `--forceExit`. |
| `pnpm test:edge` | Playback gate (Cloudflare Worker) tests; run `pnpm --dir edge/playback-gate install` once first. |
| `pnpm db:migrate:new <name>` | Create a migration from schema changes. |
| `pnpm db:seed` | Idempotent seed (dev, via ts-node). |
| `pnpm db:sync-permissions` | Upsert permission keys declared in code (dev, via ts-node). |
| `pnpm openapi:export` | Regenerate `openapi.json`. Needs no database. Commit the result; CI fails if it is stale. |

## API contract

`openapi.json` at the repo root is the contract for frontend client generation (OpenAPI 3, all paths under `/v1`). Every operation documents the shared `ErrorResponse` (`{ error: { code, message, details }, requestId }`) as its `default` response, and 401 where authentication is required. Swagger UI is served at `/v1/docs` when `NODE_ENV` is not `production`.

## Architecture rules

- Feature code lives in `src/modules/<name>`; shared infrastructure in `src/common`.
- A module may import `src/common/**`, its own files, and another module **only through that module's `index.ts`** (`import { AccountService } from "../identity"`). `src/common` never imports a module. `pnpm lint` enforces both (`eslint.config.mjs`).
- A module reads and writes only its own tables; cross-module work goes through an exported service or an outbox event (handlers must be idempotent).

## Release steps

Images: `docker build -t skiller-api .` and `docker build -f Dockerfile.worker -t skiller-worker .` (CI builds both without pushing).

1. **Migrate and sync permissions** with the new API image, before starting new containers:
   ```bash
   docker run --rm --env-file .env skiller-api npm run release
   # = prisma migrate deploy && node dist/release/scripts/sync-permissions.js
   ```
   First deploy of an environment: use `npm run release:seed` instead (migrate, then `node dist/release/prisma/seed.js`: permissions, system roles, super admin, default flags). Both are idempotent. The compiled scripts mean production needs no `ts-node`.
2. Roll out the API (`CMD node dist/main.js`, port 4000) and the worker (`CMD node dist/worker.js`).
3. Check `GET /v1/health` (liveness) and `GET /v1/ready` (database and Redis).
4. If the Cloudflare edge gate changed: `pnpm --dir edge/playback-gate deploy`.

Orphaned permissions (keys in the database no longer declared in code) are reported by the sync, never deleted.

## Operations notes

- **Redis must run with `maxmemory-policy noeviction`.** Redis holds security state that must not be silently dropped: `sessions:revoked:{sid}` (revoked-session markers that block still-valid access tokens), `stepup:{sid}`, rate-limit windows and the BullMQ queues. An evicting policy (e.g. `allkeys-lru`) could re-enable a revoked access token.
- **`TRUST_PROXY`** = number of reverse-proxy hops in front of the API (0 = none). Per-IP rate limits and stored session/OTP IPs use `req.ip`; set this to the real hop count in production (e.g. 1 behind a single load balancer or CDN).
- **Logging**: Pino, JSON in production and pretty in development. `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]` and any `code`, `token`, `refreshToken`, `password` field one level deep are redacted. Every request log carries `requestId` (also returned as the `x-request-id` header and in error bodies).
- **Sentry**: set `SENTRY_DSN` on both API and worker. Client errors (status < 500) are never reported; a worker job that has used all its attempts is reported.
- **Queues** (one BullMQ Worker each, because BullMQ cannot filter by job name): `outbox` (relay + event dispatch), `mail`, `maintenance` (hourly media cleanup), `media-transcode` (concurrency 1: ffmpeg saturates the machine, scale by running more worker processes), `media-light` (images + files, concurrency 4).
- **Outbox delivery** retries a failing event 15 times (1 s doubling, capped at 30 min, about 2.4 h). A still-failing event gets `outbox_events.deadAt` + `lastError`, is reported to Sentry, and is listed by `GET /v1/admin/outbox/dead` (`audit.view`). The failed BullMQ job is kept in Redis (queue `outbox`, `removeOnFail: false`); once the cause is fixed, replay it (for example `queue.retryJobs({ state: "failed" })` on the `outbox` queue) and clear `deadAt` on its row. Handlers are idempotent, so replays are safe.

## Notes for the frontend

- **Resumable uploads**: multipart part URLs are valid for 1 hour. If a part URL expires (or the page reloads), call `POST /v1/media/uploads/:id/parts` with `{ partNumbers: [..] }` to get fresh URLs for those parts (owner only, while the upload is still pending, 60 requests per hour), upload them, then `complete`.
- **Playback tokens expire after 10 minutes.** `GET /v1/media/:id/playback` returns a `manifestUrl` whose token is valid for 10 minutes (`expiresAt`). The player must call this route again and reload the manifest before expiry (and after a 401/403 from the edge gate); do not cache the URL longer than that.
- Access tokens last 15 minutes; refresh by `POST /v1/auth/refresh` (httpOnly cookie `skiller_rt`, path `/v1/auth`, so send requests with credentials).
- Sensitive admin actions need a step-up (`/v1/auth/step-up/request` + `/verify`), valid for 5 minutes per session.
- Lists use cursor pagination: `?cursor=&limit=` and return `{ items, nextCursor }`.
