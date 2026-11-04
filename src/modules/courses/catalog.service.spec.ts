import { Prisma } from "@prisma/client";
import type { AppConfig } from "../../common/config/config.schema";
import type { PrismaService } from "../../common/prisma/prisma.service";
import { CatalogCursor } from "./catalog-cursor";
import { CatalogService } from "./catalog.service";

const cursor = new CatalogCursor({ jwtSecret: "s".repeat(40) } as AppConfig);
const failing = (meta: Record<string, unknown>) =>
  ({ $queryRaw: jest.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("raw query failed", { code: "P2010", clientVersion: "x", meta })) }) as unknown as PrismaService;

describe("CatalogService database errors", () => {
  it.each(["22003", "22007", "22008", "22P02"])("answers 400 BAD_CURSOR when Postgres refuses a value (%s)", async (code) => {
    const service = new CatalogService(failing({ code, message: "out of range" }), cursor);
    await expect(service.search({ sort: "newest", limit: 5 })).rejects.toMatchObject({ code: "BAD_CURSOR", status: 400 });
  });

  it("lets other database errors through", async () => {
    const service = new CatalogService(failing({ code: "57014", message: "canceled" }), cursor);
    await expect(service.search({ sort: "newest", limit: 5 })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});
