import { MediaCleanupProcessor } from "./media-cleanup.processor";

describe("MediaCleanupProcessor (DAT-14)", () => {
  it("never selects assets that are UPLOADED or PROCESSING", async () => {
    const findMany = jest.fn(async () => []);
    const p = new MediaCleanupProcessor({ mediaAsset: { findMany } } as never, null as never, null as never, { now: () => new Date() } as never, null as never);
    await p.process({} as never);
    expect(findMany.mock.calls[0][0].where.status).toEqual({ notIn: ["UPLOADED", "PROCESSING"] });
  });
});
