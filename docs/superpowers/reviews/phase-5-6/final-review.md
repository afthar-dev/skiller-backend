# Final review: Phases 5–6 (gigs, messaging, promo campaigns, analytics)

Branch `phase-5-6-gigs-growth`, range `6f6b925..a45949c` (6 commits, about 7,300 lines without lockfiles and `openapi.json`).
Read: spec §10, §13, §14, §3.2; plan (Global Constraints, Decisions, Review Focus); ledger and all task reports; all of `src/modules/{gigs,messaging,growth,analytics}`, the mail and notification changes, every SegmentProvider and MetricsProvider, migrations, schema diff, drift script, README sections, and the campaign, messaging, gig-search and analytics specs.
Nothing was run: no tests, no build, no drift script (read-only review, no long runs). Throughput figures below are estimates from the code (one serial mail worker, one HTTPS call per mail), not measurements.

**Verdict: With fixes. Do not merge until both Critical findings are fixed; the Important list belongs in the same fix wave.**

---

## Strengths

- **Conversation privacy is structurally sound.** Every read and write goes through `participation()` (`messaging.service.ts:175`), and a stranger and a missing id get the same 404. The report path keeps that property (`moderation.service.ts:96-99`).
- **Blocks and account state are re-checked on every send** in one place (`assertReachable`), with one refusal error. `isFollowing(recipientId, senderId)` has the right argument order for FOLLOWING.
- **Pub/sub isolation is correct.** One exact channel per user, no pattern subscribe, listeners keyed by channel. No cross-user path exists (`message-stream.hub.ts`). Token expiry and revocation end a stream, and suspension reaches it because `admin-users.service.ts:152` revokes sessions (within one 25 s beat).
- **Moderator access to message text is narrow.** Text is available only through the `preview` of a reported message; hidden or removed text is null in every view, including the list preview.
- **The unsubscribe token is good.** HKDF-separated key, constant-time compare, signature over the exact encoded body, category bound, no address in it. Forged and swapped tokens are tested.
- **Recipient selection is careful.** Claims use SKIP LOCKED plus `claimedAt` stale recovery; suppression is checked twice (at claim and in `MailProcessor`); suppression normalisation is consistent; `setPromoEmail` keeps preference and suppression in step and never lifts a bounce or complaint.
- **Campaign Markdown is safe.** Validated at save, rendered with `html: false` and an allow-list `validateLink`. The footer sits outside the body, and subject control characters are refused rather than repaired.
- **Rollup design is right.** Upsert overwrite, snapshot keys kept out of old days, a failing provider does not lose the others, HLL memory is tiny (about 420 KB in total), no user list exists anywhere, and DAU/WAU/MAU persist into `daily_metrics` nightly.
- **`AccessGuard.record` is synchronous, fire-and-forget and exception-safe.** It cannot fail or slow a request.
- **Segment and metrics providers respect ownership** (rbac, billing, reels, identity, courses, gigs, messaging, moderation). Growth reads only `campaigns` and `campaign_recipients`; analytics reads only `daily_metrics`.
- **Hidden gigs are handled correctly** on search, profile and page (`GigVisibility` plus a final ACTIVE re-read), and the reel card follows gig state.
- **Migrations match the schema**, with hand-written objects listed in the README and drift noise list. `gig_orders` is unreachable and its flag is seeded off.
- **The outbox-dead flake was root-caused and fixed**, not retried away.

---

## Critical

### C1. Any real campaign takes down email OTP (login and step-up) for its whole drain time
**Where:** `src/modules/growth/campaign-sender.ts:96-110,149-156`; `src/modules/mail/mail.service.ts:30`; `src/modules/mail/mail.processor.ts:23-25` (no `concurrency`); `src/common/queue/queue-worker.runner.ts:33,41`; `src/modules/identity/otp.service.ts:81`.

**What is wrong:** Campaign mail and OTP mail share one FIFO BullMQ queue with one job in flight per worker process and no priority. The sender has no backpressure: up to 3,000 jobs per campaign per 30 s tick (about 100 per second), while the mail worker does one render and one HTTPS call at a time (roughly 5 per second).

**Failure scenario:**
1. An admin sends to 10,000 members. About 2 minutes later all 10,000 jobs are queued.
2. For the next 30 minutes or so, every OTP lands behind them. OTPs expire in 10 minutes, so email login and step-up fail for everyone.
3. Admins cannot stop it. Pause and cancel need a step-up, which needs an OTP stuck in the same queue, and cancelling does not recall queued jobs anyway (I2).

At 100,000 recipients this is a multi-hour outage. Receipts, invites and welcome mail stall too. No test covers it: the campaign tests run at most 250 mails through a fake client.

**Fix:**
- Give promotional mail its own queue and processor (`mail-promo`), so transactional mail never waits behind it.
- Make the sender enqueue only while that queue's waiting count is below a small bound (a few batches), which also solves I2 and I3.
- Add a limiter sized to the Resend plan (I4).
- Add a test: an OTP queued after a campaign backlog goes out first.

### C2. The visible Unsubscribe link does not unsubscribe anyone
**Where:** `src/modules/mail/templates/promo-campaign.tsx:26`; `src/modules/growth/unsubscribe.controller.ts:18-25`; `src/modules/growth/unsubscribe-token.ts:32-34`; `src/common/config/config.schema.ts:76`.

**What is wrong:** The footer link is `<API_BASE_URL>/v1/unsubscribe?t=…`. A browser click is a GET, and GET only returns JSON (`{category, alreadyUnsubscribed}`) by design, so that scanners cannot unsubscribe. No page anywhere offers the POST.

**Failure scenario:**
1. A member clicks Unsubscribe in the mail.
2. They see raw JSON saying `alreadyUnsubscribed: false`, and they are still subscribed.
3. The next campaign reaches them.

Only clients that act on `List-Unsubscribe-Post` work. This breaks the Global Constraint ("every promo has a one-click unsubscribe"), spec §13 and the exit check ("unsubscribe link suppresses the next send"). The e2e test passes because it reads the token from the header and POSTs directly (`campaigns.e2e-spec.ts:400`).

It is worse when `API_BASE_URL` is unset. The link and the RFC 8058 POST then go to `WEB_BASE_URL`, and unless the web app proxies `/v1` both fail silently.

**Fix:**
- Point the footer at a page with a confirm button: a web page `<WEB_BASE_URL>/unsubscribe?t=`, or `text/html` from the GET with a form that POSTs. Keep `List-Unsubscribe` on the API URL.
- Require `API_BASE_URL` in production, or refuse to start a campaign without it.
- Test the link actually found in `m.html`.

---

## Important

### I1. One admin can pass the "second admin" rule by editing someone else's draft
**Where:** `src/modules/growth/campaigns.service.ts:77-100,119-130,133-146`; `src/modules/growth/campaign-sender.ts:70`.

`approve` compares the actor only with `createdById`. Any `campaign.manage` holder can edit any draft, and the edit clears approval without recording who edited.

**Failure scenario:** Admin B takes a small draft created by A, sets the body and `segment: {}` (500,000 members), approves it (B is not the creator), and sends it. `send` and `start` both accept this because `approvedById !== createdById`. Nobody else reviewed it.

**Fix:** Store `lastEditedById`. Refuse approval when the actor is the creator or the last editor, and apply the same test in `send` and `start`. Add this case to the approval test.

### I2. Pause, cancel and turning on opt-in do not stop mail that is already queued
**Where:** `src/modules/growth/campaign-sender.ts:98-101,149-156`; `src/modules/growth/campaigns.service.ts:157-168`; `src/modules/mail/mail.processor.ts:39-52`.

Plan decision 7 says "cancel mid-way". The status is read only before a batch is enqueued, and with no backpressure the whole audience is enqueued within minutes of the start, while delivery takes hours. `MailProcessor` re-checks suppression only.

**Failure scenario:** An admin sees a typo at minute 5 and cancels. The status says CANCELLED and every queued mail still goes out. The same applies to `marketing_opt_in_required` flipped for legal reasons, and to members suspended after enqueue. Rows also read SENT, because SENT currently means "queued". The test (`campaigns.e2e-spec.ts:252-276`) passes only because it drives one batch at a time.

**Fix:** Bounded enqueue (see C1), plus a check at processing time for `ref.kind === "campaign"` through a `MailHooks` "may this still go?" callback (campaign status, opt-in).

### I3. Every queued mail stores the full body in Redis under `noeviction`
**Where:** `src/modules/growth/campaign-sender.ts:153`; `src/modules/mail/mail.processor.ts:12-14`; `src/common/queue/queue.options.ts:20`.

Each job carries `bodyMarkdown` (up to 50,000 characters) plus subject and URL. Failed jobs stay 7 days.

**Failure scenario:** With no backpressure, 100,000 recipients at 50 KB is about 5 GB of Redis (500 MB even at 5 KB). When Redis hits `maxmemory` under `noeviction`, writes fail. That means revocation markers, step-up, rate limits and every queue, not only mail.

**Fix:** The job carries `{campaignId, userId}`; the worker loads the text once per campaign (a small cache). Bounded enqueue caps the rest.

### I4. No Resend rate limit, and a mail that exhausts its retries stays SENT
**Where:** `src/modules/mail/mail.processor.ts:55-65` (no `onExhausted`); `src/common/queue/queue-worker.runner.ts:36-41` (no `limiter`); `src/common/queue/queue.options.ts:16-21`.

Spec §13 requires sending "respecting Resend rate limits". There is no limiter, and retries total about 15 s (5 attempts).

**Failure scenario:** During a Resend 429 run or a 30 s outage, jobs burn their 5 attempts and fail. Only the non-429 4xx branch reports `failed`, so the recipient stays SENT, `campaign_sends` counts it, and nobody is told. The failed job then blocks any re-add under the same jobId. OTP mail suffers the same fate.

**Fix:** Add a worker `limiter` option through `JobProcessor`, give promotional jobs longer backoff, and implement `MailProcessor.onExhausted` to emit the `failed` outcome. Add a test with `failWith(429)` and `failWith(500)`.

### I5. "One email per (campaign, user)" has a real hole after a crash
**Where:** `src/modules/growth/campaign-sender.ts:149-160`; `src/common/queue/queue.options.ts:19`; `src/modules/mail/mail.service.ts:12-15`.

The sender enqueues first and writes SENT after. If the process dies in between, rows stay PENDING and are re-claimed after 5 minutes. Protection then rests on the BullMQ jobId, but completed jobs are dropped after 1,000 newer completions or an hour. That leaves only Resend's Idempotency-Key, which lasts 24 hours (Resend's documented window; worth confirming for this account).

**Failure scenario:** A worker dies mid-batch and an admin pauses the campaign (or the worker stays down) for more than 24 hours. On resume, the batch of up to 100 members gets the campaign a second time.

The existing test (`campaigns.e2e-spec.ts:278-302`) covers only the retained-job case; the fake client has no idempotency.

**Fix:** Stamp `queuedAt` on the recipient before enqueuing, in the same claim step. A re-claim skips rows with `queuedAt` set (at-most-once, the right trade for promo), or re-queues only if the job is confirmed never run.

### I6. The one-click POST is limited to 60 per minute per IP
**Where:** `src/modules/growth/unsubscribe.controller.ts:7,28`.

RFC 8058 POSTs come from the mailbox provider's servers, so a large campaign's unsubscribes arrive from a handful of IPs. With `TRUST_PROXY=0`, every request shares one key.

**Failure scenario:** After a 100,000-mail send, Gmail's one-click requests exceed 60 per minute from its IPs. The API answers 429, the provider does not reliably retry, and those members keep getting mail.

**Fix:** The signed token is the credential. Rate-limit GET and invalid tokens by IP, and limit valid POSTs per token (or not at all).

### I7. A rebuild silently overwrites correct WAU/MAU history with partial numbers
**Where:** `src/modules/analytics/rollup.service.ts:80-88`; `src/common/activity/activity-tracker.ts:8,64-69`.

`window()` merges only the day sets still present, and the sets live 35 days. `rollupDay` writes wau and mau whenever that day's own set exists.

**Failure scenario:** Rebuild a day 20 days old (allowed: 31 days back). Its MAU window reaches 49 days back, but only about 15 of the 30 sets remain, so the stored MAU is overwritten with a smaller number. Any day older than about 5 days loses MAU this way; any day older than about 28 loses WAU. This contradicts "rerun is idempotent" and the README. No test rebuilds a day with real activity sets.

**Fix:** Write WAU or MAU only when every key of the window exists (return null otherwise, leaving the stored value). Raise the TTL to at least 30 + 31 days. Test: rebuild with one expired set must leave MAU unchanged.

### I8. Conversation gig cards show paused gigs and gigs of suspended sellers
**Where:** `src/modules/gigs/gig-lookup.ts:25-30`; `src/modules/messaging/messaging.service.ts:246,256`; `src/modules/messaging/message-view.ts:26`.

`cards()` includes PAUSED deliberately and skips `GigVisibility`. Global Constraint: "hidden, blocked and suspended content never shown". Review priority 3 names this surface.

**Failure scenario:** A seller is suspended, or the pair block each other. The gig's title and slug still show in the conversation list and link to a 404. A paused gig stays titled as if available. No test covers any of it.

**Fix:** Use `liveCards` plus `GigVisibility` for the viewer, and keep `gigId` as an opaque reference. If paused cards are wanted in a conversation for context, get a ruling from the user. The suspended-seller and blocked-viewer cases should go either way.

### I9. `allowMessagesFrom` is on the public profile, so the "no oracle" claim is false
**Where:** `src/modules/users/profiles.service.ts:84`; `src/modules/users/profiles.controller.ts:50`.

`toProfileView` is used for the public `GET /profiles/:handle`, so anyone, including anonymous callers, can read the setting.

**Failure scenario:** A harasser reads `EVERYONE`, gets `MESSAGING_NOT_ALLOWED`, and now knows they were blocked (or the account is out). The Task 1–2 ruling and the code comment at `messaging.service.ts:36` both promise this cannot be learned. The setting is also a private preference shown to the world.

**Fix:** Return it only in the owner's view (`/me`). If the UI needs a hint, add a per-viewer `canMessage` that collapses block, setting and account state into one boolean.

### I10. Tests that claim more than they prove
Each of these still passes without the code it names.

| Test | Gap |
|---|---|
| `test/e2e/analytics.e2e-spec.ts:213` "every number for a seeded IST day" | `enrolments`, `reel_views`, `first_course_published`, `refunds_paise` and `platform_revenue_paise` are asserted as 0 only (lines 234-238), and `certificates_issued`, `course_completions`, `reels_posted` and `reel_comments` are never asserted. `CoursesMetricsProvider` and `ReelsMetricsProvider` could return constant zeros. Seed real rows. |
| `src/common/activity/activity-tracker.int-spec.ts:101-113` | The "failed write is not remembered" check runs on a new tracker, `t2`, whose `seen` set is empty anyway. Deleting `this.seen.delete(userId)` keeps it green. Reuse one tracker. |
| `test/e2e/gig-search.e2e-spec.ts:337` "card is absent for … a blocked viewer" | There is no block step. The comment at line 187 ("each gig has a reel that links it") has no reel behind it, though the `describe` title claims the reel card. Removed and deleted gigs' cards are never checked. |
| `test/e2e/campaigns.e2e-spec.ts:189,200-201` | The body text itself contains "unsubscribe", so both regexes pass with no footer. Line 204 rescues the HTML; the text part has no real check. |
| `test/e2e/campaigns.e2e-spec.ts:285-295` "crash A: before the send" | The mails were already sent, so a true never-sent re-claim (the mail must then go out) is not tested. |
| `test/e2e/campaigns.e2e-spec.ts:304-313` "nobody is claimed twice" | The jobId dedupe hides the claim logic: removing SKIP LOCKED keeps it green. Assert on claims instead. |
| `test/e2e/analytics.e2e-spec.ts:481` | `>= 1` on shared Redis does not show that this member was counted. |
| Not tested at all | The 5-stream cap; a suspended user's stream closing; a gig card for a hidden gig in a conversation (see I8); a rebuild over activity sets (see I7). |

RED evidence: Task 4 is only `Cannot find module` (no behaviour shown). Task 5 was two mutations after the fact. The list above is what that evidence left uncovered.

---

## Minor (14)

1. `src/modules/messaging/message-stream.hub.ts:78-82`: the 5-stream cap is per process, not per user, so N API instances allow 5×N. There is no total connection cap and no `res.write` backpressure handling for slow clients.
2. `src/modules/messaging/conversations.controller.ts:85-101`: the listener is live before headers are set. A message arriving in the same socket read as the SUBSCRIBE reply would call `res.write` first, then `setHeader` throws. Set headers before subscribing.
3. `src/modules/messaging/messaging.service.ts:72-73`: the daily new-conversation slot is consumed before the hourly cap can refuse.
4. `src/modules/gigs/studio-gigs.controller.ts:62-65`: tags skip the shared sanitiser (Global Constraint).
5. `src/modules/gigs/gigs.service.ts:189-200`: a seller can delete a gig with open reports, releasing its pictures before a moderator decides. Reels hold such media through `OpenReports`; gigs do not use it.
6. Gig writes do not call `PostingRestrictions`, so a seller with three strikes (possibly from gigs) can keep publishing. The notification text covers only reels and comments.
7. `src/modules/growth/campaign-sender.ts:159,172`: a mail worker reporting `skipped` before the row turns SENT is lost (`status: "SENT"` filter), so the row reads SENT. `campaign_sends` counts `sentAt`, which means queued, and also counts later skipped or failed rows.
8. `src/modules/growth/campaigns.service.ts:157-168`: cancel during `start()` can leave PENDING rows on a CANCELLED campaign (no send, wrong counts). `testSend` is not audited.
9. `src/modules/growth/campaign-sender.ts:48-53`: one bad campaign throwing in `start` or `run` stops the whole tick, and the tick shares the maintenance queue at concurrency 1 with money jobs. A large `start` delays hold release and payout redrive.
10. `src/modules/growth/unsubscribe.service.ts:27-32`: for a hard-deleted user, the preference upsert hits the foreign key and answers 500, while the comment says it is accepted and does nothing. Rotating `JWT_SECRET` kills every old link despite "keeps working".
11. `src/modules/analytics/rollup.processor.ts:52`: a missed 03:00 run is not caught up (the job rolls up "yesterday" at run time) and `dataThrough` hides gaps. Dashboards show 0 for a missing day. `MessagingMetricsProvider` changes past days when a later inquiry sets `gigId` on an old conversation.
12. `eslint.config.mjs:9`: `MODULES` lacks analytics, gigs, growth, messaging (and reels), so the boundary rule does not apply to them in either direction. No violation exists today (only the `permissions.ts` pattern), but spec §3.2 relies on it.
13. `src/common/activity/activity-tracker.ts:70`: the temporary merge key has no TTL (12 KB leak per crash under `noeviction`). `exec()` per-command errors are ignored. Comments in `analytics.module.ts:10` and `growth-core.ts` are slightly off: `RollupProcessor` and `CampaignProcessor` are registered in the API too, harmlessly.
14. `campaign_recipients` has no index on `sentAt`, `openedAt` or `clickedAt`, so the nightly rollup scans the table three times. `campaign.manage` is held only by `super_admin`, so the second-approver rule needs two super admins; the go-live list should say so.

---

## Review Focus and priority list

| Item | Result |
|---|---|
| Plan focus 1 / priority 1: messaging privacy and abuse | Access, blocks both ways, NONE and FOLLOWING, caps: pass. SSE auth, expiry, revocation, channel isolation: pass (cap per process, Minor 1). Moderator text only when reported: pass. Setting exposed: **I9**. |
| Plan focus 2 / priority 2: unsubscribe integrity, email safety | Forgery: pass. Suppressed and opted-out: pass at send. Link: **C2**. One email: **I5**. Parallel workers: pass. Approval incl. scheduled: re-check present and tested, bypass **I1**. Webhook mapping, body sanitising, footer not removable: pass. Consent: pass at claim, **I2** for queued mail. One-click limit: **I6**. Operational: **C1, I3, I4**. |
| Plan focus 3: segment leaks | Pass. Counts only, test send to actor only, non-admin refused, audit holds the definition only. |
| Plan focus 4 / priority 3: hidden gigs | Search, profile, page, reel card: pass in code, with test gaps (I10). Messages' references: **I8**. |
| Plan focus 5 / priority 4: rollups | Equality, idempotent rerun, IST boundaries: pass except WAU/MAU (**I7**). Money as decimal strings: pass; ledger SQL matches finance. CSV injection: pass. Gates: pass. AccessGuard hook: pass. HLL memory: pass. DAU persisted: pass. |
| Priority 5: boundaries, boot, migrations | Providers: pass. BillingMetricsProvider reads wallet ledger tables by SQL, the same as `admin-finance.service.ts` since Phase 2 (precedent kept, not a new breach). Worker and API boot wiring read correctly. Migrations match schema. Hand-written indexes listed. ESLint gap: Minor 12. |
| Priority 6: test honesty | **I10**. |

## Rulings weighed

- Gig inquiry bypasses `allowMessagesFrom`: sound, matches decision 5, and blocks still apply.
- Setting checked at start only: acceptable. Block is the tool for existing pairs.
- Uniform `MESSAGING_NOT_ALLOWED`: implemented, but defeated by I9.
- `max_active_gigs` counts ACTIVE+HIDDEN: sound.
- SSE without a query token: sound.
- `API_BASE_URL` default: "cost small" is understated (C2).
- Key with `-`: fine.
- Scheduled re-check (controller ruling): done and tested; I1 is the remaining hole.
- DAU in Redis: acceptable with the nightly persist. The README line about Redis persistence should narrow to "today's numbers until the rollup".
- Funnel double count: disclosed in the response, acceptable.
- "No per-group reviews, cost if wrong: defects found late": as stated, the campaign issues above are that cost.

## Declined to judge

- **GMV differs from the finance summary after a refund** (rollup keeps sale-day GMV; finance drops REFUNDED). The Task 5 report rules this deliberately. A product call: whether two "GMV" numbers are acceptable on two admin screens.
- **Paused gigs in conversation cards as such.** The code calls it intentional and the plan is silent on conversations. Flagged under I8 for a ruling; suspended and blocked cases are not excused by this.
- **Whether default opt-out promo is lawful under the DPDP Act.** Decision 6 leaves it to the lawyer; the setting works.
- **Resend `email.failed`, `email.suppressed` and `delivery_delayed` events** are not mapped. The plan lists only five events; a check of the current Resend event list is worth doing.
- **`hasPurchased` counting refunded orders as purchases, and `lastActive` meaning session refresh rather than request activity.** Both are documented choices, reasonable, and outside the plan's detail.
- **A blocked user keeping full read access to old history** (ruling 4 of Tasks 1–2) is a product choice.
- **Plan's `user_activity_daily` flush replaced by HLL plus `daily_metrics`.** A deviation the ledger accepted; the outcome meets the intent.
- **Actual Resend plan limits and real throughput.** Not measurable here; C1's severity holds across any plausible rate, because the shared FIFO remains.

## Assessment

**Ready to merge: With fixes.**

The domain logic in gigs, messaging and the rollup is strong, and the privacy core holds. The sending pipeline is not production-safe: a campaign can lock members and admins out of OTP, and the link people actually click does nothing. Fix C1 and C2 first; a promo queue with bounded enqueue also resolves most of I2, I3 and I4. Then fix I1 and I5–I9, and close the I10 test gaps.
