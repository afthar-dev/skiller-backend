# Re-review of the Phase 2 final-review fix wave (c700b36..94e10a5)

## Finding verdicts

1. I-1 / design 1, RazorpayX VPA `{username, handle, address}` fully masked: ADDRESSED.
   - `webhook-scrub.ts` `scrubVpa` reduces any `vpa` (string or object) to `{ address: masked }`. username and handle are dropped; a missing address gives `"***"`.
   - The fake (`razorpayx.fake.ts` ~L133) now emits the real shape.
   - The unit spec asserts `"username":"asha"` and `"handle":"okhdfc"` are absent.
   - The e2e (`payout-accounts.e2e-spec.ts`) delivers a real-shaped webhook and asserts the stored `webhook_events.payload` has neither the full id nor the username.
2. I-2 / design 2, Sentry: ADDRESSED.
   - `sentry.ts` sets `dataCollection` (userInfo, cookies, headers, bodies, query params, stack-frame variables all off) plus `beforeSend: scrubSentryEvent`.
   - `scrubSentryEvent` deletes request data, cookies, headers and query_string, strips the URL query, and filters account/pan/vpa/token/secret/password/code keys in `extra` and `contexts`.
   - `dataCollection.httpBodies` exists in the installed `@sentry/core@11.10.0` typings.
   - `sentry-scrub.e2e-spec.ts` uses the real SDK with a mocked transport. It forces a 502 on PUT payout-account with the request metadata set, then asserts the account number, PAN, access token and refresh cookie are absent from the envelopes while method and path remain.
3. I-3 / design 3, org-scoped `org.wallet.manage`: ADDRESSED in code. One rollout gap, see Important N-1.
   - `PermissionService.has(..., { orgScopedOnly })` returns true only for a grant held in that org. The decorator throws if `orgScopedOnly` is set without `orgParam`.
   - Applied to: `wallet.controller.ts:148` (PUT payout-account), `:194` (POST payouts), `billing.controller.ts:117` (checkout), `:126` (cancel), `:134` (change).
   - Grep of every `orgParam` use in `src` found no other org money mutation. The other `orgParam` routes are the organizations controller (update, invites, members) and the accepted org read routes (`wallet.controller.ts:159,166,174,183`; `billing.controller.ts:109`).
   - `org_owner` carries the key in `default-roles.ts`.
   - The e2e shows super_admin gets 403 on both PUT and POST and nothing is written, while the org owner gets 200.
4. M-7 / design 4, payout-account change notification: ADDRESSED.
   - `payout-accounts.service.ts` enqueues `payout_account.changed` in the same transaction as the audit row.
   - The handler notifies the user (USER) or every active `org_owner` (ORG, via `userIdsWithRoleInOrg`, which honours expiry). It sends in-app and email, with the IST cooldown end, and `sourceEventId` makes redelivery idempotent.
   - Template, mail type, notification type (transactional) and the worker `HANDLED` map are all updated.
   - The e2e covers both owner kinds and redelivery.
5. Review item 4 / design 5, MANUAL_REVIEW resolve: ADDRESSED.
   - `POST /v1/admin/payouts/:id/resolve` (`admin-wallet.controller.ts` ~L77) has `payout.approve`, `RequireStepUp`, a strict body with a required note, and an audit row.
   - `PayoutsService.resolve` takes the payout row lock, requires MANUAL_REVIEW, and refuses when `approvedBy` or `requestedBy` equals the actor (403 `PAYOUT_SELF_RESOLUTION`).
   - PAID goes through the shared `settle()`, which the webhook path now also uses. RETURNED calls `unlock` (payout_failed entry), sets FAILED with `MANUAL_REVIEW_RETURNED`, and emits `payout.failed`.
   - The summary now counts MANUAL_REVIEW as pending.
6. Review item 5 / design 6, review flags block requests and approvals: ADDRESSED.
   - `payableAccount` throws 409 `PAYOUT_ACCOUNT_UNDER_REVIEW` before any lock, so nothing is locked.
   - Approve and send already auto-reject through `accountBlock`.
   - The DUPLICATE_PAN alert text is corrected, and a NAME_MISMATCH alert is added.
   - The README matches. The e2e covers both flags and clearing.
7. Design 7, README CA checklist: ADDRESSED. Present: TCS s.52 (1%, GSTR-8), Rule 46 fields with the CGST/SGST vs IGST split and place of supply, seller vs platform documents, the 194-O base, and the aggregate-only settlement check note.

## New breakage in the fix diff

### Important

- **N-1. Existing databases do not receive `org.wallet.manage` for `org_owner` through the normal release path.**
  - `package.json:21` (`release`) and `scripts/sync-permissions.ts:8-12` call only `syncPermissions`. That inserts the key and grants it to super_admin; it does not touch `org_owner`.
  - The add-only grant to existing system roles (with cache epoch bump) lives in `seedSystemRoles` (`permission-sync.ts:50`). It is called only from `prisma/seed.ts`, that is `release:seed` and `db:seed`.
  - README ~L214 says the seed is for a first deploy only. After a routine `release`, every org owner gets 403 on payout account, payouts and subscription checkout/cancel/change, and nothing in the docs says so.
  - The fix report flags the concern but does not close it.
  - Fix: call `seedSystemRoles` from `sync-permissions.ts` (it is idempotent and add-only) with the Redis invalidator, or make `release` run the seed. At minimum, state it in the README release section.

### Minor (5)

1. `payouts.service.ts` `settle()` (via resolve PAID): a payout that came from MANUAL_REVIEW keeps `failureReason = "AMOUNT_MISMATCH"` on a PAID row. `settle()` and its `extra` do not clear it. Also `utr` is null.
2. After RETURNED, a late `payout.processed` with the correct amount hits the "already FAILED" branch. It only logs a warning, so there is no finance alert for a possible real payment on a payout already returned. The same applies to the FAILED path that existed before this diff.
3. `wallet.controller.ts:129` and `billing.controller.ts:93` doc comments still say "authorised by `org.manage`", which is now only true of the read routes.
4. `SENSITIVE_KEY` in `sentry.ts` also filters harmless keys such as `accountId` and `payoutAccountId` in `extra` and `contexts`, which reduces debuggability. Safe, but over-broad. Breadcrumbs, `user` and exception message text are not scrubbed. That is acceptable given `dataCollection` is off and gateway errors are sanitised.
5. The email for a first account (`replaced: false`) says "Payouts to it can be requested once it is verified", but the stored cooldown equals the change time. Accurate, wording only.

## Checks run on the specific concerns

- **Resolve double-post:** a second resolve finds PAID or FAILED and gets 409 `PAYOUT_NOT_IN_REVIEW`.
  - The state check runs under the row lock, and entries are keyed `(PAYOUT, id, description)`.
  - Resolve racing a late webhook is serialised by `lockAndLoad`'s `FOR UPDATE`.
  - Late processed after PAID or MANUAL_REVIEW is a no-op.
  - A late failed or reversed event before the resolve unlocks once (keyed), and the resolve then gets 409.
  - A late reversed after a PAID resolve posts the reversal. This is correct because `wasPaid` is true.
- **Ledger zero-sum:**
  - PAID: `-amount + (amount - tds) + tds = 0`, with the same lines as the webhook path (the code was moved, not changed).
  - RETURNED: `-amount` from PAYOUT_LOCKED and `+amount` to AVAILABLE, with the same key as the failed path.
  - The e2e asserts `sum: 0n` for both.
- **Permission sync:** see N-1 (`seedSystemRoles` adds `org.wallet.manage` to existing `org_owner` roles and bumps the cache epoch, but only when the seed runs).
- **Tests:** the fix report names a 69-suite, 707-test run and a 74-test edge run, and the diff contains the new specs (webhook-scrub, sentry spec and e2e, payouts e2e, payout-accounts e2e, permission-sync spec). I did not re-run them.

## Out-of-scope observations

None new.

## Verdict

All 7 designs and 5 findings are ADDRESSED. One new Important: N-1 (rollout path leaves `org_owner` without `org.wallet.manage`). Minor count 5.
