"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

type DemoRunInfo = {
  _id: Id<"demo_runs">;
  target_count: number;
  shard_count: number;
};

function DemoRun({ run }: { run: DemoRunInfo }) {
  const values = useQuery(api.counter.values, { demo_run: run._id });

  return (
    <div className="run">
      <div className="run-meta">
        <span>Run {run._id.slice(-6)}</span>
        <span className="note">
          target: {run.target_count} · shards: {run.shard_count}
        </span>
      </div>
      <div className="counters">
        <div className="counter featured">
          <div className="label">Conflict-free</div>
          <div className="value">{values?.conflictFree ?? "…"}</div>
          {values && !values.fullyConsistent && (
            <div className="hint">catching up…</div>
          )}
        </div>
        <div className="counter">
          <div className="label">Sharded ({run.shard_count} shards)</div>
          <div className="value">{values?.sharded ?? "…"}</div>
        </div>
        <div className="counter">
          <div className="label">Naive</div>
          <div className="value">{values?.naive ?? "…"}</div>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  const createRun = useMutation(api.counter.runDemo);
  const [runs, setRuns] = useState<DemoRunInfo[]>([]);
  const [targetCount, setTargetCount] = useState(100);
  const [shardCount, setShardCount] = useState(10);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    setCreating(true);
    try {
      const run = await createRun({
        target_count: targetCount,
        shard_count: shardCount,
      });
      setRuns((prev) => [run, ...prev]);
    } finally {
      setCreating(false);
    }
  }

  return (
    <main>
      <h1>Conflict-free counter demo</h1>

      <div className="panel">
        <div className="controls">
          <label htmlFor="target-count" className="note">
            Parallel increments
          </label>
          <input
            id="target-count"
            type="number"
            min={1}
            max={1000}
            value={targetCount}
            disabled={creating}
            onChange={(e) => setTargetCount(Number(e.target.value))}
          />
          <label htmlFor="shard-count" className="note">
            Shards
          </label>
          <input
            id="shard-count"
            type="number"
            min={1}
            max={100}
            value={shardCount}
            disabled={creating}
            onChange={(e) => setShardCount(Number(e.target.value))}
          />
          <button
            className="go"
            onClick={handleCreate}
            disabled={creating || targetCount < 1 || shardCount < 1}
          >
            {creating ? "Creating…" : "Create demo run"}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="label note">Demo runs</div>
        {runs.length === 0 ? (
          <div className="note">No demo runs yet.</div>
        ) : (
          <div className="runs">
            {runs.map((run) => (
              <DemoRun key={run._id} run={run} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
