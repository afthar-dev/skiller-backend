# skiller-backend

NestJS 11 + Prisma (PostgreSQL 16) + Redis 7 + BullMQ backend for the Skiller platform. Two processes share one codebase:

- **API** (`dist/main.js`): HTTP, everything under `/v1`.
- **Worker** (`dist/worker.js`): BullMQ processors (mail, media transcoding to HLS, outbox relay, cleanup, Razorpay / RazorpayX webhook processing, hold release, invoices, payouts, reconciliation). Needs `ffmpeg`/`ffprobe`.

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
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | yes | Razorpay API credentials (orders, refunds, subscriptions). Use test-mode keys outside production. |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Secret of the Razorpay dashboard webhook; verifies `X-Razorpay-Signature` on `POST /v1/webhooks/razorpay`. |
| `RAZORPAYX_ACCOUNT_NUMBER`, `RAZORPAYX_WEBHOOK_SECRET` | yes | RazorpayX payout account number, and the secret verifying `POST /v1/webhooks/razorpayx`. |
| `KYC_PEPPER` | no | 32+ character secret keying the HMAC of PAN numbers (duplicate-PAN detection); defaults to `OTP_PEPPER`. Changing it stops old accounts matching new ones. |
| `SUPER_ADMIN_EMAIL` | yes | Gets the `super_admin` role at seed time. |
| `TRUST_PROXY` | no | Reverse-proxy hops in front of the API (default `0`). |
| `SENTRY_DSN` | no | Enables Sentry. Only server errors (status >= 500) are reported. |
| `LOG_LEVEL` | no | Pino level, default `info`. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | no | Worker only; default `ffmpeg` / `ffprobe` on `PATH`. |

## Payments: Razorpay and RazorpayX

Money is integer **paise** everywhere (`BigInt` in the database, decimal **strings** in JSON: `{ "amountPaise": "123400" }`; the OpenAPI `Money` schema is `^-?[0-9]+# skiller-backend

NestJS 11 + Prisma (PostgreSQL 16) + Redis 7 + BullMQ backend for the Skiller platform. Two processes share one codebase:

- **API** (`dist/main.js`): HTTP, everything under `/v1`.
- **Worker** (`dist/worker.js`): BullMQ processors (mail, media transcoding to HLS, outbox relay, cleanup, Razorpay / RazorpayX webhook processing, hold release, invoices, payouts, reconciliation). Needs `ffmpeg`/`ffprobe`.

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
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | yes | Razorpay API credentials (orders, refunds, subscriptions). Use test-mode keys outside production. |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Secret of the Razorpay dashboard webhook; verifies `X-Razorpay-Signature` on `POST /v1/webhooks/razorpay`. |
| `RAZORPAYX_ACCOUNT_NUMBER`, `RAZORPAYX_WEBHOOK_SECRET` | yes | RazorpayX payout account number, and the secret verifying `POST /v1/webhooks/razorpayx`. |
| `KYC_PEPPER` | no | 32+ character secret keying the HMAC of PAN numbers (duplicate-PAN detection); defaults to `OTP_PEPPER`. Changing it stops old accounts matching new ones. |
| `SUPER_ADMIN_EMAIL` | yes | Gets the `super_admin` role at seed time. |
| `TRUST_PROXY` | no | Reverse-proxy hops in front of the API (default `0`). |
| `SENTRY_DSN` | no | Enables Sentry. Only server errors (status >= 500) are reported. |
| `LOG_LEVEL` | no | Pino level, default `info`. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | no | Worker only; default `ffmpeg` / `ffprobe` on `PATH`. |
). Every movement is a double-entry ledger entry posted by `LedgerService.post`; the API never edits a balance directly.

Two Razorpay products are used, with separate webhooks and **different secrets** (the app refuses to boot if they are equal):

| | Razorpay (payments, refunds, subscriptions) | RazorpayX (payouts) |
| --- | --- | --- |
| Credentials | `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (also used to call RazorpayX) | `RAZORPAYX_ACCOUNT_NUMBER` (the current account payouts debit) |
| Webhook URL | `https://<api-host>/v1/webhooks/razorpay` | `https://<api-host>/v1/webhooks/razorpayx` |
| Webhook secret | `RAZORPAY_WEBHOOK_SECRET` | `RAZORPAYX_WEBHOOK_SECRET` |
| Events to subscribe | `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed` | `payout.processed`, `payout.reversed`, `payout.failed`, `payout.rejected`, `fund_account.validation.completed`, `fund_account.validation.failed` |

Setup:

1. Razorpay dashboard, Settings, API keys: create a key pair (test mode first) and put it in `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`.
2. Settings, Webhooks: add the `/v1/webhooks/razorpay` URL with its own secret (`RAZORPAY_WEBHOOK_SECRET`) and the events above. Do not reuse the API key secret.
3. RazorpayX dashboard: note the current account number (`RAZORPAYX_ACCOUNT_NUMBER`), add the `/v1/webhooks/razorpayx` URL with a **different** secret (`RAZORPAYX_WEBHOOK_SECRET`) and its events.
4. Webhooks are verified on the raw body (HMAC-SHA256), stored once per `X-Razorpay-Event-Id` (and per body hash), then processed by the `billing` queue; a failed event is retried and kept for replay. A payout.* / fund_account.* event arriving on the Razorpay endpoint is ignored.
5. Run the worker: payments are fulfilled, refunds finished and payouts settled there, not in the API.

Idempotency: `POST /v1/checkout`, `POST /v1/wallet/payouts` and `POST /v1/orders/:id/refund-requests` need an `Idempotency-Key` header (responses replay for 24 h). Towards Razorpay the refund id is sent as `X-Refund-Idempotency` and the payout id as `X-Payout-Idempotency` (and as the payout's `reference_id`).

### Platform settings

Stored in `platform_settings` (admin API), read through a typed registry; the default applies until a value is set:

| Key | Default | Meaning |
| --- | --- | --- |
| `hold_days` | `7` | Days a seller's share stays PENDING before it becomes AVAILABLE. |
| `gst_bps` | `1800` | GST rate (18%). Platform fees and subscription prices are GST-**inclusive**. |
| `tds_bps` | `0` | TDS withheld on payouts, in basis points. Keep 0 until the CA confirms (see checklist). |
| `min_payout_paise` | `50000` | Smallest payout request (INR 500). |
| `upi_max_payout_paise` | `10000000` | Largest single UPI payout (INR 1,00,000); above it the creator must use a bank account. |
| `platform_legal_name` | `Skiller` | Legal name printed on invoices and credit notes. |
| `platform_address` | empty | Registered address printed on invoices and credit notes. |
| `platform_state_code` | empty | Two-digit GST state code (place of supply). |
| `platform_gstin` | empty | 15-character GSTIN; empty prints "GSTIN: applied for". |
| `sac_code` | `998439` | Service accounting code on invoices. |
| `max_upload_mb_course_lesson` | `5120` | Largest lesson video upload, MB. |
| `reel_max_seconds` | `90` | Longest reel. |
| `report_autohide_threshold` | `5` | Distinct members who must report the same content before it is hidden until a moderator decides. |

### Finance operations

- **Nightly reconciliation** (worker, 02:00 India time, `maintenance` queue): for the previous IST day it compares Razorpay's captured payments with PAID / REFUNDED orders and subscription charges (by payment id and amount), checks settlements (a failed settlement, or more settled than the books ever took in), checks the ledger in SQL (all lines sum to 0, every `account_balances` row equals its lines, every entry of the day sums to 0), and fetches payouts and refunds stuck `PROCESSING` for over 2 hours from the provider, applying their final status through the same code as the webhooks. One `reconciliation_runs` row per date (rerunning a day updates it). `MISMATCH` or `ERROR` notifies every `finance_admin` and reports to Sentry. Run a day by hand with `POST /v1/admin/finance/reconciliation/run { "date": "YYYY-MM-DD" }` (`finance.reconcile`, step-up, audited); `GET /v1/admin/finance/reconciliation` lists runs.
- **Finance summary**: `GET /v1/admin/finance/summary?from&to` (`finance.view`, IST days, default last 30): GMV, platform revenue, tax payable, refunds, payouts paid / pending, paid subscribers. Every number is a ledger or money-table sum.
- **Admin lists** (filters + cursor pagination): `/v1/admin/orders`, `/subscriptions` (`billing.view_any`), `/refunds` (`billing.refund`), `/payouts`, `/payout-accounts` (`wallet.view_any`).
- **Coupons**: platform coupons at `/v1/admin/coupons` (`billing.coupons.manage`, step-up, audited); creators manage their own at `/v1/coupons/mine` (needs a plan with creator coupons).
- **Payout account review flags** (DUPLICATE_PAN, NAME_MISMATCH) block both new payout requests (409 `PAYOUT_ACCOUNT_UNDER_REVIEW`, nothing is locked) and approvals / sends of payouts already requested (auto-rejected, funds unlocked) until finance clears them: `POST /v1/admin/payout-accounts/:id/clear-flag` (`payout.approve`, step-up, audited). Both flags raise a finance alert.
- **Payouts in `MANUAL_REVIEW`** (a processed event with the wrong amount; funds stay locked): `POST /v1/admin/payouts/:id/resolve { "outcome": "PAID" | "RETURNED", "note" }` (`payout.approve`, step-up, audited; the approver and the requester cannot resolve). `PAID` posts the settlement entry exactly as a processed webhook would; `RETURNED` moves the locked amount back to AVAILABLE and marks the payout FAILED (`MANUAL_REVIEW_RETURNED`). The creator gets the usual paid / failed notification. `MANUAL_REVIEW` payouts count as pending in the finance summary.
- **Organization money routes** (payout account, payouts, subscription checkout / cancel / change under `/v1/orgs/:slug/...`) need `org.wallet.manage` **held in that organization** (granted to `org_owner` only). Platform-wide grants, `super_admin` included, do not satisfy it (`orgScopedOnly`); read routes still accept `org.manage`.
- **Payout account changes** email and notify the owner (a creator) or every `org_owner` (an organization), with the end of the 24 hour pause.
- **Sentry** never receives request bodies, cookies, headers or query strings (`dataCollection` off plus a `beforeSend` that drops them and filters account / pan / vpa / token / code keys in `extra` and `contexts`). Verify once with a test event in staging.
- Phase 3 must register the COURSE `SellableProvider` in **both** the API and the worker module: fulfilment after a webhook runs in the worker.

### Go-live checklist (money)

Do not take real money until every box is ticked.

- [ ] **RazorpayX request and webhook shapes verified in test mode.** The RazorpayX client was written from the documentation and has only run against fakes. In test mode confirm: the fund account validation (penny drop) request and its `fund_account.validation.completed` webhook, including `results.account_status` and `registered_name`; the payout entity (`status`, `utr`, `failure_reason`, `reference_id`); finding a payout by `reference_id`; the `X-Payout-Idempotency` header returning the first payout on a repeat; and that `payout.processed` carries an `amount` equal to what was sent. Also confirm that `GET /payments`, `/settlements` and `/refunds/:id` (used by reconciliation) return the fields the client reads, and that `X-Refund-Idempotency` is honoured.
- [ ] **CA confirms the tax treatment**: GST on the platform fee (18%, fee treated as GST-inclusive), the GST credit notes issued on every refund (credit notes `SKC/yy-yy/nnnnnn`, invoices `SKL/yy-yy/nnnnnn`), SAC code **998439**, and the TDS rate under section 194-O for `tds_bps` (commonly 1%; 0 until confirmed).
- [ ] **CA confirms the rest of the tax model** (none of this is built yet):
  - **GST TCS under section 52 CGST Act**: as an e-commerce operator the platform collects 1% TCS on each seller's net taxable supplies (and files GSTR-8). Nothing computes, collects or reports it today.
  - **Rule 46 invoice content**: supplier GSTIN, place of supply from the buyer's state (the buyer's state is not collected; invoices fall back to the platform's state), and the **CGST + SGST** split (intra-state) or **IGST** (inter-state) instead of the single "GST (18%)" line. "TAX INVOICE" must not be printed until a GSTIN is set.
  - **Seller vs platform documents**: today one document bills the buyer the full price and taxes only the platform fee. The CA decides whether the platform fee invoice and the seller's own invoice / bill of supply must be two documents.
  - **194-O base**: TDS is currently computed on the payout amount. Section 194-O applies to the gross amount of sales credited or paid, whichever is earlier; confirm the base, not only the rate.
  - **Reconciliation settlement check is aggregate only**: it compares a day's settled gross with all-time clearing inflow, so it catches a failed settlement or a large over-settlement but not a per-settlement mismatch. Per-settlement matching (Razorpay settlement recon API) is deferred.
- [ ] Fill **`platform_legal_name`, `platform_address`, `platform_state_code` and `platform_gstin`** (settings above). Without them invoices print placeholders.
- [ ] Both webhooks configured with **different** secrets and the events listed above; send a test event to each and see it processed (`webhook_events.processedAt` set).
- [ ] Run one end-to-end purchase, refund, subscription and payout in test mode, then a manual reconciliation run for that day (expect OK).
- [ ] Redis is `noeviction`, a worker is running, `SENTRY_DSN` is set on both processes, and at least two people hold `finance_admin` (a payout cannot be approved by the person who requested it).
- [ ] Phase 3: the COURSE `SellableProvider` is registered in both the API and the worker before courses are sold.

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

## Courses

The `courses` module owns every course table (categories, courses, sections, lessons, enrolments, progress, quizzes, certificates, reviews, Q&A). It plugs into billing through the `COURSE` sellable (registered in both the API and the worker), the course refund rule and the media playback policy.

**Lifecycle.** `DRAFT -> IN_REVIEW -> PUBLISHED -> ARCHIVED`. An author submits a complete draft (`POST /v1/studio/courses/:id/submit`; `COURSE_NOT_PUBLISHABLE` lists what is missing, and the owner's `max_published_courses` is checked at submit and again at approval). Content is locked while a course is in review (`/withdraw` returns it to draft). A moderator (`course.review`) approves or rejects with a reason; a rejected course goes back to the queue when resubmitted. After the first approval the slug is locked and edits to a published course go live directly. Archiving is terminal: the course leaves the catalog and is not for sale, but learners who already enrolled keep access. Owners are a creator (USER) or an organization (ORG); `org_owner` and `org_instructor` author an org course, and course media for an ORG course must be uploaded with `orgId` (see Organization storage).

**Moderation.** Moderators can flag any published course (hidden from the catalog and closed to new sales; enrolled learners keep access) and unflag it, with a reason; every action is audited and the author is notified. A moderator cannot review or hide content on a course they author (`COURSE_REVIEW_SELF`). Reviews, questions and answers can be hidden and unhidden by moderators (`/v1/admin/{reviews,questions,answers}/:id/{hide,unhide}`).

**Markdown rendering rule for clients.** See "Rendering course Markdown" under Notes for the frontend: render with markdown-it `html: false` and the exported link validator (`createMarkdownRenderer()` / `isSafeLinkDestination` from `src/modules/courses/index.ts`).

**Playback.** Lesson videos are private HLS. The player asks `GET /v1/media/:id/playback` (enrolled learners, free-preview lessons and authors only; refunded learners lose access at once). The returned token lasts 10 minutes: refresh it by calling the route again before `expiresAt` and after any 401/403 from the edge gate.

**Organization seats.** An `org_learner` of an organization enrols free in that organization's courses (`POST /v1/courses/:slug/enrol`, source `ORG_SEAT`) without checkout. Removing the member (`org.member_removed`) or letting the learner grant expire (daily `courses.seats.sweep`) revokes only `ORG_SEAT` enrolments, never purchases.

**Certificates.** Issued when every required lesson is complete and every quiz passed (`course.completed` event, handled in the worker). If the learner's display name is still the one derived from their email, the certificate is created `PENDING_NAME` (no PDF, not verifiable) and the learner is notified; `POST /v1/me/certificates/:id/name { name }` confirms the name (sanitised, then immutable) and issues the PDF. Public verification: `GET /v1/certificates/:code` (rate limited). A certificate is revoked when the purchase is refunded or the organization seat ends.

**Refund rule.** A course order is refundable within 7 days of purchase and while less than 30% of the required lessons are completed. Refund removes the enrolment (progress is kept for analytics but hidden), hides the learner's review and revokes the certificate.

**Creator analytics.** `GET /v1/studio/courses/:id/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD` (authors only). IST calendar days, inclusive, at most 366 days, default the last 30 days. Returns enrolments per day by source, revenue (`soldPaise`, `refundedPaise`, `netPaise`: the seller share actually posted to the ledger for this course's orders in the range, read through `BillingReports.sellerRevenueForItem`), completion rate (completed / active enrolments), rating (`avg` is null below 3 ratings) and, for owners whose `analytics_level` is `standard` or `advanced`, per-lesson drop-off and watch time in curriculum order. On `basic` those are omitted and `upgradeRequired` is `true`. Completion, drop-off and watch time describe the course as it stands (live enrolments only), not the range.

**Organization storage.** Course media for an ORG course counts against the organization's `storage_gb`, not the uploader's. The upload session takes an optional `orgId` (`POST /v1/media/uploads`); the caller must be `org_owner` or `org_instructor` there, and the purpose must be `course_lesson`, `course_resource`, `course_promo` or `thumbnail`. Usage = declared size of every non-FAILED asset with that `orgId` (pending uploads included), whichever author uploaded it. An ORG course accepts only assets uploaded for that organization, a USER course only personal ones (`MEDIA_NOT_USABLE` otherwise). Personal uploads keep counting against the uploader.

### Hand-written database objects (`prisma migrate dev` must never drop or recreate these)

Prisma cannot express them, so it proposes `DROP INDEX` / `ALTER` for them in every `migrate dev`. Delete those statements from the generated SQL, or the migration silently removes a uniqueness rule or an index the queries depend on. `scripts/check-schema-drift.mjs` (filter in `check-schema-drift-lib.mjs`, tested by `pnpm test:scripts`) ignores only those exact statements and the exact `ratingShown` ALTER COLUMN clauses, and fails the build on any other drift, including a real change in the same `ALTER TABLE`.

- `profiles_handle_pattern_idx`, `users_email_pattern_idx`: `text_pattern_ops` prefix-search indexes.
- `user_roles_userId_roleId_orgId_key`, `ledger_accounts_owner_kind_key`: unique indexes `NULLS NOT DISTINCT` (a platform-wide grant / platform account has a NULL owner and must still be unique).
- Partial unique indexes: `subscriptions_one_free_active_key`, `coupon_redemptions_live_user_key`, `refunds_order_live_key`, `payout_accounts_owner_live_key`, `certificates_live_key`.
- Search: extension `pg_trgm`; `courses_search_vector_idx` (GIN on `searchVector`, `fastupdate = off`), `courses_title_trgm_idx` (GIN trigram on `title`).
- Reels: `reels."searchVector"` (tsvector, `simple`: caption A, hashtags B) is set by the `reels_search_vector_trg` trigger (function `reels_search_vector_update()`), with `reels_search_vector_idx` (GIN, `fastupdate = off`) and `reels_caption_trgm_idx` (GIN trigram on `caption`, `fastupdate = off`); keep the three out of every `migrate dev` DROP/CREATE. `reels_hashtags_idx` (GIN on `hashtags`) and `reels_status_publishedAt_id_idx` are plain Prisma indexes.
- Catalog: partial indexes `courses_pub_popular_idx`, `courses_pub_newest_idx`, `courses_pub_rating_idx` (published, unflagged courses), `enrolments_created_active_idx` (active enrolments by `createdAt`), and the stored generated column `courses."ratingShown"` (drop the `ALTER COLUMN "ratingShown"` Prisma proposes).

## Moderation

The `moderation` module owns reports, strikes, posting restrictions, blocks and mutes; content stays with its owner, which registers a `ModerationTarget` (hide / remove / restore) with `ModerationTargetRegistry` (reels and reel comments in the reels module, course reviews and Q&A in courses). `POST /v1/reports` (20 an hour, one per member per item); `report_autohide_threshold` distinct open reporters hide the item until a moderator decides (`GET /v1/admin/moderation/reports`, `POST /v1/admin/moderation/targets/:type/:id/uphold|dismiss`, permission `moderation.review`, audited, never on your own content or courses). Upheld = content removed + one strike (90 days); 3 active strikes bar posting reels and comments for 7 days (`403 POSTING_RESTRICTED`, `details.until`). Blocks are symmetric in effect and end follows; mutes only hide a creator from the muter's feeds, hashtag pages and search. Every reel read path goes through `ReelVisibility.filterVisible`, fed by one per-viewer lookup cached 60 s in Redis (`rel:{user}:{epoch}`, epoch bumped on every block / mute change).

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
- **Queues** (one BullMQ Worker each, because BullMQ cannot filter by job name): `outbox` (relay + event dispatch), `mail`, `maintenance` (media cleanup, order expiry, idempotency cleanup, subscription grace expiry, hold release, invoice sweep, refund and payout re-drive, nightly reconciliation), `media-transcode` (concurrency 1: ffmpeg saturates the machine, scale by running more worker processes), `media-light` (images + files, concurrency 4), `billing` (Razorpay/RazorpayX webhook processing; same retry schedule as `outbox`, a failed job is kept for replay).
- **Outbox delivery** retries a failing event 15 times (1 s doubling, capped at 30 min, about 2.4 h). A still-failing event gets `outbox_events.deadAt` + `lastError`, is reported to Sentry, and is listed by `GET /v1/admin/outbox/dead` (`audit.view`). The failed BullMQ job is kept in Redis (queue `outbox`, `removeOnFail: false`); once the cause is fixed, replay it (for example `queue.retryJobs({ state: "failed" })` on the `outbox` queue) and clear `deadAt` on its row. Handlers are idempotent, so replays are safe.

## Notes for the frontend

- **Resumable uploads**: multipart part URLs are valid for 1 hour. If a part URL expires (or the page reloads), call `POST /v1/media/uploads/:id/parts` with `{ partNumbers: [..] }` to get fresh URLs for those parts (owner only, while the upload is still pending, 60 requests per hour), upload them, then `complete`.
- **Playback tokens expire after 10 minutes.** `GET /v1/media/:id/playback` returns a `manifestUrl` whose token is valid for 10 minutes (`expiresAt`). The player must call this route again and reload the manifest before expiry (and after a 401/403 from the edge gate); do not cache the URL longer than that.
- Access tokens last 15 minutes; refresh by `POST /v1/auth/refresh` (httpOnly cookie `skiller_rt`, path `/v1/auth`, so send requests with credentials).
- Sensitive admin actions need a step-up (`/v1/auth/step-up/request` + `/verify`), valid for 5 minutes per session.
- Lists use cursor pagination: `?cursor=&limit=` and return `{ items, nextCursor }`.
- **Rendering course Markdown** (lesson articles, course descriptions): the API stores Markdown exactly as sent and rejects raw HTML and unsafe links with `422 MARKDOWN_UNSAFE` (`details.issues: [{ line, kind: "html" | "link", value }]`). Allowed link and image destinations: http, https, mailto, tel or relative. Clients must still render with markdown-it using `html: false` and the same link rule: `const md = new MarkdownIt({ html: false, linkify: false }); md.validateLink = (url) => !/^([a-z][a-z0-9+.-]*):/i.test(url) || /^(https?|mailto|tel):/i.test(url);`. The reference configuration is exported as `createMarkdownRenderer()` from `src/modules/courses/index.ts`.
