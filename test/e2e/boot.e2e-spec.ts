import type { INestApplication } from "@nestjs/common";
import { applyTestEnv } from "../setup/env";

// Boots the real AppModule through the same factory as src/main.ts (not Test.createTestingModule) and talks to it over a real socket.
describe("API boot (src/main.ts path)", () => {
  let app: INestApplication;

  afterAll(() => app?.close());

  it("createApp() starts, listens on an ephemeral port and answers GET /v1/health", async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    const { createApp } = await import("../../src/create-app");
    app = (await createApp()).app;
    await app.listen(0);
    const res = await fetch(`${await app.getUrl()}/v1/health`.replace("[::1]", "localhost"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    const ready = await fetch(`${await app.getUrl()}/v1/ready`.replace("[::1]", "localhost"));
    expect(ready.status).toBe(200);
    // Phase 3: the courses module is wired into the real app (public catalog, studio analytics behind auth) and the COURSE sellable is registered.
    const base = (await app.getUrl()).replace("[::1]", "localhost");
    expect((await fetch(`${base}/v1/courses`)).status).toBe(200);
    expect((await fetch(`${base}/v1/studio/courses/x/analytics`)).status).toBe(401);
    const { SellableRegistry } = await import("../../src/modules/billing");
    expect(app.get(SellableRegistry).find("COURSE")).toBeDefined();
  });
});
