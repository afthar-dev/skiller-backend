- Task 1 DONE: backend ab7f2f4, web 3f16ce7. Ceiling 88→71 (17 ops; archive/unarchive already typed). Stream doc'd as text/event-stream; check lib counts described event-stream as typed. Web must type stream data from components["schemas"]["MessageStreamEvent"].
- Task 2 DONE: web 6b678c4; backend 9ae628e (gig cards coverUrl+seller, gallery urls, search query params documented). No delivery-days filter or reviews (API lacks). /gigs first page public SSR copy ignores blocks (open, review).
- Task 3 DONE: web 3b12bd8, 792 unit. Gig lists saved whole, no version token (last save wins). Hidden/removed show state text (API has no reason). Message seller → /messages/new?gig=<gigId> (Task 4 must add).
- Task 4 DONE: web 562cf03, backend 2157ab2 (documented after/archived queries). Link now has &slug=. Catch-up uses a watermark (reconnect gap bug found). Open: conversation start has no idempotency.
- Task 5 DONE: web 0209e4c. Preferences page pre-existed; added Saved state + link tests.
- Task 6 DONE: web ea2ac1d, 3e847fc, 4d91c40 (header overflow at 375 px fix), 8185496 (quietNetwork helper, stream breaks networkidle). Backend full suite 142/1458 green. Web unit 863. e2e 138 ×3 green. Open: gig page 60 s cache after moderation removal (gig:<slug> tag never revalidated); POST /v1/conversations no idempotency.

## Final review and fix wave

- Opus review: 0 Critical, 5 Important, 8 Minor. Fixed I1–I5, M1–M3, M6, M8 (backend 3afc072: clientMessageId idempotency with per-sender unique index, 409 CLIENT_MESSAGE_ID_REUSED on cross-conversation reuse, `replaced` stream event; web 5bd86a5 onward).
- After fixes: web unit 886, e2e 138/138 (run 2; run 1 failed the old stream-cut expectation, test updated for `replaced`); backend messaging/openapi units 365, messaging/gigs e2e 71, openapi ceiling 71. Backend full suite 1458 ran in Task 6, before the fix wave.
- Open: M4 gig page 60 s cache not revalidated on moderation; M5 public SSR /gigs first page and gig page show blocked sellers; M7 `after=` relies on uuid v7 order across instances (clock skew); mutes not seeded; auth-provider broadcast test flaky under load.
