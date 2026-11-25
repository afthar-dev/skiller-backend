# Hosting Skiller

How to run Skiller in production. Examples use `skiller.in`; replace it with your real domain everywhere. Prices change, so check each provider's current plan page. Nothing here has been run against the real providers yet: treat the first deploy as a test.

## 1. What runs where

| Part | Host | Address | Notes |
|---|---|---|---|
| Web app (`skiller-web`) | Vercel | `skiller.in` | Next.js. Function region near the API. |
| API (`Dockerfile`) | Render web service | `api.skiller.in` | Port 4000. Always on. |
| Worker (`Dockerfile.worker`) | Render background worker | none | Queues, ffmpeg, scheduled jobs. Always on. |
| Redis 7 | Render Key Value | private network | Must be `noeviction`, with persistence. |
| Postgres | Neon | n/a | Pooled URL for the app, direct URL for migrations. |
| Files and video | Cloudflare R2 | `cdn.skiller.in` | Public and private buckets. |
| Video gate (`edge/playback-gate`) | Cloudflare Worker | `play.skiller.in` | Checks playback tokens for private lessons. |
| DNS | Cloudflare | | Domain must use Cloudflare nameservers for R2 custom domains and Worker routes. |
| Email | Resend | | OTP, receipts, campaigns. |
| Payments, payouts | Razorpay, RazorpayX | | Webhooks call the API. |
| Errors | Sentry | | Web, API and worker. |

Choose one region close to India for Render, Neon and the web app's functions. `render.yaml` uses Singapore; pick Neon's Singapore region too. A database far from the API slows every request.

**Web and API must share the parent domain.** The login cookie is `SameSite=Lax`. `skiller.in` with `api.skiller.in` works; a `*.vercel.app` or `*.onrender.com` address against the production API doesn't keep users signed in.

**Why a long-running host and not serverless for the API:** the API holds live message streams and the worker runs long ffmpeg jobs and BullMQ consumers. Both need processes that stay up.

## 2. Before you start

- Domain bought, with nameservers moved to Cloudflare.
- GitHub repos for `skiller-backend` and `skiller-web`. Render deploys the backend from its repo; the web app can be deployed from a laptop with the Vercel CLI instead.
- Accounts: Vercel, Render, Neon, Cloudflare, Resend, Razorpay (with RazorpayX activated), Sentry.
- Keep secrets in a password manager. Never commit them.

Generate each secret separately:

```bash
openssl rand -base64 48
```

You need separate values for `JWT_SECRET`, `OTP_PEPPER`, `PLAYBACK_SECRET` and `KYC_PEPPER`.

## 3. Set up in this order

### 3.1 Neon

1. Create a project in your chosen region, Postgres 16 or newer, database `skiller`.
2. Copy two connection strings:
   - **Pooled** (host contains `-pooler`), add `?pgbouncer=true&connection_limit=10&sslmode=require`. API and worker use this as `DATABASE_URL`.
   - **Direct** (no `-pooler`). Only the release step uses this as `DATABASE_URL`.
3. Turn off scale-to-zero for production, and set a compute size that covers API plus worker connections. The worker polls continuously, so the database rarely sleeps anyway.
4. Set point-in-time restore to the longest window your plan allows. Money records live here.

Advisory locks in the code are all transaction-level, so transaction-mode pooling is safe.

### 3.2 Cloudflare R2

1. Create buckets `skiller-public` and `skiller-private`.
2. Connect custom domain `cdn.skiller.in` to `skiller-public` only. `skiller-private` is never public.
3. Create an R2 API token with read and write on both buckets. Save `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
4. Add this CORS policy to both buckets, because browsers upload straight to R2. `ETag` must be exposed or multipart uploads can't complete:

```json
[
  {
    "AllowedOrigins": ["https://skiller.in"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

5. Add a lifecycle rule to abort incomplete multipart uploads after 7 days.

### 3.3 Playback gate

Edit `edge/playback-gate/wrangler.toml`:

- Uncomment `routes` and set `pattern = "play.skiller.in/*"`, `zone_name = "skiller.in"`.
- Set `ALLOWED_ORIGINS = "https://skiller.in"`. It must equal the API's `CORS_ORIGINS`. The file currently says `https://app.skiller.in`.

```bash
pnpm --dir edge/playback-gate install
```

```bash
pnpm --dir edge/playback-gate exec wrangler secret put PLAYBACK_SECRET
```

```bash
pnpm --dir edge/playback-gate deploy
```

### 3.4 Resend

1. Add and verify sending domain `mail.skiller.in` (SPF and DKIM records in Cloudflare).
2. Publish DMARC, starting with `p=none`.
3. Create an API key.
4. Add webhook `https://api.skiller.in/v1/webhooks/resend` for `delivered`, `opened`, `clicked`, `bounced`, `complained`. Save its secret as `RESEND_WEBHOOK_SECRET`.

### 3.5 Render

`render.yaml` in the repo root is a Render Blueprint. It creates three services in Singapore: `skiller-redis` (Key Value), `skiller-api` (web service, `Dockerfile`) and `skiller-worker` (background worker, `Dockerfile.worker`), plus a shared variable group `skiller-shared`.

1. Edit the domain values in `render.yaml` (`skiller.in`) first if yours differ.
2. Push `skiller-backend` to GitHub. Render reads the Blueprint from the repo. In Render: **New, Blueprint**, pick the repo, keep `render.yaml`.
3. Render asks for every value marked `sync: false`. Paste them from your password manager (list below). `JWT_SECRET`, `OTP_PEPPER` and `KYC_PEPPER` are generated by Render.

**Redis (`skiller-redis`).** Paid plan, `maxmemoryPolicy: noeviction`, no public access. An evicting policy can bring revoked sessions back to life and lose queue jobs. The free plan keeps nothing on disk; don't use it. After the first deploy, confirm in the dashboard that the policy shows `noeviction`.

**API (`skiller-api`).**
- Health check path: `/v1/health` (liveness only). `/v1/ready` also checks Neon and Redis (2 s timeout each); use it for deploy checks and the external monitor, not for Render's restart decision.
- Pre-deploy command: `sh -c 'DATABASE_URL="$DIRECT_DATABASE_URL" npm run release'`. It migrates with the Neon **direct** URL before each new version goes live. If it fails, the old version keeps running.
- Custom domain `api.skiller.in` (the Blueprint adds it). In Cloudflare add the CNAME Render shows (`skiller-api.onrender.com`), **DNS only** (grey cloud), then verify in Render. Render issues the certificate.
- Plan `standard` (2 GB). Free plans sleep, which drops live message streams.

**Worker (`skiller-worker`).**
- No public address.
- At least 2 GB RAM (`standard`). The disk is temporary and needs room for your largest video source plus its HLS output. Transcoding runs one job at a time per worker; add instances for more throughput.

**Shared variables** (group `skiller-shared`, used by API and worker). Full list in `README.md`. `render.yaml` already holds the non-secret ones; the block below is the full set for reference.

```
NODE_ENV=production
DATABASE_URL=<neon pooled url>
DIRECT_DATABASE_URL=<neon direct url>
REDIS_URL=<set by Render from skiller-redis>
JWT_SECRET=...
OTP_PEPPER=...
PLAYBACK_SECRET=...
KYC_PEPPER=...
CORS_ORIGINS=https://skiller.in
WEB_BASE_URL=https://skiller.in
API_BASE_URL=https://api.skiller.in
COOKIE_DOMAIN=.skiller.in
TRUST_PROXY=1
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_PUBLIC_BUCKET=skiller-public
R2_PRIVATE_BUCKET=skiller-private
R2_PUBLIC_BASE_URL=https://cdn.skiller.in
R2_PLAYBACK_BASE_URL=https://play.skiller.in
RESEND_API_KEY=...
RESEND_FROM_ADDRESS=Skiller <hello@mail.skiller.in>
RESEND_WEBHOOK_SECRET=...
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
RAZORPAYX_ACCOUNT_NUMBER=...
RAZORPAYX_WEBHOOK_SECRET=...
SSR_SHARED_SECRET=...
SUPER_ADMIN_EMAIL=you@example.com
SENTRY_DSN=...
```

`TRUST_PROXY` is the number of proxies in front of the API. Rate limits depend on it. Render puts its own proxy in front, so start at `1` and confirm by checking that logged IPs are real client IPs (sign in from your phone on mobile data and compare). If they show a Render or Cloudflare address, raise it by one. If you later turn on the Cloudflare proxy for `api.`, add one.

`SSR_SHARED_SECRET` is a random string of at least 32 characters (`openssl rand -base64 48`), identical on the API, the worker and the web app's Vercel project. Rotate it by changing all three. Never set `RAZORPAY_BASE_URL` in production: the API refuses to start with it.

### 3.6 First deploy

The first deploy also needs the seed. In Render open `skiller-api`, **Shell**, and run once:

```bash
DATABASE_URL="$DIRECT_DATABASE_URL" npm run release:seed
```

The pre-deploy step will already have migrated, so this only seeds.

It migrates, then seeds permissions, roles, default flags and the super admin. Then start API and worker and check:

```bash
curl https://api.skiller.in/v1/health
```

```bash
curl https://api.skiller.in/v1/ready
```

### 3.7 Razorpay

Start in **test mode**. Use separate webhooks with **different** secrets; the app won't boot if they match.

- `https://api.skiller.in/v1/webhooks/razorpay`
- `https://api.skiller.in/v1/webhooks/razorpayx`

The event lists are in `README.md` under Payments.

### 3.8 Vercel

1. Import `skiller-web`. Attach `skiller.in`, and redirect `www` to it.
2. In Cloudflare, point the domain at Vercel as Vercel instructs, **DNS only**.
3. Set the function region near the API.
4. Environment variables:

```
NEXT_PUBLIC_API_URL=https://api.skiller.in
NEXT_PUBLIC_SITE_URL=https://skiller.in
NEXT_PUBLIC_SENTRY_DSN=...
```

Secrets don't belong here, with one exception: the web app holds only `SSR_SHARED_SECRET`, as a server-only Vercel variable (no `NEXT_PUBLIC_` prefix). Set the same value on the API and worker. The web app's server sends it as `X-Skiller-Server` with the visitor's address in `X-Skiller-Client-Ip`, so per-IP rate limits count visitors instead of Vercel. Vercel preview URLs can show public pages but can't sign in against production.

## 4. Each release

1. Run tests in CI.
2. Push to `main`. Render builds both images, runs the API pre-deploy migration, then rolls out API and worker. Migrations must stay backward compatible with the running version during the rollout.
3. With auto-deploy off, use **Manual Deploy** on `skiller-api` first, then `skiller-worker`.
4. Check `/v1/ready`.
5. If `edge/playback-gate` changed, deploy it.
6. Vercel deploys the web app on merge to `main`. Deploy the API first when a web change depends on a new API.

**Rollback:** in Render open the service, Events, and roll back to the previous deploy and promote the previous deployment in Vercel. Migrations aren't rolled back automatically; a bad migration needs a new fix-forward migration, or a Neon restore as last resort.

## 5. Staging

Keep a second copy before taking real money: `staging.skiller.in` (web) and `api.staging.skiller.in`, a Neon branch, a separate Render project from the same Blueprint (rename the services and domains), separate R2 buckets, Razorpay test keys. Use `COOKIE_DOMAIN=.staging.skiller.in`.

## 6. Before real users and real money

Complete both go-live checklists in `README.md`. In short:

- [ ] One full purchase, refund, subscription and payout in Razorpay test mode, then a reconciliation run.
- [ ] RazorpayX request and webhook shapes verified in test mode. The client has only run against fakes.
- [ ] Upload a course video, watch it through `play.skiller.in`, and confirm a raw R2 URL for the private bucket fails.
- [ ] Sign in on phone and desktop. Refresh the page and stay signed in.
- [ ] Bounce and complaint webhooks reach the API.
- [ ] Sentry receives a test error from web, API and worker.
- [ ] Redis `noeviction` and persistence confirmed. Restart it and check queues survive.
- [ ] Two `finance_admin` holders, and two super admins if campaigns will exceed 10,000 recipients.
- [ ] Platform settings filled: `platform_legal_name`, `platform_address`, `platform_state_code`, `platform_gstin`.
- [ ] CA sign-off on GST, TCS, TDS and invoice content.
- [ ] Lawyer sign-off on DPDP promo consent and legal pages.
- [ ] Restore a Neon backup into a branch once, so you know it works.
- [ ] Swap to live Razorpay keys and webhooks last.

## 7. Watching it

- **Uptime:** external monitor on `/v1/ready` and the home page.
- **Sentry alerts:** new errors, and any exhausted worker job.
- **Dead events:** `GET /v1/admin/outbox/dead` should stay empty.
- **Queue depth:** a growing `media-transcode` means add a worker; a growing `mail` is urgent because OTP login depends on it.
- **Reconciliation:** the nightly job must report OK.
- **Limits:** Neon connections, Redis memory (with `noeviction`, a full Redis makes writes fail), R2 storage, Resend sending quota.

## 8. Scaling, in order

1. More worker replicas for video.
2. More API replicas. Sessions, rate limits and live messages already go through Redis.
3. Larger Neon compute.
4. Cloudflare proxy in front of `api.` for rate limiting at the edge, then add one to `TRUST_PROXY`.

### 8.1 Video transcoding capacity

Reels use the `media-transcode` queue and course lessons the `media-transcode-long` queue, one job at a time each, so a long lesson never delays a reel. Both run in the one worker process and share its CPU: on a 1 vCPU `standard` worker a lesson and a reel transcoding together each take about twice as long.

Each rendition is one ffmpeg run that decodes the source again, and its time limit is `max(30 min, 3 x source duration)`, so a long lesson is not killed for being long (a hung ffmpeg still is).

Benchmark (single thread, `-preset veryfast`, synthetic 1080p30 source, a developer desktop, not a Render instance): a 60 s clip took about 10 s for the 480p rendition and about 58 s for the 1080p rendition, i.e. roughly real time for 1080p on one core. A 60-minute 1080p lecture therefore needs about 1 hour for the 1080p rendition alone and 1.5 to 2 hours for all four, more on a slower vCPU. Before launch, repeat it on the real plan: generate a 45-minute clip with `ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=30 -t 2700 ...`, run `transcodeToHls` in `docker run --cpus=1 --memory=2g`, and note the time per rung here.

Guidance: keep the `standard` worker for reels and lessons up to about 30 minutes; move the worker to `pro` (2+ CPUs) before accepting hour-long lessons, and tell instructors the supported length. A worker redeploy waits up to 5 minutes (`maxShutdownDelaySeconds`) for the running transcode; a longer one is stalled and starts again (up to 3 times), and anything left stuck is re-queued or failed by the hourly sweep (`media.stuck-sweep`).
