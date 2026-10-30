import { BarChart3, BookOpen, Inbox, LayoutDashboard, Megaphone, Phone, Send, Settings, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CampaignPage } from "../pages/campaign";
import { CampaignsPage } from "../pages/campaigns";
import { CallsPage } from "../pages/calls";
import { LibraryPage } from "../pages/library";
import { RepliesPage } from "../pages/replies";
import { SettingsPage } from "../pages/settings";
import { StatsPage } from "../pages/stats";
import { TodayPage } from "../pages/today";
import { ToastProvider } from "../ui/toast";
import { Link, useLocation } from "./router";
import { StatusProvider, useStatus } from "./status";

interface Route {
  path: string;
  label: string;
  icon: LucideIcon;
}

const MAIN: Route[] = [
  { path: "/", label: "Today", icon: LayoutDashboard },
  { path: "/campaigns", label: "Campaigns", icon: Megaphone },
  { path: "/calls", label: "Call scripts", icon: Phone },
  { path: "/library", label: "Message library", icon: BookOpen },
];
const RESULTS: Route[] = [
  { path: "/replies", label: "Replies", icon: Inbox },
  { path: "/stats", label: "Stats", icon: BarChart3 },
];

function NavLink({ route, active }: { route: Route; active: boolean }) {
  const Icon = route.icon;
  return (
    <Link to={route.path} className={active ? "active" : undefined}>
      <Icon size={17} />
      {route.label}
    </Link>
  );
}

function Sidebar({ path }: { path: string }) {
  const isActive = (p: string) => (p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`));
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Send size={14} />
        </span>
        cold
      </div>
      <nav className="nav" aria-label="Main">
        {MAIN.map((r) => (
          <NavLink key={r.path} route={r} active={isActive(r.path)} />
        ))}
        <div className="nav-label">Results</div>
        {RESULTS.map((r) => (
          <NavLink key={r.path} route={r} active={isActive(r.path)} />
        ))}
      </nav>
      <div className="sidebar-foot nav">
        <NavLink route={{ path: "/settings", label: "Settings", icon: Settings }} active={isActive("/settings")} />
      </div>
    </aside>
  );
}

function TopBar({ title, icon: Icon }: { title: string; icon: LucideIcon }) {
  const { data } = useStatus();
  const store = data?.store;
  const storeText = !store ? "" : "error" in store ? "Touch log unavailable" : store.kind === "twenty" ? "Logging to Twenty" : "Logging to a local file";
  const tone = !store ? "" : "error" in store ? "red" : store.kind === "twenty" ? "green" : "amber";
  return (
    <header className="topbar">
      <div className="crumb">
        <Icon size={15} />
        {title}
      </div>
      <div className="topbar-status">
        {data?.isExample && (
          <Link to="/settings" title="cold.yaml does not exist yet">
            Example config
          </Link>
        )}
        {store && (
          <span className="row" title={"error" in store ? store.error : store.where}>
            <span className={`dot ${tone}`} />
            {storeText}
          </span>
        )}
      </div>
    </header>
  );
}

function Page({ title, icon, children, flush }: { title: string; icon: LucideIcon; children: ReactNode; flush?: boolean }) {
  return (
    <div className="main">
      <TopBar title={title} icon={icon} />
      <main className={flush ? "content flush" : "content"}>{children}</main>
    </div>
  );
}

function Routes() {
  const { path } = useLocation();
  const campaign = /^\/campaigns\/([\w-]+)$/.exec(path);
  let page: ReactNode;
  if (path === "/") page = <Page title="Today" icon={LayoutDashboard}><TodayPage /></Page>;
  else if (path === "/campaigns") page = <Page title="Campaigns" icon={Megaphone}><CampaignsPage /></Page>;
  else if (campaign) page = <Page title="Campaign" icon={Megaphone}><CampaignPage id={campaign[1]!} /></Page>;
  else if (path === "/calls") page = <Page title="Call scripts" icon={Phone} flush><CallsPage /></Page>;
  else if (path === "/library") page = <Page title="Message library" icon={BookOpen} flush><LibraryPage /></Page>;
  else if (path === "/replies") page = <Page title="Replies" icon={Inbox}><RepliesPage /></Page>;
  else if (path === "/stats") page = <Page title="Stats" icon={BarChart3}><StatsPage /></Page>;
  else if (path === "/settings") page = <Page title="Settings" icon={Settings}><SettingsPage /></Page>;
  else page = <Page title="Not found" icon={LayoutDashboard}><p>There is no page here. <Link to="/">Go to Today</Link>.</p></Page>;
  return (
    <div className="shell">
      <Sidebar path={path} />
      {page}
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <StatusProvider>
        <Routes />
      </StatusProvider>
    </ToastProvider>
  );
}
