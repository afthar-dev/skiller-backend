# HTTP API. Build: docker build -t skiller-api .   Run: docker run --env-file .env -p 4000:4000 skiller-api
# Release (before rolling out a new version): docker run --rm --env-file .env skiller-api npm run release
#   = prisma migrate deploy && node dist/release/scripts/sync-permissions.js   (first deploy: npm run release:seed)
FROM node:24-bookworm-slim AS build
# openssl must be present when `prisma generate` runs, or the client is generated for the wrong engine (openssl-1.1.x).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: ffmpeg-static (a dev dependency for tests) would otherwise download a binary the API never uses.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY prisma ./prisma
RUN pnpm exec prisma generate
COPY tsconfig.json tsconfig.build.json tsconfig.scripts.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
# nest build -> dist/main.js; tsc -> dist/release/* (seed + permission sync, so production needs no ts-node)
RUN pnpm build

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
# Full node_modules on purpose: the prisma CLI (a dev dependency) runs `migrate deploy` from this same image, as the non-root user (it needs to write to its engines directory).
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
# Invoice and credit note PDFs embed these fonts (Noto Sans, Noto Sans Devanagari; SIL OFL 1.1), loaded from <app root>/assets/fonts at runtime.
COPY assets ./assets
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
