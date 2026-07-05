import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const logValidator = v.object({
  key: v.string(),
  delta: v.number(),
});

export default defineSchema({
  // Append-only increment log. Writers only ever insert here, so concurrent
  // increments never contend on the same document.
  counter_logs: defineTable(logValidator).index("by_key", ["key"]),

  // At most one row per key: the sum of all logs compacted so far.
  counter_snapshots: defineTable({
    key: v.string(),
    count: v.number(),
  }).index("by_key", ["key"]),

  // Per-key lease ensuring a single compaction pipeline runs at a time.
  compaction_leases: defineTable({
    key: v.string(),
    expires_at: v.number(),
  }).index("by_key_and_expires_at", ["key", "expires_at"]),
});
