# Web Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `skiller-web` app where a person signs in by email code, stays signed in, edits their profile, manages settings, and views public profiles, on a typed API client, on phone and desktop.

**Architecture:** Next.js App Router app in its own repo. Public pages render on the server with public data only; signed-in pages are client-rendered through TanStack Query. A typed client generated from the backend contract handles tokens, single-flight refresh, step-up and error mapping in one place.

**Tech Stack:** Node 24, pnpm 10.17.1, current stable Next.js and React (exact versions pinned by the lockfile), strict TypeScript, Tailwind CSS 4, shadcn/ui, openapi-typescript, openapi-fetch, TanStack Query 5, react-hook-form, zod, Vitest, Testing Library, Playwright, @axe-core/playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-skiller-web-frontend-design.md`

## Global Constraints

- New repo: `D:\skiller\skiller-web`. Never modify `D:\skiller\skiller-frontend`; read it only to copy the logo and brand values.
- Backend changes go on backend branch `web-phase-1` with tests, an `openapi.json` update, and the backend's own lint, typecheck and test rules.
- Access token in memory only; never `localStorage` or `sessionStorage`. All API requests use `credentials: "include"`.
- Server components fetch public data only and never forward cookies.
- Every data view uses `Loading`, `Empty`, `ErrorState` or `NoAccess`. No blank screens. A 403 never signs the user out.
- Brand: primary `#B91C1C` (`0 74% 42%`), radius `0.75rem`, display font Cabinet Grotesk, body font Satoshi, both self-hosted with `next/font/local`. Light and dark themes copied from `skiller-frontend/src/index.css`.
- Member screens designed at 375 px first. Keyboard reachable, visible focus, labelled inputs, AA contrast.
- A feature imports another feature only through its `index.ts` (ESLint `no-restricted-imports`).
- Avatars and banners show initials or a colour block in this phase. Image upload comes with the upload engine in phase 3.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions taken for this plan (change any you disagree with)

1. **Web address in development:** `http://localhost:3000`, API `http://localhost:4000`, `COOKIE_DOMAIN=localhost`, backend `NODE_ENV=development` so the cookie isn't `Secure`.
2. **E2E mail:** backend gains optional `RESEND_BASE_URL`, refused in production. Playwright runs a small fake Resend server and reads codes from it.
3. **Bottom navigation on phones:** Home, Courses, Reels, Messages, Profile. Sections from later phases link to a neutral "arrives soon" page until built, and are removed from the list if cut.
4. **New users:** after first sign-in (`isNew: true`) go to a short onboarding form for display name and handle, then Home.
5. **Sign-in return:** `?next=` accepts same-origin relative paths only.

## Review Focus

1. **Refresh storm:** many parallel 401s and two tabs at once. Expected: one refresh per tab, each request retried once, no sign-out from `REFRESH_RACE`. Test in Task 3.
2. **Open redirect:** `?next=https://evil.example` or `//evil.example` after sign-in. Expected: falls back to `/home`. Test in Task 4.
3. **Session gone mid-use:** session revoked on another device while the app is open. Expected: one clean redirect to sign-in with a message, no loop. Test in Task 3.
4. **OTP edge cases:** wrong code, expired code, resend while rate limited, paste of a 6-digit code. Expected: clear message each time, paste fills all boxes. Test in Task 4.
5. **Hidden profile:** unknown, suspended or blocked profile on the server-rendered page. Expected: real 404 status, no details leaked. Test in Task 6.

---

### Task 1: Backend contract for Phase 1

Backend repo, branch `web-phase-1` from `main` after `frontend-spec` is merged.

**Files:**
- Create: `scripts/check-openapi-responses.mjs`, `scripts/openapi-untyped-allowlist.json`
- Modify: `src/modules/identity/auth.controller.ts`, the controllers serving `/v1/me/*` lists, profiles, follows, blocks, mutes and notification preferences, `src/modules/mail/mail.module.ts`, `src/common/config/config.schema.ts`, `.env.example`, `README.md`, `openapi.json`, `package.json`
- Test: existing e2e specs for those routes; `src/common/config/config.schema.spec.ts`; `pnpm test:scripts` entry for the new script

**Interfaces:**
- Produces: response schemas in `openapi.json` for these operations: `POST /v1/auth/step-up/verify`, `GET /v1/auth/sessions`, `POST /v1/auth/sessions/revoke-others`, `PUT /v1/me/experience|education|skills|portfolio`, `GET /v1/profiles/{handle}`, `POST|DELETE /v1/profiles/{handle}/follow`, `GET /v1/profiles/{handle}/followers|following`, `PUT|DELETE /v1/blocks/{handle}`, `PUT|DELETE /v1/mutes/{handle}`, `GET /v1/me/blocks|mutes`, `GET|PUT /v1/me/notification-preferences`. `POST /v1/auth/logout` and `DELETE /v1/auth/sessions/{id}` declare 204 if that is what they return.
- Produces: env `RESEND_BASE_URL` (optional).

- [ ] **Step 1: Write failing tests**

Config: `RESEND_BASE_URL` set with `NODE_ENV=production` gives a `ConfigError`; with `development` it is accepted and reaches `config.resend.baseUrl`.
Script: a contract with one untyped operation outside the allowlist exits 1 naming it; an allowlist entry that is now typed also exits 1 (the list may only shrink).
Each listed route: extend its existing e2e spec to assert the real response matches the declared fields (`toMatchObject` on required keys), so schemas can't lie.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm test -- config.schema` and `pnpm test:scripts`
Expected: FAIL on the missing option and missing script.

- [ ] **Step 3: Implement**

Add `ApiJsonResponse` declarations using the existing helpers in `src/common/openapi/responses`. Declare what the handlers really return; don't change behaviour. Pass `config.resend.baseUrl` as `HttpResendClient`'s third argument. Add `"openapi:check-responses": "node scripts/check-openapi-responses.mjs"`. An operation counts as typed when a 2xx response has a non-empty JSON schema or is 204. Seed the allowlist with every remaining untyped operation.

- [ ] **Step 4: Verify**

Run: `pnpm openapi:export`, `pnpm openapi:check-responses`, typecheck, lint, then the full suite.
Expected: all green; allowlist has at most 180 entries.

- [ ] **Step 5: Commit**

`feat: typed responses for phase 1 routes and an allowlist that can only shrink`

---

### Task 2: Repo, tokens and page states

**Files:**
- Create: `D:\skiller\skiller-web` (Next.js scaffold, `src/` layout), `.nvmrc`, `.github/workflows/ci.yml`, `eslint.config.mjs`, `vitest.config.ts`, `src/app/globals.css`, `src/app/fonts/*`, `public/logo.svg`, `src/components/ui/*` (button, input, label, dialog, dropdown-menu, sheet, tabs, switch, skeleton, sonner, avatar, input-otp, form), `src/components/logo.tsx`, `src/components/page-states.tsx`, `src/lib/env.ts`, `scripts/api-generate.mjs`, `src/lib/api/schema.gen.ts`, `README.md`
- Test: `src/components/page-states.test.tsx`, `src/lib/env.test.ts`

**Interfaces:**
- Produces: `Loading({label?})`, `Empty({title, hint?, action?})`, `ErrorState({error, onRetry?})`, `NoAccess()`.
- Produces: `env.apiUrl`, `env.siteUrl`, read from `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`; missing values throw at start-up.
- Produces: `pnpm api:generate` (reads `../skiller-backend/openapi.json` or `OPENAPI_PATH`), `pnpm api:check` (regenerates to memory, fails on any difference from `schema.gen.ts`).

- [ ] **Step 1: Scaffold and copy brand**

Create the app, init git, add shadcn, map tokens from `skiller-frontend/src/index.css`, copy the logo from `Logo.jsx` to SVG, download Cabinet Grotesk and Satoshi woff2 from Fontshare into `src/app/fonts`.

- [ ] **Step 2: Write failing tests**

`ErrorState` shows the friendly message and `requestId`, and its Retry button calls `onRetry`. `Loading` has `role="status"`. `env` throws naming the missing variable.

- [ ] **Step 3: Run, confirm failure, implement, run again**

Run: `pnpm vitest run`
Expected: FAIL, then PASS.

- [ ] **Step 4: Add boundary rule and CI**

ESLint: `no-restricted-imports` blocks `@/features/*/*` from outside that feature. CI runs `typecheck`, `lint`, `test`, `build`. Add `api:check` to CI by committing a copy of the contract as `contract/openapi.json`, refreshed by `api:generate`, so CI doesn't need the backend repo.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm api:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

`chore: next app, brand tokens, page states and typed contract`

---

### Task 3: API client

**Files:**
- Create: `src/lib/api/client.ts`, `src/lib/api/token.ts`, `src/lib/api/refresh.ts`, `src/lib/api/errors.ts`, `src/lib/api/server.ts`, `src/lib/api/query-client.ts`, `src/lib/api/index.ts`
- Test: `src/lib/api/refresh.test.ts`, `src/lib/api/errors.test.ts`, `src/lib/api/client.test.ts`

**Interfaces:**
- Produces: `api` (openapi-fetch client with `credentials: "include"`), `getAccessToken()`, `setAccessToken(token | null)`.
- Produces: `refreshSession(): Promise<string | null>`, single-flight; null means the session is gone.
- Produces: `class ApiError extends Error { status; code; details; requestId }`, `unwrap<T>(result): T` throwing `ApiError`.
- Produces: `friendlyMessage(error: unknown): string`, `fieldErrors(error: unknown): Record<string, string>`.
- Produces: `onSessionLost(cb)`, `setStepUpHandler(handler: () => Promise<boolean>)`.
- Produces: `publicFetch<T>(path, init?)` for server components: no cookies, no token, `null` on 404.

- [ ] **Step 1: Write failing tests** (mock `fetch`)

```ts
it("sends one refresh for five parallel 401s and retries each once")
it("retries the refresh on REFRESH_RACE and does not sign out")
it("signs out once when refresh returns 401 and does not loop")
it("does not refresh or sign out on 403")
it("on STEP_UP_REQUIRED calls the handler and repeats the request with the same Idempotency-Key")
it("does not repeat the request when the step-up handler returns false")
it("maps VALIDATION_FAILED details.fields to field errors")
it("falls back to a generic message containing requestId for an unknown code")
it("publicFetch sends no credentials and returns null on 404")
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run src/lib/api`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

Add openapi-fetch middleware. `REFRESH_RACE` waits 300 ms and retries at most twice. A retried request is sent at most once. Error body: `{ error: { code, message, details }, requestId }`. Query client: no retry on 4xx, one retry on network errors and 5xx.

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

`feat: typed api client with single-flight refresh and error mapping`

---

### Task 4: Sign-in, session and onboarding

**Files:**
- Create: `src/features/auth/index.ts`, `auth-provider.tsx`, `use-session.ts`, `require-auth.tsx`, `safe-next.ts`, `sign-in-form.tsx`, `code-form.tsx`, `src/app/(auth)/sign-in/page.tsx`, `src/app/(auth)/sign-in/code/page.tsx`, `src/app/(member)/onboarding/page.tsx`, `src/features/auth/step-up-dialog.tsx`
- Test: `safe-next.test.ts`, `code-form.test.tsx`, `auth-provider.test.tsx`, `step-up-dialog.test.tsx`

**Interfaces:**
- Consumes: `api`, `refreshSession`, `setAccessToken`, `onSessionLost`, `setStepUpHandler`.
- Produces: `useSession(): { status: "loading" | "signedIn" | "signedOut"; me: Me | null; can(permission: string): boolean; signOut(): Promise<void> }`, where `Me` is the generated `GET /v1/me` body.
- Produces: `<RequireAuth>` client gate redirecting to `/sign-in?next=<path>`.
- Produces: `safeNext(value: string | null): string`.

- [ ] **Step 1: Write failing tests**

```ts
expect(safeNext("/learning?x=1")).toBe("/learning?x=1");
expect(safeNext("https://evil.example")).toBe("/home");
expect(safeNext("//evil.example")).toBe("/home");
expect(safeNext("/\\evil.example")).toBe("/home");
expect(safeNext(null)).toBe("/home");
```

Code form: pasting `123456` fills all boxes and submits; a wrong-code error clears the boxes and focuses the first; Resend is disabled for 30 s, and a rate-limit error shows the friendly message.
Provider: on load calls refresh then `GET /v1/me`; a `BroadcastChannel` `signed-out` message signs this tab out; a lost session redirects once with message "You were signed out".
Step-up dialog: requests a code, verifies, resolves `true`; cancel resolves `false`.

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run src/features/auth`
Expected: FAIL.

- [ ] **Step 3: Implement**

`challengeId` travels in component state or router state, never in the URL. The code page sends users without one back to sign-in. `isNew` goes to `/onboarding` (`PATCH /v1/me/profile` with `displayName`, `handle`), otherwise `safeNext`. Handle collisions show as a field error.

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

`feat: email code sign-in, session restore, onboarding and step-up`

---

### Task 5: App shell and design pass

**Files:**
- Create: `src/app/layout.tsx`, `src/app/not-found.tsx`, `src/app/error.tsx`, `src/app/(public)/layout.tsx`, `src/app/(public)/page.tsx`, `src/app/(member)/layout.tsx`, `src/app/(member)/home/page.tsx`, `src/app/(member)/soon/page.tsx`, `src/components/shell/public-header.tsx`, `member-sidebar.tsx`, `bottom-nav.tsx`, `user-menu.tsx`, `theme-toggle.tsx`, `src/components/shell/nav-items.ts`
- Test: `src/components/shell/nav-items.test.ts`, `bottom-nav.test.tsx`

**Interfaces:**
- Consumes: `useSession`.
- Produces: `navItems(me): NavItem[]`, `type NavItem = { label; href; icon; permission? }`. Admin entry only with an `admin`-area permission; Studio entry only for `profile.isCreator`.

- [ ] **Step 1: Write failing tests**

Bottom nav shows the five decided items in order and marks the current route with `aria-current="page"`. Creator sees Studio; non-creator doesn't. Member without admin permissions sees no Admin.

- [ ] **Step 2: Run, confirm failure, implement, run again**

Run: `pnpm vitest run src/components/shell`
Expected: FAIL, then PASS.

Phone: top bar plus bottom nav respecting safe-area insets. Desktop (1024 px and up): left sidebar. Landing: hero, value for learners, creators and sellers, sign-in call to action, with metadata. Use the `anthropic-skills:impeccable` skill for this visual pass; avoid generic template layouts.

- [ ] **Step 3: Verify visually**

Start the app, screenshot landing, home and a 404 at 375 px and 1280 px in light and dark. Confirm no horizontal scroll. Save the screenshots in the task report.

- [ ] **Step 4: Commit**

`feat: app shell, navigation and landing`

---

### Task 6: Profiles

**Files:**
- Create: `src/features/profile/index.ts`, `queries.ts`, `schemas.ts`, `profile-header.tsx`, `follow-button.tsx`, `edit-basics-form.tsx`, `edit-list-form.tsx`, `src/app/(public)/u/[handle]/page.tsx`, `src/app/(member)/settings/profile/page.tsx`, `src/app/(public)/u/[handle]/followers/page.tsx`, `src/app/(public)/u/[handle]/following/page.tsx`
- Test: `schemas.test.ts`, `follow-button.test.tsx`, `src/app/(public)/u/[handle]/page.test.tsx`

**Interfaces:**
- Consumes: `publicFetch`, `api`, `useSession`, `fieldErrors`.
- Produces: `useMe()`, `useUpdateProfile()`, `useReplaceSection(section: "experience" | "education" | "skills" | "portfolio")`, `FollowButton({handle})`.

- [ ] **Step 1: Write failing tests**

Schemas mirror the API limits: `displayName` 1–80, `headline` ≤ 120, `about` ≤ 5000, `location` ≤ 80, skills ≤ 50 items of ≤ 40 chars, portfolio ≤ 30 items, experience title and company ≤ 120 with `startDate` required, `endDate` not before `startDate`.
Profile page: `publicFetch` null calls `notFound()`; output never contains the owner's email or `allowMessagesFrom`; `generateMetadata` sets title and canonical `/u/<handle>`.
Follow button: optimistic toggle, rolls back and shows a message on error; signed-out click goes to sign-in with `next`.

- [ ] **Step 2: Run, confirm failure, implement, run again**

Run: `pnpm vitest run src/features/profile "src/app/(public)/u"`
Expected: FAIL, then PASS.

Profile tabs for courses, reels and gigs appear only as later phases land them; this phase shows about, experience, education, skills and portfolio. Lists save with the matching `PUT` replacing the whole list. Add JSON-LD `ProfilePage`.

- [ ] **Step 3: Commit**

`feat: public profiles and profile editing`

---

### Task 7: Settings

**Files:**
- Create: `src/features/settings/index.ts`, `queries.ts`, `sessions-list.tsx`, `notification-preferences.tsx`, `blocked-list.tsx`, `muted-list.tsx`, `become-creator.tsx`, `src/app/(member)/settings/layout.tsx`, `page.tsx`, `sessions/page.tsx`, `notifications/page.tsx`, `privacy/page.tsx`, `creator/page.tsx`
- Test: `sessions-list.test.tsx`, `notification-preferences.test.tsx`, `become-creator.test.tsx`

**Interfaces:**
- Consumes: `api`, `useSession`, page states.
- Produces: nothing used by later tasks except the `/settings` routes.

- [ ] **Step 1: Write failing tests**

Sessions: marks the current session and revoking it signs out; "Sign out other devices" calls `revoke-others` and refreshes the list. Notification preferences: toggle saves through `PUT`, reverts on error; security types such as sign-in codes can't be switched off if the API marks them mandatory. Become creator: button disabled until terms are ticked; success refreshes `me` and Studio appears.
Blocks and mutes: unblock removes the row; empty lists use `Empty`. Promo email appears as one more preference, using the `marketing_opt_in` type from the API.

- [ ] **Step 2: Run, confirm failure, implement, run again**

Run: `pnpm vitest run src/features/settings`
Expected: FAIL, then PASS.

- [ ] **Step 3: Commit**

`feat: sessions, notification, privacy and creator settings`

---

### Task 8: End-to-end flows and docs

**Files:**
- Create: `playwright.config.ts`, `docker-compose.e2e.yml`, `e2e/support/stack.ts`, `e2e/support/fake-resend.ts`, `e2e/support/mail.ts`, `e2e/auth.spec.ts`, `e2e/profile.spec.ts`, `e2e/settings.spec.ts`, `e2e/a11y.spec.ts`
- Modify: `README.md`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: backend `RESEND_BASE_URL`; `OPENAPI_PATH`.
- Produces: `latestCode(email: string): Promise<string>`, `uniqueEmail(): string`, reused by every later phase.

- [ ] **Step 1: Build the stack**

`docker-compose.e2e.yml`: Postgres 16, Redis 7 with `noeviction`, MinIO. `stack.ts`: starts fake Resend, migrates and seeds, starts backend API and worker from `BACKEND_DIR` (default `../skiller-backend`) with `NODE_ENV=development`, `COOKIE_DOMAIN=localhost`, `CORS_ORIGINS=http://localhost:3000`, `RESEND_BASE_URL`, then builds and starts the web app. Each test uses `uniqueEmail()`, because the API allows 5 codes per email per 15 minutes.

- [ ] **Step 2: Write the flows**

Run each at 375 × 812 and 1280 × 800.

```ts
test("new user signs in, onboards, and stays signed in after reload")
test("wrong code shows a message, then the right code works")
test("signing out in one tab signs out the other")
test("session revoked on another device redirects once to sign-in")
test("?next=https://evil.example lands on /home")
test("edit profile and see it on the public page signed out")
test("unknown handle returns status 404")
test("follow then unfollow updates the count")
test("become creator shows Studio")
test("step-up dialog completes a protected action and repeats it")
```

Use a protected action the seeded super admin can reach through the API from the test page, because admin screens arrive in phase 6.

`a11y.spec.ts`: axe finds no serious or critical issues on landing, sign-in, profile, settings.

- [ ] **Step 3: Run**

Run: `pnpm e2e`
Expected: all pass in both sizes. Fix the app, not the test, unless the test is wrong.

- [ ] **Step 4: Docs and CI**

README: setup, scripts, env, how to run e2e. CI runs Vitest and the build always; e2e runs once both repos have remotes.

- [ ] **Step 5: Final verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm api:check && pnpm e2e`
Expected: all exit 0.

- [ ] **Step 6: Commit**

`test: end-to-end auth, profile and settings flows`

## Exit check

- [ ] New user signs in by email code on a phone-sized screen, finishes onboarding, reloads, and stays signed in.
- [ ] Public profile is server-rendered, editable by its owner, and returns a real 404 when hidden.
- [ ] Sessions, notification, block, mute and creator settings work.
- [ ] Backend untyped allowlist shrank and cannot grow.
