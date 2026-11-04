import { SignedCursor } from "./signed-cursor";

describe("SignedCursor", () => {
  const cursors = new SignedCursor("a-secret-of-at-least-thirty-two-characters");

  it("round-trips a payload for its own context", () => {
    const raw = cursors.sign("profile-reels", { t: "2026-11-04T10:00:00.000Z", id: "abc" });
    expect(cursors.verify("profile-reels", raw)).toEqual({ t: "2026-11-04T10:00:00.000Z", id: "abc" });
  });

  it("refuses a cursor made for another list, a tampered one and a forged one", () => {
    const raw = cursors.sign("profile-reels", { t: "x", id: "1" });
    expect(() => cursors.verify("saved-reels", raw)).toThrow(expect.objectContaining({ code: "BAD_CURSOR", status: 400 }));
    const [body, sig] = raw.split(".");
    const forged = Buffer.from(JSON.stringify({ t: "y", id: "1" })).toString("base64url");
    expect(() => cursors.verify("profile-reels", `${forged}.${sig}`)).toThrow(expect.objectContaining({ code: "BAD_CURSOR" }));
    expect(() => cursors.verify("profile-reels", `${body}.AAAA`)).toThrow(expect.objectContaining({ code: "BAD_CURSOR" }));
    expect(() => cursors.verify("profile-reels", "garbage")).toThrow(expect.objectContaining({ code: "BAD_CURSOR" }));
    expect(() => new SignedCursor("another-secret-of-at-least-thirty-two").verify("profile-reels", raw)).toThrow(expect.objectContaining({ code: "BAD_CURSOR" }));
  });
});
