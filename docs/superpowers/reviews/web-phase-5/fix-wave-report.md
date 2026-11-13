# Fix wave report: Web Phase 5

## Backend (branch web-phase-5)
3afc072 Messaging: clientMessageId idempotency and a replaced stream event
- I3: evicted stream ends with `event: replaced` (documented in the openapi stream description).
- I4: optional `clientMessageId` (uuid) on POST /v1/conversations and POST /v1/conversations/:id/messages; migration 20261113150000_message_client_id, unique (senderId, clientMessageId); repeat returns the existing message (and conversation) with 200, no new notification or stream event, no cap slot; parallel repeats resolved through the unique index. Same key in another conversation: 409 CLIENT_MESSAGE_ID_REUSED.

## Web (branch phase-5-gigs)
adcd684 e2e: an evicted tab stays off and polls instead of reconnecting
8b0b907 Gallery: sync the latest list in an effect (lint)
2db918c Thread: announce only new incoming messages; show when live updates are off (M6)
56c83b7 Gig page: Starting at is the lowest package price, as on the card (M1)
09e2ef1 Studio gallery: edits are built from the latest list, so a quick second removal cannot bring the first back (M2)
5f43f0a Messaging: seed the block list on start so blocked people stay hidden after a reload (I5, M8)
4d1ada3 Messaging: one clientMessageId per send attempt, reused on retry (I4); counter announced only near the limit (M6)
43a3833 Messaging threads: poll whenever the stream is not live; the watermark follows catch-ups only (I1, I2, M3)
5c776cd Messaging stream: a thrown refresh backs off instead of stopping; replaced ends this tab's stream (I1, I3, M3)
5bd86a5 Regenerate the API schema (clientMessageId, replaced event)

Findings: I1 (thrown refresh = failed connection, backoff; onEnd clears the manager; thread polls whenever not live), I2 (watermark moves only from catch-ups/first page; 60 s live catch-up), I3 (client stops on replaced; no backoff reset for connections < 30 s), I4 (client id per attempt in composer, reused on retry, heuristic removed), I5 + M8 (blocks seeded from /v1/me/blocks; badge excludes them; unblock in Settings shows again), M1, M2, M3 (watchdog armed before headers), M6 (counter announced only near limit, new-message region, "Live updates off" notice). e2e "after the stream is cut" rewritten for the new replaced behaviour (tab stays off and polls).

## Verification
- Backend: typecheck, lint, prisma validate, schema drift (scratch postgres), openapi:check-responses (71/71), openapi.json regenerated, test:scripts, unit messaging + openapi specs (51 suites, 365 tests), e2e messaging + gigs + gig-search + pool-gig-media + gigs-messaging-contract: 5 suites, 71 tests green.
- Web: api:generate/api:check, typecheck, lint, vitest 118 files / 886 tests, build green. `pnpm e2e` (E2E_BUILD_BACKEND=1 E2E_PG_PORT=55600): first run 128 passed, 2 failed (old reconnect expectation, fixed), second run 138 passed. Stack torn down.

## Not fixed / notes
- M4, M5, M7 left as known items.
- Unread badge excludes blocked people using conversations loaded in the visit (inbox loaded to 20 pages while someone is blocked, plus cached archive pages).
- Seeding covers blocks only, not mutes. Nothing pushed or merged.
- auth-provider "signed-out broadcast" unit test failed once under full-suite load, passes alone and on rerun (pre-existing flake).
