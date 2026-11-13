# Final review: Web Phase 5 (Gigs and Messaging)

Scope: backend `web-phase-5` vs main (backend.diff), web `phase-5-gigs` vs main (web.diff, HEAD 8185496). I checked each finding against the source. Line numbers refer to the current branch files.

Overall: solid work. The SSE parser handles chunk splits and lone `\r` correctly. The single-flight refresh is reused. The per-thread watermark with an epoch counter is a careful answer to the reconnect-gap race. JSON-LD escapes `<`. Descriptions, FAQs and messages are rendered as plain text (`whitespace-pre-line` / `pre-wrap`, no `dangerouslySetInnerHTML` apart from the escaped JSON-LD). The new backend fields only use `publicUrls` (PUBLIC bucket + READY), so hidden, private or unfinished assets never get a URL. No route behaviour or authz changed in the backend (decorators and docs only). The issues below are in the failure paths that the tests do not cover.

Counts: Critical 0, Important 5, Minor 8.

---

## Important

### I1. The stream stops for good after a transient refresh failure, and nothing restarts it or polls
- `src/features/messaging/stream.ts:132-133`, `:147-148`, `:159-160`: `refreshToken().catch(() => null)` then `return`.
- `src/lib/api/refresh.ts:46-47`: `refreshSession` **throws** on network errors, 5xx and an exhausted `REFRESH_RACE`. It returns `null` only on a real 401.
- `src/features/messaging/use-message-stream.ts:19`: `closeCurrent` is never cleared when the loop ends by itself, so `startMessageStream` stays a no-op.
- `src/features/messaging/use-messages.ts:87`: the open thread polls only when the status is `"down"`, and the loop ends in `"stopped"`.

Scenario: the access token expires while a thread is open, and the server sends `event: expired`. The refresh call hits a network blip, or two tabs refresh at the same moment and the race retries run out. `refreshSession` throws, the `.catch` turns that into `null`, and the loop returns. The status becomes `"stopped"` while the session is still valid. From then on the tab gets no live messages and no 10 s polling. It does not recover until the member leaves the `(member)` layout or signs out. Focus catch-up is the only path left. A laptop waking from sleep (expired token, wifi still coming up) hits the same path through the 401 branch.

Fix:
- In `stream.ts`, treat a thrown refresh as a failed connection: `report("down")`, back off and continue. Return only when the refresh resolves to `null`.
- In `startMessageStream`, clear `closeCurrent` when the loop ends (have `openMessageStream` take an `onEnd` callback).
- Optionally, poll whenever the status is not `"live"`.
- Add a test: refresh rejects once, then the stream reconnects.

### I2. A message the stream drops is lost until reload, because the watermark follows stream events past the gap
- `src/features/messaging/store.ts:80-86`: `ingest` moves the watermark to every stream message while the thread is `verified` and the status is `live`.
- The backend delivery is explicitly best effort:
  - `src/modules/messaging/message-stream.hub.ts:39-45`: `publish` logs and swallows Redis errors ("a failed push is a delayed message").
  - Redis pub/sub also drops messages published while the shared subscriber connection reconnects. The client's SSE connection stays open the whole time, so the status never leaves `live`.

Scenario: the buyer has the thread open and the stream is live. The seller sends m1, and its publish fails (Redis blip on the publisher, or the subscriber is reconnecting). The seller then sends m2, which arrives by stream. `ingest(m2)` moves the watermark to m2. Every later catch-up (focus, reconnect, poll) asks `after=m2`, so m1 is never fetched. The thread shows m2 without m1 until a full reload. The backend's contract that polling recovers anything the stream missed is broken by the client. This breaks "no lost messages" in Review Focus 1.

Fix (web only):
- Do not advance the watermark from stream events. Move it only from catch-up results and the first page (server-confirmed, contiguous). Re-fetched messages are already deduped by id, so the cost is a few repeated rows per catch-up.
- Add a cheap periodic catch-up while live (for example every 60 s for the open thread, or on every Nth heartbeat), so a dropped event is repaired without a reconnect.
- Alternative (backend): add `previousId` to `MessageStreamEvent` so the client can detect a gap and run a catch-up.

### I3. With six or more tabs, the streams evict each other in an endless 1 s reconnect loop
- `src/modules/messaging/message-stream.hub.ts:77-82`: past `MAX_STREAMS_PER_USER` (5, per API instance) the oldest stream is ended with `end()`, which sends no event.
- `src/features/messaging/stream.ts:153-154`: `failures = 0` as soon as a 200 arrives. `:171-172`: a stream that closes without `expired`/`revoked` is "dropped", so it waits `backoffFor(0)` = 1 s and reconnects.

Scenario: a member keeps six member-area tabs open, which is easy with gig and message links opening in new tabs. Tab 6 evicts tab 1. Tab 1 reconnects after 1 s and evicts tab 2, and so on, forever: about one reconnect per second for that user. Each evicted tab goes `down`, then `connecting`, then `live`. That clears `verified` and bumps the epoch. Each open thread runs an `after=` catch-up on every cycle, and polls every 10 s while down. The backend sees constant subscribe/unsubscribe churn, and the "one stream per tab, at most 5" contract degrades into a storm. The plan's Review Focus 5 (many tabs) did not test more than 5.

Fix (any one):
- (a) The backend ends an evicted stream with `event: replaced`, and the client stops (or waits a long backoff, and reconnects only on focus) when it sees it.
- (b) The client does not reset `failures` until a connection has lasted, for example, 30 s.
- (c) One stream per browser: elect a leader with the Web Locks API or a `BroadcastChannel`, and fan out events to the other tabs.

(a) plus (b) is the smallest change.

### I4. Retrying a start without idempotency sends the opening message twice. A backend idempotency key is warranted.
- `src/features/messaging/new-conversation.tsx:82-88`: `start` POSTs `/v1/conversations` each time. `composer.tsx:49-53` keeps the text and offers Retry after any error, including a timeout or network error after the server committed.
- `src/modules/messaging/messaging.service.ts:59-89`: `start` always appends a message, so a retry appends a second copy. If the first call created the conversation, the retry lands on the existing pair and appends again.
- The in-thread send (`use-messages.ts:127-137`) uses a heuristic: catch up, then look for a message from me with the same body after an anchor. It fails in two ways:
  - A double send if the catch-up itself fails, because errors are swallowed at `use-messages.ts:67` and the resend still goes out.
  - A wrong "delivered" if the same text was sent from another device after the anchor.

Scenario: a buyer on a phone taps "Send message" on a gig. The response times out, but the server committed. The buyer taps Retry, and the seller gets the inquiry twice. It also costs a second hourly slot.

Judgement: warranted. The heuristic cannot be made safe on the client for `POST /v1/conversations`: there is no conversation id to catch up on before the first success. The mobile apps will need the same thing. The smallest robust design:
- An optional `clientMessageId` (UUID) on both `POST /v1/conversations` and `POST /v1/conversations/:id/messages`, stored on `Message`.
- `@@unique([senderId, clientMessageId])`; on conflict, return the existing message (and conversation) with 200.
- The web keeps one id per composed text until it succeeds, and drops the body-matching heuristic.

An `Idempotency-Key` header cached in Redis for 24 h also works, but the column also gives the stream echo a stable key.

### I5. Blocking hides a conversation only until reload; afterwards the blocked person's thread, messages and an enabled composer come back
- `src/features/reels/availability.ts:10` (state is per visit only), `src/features/messaging/conversation-list.tsx:90`, `src/features/messaging/thread.tsx:77-80` and `:209`: hiding and disabling depend on this visit's `availability`.
- `src/modules/messaging/messaging.service.ts:100-121` and `:129-153`: `list` and `messages` ignore blocks. Only `assertReachable` (line 185-189) checks them, at send time.

Scenario: the seller blocks a buyer from the thread. The thread closes and the conversation leaves the list. The seller reloads `/messages`. The conversation is back in the inbox with the buyer's messages and unread count (the badge counts them too), and the composer is enabled. Typing and sending gives "You can't message this person." Review Focus 3 ("blocked user's messages hidden") only holds within one page visit.

Fix:
- Preferred (backend): add a neutral `canMessage: boolean` to `Conversation`. It is false for any reason `assertReachable` would refuse, so it says no more than `MESSAGING_NOT_ALLOWED`. Either filter out conversations with people *I* blocked, or flag them so the web hides them.
- Minimum (web): seed `availability` from `GET /v1/me/blocks` when the messaging area mounts.

---

## Minor

### M1. The gig page's "Starting at" shows the Basic price, not the lowest
`src/features/gigs/gig-detail.tsx:19,90`: `const lowest = gig.packages[0]`. Packages are sorted by tier (`gig-view.ts:19`), and the backend does not require prices to rise by tier (`gig-rules.ts:40-42` checks only min/max). With Basic at ₹2,000 and Standard at ₹1,000, the card says "From ₹1,000" (it uses `startingPricePaise`, the minimum) and the page says "Starting at ₹2,000". Fix: take the minimum `pricePaise` (compare as BigInt), or show the Basic price with a "Basic" label.

### M2. Rapid gallery edits use a stale list, so a removed picture comes back
`src/features/studio-gigs/gallery-tab.tsx:28-35`, `:82`, `:102`: every action builds the new list from `gig.galleryAssetIds`. That list only changes when a PATCH succeeds (`queries.ts:51-57`, no optimistic update), and the buttons are not disabled while saving. Scenario: the seller clicks Remove on picture 1, then on picture 2 before the first PATCH returns. The second PATCH sends the list without #2 but **with** #1, so #1 comes back. Out-of-order responses can also leave the cache on the older state. The same applies when an upload's `onReady` lands during a remove or reorder. Fix: disable gallery controls while `fields.state("gallery")` is saving, or keep the latest list in a ref updated optimistically and send the PATCHes one at a time.

### M3. The idle watchdog is not armed while waiting for response headers, and "connecting" never polls
`src/features/messaging/stream.ts:139-145`: `ping()` runs only after a 200. `use-messages.ts:87` polls only when the status is `down`. On a network switch the connection can be black-holed, and the fetch can wait minutes with no response. The tab stays `connecting`, with no live updates and no polling. Fix: arm the idle timer before `doFetch`, and poll whenever the status is not `live`.

### M4. Gig pages are cached for 60 s and nothing revalidates `gig:<slug>`
`src/features/gigs/queries.ts:13` (tag set), and no `revalidateTag` anywhere in `src`. A gig that is removed by moderation, paused or deleted still renders for up to 60 s. Because the cache is stale-while-revalidate, the first request after expiry is also served stale. Its "Message seller" then fails with "We could not find who to write to". This was already recorded and matches the other public pages. If removal must take effect at once, add a small signed revalidation route that the backend calls on moderation, pause and delete, or fetch the detail with `revalidate: 0` (it is one cheap query).

### M5. The public SSR copies show blocked sellers to the person who blocked them
`/gigs` page one and `/gigs/[slug]` use `publicFetch` with no viewer (`queries.ts:13-20`). A member who blocked a seller still sees that seller's card and gig page. Only "Message seller" leads to the neutral not-found. This is the documented trade-off (the course catalog does the same). Consider filtering page one on the client against `availability` or `/v1/me/blocks`.

### M6. Accessibility of the live regions
- `src/features/messaging/thread.tsx:195`: the `role="log"` list has `aria-live="polite"`. "Load earlier messages" prepends up to 30 bubbles, and screen readers announce all of them, as they do the catch-up batches. Fix: announce only new incoming messages in a separate visually hidden `role="status"` ("New message from X"), and leave the list without `aria-live`.
- `src/features/messaging/composer.tsx:103`: the character counter is `aria-live="polite"`, so every keystroke announces "12 / 4,000". Fix: make it live only near or over the limit, or debounce it.
- `useMessages` returns `live` (`use-messages.ts:159`), but no UI uses it. Nothing tells the member when live updates are off. Fix: show a small "Reconnecting…" status when the status is `down` or `stopped`.

### M7. `after=` relies on uuid v7 order, but ids come from each API instance's clock
`prisma/schema.prisma:1938` (`@default(uuid(7))`, generated by Prisma in the app process) and `messaging.service.ts:132` (`id > after`). `append` (line 205-216) runs the inserts for one conversation one at a time under `FOR UPDATE` and makes `createdAt` strictly increasing, but the **id** is not. Two instances whose clocks are a few ms apart can give a later message a smaller id. A client whose watermark already covers the earlier one then skips it on `after=`. The window is small (rapid back-and-forth on two instances with skew), but it can happen. Fix: page `after=` on `(createdAt, id)` (the per-conversation monotonic key `append` already guarantees), or generate the id in Postgres inside the locked transaction.

### M8. The unread badge counts conversations hidden by a block in this visit
`src/features/messaging/unread-badge.tsx:8-9` uses the server total, while `conversation-list.tsx:90` hides the blocked conversation. After a block, the badge can say 3 while the inbox shows none. This goes away with the backend fix for I5.

---

## Checked and fine
- SSE parser: frames split anywhere, CRLF split across chunks, comment heartbeats, multi-line `data`.
- `expired` and `revoked` (with a real 401 refresh) refresh or stop correctly.
- The abort on unmount and sign-out releases the reader, the timers and the outer listener.
- The strict-mode double effect is guarded.
- Dedupe by id across stream, poll and send. Order by createdAt then id.
- Catch-up reruns instead of sharing a stale result.
- `MESSAGING_NOT_ALLOWED` is one neutral text, and the composer turns off.
- The compose screen checks that the slug matches the gig id.
- Signing in from the gig page returns to the gig.
- Studio:
  - Basic is required and packages are sent in tier order.
  - The `GIG_PRICE_INVALID` index is mapped from `packages[i].pricePaise`, and the min/max come from the error details.
  - A picture is attached only from `onReady` (READY), and the backend checks ownership and READY again (`useAsset`).
  - `ENTITLEMENT_LIMIT_REACHED` and the slot count work, and plan usage is invalidated after activate and pause.
  - `GIG_STATE_INVALID` reloads the gig.
- Gig SSR:
  - No cookies or session are read, and the page returns a real 404.
  - The canonical URL and the OG image use `metadataBase`.
  - JSON-LD is a `Service` with one `Offer` per package, written in rupees.
- Backend: `GigImages` returns only PUBLIC + READY renditions, the card's `seller` is the public `ProfileSummary`, catalog visibility filtering is unchanged, and no authz changed.
- The `check-openapi-responses` change only counts a 2xx `text/event-stream` with a described schema as typed.

## Verdict
**Approve with fixes.** Fix I1 and I2 before merge: both are small, web-only changes, and both are paths where messaging silently stops working or loses a message. I3 should land with them or right after: either the backend `replaced` event, or simply not resetting the backoff for short-lived connections. I4 (a `clientMessageId` for idempotency) and I5 (block-aware conversations) need backend work. Track them as the first follow-up tasks; neither corrupts data. The Minor items can go to the backlog. M1 and M2 are quick wins.
