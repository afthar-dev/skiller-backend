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

  it("documents the money routes and defines Money as an integer-paise string", () => {
    for (const path of ["/v1/checkout", "/v1/wallet/me", "/v1/wallet/payouts", "/v1/admin/finance/summary", "/v1/admin/finance/reconciliation/run", "/v1/admin/coupons", "/v1/coupons/mine", "/v1/webhooks/razorpay", "/v1/webhooks/razorpayx"]) {
      expect(doc.paths[path]).toBeDefined();
    }
    expect(doc.components?.schemas?.Money).toMatchObject({ type: "string", pattern: "^-?[0-9]+$" });
  });

  it("documents every money field as a string: *Paise properties are Money or a string, never a number", () => {
    const offenders: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      const props = obj.properties as Record<string, { type?: string; $ref?: string; allOf?: unknown }> | undefined;
      for (const [name, prop] of Object.entries(props ?? {})) {
        if (/(Paise|^available|^pending|^payoutLocked)$/.test(name) && prop.type !== "string" && prop.$ref !== "#/components/schemas/Money") offenders.push(`${where}.${name}`);
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${where}.${k}`);
    };
    walk(doc, "doc");
    expect(offenders).toEqual([]);
    const wallet = doc.components?.schemas?.Wallet as { properties: { balances: { properties: Record<string, unknown> } } };
    expect(wallet.properties.balances.properties.available).toEqual({ $ref: "#/components/schemas/Money" });
    const me = (doc.paths["/v1/wallet/me"]?.get as { responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> }).responses["200"];
    expect(me.content?.["application/json"]?.schema?.$ref).toBe("#/components/schemas/Wallet");
  });

  it("serves swagger UI at /v1/docs when enabled", async () => {
    const res = await request(app.getHttpServer()).get("/v1/docs-json");
    expect(res.status).toBe(200);
    expect(res.body.paths["/v1/auth/otp/request"]).toBeDefined();
  });
});
