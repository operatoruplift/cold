import { createContext, useContext, type ReactNode } from "react";
import type { StatusResponse } from "../../domains/web/types";
import { useApi, type Loaded } from "../lib/api";

const StatusContext = createContext<Loaded<StatusResponse>>({ loading: true, reload: () => {} });

/** The config, accounts and connections, loaded once and shared; pages call reload() after changing settings. */
export function StatusProvider({ children }: { children: ReactNode }) {
  const status = useApi<StatusResponse>("/api/status");
  return <StatusContext.Provider value={status}>{children}</StatusContext.Provider>;
}

export const useStatus = () => useContext(StatusContext);
