import { useSyncExternalStore } from "react";

/** What the app knows about running as an installed app. */
export interface PwaState {
  online: boolean;
  /** The browser offered to install COLD (Chrome, Edge): call install(). */
  installable: boolean;
  /** Running as an installed app, in its own window. */
  standalone: boolean;
  /** iPhone or iPad Safari, not installed: installing is Share, then Add to Home Screen. */
  iosHint: boolean;
  /** A new version finished downloading: applyUpdate() switches to it. */
  updateReady: boolean;
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const listeners = new Set<() => void>();
let deferredPrompt: InstallPromptEvent | undefined;
let waiting: ServiceWorker | undefined;

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let state: PwaState = {
  online: navigator.onLine,
  installable: false,
  standalone: isStandalone(),
  iosHint: isIos() && !isStandalone(),
  updateReady: false,
};

function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/**
 * Register the service worker (it keeps the app shell for offline use) and
 * listen for what the browser says about installing and updating. Service
 * workers only run on HTTPS or localhost; elsewhere this does nothing.
 */
export function startPwa(): void {
  addEventListener("online", () => set({ online: true }));
  addEventListener("offline", () => set({ online: false }));
  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    set({ installable: true });
  });
  addEventListener("appinstalled", () => {
    deferredPrompt = undefined;
    set({ installable: false, standalone: isStandalone() });
  });
  matchMedia("(display-mode: standalone)").addEventListener("change", () => set({ standalone: isStandalone(), iosHint: isIos() && !isStandalone() }));

  if (!("serviceWorker" in navigator) || !isSecureContext) return;
  navigator.serviceWorker
    .register("/sw.js", { scope: "/app/" })
    .then((registration) => {
      const track = (worker: ServiceWorker | null) => {
        if (!worker) return;
        const check = () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            waiting = worker;
            set({ updateReady: true });
          }
        };
        worker.addEventListener("statechange", check);
        check();
      };
      track(registration.waiting);
      registration.addEventListener("updatefound", () => track(registration.installing));
      // Look for a new version when the app comes back to the front.
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && registration.update().catch(() => {}));
    })
    .catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!reloading && waiting) {
      reloading = true;
      location.reload();
    }
  });
}

export async function install(): Promise<void> {
  const prompt = deferredPrompt;
  if (!prompt) return;
  await prompt.prompt();
  await prompt.userChoice.catch(() => undefined);
  deferredPrompt = undefined;
  set({ installable: false });
}

export function applyUpdate(): void {
  if (waiting) waiting.postMessage("skip-waiting");
  else location.reload();
}

export function usePwa(): PwaState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
