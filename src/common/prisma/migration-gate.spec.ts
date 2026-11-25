import { pendingMigrations, waitForMigrations } from "./migration-gate";

const db = (applied: () => string[]) => ({ $queryRaw: async () => applied().map((migration_name) => ({ migration_name })) }) as never;

describe("migration gate (DAT-5)", () => {
  it("lists bundled migrations the database has not applied", async () => {
    await expect(pendingMigrations(db(() => ["a"]), ["a", "b"])).resolves.toEqual(["b"]);
  });

  it("waits until the missing migration is applied, then returns", async () => {
    let applied = ["a"];
    let sleeps = 0;
    await waitForMigrations(db(() => applied), { bundled: ["a", "b"], sleep: async () => void (++sleeps === 2 && (applied = ["a", "b"])) });
    expect(sleeps).toBe(2);
  });

  it("throws after the timeout so the process exits and is restarted", async () => {
    await expect(waitForMigrations(db(() => []), { bundled: ["a"], timeoutMs: 0, sleep: async () => undefined })).rejects.toThrow(/missing migrations: a/);
  });

  it("does nothing when no migrations are bundled", async () => {
    await expect(waitForMigrations(db(() => []), { bundled: [] })).resolves.toBeUndefined();
  });
});
