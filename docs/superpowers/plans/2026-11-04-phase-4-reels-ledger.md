# SDD ledger — plan: docs/superpowers/plans/2026-11-04-phase-4-reels.md
Spec: docs/superpowers/specs/2026-11-03-skiller-platform-redesign-design.md
Setup: user approved plan + reels decisions 1-8; branch phase-4-reels from main 25795ec (plan commit ee2d778)
Executor: Ruling: Sonnet implementer per group (1-2, 3, 4-5, 6, 7), Sonnet task review per group, Opus final — cost if wrong: coarser gates
Pre-flight: T1 Reel model consumed by all; T2 engagement events consumed by T4 interests; T3 ReelSeen consumed by T4; T6 blocks/mutes/hidden consumed retroactively by T1-T5 read paths (T6 must patch them) — consistent
Executor: Ruling (user, 2026-11-04): no per-group task reviews in Phase 4 — implement all groups sequentially (TDD + green suite gate per group), then ONE final Opus whole-branch review + one fix wave — user asked for speed/fewer tokens — cost if wrong: defects found later, larger final fix wave
Task 1-2: Ruling (implementer, accepted): MediaAttachments extracted (worker-safe attach/detach/assetInfo); hashtags accept \p{M}; over-limit POST → 201 LIMIT_REACHED, publish retry → 403; anonymous shares not counted; no comment likes; openapi/README → Task 7 — cost if wrong: none
Task 1-2: Ruling (controller): PROCESSING reels must reserve their asset so the 24h orphan cleanup can't delete it — fix in Task 3 dispatch — cost if wrong: long transcodes lose video
Task 1: complete (commits ee2d778..a8bbe64, no task review per user ruling)
Task 2: complete (commits a8bbe64..f0b5719, no task review per user ruling)
Task 3: Ruling (implementer, accepted): pending hash fields keyed by IST day; no-cookie viewers keyed ip|ua and issued cookie marked seen; PENDING assets rejected at reel create; flush on maintenance queue; anonymous cookie rotation capped 300/h/IP (not eliminated) — cost if wrong: bounded anonymous view inflation
Task 3: complete (commits f0b5719..dfd2b76, no task review per user ruling; full suite 1131/1132 then boot-list fix, targeted rerun green)
Task 4-5: Ruling (implementer, accepted): engagement factor floor 0.05 (literal formula scores new reels 0 and they'd never surface); interest weights normalised to viewer's strongest; per-creator cap per block of first request's limit; reel search orders by recency for exact keyset; hashtag top paging live (may skip/repeat at boundary); followeeIds capped 5000 — cost if wrong: minor feed quality
Task 4: complete (commits dfd2b76..8600e13, no task review per user ruling)
Task 5: complete (commits 8600e13..1c431f4, no task review per user ruling; full suite 1171 green after last edit)
Task 6: Ruling (implementer, accepted): ModerationHold + UserRestriction tables; course targets registered API-only (decisions only in API); view beacons from blocked viewers still count; commentCount includes blocked users' comments — cost if wrong: small count mismatch per viewer
Task 6: Ruling (controller): Task 7 also fixes: worker auto-publish on media.ready respects posting ban (status LIMIT_REACHED-style RESTRICTED + notify); unread-count excludes filtered notifications — cost if wrong: none
Task 6: complete (commits 1c431f4..0c04e8a, no task review per user ruling; full suite 1193 green after last edit; tests after impl, mutation RED 5/8 + 9/14)
Task 7: Ruling (implementer, accepted): banned auto-publish reuses LIMIT_REACHED + failureReason POSTING_RESTRICTED; NotificationFilter types + batched list; linkClicks column; uniqueViewers approximate (sum of daily HLL); newFollowers creator-scoped; avgWatchPct assumes 90 s if no duration — cost if wrong: approximate analytics
Task 7: complete (commits 0c04e8a..691d8b3, full suite 1207 green after last edit)
Final review: Opus (only review of phase) — merge with fixes; 1 Critical (delete escapes strike), 5 Important, 19 minors
Final: Ruling (controller): C1 — ownerOf resolves soft-deleted targets; uphold on deleted content still records the strike (content stays deleted); reel/comment delete while OPEN reports exist keeps the media until decided; TARGET_GONE only for rows truly absent — cost if wrong: none
Final: Ruling (controller): I1 — posting ban also blocks reel caption PATCH and comment edit — cost if wrong: none
Final: Ruling (controller): I2 — upheld removal purges public HLS/poster immediately (media purge job) instead of waiting for 24h cleanup; reel keeps row as REMOVED — cost if wrong: no restore after uphold (dismiss path unaffected)
Final: Ruling (controller): I3 — watch time accumulates: per (viewer, reel, IST day) Redis max-position; each beacon adds positive delta capped at duration; views still counted once — cost if wrong: none
Final: Ruling (controller): I4 — for-you snapshot: one Redis key per signed-in viewer (overwritten; ≤ 300 ids; TTL 30 min), anonymous viewers use the shared 5-min global list only — bounds memory by active users — cost if wrong: a viewer's second concurrent session resets the first
Final: Ruling (controller): I5 — candidates = union of top 300 by recency and top 300 by engagement rate within last 7 days (filter 30-day fill unchanged) — cost if wrong: none
Final: Ruling (controller): declined-to-judge — reels/comments of SUSPENDED or DELETED accounts hidden from public reads via ReelVisibility (restored on unsuspend) — cost if wrong: content from suspended users disappears immediately (intended)
Final: fixed C1, I1-I5, suspended/deleted hiding — commits 691d8b3..efa35af, suite 1220/1220, test:scripts clean; RED/GREEN per item
Final: Ruling (controller): fix wave accepted without a dispatched re-review, per user's fewer-reviews instruction — cost if wrong: fix-wave regression surfaces later
Final: Ruling (implementer, accepted): moderation purge deletes the media row too; future account-deletion path must bust UserStatusCache; candidate query uses existing status/publishedAt index — cost if wrong: engagement-ranked query slower at scale
Final: minor (deferred): 19 minors in final-review.md; cookie drop can double-count watch time; commentCount includes suspended accounts' replies
