import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { REDIS } from "../../src/common/redis/redis.constants";
import { createTestApp } from "../setup/app";

describe("health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(() => app?.close());

  it("GET /v1/health returns ok", async () => {
    const res = await request(app.getHttpServer()).get("/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("echoes a request id and uses the shared error body for unknown routes", async () => {
    const res = await request(app.getHttpServer()).get("/v1/nope").set("x-request-id", "abc12345-test");
    expect(res.status).toBe(404);
    expect(res.headers["x-request-id"]).toBe("abc12345-test");
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" }, requestId: "abc12345-test" });
  });

  it("GET /v1/ready returns 200 when DB and Redis are up", async () => {
    const res = await request(app.getHttpServer()).get("/v1/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { database: true, redis: true } });
  });

  it("GET /v1/ready returns 503 NOT_READY when Redis check fails", async () => {
    const broken = await createTestApp((b) =>
      b.overrideProvider(REDIS).useValue({ ping: () => Promise.reject(new Error("down")), quit: () => Promise.resolve("OK") }),
    );
    try {
      const res = await request(broken.getHttpServer()).get("/v1/ready");
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("NOT_READY");
      expect(res.body.error.details.checks).toEqual({ database: true, redis: false });
    } finally {
      await broken.close();
    }
  });
});
