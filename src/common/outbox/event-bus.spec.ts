import { EventBus } from "./event-bus";

describe("EventBus", () => {
  it("passes the delivered event id to handlers", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on("user.became_creator", async (_e, { eventId }) => {
      seen.push(eventId);
    });
    await bus.dispatch({ type: "user.became_creator", userId: "u1" }, "evt-1");
    expect(seen).toEqual(["evt-1"]);
  });

  it("derives a stable content-hash id when none is given, so a repeated dispatch is a redelivery", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on("user.became_creator", async (_e, { eventId }) => {
      seen.push(eventId);
    });
    await bus.dispatch({ type: "user.became_creator", userId: "u1" });
    await bus.dispatch({ type: "user.became_creator", userId: "u1" });
    await bus.dispatch({ type: "user.became_creator", userId: "u2" });
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
  });
});
