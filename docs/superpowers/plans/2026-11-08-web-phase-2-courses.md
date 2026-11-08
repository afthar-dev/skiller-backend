# Web Phase 2 — Courses, Learning and Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visitor finds a course through search or Google, buys it (or enrols free), learns it on a phone, passes its quizzes and gets a verifiable certificate.

**Architecture:** Catalog, course detail and certificate verification render on the server through `publicFetch`, which now identifies the web server to the API so rate limits stay per visitor. Checkout, learning, quizzes, reviews and Q&A are client features in `src/features/{catalog,checkout,learn}` on the Phase 1 client. Razorpay and video run through two small, separately tested modules.

**Tech Stack:** As Phase 1, plus hls.js, markdown-it, Razorpay Checkout (`https://checkout.razorpay.com/v1/checkout.js`).

**Spec:** `docs/superpowers/specs/2026-11-06-skiller-web-frontend-design.md` (sections 1 items 1, 5, 8, 9 Public/Learner/Money, 10, 12 phase 2). Phase 1 ledger rulings still bind: `docs/superpowers/plans/2026-11-06-web-phase-1-foundation-ledger.md`.

## Global Constraints

- Web repo `D:\skiller\skiller-web`, branch `phase-2-courses` from `main`. Backend branch `web-phase-2` from `main`.
- Money stays decimal strings of paise; format only through `lib/money` with `BigInt`, never `Number`. The app never computes price, discount, GST or fee; it shows what the API returns.
- `POST /v1/checkout` and `POST /v1/orders/:id/refund-requests` send an `Idempotency-Key` created once per user attempt, reused on retry, replaced when the user starts over.
- Markdown renders with markdown-it `html: false`, `linkify: false` and the backend's link rule: `md.validateLink = (url) => !/^([a-z][a-z0-9+.-]*):/i.test(url) || /^(https?|mailto|tel):/i.test(url)`.
- Playback tokens last 10 minutes: refetch `GET /v1/media/:id/playback` before `expiresAt` and after any 401/403 from the gate, keeping position.
- Video heartbeat `PUT /v1/learn/lessons/:id/progress {positionSec}` no more often than every 5 s (server minimum 5000 ms). Send every 15 s while playing, and on pause, seek end and page hide. Videos complete at 90% real watching; never fake completion.
- Server components fetch public data only, never forward cookies; hidden, flagged or unknown courses and certificates return a real 404.
- Every data view uses `Loading`, `Empty`, `ErrorState` or `NoAccess`. Member screens designed at 375 px first; AA contrast; keyboard reachable.
- A feature imports another only through its `index.ts`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions taken for this plan (change any you disagree with)

1. **Trusted web server:** backend gains optional `SSR_SHARED_SECRET` (32+ chars). Requests carrying it in `X-Skiller-Server` are trusted: if they also carry `X-Skiller-Client-Ip`, rate limits key on that address; without it, public read limits are skipped (only cached fetches send no client IP). The secret is server-only in the web app (`SSR_SHARED_SECRET`, never `NEXT_PUBLIC_`). Compare in constant time; a wrong secret is treated as no secret.
2. **Caching:** course detail, categories and certificate verification cache 60 s with tags. Catalog search results are dynamic (per query) and forward the visitor's IP.
3. **Catalog paging:** first page server-rendered; "Load more" fetches next pages from the browser with the signed cursor.
4. **Checkout:** one sheet on the course page: price, coupon field, total from the API, Pay. After Razorpay success the app calls verify; on 202 it polls `GET /v1/orders/:id` every 2 s for up to 60 s, then shows "Payment received, confirming" with a link to Orders. Free courses use enrol, no sheet.
5. **Razorpay script** loads only when the sheet opens. Its CSP entries arrive in phase 7.
6. **Learning layout:** phone: lesson full width, curriculum in a bottom sheet; desktop: curriculum sidebar. Resume opens the first incomplete lesson.
7. **E2E content:** article and quiz lessons only, because ffmpeg is not installed locally. The video player is covered by unit tests with a mocked hls.js and a mocked playback route.
8. **Orders page** lives at `/settings/orders` with invoice and credit-note downloads and refund requests, since a learner's purchases belong with account settings until the money area grows in phase 3.

## Review Focus

1. **Double charge:** double-tapping Pay, closing Razorpay and paying again, or a network drop during verify. Expected: one order per attempt key, verify retried safely, never two enrolments or two charges from one attempt. Test in Task 5.
2. **Verify returns 202 forever:** payment captured late. Expected: polling stops at 60 s with a clear message and no error screen; Orders shows the order once paid. Test in Task 5.
3. **Token expiry mid-video:** a 40-minute lesson. Expected: playback continues across token refreshes without jumping position. Test in Task 6.
4. **Unsafe lesson Markdown and links:** `javascript:` links, raw HTML in articles, Q&A and reviews. Expected: rendered inert. Test in Task 6.
5. **Refunded learner:** after refund the course leaves My learning, the lesson page shows NoAccess, and the certificate verify page shows revoked. Test in Task 8.

---

### Task 1: Backend: CI fix, trusted server, fake Razorpay switch

Backend repo, branch `web-phase-2`.

**Files:**
- Modify: `test/e2e/gigs.e2e-spec.ts` and whatever its failure reveals in `src/modules/gigs/`; `src/common/redis/rate-limit.*`; `src/common/config/config.schema.ts`; `src/modules/billing/billing.module.ts`; `.env.example`; `README.md`; `docs/HOSTING.md`
- Test: gigs e2e; rate-limit spec; config schema spec

**Interfaces:**
- Produces: env `SSR_SHARED_SECRET` (optional, min 32), `RAZORPAY_BASE_URL` (optional, refused in production); headers `X-Skiller-Server`, `X-Skiller-Client-Ip`.

- [ ] **Step 1: Reproduce the CI failure**

GitHub run on `main` failed `max_active_gigs ... parallel activations never exceed the limit`: of 8 parallel activations, 2 succeeded and 0 were refused. Log every status the test gets, run it 10 times locally (`--runInBand`), and on CPU-limited Docker if it doesn't reproduce. Find what the other 6 returned.

- [ ] **Step 2: Fix the cause**

If the API returns 5xx or a lock error under contention, that is a product bug: parallel activations must each get 200 or 403 `ENTITLEMENT_LIMIT_REACHED`. Fix in the service (wait for the per-seller lock instead of failing) with a test that proves it. Only if the API behaves correctly, fix the test. Record which in the report.

- [ ] **Step 3: Write failing tests for the new switches**

Config: `RAZORPAY_BASE_URL` with `NODE_ENV=production` is a `ConfigError`; `SSR_SHARED_SECRET` shorter than 32 is a `ConfigError`.
Rate limit: with the right secret and `X-Skiller-Client-Ip: 203.0.113.9`, the limit key uses `203.0.113.9`; with the right secret and no client IP, a `@Public` read limit is skipped; with a wrong secret, both headers are ignored and `req.ip` is used; client IP header without secret is ignored.

- [ ] **Step 4: Implement, verify, commit**

Pass `RAZORPAY_BASE_URL` to `HttpRazorpayClient` as `baseUrl`. Document both envs in README and HOSTING (web gets `SSR_SHARED_SECRET` as a server-only Vercel variable; replace "the web app holds none" with "the web app holds only this server-side secret").
Run: typecheck, lint, `pnpm openapi:check-responses`, then the full suite `--runInBand --forceExit`.
Commits: `fix: <cause> under parallel gig activations` and `feat: trusted web server identity for rate limits; fake Razorpay switch for local runs`.

---

### Task 2: Backend: response schemas for Phase 2 routes

**Files:**
- Modify: controllers for the routes below, `openapi.json`, `scripts/openapi-untyped-allowlist.json`, `scripts/openapi-untyped-ceiling.json`
- Test: the existing e2e spec of each route gains a `toMatchObject` on the declared required keys

**Interfaces:**
- Produces typed responses for: `GET /v1/courses`, `/v1/courses/{slug}`, `/curriculum`, `/reviews`, `/reviews/mine` (GET, PUT), `POST /enrol`, `GET /v1/categories`, `POST /v1/checkout/verify`, `GET /v1/me/learning`, `/v1/learn/courses/{slug}`, `/v1/learn/lessons/{id}`, `PUT .../progress`, `POST .../complete`, `GET /v1/learn/quizzes/{id}`, `POST .../attempts`, `/v1/me/certificates`, `POST .../name`, `/v1/certificates/{code}`, `/download`, lesson questions GET/POST, answers GET/POST, `/v1/invoices/{id}/download`, `/v1/credit-notes/{id}/download`, and the catalog query parameters (`q`, `category`, `level`, `language`, `price`, `minPrice`, `maxPrice`, `minRating`, `sort`).

- [ ] **Step 1: Add assertions, see them fail on missing declarations, declare, see them pass.** Declare what handlers really return.
- [ ] **Step 2: Lower the ceiling to the new count.** Run `pnpm openapi:export`, `pnpm openapi:check-responses`, affected specs, typecheck, lint.
- [ ] **Step 3: Commit** `feat: typed responses for course, learning and checkout routes`

---

### Task 3: Web shared pieces

**Files:**
- Create: `src/lib/money/format.ts`, `src/lib/markdown/render.ts`, `src/components/markdown.tsx`, `src/components/rating-stars.tsx`
- Modify: `src/lib/api/server.ts`, `src/lib/env.ts`, `.env.example`, `contract/`, `src/lib/api/schema.gen.ts`
- Test: `src/lib/money/format.test.ts`, `src/lib/markdown/render.test.ts`, `src/lib/api/server.test.ts`

**Interfaces:**
- Produces: `formatPaise(paise: string, opts?: { free?: boolean }): string`; `renderMarkdown(src: string): string`; `<Markdown source>`; `publicFetch<T>(path, { revalidate?: number | false, tags?: string[], clientIp?: string })`; `visitorIp(): Promise<string | undefined>` (from `x-forwarded-for` first entry, server only); `serverEnv.ssrSecret`.

- [ ] **Step 1: Write failing tests**

```ts
expect(formatPaise("49900")).toBe("₹499");
expect(formatPaise("49950")).toBe("₹499.50");
expect(formatPaise("1000000000")).toBe("₹1,00,00,000");
expect(formatPaise("0", { free: true })).toBe("Free");
expect(() => formatPaise("12.5")).toThrow();
expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("javascript:");
expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img");
expect(renderMarkdown("[ok](https://a.example)")).toContain('href="https://a.example"');
```

`publicFetch` sends `X-Skiller-Server` when the secret is set, sends `X-Skiller-Client-Ip` only when `clientIp` is given, never sends cookies or `Authorization`, and `server.ts` can't be imported into a client component (`import "server-only"`).

- [ ] **Step 2: Run, confirm failure, implement, run again** (`pnpm vitest run src/lib`)

External links open in a new tab with `rel="noopener noreferrer nofollow"`.

- [ ] **Step 3: Regenerate contract** (`pnpm api:generate`, `pnpm api:check`) and commit `feat: money format, safe markdown and trusted public fetch`

---

### Task 4: Catalog and course page

**Files:**
- Create: `src/features/catalog/{index.ts,queries.ts,filters.ts,course-card.tsx,filter-bar.tsx,load-more.tsx,curriculum-list.tsx,reviews-list.tsx}`, `src/app/(public)/courses/page.tsx`, `src/app/(public)/courses/[slug]/page.tsx`, `src/app/(public)/courses/category/[category]/page.tsx`
- Modify: bottom nav and sidebar `Courses` target from `/soon` to `/courses`; landing calls to action
- Test: `filters.test.ts`, `course-card.test.tsx`, `src/app/(public)/courses/[slug]/page.test.tsx`

**Interfaces:**
- Consumes: `publicFetch`, `visitorIp`, `formatPaise`, `<Markdown>`.
- Produces: `parseCatalogParams(searchParams): CatalogQuery`, `toCatalogSearch(query): URLSearchParams`, `CourseCard({course})`, `CourseCta` slot on the course page filled by Task 5 through `@/features/checkout`.

- [ ] **Step 1: Write failing tests**

Filters round-trip: `?q=design&price=paid&minPrice=10000&sort=newest` parses and serialises back unchanged; unknown `sort` falls back to `relevance`; `minPrice=abc` is dropped, not sent.
Course page: `publicFetch` null calls `notFound()`; metadata has title, description, canonical `/courses/<slug>`; JSON-LD type `Course` with `offers.price` from the API value; free-preview lessons link to the preview player, others show a lock.
Card: shows price through `formatPaise`, rating only when the API gives one, creator name.

- [ ] **Step 2: Run, confirm failure, implement, run again**

Search box, filter sheet on phone, chips on desktop. Empty results show `Empty` with a "Clear filters" action. Category pages share the catalog with `category` fixed.

- [ ] **Step 3: Commit** `feat: course catalog, search and course page`

---

### Task 5: Checkout and orders

**Files:**
- Create: `src/lib/razorpay/load.ts`, `src/lib/razorpay/open.ts`, `src/features/checkout/{index.ts,use-checkout.ts,checkout-sheet.tsx,course-cta.tsx,attempt-key.ts}`, `src/features/orders/{index.ts,queries.ts,orders-list.tsx,refund-dialog.tsx}`, `src/app/(member)/(shell)/settings/orders/page.tsx`, `src/app/(member)/(shell)/checkout/success/page.tsx`
- Test: `use-checkout.test.ts`, `attempt-key.test.ts`, `course-cta.test.tsx`, `refund-dialog.test.tsx`, `open.test.ts`

**Interfaces:**
- Consumes: `api`, `unwrap`, `formatPaise`, `useSession`.
- Produces: `CourseCta({course})` (state from `GET /v1/learn/courses/{slug}` 200 = enrolled); `useCheckout(item: {type: "COURSE", id: string})` returning `{ start(couponCode?), state, error, reset() }`; `openRazorpay(started: CheckoutStarted, prefill): Promise<RazorpayResult | "dismissed">`.

- [ ] **Step 1: Write failing tests**

```ts
it("reuses the attempt key when Pay is retried after a network error")
it("creates a new attempt key after reset()")
it("ignores a second start() while one is in flight")
it("on verify 200 goes to success; on 202 polls the order every 2 s and stops at 60 s with state 'confirming'")
it("on Razorpay dismiss returns to the sheet without calling verify")
it("retries verify once on network error with the same payload")
it("shows the coupon error from the API and keeps the sheet open")
```

CTA: signed out → "Sign in to buy" with `next`; enrolled → "Continue learning"; free → "Enrol free" calls enrol; paid → opens sheet. Refund dialog: offered for a `PAID` order with `paidAt` within 7 days (the API has no refundable flag; it enforces the 30% progress rule itself), sends reason with its own attempt key, shows the API's refusal text.

- [ ] **Step 2: Run, confirm failure, implement, run again**

`openRazorpay` passes `key: started.keyId`, `order_id: started.razorpayOrderId`, `amount: started.amountPaise`, `currency: started.currency`, and resolves with `{razorpay_payment_id, razorpay_order_id, razorpay_signature}`. Success page invalidates `me/learning` and links to the first lesson. Orders list shows status, amount, invoice download (fetches the 5-minute URL on click, never stored), credit note when refunded.

- [ ] **Step 3: Commit** `feat: course checkout, free enrolment and orders`

---

### Task 6: Learning and the player

**Files:**
- Create: `src/features/learn/{index.ts,queries.ts,curriculum-nav.tsx,lesson-view.tsx,article-lesson.tsx,resource-lesson.tsx,video-player.tsx,use-playback.ts,use-heartbeat.ts,next-lesson.ts}`, `src/app/(member)/(shell)/learning/page.tsx`, `src/app/(member)/learn/[slug]/layout.tsx`, `src/app/(member)/learn/[slug]/page.tsx`, `src/app/(member)/learn/[slug]/lessons/[lessonId]/page.tsx`, `src/app/(public)/courses/[slug]/preview/[lessonId]/page.tsx`
- Test: `use-playback.test.ts`, `use-heartbeat.test.ts`, `next-lesson.test.ts`, `article-lesson.test.tsx`

**Interfaces:**
- Consumes: `api`, `<Markdown>`, `RequireAuth`.
- Produces: `usePlayback(assetId): { manifestUrl, error, refresh() }`; `useHeartbeat(lessonId, getPosition)`; `nextLesson(curriculum, currentId): LessonRef | null`; `firstIncomplete(curriculum): LessonRef`.

- [ ] **Step 1: Write failing tests**

```ts
it("refetches playback 60 s before expiresAt and swaps the source keeping currentTime")
it("refetches once on a 403 from the gate, then shows ErrorState if it fails again")
it("sends a heartbeat every 15 s while playing, not while paused")
it("never sends two heartbeats within 5 s, even on pause right after a tick")
it("sends a final heartbeat on pagehide with keepalive")
it("firstIncomplete skips completed lessons; nextLesson crosses sections")
it("article lesson renders a javascript: link inert and shows Mark complete only for non-video lessons")
```

- [ ] **Step 2: Run, confirm failure, implement, run again**

hls.js when `Hls.isSupported()`, native HLS otherwise. Resume video at the API's last position. Lesson 403/404 shows `NoAccess` with a link to the course page. My learning lists progress from the API and a "Continue" button using `firstIncomplete`.

- [ ] **Step 3: Commit** `feat: my learning, lesson player and progress`

---

### Task 7: Quizzes, certificates, reviews and Q&A

**Files:**
- Create: `src/features/learn/{quiz-view.tsx,quiz-result.tsx,qa-thread.tsx,ask-question.tsx}`, `src/features/certificates/{index.ts,queries.ts,certificate-card.tsx,name-dialog.tsx}`, `src/features/reviews/{index.ts,review-form.tsx}`, `src/app/(member)/(shell)/settings/certificates/page.tsx`, `src/app/(public)/certificates/[code]/page.tsx`
- Test: `quiz-view.test.tsx`, `name-dialog.test.tsx`, `review-form.test.tsx`, `src/app/(public)/certificates/[code]/page.test.tsx`

**Interfaces:**
- Consumes: `api`, `<Markdown>` (Q&A and reviews are plain text: render as text, not Markdown), `RatingStars`, `publicFetch`.
- Produces: `ReviewForm({slug})` mounted on the course page for enrolled learners.

- [ ] **Step 1: Write failing tests**

Quiz: submit disabled until every question has an answer; shows score and pass state from the API; correct answers only when the API includes them. Name dialog: confirms the name is final before sending. Review form: rating 1–5 required, body ≤ 2000. Verify page: valid shows learner, course, issuer, date; revoked shows "Revoked"; unknown is a 404; metadata `noindex` for revoked.

- [ ] **Step 2: Run, confirm failure, implement, run again**

Certificate PDF download fetches the 5-minute link on click. Author answers are marked. Plain-text user content keeps line breaks and is never parsed as HTML.

- [ ] **Step 3: Commit** `feat: quizzes, certificates, reviews and course Q&A`

---

### Task 8: End-to-end flows

**Files:**
- Create: `e2e/support/fake-razorpay.ts`, `e2e/support/seed-course.ts`, `e2e/courses.spec.ts`, `e2e/checkout.spec.ts`, `e2e/learn.spec.ts`
- Modify: `e2e/support/stack.ts` (`RAZORPAY_BASE_URL`, `SSR_SHARED_SECRET` on both sides), `e2e/a11y.spec.ts`

**Interfaces:**
- Produces: `seedPublishedCourse({ price: string, lessons: ("article" | "quiz")[], freePreview?: number }): Promise<{ slug, id, creatorEmail }>` through real API calls (creator builds and submits; seeded super admin approves with step-up); `fakeRazorpay` that creates orders, and a route that stubs `checkout.js` in the browser to complete payment with a valid signature (HMAC-SHA256 of `order_id|payment_id` with the test key secret), or to dismiss.

- [ ] **Step 1: Write the flows**, each at 375 × 812 and 1280 × 800:

```ts
test("visitor searches, opens a course, signs in and buys it")
test("double tap on Pay creates one order")
test("dismissing Razorpay then paying again enrols once")
test("verify returning 202 shows confirming, then Orders shows paid")
test("free course enrols without checkout")
test("learner reads an article, passes the quiz, names and verifies the certificate signed out")
test("refund within 7 days removes access and revokes the certificate")
test("free-preview lesson opens signed out; other lessons need enrolment")
test("flagged course page is a 404 and leaves the catalog")
test("catalog filters survive reload and Load more adds no duplicates")
test("review and Q&A post as plain text")
```

Make the fake capture-late path return "created but not captured" so verify answers 202, then capture.
`a11y.spec.ts` adds catalog, course page, checkout sheet, lesson page and certificate page, light and dark.

- [ ] **Step 2: Run** `pnpm e2e`. Fix the app, not the test, unless the test is wrong.

- [ ] **Step 3: Final verification**

Web: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm api:check && E2E_BUILD_BACKEND=1 pnpm e2e`. Backend, if changed in this task: affected specs, typecheck, lint, `pnpm openapi:check-responses`.

- [ ] **Step 4: Commit** `test: end-to-end course, checkout and learning flows`

## Exit check

- [ ] A signed-out visitor finds a course on a phone, signs in, pays through the fake Razorpay once, and lands in the first lesson.
- [ ] A learner finishes article and quiz lessons and gets a certificate anyone can verify.
- [ ] A refunded learner loses access and the certificate shows revoked.
- [ ] Backend CI is green on GitHub and the untyped ceiling went down.
