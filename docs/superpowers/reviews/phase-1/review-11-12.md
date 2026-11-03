# Review: Tasks 11 + 12 (ea909dd..453ff96)

Line numbers are file lines in the new/modified file at HEAD (derived from diff hunks).

## Spec Compliance
Spec compliant. Every listed route, model, error code, event and test focus is present.
- Task 11: models/migration, `user.registered` handler, `/v1/me`, `PATCH /me/profile` (reserved before pattern, `HANDLE_TAKEN` via P2002 on lower-cased handle), four PUT lists with limits, public `/profiles/:handle` with `isFollowing`, idempotent follow/unfollow with same-tx counters, `FOLLOW_SELF`, paginated followers/following, `become-creator` with one `user.became_creator` event.
- Task 12: `Organization`/`OrgInvite`, `org.create`/`org.manage`/`org.invite`, hashed 7-day token, `INVITE_EMAIL_MISMATCH`/`INVITE_EXPIRED`/`INVITE_USED`, members list/remove, `ORG_OWNER_REQUIRED`.
- Cannot verify from the diff: invite `email` vs `account.email` comparison assumes `users.email` is always lower-case (schema comment says so; the identity module is outside the diff). `parsePage` limit default 20 / max 100 lives in unchanged code.

## Strengths
- Module boundaries are mostly respected: RBAC never sees `organizations` (OrgParamResolverRegistry inversion, `UserRole.orgId` left FK-less); users module reaches identity through `AccountService`.
- Single-use invite claim via `updateMany where acceptedAt null`; concurrent-accept test proves exactly one winner.
- Token: 32 random bytes, SHA-256 stored, raw only in mail; test asserts the raw token is absent from the row.
- Profile creation is idempotent and race-safe (`createMany skipDuplicates` + re-read + retry); become-creator emits only on the flipping call.
- Public profile (`toProfileView`) exposes no email/status/session data; follower summaries are limited to id/handle/displayName/headline/avatar.
- No IDOR surface on experience/education/skills/portfolio: all PUT routes act on `auth.id`, no id path params, `.strict()` schemas, http(s)-only URLs.
- Slug resolution cannot be redirected: guard and handler both resolve through the same lower-cased lookup, slug is immutable (update schema has no slug), unknown slug -> `undefined` org -> only platform grants pass, then 404.

## Named risks
- (a) Direct mail vs outbox: acceptable under the module/outbox rules (cross-module call to an exported `MailService` is allowed; routing through an at-least-once handler would need the raw token in the outbox payload, i.e. persisting it, or risk duplicate mails). `org.member_invited` is still emitted (organizations.service.ts:142). Gap is failure handling, see Minor 1.
- (b) `corsOrigins[0]`: works but fragile, see Important 2.
- (c) Owner can never be removed: stricter than the brief (self-removal only) but consistent while there is no ownership transfer; acceptable. Noted as Minor 9.
- (d) One row per grant: see Important 3.
- (e) Public profile leak check: clean (see Strengths).

## Issues

### Critical (Must Fix)
None.

### Important (Should Fix)
1. `src/modules/users/profiles.service.ts:103` - users module reads the identity-owned `users` table directly (`this.prisma.user.findUnique` in `ensure`), violating "module reads/writes only its own tables" when `AccountService.get` already exists for this. Use `AccountService` (the worker module will need it exposed/imported), or require `email` from callers.
2. `src/modules/organizations/organizations.service.ts:147-148` - invite link is built from `corsOrigins[0] ?? ""`: CORS origin is not the web base URL, and an empty list silently yields a relative link (`/org-invites/accept?...`) that is useless in an email. Add a required `WEB_BASE_URL` config value and fail at boot if absent.
3. `src/modules/organizations/organizations.service.ts:157-170` (+ `invite` 138-145) - no reconciliation with existing membership: inviting/accepting for an existing member or the owner adds a second `UserRole` row (owner + learner, instructor + learner). Result: members list returns the same user several times (`roles.service.ts:67`, one row per grant, pagination counts grants not people), and `removeOrgMember` (`roles.service.ts:79`) silently drops all roles at once. Reject invites/accepts for existing members (or replace the role), and/or aggregate roles per user in the list.

### Minor (Nice to Have)
1. `organizations.service.ts:148` - `mail.send` failure after commit returns 500 while the invite row and rate-limit token remain; wrap with compensation (delete invite) or return a clear 502/retry hint. `org.member_invited` currently has no consumer.
2. `follows.service.ts:24-25,34-35` - counters updated target-then-follower; concurrent A->B and B->A can deadlock (Postgres 40P01 -> 500). Update in a fixed order (sorted by userId).
3. `profiles.controller.ts:23-32` - optional-viewer path checks session revocation but not user status (suspended user still gets `isFollowing`); harmless but inconsistent with AuthGuard.
4. `org-param-resolver.ts` / `organizations.module.ts:23` - resolvers are keyed by route param name globally; a future `:slug` route with another meaning and `orgParam: "slug"` would be mis-resolved. Key by (controller/permission) or assert uniqueness.
5. `me.controller.ts:34-52` - no cross-field validation (`endDate >= startDate`, `startYear <= endYear`).
6. `profiles.service.ts:~170-190` - concurrent PUT replace-lists on the same user can hit PK conflicts (`profile_skills` PK) and return 500; no lock or retry.
7. `schema.prisma` Profile.handle / Organization.slug - lower-case invariant is app-level only (plan says citext); add `CHECK (handle = lower(handle))` or use citext.
8. `organizations.service.ts:30,672` - public `GET /orgs/:slug` returns `ownerId` and the profile view returns `userId`; fine if intended as public ids, otherwise trim.
9. `organizations.service.ts:ORG_OWNER_REQUIRED` triggers for any removal of the owner, not just self-removal (stricter than brief; document).
10. Suspended/banned users' profiles remain publicly readable and followable; confirm intent.
11. Followers/following ordered by user id, not follow time (documented in report); `Follow.createdAt` is unused for ordering.
12. Test gaps: no test that a path slug in upper case still hits the guard for the right org, none for inviting an existing member, none for mail-failure behaviour.

## Assessment
**Task quality:** Approved with fixes (no blockers; address Important 1-3 before the whole-branch review).
**Reasoning:** Behaviour matches the brief and is well tested, with good concurrency and token handling; the main gaps are one module-boundary read, a fragile invite-link base, and duplicate-membership handling.
