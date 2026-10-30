import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

/** The app lives under /app/ (the public site has /). Paths inside the app are written without it. */
export const BASE = "/app";

const inApp = (pathname: string) => (pathname.startsWith(BASE) ? pathname.slice(BASE.length) || "/" : pathname);
export const href = (to: string) => `${BASE}${to.startsWith("/") ? to : `/${to}`}`;

/** Move to a page without reloading. */
export function navigate(to: string): void {
  const target = href(to);
  if (target === location.pathname + location.search) return;
  history.pushState({}, "", target);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The current path (without /app) and query, kept in step with the address bar. */
export function useLocation(): { path: string; query: URLSearchParams } {
  const [url, setUrl] = useState(location.pathname + location.search);
  useEffect(() => {
    const update = () => setUrl(location.pathname + location.search);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const [pathname, search = ""] = url.split("?");
  const path = inApp(pathname ?? "/").replace(/\/+$/, "") || "/";
  return { path, query: new URLSearchParams(search) };
}

/** Update the query string without adding a history entry. */
export function setQuery(values: Record<string, string | undefined>): void {
  const params = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(values)) v ? params.set(k, v) : params.delete(k);
  const search = params.toString();
  history.replaceState({}, "", `${location.pathname}${search ? `?${search}` : ""}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Link({ to, children, className, title, onClick }: { to: string; children: ReactNode; className?: string; title?: string; onClick?: () => void }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onClick?.();
    navigate(to);
  };
  return (
    <a href={href(to)} onClick={click} className={className} title={title}>
      {children}
    </a>
  );
}
