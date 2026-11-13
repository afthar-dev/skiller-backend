import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { OPTIONAL_AUTH_EXTENSION } from "../auth/optional-auth.decorator";
import { errorResponseObject, errorResponseSchema } from "./error-response";
import { adminComponents } from "./admin";
import { gigComponents } from "./gigs";
import { moneyComponents } from "./money";
import { reelComponents } from "./reels";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Scans the app's routes into an OpenAPI 3 document; every operation gets the shared `default` error response. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Skiller API")
    .setDescription("Skiller platform backend. All routes are under /v1. Errors use the shared ErrorResponse envelope.")
    .setVersion("1.0.0")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" })
    .build();
  const doc = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey.replace(/Controller$/, "")}_${methodKey}`,
  });

  doc.components = { ...doc.components, schemas: { ...doc.components?.schemas, ...(moneyComponents as Record<string, never>), ...(reelComponents as Record<string, never>), ...(gigComponents as Record<string, never>), ...(adminComponents as Record<string, never>), ErrorResponse: errorResponseSchema as never } };
  for (const item of Object.values(doc.paths)) {
    for (const method of METHODS) {
      const op = (item as Record<string, ({ responses: Record<string, unknown>; security?: unknown[] } & Record<string, unknown>) | undefined>)[method];
      if (!op) continue;
      op.responses.default ??= errorResponseObject("Error response (see `error.code`).");
      if (op[OPTIONAL_AUTH_EXTENSION]) {
        delete op[OPTIONAL_AUTH_EXTENSION];
        op.security = [{ bearer: [] }, {}];
      }
    }
  }
  return doc;
}

/** Swagger UI at /v1/docs (+ /v1/docs-json). Call before `app.init()`; only enabled outside production. */
export function setupSwagger(app: INestApplication, doc: OpenAPIObject = buildOpenApiDocument(app)) {
  SwaggerModule.setup("docs", app, doc, { useGlobalPrefix: true });
}
