import { PlaybackService } from "./playback.service";

describe("PlaybackService.grant: missing and forbidden look the same", () => {
  const asset = { id: "a1", bucket: "PRIVATE", purpose: "COURSE_LESSON", status: "READY" };
  const build = (found: unknown, allow: boolean) => {
    const prisma = { mediaAsset: { findUnique: jest.fn().mockResolvedValue(found) } };
    const policy = { canPlay: jest.fn().mockResolvedValue(allow), canPlayAnonymously: jest.fn().mockResolvedValue(allow) };
    return new PlaybackService(prisma as never, {} as never, [policy] as never, {} as never, { now: () => new Date() } as never, { eval: jest.fn().mockResolvedValue([1, 0]) } as never);
  };
  const failure = (p: Promise<unknown>) => p.catch((e: unknown) => e) as Promise<{ code: string; status: number; message: string }>;

  it("a missing asset and an asset the caller may not play give the identical 404 MEDIA_NOT_FOUND, signed in or not", async () => {
    const missing = await failure(build(null, true).grant("u1", "a1"));
    for (const userId of ["u1", null]) {
      const denied = await failure(build(asset, false).grant(userId, "a1"));
      expect(denied).toMatchObject({ code: "MEDIA_NOT_FOUND", status: 404, message: missing.message });
    }
    expect(missing).toMatchObject({ code: "MEDIA_NOT_FOUND", status: 404 });
  });
});
