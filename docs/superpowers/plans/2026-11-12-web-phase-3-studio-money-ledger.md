# SDD ledger — plan: docs/superpowers/plans/2026-11-12-web-phase-3-studio-money.md
Process: Ruling (user): Sonnet implementers, no per-task reviews, one Opus final review, one fix wave. Short updates only.
Preflight: tasks share no files across repos; T1 (backend) runs parallel to T2-T3 (web); T5 depends on T3 UploadField; T8 needs T1 schemas regenerated — consistent
Task 2: complete (web 85812c6)
Task 3: complete (web b2658d3; 361 unit)
Task 3: Ruling (controller): part ETags in sessionStorage accepted (needed by /complete, no URLs) — cost if wrong: none
Task 3: Ruling (controller): backend adds an abort route for pending uploads so cancel frees the 10-pending cap; batched after Task 1 — cost if wrong: cancelled uploads block new ones until expiry
Task 1: complete (dc3f06e, 4f92f15, 0d53d25; missing code root cause: BullMQ auto job ids reused after counter reset collided with Resend 24 h idempotency keys; refresh grace 10 s sealed in Redis; ceiling 154 -> 119); full suite running, log C:\Users\aftha\AppData\Local\Temp\full-suite.log
Task 1: note for final review — refresh grace lets a holder of the just-rotated token get the current one for 10 s (trade-off accepted, like Auth0 reuse interval); new schemas not checked against live responses
Task 1 extras: 16eb438 plan test isolation, 31bf942 upload abort route; second full suite log C:\Users\aftha\AppData\Local\Temp\full2.log — verify before merge
Task 4: complete (web 2daa921); Task 5: complete (web d39031c; 445 unit)
Task 4: Ruling (controller): backend adds avatarUrl and bannerUrl to profile views and summaries (others' profiles show initials until then), after full2 finishes — cost if wrong: no public avatars
Task 1: full suite 1429/1429 green after 31bf942
Task 4 backend: avatarUrl/bannerUrl (5abfaca, 2d80630); full3 log C:\Users\aftha\AppData\Local\Temp\full3.log — profiles int-spec may fail if reached before 2d80630; rerun alone
Task 4 backend: note for final review — MediaService and ProfilesService now inject each other via forwardRef (module cycle)
Task 6: complete (web 89b63d4); Task 7: complete (web 33ac6be; 533 unit)
Task 7: Ruling (controller): Monthly to Yearly stays a scheduled switch at period end (backend behaviour); UI copy must say "Switch to yearly at the end of this period" not "Switch to Pro" — cost if wrong: creators wait a period for yearly
Task 7: Ruling (controller): backend exposes the payout account review flag on GET /v1/wallet/payout-account so Withdraw is disabled up front; cancel wired to DELETE /v1/media/uploads/{id} (contract has it now) — both in Task 8 — cost if wrong: none
Task 4 backend: full3 CRASHED at worker boot — ProfilesService needs MediaService, missing in UsersWorkerModule (production worker would not start); fix first in Task 8 dispatch, and remove the media<->profiles cycle
Task 8: complete (backend 03387f8, c78a531; web f096d74..74dcbe9; full suite 1436 green; e2e 108 x3 green; 5 bugs incl. worker boot cycle, RazorpayX base URL, public avatars, cancel, and the long-running "missing sign-in code" e2e flake = helper read welcome mail)
Final review: Opus — merge with fixes; 0 Critical, 3 Important (reorder overwrite across tabs, re-attaching removed upload, lesson video attach only when editor open / leaving Studio aborts uploads), 8 minors; refresh grace sound
Final: Ruling (controller): fix I1-I3 as reviewer suggests (curriculum version + 409 ORDER_STALE; engine marks slot handled; attach from engine, one UploadProvider above member and studio layouts, warn before unload); also minors on reuse detection for tokens older than one generation, withdraw attempt key surviving remount, cancel-vs-complete race and purger abort retry; other minors deferred — cost if wrong: none
Final: fixed I1-I3 and 4 minors (backend 3c7a57a..6e39058, web 5ccba9a..512e22e); full suite 1440 green; web 555 unit, e2e 108 green
Final: open — upload in flight at sign-out runs until its next 401; stale curriculum draft discarded on ORDER_STALE; other review minors deferred
