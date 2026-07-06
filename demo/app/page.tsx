"use client";

import { ConvexHttpClient } from "convex/browser";
import { useMutation, useQuery } from "convex/react";
import { useMemo, useRef, useState } from "react";
import { api } from "../convex/_generated/api";

type Mode = "naive" | "conflictFree";

type Run = {
  mode: Mode;
  n: number;
  settled: number;
};

type LogEntry = {
  id: number;
  mode: Mode;
  text: string;
};

const MODE_LABEL: Record<Mode, string> = {
  naive: "Naive counter",
  conflictFree: "Conflict-free counter",
};

const MAX_RUN = 1000;

export default function Page() {
  const values = useQuery(api.counter.values);
  const reset = useMutation(api.counter.reset);

  // Increments go over HTTP so they run as independent, genuinely parallel
  // transactions — mutations sent through the websocket client would be
  // executed in order and never contend.
  const httpClient = useMemo(
    () =>
      new ConvexHttpClient(
        process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://placeholder.convex.cloud",
      ),
    [],
  );

  const [mode, setMode] = useState<Mode>("conflictFree");
  const [n, setN] = useState(1000);
  const [run, setRun] = useState<Run | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);

  const addLog = (entryMode: Mode, text: string) => {
    setLog((entries) => [
      { id: logId.current++, mode: entryMode, text },
      ...entries.slice(0, 49),
    ]);
  };

  const start = async () => {
    if (run) return;
    const count = Math.min(Math.max(Math.floor(n) || 1, 1), MAX_RUN);
    setN(count);
    setRun({ mode, n: count, settled: 0 });

    const fn =
      mode === "naive"
        ? api.counter.incrementNaive
        : api.counter.incrementConflictFree;

    const t0 = performance.now();
    const outcomes = await Promise.all(
      Array.from({ length: count }, async () => {
        let outcome: "ok" | "conflict" | "error";
        try {
          await httpClient.mutation(fn, {});
          outcome = "ok";
        } catch (error) {
          const message = error instanceof Error ? error.message : `${error}`;
          outcome = /concurrency|conflict|changed while/i.test(message)
            ? "conflict"
            : "error";
        }
        setRun((r) => (r ? { ...r, settled: r.settled + 1 } : r));
        return outcome;
      }),
    );
    const seconds = (performance.now() - t0) / 1000;

    const ok = outcomes.filter((o) => o === "ok").length;
    const conflicts = outcomes.filter((o) => o === "conflict").length;
    const errors = count - ok - conflicts;
    const rate = Math.round(ok / seconds);
    let text = `${MODE_LABEL[mode]}: ${ok}/${count} committed in ${seconds.toFixed(2)}s (${rate}/s)`;
    if (conflicts > 0)
      text += ` — ${conflicts} rejected as write conflicts (increments lost!)`;
    if (errors > 0) text += ` — ${errors} other errors`;
    addLog(mode, text);
    setRun(null);
  };

  const progress = run ? Math.min(run.settled / run.n, 1) : 0;

  return (
    <main>
      <h1>Conflict-free counter demo</h1>
      <p className="sub">
        Both counters receive the same workload: N increments fired in
        parallel. The naive counter read-modify-writes one document, so
        concurrent increments conflict — Convex retries them, and past its
        retry budget it rejects them outright. The{" "}
        <a
          href="https://github.com/stack1ng/convex-conflict-free-counter"
          target="_blank"
          rel="noreferrer"
        >
          conflict-free counter
        </a>{" "}
        appends to a log, so the same increments all commit in parallel on the
        first try.
      </p>

      <div className="panel">
        <div className="switch" role="tablist" aria-label="Counter mode">
          {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
            <button
              key={m}
              className={mode === m ? "active" : ""}
              onClick={() => !run && setMode(m)}
              role="tab"
              aria-selected={mode === m}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>

        <div className="counters">
          <div className={`counter ${mode === "naive" ? "selected" : ""}`}>
            <div className="label">Naive counter (one document)</div>
            <div className="value">{values?.naive ?? "…"}</div>
            <div className="hint">
              db.patch(doc, {"{ value: value + 1 }"}) — concurrent increments
              conflict; some are rejected and silently lost.
            </div>
          </div>
          <div
            className={`counter ${mode === "conflictFree" ? "selected" : ""}`}
          >
            <div className="label">Conflict-free counter (log-structured)</div>
            <div className="value">{values?.conflictFree ?? "…"}</div>
            <div className="hint">
              counter.add(ctx, key) — append-only, every increment commits.
              {values && !values.fullyConsistent && " (count catching up…)"}
            </div>
          </div>
        </div>

        <div className="controls">
          <label htmlFor="n" className="note">
            Parallel increments
          </label>
          <input
            id="n"
            type="number"
            min={1}
            max={MAX_RUN}
            value={n}
            disabled={!!run}
            onChange={(e) => setN(Number(e.target.value))}
          />
          <button className="go" onClick={start} disabled={!!run || !values}>
            {run ? `Running… ${run.settled}/${run.n}` : "Go"}
          </button>
          <button className="reset" onClick={() => reset()} disabled={!!run}>
            Reset counters
          </button>
        </div>

        {run && (
          <div className="progress" aria-label="Run progress">
            <div style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>

      <div className="panel">
        <div className="label note">Run log</div>
        <div className="log">
          {log.length === 0 && (
            <div className="empty">
              No runs yet. Pick a mode, hit Go, and compare — watch the commit
              rate and the rejected-increment count.
            </div>
          )}
          {log.map((entry) => (
            <div key={entry.id} className={`entry ${entry.mode}`}>
              {entry.text}
            </div>
          ))}
        </div>
        <p className="note">
          Convex auto-retries conflicting mutations, so light contention shows
          up only as latency. Under heavy parallelism the retry budget runs
          out and increments are rejected with an OCC error — the naive
          counter ends up below its target unless the client retries. The
          conflict-free counter never conflicts, so it never loses an
          increment and never pays retry latency.
        </p>
      </div>
    </main>
  );
}
