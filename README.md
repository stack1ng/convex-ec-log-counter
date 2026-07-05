# Convex EC Log Counter Component

[![npm version](https://badge.fury.io/js/convex-ec-log-counter.svg)](https://badge.fury.io/js/convex-ec-log-counter)

<!-- START: Include on https://convex.dev/components -->

An **eventually-consistent, contention-free counter** for
[Convex](https://convex.dev). Increment it from as many concurrent mutations
as you like — writes never conflict with each other, so your mutations never
slow down or retry because of counter contention.

Use it for metrics, event counts, tallies, quotas — anywhere many writers bump
the same counter and reads can tolerate a few seconds of lag (and every read
tells you whether it lagged).

**How it works**: every `add` appends a row to an internal log, which is
conflict-free by construction. A scheduled compaction pipeline periodically
folds the log into a per-key snapshot behind a lease, so the log stays small.
Reads return `snapshot + visible log entries` along with a `fullyConsistent`
flag — `true` when the returned count reflects every write committed before
the read, `false` when the uncompacted log may have been larger than the
scan budget, so the count may (temporarily) be missing recent increments.

Compared to
[`@convex-dev/sharded-counter`](https://www.convex.dev/components/sharded-counter):

- No shard count to choose or rebalance — throughput scales automatically
  with write volume.
- Reads are exact whenever the backlog fits in the read budget (and say so
  via `fullyConsistent`), instead of trading read contention against shard
  count.
- The trade-off: after a burst of writes, a read may briefly lag behind by up
  to the compaction delay (default 15s). Writes are never lost — the count
  always converges.

Found a bug? Feature request?
[File it here](https://github.com/stack1ng/convex-ec-log-counter/issues).

## Pre-requisite: Convex

You'll need an existing Convex project to use the component. Convex is a
hosted backend platform, including a database, serverless functions, and a ton
more you can learn about [here](https://docs.convex.dev/get-started).

Run `npm create convex` or follow any of the
[quickstarts](https://docs.convex.dev/home) to set one up.

## Installation

Install the component package:

```sh
npm install convex-ec-log-counter
```

Create a `convex.config.ts` file in your app's `convex/` folder and install
the component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import ecLogCounter from "convex-ec-log-counter/convex.config";

const app = defineApp();
app.use(ecLogCounter);

export default app;
```

Instantiate the client (typically in its own module so every function shares
one instance):

```ts
// convex/counter.ts
import { ECLogCounter } from "convex-ec-log-counter";
import { components } from "./_generated/api";

export const counter = new ECLogCounter(components.ecLogCounter);
```

## Updating counters

Add to (or subtract from) a counter from any mutation or action:

```ts
// convex/events.ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { counter } from "./counter";

export const recordEvent = mutation({
  args: { kind: v.string() },
  handler: async (ctx, { kind }) => {
    await counter.add(ctx, `events:${kind}`); // delta defaults to 1
    await counter.add(ctx, "events:total", 1);
    await counter.add(ctx, "credits:remaining", -3);
  },
});
```

Batch several updates into a single component call:

```ts
await counter.addMany(ctx, [
  { key: "views:home", delta: 1 },
  { key: "views:total", delta: 1 },
]);
```

## Reading counters

```ts
// convex/stats.ts
import { query } from "./_generated/server";
import { v } from "convex/values";
import { counter } from "./counter";

export const eventCount = query({
  args: { kind: v.string() },
  handler: async (ctx, { kind }) => {
    const { count, fullyConsistent } = await counter.count(
      ctx,
      `events:${kind}`,
    );
    // `fullyConsistent` is true when `count` reflects every write committed
    // before this query started.
    return { count, fullyConsistent };
  },
});
```

By default, reads scan as much of the uncompacted log as the transaction's
read budget allows, so they are exact except during very large write bursts.
You can bound (or skip) the log scan for cheaper reads:

```ts
// Read at most 100 uncompacted log entries on top of the snapshot:
await counter.count(ctx, key, { logScanLimit: 100 });

// Snapshot only — cheapest possible read, lags by up to the compaction delay:
await counter.count(ctx, key, { logScanLimit: 0 });
```

Note that a query that scans the log re-runs whenever the counter changes, as
any reactive Convex query would. Use `logScanLimit: 0` for subscriptions that
should only update once per compaction rather than on every increment.

## Configuration

```ts
export const counter = new ECLogCounter(components.ecLogCounter, {
  // Wait this long after a write before compacting (default: 15s).
  // Longer = fewer, larger compactions. Shorter = reads converge faster.
  compactionDelay: 15_000,
  // How long one compaction round may take before its lease can be stolen
  // (default: 60s). You shouldn't normally need to change this.
  compactionLeaseDuration: 60_000,
  // Default `logScanLimit` for count() (default: unlimited, i.e. scan
  // within the transaction's read budget).
  defaultLogScanLimit: undefined,
});
```

## Buffering updates in hot mutations

If one mutation updates the same keys many times (for example from
[database triggers](https://stack.convex.dev/triggers)), you can buffer
deltas in memory and flush them with one component call at the end:

```ts
const bufferedCtx = counter.bindDeltasBuffer(ctx);
await counter.addBuffered(bufferedCtx, "tasks:completed");
await counter.addBuffered(bufferedCtx, "tasks:completed"); // coalesced
await counter.addBuffered(bufferedCtx, "tasks:pending", -2);
await counter.flushDeltas(bufferedCtx); // one addMany call, 2 log rows
```

## Consistency model

- **Writes are never lost.** Every `add` is durably committed in your
  mutation's transaction. The count always converges to the true total.
- **Reads are exact when `fullyConsistent` is `true`.** This is the common
  case: the snapshot plus the scanned log tail covers every committed write.
- **Reads can lag when `fullyConsistent` is `false`.** This happens when more
  log entries exist than the read was willing (or able) to scan. The lag is
  bounded by the compaction cadence — roughly `compactionDelay` plus the time
  to drain the backlog.
- **Counts are floats.** Deltas are Convex `number`s (IEEE 754 doubles), so
  integer counts stay exact up to 2^53.

## Testing your app

The package ships a `/test` entry point for use with
[`convex-test`](https://docs.convex.dev/functions/testing):

```ts
import { convexTest } from "convex-test";
import ecLogCounter from "convex-ec-log-counter/test";
import schema from "./schema";
import { modules } from "./test.setup";

const t = convexTest(schema, modules);
ecLogCounter.register(t); // pass a name if you installed it under one

// Compaction runs through the scheduler; drive it in tests with fake timers:
// vi.useFakeTimers(); ...; await t.finishAllScheduledFunctions(vi.runAllTimers);
```

<!-- END: Include on https://convex.dev/components -->

## Running the example

```sh
npm i
npm run dev
```

See
[example/convex/example.ts](https://github.com/stack1ng/convex-ec-log-counter/blob/main/example/convex/example.ts)
for a complete usage example.
