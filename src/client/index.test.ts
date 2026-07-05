/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { ECLogCounter, type RunMutationCtx } from "./index.js";
import {
  components,
  componentModules,
  componentSchema,
  modules,
} from "./setup.test.js";

function setup() {
  const t = convexTest(undefined, modules);
  t.registerComponent("ecLogCounter", componentSchema, componentModules);
  return t;
}

async function drain(t: ReturnType<typeof setup>) {
  const finish = t.finishAllScheduledFunctions as (
    advanceTimers: () => void,
    maxIterations?: number,
  ) => Promise<void>;
  await finish(() => vi.advanceTimersToNextTimer(), 10_000);
}

describe("ECLogCounter against a real component", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("add / count round trip, delta defaults to 1", async () => {
    const t = setup();
    const counter = new ECLogCounter(components.ecLogCounter);
    await t.run(async (ctx) => {
      await counter.add(ctx, "k");
      await counter.add(ctx, "k", 4);
    });
    const result = await t.run(async (ctx) => counter.count(ctx, "k"));
    expect(result).toEqual({ count: 5, fullyConsistent: true });
  });

  test("count stays correct across compaction", async () => {
    const t = setup();
    const counter = new ECLogCounter(components.ecLogCounter);
    await t.run(async (ctx) => {
      await counter.addMany(ctx, [
        { key: "k", delta: 2 },
        { key: "k", delta: 3 },
        { key: "other", delta: 7 },
      ]);
    });
    await drain(t);
    expect(await t.run(async (ctx) => counter.count(ctx, "k"))).toEqual({
      count: 5,
      fullyConsistent: true,
    });
    expect(await t.run(async (ctx) => counter.count(ctx, "other"))).toEqual({
      count: 7,
      fullyConsistent: true,
    });
  });

  test("count forwards logScanLimit and defaultLogScanLimit", async () => {
    const t = setup();
    const counter = new ECLogCounter(components.ecLogCounter);
    const snapshotOnly = new ECLogCounter(components.ecLogCounter, {
      defaultLogScanLimit: 0,
    });
    await t.run(async (ctx) => {
      await counter.add(ctx, "k", 5);
    });
    // Uncompacted: full scan sees it, snapshot-only doesn't.
    expect(
      (await t.run(async (ctx) => counter.count(ctx, "k"))).count,
    ).toBe(5);
    expect(
      (await t.run(async (ctx) => snapshotOnly.count(ctx, "k"))).count,
    ).toBe(0);
    // Per-call override beats the instance default.
    expect(
      (
        await t.run(async (ctx) =>
          snapshotOnly.count(ctx, "k", { logScanLimit: 10 }),
        )
      ).count,
    ).toBe(5);
    expect(
      (
        await t.run(async (ctx) =>
          counter.count(ctx, "k", { logScanLimit: 0 }),
        )
      ).count,
    ).toBe(0);
  });

  test("reset zeroes a counter", async () => {
    const t = setup();
    const counter = new ECLogCounter(components.ecLogCounter);
    await t.run(async (ctx) => {
      await counter.add(ctx, "k", 12);
    });
    await drain(t);
    await t.run(async (ctx) => {
      await counter.reset(ctx, "k");
    });
    await drain(t);
    expect(await t.run(async (ctx) => counter.count(ctx, "k"))).toEqual({
      count: 0,
      fullyConsistent: true,
    });
  });

  test("buffered adds coalesce and flush once", async () => {
    const t = setup();
    const counter = new ECLogCounter(components.ecLogCounter);
    await t.run(async (ctx) => {
      const buffered = counter.bindDeltasBuffer(ctx);
      await counter.addBuffered(buffered, "a");
      await counter.addBuffered(buffered, "a");
      await counter.addBuffered(buffered, "a", 3);
      await counter.addBuffered(buffered, "b", -1);
      await counter.addBuffered(buffered, "zero", 5);
      await counter.addBuffered(buffered, "zero", -5);
      await counter.flushDeltas(buffered);
    });
    expect((await t.run(async (ctx) => counter.count(ctx, "a"))).count).toBe(5);
    expect((await t.run(async (ctx) => counter.count(ctx, "b"))).count).toBe(
      -1,
    );
    // Fully-cancelled deltas are dropped before writing. `runInComponent`
    // exists at runtime in convex-test but is absent from its types.
    const tWithComponents = t as unknown as {
      runInComponent: (
        componentPath: string,
        f: (ctx: {
          db: {
            query: (table: string) => {
              collect: () => Promise<Array<{ key: string }>>;
            };
          };
        }) => Promise<Array<{ key: string }>>,
      ) => Promise<Array<{ key: string }>>;
    };
    const logs = await tWithComponents.runInComponent(
      "ecLogCounter",
      async (ctx) => ctx.db.query("counter_logs").collect(),
    );
    expect(logs.some((l) => l.key === "zero")).toBe(false);
  });
});

describe("ECLogCounter unit behavior (fake ctx)", () => {
  // The real runMutation is a variadic generic; a loose mock plus a cast
  // keeps the tests focused on call counts and payloads.
  function fakeCtx() {
    const runMutation = vi.fn(async (..._args: unknown[]) => null);
    return {
      ctx: { runMutation } as unknown as RunMutationCtx,
      runMutation,
    };
  }

  test("addMany chunks batches larger than 8,000 deltas", async () => {
    const counter = new ECLogCounter(components.ecLogCounter);
    const { ctx, runMutation } = fakeCtx();
    const deltas = Array.from({ length: 8_001 }, (_, i) => ({
      key: `k${i % 3}`,
      delta: 1,
    }));
    await counter.addMany(ctx, deltas);
    expect(runMutation).toHaveBeenCalledTimes(2);
    const firstArgs = runMutation.mock.calls[0][1] as {
      deltas: unknown[];
    };
    const secondArgs = runMutation.mock.calls[1][1] as {
      deltas: unknown[];
    };
    expect(firstArgs.deltas).toHaveLength(8_000);
    expect(secondArgs.deltas).toHaveLength(1);
  });

  test("addMany with an empty array never calls the component", async () => {
    const counter = new ECLogCounter(components.ecLogCounter);
    const { ctx, runMutation } = fakeCtx();
    await counter.addMany(ctx, []);
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("client-side rejection of non-finite deltas", async () => {
    const counter = new ECLogCounter(components.ecLogCounter);
    const { ctx, runMutation } = fakeCtx();
    await expect(counter.add(ctx, "k", NaN)).rejects.toThrow(/finite/);
    await expect(
      counter.addMany(ctx, [{ key: "k", delta: Infinity }]),
    ).rejects.toThrow(/finite/);
    const buffered = counter.bindDeltasBuffer(ctx);
    await expect(
      counter.addBuffered(buffered, "k", -Infinity),
    ).rejects.toThrow(/finite/);
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("addBuffered without a bound buffer throws a helpful error", async () => {
    const counter = new ECLogCounter(components.ecLogCounter);
    // Deliberately bypass the type system, as a misconfigured consumer would.
    const ctx = fakeCtx().ctx as never;
    await expect(counter.addBuffered(ctx, "k")).rejects.toThrow(
      /bindDeltasBuffer/,
    );
    await expect(counter.flushDeltas(ctx)).rejects.toThrow(
      /bindDeltasBuffer/,
    );
  });

  test("flushDeltas clears the buffer so a second flush writes nothing", async () => {
    const counter = new ECLogCounter(components.ecLogCounter);
    const { ctx, runMutation } = fakeCtx();
    const buffered = counter.bindDeltasBuffer(ctx);
    await counter.addBuffered(buffered, "k", 2);
    await counter.flushDeltas(buffered);
    expect(runMutation).toHaveBeenCalledTimes(1);
    await counter.flushDeltas(buffered);
    expect(runMutation).toHaveBeenCalledTimes(1);
  });

  test("custom compaction options are forwarded to the component", async () => {
    const counter = new ECLogCounter(components.ecLogCounter, {
      compactionDelay: 1_000,
      compactionLeaseDuration: 5_000,
    });
    const { ctx, runMutation } = fakeCtx();
    await counter.add(ctx, "k", 1);
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
      key: "k",
      delta: 1,
      compactionDelay: 1_000,
      compactionLeaseDuration: 5_000,
    });
  });
});
