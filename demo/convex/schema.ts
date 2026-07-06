import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  demo_runs: defineTable({
    target_count: v.number(),
  }),

  // The "naive" counter: a single document whose value every increment
  // read-modify-writes, so concurrent increments conflict and serialize.
  naive_counters: defineTable({
    demo_run: v.id("demo_runs"),
    value: v.number(),
  }).index("by_demo_run", ["demo_run"]),
});
