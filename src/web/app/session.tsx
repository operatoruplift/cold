import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { SessionResponse } from "../../domains/web/types";
import { api, ApiError, SIGNED_OUT } from "../lib/api";

interface SessionState {
  session?: SessionResponse;
  error?: ApiError;
  loading: boolean;
  reload: () => void;
  /** After signing in or setting up: the server's answer, used as is. */
  accept: (session: SessionResponse) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState>({ loading: true, reload: () => {}, accept: () => {}, signOut: async () => {} });

/** Who is signed in. Any API call that comes back 401 drops back to the sign-in screen. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ session?: SessionResponse; error?: ApiError; loading: boolean }>({ loading: true });
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    api<SessionResponse>("/api/session")
      .then((session) => setState({ session, loading: false }))
      .catch((error: ApiError) => setState((s) => ({ ...s, error, loading: false })));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => {
    const lost = () => setState((s) => (s.session ? { ...s, session: { ...s.session, signedIn: false, owner: undefined } } : s));
    window.addEventListener(SIGNED_OUT, lost);
    return () => window.removeEventListener(SIGNED_OUT, lost);
  }, []);
  const accept = useCallback((session: SessionResponse) => setState({ session, loading: false }), []);
  const signOut = useCallback(async () => {
    const session = await api<SessionResponse>("/api/session/logout", { method: "POST", body: {} });
    setState({ session, loading: false });
  }, []);
  return <SessionContext.Provider value={{ ...state, reload, accept, signOut }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
