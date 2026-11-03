import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { buildOpenApiDocument, setupSwagger } from "../../src/common/openapi/openapi";
import { createTestApp } from "../setup/app";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const ERROR_REF = "#/components/schemas/ErrorResponse";

type Operation = { security?: unknown[]; responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> };

describe("openapi", () => {
  let app: INestApplication;
  let doc: ReturnType<typeof buildOpenApiDocument>;
  const operations: Array<{ id: string; op: Operation }> = [];

  beforeAll(async () => {
    app = await createTestApp(undefined, {}, (instance) => {
      doc = buildOpenApiDocument(instance);
      setupSwagger(instance, doc);
    });
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of METHODS) {
        const op = (item as Record<string, Operation | undefined>)[method];
        if (op) operations.push({ id: `${method.toUpperCase()} ${path}`, op });
      }
    }
  });

  afterAll(() => app?.close());

  it("documents the OTP request route under /v1", () => {
    expect(doc.paths["/v1/auth/otp/request"]?.post).toBeDefined();
  });

  it("defines the shared ErrorResponse schema", () => {
    expect(doc.components?.schemas?.ErrorResponse).toMatchObject({ type: "object", required: ["error", "requestId"] });
  });

  it("gives every operation a default error response referencing ErrorResponse", () => {
    expect(operations.length).toBeGreaterThan(40);
    const missing = operations.filter(({ op }) => op.responses.default?.content?.["application/json"]?.schema?.$ref !== ERROR_REF).map((o) => o.id);
    expect(missing).toEqual([]);
  });

  it("gives every authenticated operation a 401 referencing ErrorResponse", () => {
    const authed = operations.filter(({ op }) => op.security?.length);
    expect(authed.length).toBeGreaterThan(30);
    const missing = authed.filter(({ op }) => op.responses["401"]?.content?.["application/json"]?.schema?.$ref !== ERROR_REF).map((o) => o.id);
    expect(missing).toEqual([]);
  });

  it("marks public routes as unauthenticated", () => {
    const op = doc.paths["/v1/auth/otp/request"]?.post as Operation;
    expect(op.security).toBeUndefined();
  });

  it("documents request bodies for validated routes", () => {
    const post = doc.paths["/v1/media/uploads"]?.post as { requestBody?: { content: Record<string, { schema: { properties?: Record<string, unknown> } }> } };
    expect(post.requestBody?.content["application/json"].schema.properties).toHaveProperty("purpose");
  });

  it("serves swagger UI at /v1/docs when enabled", async () => {
    const res = await request(app.getHttpServer()).get("/v1/docs-json");
    expect(res.status).toBe(200);
    expect(res.body.paths["/v1/auth/otp/request"]).toBeDefined();
  });
});
