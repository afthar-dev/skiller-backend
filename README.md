# skiller-backend

## Operations notes

- **Redis must run with `maxmemory-policy noeviction`.** Redis holds security state that must not be silently dropped: `sessions:revoked:{sid}` (revoked-session markers that block still-valid access tokens), `stepup:{sid}`, rate-limit windows and the BullMQ queues. An evicting policy (e.g. `allkeys-lru`) could re-enable a revoked access token.
- **`TRUST_PROXY`** = number of reverse-proxy hops in front of the API (0 = none). Per-IP rate limits and stored session/OTP IPs use `req.ip`; set this to the real hop count in production (e.g. 1 behind a single load balancer or CDN).
