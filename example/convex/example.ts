import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { ECLogCounter } from "convex-ec-log-counter";

const counter = new ECLogCounter(components.ecLogCounter, {
  compactionDelay: 1000 * 15,
});

// Record an event and bump its per-kind counter. Any number of these can
// commit concurrently without conflicting on the counter.
export const recordEvent = mutation({
  args: { kind: v.string() },
  returns: v.null(),
  handler: async (ctx, { kind }) => {
    await ctx.db.insert("events", { kind });
    await counter.add(ctx, `events:${kind}`);
    return null;
  },
});

// Bump several counters at once with a single component call.
export const recordBatch = mutation({
  args: { kinds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { kinds }) => {
    await counter.addMany(
      ctx,
      kinds.map((kind) => ({ key: `events:${kind}`, delta: 1 })),
    );
    return null;
  },
});

// Read a counter. `fullyConsistent` tells you whether the count reflects
// every write committed before this query started.
export const eventCount = query({
  args: { kind: v.string() },
  returns: v.object({
    count: v.number(),
    fullyConsistent: v.boolean(),
  }),
  handler: async (ctx, { kind }) => {
    return await counter.count(ctx, `events:${kind}`);
  },
});
