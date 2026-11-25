import { PRUNE_RULES, PruneProcessor, retentionDays } from "./prune.processor";

describe("PruneProcessor (DAT-10)", () => {
  const NOW = new Date("2026-11-25T00:00:00Z");

  it("deletes each table in batches with the retention cutoff bound as a parameter, and keeps going until a short batch", async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const counts = [5000, 12, 0, 0, 0, 0, 0];
    const prisma = { $executeRaw: async (strings: TemplateStringsArray & { sql?: string }, ...values: unknown[]) => { void strings; calls.push({ sql: "", values }); return counts.shift() ?? 0; } };
    const p = new PruneProcessor(prisma as never, { register: () => undefined } as never, { now: () => NOW } as never, null as never);
    const out = await p.process();
    expect(out["outbox_events"]).toBe(5012); // two batches: a full one, then a short one
    expect(Object.keys(out)).toEqual(PRUNE_RULES.map((r) => r.table));
    const flat = (vs: unknown[]): unknown[] => vs.flatMap((v) => (v && typeof v === "object" && "values" in v ? flat((v as { values: unknown[] }).values) : [v]));
    const cutoff = flat(calls[0]!.values).find((v) => v instanceof Date) as Date;
    expect(cutoff.toISOString()).toBe("2026-11-18T00:00:00.000Z"); // outbox: 7 days
  });

  it("retention is configurable by env and ignores nonsense", () => {
    const rule = PRUNE_RULES[0]!;
    expect(retentionDays(rule, {})).toBe(7);
    expect(retentionDays(rule, { PRUNE_OUTBOX_DAYS: "30" })).toBe(30);
    expect(retentionDays(rule, { PRUNE_OUTBOX_DAYS: "0" })).toBe(7);
    expect(retentionDays(rule, { PRUNE_OUTBOX_DAYS: "abc" })).toBe(7);
  });

  it("never touches unpublished or dead outbox rows, unread notifications or unprocessed webhooks", () => {
    const where = (t: string) => PRUNE_RULES.find((r) => r.table === t)!.where;
    expect(where("outbox_events")).toContain(`"publishedAt" IS NOT NULL`);
    expect(where("notifications")).toContain(`"readAt" IS NOT NULL`);
    expect(where("webhook_events")).toContain(`"processedAt" IS NOT NULL`);
  });
});
