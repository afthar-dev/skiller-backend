# Hosting Skiller

How to run Skiller in production. Examples use `skiller.in`; replace it with your real domain everywhere. Prices change, so check each provider's current plan page. Nothing here has been run against the real providers yet: treat the first deploy as a test.

## 1. What runs where

| Part | Host | Address | Notes |
|---|---|---|---|
| Web app (`skiller-web`) | Vercel | `skiller.in` | Next.js. Function region near the API. |
| API (`Dockerfile`) | Railway | `api.skiller.in` | Port 4000. Always on. |
| Worker (`Dockerfile.worker`) | Railway | none | Queues, ffmpeg, scheduled jobs. Always on. |
| Redis 7 | Railway | private network | Must be `noeviction`, with persistence. |
| Postgres | Neon | n/a | Pooled URL for the app, direct URL for migrations. |
| Files and video | Cloudflare R2 | `cdn.skiller.in` | Public and private buckets. |
| Video gate (`edge/playback-gate`) | Cloudflare Worker | `play.skiller.in` | Checks playback tokens for private lessons. |
| DNS | Cloudflare | | Domain must use Cloudflare nameservers for R2 custom domains and Worker routes. |
| Email | Resend | | OTP, receipts, campaigns. |
| Payments, payouts | Razorpay, RazorpayX | | Webhooks call the API. |
| Errors | Sentry | | Web, API and worker. |

Choose one region close to India for Railway, Neon and Vercel functions (Singapore is the usual choice if nothing nearer is offered on all three). A database far from the API slows every request.

**Web and API must share the parent domain.** The login cookie is `SameSite=Lax`. `skiller.in` with `api.skiller.in` works; a `*.vercel.app` or `*.up.railway.app` address against the production API doesn't keep users signed in.

**Why Railway and not serverless for the API:** the API holds live message streams and the worker runs long ffmpeg jobs and BullMQ consumers. Both need processes that stay up.

## 2. Before you start

- Domain bought, with nameservers moved to Cloudflare.
- GitHub repos for `skiller-backend` and `skiller-web` (neither has a remote yet).
- Accounts: Vercel, Railway, Neon, Cloudflare, Resend, Razorpay (with RazorpayX activated), Sentry.
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

### 3.5 Railway

Create one project with three services.

**Redis.** Add Redis 7, then set the start command or config so these apply:

```
redis-server --maxmemory-policy noeviction --appendonly yes
```

Confirm with `CONFIG GET maxmemory-policy`. An evicting policy can bring revoked sessions back to life and lose queue jobs. Give it a volume so data survives a restart.

**API.**
- Source: `skiller-backend` repo, Dockerfile `Dockerfile`.
- Public domain: `api.skiller.in` (CNAME in Cloudflare, **DNS only**, grey cloud).
- Health check path: `/v1/ready`.
- Pre-deploy command: `npm run release`, with `DATABASE_URL` for that step set to the Neon **direct** URL. If Railway can't override it per step, run the release by hand (section 4).
- 1 GB RAM to start.

**Worker.**
- Source: same repo, Dockerfile `Dockerfile.worker`. Set `RAILWAY_DOCKERFILE_PATH=Dockerfile.worker`.
- No public domain.
- At least 2 GB RAM and enough temp disk for your largest video source plus its HLS output. Transcoding runs one job at a time per worker. Add worker replicas for more throughput.

**Shared variables** (API and worker). Full list in `README.md`.

```
NODE_ENV=production
DATABASE_URL=<neon pooled url>
REDIS_URL=<railway private redis url>
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

`TRUST_PROXY` is the number of proxies in front of the API. Rate limits depend on it. Confirm it by checking that logged IPs are real client IPs. If you later turn on the Cloudflare proxy for `api.`, add one.

`SSR_SHARED_SECRET` is a random string of at least 32 characters (`openssl rand -base64 48`), identical on the API, the worker and the web app's Vercel project. Rotate it by changing all three. Never set `RAZORPAY_BASE_URL` in production: the API refuses to start with it.

### 3.6 First deploy

Run this once with the direct database URL, instead of `npm run release`:

```bash
npm run release:seed
```

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
2. Run migrations first, with the direct URL, using the new API image:

```bash
docker run --rm --env-file .env.release skiller-api npm run release
```

3. Roll out API and worker. Migrations must stay backward compatible with the running version during the rollout.
4. Check `/v1/ready`.
5. If `edge/playback-gate` changed, deploy it.
6. Vercel deploys the web app on merge to `main`. Deploy the API first when a web change depends on a new API.

**Rollback:** redeploy the previous image in Railway and promote the previous deployment in Vercel. Migrations aren't rolled back automatically; a bad migration needs a new fix-forward migration, or a Neon restore as last resort.

## 5. Staging

Keep a second copy before taking real money: `staging.skiller.in` (web) and `api.staging.skiller.in`, a Neon branch, separate Railway environment, separate R2 buckets, Razorpay test keys. Use `COOKIE_DOMAIN=.staging.skiller.in`.

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
