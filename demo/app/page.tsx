"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";

function DemoRun({ run }: { run: Doc<"demo_runs"> }) {
  const values = useQuery(api.counter.values, { demo_run: run._id });

  return (
    <div className="run">
      <div className="run-meta">
        <span>Run {run._id.slice(-6)}</span>
        <span className="note">target: {run.target_count}</span>
      </div>
      <div className="counters">
        <div className="counter">
          <div className="label">Naive</div>
          <div className="value">{values?.naive ?? "…"}</div>
        </div>
        <div className="counter">
          <div className="label">Conflict-free</div>
          <div className="value">{values?.conflictFree ?? "…"}</div>
          {values && !values.fullyConsistent && (
            <div className="hint">catching up…</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  const runs = useQuery(api.counter.list);
  const createRun = useMutation(api.counter.runDemoIncrements);
  const [targetCount, setTargetCount] = useState(100);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    setCreating(true);
    try {
      await createRun({ target_count: targetCount });
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
          <button
            className="go"
            onClick={handleCreate}
            disabled={creating || targetCount < 1}
          >
            {creating ? "Creating…" : "Create demo run"}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="label note">Demo runs</div>
        {runs === undefined ? (
          <div className="note">Loading…</div>
        ) : runs.length === 0 ? (
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
