import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";
import { paginator } from "convex-helpers/server/pagination";
import { getSnapshot } from "./shared.js";

// How many log rows one compaction transaction folds into the snapshot.
// Bounded well inside Convex's per-transaction limits: the mutation performs
// a single index-range read of the batch (not per-document gets), so the
// binding constraints are documents scanned (32,000), documents written
// (16,000, one delete per log), and bytes read (16 MiB) for large keys.
export const COMPACTION_BATCH_SIZE = 4_000;

// Watchdog slack after a lease expires before we declare its chain dead.
const WATCHDOG_SLACK_MS = 1_000;

// How many keys one fan-out transaction signals before rescheduling itself.
// Each key can schedule two functions (compactLogs + watchdog), and Convex
// caps scheduled functions at 1,000 per mutation.
const SIGNAL_FANOUT_BATCH_SIZE = 400;

const configArgs = {
  compactionDelay: v.number(),
  compactionLeaseDuration: v.number(),
};

async function getActiveLease(ctx: QueryCtx, key: string) {
  return await ctx.db
    .query("compaction_leases")
    .withIndex("by_key_and_expires_at", (q) =>
      q.eq("key", key).gt("expires_at", Date.now()),
    )
    .order("desc")
    .first();
}

// Best-effort cleanup of lease rows abandoned by crashed compaction chains.
// Bounded so it can never dominate the calling transaction.
async function reapExpiredLeases(ctx: MutationCtx, key: string) {
  const expired = await ctx.db
    .query("compaction_leases")
    .withIndex("by_key_and_expires_at", (q) =>
      q.eq("key", key).lte("expires_at", Date.now()),
    )
    .take(64);
  for (const lease of expired) {
    await ctx.db.delete("compaction_leases", lease._id);
  }
}

async function signalNeedCompactionHandler(
  ctx: MutationCtx,
  {
    key,
    compactionDelay,
    compactionLeaseDuration,
  }: { key: string; compactionDelay: number; compactionLeaseDuration: number },
) {
  const activeLease = await getActiveLease(ctx, key);
  if (activeLease) return;

  // Deleting an expired lease fences out its chain (renewLease requires the
  // row to exist), so a slow-but-alive chain that outlived its lease dies
  // cleanly at its next renewal instead of racing the new one.
  await reapExpiredLeases(ctx, key);

  const lease = await ctx.db.insert("compaction_leases", {
    key,
    expires_at: Date.now() + compactionDelay + compactionLeaseDuration,
  });

  const job = await ctx.scheduler.runAfter(
    compactionDelay,
    internal.compaction.compactLogs,
    {
      key,
      lease,
      compactionDelay,
      compactionLeaseDuration,
    },
  );
  await ctx.db.patch("compaction_leases", lease, { job });

  // compactLogs is an action: Convex runs it at most once and never retries
  // it. If it (or any link of its chain) dies, this exactly-once watchdog
  // mutation reclaims the lease and re-signals, so the pipeline self-heals
  // without waiting for a future write to the key.
  await ctx.scheduler.runAfter(
    compactionDelay + compactionLeaseDuration + WATCHDOG_SLACK_MS,
    internal.compaction.watchdogLease,
    {
      key,
      lease,
      compactionDelay,
      compactionLeaseDuration,
    },
  );
}

export const signalNeedCompaction = internalMutation({
  args: {
    key: v.string(),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await signalNeedCompactionHandler(ctx, args);
    return null;
  },
});

// Fan-out used by addMany: signals each key across separate transactions so
// a large batch can never exceed the scheduled-functions-per-mutation limit.
export const signalNeedCompactionMany = internalMutation({
  args: {
    keys: v.array(v.string()),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (
    ctx,
    { keys, compactionDelay, compactionLeaseDuration },
  ) => {
    const batch = keys.slice(0, SIGNAL_FANOUT_BATCH_SIZE);
    const rest = keys.slice(SIGNAL_FANOUT_BATCH_SIZE);
    for (const key of batch) {
      await signalNeedCompactionHandler(ctx, {
        key,
        compactionDelay,
        compactionLeaseDuration,
      });
    }
    if (rest.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.compaction.signalNeedCompactionMany,
        {
          keys: rest,
          compactionDelay,
          compactionLeaseDuration,
        },
      );
    }
    return null;
  },
});

// Recovers from dead compaction chains. While the lease keeps getting
// renewed (or its chain's scheduled function is still pending/running), the
// watchdog keeps watching; once the lease row is gone (chain finished
// cleanly) it stops; if the lease expired with its chain dead, it reaps the
// lease and re-signals when logs remain.
export const watchdogLease = internalMutation({
  args: {
    key: v.string(),
    lease: v.id("compaction_leases"),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (
    ctx,
    { key, lease, compactionDelay, compactionLeaseDuration },
  ) => {
    const row = await ctx.db.get("compaction_leases", lease);
    if (!row) return null; // chain completed and cleaned up after itself

    const rewatch = async (delay: number) => {
      await ctx.scheduler.runAfter(
        delay,
        internal.compaction.watchdogLease,
        { key, lease, compactionDelay, compactionLeaseDuration },
      );
    };

    const remaining = row.expires_at - Date.now();
    if (remaining > 0) {
      // Chain is still alive (the lease was renewed); check again later.
      await rewatch(remaining + WATCHDOG_SLACK_MS);
      return null;
    }

    // The lease expired — but only steal it if the chain is actually dead.
    // A scheduled function still pending or running means the chain is slow
    // (e.g. scheduler backlog), not gone; stealing now could duplicate work.
    if (row.job) {
      const job = await ctx.db.system.get("_scheduled_functions", row.job);
      if (job?.state.kind === "pending" || job?.state.kind === "inProgress") {
        await rewatch(WATCHDOG_SLACK_MS);
        return null;
      }
    }

    await ctx.db.delete("compaction_leases", lease);
    const pending = await ctx.db
      .query("counter_logs")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (pending) {
      await ctx.scheduler.runAfter(
        0,
        internal.compaction.signalNeedCompaction,
        { key, compactionDelay, compactionLeaseDuration },
      );
    }
    return null;
  },
});

// Ownership check: the chain owns the key for exactly as long as its lease
// ROW exists. Takeover paths (signal reap, watchdog) delete the row first,
// so a fenced-out chain fails here before touching any logs.
async function renewLease(
  ctx: MutationCtx,
  lease: Id<"compaction_leases">,
  compactionLeaseDuration: number,
) {
  const row = await ctx.db.get("compaction_leases", lease);
  if (!row)
    throw new ConvexError({
      code: "FAILED_PRECONDITION",
      message: "Lease is no longer valid",
    });
  await ctx.db.patch("compaction_leases", lease, {
    expires_at: Date.now() + compactionLeaseDuration,
  });
}

// This is an action so that the unbounded log-space read happens in a query,
// which can't conflict with concurrent appends. The query only establishes a
// cursor BOUNDARY; the mutation then re-reads the bounded range below that
// boundary, which concurrent appends (always above it) can never enter, so
// the mutation doesn't conflict with appends either.
export const compactLogs = internalAction({
  args: {
    key: v.string(),
    lease: v.id("compaction_leases"),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (
    ctx,
    { key, lease, compactionDelay, compactionLeaseDuration },
  ) => {
    const boundary = await ctx.runQuery(internal.compaction.getCompactLogSet, {
      key,
      numItems: COMPACTION_BATCH_SIZE,
    });
    if (boundary.pageSize === 0) {
      // No more logs to compact: release the lease and recheck. Run it
      // directly (not scheduled) so the whole step stays covered by this
      // action's job entry, which the watchdog checks before stealing.
      await ctx.runMutation(internal.compaction.releaseLeaseAndRecheck, {
        key,
        lease,
        compactionDelay,
        compactionLeaseDuration,
      });
      return null;
    }
    await ctx.runMutation(internal.compaction.compactLogSet, {
      key,
      lease,
      compactionDelay,
      compactionLeaseDuration,
      pageSize: boundary.pageSize,
      moreLogsExist: !boundary.isDone,
    });
    return null;
  },
});

export const releaseLeaseAndRecheck = internalMutation({
  args: {
    lease: v.id("compaction_leases"),
    key: v.string(),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (
    ctx,
    { key, lease, compactionDelay, compactionLeaseDuration },
  ) => {
    const row = await ctx.db.get("compaction_leases", lease);
    if (row) await ctx.db.delete("compaction_leases", lease);
    const page = await ctx.db
      .query("counter_logs")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (page) {
      await ctx.scheduler.runAfter(
        0,
        internal.compaction.signalNeedCompaction,
        {
          key,
          compactionDelay,
          compactionLeaseDuration,
        },
      );
    }
    return null;
  },
});

export const getCompactLogSet = internalQuery({
  args: {
    key: v.string(),
    numItems: v.number(),
  },
  returns: v.object({
    pageSize: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { key, numItems }) => {
    const logs = await paginator(ctx.db, schema)
      .query("counter_logs")
      .withIndex("by_key", (q) => q.eq("key", key))
      .order("asc")
      .paginate({ numItems, cursor: null });
    return {
      pageSize: logs.page.length,
      isDone: logs.isDone,
    };
  },
});

export const compactLogSet = internalMutation({
  args: {
    key: v.string(),
    lease: v.id("compaction_leases"),
    pageSize: v.number(),
    moreLogsExist: v.boolean(),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (
    ctx,
    {
      key,
      lease,
      pageSize,
      moreLogsExist,
      compactionDelay,
      compactionLeaseDuration,
    },
  ) => {
    await renewLease(ctx, lease, compactionLeaseDuration);

    const snapshot = await getSnapshot(ctx, key);
    // Re-read the same page the boundary query saw: the lease guarantees
    // nothing else deletes logs in it, and concurrent appends only land
    // after it, so the first `pageSize` rows are exactly the query's page.
    const logs = await paginator(ctx.db, schema)
      .query("counter_logs")
      .withIndex("by_key", (q) => q.eq("key", key))
      .order("asc")
      .paginate({
        numItems: pageSize,
        cursor: null,
      });

    let delta = 0;
    for (const log of logs.page) {
      delta += log.delta;
      await ctx.db.delete("counter_logs", log._id);
    }

    // Replace the snapshot with the latest count.
    if (logs.page.length > 0) {
      const patch = {
        count: snapshot.count + delta,
      };
      if (snapshot._id) await ctx.db.patch("counter_snapshots", snapshot._id, patch);
      else await ctx.db.insert("counter_snapshots", { ...patch, key });
    }

    if (moreLogsExist) {
      const job = await ctx.scheduler.runAfter(
        0,
        internal.compaction.compactLogs,
        {
          key,
          lease,
          compactionDelay,
          compactionLeaseDuration,
        },
      );
      await ctx.db.patch("compaction_leases", lease, { job });
    } else {
      // No more logs to compact, so we can release the lease.
      await ctx.db.delete("compaction_leases", lease);

      // Also schedule one more compaction to check for straggler logs that
      // were inserted while we were compacting.
      await ctx.scheduler.runAfter(
        0,
        internal.compaction.signalNeedCompaction,
        {
          key,
          compactionDelay,
          compactionLeaseDuration,
        },
      );
    }
    return null;
  },
});

async function deleteLogsUpToBoundary(
  ctx: MutationCtx,
  key: string,
  boundaryCreationTime: number,
): Promise<{ moreRemain: boolean }> {
  const page = await ctx.db
    .query("counter_logs")
    .withIndex("by_key", (q) =>
      q.eq("key", key).lte("_creationTime", boundaryCreationTime),
    )
    .take(COMPACTION_BATCH_SIZE);
  for (const log of page) {
    await ctx.db.delete("counter_logs", log._id);
  }
  return { moreRemain: page.length === COMPACTION_BATCH_SIZE };
}

// Deletes everything stored for a key up to the moment the reset starts:
// pending logs, the snapshot row, and any lease rows. Writes committed after
// the reset starts survive it — the deletion is bounded by the creation time
// of the newest log visible at reset time, and a clear-lease blocks
// compaction from folding pre-reset logs into a fresh snapshot while a large
// backlog is being deleted across several scheduled transactions.
export async function clearKeyHandler(
  ctx: MutationCtx,
  {
    key,
    compactionDelay,
    compactionLeaseDuration,
  }: { key: string; compactionDelay: number; compactionLeaseDuration: number },
) {
  // Fence out any in-flight compaction chain (its next renewLease will fail
  // cleanly without touching the logs) and pause new chains.
  const leases = await ctx.db
    .query("compaction_leases")
    .withIndex("by_key_and_expires_at", (q) => q.eq("key", key))
    .take(64);
  for (const lease of leases) {
    await ctx.db.delete("compaction_leases", lease._id);
  }

  const snapshot = await ctx.db
    .query("counter_snapshots")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  if (snapshot) await ctx.db.delete("counter_snapshots", snapshot._id);

  // Everything to delete is at or before the newest currently-visible log;
  // logs appended later have strictly greater creation times and survive.
  const newestLog = await ctx.db
    .query("counter_logs")
    .withIndex("by_key", (q) => q.eq("key", key))
    .order("desc")
    .first();
  if (!newestLog) return;

  const { moreRemain } = await deleteLogsUpToBoundary(
    ctx,
    key,
    newestLog._creationTime,
  );
  if (!moreRemain) return;

  // Large backlog: hold a lease while scheduled follow-ups (exactly-once
  // mutations) delete the rest, so no compaction chain folds still-pending
  // pre-reset logs into a fresh snapshot mid-clear.
  const clearLease = await ctx.db.insert("compaction_leases", {
    key,
    expires_at: Date.now() + compactionLeaseDuration,
  });
  await ctx.scheduler.runAfter(0, internal.compaction.clearKeyBatch, {
    key,
    lease: clearLease,
    boundaryCreationTime: newestLog._creationTime,
    compactionDelay,
    compactionLeaseDuration,
  });
}

export const clearKeyBatch = internalMutation({
  args: {
    key: v.string(),
    lease: v.id("compaction_leases"),
    boundaryCreationTime: v.number(),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (
    ctx,
    {
      key,
      lease,
      boundaryCreationTime,
      compactionDelay,
      compactionLeaseDuration,
    },
  ) => {
    await renewLease(ctx, lease, compactionLeaseDuration);
    const { moreRemain } = await deleteLogsUpToBoundary(
      ctx,
      key,
      boundaryCreationTime,
    );
    if (moreRemain) {
      const job = await ctx.scheduler.runAfter(
        0,
        internal.compaction.clearKeyBatch,
        {
          key,
          lease,
          boundaryCreationTime,
          compactionDelay,
          compactionLeaseDuration,
        },
      );
      await ctx.db.patch("compaction_leases", lease, { job });
      return null;
    }
    await ctx.db.delete("compaction_leases", lease);
    // Adds that landed during the clear had their compaction signals no-op
    // against the clear-lease; compact them now.
    const pending = await ctx.db
      .query("counter_logs")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (pending) {
      await ctx.scheduler.runAfter(
        0,
        internal.compaction.signalNeedCompaction,
        { key, compactionDelay, compactionLeaseDuration },
      );
    }
    return null;
  },
});
