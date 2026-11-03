import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import vectors from "./test/vectors.json" with { type: "json" };

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: { bindings: { PLAYBACK_SECRET: vectors.secret } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
