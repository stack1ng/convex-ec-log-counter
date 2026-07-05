/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { test as fcTest, fc } from "@fast-check/vitest";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { api } from "./_generated/api.js";

function setup() {
  return convexTest(schema, modules);
}

// Drives all pending scheduled work (compaction chains, watchdogs) to
// completion under fake timers. Timers advance one at a time so scheduled
// functions observe a clock consistent with their scheduling order (jumping
// the whole timeline at once would expire every lease before its chain ran).
async function drain(t: ReturnType<typeof setup>) {
  const finish = t.finishAllScheduledFunctions as (
    advanceTimers: () => void,
    maxIterations?: number,
  ) => Promise<void>;
  await finish(() => vi.advanceTimersToNextTimer(), 10_000);
}

// Fake timers everywhere: scheduled compaction work only ever runs inside
// drain(), never in the background of an unrelated assertion.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("read without compaction", () => {
  test("missing key reads 0 and is fully consistent", async () => {
    const t = setup();
    expect(await t.query(api.public.read, { key: "nope" })).toEqual({
      count: 0,
      fullyConsistent: true,
    });
  });

  test("uncompacted adds are visible to reads by default", async () => {
    const t = setup();
    await t.mutation(api.public.add, { key: "k", delta: 1 });
    await t.mutation(api.public.add, { key: "k", delta: 2 });
    await t.mutation(api.public.add, { key: "k", delta: 3 });
    expect(await t.query(api.public.read, { key: "k" })).toEqual({
      count: 6,
      fullyConsistent: true,
    });
  });

  test("negative and fractional deltas", async () => {
    const t = setup();
    await t.mutation(api.public.add, { key: "k", delta: 10 });
    await t.mutation(api.public.add, { key: "k", delta: -4 });
    await t.mutation(api.public.add, { key: "k", delta: 0.5 });
    const { count } = await t.query(api.public.read, { key: "k" });
    expect(count).toBeCloseTo(6.5);
  });

  test("keys are independent", async () => {
    const t = setup();
    await t.mutation(api.public.add, { key: "a", delta: 1 });
    await t.mutation(api.public.add, { key: "b", delta: 2 });
    expect((await t.query(api.public.read, { key: "a" })).count).toBe(1);
    expect((await t.query(api.public.read, { key: "b" })).count).toBe(2);
  });

  test("logScanLimit: 0 reads the snapshot only and is not fully consistent", async () => {
    const t = setup();
    await t.mutation(api.public.add, { key: "k", delta: 5 });
    expect(
      await t.query(api.public.read, { key: "k", logScanLimit: 0 }),
    ).toEqual({
      count: 0,
      fullyConsistent: false,
    });
  });

  test("logScanLimit smaller than the backlog counts a prefix and flags inconsistency", async () => {
    const t = setup();
    for (let i = 1; i <= 5; i++) {
      await t.mutation(api.public.add, { key: "k", delta: i });
    }
    // Logs scan in insertion (creation-time) order: 1 + 2 = 3.
    expect(
      await t.query(api.public.read, { key: "k", logScanLimit: 2 }),
    ).toEqual({
      count: 3,
      fullyConsistent: false,
    });
  });
});

describe("input validation", () => {
  test.each([NaN, Infinity, -Infinity])(
    "add rejects non-finite delta %p",
    async (delta) => {
      const t = setup();
      await expect(
        t.mutation(api.public.add, { key: "k", delta }),
      ).rejects.toThrow(/finite/);
      // Nothing was written.
      expect(await t.query(api.public.read, { key: "k" })).toEqual({
        count: 0,
        fullyConsistent: true,
      });
    },
  );

  test("addMany rejects non-finite deltas atomically", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public.addMany, {
        deltas: [
          { key: "a", delta: 1 },
          { key: "b", delta: NaN },
        ],
      }),
    ).rejects.toThrow(/finite/);
    expect((await t.query(api.public.read, { key: "a" })).count).toBe(0);
  });
});

describe("addMany", () => {
  test("empty batch is a no-op", async () => {
    const t = setup();
    await t.mutation(api.public.addMany, { deltas: [] });
    const logs = await t.run(async (ctx) => ctx.db.query("counter_logs").collect());
    expect(logs).toHaveLength(0);
  });

  test("applies deltas across keys, including repeats", async () => {
    const t = setup();
    await t.mutation(api.public.addMany, {
      deltas: [
        { key: "a", delta: 1 },
        { key: "b", delta: 10 },
        { key: "a", delta: 2 },
      ],
    });
    expect((await t.query(api.public.read, { key: "a" })).count).toBe(3);
    expect((await t.query(api.public.read, { key: "b" })).count).toBe(10);
  });
});

describe("compaction", () => {
  test("folds logs into the snapshot and cleans up after itself", async () => {
    const t = setup();
    await t.mutation(api.public.add, { key: "k", delta: 1 });
    await t.mutation(api.public.add, { key: "k", delta: 2 });
    await t.mutation(api.public.add, { key: "k", delta: 39 });
    await drain(t);

    await t.run(async (ctx) => {
      const logs = await ctx.db.query("counter_logs").collect();
      const snapshots = await ctx.db.query("counter_snapshots").collect();
      const leases = await ctx.db.query("compaction_leases").collect();
      expect(logs).toHaveLength(0);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ key: "k", count: 42 });
      expect(leases).toHaveLength(0);
    });
    expect(await t.query(api.public.read, { key: "k" })).toEqual({
      count: 42,
      fullyConsistent: true,
    });
    // Snapshot-only reads are now exact too (though conservatively flagged).
    expect(
      (await t.query(api.public.read, { key: "k", logScanLimit: 0 })).count,
    ).toBe(42);
  });

  test("compacts multiple keys from one addMany batch", async () => {
    const t = setup();
    const keys = Array.from({ length: 25 }, (_, i) => `k${i}`);
    await t.mutation(api.public.addMany, {
      deltas: keys.map((key, i) => ({ key, delta: i + 1 })),
    });
    await drain(t);

    for (const [i, key] of keys.entries()) {
      expect(await t.query(api.public.read, { key })).toEqual({
        count: i + 1,
        fullyConsistent: true,
      });
    }
    const snapshots = await t.run(async (ctx) =>
      ctx.db.query("counter_snapshots").collect(),
    );
    expect(snapshots).toHaveLength(25);
  });

  test("later writes are picked up by subsequent compactions", async () => {
    const t = setup();
    await t.mutation(api.public.add, { key: "k", delta: 5 });
    await drain(t);
    await t.mutation(api.public.add, { key: "k", delta: -2 });
    await drain(t);

    const snapshots = await t.run(async (ctx) =>
      ctx.db.query("counter_snapshots").collect(),
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ key: "k", count: 3 });
  });

  test("a signal without any logs terminates without leaving state behind", async () => {
    const t = setup();
    await t.mutation(api.public.add, { key: "k", delta: 1 });
    await drain(t);
    // The straggler recheck at the end of the chain already ran; verify no
    // leases or scheduled work is left.
    const leases = await t.run(async (ctx) =>
      ctx.db.query("compaction_leases").collect(),
    );
    expect(leases).toHaveLength(0);
  });
});

describe("reset", () => {
  test("clears logs, snapshot, and leases for a key", async () => {
    const t = setup();
    await t.mutation(api.public.add, { key: "k", delta: 7 });
    await drain(t); // snapshot exists now
    await t.mutation(api.public.add, { key: "k", delta: 3 }); // pending log
    await t.mutation(api.public.reset, { key: "k" });
    await drain(t);

    expect(await t.query(api.public.read, { key: "k" })).toEqual({
      count: 0,
      fullyConsistent: true,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("counter_logs").collect()).toHaveLength(0);
      expect(await ctx.db.query("counter_snapshots").collect()).toHaveLength(0);
    });
  });

  test("does not touch other keys", async () => {
    const t = setup();
    await t.mutation(api.public.add, { key: "keep", delta: 9 });
    await t.mutation(api.public.add, { key: "drop", delta: 5 });
    await t.mutation(api.public.reset, { key: "drop" });
    await drain(t);

    expect((await t.query(api.public.read, { key: "keep" })).count).toBe(9);
    expect((await t.query(api.public.read, { key: "drop" })).count).toBe(0);
  });
});

describe("randomized model check", () => {
  fcTest.prop(
    {
      ops: fc.array(
        fc.record({
          key: fc.constantFrom("a", "b", "c"),
          delta: fc
            .integer({ min: -10_000, max: 10_000 })
            .map((i) => i / 100),
          compact: fc.boolean(),
        }),
        { maxLength: 40 },
      ),
    },
    { numRuns: 10 },
  )(
    "counter matches an in-memory reference across adds and compactions",
    async ({ ops }) => {
      const t = setup();
      const reference = new Map<string, number>();
      for (const { key, delta, compact } of ops) {
        if (!Number.isFinite(delta)) continue;
        reference.set(key, (reference.get(key) ?? 0) + delta);
        await t.mutation(api.public.add, { key, delta });
        if (compact) await drain(t);
        const { count } = await t.query(api.public.read, { key });
        expect(count).toBeCloseTo(reference.get(key)!, 8);
      }
      await drain(t);
      for (const [key, value] of reference.entries()) {
        const result = await t.query(api.public.read, { key });
        expect(result.count).toBeCloseTo(value, 8);
        expect(result.fullyConsistent).toBe(true);
      }
      // Everything is compacted: no logs or leases remain.
      await t.run(async (ctx) => {
        expect(await ctx.db.query("counter_logs").collect()).toHaveLength(0);
        expect(await ctx.db.query("compaction_leases").collect()).toHaveLength(
          0,
        );
      });
    },
  );
});
