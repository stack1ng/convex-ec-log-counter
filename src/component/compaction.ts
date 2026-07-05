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

  await reapExpiredLeases(ctx, key);

  const lease = await ctx.db.insert("compaction_leases", {
    key,
    expires_at: Date.now() + compactionDelay + compactionLeaseDuration,
  });

  await ctx.scheduler.runAfter(
    compactionDelay,
    internal.compaction.compactLogs,
    {
      key,
      lease,
      compactionDelay,
      compactionLeaseDuration,
    },
  );

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
  handler: async (ctx, args) => {
    await signalNeedCompactionHandler(ctx, args);
  },
});

// Fan-out used by addMany: signals each key across separate transactions so
// a large batch can never exceed the scheduled-functions-per-mutation limit.
export const signalNeedCompactionMany = internalMutation({
  args: {
    keys: v.array(v.string()),
    ...configArgs,
  },
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
  },
});

// Recovers from dead compaction chains. While the lease keeps getting
// renewed, the watchdog keeps watching; once the lease row is gone (chain
// finished cleanly) it stops; if the lease expired in place (chain died), it
// reaps the lease and re-signals when logs remain.
export const watchdogLease = internalMutation({
  args: {
    key: v.string(),
    lease: v.id("compaction_leases"),
    ...configArgs,
  },
  handler: async (
    ctx,
    { key, lease, compactionDelay, compactionLeaseDuration },
  ) => {
    const row = await ctx.db.get("compaction_leases", lease);
    if (!row) return; // chain completed and cleaned up after itself

    const remaining = row.expires_at - Date.now();
    if (remaining > 0) {
      // Chain is still alive (the lease was renewed); check again later.
      await ctx.scheduler.runAfter(
        remaining + WATCHDOG_SLACK_MS,
        internal.compaction.watchdogLease,
        { key, lease, compactionDelay, compactionLeaseDuration },
      );
      return;
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
  },
});

async function renewLease(
  ctx: MutationCtx,
  key: string,
  lease: Id<"compaction_leases">,
  compactionLeaseDuration: number,
) {
  const activeLease = await getActiveLease(ctx, key);
  if (activeLease?._id !== lease)
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
  handler: async (
    ctx,
    { key, lease, compactionDelay, compactionLeaseDuration },
  ) => {
    const boundary = await ctx.runQuery(internal.compaction.getCompactLogSet, {
      key,
      numItems: COMPACTION_BATCH_SIZE,
    });
    if (boundary.pageSize === 0) {
      // No more logs to compact, so release the lease and schedule a recheck.
      await ctx.scheduler.runAfter(
        0,
        internal.compaction.releaseLeaseAndRecheck,
        {
          key,
          lease,
          compactionDelay,
          compactionLeaseDuration,
        },
      );
      return;
    }
    await ctx.runMutation(internal.compaction.compactLogSet, {
      key,
      lease,
      compactionDelay,
      compactionLeaseDuration,
      endCursor: boundary.endCursor,
      moreLogsExist: !boundary.isDone,
    });
  },
});

export const releaseLeaseAndRecheck = internalMutation({
  args: {
    lease: v.id("compaction_leases"),
    key: v.string(),
    ...configArgs,
  },
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
  },
});

export const getCompactLogSet = internalQuery({
  args: {
    key: v.string(),
    numItems: v.number(),
  },
  returns: v.object({
    endCursor: v.string(),
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
      endCursor: logs.continueCursor,
      pageSize: logs.page.length,
      isDone: logs.isDone,
    };
  },
});

export const compactLogSet = internalMutation({
  args: {
    key: v.string(),
    lease: v.id("compaction_leases"),
    endCursor: v.string(),
    moreLogsExist: v.boolean(),
    ...configArgs,
  },
  handler: async (
    ctx,
    {
      key,
      lease,
      endCursor,
      moreLogsExist,
      compactionDelay,
      compactionLeaseDuration,
    },
  ) => {
    await renewLease(ctx, key, lease, compactionLeaseDuration);

    const snapshot = await getSnapshot(ctx, key);
    // Re-read the same bounded range the query saw. The lease guarantees no
    // other compactor deleted rows in it, and appends land above endCursor.
    const logs = await paginator(ctx.db, schema)
      .query("counter_logs")
      .withIndex("by_key", (q) => q.eq("key", key))
      .order("asc")
      .paginate({
        numItems: COMPACTION_BATCH_SIZE,
        cursor: null,
        endCursor,
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

    if (moreLogsExist)
      await ctx.scheduler.runAfter(0, internal.compaction.compactLogs, {
        key,
        lease,
        compactionDelay,
        compactionLeaseDuration,
      });
    else {
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
  },
});

// Deletes everything stored for a key: pending logs (in batches), the
// snapshot row, and any lease rows. Concurrent adds may commit while a batch
// chain is in flight and survive the reset.
export async function clearKeyHandler(
  ctx: MutationCtx,
  {
    key,
    compactionDelay,
    compactionLeaseDuration,
  }: { key: string; compactionDelay: number; compactionLeaseDuration: number },
) {
  const logs = await paginator(ctx.db, schema)
      .query("counter_logs")
      .withIndex("by_key", (q) => q.eq("key", key))
      .order("asc")
      .paginate({ numItems: COMPACTION_BATCH_SIZE, cursor: null });
    for (const log of logs.page) {
      await ctx.db.delete("counter_logs", log._id);
    }
    if (!logs.isDone) {
      // More logs than one transaction should delete; continue in a
      // scheduled follow-up.
      await ctx.scheduler.runAfter(0, internal.compaction.clearKey, {
        key,
        compactionDelay,
        compactionLeaseDuration,
      });
      return;
    }

    const snapshot = await ctx.db
      .query("counter_snapshots")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (snapshot) await ctx.db.delete("counter_snapshots", snapshot._id);

    // Deleting lease rows fences out any in-flight compaction chain (its
    // next renewLease will fail cleanly without touching the logs).
    const leases = await ctx.db
      .query("compaction_leases")
      .withIndex("by_key_and_expires_at", (q) => q.eq("key", key))
      .take(64);
    for (const lease of leases) {
      await ctx.db.delete("compaction_leases", lease._id);
    }
}

export const clearKey = internalMutation({
  args: {
    key: v.string(),
    ...configArgs,
  },
  handler: clearKeyHandler,
});
