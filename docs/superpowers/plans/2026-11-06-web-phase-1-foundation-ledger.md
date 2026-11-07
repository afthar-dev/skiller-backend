# SDD ledger — plan: docs/superpowers/plans/2026-11-06-web-phase-1-foundation.md
Process: Ruling (user): Sonnet implementers, no per-task reviews, one Opus final review, one fix wave, no dispatched re-review.
Preflight scan:
| Pair/Task | Shared | Finding |
|---|---|---|
| T1→T8 | RESEND_BASE_URL, openapi | consistent |
| T1→T2 | openapi.json → contract copy | T2 text says api:generate reads backend, CI needs no backend: see ruling |
| T2→T3 | schema.gen, env | consistent |
| T3→T4 | refresh, setStepUpHandler, onSessionLost | consistent |
| T2→T5 | app/layout.tsx | T5 lists "Create" but scaffold makes it: T5 modifies |
| T4→T5 | useSession, RequireAuth, (member) route group | onboarding page precedes member layout: onboarding sits outside bottom nav |
| T5→T6/7 | shell, page states | consistent |
| T3,T4→T8 | latestCode, flows | consistent |
| T1 self | test:scripts only runs drift spec | must extend script list (package.json listed) |
| T2..T8 self | consistent | none |
Preflight: Ruling (controller): api:generate copies OPENAPI_PATH or ../skiller-backend/openapi.json to contract/openapi.json then generates; api:check compares schema.gen.ts against contract/openapi.json only — keeps CI backend-free — cost if wrong: contract copy stale until api:generate is run
Preflight: Ruling (controller): T5 modifies scaffold's root layout; onboarding gets its own minimal layout — cost if wrong: none
Task 1: complete (commits 3f7bb44..6cf58c2; full suite 1357 green after last edit; allowlist 180)
Task 1: Ruling (controller): profileViewSchema required list widened in Task 6 (small backend commit + regenerate) so generated profile fields are not optional; other shape inconsistencies (id vs userId, block 200 vs follow 204, step-up wrong code 400) stay, client handles them — cost if wrong: small adapter code
Task 2: complete (web 0aa8be3; Next 16.4.5, React 19.3.0)
Task 3: complete (web 054e932; 30 unit tests, typecheck, lint, build, api:check green)
Task 3: Ruling (controller): turn off cacheComponents and partialPrefetching in next.config.ts — streamed shells can turn notFound() into status 200, and spec needs real 404s — cost if wrong: lose partial prerender speed, can re-enable later
Task 3: Ruling (controller): ErrorState uses friendlyMessage, done in Task 4 — cost if wrong: none
Task 4: complete (web 7eb7f66; fixed client 401 on otp routes)
Task 5: complete (web 429cfbf; 59 unit tests; shell in nested (member)/(shell) group)
Task 5: Ruling (controller): phone bottom nav stays five items for everyone; Studio lives in sidebar and user menu — plan decision 3 lists five, six crowds a 375 px bar — cost if wrong: creators one tap further from Studio
Task 6: complete (web fe5f0e0, backend ecc0d1f)
Task 7: complete (web a18e2c2; 106 unit tests)
Task 7: Ruling (controller): no mandatory notification lock — API has no such field and OTP mail is not a preference, so nothing security-critical can be switched off — cost if wrong: member can mute a payout alert
Task 7: Ruling (controller): profile links editing and allowMessagesFrom setting deferred to phase 5 (messaging); follower count must update live, fixed in Task 8 — cost if wrong: none
Task 8: complete (web d440677..87db1f7; 109 unit, 34 Playwright at both sizes; 4 web bugs fixed; backend unchanged)
Task 8: Ruling (implementer): step-up e2e hook gated by build flag NEXT_PUBLIC_E2E_HOOKS=1, folded out of normal builds — cost if wrong: test hook shipped if flag set in production
Task 8: note: one unreproduced flake, second sign-in mail for same email never arrived once — point final review at it
Final review: Opus (only review) — merge with fixes; 1 Critical, 10 Important, 13 minors; auth core held up
Final: Ruling (controller): C1 — getByHandle returns 404 for suspended and deleted accounts — cost if wrong: none
Final: Ruling (controller): I1 — refreshed retry goes through the same step-up handling; I2 — unwrap throws on any non-2xx, empty body included; I4 — RequireAuth redirects on every signed-out render, no stuck spinner — cost if wrong: none
Final: Ruling (controller): I3 — failed logout keeps the user signed in and shows a retryable error, since the 30-day cookie survives otherwise — cost if wrong: offline user can't sign out until back online
Final: Ruling (controller): I5 — friendly copy for OTP_EXPIRED and OTP_LOCKED, step-up dialog gets resend — cost if wrong: none
Final: Ruling (controller): I6 — remove automatic Idempotency-Key; callers pass an explicit per-attempt key, server rejection stays the net — cost if wrong: none
Final: Ruling (controller): I7 — now: publicFetch gets revalidate (default 60 s) and 5 s timeout; hidden content can stay visible up to 60 s. Trusted server identity for rate limits goes in the Phase 2 plan before catalog pages — cost if wrong: launch traffic 429s if Phase 2 skips it
Final: Ruling (controller): I8 — darken/lighten error and link text to AA, axe in dark mode and with a visible form error; I9 — replace stub flows with real ones — cost if wrong: none
Final: Ruling (controller): I10 — check-responses in CI, allowlist has a committed ceiling that only falls, typed means a schema with properties, items or $ref — cost if wrong: none
Final: Ruling (controller): mail flake — fix latestCode race in test helper; add a timeout to the Resend call because a hung send blocks OTP mail at concurrency 1 — cost if wrong: none
Final: fixed C1, I1–I10 and mail-flake ruling (backend cf6af33..e20f754, web 946c44a..83bc899); backend full suite 1363 green after last edit; web 135 unit + 48 e2e green; allowlist 180 with ceiling
Final: found and fixed in passing — worker modules building ProfilesService lacked UserStatusCache (real worker would fail at boot); campaigns skip test raced queue when run first
Final: Ruling (implementer): gigs, reels, messaging, unblock and unmute look up handles with getByHandleAnyStatus so their own visibility rules apply — cost if wrong: suspended handle answers with an empty list instead of 404 there
Final: open — second sign-in mail missed 20 s in 2 of 8 e2e runs; wait raised to 40 s; suspected single mail worker cold start; investigate with mail queue logs before launch
Final: deferred review minors (13, minus step-up cancel reset fixed); trusted server identity for public fetches goes in Phase 2 plan
