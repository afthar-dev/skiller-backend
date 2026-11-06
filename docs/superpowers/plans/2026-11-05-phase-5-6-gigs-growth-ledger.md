# SDD ledger — plan: docs/superpowers/plans/2026-11-05-phase-5-6-gigs-growth.md
Spec: docs/superpowers/specs/2026-11-03-skiller-platform-redesign-design.md
Setup: user said "do 5&6 together"; one plan, branch phase-5-6-gigs-growth from main cfa06c7; plan approval gate waived by the go-ahead, decisions 1-8 listed to user for change
Executor: Ruling (user, standing): no per-group reviews, Sonnet implementers (1-2, 3-4, 5), one Opus final review + one fix wave — cost if wrong: defects found late
Task 1-2: Ruling (implementer, accepted): gig inquiries bypass allowMessagesFrom (blocks/suspension/restrictions still apply); setting checked at start only; uniform MESSAGING_NOT_ALLOWED; FOLLOWING = recipient follows sender; ViewerResolver moved to identity; ModerationTarget.canReport hook; max_active_gigs counts ACTIVE+HIDDEN; SSE needs fetch client (no token in URL) — cost if wrong: small
Task 1: complete (commits 6f6b925..814ecf8)
Task 2: complete (commits 814ecf8..c3d3043; full suite 1275 green after last edit)
Task 3-4: Ruling (implementer, accepted): API_BASE_URL optional config (default WEB_BASE_URL) for unsubscribe links; idempotency key uses "-"; growth.campaigns.tick job — cost if wrong: set API_BASE_URL in prod if web doesn't proxy /v1
Task 3-4: Ruling (controller): scheduled campaigns re-check the >10,000 approval at send start (Task 5) — cost if wrong: unapproved large send
Task 3-4: open: one-off outbox-dead.int-spec failure (4 handler calls vs 3) seen once in a full run; passes alone → watch in Task 5 runs
Task 3: complete (commits c3d3043..8f6d518)
Task 4: complete (commits 8f6d518..0b2ae17; full suite 1307 green after last edit)
Task 5: Ruling (implementer): DAU source HLLs in Redis (35 d TTL), funnel stage 3 may double count seller with first course and gig on different days (noted in response) — cost if wrong: approximate analytics
Task 5: outbox-dead flake root-caused and fixed (attempts override installed before event exists)
Task 5: complete (commits 0b2ae17..a45949c; full suite 1330/1331 then one-line spec fix, unit 334/334)
Final review: Opus (only review) — merge with fixes; 2 Critical (campaign mail blocks OTP queue; footer unsubscribe link does nothing), 10 Important, 14 minors
Final: Ruling (controller): C1+I2+I3+I4 — dedicated `mail-promo` queue + worker with BullMQ rate limiter (setting promo_send_per_second default 8); transactional `mail` queue never carries promo; job data = {campaignId, userId} only, processor re-checks campaign status + suppression + consent then renders at send time (campaign body cached); tick backpressure (enqueue only while queue depth < 500); exhausted jobs mark recipient FAILED and alert — cost if wrong: slower campaigns
Final: Ruling (controller): C2 — GET unsubscribe returns a minimal HTML page with a confirm button (no auto-unsubscribe on GET: link scanners), POST performs it; API_BASE_URL required when NODE_ENV=production; List-Unsubscribe-Post unchanged — cost if wrong: one extra click
Final: Ruling (controller): I1 — approval bound to a content hash; any edit clears it; approver ≠ creator and ≠ last editor — cost if wrong: none
Final: Ruling (controller): I5 — recipient PENDING→SENDING claim; processor sets SENT after Resend returns; SENDING older than 24 h → UNKNOWN (never resent) — cost if wrong: rare missed email rather than duplicate
Final: Ruling (controller): I6 — valid signed unsubscribe POST not IP-limited (per-token 10/min only); invalid tokens per-IP limited — cost if wrong: none
Final: Ruling (controller): I7 — rebuild skips WAU/MAU when any source HLL is missing, keeps stored values — cost if wrong: none
Final: Ruling (controller): I8 — conversation gig cards use GigVisibility; I9 — allowMessagesFrom removed from public profile (owner-only) — cost if wrong: none
Final: Ruling (controller): I7 amended — literal "skip when any HLL missing" would blank WAU/MAU for a young platform and after any no-activity day; a missing day counts as lost only if older than key lifetime or it has a stored dau row (`RollupService.hasLostDays`); activity set TTL 62 d — cost if wrong: approximate WAU/MAU after Redis data loss
Final: fixed C1, C2, I1–I10 (commits f573e51..5cb9e49); full suite 1356/1356 after last edit, edge 74/74, scripts 5/5, tsc, lint, build, openapi, drift on fresh DB green; I10 tests proved by mutation
Final: accepted limits — orphaned claims hold a campaign in SENDING up to 24 h (then UNKNOWN, never resent); promo_send_per_second change takes ~2 min; two timing-based tests may trip on a very slow machine
Final: deferred review minors 1–13 (minor 14 done in README)
Final: Ruling (user): one Opus final review + one fix wave, no dispatched re-review
