import { useCallback, useEffect, useRef, useState } from "react";

/** An API refusal, with the server's words and any extra detail (lint issues, config errors). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Fired when the server says the session is gone, so the app can show the sign-in screen. */
export const SIGNED_OUT = "cold:signed-out";

/** Call the API. Every request carries the x-cold header the server requires, and the session cookie. */
export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers: { "x-cold": "1", ...(options.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, navigator.onLine ? "Could not reach the COLD server." : "You're offline. This needs a connection.");
  }
  if (response.status === 401 && !path.startsWith("/api/session")) window.dispatchEvent(new Event(SIGNED_OUT));
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const body = (data ?? {}) as Record<string, unknown>;
    throw new ApiError(response.status, typeof body.error === "string" ? body.error : `${response.status} ${response.statusText}`, body);
  }
  return data as T;
}

export interface Loaded<T> {
  data?: T;
  error?: ApiError;
  loading: boolean;
  reload: () => void;
}

/** GET a path and keep the result. A null path loads nothing. Stale answers are ignored. */
export function useApi<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: path !== null });
  const [tick, setTick] = useState(0);
  const current = useRef(0);
  useEffect(() => {
    if (path === null) {
      setState({ loading: false });
      return;
    }
    const call = ++current.current;
    setState((s) => ({ ...s, loading: true }));
    api<T>(path)
      .then((data) => call === current.current && setState({ data, loading: false }))
      .catch((error: ApiError) => call === current.current && setState({ error, loading: false }));
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** GET a path as text (a CSV export), with the same header and session as api(). */
export async function apiText(path: string): Promise<string> {
  const response = await fetch(path, { headers: { "x-cold": "1" }, credentials: "same-origin" });
  if (response.status === 401) window.dispatchEvent(new Event(SIGNED_OUT));
  if (!response.ok) throw new ApiError(response.status, `${response.status} ${response.statusText}`);
  return response.text();
}
