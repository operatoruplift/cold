import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

/** Move to a page without reloading. */
export function navigate(to: string): void {
  if (to === location.pathname + location.search) return;
  history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The current path and query, kept in step with the address bar. */
export function useLocation(): { path: string; query: URLSearchParams } {
  const [href, setHref] = useState(location.pathname + location.search);
  useEffect(() => {
    const update = () => setHref(location.pathname + location.search);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const [path, search = ""] = href.split("?");
  return { path: path ?? "/", query: new URLSearchParams(search) };
}

/** Update the query string without adding a history entry. */
export function setQuery(values: Record<string, string | undefined>): void {
  const params = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(values)) v ? params.set(k, v) : params.delete(k);
  const search = params.toString();
  history.replaceState({}, "", `${location.pathname}${search ? `?${search}` : ""}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Link({ to, children, className, title }: { to: string; children: ReactNode; className?: string; title?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className} title={title}>
      {children}
    </a>
  );
}
