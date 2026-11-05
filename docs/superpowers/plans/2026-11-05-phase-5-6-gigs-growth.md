# Phases 5–6 — Gigs and Growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gigs as listings with buyer–seller messaging (no payments), promotional email campaigns with unsubscribe, and admin growth dashboards — completing the MVP backend.

**Architecture:** New `gigs`, `messaging` and `growth` modules. Messaging is generic (conversations can reference a gig now, orders later). Campaigns run on the worker through Resend with suppressions honoured. Dashboards read a daily rollup table built by a nightly job, never live scans. `gig_orders` escrow stays out: tables reserved, feature flag `gig_orders` off, no endpoints.

**Tech Stack:** As Phases 1–4. SSE for live message delivery (with polling fallback).

**Spec:** `docs/superpowers/specs/2026-11-03-skiller-platform-redesign-design.md` §10, §13, §14. Earlier ledgers' rulings still bind.

## Global Constraints

- Gigs never touch money or the ledger in this phase; prices are display-only integer paise (JSON decimal strings).
- Plain-text user content uses the shared sanitiser; Markdown uses `assertSafeMarkdown`.
- Every route has `@RequirePermission` / `@Public` / `@AuthenticatedOnly`; modules read only their own tables; outbox handlers idempotent; public reads rate-limited; hidden, blocked and suspended content never shown (reuse moderation/visibility seams).
- Promo email: never to suppressed addresses; every promo has a one-click unsubscribe; sends are batched, resumable and idempotent per (campaign, user).

## Decisions taken for this plan (change any you disagree with)

1. **Sellers:** creators only. Gigs reuse course categories. Limit per plan: Free 5 active gigs, Pro 25, Business unlimited (new entitlement `max_active_gigs`).
2. **Packages:** 1–3 tiers (BASIC required; STANDARD, PREMIUM optional); price ₹99–₹10,00,000.
3. **Moderation:** gigs go live immediately (no pre-approval, unlike courses) and can be reported; reports auto-hide at the shared threshold.
4. **Off-platform deals at MVP:** Skiller doesn't process gig payments. Gig pages and the inquiry screen show a notice that payments happen outside the platform and aren't protected.
5. **Messaging:** one-to-one text conversations only (no attachments in this phase); started by a buyer from a gig or by anyone from a profile if the recipient allows it (setting `allowMessagesFrom`: EVERYONE default | FOLLOWING | NONE). Blocks stop messaging both ways. Messages can be reported. 60 messages/hour/user; first message to a new person 20/day/user (spam cap).
6. **Promo consent:** every account is subscribed to promo email by default, with one-click unsubscribe, a preference toggle, and suppression on bounce/complaint. **Confirm with your lawyer** whether India's DPDP Act requires opt-in instead; a `marketing_opt_in_required` setting flips sends to explicit opt-in only.
7. **Campaigns:** admin composes subject + Markdown body + segment (roles, plan, interests, last active, has purchased); preview count and test send; schedule or send now; batches of 100 under Resend limits; cancel mid-way; stats from Resend webhooks (delivered, opened, clicked, bounced, complained). Needs permission `campaign.manage` + step-up; send needs a second admin's approval only if audience > 10,000.
8. **Dashboards:** admin `analytics.view`: signups, active users (DAU/WAU/MAU by activity), creators, course sales and revenue (from ledger), reels posted/views, gigs and inquiries, campaign performance, funnel signup → creator → first sale. Daily rollups at 03:00 IST; ranges up to 2 years; CSV export.

## Review Focus

1. **Messaging privacy and abuse:** reading others' conversations; messaging someone who blocked you or set NONE; spam caps — expected enforced everywhere. Test in Task 2.
2. **Unsubscribe integrity:** forged links, suppressed addresses, resumed campaign double-sending — expected signed links, zero sends to suppressed, one email per (campaign, user). Test in Task 4.
3. **Campaign segment leaks:** preview/test exposing user PII beyond counts; non-admin access. Test in Task 4.
4. **Hidden gigs:** paused, reported, suspended-seller gigs leaking into search, profile, reel link cards. Test in Task 3.
5. **Rollup correctness:** dashboards equal source data; rerun for a date idempotent; IST day boundaries. Test in Task 5.

---

### Task 1: Gig listings
- Models `Gig(id, sellerId, slug @unique, title, description (Markdown), categoryId, tags[], status DRAFT|ACTIVE|PAUSED|HIDDEN|REMOVED|DELETED, coverAssetId?, createdAt, updatedAt, publishedAt?)`, `GigPackage(gigId, tier, name, pricePaise, deliveryDays, revisions, features[])`, `GigGalleryItem(gigId, assetId, position)`, `GigFaq(gigId, question, answer, position)`. Reserved tables `gig_orders` (shape only, unused), flag `gig_orders` stays off.
- Studio CRUD `/v1/studio/gigs`, activate/pause; `max_active_gigs` entitlement; media via `GIG_GALLERY`/`THUMBNAIL` attach; public `GET /v1/gigs/:slug`, `GET /v1/profiles/:handle/gigs`.
- [ ] TDD. Commit `feat: gig listings`.

### Task 2: Messaging
- New `messaging` module: `Conversation(id, kind DIRECT, gigId?, createdAt, lastMessageAt)`, `ConversationParticipant(conversationId, userId, lastReadAt, archivedAt?)`, `Message(id, conversationId, senderId, body, status VISIBLE|HIDDEN|REMOVED, createdAt)`; unique direct pair.
- `POST /v1/conversations { recipientHandle, gigId?, message }` (get-or-create), `GET /v1/conversations`, `GET /v1/conversations/:id/messages` (keyset), `POST .../messages`, `POST .../read`, unread count, SSE stream `GET /v1/conversations/stream` (Redis pub/sub) with polling fallback; profile setting `allowMessagesFrom`; notifications batched; moderation target GIG_MESSAGE; blocks enforced.
- [ ] TDD incl. Review Focus 1. Commit `feat: messaging and gig inquiries`.

### Task 3: Gig search and links
- Gig tsvector + trigram search and catalog `GET /v1/gigs?q=&category=&minPrice=&maxPrice=&sort=` with signed cursors and partial indexes; reports for gigs (moderation target GIG, auto-hide); reels may link one ACTIVE gig of their creator (card, Phase 4 Decision 3 follow-up); hidden gigs filtered on every surface.
- [ ] TDD incl. Review Focus 4. Commit `feat: gig search, moderation and reel links`.

### Task 4: Promo campaigns
- `growth` module: `Campaign(id, name, subject, bodyMarkdown, segment Json, status DRAFT|SCHEDULED|SENDING|PAUSED|SENT|CANCELLED, scheduledAt?, createdById, approvedById?, stats Json)`, `CampaignRecipient(campaignId, userId, status PENDING|SENT|SKIPPED|FAILED, sentAt?, resendId?) @@id`.
- Segment evaluation through exported lookups (no cross-module table reads); preview returns counts only; test send to the actor; worker sends in batches with `idempotencyKey = campaign:user`, resumes after crash, respects suppressions + preferences + `marketing_opt_in_required`.
- Signed one-click unsubscribe `GET/POST /v1/unsubscribe?t=` (`@Public`) + `List-Unsubscribe` headers; preference toggle; Resend webhooks fill stats; audit; `campaign.manage`, step-up, second approver above 10,000.
- [ ] TDD incl. Review Focus 2, 3. Commit `feat: promo email campaigns`.

### Task 5: Dashboards, wiring, docs
- `DailyMetric(day, key, value BigInt) @@id` built by a nightly job at 03:00 IST from exported per-module `MetricsProvider`s (idempotent rerun per day, backfill command); activity tracked by a lightweight `user_activity_daily` update (Redis HLL + flush) from AccessGuard.
- `GET /v1/admin/analytics/overview|series|funnel?from&to`, CSV export; `analytics.view`.
- Worker/API boot tests, openapi, README (Gigs, Messaging, Campaigns, Analytics, go-live checklist: DPDP consent, Resend domain/DMARC), hand-written indexes in README + drift script.
- [ ] TDD incl. Review Focus 5. Commit `chore: growth dashboards, wiring, docs`.

## Exit check

- [ ] Creator publishes a gig; buyer finds it in search and messages the seller; seller replies in real time.
- [ ] Admin sends a test campaign to a segment; unsubscribe link suppresses the next send.
- [ ] Dashboard numbers match source data for a seeded day.
