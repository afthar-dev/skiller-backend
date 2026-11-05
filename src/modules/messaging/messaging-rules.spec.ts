import { toMessageView } from "./message-view";
import { MESSAGE_MAX, MESSAGES_PER_HOUR, NEW_CONVERSATIONS_PER_DAY, pairKeyOf } from "./messaging-rules";

describe("messaging rules", () => {
  it("the pair key is the same whoever starts the conversation", () => {
    expect(pairKeyOf("b-user", "a-user")).toBe("a-user:b-user");
    expect(pairKeyOf("a-user", "b-user")).toBe(pairKeyOf("b-user", "a-user"));
    expect(pairKeyOf("a", "b")).not.toBe(pairKeyOf("a", "c"));
  });

  it("keeps the agreed limits", () => {
    expect([MESSAGE_MAX, NEW_CONVERSATIONS_PER_DAY, MESSAGES_PER_HOUR]).toEqual([4000, 20, 60]);
  });

  it("a message shows its text only while it is VISIBLE", () => {
    const m = { id: "1", conversationId: "c", senderId: "u", body: "secret words", createdAt: new Date("2026-11-05T00:00:00Z") };
    expect(toMessageView({ ...m, status: "VISIBLE" })).toMatchObject({ body: "secret words", status: "VISIBLE" });
    for (const status of ["HIDDEN", "REMOVED"] as const) {
      const view = toMessageView({ ...m, status });
      expect(view).toMatchObject({ body: null, status });
      expect(JSON.stringify(view)).not.toContain("secret");
    }
  });
});
