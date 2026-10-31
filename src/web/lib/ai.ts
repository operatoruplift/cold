import { useEffect, useRef, useState } from "react";
import type { AiRun } from "../../domains/ai/store";
import { api, ApiError } from "./api";

/**
 * Follow a background AI run (finding or researching prospects) until it
 * finishes. Survives a page reload when the run id is kept in the address.
 */
export function useAiRun<T>(runId: string | undefined): { run?: AiRun<T>; error?: ApiError; elapsed: number } {
  const [run, setRun] = useState<AiRun<T>>();
  const [error, setError] = useState<ApiError>();
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(Date.now());
  useEffect(() => {
    setRun(undefined);
    setError(undefined);
    if (!runId) return;
    started.current = Date.now();
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await api<AiRun<T>>(`/api/ai/runs/${runId}`);
        if (!alive) return;
        setRun(next);
        if (next.status === "running") {
          started.current = new Date(next.createdAt).getTime();
          timer = setTimeout(tick, 2000);
        }
      } catch (err) {
        if (alive) setError(err as ApiError);
      }
    };
    void tick();
    const clock = setInterval(() => alive && setElapsed(Math.round((Date.now() - started.current) / 1000)), 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [runId]);
  return { run, error, elapsed };
}

/** Start a background run and wait for it: quick checks at first (a draft takes seconds), then every two seconds. */
export async function runAndWait<T>(start: () => Promise<{ runId: string }>, onTick?: (seconds: number) => void): Promise<AiRun<T>> {
  const { runId } = await start();
  const began = Date.now();
  for (let check = 0; ; check++) {
    await new Promise((r) => setTimeout(r, Math.min(2000, 700 + check * 300)));
    onTick?.(Math.round((Date.now() - began) / 1000));
    const run = await api<AiRun<T>>(`/api/ai/runs/${runId}`);
    if (run.status === "done") return run;
    if (run.status === "failed") throw new ApiError(502, run.error ?? "The AI run failed.");
  }
}

export const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
