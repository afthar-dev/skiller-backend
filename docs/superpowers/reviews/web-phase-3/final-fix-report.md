# Final fix wave: report

Status: done, nothing pushed.

## Commits
Backend (web-phase-3): 3c7a57a I1 curriculum version and ORDER_STALE; 31bec54 refresh reuse for tokens older than one generation (migration 20261112000000_session_retired_hashes); 4460447 purger aborts a cancelled upload's multipart again; plus a test tidy commit.
Web (phase-3-studio): 5ccba9a I1; 2631c3f withdraw key survives remount; 82346db I2, I3, cancel vs complete; plus an e2e wait fix.

## Fixed
- I1: GET curriculum returns `version` (fingerprint of ids, positions, section membership); PUT order requires `expectedVersion`, 409 ORDER_STALE under the course lock. Web sends the version the draft started from. Impossible-422 test replaced by 409 tests.
- I2/I3: engine runs onReady once at READY and empties the slot; UploadProvider moved to the root providers; beforeunload while a slot is uploading; hint reworded.
- Minors: reuse detection (`retiredHashes`, last 20, GIN index; previous token keeps 10 s grace); withdraw key in sessionStorage (key plus digest of amount); cancel racing complete (state goes to processing before complete, engine ignores cancel while completing); purger retries abort for FAILED/ABORTED_BY_OWNER.

## Numbers
Backend: typecheck, lint, openapi:export, openapi:check-responses ok; full suite 138 suites, 1440 tests passed (full-suite-final.log).
Web: typecheck, lint, build, api:check ok; 555 unit tests passed (was 533+); e2e 108 passed (e2e-fix-1.log).

## Concerns
- Uploads in flight now outlive sign-out until their next request fails 401 (provider is above auth layouts).
- A curriculum draft started before this tab adds a section/lesson sends the older version, so the save gets ORDER_STALE and reloads (safe, slightly annoying).
- After an attach (onReady) the field returns to idle; the "Your file is ready." line only shows briefly. Attach errors are shown by the callers only.
- Retired-hash history only covers tokens rotated after the migration.
