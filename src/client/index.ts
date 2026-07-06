import type {
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

// e.g. `ctx` from a Convex mutation or action.
export type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};

// e.g. `ctx` from a Convex query, mutation, or action.
export type RunQueryCtx = {
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};

export interface ConflictFreeCounterOptions {
  /**
   * How long (in milliseconds) the counter waits after a write before
   * compacting the log into the snapshot. Longer delays batch more log
   * entries per compaction; shorter delays converge reads faster.
   * Default: 15 seconds.
   */
  compactionDelay?: number;
  /**
   * How long (in milliseconds) a compaction lease is valid for. Must
   * comfortably exceed the time one compaction round takes. Default: 1 minute.
   */
  compactionLeaseDuration?: number;
  /**
   * Default cap on how many uncompacted log entries a `count` call reads
   * before falling back to the (slightly stale) snapshot. Higher values make
   * reads more consistent but larger; `0` means snapshot-only reads.
   * Default: scan as much as the transaction's read budget allows.
   */
  defaultLogScanLimit?: number;
}

const DEFAULT_OPTIONS = {
  compactionDelay: 1000 * 15,
  compactionLeaseDuration: 1000 * 60,
  defaultLogScanLimit: undefined as number | undefined,
};

// Convex caps array arguments at 8,192 elements; stay under it when
// chunking addMany batches across component calls.
const MAX_DELTAS_PER_CALL = 8_000;

// A NaN or Infinity delta would permanently poison the counter (NaN + x is
// NaN forever), so reject non-finite deltas as early as possible.
function assertFiniteDelta(delta: number) {
  if (!Number.isFinite(delta))
    throw new Error(`counter delta must be a finite number, got ${delta}`);
}

const bufferedCounterDeltasSymbol = Symbol(
  "conflict-free-counter-buffered-deltas",
);

type BufferedDeltas = Map<string, number>;

/**
 * A mutation ctx that has been bound with a delta buffer via
 * {@link ConflictFreeCounter.bindDeltasBuffer}.
 */
export type BufferedCounterCtx = RunMutationCtx & {
  [bufferedCounterDeltasSymbol]: BufferedDeltas;
};

/**
 * An eventually-consistent, contention-free counter.
 *
 * Writes append to a log (never contending with each other), and a scheduled
 * compaction pipeline folds the log into a per-key snapshot. Reads return the
 * snapshot plus as much of the uncompacted log as fits in the read budget,
 * along with a `fullyConsistent` flag telling you whether the returned count
 * reflects every write.
 */
export class ConflictFreeCounter {
  private options: Required<
    Omit<ConflictFreeCounterOptions, "defaultLogScanLimit">
  > &
    Pick<ConflictFreeCounterOptions, "defaultLogScanLimit">;

  constructor(
    private component: ComponentApi,
    options: ConflictFreeCounterOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Increment (or decrement, with a negative delta) the counter for `key`.
   *
   * This only ever appends to the counter's log, so concurrent calls for the
   * same key never conflict with each other.
   */
  async add(ctx: RunMutationCtx, key: string, delta: number = 1) {
    assertFiniteDelta(delta);
    await ctx.runMutation(this.component.public.add, {
      key,
      delta,
      compactionDelay: this.options.compactionDelay,
      compactionLeaseDuration: this.options.compactionLeaseDuration,
    });
  }

  /**
   * Apply several deltas (possibly to different keys) at once. Batches
   * larger than ~8,000 deltas are chunked across component calls (all within
   * the calling mutation's transaction).
   */
  async addMany(
    ctx: RunMutationCtx,
    deltas: Array<{ key: string; delta: number }>,
  ) {
    for (const { delta } of deltas) assertFiniteDelta(delta);
    for (let i = 0; i < deltas.length; i += MAX_DELTAS_PER_CALL) {
      await ctx.runMutation(this.component.public.addMany, {
        deltas: deltas.slice(i, i + MAX_DELTAS_PER_CALL),
        compactionDelay: this.options.compactionDelay,
        compactionLeaseDuration: this.options.compactionLeaseDuration,
      });
    }
  }

  /**
   * Delete all state for a key (its logs, snapshot, and leases), resetting
   * the count to zero. Writes committed after the reset starts survive it.
   *
   * Cost: the first deletion batch (up to ~4,000 deletes plus their reads)
   * runs inline in the calling mutation's transaction. Backlogs larger than
   * one batch finish asynchronously across scheduled transactions, so reads
   * in that window see a nonzero, shrinking count.
   *
   * Therefore, this is not gauranteed to be atomic.
   */
  async reset(ctx: RunMutationCtx, key: string) {
    await ctx.runMutation(this.component.public.reset, {
      key,
      compactionDelay: this.options.compactionDelay,
      compactionLeaseDuration: this.options.compactionLeaseDuration,
    });
  }

  /**
   * Read the counter for `key`.
   *
   * Returns the current count and whether it is fully consistent (i.e. it
   * reflects every `add` committed before this read started). When the
   * uncompacted log is larger than the scan limit, the returned count omits
   * the tail of the log and `fullyConsistent` is `false`; the missing deltas
   * show up after the next compaction (within roughly `compactionDelay`).
   */
  async count(
    ctx: RunQueryCtx,
    key: string,
    opts?: { logScanLimit?: number },
  ): Promise<{ count: number; fullyConsistent: boolean }> {
    return await ctx.runQuery(this.component.public.read, {
      key,
      logScanLimit: opts?.logScanLimit ?? this.options.defaultLogScanLimit,
    });
  }

  /**
   * Bind a delta buffer to a ctx, enabling {@link addBuffered}. Useful when a
   * single mutation makes many `add` calls for overlapping keys (e.g. from
   * database triggers): deltas accumulate in memory per key and are written
   * with a single component call by {@link flushDeltas}.
   */
  bindDeltasBuffer<InCtx extends object>(
    original: InCtx,
  ): InCtx & { [bufferedCounterDeltasSymbol]: BufferedDeltas } {
    return {
      ...original,
      [bufferedCounterDeltasSymbol]: new Map(),
    };
  }

  /**
   * Accumulate a delta in the ctx's in-memory buffer. Nothing is written
   * until {@link flushDeltas} is called — typically right before the mutation
   * returns.
   */
  async addBuffered(ctx: BufferedCounterCtx, key: string, delta: number = 1) {
    assertFiniteDelta(delta);
    const bufferedDeltas = ctx[bufferedCounterDeltasSymbol];
    if (!bufferedDeltas)
      throw new Error(
        "ctx has no delta buffer; wrap it with bindDeltasBuffer() first",
      );
    bufferedDeltas.set(key, (bufferedDeltas.get(key) ?? 0) + delta);
  }

  /**
   * Write all buffered deltas (one component call per ~8,000 keys). Each
   * key is removed from the buffer only after it has been written, so a
   * caller that catches a failure can call flushDeltas again to retry
   * exactly the deltas that weren't written.
   */
  async flushDeltas(ctx: BufferedCounterCtx) {
    const bufferedDeltas = ctx[bufferedCounterDeltasSymbol];
    if (!bufferedDeltas)
      throw new Error(
        "ctx has no delta buffer; wrap it with bindDeltasBuffer() first",
      );
    const deltas = Array.from(bufferedDeltas.entries(), ([key, delta]) => ({
      key,
      delta,
    })).filter(({ delta }) => delta !== 0);
    for (let i = 0; i < deltas.length; i += MAX_DELTAS_PER_CALL) {
      const chunk = deltas.slice(i, i + MAX_DELTAS_PER_CALL);
      await ctx.runMutation(this.component.public.addMany, {
        deltas: chunk,
        compactionDelay: this.options.compactionDelay,
        compactionLeaseDuration: this.options.compactionLeaseDuration,
      });
      for (const { key } of chunk) bufferedDeltas.delete(key);
    }
    // Drop any remaining net-zero entries; they write nothing.
    bufferedDeltas.clear();
  }
}
