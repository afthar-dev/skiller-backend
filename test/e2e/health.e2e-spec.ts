import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { applyTestEnv } from "../setup/env";

describe("health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    applyTestEnv();
    const { AppModule } = await import("../../src/app.module");
    const { configureApp } = await import("../../src/bootstrap");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(() => app?.close());

  it("GET /v1/health returns ok", async () => {
    const res = await request(app.getHttpServer()).get("/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it.todo("GET /v1/ready checks DB and Redis (Task 3)");
});
