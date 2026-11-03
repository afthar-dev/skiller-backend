# Skiller Platform Redesign — Design Spec

- **Date:** 2026-11-03
- **Status:** Draft, awaiting review
- **Scope:** Full backend rewrite (NestJS) + API contract the React frontend will be reworked against.

## 1. Intent

Skiller combines three products:

| Side | Inspiration | Skiller feature |
|------|-------------|-----------------|
| Learning | Coursera | Courses with native video, progress, certificates |
| Marketplace | Fiverr | Gigs (listings now, escrow orders later) |
| Social / identity | LinkedIn + short video | Profiles, follows, reels |

The current backend (FastAPI-style, built by another developer) has drifting endpoints (`/wallet` vs `/wallets`), broken routes (`/billing/plans` returns 500), duplicated state (two trial-expiry clocks) and tutorial-grade features. Goal: a production-grade system with correct money handling, secure video, extensible permissions and clean module boundaries.

**Success criteria**

1. Every rupee traceable: double-entry ledger balances to zero, reconciles nightly against Razorpay.
2. Paid video cannot be fetched without a valid short-lived token.
3. Every route guarded by a permission; new roles creatable from admin UI without deploy.
4. Modules own their tables; cross-module calls go through exported services or events.
5. A course purchase credits 90% (plan-configurable) to the creator and 10% to the platform, automatically.

## 2. Decisions

| Topic | Decision |
|-------|----------|
| Architecture | Modular monolith (NestJS) + separate worker process from same codebase |
| Database | Neon Postgres, Prisma ORM, migrations in repo |
| Queue / cache | Redis (Upstash or managed) + BullMQ |
| Auth email / OTP / promo mail | Resend (+ React Email templates) |
| Payments | Razorpay Orders + Subscriptions; RazorpayX Payouts |
| Storage | Cloudflare R2 (public + private buckets), Cloudflare CDN + Worker for signed segment access |
| Video | Direct multipart upload to R2 → ffmpeg worker → HLS renditions in R2 |
| Accounts | One account, many roles. Everyone is a `member`; "Become a creator" adds `creator`. Institutions are organizations with seats |
| Subscriptions | Creator SaaS plans (creators/institutions pay to unlock limits and lower commission). Learners buy courses individually |
| Commission | Default 10%, configurable per plan, snapshotted on every order |
| Gigs | MVP = listings + inquiries/DM. Escrow orders designed, feature-flagged off |
| Payouts | Creator requests → admin approves → RazorpayX → webhook settles |
| Money unit | Integer paise everywhere. No floats |

## 3. Architecture

```
React (Vite) ──HTTPS──▶ NestJS API (/v1) ──▶ Neon Postgres
     │                        │  ├──▶ Redis (cache, rate limit, BullMQ)
     │                        │  ├──▶ Razorpay / RazorpayX
     │                        │  └──▶ Resend
     │ presigned PUT          ▼
     └────────────────▶ Cloudflare R2 ◀── Worker process (ffmpeg, emails, payouts, reconciliation)
                              ▲
        HLS playback ── Cloudflare Worker (validates signed token) 
```

Webhooks (Razorpay, RazorpayX, Resend) hit the API, are verified, stored raw in `webhook_events`, and processed by queue jobs.

### 3.1 Repository layout

```
skiller-backend/
  prisma/schema.prisma, migrations/, seed.ts
  src/
    main.ts                 # HTTP API bootstrap
    worker.ts               # BullMQ worker bootstrap
    common/                 # guards, decorators, error filter, pagination, idempotency, outbox, config (Zod)
    infra/                  # prisma, redis, r2, resend, razorpay clients
    modules/
      identity/  users/  rbac/  organizations/  media/
      courses/   reels/  gigs/  billing/        wallet/
      notifications/  admin/
  test/                     # integration + e2e
```

### 3.2 Module rules

- A module reads and writes only its own tables.
- Cross-module synchronous calls use the target module's exported service (e.g. `EntitlementsService`, `LedgerService`).
- Side effects across modules use domain events written to an `outbox` table in the same transaction, published to BullMQ by a relay. Examples: `order.paid`, `course.published`, `payout.settled`.
- `eslint-plugin-boundaries` enforces imports.

## 4. Identity and auth

- **Sign-in:** email → 6-digit OTP via Resend. OTP stored hashed, 10-minute TTL, max 5 attempts, rate-limited per email and per IP. Password login and Google OAuth are later additions.
- **Tokens:** 15-minute JWT access token (kept in memory by client) + rotating refresh token in httpOnly, Secure, SameSite=Lax cookie. Refresh tokens stored hashed in `sessions` with device, IP, last-used. Reuse of a rotated token revokes the whole token family.
- **Step-up:** payout requests, payout-account changes, email change and role grants require a fresh OTP (valid 5 minutes).
- **Sessions UI:** list devices, revoke one, revoke all others.

Tables: `users`, `user_emails`, `otp_challenges`, `sessions`.

## 5. Roles and permissions

```
permissions      (id, key UNIQUE, description, module)
roles            (id, key UNIQUE, name, scope PLATFORM|ORG, is_system, created_by)
role_permissions (role_id, permission_id)
user_roles       (user_id, role_id, org_id NULL, granted_by, expires_at NULL)
```

- Permission keys are declared in code next to the routes using them (`@RequirePermission('course.publish')`). A seed-sync step on deploy upserts new keys. Keys are never deleted automatically.
- **System roles:** `member`, `creator`, `org_owner`, `org_instructor`, `org_learner`, `moderator`, `support`, `finance_admin`, `super_admin`. System roles cannot be deleted; their permission sets can be extended.
- **Custom roles:** admins with `rbac.manage` create roles by combining existing permissions.
- **Two-layer check:**
  1. `PermissionGuard` — does any of the user's roles (platform-wide or for the target org) grant the key?
  2. Ownership policy in the service (`CoursePolicy.canEdit(user, course)`) — is this resource theirs, or do they hold an override permission like `course.manage_any`?
- Effective permission set cached in Redis per user, invalidated on any `user_roles` / `role_permissions` change.
- `audit_logs(actor_id, action, target_type, target_id, before jsonb, after jsonb, ip, created_at)` for every admin and role change.

## 6. Users, profiles, organizations

- **Profile:** unique `handle` (`/@handle`), display name, headline, about, avatar, banner, location, links, experience[], education[], skills[], portfolio items. Public profile tabs: Courses, Reels, Gigs, About.
- **Social graph:** `follows(follower_id, followee_id)`. Counts denormalized.
- **Creator onboarding:** "Become a creator" → accept creator terms → `creator` role granted → wallet accounts created → Free plan subscription created.
- **Verified badge:** granted by paid plan or KYC-approved creator.
- **Organizations (institutions):** `organizations`, `org_members(org_id, user_id, role_id)`, invite by email. Org owns courses; revenue goes to org wallet. Seat limits from the org's plan.

## 7. Media pipeline

1. `POST /v1/media/uploads {purpose, filename, size, mime}` → validates against purpose rules and plan storage quota → creates `media_assets(status=PENDING)` → returns presigned multipart URLs.
2. Client uploads parts directly to R2 (resumable).
3. `POST /v1/media/uploads/:id/complete` → completes multipart → enqueues `media.transcode`.
4. Worker: `ffprobe` validation → HLS renditions (240p/480p/720p/1080p, capped at source) → thumbnails + poster → duration → writes to R2 → `status=READY` (or `FAILED` with reason) → emits `media.ready`.

| Purpose | Bucket | Limits |
|---------|--------|--------|
| `avatar`, `banner`, `thumbnail`, `gig_gallery` | public | images, ≤10 MB |
| `reel` | public | video, ≤90 s, ≤200 MB, 9:16 preferred |
| `course_lesson` | private | video, plan storage quota |
| `course_resource` | private | pdf/zip, ≤100 MB |

**Playback of private media:** `GET /v1/media/:id/playback` (checks enrolment or ownership) → returns manifest URL with HMAC token (user id, asset id, expiry ~10 min). A Cloudflare Worker in front of the private bucket validates the token for the manifest and each segment. Player overlays a watermark with the learner's email.

Unattached assets older than 24 h are deleted by a scheduled job.

## 8. Courses

- **Structure:** `courses → course_sections → lessons`. Lesson types: `VIDEO`, `ARTICLE`, `QUIZ`, `RESOURCE`. Any lesson can be marked free preview.
- **Lifecycle:** `DRAFT → IN_REVIEW → PUBLISHED → ARCHIVED`. First publish goes to moderation queue; later edits to published courses publish directly unless flagged.
- **Pricing:** price in paise (0 = free), creator coupons (if plan allows), platform coupons.
- **Enrolment:** created on `order.paid` (or immediately for free). Lifetime access unless refunded.
- **Progress:** `lesson_progress(user_id, lesson_id, position_seconds, completed_at)`; course % computed and cached on `enrollments`.
- **Quizzes:** questions, options, pass mark; attempts stored.
- **Certificates:** PDF generated on completion, stored in R2, public verify URL `/certificates/:code`.
- **Reviews:** enrolled users only, one per user per course, rating 1–5 + text. Creator can reply.
- **Q&A:** threaded per lesson.
- **Search:** Postgres full-text + `pg_trgm` across title, subtitle, tags, creator name. Filters: category, level, price, rating, language.
- **Creator analytics:** enrolments, revenue, completion rate, per-lesson drop-off (plan-gated depth).

## 9. Reels

- Reel = `media_asset` + caption + hashtags + optional link to one course or gig (the conversion hook).
- **Engagement:** likes, comments (one level of replies), saves, shares (counter), views (counted once per user per reel after 3 s watched; deduped in Redis, flushed to DB in batches).
- **Feed:** `following` tab (reverse chronological) and `for_you` tab (score = recency decay × engagement rate × topic match with user interests). Cursor pagination. Ranking computed at read time over a candidate window; precomputation later if needed.
- **Limits:** reels per day from plan entitlements.
- **Moderation:** report → `reports` queue; moderators hide/remove; repeated violations → strike count on user.

## 10. Gigs (MVP: listings)

- `gigs(seller_id, title, category, description, tags, status DRAFT|ACTIVE|PAUSED)`.
- `gig_packages(gig_id, tier BASIC|STANDARD|PREMIUM, price_paise, delivery_days, revisions, features[])`.
- Gallery media, FAQ entries.
- **Inquiry:** buyer contacts seller → creates/opens a `conversation` with a gig reference. `conversations`, `conversation_participants`, `messages`. Delivery via polling or SSE at MVP.
- **Future (flagged off):** `gig_orders` with escrow ledger account kind `ESCROW`, delivery/acceptance, auto-release, disputes. Table shapes reserved; no endpoints exposed.

## 11. Billing

### 11.1 Orders

```
orders      (id, buyer_id, type COURSE|SUBSCRIPTION, status CREATED|PAID|FAILED|REFUNDED|PARTIALLY_REFUNDED,
             subtotal_paise, discount_paise, tax_paise, total_paise, currency,
             commission_bps, seller_owner_type, seller_owner_id,
             razorpay_order_id UNIQUE, razorpay_payment_id UNIQUE NULL, idempotency_key UNIQUE, created_at)
order_items (order_id, item_type, item_id, unit_price_paise)
coupons     (code, funded_by CREATOR|PLATFORM, owner_id, kind PERCENT|FLAT, value, max_uses, expires_at, scope)
webhook_events (id, provider, event_id UNIQUE, type, payload jsonb, processed_at, error)
```

**Checkout flow**

1. `POST /v1/checkout {item, coupon?}` with `Idempotency-Key` header → price computed server-side → commission rate snapshotted from seller's current plan → Razorpay order created.
2. Client completes Razorpay checkout.
3. `POST /v1/checkout/verify` (signature check) and Razorpay `payment.captured` webhook both call `fulfilOrder()`. Unique constraint on `razorpay_payment_id` makes the second call a no-op.
4. `fulfilOrder()` in one transaction: order → PAID, ledger entry posted, outbox `order.paid` → courses module creates enrolment, notifications send receipt.
5. Invoice PDF generated by worker, stored in R2.

**Refunds:** buyer may request within 7 days if < 30% of course consumed; admin (`order.refund`) approves → Razorpay refund → ledger reversal → enrolment revoked.

### 11.2 Creator subscriptions

```
plans          (id, key, name, audience CREATOR|ORG, is_active)
plan_versions  (id, plan_id, price_paise, interval MONTH|YEAR, commission_bps, limits jsonb, razorpay_plan_id, created_at)
subscriptions  (id, owner_type USER|ORG, owner_id, plan_version_id, status TRIALING|ACTIVE|PAST_DUE|CANCELLED|EXPIRED,
                trial_ends_at, current_period_end, cancel_at_period_end, razorpay_subscription_id)
```

- Plan price changes create a new `plan_version`; existing subscribers stay on theirs.
- `subscriptions` is the **only** source of plan, trial and expiry.
- Razorpay Subscriptions handles recurring charge; webhooks (`subscription.charged`, `.halted`, `.cancelled`) drive status.
- **Free plan** always exists (10% commission, basic limits); creators fall back to it on expiry.
- `EntitlementsService.check(owner, key)` / `.limit(owner, key)` is used by every module. Example limit keys: `max_published_courses`, `storage_gb`, `reels_per_day`, `analytics_level`, `creator_coupons`, `org_seats`.
- Downgrade never deletes content; it blocks new publishes/uploads beyond the new limits.

## 12. Wallet (double-entry ledger)

```
ledger_accounts  (id, owner_type USER|ORG|PLATFORM, owner_id NULL, kind, currency, UNIQUE(owner_type, owner_id, kind))
journal_entries  (id, ref_type, ref_id, description, created_at, UNIQUE(ref_type, ref_id, description))
ledger_lines     (id, entry_id, account_id, amount_paise BIGINT)   -- signed; SUM per entry = 0
account_balances (account_id PK, balance_paise, updated_at)        -- updated in same tx
```

Account kinds: `AVAILABLE`, `PENDING`, `PAYOUT_LOCKED` (per seller); `GATEWAY_CLEARING`, `PLATFORM_REVENUE`, `TAX_PAYABLE`, `REFUNDS` (platform).

**Course sale ₹1,000, seller plan rate 10%:**

| Account | Line |
|---------|------|
| PLATFORM / GATEWAY_CLEARING | −100000 |
| seller / PENDING | +90000 |
| PLATFORM / PLATFORM_REVENUE | +10000 |

Discounts reduce the base before commission. Platform-funded coupons are debited from `PLATFORM_REVENUE` so the seller still receives 90% of list price.

- **Hold:** after `hold_days` (platform setting, default 7) a job moves PENDING → AVAILABLE.
- **Refund inside hold:** reverse lines from PENDING. Refund after release: debit AVAILABLE (may go negative; future earnings net it off).
- **Invariants (tested):** every entry sums to 0; `account_balances` equals sum of lines; no line on a closed account.
- `LedgerService.post(entry)` is the only write path. Locks balance rows `FOR UPDATE` to avoid races.
- **Reconciliation:** nightly job compares Razorpay settlements to `GATEWAY_CLEARING`; mismatches alert admins.

### 12.1 Payouts

```
payout_accounts (owner, type BANK|UPI, masked details, razorpayx_fund_account_id, verified_at, pan_verified_at)
payouts         (id, owner, amount_paise, status REQUESTED|APPROVED|PROCESSING|PAID|REJECTED|REVERSED,
                 idempotency_key UNIQUE, approved_by, razorpayx_payout_id, failure_reason)
```

1. Creator adds payout account (fund-account validation; PAN required before first payout).
2. Request with step-up OTP and `Idempotency-Key` → ledger AVAILABLE → PAYOUT_LOCKED. Minimum amount configurable.
3. Admin with `payout.approve` approves/rejects (reject unlocks funds).
4. Approved → RazorpayX payout job → webhook `payout.processed` settles (seller PAYOUT_LOCKED −amount, PLATFORM GATEWAY_CLEARING +amount) or `payout.reversed` returns funds to AVAILABLE.
5. TDS deduction hook present, rate configurable (0 at launch unless advised otherwise).

## 13. Notifications and email

- Domain events → `NotificationsService` → in-app (`notifications` table, bell + unread count) and/or email per `notification_preferences`.
- Transactional emails (OTP, receipts, payout status, enrolment, course approved) via Resend with React Email templates, sent by worker with retries.
- **Promotional campaigns:** admin builds a segment (roles, interests, last active, has purchased) → preview count → schedule → worker sends in batches respecting Resend rate limits. Every promo email has one-click unsubscribe; `email_suppressions` filled from unsubscribes and Resend bounce/complaint webhooks; suppressed addresses are never sent promos.

## 14. Platform admin

Admin area in the frontend under `/admin`, every screen gated by permission:

- Users: search, view, suspend/ban, revoke sessions, grant/revoke roles.
- Roles & permissions editor.
- Moderation queues: courses in review, reported reels/gigs/comments.
- KYC & payout-account review.
- Payout approvals.
- Orders & refunds.
- Plans, plan versions, commission rates, coupons.
- Email campaigns.
- Platform settings (hold days, upload limits, feature flags).
- Revenue dashboard (GMV, platform revenue, payouts, active subscribers).
- Audit log viewer.

## 15. API conventions

- REST under `/v1`. OpenAPI generated from DTOs → typed TS client generated into the frontend.
- Error shape: `{ "error": { "code": "COURSE_NOT_FOUND", "message": "...", "details": {} }, "requestId": "..." }`.
- Cursor pagination: `?cursor=&limit=` → `{ items, nextCursor }`.
- `Idempotency-Key` required on checkout, payout and other money-moving POSTs; stored responses replayed for 24 h.
- Timestamps ISO-8601 UTC; money as integer paise with `currency`.

## 16. Security and operations

- Config validated by Zod at boot; app refuses to start on bad config.
- Helmet, strict CORS allowlist, Redis-backed rate limits (global + per-route for OTP, checkout, upload).
- Webhook signature verification for Razorpay, RazorpayX, Resend.
- Request IDs, Pino structured logs, Sentry for errors, `/health` (liveness) and `/ready` (DB + Redis).
- Feature flags table read through cached `FlagsService`.
- PII: payout details stored masked; full numbers only at RazorpayX.
- Deploy: API and worker as Docker images (Railway / Render / Fly). Neon branch per PR preview. Migrations run as a release step.

## 17. Testing

- **Unit:** services, policies, pricing/commission math, ledger invariants (property-based tests on `LedgerService`).
- **Integration:** Testcontainers Postgres + Redis; repository and module tests.
- **E2E:** checkout → webhook → enrolment → ledger → hold release → payout; OTP login; upload → transcode (small fixture video).
- Razorpay webhook fixtures replayed in tests.
- CI: lint, typecheck, test, `prisma migrate diff` check, OpenAPI diff.

## 18. Delivery phases

Each phase gets its own implementation plan.

| Phase | Contents | Exit criteria |
|-------|----------|---------------|
| 1. Foundation | Repo, config, infra clients, identity/OTP, sessions, RBAC, users/profile, media upload + transcode, notifications (transactional), admin shell + audit log | OTP login works end to end; role editor works; video upload reaches READY |
| 2. Money core | Billing orders + Razorpay, ledger, hold release, plans/subscriptions/entitlements, payouts + admin approval, reconciliation | Test-mode purchase credits 90/10 correctly; payout round-trip in RazorpayX test mode |
| 3. Courses | Studio, curriculum, publish/moderation, enrolment, player with signed HLS, progress, quizzes, certificates, reviews, search | Learner buys, watches, completes, gets certificate |
| 4. Reels | Upload, feed (following / for you), engagement, reports | Feed serves ranked reels; reel links to course |
| 5. Gigs | Listings, packages, inquiry DM | Buyer can find gig and message seller |
| 6. Growth | Promo campaigns, analytics dashboards | Admin sends segmented campaign with unsubscribe |
| Later | Gig escrow orders, disputes, password/Google login, Meilisearch, DRM, mobile apps | — |

Frontend rework follows each phase against the generated client.

## 19. Out of scope for MVP

Gig escrow and disputes; learner all-access subscription; live classes; DRM; multi-currency; mobile apps; data migration from the old backend (to be decided separately once old DB access is available).
