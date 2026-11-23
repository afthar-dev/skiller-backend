import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/prisma/prisma.service";
import { NotificationsService } from "./notifications.service";
import { PrismaClient } from "@prisma/client";

describe("NotificationsService.notify dedupe (DAT-1)", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const service = new NotificationsService(prisma as unknown as PrismaService, {} as never, { send: jest.fn() } as never, {} as never, {} as never);

  afterAll(() => prisma.$disconnect());

  const input = (type: "media.ready" | "reel.limit_reached", sourceEventId: string) => ({ type, title: type, body: type, sourceEventId }) as never;

  it("two handlers of one event both land; a redelivery of the same handler does not duplicate", async () => {
    const user = await prisma.user.create({ data: { email: `ntf-${randomUUID()}@example.com` } });
    const eventId = randomUUID();
    await service.notify(user.id, input("media.ready", eventId));
    await service.notify(user.id, input("reel.limit_reached" as never, eventId));
    await service.notify(user.id, input("media.ready", eventId));
    await service.notify(user.id, input("reel.limit_reached" as never, eventId));
    const rows = await prisma.notification.findMany({ where: { userId: user.id, sourceEventId: eventId }, orderBy: { type: "asc" } });
    expect(rows.map((r) => r.type)).toEqual(["media.ready", "reel.limit_reached"]);
  });
});
