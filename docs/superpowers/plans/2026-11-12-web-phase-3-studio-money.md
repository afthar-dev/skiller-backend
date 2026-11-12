# Web Phase 3 — Creator Studio and Money Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator uploads videos, builds and submits a course, sells it, sees earnings, sets a payout account, withdraws money, and manages their plan and coupons; avatars and banners get real images.

**Architecture:** One resumable upload engine in `src/lib/upload` used by every media field. Studio (`src/app/studio/*`, desktop-first, phone-usable) and money (`src/features/{wallet,subscription,coupons}`) are client features on the Phase 1–2 client. Backend gets response schemas and the three login fixes Phase 2 left open.

**Tech Stack:** As Phase 2, plus `@dnd-kit/core` and `@dnd-kit/sortable` for curriculum ordering (keyboard sortable).

**Spec:** `docs/superpowers/specs/2026-11-06-skiller-web-frontend-design.md` (sections 8 Uploads/Money, 9 Studio/Money, 12 phase 3). Earlier web ledgers bind.

## Global Constraints

- Web branch `phase-3-studio`; backend branch `web-phase-3`, both from `main`.
- Money: decimal paise strings formatted with `lib/money`; never compute fees, GST, TDS or balances in the app. `POST /v1/wallet/payouts` sends an `Idempotency-Key` per attempt (reuse on network error or 5xx, new after other 4xx), same rule as checkout.
- Payout account and payout requests need step-up (Phase 1 dialog handles `STEP_UP_REQUIRED`). PAN and account numbers are typed by the user, sent once, never stored client-side or logged; responses are shown masked as returned.
- Uploads: parts per `POST /v1/media/uploads` (10 MB each), part URLs valid 1 h, re-sign via `/parts` (60/h), resume after reload, parallel 3 parts, per-part retry 3 times with backoff, cancel. Completed assets show processing until `GET /v1/media/:id` reports READY or FAILED.
- Studio pages show plan limits before the user hits them (from `GET /v1/subscriptions/me`).
- Markdown authored in studio is validated by the API (`422 MARKDOWN_UNSAFE` with `details.issues`); show issues inline by line.
- Every data view uses page states; AA contrast; keyboard reachable (drag-and-drop has keyboard moves).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions taken for this plan (change any you disagree with)

1. **Studio home:** `/studio` lists courses with status chips (Draft, In review, Published, Rejected with reason, Archived) and a Create button; gigs and reels join in phases 4–5.
2. **Course builder:** one page per course with tabs Details, Curriculum, Pricing, Publish. Autosave on blur for text fields; explicit Save for curriculum order.
3. **Lesson kinds:** Video (upload), Article (Markdown with preview), Resource (file upload), Quiz (question editor). Free-preview toggle per lesson.
4. **Uploads survive navigation** inside the app (engine lives in a provider); a reload resumes from stored upload id and completed parts kept in `sessionStorage` (ids and part numbers only, never URLs).
5. **Plans page** `/settings/plan`: current plan, usage vs limits, upgrade (Razorpay subscription checkout), cancel at period end, scheduled downgrade.
6. **Wallet** `/studio/earnings`: balances (available, pending, locked), ledger list, payouts list, Withdraw (min from API error text, never hard-coded), payout account form (bank or UPI + PAN).
7. **Login fixes first** (Task 1): Phase 2 left three open items; they block reliable e2e.

## Review Focus

1. **Upload interrupted:** network drop mid-part, tab reload, URL expiry after 1 h. Expected: resumes without re-sending finished parts; no orphan duplicate asset. Test in Task 3.
2. **Double withdrawal:** double tap, retry after timeout. Expected: one payout per attempt key. Test in Task 7.
3. **Course in review edited:** content is locked while IN_REVIEW. Expected: builder is read-only with a Withdraw-to-draft action, never a failing save. Test in Task 5.
4. **Curriculum reorder conflict:** two tabs reorder. Expected: second save gets the API's error and reloads, never a silent overwrite. Test in Task 5.
5. **Payout account under review:** `PAYOUT_ACCOUNT_UNDER_REVIEW`. Expected: Withdraw disabled with the reason, nothing locked. Test in Task 7.

---

### Task 1: Backend login fixes and Phase 3 schemas

Backend `web-phase-3`.

- **Refresh rotation lost Set-Cookie:** a rotation whose response never reached the browser gets 409 for 10 s, then reuse revokes the family. Fix: accept the immediately previous refresh token within a short grace window (10 s) by returning the already-rotated session's new token again (idempotent rotation), so a dropped response never signs the user out; reuse after the window still revokes. Tests: dropped response then retry with old token → 200 same new token; old token after 10 s → family revoked.
- **Second sign-in email sometimes missing:** reproduce with two sign-ins for one email within seconds (the e2e pattern). Check OTP request dedupe, mail job ids (`jobId` collisions drop the second job), and the Resend idempotency key. Fix the cause with a test.
- **Schemas:** type every route in the API list above marked untyped for studio courses, subscriptions, payout account, coupons delete, studio reviews reply; lower the untyped ceiling.
- Full suite after the last edit. Commits per fix.

### Task 2: Web session-restore gaps

- `FollowButton` and any other component reading session status must never stay on Loading when restore fails: show error with retry. Search for every `status === "loading"` branch.
- Unit tests for each. Commit `fix: no component waits forever on a failed session restore`.

### Task 3: Upload engine

**Files:** `src/lib/upload/{engine.ts,store.ts,provider.tsx,use-upload.ts}`, `src/components/upload-field.tsx`.

**Produces:** `useUpload({ purpose, accept, maxBytes })` → `{ start(file), cancel(), progress (0-1), state: "idle"|"uploading"|"processing"|"ready"|"failed", assetId, error }`; `<UploadField purpose accept onReady(assetId)>`.

Tests (mock fetch and XHR): parallel 3 parts; a failed part retries 3 times then fails the upload; 403 on a part URL re-signs via `/parts` once and continues; reload resumes from `sessionStorage` sending only missing parts; cancel stops all parts; polling `GET /v1/media/:id` every 3 s until READY or FAILED, stops on unmount. Part ETags read from response headers (R2 CORS exposes `ETag`).

### Task 4: Profile images

Avatar and banner upload on `/settings/profile` using `UploadField` (purposes from the API's media purposes); public profile and shell show the image URL from the API, initials as fallback. Tests for fallback and replace.

### Task 5: Course builder

**Files:** `src/app/studio/{layout.tsx,page.tsx}`, `src/app/studio/courses/[id]/{page.tsx,details,curriculum,pricing,publish}`, `src/features/studio-courses/*`.

Tests: create draft; details autosave shows saved/error state; `MARKDOWN_UNSAFE` issues shown by line; add/rename/delete section and lesson; video and resource lessons attach only READY assets; quiz editor keeps ids and marks correct options; reorder by drag and by keyboard, save sends every section and lesson once; reorder conflict reloads with message; submit shows `COURSE_NOT_PUBLISHABLE` missing items as a checklist; IN_REVIEW builder read-only with Withdraw; Rejected shows reason; archive needs confirm; plan limit shown before submit when at `max_published_courses`.

### Task 6: Studio analytics, reviews and coupons

`/studio/courses/[id]/analytics` (range picker, enrolments, revenue, completion, rating; drop-off and watch time only when returned, else upgrade prompt). Review replies on the course's reviews. Coupons `/studio/coupons`: list, create (code, percent or amount, limits, expiry), toggle, delete unused; error when plan lacks creator coupons. Tests for upgrade prompt, coupon validation from API errors, delete vs switch-off.

### Task 7: Wallet, payouts and plans

`/studio/earnings` and `/settings/plan` per decisions 5–6.

Tests: balances render only API strings; Withdraw reuses attempt key on network error, new key after 4xx; step-up dialog runs for payout account and payouts; under-review account disables Withdraw with reason; UPI above the API's max shows the API's message; payout list statuses; plan upgrade opens Razorpay subscription checkout with the API's subscription id; cancel at period end confirms the date; downgrade shows scheduled state.

### Task 8: End-to-end flows

Reuse Phase 2 stack, fake Razorpay (add subscription and RazorpayX payout endpoints and webhooks), fake Resend. MinIO serves uploads; transcoding needs ffmpeg, so video flows stop at "processing" unless ffmpeg is present (skip with a clear reason).

Flows at both sizes: upload resumes after reload; creator builds article + quiz course, submits, admin approves, learner buys, creator sees pending earnings; withdraw once with double tap; payout account under review blocks withdraw; upgrade plan then cancel; coupon created and used at checkout; avatar upload shows on profile; course in review is read-only. All Phase 1–2 flows still pass. Run full e2e three times; all green.

## Exit check

- [ ] Creator goes from empty studio to a published course, sale, earnings and a payout request.
- [ ] Interrupted uploads resume.
- [ ] Login stays stable through e2e: no missing codes, no lost-cookie sign-outs.
