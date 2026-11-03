import { INestApplication } from "@nestjs/common";
import request from "supertest";
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

  it.todo("GET /v1/ready checks DB and Redis (Task 3)");
});
