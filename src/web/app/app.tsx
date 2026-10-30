import {
  BarChart3,
  BookOpen,
  Download,
  Home,
  Inbox,
  ListChecks,
  LogOut,
  Megaphone,
  Menu,
  Phone,
  RefreshCw,
  Settings,
  Sparkles,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AuthScreen } from "../pages/auth";
import { CampaignPage } from "../pages/campaign";
import { CampaignsPage } from "../pages/campaigns";
import { CallsPage } from "../pages/calls";
import { LibraryPage } from "../pages/library";
import { ProspectsPage } from "../pages/prospects";
import { RepliesPage } from "../pages/replies";
import { SettingsPage } from "../pages/settings";
import { StatsPage } from "../pages/stats";
import { TodayPage } from "../pages/today";
import { WaitlistPage } from "../pages/waitlist";
import { Button, Loading, Modal } from "../ui/kit";
import { ToastProvider, useToast } from "../ui/toast";
import { applyUpdate, install, usePwa } from "./pwa";
import { Link, useLocation } from "./router";
import { SessionProvider, useSession } from "./session";
import { StatusProvider, useStatus } from "./status";

interface Route {
  path: string;
  label: string;
  icon: LucideIcon;
}

const MAIN: Route[] = [
  { path: "/", label: "Home", icon: Home },
  { path: "/prospects", label: "Prospects", icon: Sparkles },
  { path: "/campaigns", label: "Campaigns", icon: Megaphone },
  { path: "/library", label: "Sequences", icon: BookOpen },
  { path: "/calls", label: "Calls", icon: Phone },
  { path: "/replies", label: "Inbox", icon: Inbox },
  { path: "/stats", label: "Analytics", icon: BarChart3 },
];
const SITE: Route[] = [{ path: "/waitlist", label: "Waitlist", icon: ListChecks }];
const SETTINGS: Route = { path: "/settings", label: "Settings", icon: Settings };
/** Along the bottom on a phone; the rest sit behind More. */
const TABS = ["/", "/prospects", "/campaigns", "/replies"];

const isActive = (path: string, p: string) => (p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`));

function NavLink({ route, active, onClick }: { route: Route; active: boolean; onClick?: () => void }) {
  const Icon = route.icon;
  return (
    <Link to={route.path} className={active ? "active" : undefined} onClick={onClick}>
      <Icon size={17} />
      {route.label}
    </Link>
  );
}

function Sidebar({ path }: { path: string }) {
  const pwa = usePwa();
  const { signOut } = useSession();
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/brand/cold-logo.svg" alt="COLD" />
      </div>
      <nav className="nav" aria-label="Main">
        {MAIN.map((r) => (
          <NavLink key={r.path} route={r} active={isActive(path, r.path)} />
        ))}
        <div className="nav-label">Site</div>
        {SITE.map((r) => (
          <NavLink key={r.path} route={r} active={isActive(path, r.path)} />
        ))}
      </nav>
      <div className="sidebar-foot nav">
        {pwa.installable && (
          <button type="button" className="nav-btn" onClick={() => void install()}>
            <Download size={17} />
            Install COLD
          </button>
        )}
        <NavLink route={SETTINGS} active={isActive(path, SETTINGS.path)} />
        <button type="button" className="nav-btn" onClick={() => void signOut()}>
          <LogOut size={17} />
          Sign out
        </button>
      </div>
    </aside>
  );
}

/** Phones: four tabs and More, which opens every other page. */
function TabBar({ path }: { path: string }) {
  const [more, setMore] = useState(false);
  const { signOut } = useSession();
  const pwa = usePwa();
  const tabs = MAIN.filter((r) => TABS.includes(r.path));
  const rest = [...MAIN.filter((r) => !TABS.includes(r.path)), ...SITE, SETTINGS];
  return (
    <>
      <nav className="tabbar" aria-label="Main">
        {tabs.map((r) => {
          const Icon = r.icon;
          return (
            <Link key={r.path} to={r.path} className={isActive(path, r.path) ? "active" : undefined}>
              <Icon size={20} />
              {r.label}
            </Link>
          );
        })}
        <button type="button" className={rest.some((r) => isActive(path, r.path)) ? "active" : undefined} onClick={() => setMore(true)}>
          <Menu size={20} />
          More
        </button>
      </nav>
      {more && (
        <Modal title="COLD" onClose={() => setMore(false)}>
          <div className="sheet-list">
            {rest.map((r) => {
              const Icon = r.icon;
              return (
                <Link key={r.path} to={r.path} onClick={() => setMore(false)}>
                  <Icon size={18} />
                  {r.label}
                </Link>
              );
            })}
            {pwa.installable && (
              <button type="button" onClick={() => void install()}>
                <Download size={18} />
                Install COLD on this device
              </button>
            )}
            <button type="button" onClick={() => void signOut()}>
              <LogOut size={18} />
              Sign out
            </button>
          </div>
        </Modal>
      )}
    </>
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
      <Link to="/" className="mobile-brand">
        <img src="/brand/cold-logo.svg" alt="COLD" />
      </Link>
      <div className="topbar-status">
        {data?.isExample && (
          <Link to="/settings" title="cold.yaml does not exist yet">
            Example config
          </Link>
        )}
        {store && (
          <span className="row" title={"error" in store ? store.error : store.where}>
            <span className={`dot ${tone}`} />
            <span className="hide-sm">{storeText}</span>
          </span>
        )}
      </div>
    </header>
  );
}

/** Offline, an update ready, or an install hint: one line under the top bar. */
function Banners() {
  const pwa = usePwa();
  const [hideIos, setHideIos] = useState(() => localStorageGet("cold.iosHint") === "hidden");
  if (!pwa.online)
    return (
      <div className="banner offline" role="status">
        <WifiOff size={15} /> You're offline. Pages you have open still work; sending, syncing and AI need a connection.
      </div>
    );
  if (pwa.updateReady)
    return (
      <div className="banner install" role="status">
        <RefreshCw size={15} /> A new version of COLD is ready.
        <span className="spacer" />
        <Button size="sm" variant="primary" onClick={applyUpdate}>
          Reload
        </Button>
      </div>
    );
  if (pwa.iosHint && !hideIos)
    return (
      <div className="banner install">
        <Download size={15} /> Install COLD: tap Share, then Add to Home Screen.
        <span className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon={X}
          aria-label="Hide"
          onClick={() => {
            localStorageSet("cold.iosHint", "hidden");
            setHideIos(true);
          }}
        />
      </div>
    );
  return null;
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function localStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the hint just comes back next time
  }
}

function Page({ title, icon, children, flush }: { title: string; icon: LucideIcon; children: ReactNode; flush?: boolean }) {
  useEffect(() => {
    document.title = title === "Home" ? "COLD" : `${title} · COLD`;
  }, [title]);
  return (
    <div className="main">
      <TopBar title={title} icon={icon} />
      <Banners />
      <main className={flush ? "content flush" : "content"}>{children}</main>
    </div>
  );
}

function Routes() {
  const { path } = useLocation();
  const campaign = /^\/campaigns\/([\w-]+)$/.exec(path);
  let page: ReactNode;
  if (path === "/") page = <Page title="Home" icon={Home}><TodayPage /></Page>;
  else if (path === "/prospects") page = <Page title="Prospects" icon={Sparkles}><ProspectsPage /></Page>;
  else if (path === "/campaigns") page = <Page title="Campaigns" icon={Megaphone}><CampaignsPage /></Page>;
  else if (campaign) page = <Page title="Campaign" icon={Megaphone}><CampaignPage id={campaign[1]!} /></Page>;
  else if (path === "/calls") page = <Page title="Calls" icon={Phone} flush><CallsPage /></Page>;
  else if (path === "/library") page = <Page title="Sequences" icon={BookOpen} flush><LibraryPage /></Page>;
  else if (path === "/replies") page = <Page title="Inbox" icon={Inbox}><RepliesPage /></Page>;
  else if (path === "/stats") page = <Page title="Analytics" icon={BarChart3}><StatsPage /></Page>;
  else if (path === "/waitlist") page = <Page title="Waitlist" icon={ListChecks}><WaitlistPage /></Page>;
  else if (path === "/settings") page = <Page title="Settings" icon={Settings}><SettingsPage /></Page>;
  else page = <Page title="Not found" icon={Home}><p>There is no page here. <Link to="/">Go home</Link>.</p></Page>;
  return (
    <div className="shell">
      <Sidebar path={path} />
      {page}
      <TabBar path={path} />
    </div>
  );
}

/** Until the owner signs in, the app is only the sign-in screen. */
function Gate() {
  const { session, loading, error, reload } = useSession();
  const toast = useToast();
  useEffect(() => {
    if (error) toast.error(error.message);
  }, [error, toast]);
  if (!session)
    return loading ? (
      <Loading label="Opening COLD" />
    ) : (
      <div className="auth-side" style={{ minHeight: "100%" }}>
        <div className="auth-card">
          <h2>Can't reach COLD</h2>
          <p className="auth-sub">{error?.message ?? "The server did not answer."}</p>
          <Button variant="primary" icon={RefreshCw} onClick={reload}>
            Try again
          </Button>
        </div>
      </div>
    );
  if (!session.signedIn) return <AuthScreen />;
  return (
    <StatusProvider>
      <Routes />
    </StatusProvider>
  );
}

export function App() {
  return (
    <ToastProvider>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </ToastProvider>
  );
}
