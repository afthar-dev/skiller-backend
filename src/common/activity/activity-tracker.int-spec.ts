import IORedis, { type Redis } from "ioredis";
import { randomInt, randomUUID } from "node:crypto";
import { FakeClock } from "../../../test/support/fake-clock";
import { addDays } from "../clock/ist";
import { ACTIVITY_TTL_SECONDS, ActivityTracker, activityKey } from "./activity-tracker";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ActivityTracker (Redis HyperLogLog per IST day)", () => {
  let redis: Redis;
  /** A far-away random year: nothing else writes these keys, and a re-run on the same Redis does not meet old data. */
  const base = `${randomInt(2001, 2090)}-0${randomInt(1, 10)}-1${randomInt(0, 9)}`;
  const touched = new Set<string>();
  const keyOf = (day: string) => {
    touched.add(activityKey(day));
    return activityKey(day);
  };

  const trackerAt = (iso: string) => {
    const clock = new FakeClock(new Date(iso));
    return { clock, tracker: new ActivityTracker(redis, clock) };
  };
  /** record() is fire-and-forget; wait until the HLL shows the write. */
  async function flush() {
    await sleep(60);
  }

  beforeAll(() => {
    redis = new IORedis(process.env.REDIS_URL!);
  });
  afterAll(async () => {
    if (touched.size > 0) await redis.del(...touched);
    await redis.quit();
  });

  it("counts each member once a day however often they appear, and expires the day's set after 35 days", async () => {
    const { tracker } = trackerAt(`${base}T10:00:00.000Z`);
    keyOf(base);
    const [a, b] = [randomUUID(), randomUUID()];
    for (let i = 0; i < 5; i++) tracker.record(a);
    tracker.record(b);
    await flush();
    expect(await tracker.daily(base)).toBe(2);
    const ttl = await redis.ttl(activityKey(base));
    expect(ttl).toBeGreaterThan(ACTIVITY_TTL_SECONDS - 60);
    expect(ttl).toBeLessThanOrEqual(ACTIVITY_TTL_SECONDS);
  });

  it("splits days at midnight India time: 23:59:59.999 IST and 00:00:00.000 IST are different days", async () => {
    const day = addDays(base, 3);
    const next = addDays(day, 1);
    keyOf(day);
    keyOf(next);
    const [late, early] = [randomUUID(), randomUUID()];
    // IST = UTC + 05:30, so IST midnight of `next` is (day) 18:30:00Z.
    trackerAt(`${day}T18:29:59.999Z`).tracker.record(late);
    trackerAt(`${day}T18:30:00.000Z`).tracker.record(early);
    await flush();
    const probe = trackerAt(`${day}T00:00:00.000Z`).tracker;
    expect(await probe.daily(day)).toBe(1);
    expect(await probe.daily(next)).toBe(1);
  });

  it("WAU / MAU merge the last 7 / 30 day sets: a member active on several days counts once; a day without a set is skipped; no sets at all is null", async () => {
    const start = addDays(base, 200);
    const regular = randomUUID();
    const oneOff = randomUUID();
    for (let i = 0; i < 10; i++) {
      const day = addDays(start, i);
      keyOf(day);
      trackerAt(`${day}T06:00:00.000Z`).tracker.record(regular);
      if (i === 2) trackerAt(`${day}T06:00:00.000Z`).tracker.record(oneOff);
    }
    await flush();
    const probe = trackerAt(`${start}T00:00:00.000Z`).tracker;
    const end = addDays(start, 9);
    expect(await probe.daily(end)).toBe(1);
    expect(await probe.window(end, 7)).toBe(1); // days 3..9: only `regular`
    expect(await probe.window(end, 30)).toBe(2); // days 0..9 hold `oneOff` on day 2
    expect(await probe.window(addDays(start, 2), 7)).toBe(2);
    expect(await probe.daily(addDays(start, 40))).toBeNull();
    expect(await probe.window(addDays(start, 80), 30)).toBeNull();
    // the temporary merge key is gone
    expect(await redis.keys("activity:tmp:*")).toHaveLength(0);
  });

  it("never throws and never waits for Redis: a broken connection cannot fail the caller", async () => {
    const broken = {
      multi: () => {
        throw new Error("redis down");
      },
    } as unknown as Redis;
    expect(() => new ActivityTracker(broken, new FakeClock()).record(randomUUID())).not.toThrow();
    const rejecting = {
      multi: () => ({ pfadd: () => ({ expire: () => ({ exec: () => Promise.reject(new Error("redis down")) }) }) }),
    } as unknown as Redis;
    const tracker = new ActivityTracker(rejecting, new FakeClock());
    const user = randomUUID();
    tracker.record(user);
    await flush(); // an unhandled rejection would fail the run here
    // a failed write is not remembered as done: the next request tries again
    const calls: string[] = [];
    const recovering = {
      multi: () => ({
        pfadd: (_k: string, u: string) => {
          calls.push(u);
          return { expire: () => ({ exec: () => Promise.resolve([]) }) };
        },
      }),
    } as unknown as Redis;
    const t2 = new ActivityTracker(recovering, new FakeClock());
    t2.record(user);
    t2.record(user);
    expect(calls).toEqual([user]); // one write per member per day per process
  });
});
