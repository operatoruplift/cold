import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { ApiError } from "../lib/api";

export type Tone = "blue" | "green" | "red" | "amber" | "purple" | "teal" | "gray";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "success" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
  loading?: boolean;
  block?: boolean;
};

export function Button({ variant = "default", size = "md", icon: Icon, loading, block, children, className, disabled, ...rest }: ButtonProps) {
  const classes = ["btn", variant !== "default" && variant, size !== "md" && size, block && "block", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" style={{ width: 13, height: 13 }} /> : Icon ? <Icon size={size === "sm" ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

export function PageHeader({ title, count, sub, icon: Icon, actions }: { title: ReactNode; count?: number; sub?: ReactNode; icon?: LucideIcon; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        <div className="page-title">
          {Icon && (
            <span className="stat-icon tone-blue">
              <Icon size={17} />
            </span>
          )}
          <h1 className="truncate">{title}</h1>
          {count !== undefined && <span className="count">{count}</span>}
        </div>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, icon: Icon, actions, children, tight, className }: { title?: ReactNode; icon?: LucideIcon; actions?: ReactNode; children: ReactNode; tight?: boolean; className?: string }) {
  return (
    <section className={["card", className].filter(Boolean).join(" ")}>
      {(title || actions) && (
        <div className="card-head">
          <h2>
            {Icon && <Icon size={16} className="text-3" />}
            {title}
          </h2>
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      <div className={tight ? "card-body tight" : "card-body"}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, icon: Icon, tone = "blue", note }: { label: string; value: ReactNode; icon: LucideIcon; tone?: Tone; note?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span className={`stat-icon tone-${tone}`}>
          <Icon size={16} />
        </span>
        {label}
      </div>
      <div className={`stat-value text-${tone === "gray" ? "2" : tone}`}>{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export function Pill({ tone = "gray", icon: Icon, children, title }: { tone?: Tone; icon?: LucideIcon; children: ReactNode; title?: string }) {
  return (
    <span className={`pill tone-${tone}`} title={title}>
      {Icon && <Icon size={12} />}
      {children}
    </span>
  );
}

const NOTICE_ICONS: Record<string, LucideIcon> = { amber: AlertTriangle, red: XCircle, blue: Info, green: CheckCircle2 };

export function Notice({ tone = "amber", title, children, action }: { tone?: "amber" | "red" | "blue" | "green"; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = NOTICE_ICONS[tone]!;
  return (
    <div className={`notice ${tone}`} role={tone === "red" ? "alert" : "status"}>
      <Icon size={16} />
      <div className="notice-body">
        {title && <div className="notice-title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function ErrorNotice({ error, title = "Something went wrong" }: { error?: ApiError | Error | null; title?: string }) {
  if (!error) return null;
  return (
    <Notice tone="red" title={title}>
      {error.message}
    </Notice>
  );
}

export function Empty({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={20} />
      </span>
      <h3>{title}</h3>
      {children && <p style={{ maxWidth: 440 }}>{children}</p>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" /> {label}...
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: ReactNode; count?: number; icon?: LucideIcon }>; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(({ id, label, count, icon: Icon }) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} className={value === id ? "tab active" : "tab"} onClick={() => onChange(id)}>
          {Icon && <Icon size={14} />}
          {label}
          {count !== undefined && <span className="count">{count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** Initials for an avatar: "Dana Reyes (Clearview Tint)" -> "DR". */
export function initials(label: string): string {
  const words = label.replace(/\(.*\)/, "").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}
