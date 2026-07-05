/// <reference types="vite/client" />

// Consumer-style test: exercises the example app end to end, registering the
// component exactly the way a package consumer would via the `/test` export.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import ecLogCounter from "convex-ec-log-counter/test";
import schema from "./schema";
import { modules } from "./setup.test";
import { api } from "./_generated/api";

function setup() {
  const t = convexTest(schema, modules);
  ecLogCounter.register(t);
  return t;
}

describe("example app", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("records events and counts them", async () => {
    const t = setup();
    await t.mutation(api.example.recordEvent, { kind: "signup" });
    await t.mutation(api.example.recordEvent, { kind: "signup" });
    await t.mutation(api.example.recordEvent, { kind: "login" });

    expect(await t.query(api.example.eventCount, { kind: "signup" })).toEqual({
      count: 2,
      fullyConsistent: true,
    });
    expect(await t.query(api.example.eventCount, { kind: "login" })).toEqual({
      count: 1,
      fullyConsistent: true,
    });
    expect(await t.query(api.example.eventCount, { kind: "other" })).toEqual({
      count: 0,
      fullyConsistent: true,
    });
  });

  test("counts survive compaction", async () => {
    const t = setup();
    await t.mutation(api.example.recordBatch, {
      kinds: ["a", "a", "b"],
    });
    const finish = t.finishAllScheduledFunctions as (
      advanceTimers: () => void,
      maxIterations?: number,
    ) => Promise<void>;
    await finish(() => vi.advanceTimersToNextTimer(), 10_000);

    expect(
      (await t.query(api.example.eventCount, { kind: "a" })).count,
    ).toBe(2);
    expect(
      (await t.query(api.example.eventCount, { kind: "b" })).count,
    ).toBe(1);
  });
});
