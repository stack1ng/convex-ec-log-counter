/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";

const config = {
  compactionDelay: 15_000,
  compactionLeaseDuration: 60_000,
};

function setup() {
  return convexTest(schema, modules);
}

// Advance timers one at a time so scheduled functions observe a clock
// consistent with their scheduling order (jumping the whole timeline at once
// would expire every lease before its chain ran).
async function drain(t: ReturnType<typeof setup>) {
  const finish = t.finishAllScheduledFunctions as (
    advanceTimers: () => void,
    maxIterations?: number,
  ) => Promise<void>;
  await finish(() => vi.advanceTimersToNextTimer(), 10_000);
}

async function insertLogs(
  t: ReturnType<typeof setup>,
  key: string,
  deltas: number[],
) {
  await t.run(async (ctx) => {
    for (const delta of deltas) {
      await ctx.db.insert("counter_logs", { key, delta });
    }
  });
}

async function insertLease(
  t: ReturnType<typeof setup>,
  key: string,
  expiresAt: number,
): Promise<Id<"compaction_leases">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("compaction_leases", { key, expires_at: expiresAt }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("signalNeedCompaction", () => {
  test("is idempotent while a lease is active", async () => {
    const t = setup();
    await insertLogs(t, "k", [1]);
    await t.mutation(internal.compaction.signalNeedCompaction, {
      key: "k",
      ...config,
    });
    await t.mutation(internal.compaction.signalNeedCompaction, {
      key: "k",
      ...config,
    });
    const leases = await t.run(async (ctx) =>
      ctx.db.query("compaction_leases").collect(),
    );
    expect(leases).toHaveLength(1);
  });

  test("reaps expired lease rows before creating a new one", async () => {
    const t = setup();
    const now = Date.now();
    await insertLease(t, "k", now - 10_000);
    await insertLease(t, "k", now - 5_000);
    await insertLogs(t, "k", [1]);
    await t.mutation(internal.compaction.signalNeedCompaction, {
      key: "k",
      ...config,
    });
    const leases = await t.run(async (ctx) =>
      ctx.db.query("compaction_leases").collect(),
    );
    expect(leases).toHaveLength(1);
    expect(leases[0].expires_at).toBeGreaterThan(now);
  });
});

describe("cursor-boundary batching", () => {
  test("getCompactLogSet reports the page size up to numItems", async () => {
    const t = setup();
    await insertLogs(t, "k", [1, 2, 3, 4, 5]);
    const boundary = await t.query(internal.compaction.getCompactLogSet, {
      key: "k",
      numItems: 2,
    });
    expect(boundary.pageSize).toBe(2);
    expect(boundary.isDone).toBe(false);
  });

  test("compactLogSet folds exactly the bounded range and continues the chain", async () => {
    const t = setup();
    await insertLogs(t, "k", [1, 2, 4, 8, 16]);
    const lease = await insertLease(t, "k", Date.now() + 60_000);
    const boundary = await t.query(internal.compaction.getCompactLogSet, {
      key: "k",
      numItems: 3,
    });
    await t.mutation(internal.compaction.compactLogSet, {
      key: "k",
      lease,
      pageSize: boundary.pageSize,
      moreLogsExist: !boundary.isDone,
      ...config,
    });

    await t.run(async (ctx) => {
      const logs = await ctx.db.query("counter_logs").collect();
      const snapshots = await ctx.db.query("counter_snapshots").collect();
      // First three logs (1 + 2 + 4) folded; the rest untouched.
      expect(snapshots[0]).toMatchObject({ key: "k", count: 7 });
      expect(logs.map((l) => l.delta).sort((a, b) => a - b)).toEqual([8, 16]);
      // Chain continues: lease still held (renewed), not deleted.
      expect(await ctx.db.get("compaction_leases", lease)).not.toBeNull();
    });

    // Drain the scheduled continuation: everything compacts, lease released.
    await drain(t);
    expect(await t.query(api.public.read, { key: "k" })).toEqual({
      count: 31,
      fullyConsistent: true,
    });
    const leases = await t.run(async (ctx) =>
      ctx.db.query("compaction_leases").collect(),
    );
    expect(leases).toHaveLength(0);
  });

  test("writes committed after the boundary are not folded by that batch", async () => {
    const t = setup();
    await insertLogs(t, "k", [1, 2]);
    const lease = await insertLease(t, "k", Date.now() + 60_000);
    const boundary = await t.query(internal.compaction.getCompactLogSet, {
      key: "k",
      numItems: 10,
    });
    // A "concurrent" append lands after the boundary was taken.
    await insertLogs(t, "k", [100]);
    await t.mutation(internal.compaction.compactLogSet, {
      key: "k",
      lease,
      pageSize: boundary.pageSize,
      moreLogsExist: !boundary.isDone,
      ...config,
    });

    await t.run(async (ctx) => {
      const snapshots = await ctx.db.query("counter_snapshots").collect();
      const logs = await ctx.db.query("counter_logs").collect();
      expect(snapshots[0]).toMatchObject({ key: "k", count: 3 });
      // The straggler survives as a log (the end-of-chain recheck would
      // compact it later).
      expect(logs.map((l) => l.delta)).toEqual([100]);
    });
    // Reads still see the full total.
    expect((await t.query(api.public.read, { key: "k" })).count).toBe(103);
  });
});

describe("lease fencing", () => {
  test("compactLogSet whose lease row was reaped throws and leaves logs untouched", async () => {
    const t = setup();
    await insertLogs(t, "k", [1, 2, 3]);
    const lease = await insertLease(t, "k", Date.now() + 60_000);
    const boundary = await t.query(internal.compaction.getCompactLogSet, {
      key: "k",
      numItems: 10,
    });
    // A takeover (signal reap or watchdog) deletes the row, fencing out the
    // old chain before it touches any logs.
    await t.run(async (ctx) => ctx.db.delete("compaction_leases", lease));
    await expect(
      t.mutation(internal.compaction.compactLogSet, {
        key: "k",
        lease,
        pageSize: boundary.pageSize,
        moreLogsExist: !boundary.isDone,
        ...config,
      }),
    ).rejects.toThrow(/no longer valid/);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("counter_logs").collect()).toHaveLength(3);
      expect(await ctx.db.query("counter_snapshots").collect()).toHaveLength(0);
    });
  });

  test("an expired-but-unreaped lease still owns the key: the chain completes", async () => {
    const t = setup();
    await insertLogs(t, "k", [5, 6]);
    // Ownership is the row's existence; expiry only permits takeover.
    const lease = await insertLease(t, "k", Date.now() - 1_000);
    const boundary = await t.query(internal.compaction.getCompactLogSet, {
      key: "k",
      numItems: 10,
    });
    await t.mutation(internal.compaction.compactLogSet, {
      key: "k",
      lease,
      pageSize: boundary.pageSize,
      moreLogsExist: !boundary.isDone,
      ...config,
    });
    await drain(t);
    expect(await t.query(api.public.read, { key: "k" })).toEqual({
      count: 11,
      fullyConsistent: true,
    });
  });

  test("a signal reaps an expired lease, fencing out its chain", async () => {
    const t = setup();
    await insertLogs(t, "k", [7]);
    const expired = await insertLease(t, "k", Date.now() - 1_000);
    await t.mutation(internal.compaction.signalNeedCompaction, {
      key: "k",
      ...config,
    });
    await t.run(async (ctx) => {
      // The expired lease is gone, replaced by the new chain's lease.
      expect(await ctx.db.get("compaction_leases", expired)).toBeNull();
      const leases = await ctx.db.query("compaction_leases").collect();
      expect(leases).toHaveLength(1);
      expect(leases[0].expires_at).toBeGreaterThan(Date.now());
    });
  });
});

describe("watchdog", () => {
  test("no-ops when the lease row is already gone", async () => {
    const t = setup();
    const lease = await insertLease(t, "k", Date.now() + 60_000);
    await t.run(async (ctx) => ctx.db.delete("compaction_leases", lease));
    await t.mutation(internal.compaction.watchdogLease, {
      key: "k",
      lease,
      ...config,
    });
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.filter((f) => f.state.kind === "pending")).toHaveLength(0);
  });

  test("re-watches while the lease is still active", async () => {
    const t = setup();
    const lease = await insertLease(t, "k", Date.now() + 30_000);
    await t.mutation(internal.compaction.watchdogLease, {
      key: "k",
      lease,
      ...config,
    });
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const pending = scheduled.filter((f) => f.state.kind === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toContain("watchdogLease");
    // The lease is untouched.
    const row = await t.run(async (ctx) =>
      ctx.db.get("compaction_leases", lease),
    );
    expect(row).not.toBeNull();
    // Let the re-scheduled watchdog run to completion so nothing leaks.
    await t.run(async (ctx) => ctx.db.delete("compaction_leases", lease));
    await drain(t);
  });

  test("does not steal an expired lease while its chain's job is still pending", async () => {
    const t = setup();
    await insertLogs(t, "k", [1]);
    // Start a real chain so the lease records its scheduled compactLogs job.
    await t.mutation(internal.compaction.signalNeedCompaction, {
      key: "k",
      ...config,
    });
    const lease = await t.run(async (ctx) => {
      const rows = await ctx.db.query("compaction_leases").collect();
      // Simulate the lease expiring while the scheduled job hasn't run yet
      // (e.g. severe scheduler backlog).
      await ctx.db.patch("compaction_leases", rows[0]._id, {
        expires_at: Date.now() - 1,
      });
      return rows[0]._id;
    });
    await t.mutation(internal.compaction.watchdogLease, {
      key: "k",
      lease,
      ...config,
    });
    // The lease was NOT stolen; a re-watch was scheduled instead.
    await t.run(async (ctx) => {
      expect(await ctx.db.get("compaction_leases", lease)).not.toBeNull();
      const pending = (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter((f) => f.state.kind === "pending");
      expect(pending.some((f) => f.name.includes("watchdogLease"))).toBe(true);
    });
    // Draining lets the slow chain finish normally.
    await drain(t);
    expect(await t.query(api.public.read, { key: "k" })).toEqual({
      count: 1,
      fullyConsistent: true,
    });
  });

  test("recovers a dead chain: reaps the expired lease and compacts the backlog", async () => {
    const t = setup();
    // Simulate a chain that died: logs exist, the lease expired in place
    // with no live scheduled job (no `job` recorded).
    await insertLogs(t, "k", [3, 4]);
    const lease = await insertLease(t, "k", Date.now() - 1);
    await t.mutation(internal.compaction.watchdogLease, {
      key: "k",
      lease,
      ...config,
    });
    await drain(t);

    expect(await t.query(api.public.read, { key: "k" })).toEqual({
      count: 7,
      fullyConsistent: true,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("counter_logs").collect()).toHaveLength(0);
      expect(await ctx.db.query("compaction_leases").collect()).toHaveLength(0);
      expect(await ctx.db.query("counter_snapshots").collect()).toHaveLength(1);
    });
  });

  test("end-to-end: every add leaves a watchdog that terminates cleanly", async () => {
    const t = setup();
    await t.mutation(api.public.add, { key: "k", delta: 1 });
    // Before draining, both the compaction and its watchdog are scheduled.
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.some((f) => f.name.includes("signalNeedCompaction")),
    ).toBe(true);
    await drain(t);
    // After draining, nothing is pending and no lease remains.
    const after = await t.run(async (ctx) => ({
      pending: (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((f) => f.state.kind === "pending"),
      leases: await ctx.db.query("compaction_leases").collect(),
    }));
    expect(after.pending).toHaveLength(0);
    expect(after.leases).toHaveLength(0);
  });
});

describe("signal fan-out", () => {
  test("signalNeedCompactionMany chunks batches over the fan-out size", async () => {
    const t = setup();
    // SIGNAL_FANOUT_BATCH_SIZE is 400; 403 keys force one reschedule.
    const keys = Array.from({ length: 403 }, (_, i) => `k${i}`);
    await t.mutation(internal.compaction.signalNeedCompactionMany, {
      keys,
      ...config,
    });

    await t.run(async (ctx) => {
      // First 400 keys got leases; the remaining 3 ride a rescheduled call.
      const leases = await ctx.db.query("compaction_leases").collect();
      expect(leases).toHaveLength(400);
      const pending = (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter((f) => f.state.kind === "pending");
      const fanOut = pending.filter((f) =>
        f.name.includes("signalNeedCompactionMany"),
      );
      expect(fanOut).toHaveLength(1);
      expect((fanOut[0].args[0] as { keys: string[] }).keys).toHaveLength(3);
    });
  });

  test("addMany end-to-end compacts every key through the fan-out", async () => {
    const t = setup();
    const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
    await t.mutation(api.public.addMany, {
      deltas: keys.map((key, i) => ({ key, delta: i })),
    });
    await drain(t);

    const snapshots = await t.run(async (ctx) =>
      ctx.db.query("counter_snapshots").collect(),
    );
    // Key k0 has delta 0 — compaction still folds it (snapshot count 0).
    expect(snapshots).toHaveLength(12);
    const logs = await t.run(async (ctx) =>
      ctx.db.query("counter_logs").collect(),
    );
    expect(logs).toHaveLength(0);
  }, 60_000);
});

describe("releaseLeaseAndRecheck", () => {
  test("tolerates an already-deleted lease", async () => {
    const t = setup();
    const lease = await insertLease(t, "k", Date.now() + 60_000);
    await t.run(async (ctx) => ctx.db.delete("compaction_leases", lease));
    // Should not throw.
    await t.mutation(internal.compaction.releaseLeaseAndRecheck, {
      key: "k",
      lease,
      ...config,
    });
  });

  test("re-signals when logs remain", async () => {
    const t = setup();
    await insertLogs(t, "k", [2]);
    const lease = await insertLease(t, "k", Date.now() + 60_000);
    await t.mutation(internal.compaction.releaseLeaseAndRecheck, {
      key: "k",
      lease,
      ...config,
    });
    await drain(t);
    expect(await t.query(api.public.read, { key: "k" })).toEqual({
      count: 2,
      fullyConsistent: true,
    });
    const logs = await t.run(async (ctx) =>
      ctx.db.query("counter_logs").collect(),
    );
    expect(logs).toHaveLength(0);
  });
});
