# SDD ledger — plan: docs/superpowers/plans/2026-11-08-web-phase-2-courses.md
Process: Ruling (user): Sonnet implementers, no per-task reviews, one Opus final review, one fix wave, no dispatched re-review.
Preflight scan:
| Pair/Task | Shared | Finding |
|---|---|---|
| T1→T3,T8 | SSR_SHARED_SECRET, RAZORPAY_BASE_URL | consistent |
| T2→T3..T7 | typed contract | consistent; web regenerates in T3 |
| T3→T4..T7 | formatPaise, Markdown, publicFetch | consistent |
| T4→T5 | CourseCta slot on course page | T5 owns CourseCta, T4 leaves a slot: consistent |
| T5→T6 | success page links first lesson | uses firstIncomplete from T6: T5 links /learn/<slug>, which resumes |
| T6→T7 | learn feature files shared | T7 adds files in features/learn: same feature, ok |
| T7→T4 | ReviewForm on course page | course page is public SSR; ReviewForm client island: ok |
| T8 self | seedPublishedCourse needs step-up for approve? | confirm in T8 |
Preflight: Ruling (controller): T5 success page links /learn/<slug> (which resumes via firstIncomplete) so T5 does not depend on T6 code — cost if wrong: none
Task 1: complete (9830a33..bc228ad; CI root cause: entitlements read on global pool inside interactive tx starved the pool, 500 P2024 — real production bug)
Task 2: complete (29b9d36; untyped ceiling 180 -> 154; live responses validated against openapi.json; full suite 1370 green)
Task 1: Ruling (controller): audit every call that uses the global Prisma client inside an interactive transaction (assertPublishable first) and fix the same way, as a separate backend task now, in parallel with web work — cost if wrong: pool starvation under load at launch
Task 3: complete (web 6bd96be)
Task 4: complete (web 50bfe18; 170 unit tests; screenshots in shots/)
Task 4: Ruling (controller): server-only reads live in @/features/<x>/server, exempt from the index.ts rule — server-only modules can't share a client barrel — cost if wrong: none
Task 4: Ruling (controller): category pages move to /categories/<slug> so no course slug can be shadowed — done in Task 5 dispatch — cost if wrong: none
Task 4: Ruling (controller): course cards need real thumbnails: backend adds public thumbnailUrl to course list and detail after the pool audit lands (same repo) — cost if wrong: placeholder images at launch
Pool audit: complete (e7d71af..ea10024; 9 real pool-starvation bugs fixed incl. checkout, payouts, refunds, subscriptions; 22 pool specs at connection_limit=3; full suite 1392 green)
Pool audit: Ruling (controller): CampaignSender.start left as is — worker tick, retries next tick, fixing means reworking segment providers and crash safety — cost if wrong: delayed campaign start under a tiny pool
Task 5: complete (web 9a80be1..43633f5; 221 unit tests; checkout e2e comes in Task 8)
Task 5: Ruling (implementer): Idempotency-Key kept after network error or 5xx, replaced after other 4xx or coupon change — server replays stored 4xx — cost if wrong: none
Task 5: Ruling (controller): pass Razorpay `amount` as an integer number converted from the paise string at the Razorpay boundary only (exact below 2^53) — checkout.js documents an integer — cost if wrong: none
Task 5: Ruling (controller): backend adds refund state to Order responses so "Refund requested" survives reload; done with thumbnailUrl in one backend task — cost if wrong: none
Task 6: complete (web 53af4d4; Razorpay amount fix b37468f)
Task 7: complete (web 6742b54; 300 unit tests)
Task 7: Ruling (controller): free-preview lessons must open signed out (spec: visitor discovery); backend makes GET /v1/learn/lessons/:id and GET /v1/media/:id/playback optional-auth for free-preview lessons only, everything else unchanged — cost if wrong: anonymous viewers can stream preview videos (intended)
Task 7: Ruling (controller): posting a review expires the course page cache tag at once, as profile edits do; markdown renderer drops leftover text of rejected links — both in Task 8 — cost if wrong: none
Backend fields: complete (0be358e thumbnailUrl 1024 px webp, b431517 order refund); targeted e2e green; FULL SUITE NOT RUN — Docker engine down, needs user restart; run before merge
Backend fields: helper's attempt to kill Docker / wsl --shutdown was denied by permissions; controller will not retry it — user restarts Docker
Web follow-ups: complete (3ed0b4b..; thumbnails via plain img, order refund state, review cache expiry, rejected-link text, require-auth flake fix reasoned not reproduced; 314 unit tests, 3 green runs)
Preview: complete (624461b, f41b527; full suite 1420/1421 then stale test fixed, re-run green; edge 76)
Preview: note for final review — visitor playback tokens carry u:"anonymous"; check nothing assumes u is a user id
Task 8: complete (web e2e 86 green, 319 unit; 3 web bugs fixed; backend unchanged)
Final review: Opus — merge with fixes; 0 Critical, 1 Important (FAILED status during polling re-enables Pay; second charge possible), 9 minors; pool fixes, trusted identity, optional auth, anonymous tokens, markdown, secret all sound
Final: Ruling (controller): fix I1 as reviewer suggests (after payment proof, FAILED/EXPIRED = not yet, keep verifying to 60 s, never re-enable Pay); fix payment/refund minors in same wave; other minors deferred — cost if wrong: none
Final: fixed I1, M1, M2, M4, M9 (web 98b10de..253772e, backend b42f81e); 326 unit; e2e best 87/88
Final: open — learn.spec flow fails 4 of 5 full runs: course page Enrol button stuck "Loading" after sign-in and reload under load; passes alone. Possible real session-restore bug on the main conversion path
Final: Ruling (controller): one capped investigation of the stuck Enrol button before merge, since it sits on the buying path — cost if wrong: one extra helper run
Final: Ruling (user): finish Phase 2 now — merged and pushed while the stuck-Enrol investigation continues on phase-2-courses; its fix merges after
Final: stuck Enrol fixed (web 141ed04): failed session restore left CourseCta and PreviewLesson on Loading forever; now error with retry. Test helper waited too little for refresh rotation
Final: open — second sign-in for the same email sometimes gets no code (2 of 3 full e2e runs, one flow each); same issue as Phase 1, cause unproven
Final: open — backend: a refresh rotation whose Set-Cookie is lost (navigation mid-request) answers 409 for 10 s, then token reuse revokes the whole session family; user is signed out. Review before launch
Final: open — FollowButton has the same stuck-loading gap on failed restore
