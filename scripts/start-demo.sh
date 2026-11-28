#!/bin/sh
# Free-tier DEMO only (render.demo.yaml): one container runs the database update, the API and the worker.
# Production uses separate API and worker services (render.yaml). Not for real users or real money.
set -e

# Free Render plans have no pre-deploy step and no shell, so update and seed the database on every start.
# The seed is idempotent: it never overwrites what an admin changed.
DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}" npm run release:seed

# Small heap caps so both processes fit in a 512 MB free instance.
node --max-old-space-size=${WORKER_HEAP_MB:-160} dist/worker.js &
WORKER=$!
node --max-old-space-size=${API_HEAP_MB:-224} dist/main.js &
API=$!

stop() { kill -TERM "$API" "$WORKER" 2>/dev/null || true; wait; exit 0; }
trap stop TERM INT

# If either process dies, stop the other and exit so Render restarts the container.
while kill -0 "$API" 2>/dev/null && kill -0 "$WORKER" 2>/dev/null; do sleep 5; done
kill -TERM "$API" "$WORKER" 2>/dev/null || true
wait
exit 1
