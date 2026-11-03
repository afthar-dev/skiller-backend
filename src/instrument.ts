// Imported first by main.ts / worker.ts so Sentry is set up before the rest of the app loads.
import { initSentry } from "./common/observability/sentry";

initSentry({ dsn: process.env.SENTRY_DSN || undefined, environment: process.env.NODE_ENV });
