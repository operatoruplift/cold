/**
 * The public site's motion and the waitlist forms. Plain DOM, no framework:
 * elements marked data-reveal rise in as they scroll into view, the hero's
 * ridges drift apart with the scroll, the platform section pins while its four
 * steps flip through, and the product screen settles into place.
 */
document.documentElement.classList.add("js");

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = <T extends Element>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector);
const $$ = <T extends Element>(selector: string, root: ParentNode = document) => [...root.querySelectorAll<T>(selector)];
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/* ---------- Reveal ---------- */
function reveal(): void {
  const all = $$<HTMLElement>("[data-reveal]");
  const now = all.filter((el) => el.dataset.reveal === "load");
  requestAnimationFrame(() => now.forEach((el) => el.classList.add("is-visible")));
  const later = all.filter((el) => el.dataset.reveal !== "load");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    later.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
  );
  later.forEach((el) => seen.observe(el));
}

/* ---------- Scroll-driven pieces, all updated in one frame ---------- */
type Updater = () => void;
const updaters: Updater[] = [];
let queued = false;
function onScroll(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const update of updaters) update();
  });
}

function nav(): void {
  const bar = $<HTMLElement>("[data-nav]");
  if (!bar) return;
  updaters.push(() => bar.classList.toggle("scrolled", scrollY > 8));
}

/** The hero's three ridges sink at different speeds as you scroll past. */
function ridges(): void {
  const hero = $<HTMLElement>("[data-hero]");
  if (!hero || reduceMotion) return;
  const layers = $$<HTMLElement>("[data-depth]", hero);
  updaters.push(() => {
    const y = scrollY;
    if (y > hero.offsetHeight) return;
    for (const layer of layers) layer.style.transform = `translate3d(0, ${(y * Number(layer.dataset.depth)).toFixed(1)}px, 0)`;
  });
}

/**
 * The platform section: a tall track pins a full-screen grid while the page
 * scrolls. Each quarter of the track is one step: its copy flips in, the
 * device's film slides to its panel, and the progress bars fill.
 */
function steps(): void {
  const track = $<HTMLElement>("[data-steps]");
  if (!track) return;
  const copies = $$<HTMLElement>(".step", track);
  const panels = $$<HTMLElement>("[data-panel]", track);
  const bars = $$<HTMLElement>(".steps-bars span", track);
  const film = $<HTMLElement>("[data-film]", track);

  // Narrow screens do not pin: each step carries its own copy of its panel.
  copies.forEach((copy, i) => {
    const panel = panels[i];
    if (!panel) return;
    const holder = document.createElement("div");
    holder.className = "step-panel";
    holder.setAttribute("aria-hidden", "true");
    holder.innerHTML = `<div class="device"><div class="film"></div></div>`;
    const clone = panel.cloneNode(true) as HTMLElement;
    clone.classList.add("is-active");
    holder.querySelector(".film")!.append(clone);
    copy.append(holder);
  });

  let active = -1;
  const show = (index: number) => {
    if (index === active) return;
    active = index;
    copies.forEach((c, i) => c.classList.toggle("is-active", i === index));
    panels.forEach((p, i) => p.classList.toggle("is-active", i === index));
    film?.style.setProperty("--i", String(index));
  };
  show(0);

  updaters.push(() => {
    const rect = track.getBoundingClientRect();
    const total = Math.max(1, rect.height - innerHeight);
    const progress = clamp(-rect.top / total);
    const n = copies.length;
    show(Math.min(n - 1, Math.floor(progress * n)));
    const filled = progress * n;
    bars.forEach((bar, i) => bar.style.setProperty("--fill", `${(clamp(filled - i) * 100).toFixed(1)}%`));
  });
}

/** The product screen tilts and zooms out into place as its section scrolls in. */
function productZoom(): void {
  const el = $<HTMLElement>("[data-zoom]");
  if (!el || reduceMotion) return;
  updaters.push(() => {
    const rect = el.getBoundingClientRect();
    if (rect.top > innerHeight || rect.bottom < 0) return;
    const p = clamp((innerHeight - rect.top) / (innerHeight * 0.85));
    const ease = 1 - Math.pow(1 - p, 3);
    el.style.transform = `perspective(1600px) rotateX(${((1 - ease) * 18).toFixed(2)}deg) scale(${(1.12 - 0.12 * ease).toFixed(4)}) translateY(${((1 - ease) * -40).toFixed(1)}px)`;
  });
}

/* ---------- Snow ---------- */
function snow(): void {
  const canvas = $<HTMLCanvasElement>("[data-snow]");
  const hero = $<HTMLElement>("[data-hero]");
  if (!canvas || !hero || reduceMotion) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let width = 0;
  let height = 0;
  const flakes: Array<{ x: number; y: number; r: number; v: number; phase: number }> = [];
  const resize = () => {
    const ratio = Math.min(2, devicePixelRatio || 1);
    width = hero.clientWidth;
    height = hero.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const target = Math.round(Math.min(110, width / 14));
    while (flakes.length < target) flakes.push({ x: Math.random() * width, y: Math.random() * height, r: 0.8 + Math.random() * 2.2, v: 0.25 + Math.random() * 0.75, phase: Math.random() * Math.PI * 2 });
    flakes.length = target;
  };
  resize();
  addEventListener("resize", resize);

  let visible = true;
  new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    if (visible) requestAnimationFrame(frame);
  }).observe(hero);

  let last = performance.now();
  function frame(now: number) {
    if (!visible || document.hidden) return;
    const dt = Math.min(48, now - last) / 16.7;
    last = now;
    ctx!.clearRect(0, 0, width, height);
    for (const f of flakes) {
      f.y += f.v * dt;
      f.phase += 0.012 * dt;
      f.x += Math.sin(f.phase) * 0.35 * dt;
      if (f.y > height + 4) {
        f.y = -4;
        f.x = Math.random() * width;
      }
      ctx!.globalAlpha = 0.45 + f.r / 5;
      ctx!.beginPath();
      ctx!.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx!.fillStyle = "#ffffff";
      ctx!.fill();
    }
    requestAnimationFrame(frame);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && visible) {
      last = performance.now();
      requestAnimationFrame(frame);
    }
  });
  requestAnimationFrame(frame);
}

/* ---------- Waitlist ---------- */
const openedAt = performance.now();

function source(): string | undefined {
  const params = new URLSearchParams(location.search);
  const parts = ["utm_source", "utm_medium", "utm_campaign", "ref"].map((k) => (params.get(k) ? `${k}=${params.get(k)}` : "")).filter(Boolean);
  return parts.length ? parts.join("&").slice(0, 200) : undefined;
}

async function join(body: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cold": "1" },
      body: JSON.stringify({ ...body, source: source(), referrer: document.referrer || undefined, elapsedMs: Math.round(performance.now() - openedAt) }),
    });
    const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    return response.ok ? { ok: true, message: data.message ?? "You're on the list." } : { ok: false, message: data.error ?? "That did not go through. Try again in a moment." };
  } catch {
    return { ok: false, message: "You seem to be offline. Try again when you're connected." };
  }
}

const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

function waitlist(): void {
  const full = $<HTMLFormElement>("[data-join]");
  const done = $<HTMLElement>("[data-join-done]");
  const quick = $<HTMLFormElement>("[data-quick-join]");

  quick?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = quick.elements.namedItem("email") as HTMLInputElement;
    const button = quick.querySelector("button")!;
    const note = $<HTMLElement>(".hero-note");
    if (!validEmail(input.value)) {
      input.setAttribute("aria-invalid", "true");
      if (note) note.textContent = "That email doesn't look right. Try again?";
      input.focus();
      return;
    }
    input.removeAttribute("aria-invalid");
    button.disabled = true;
    const result = await join({ email: input.value, website: "" });
    button.disabled = false;
    if (note) note.textContent = result.ok ? "You're on the list. Tell us a little more below and we'll save the right seat." : result.message;
    if (result.ok && full) {
      (full.elements.namedItem("email") as HTMLInputElement).value = input.value.trim();
      document.getElementById("waitlist")?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    }
  });

  full?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(full);
    const email = String(data.get("email") ?? "");
    const status = $<HTMLElement>(".join-status", full)!;
    const input = full.elements.namedItem("email") as HTMLInputElement;
    if (!validEmail(email)) {
      input.setAttribute("aria-invalid", "true");
      status.textContent = "Add a work email so we can reach you.";
      status.className = "join-status error";
      input.focus();
      return;
    }
    input.removeAttribute("aria-invalid");
    const button = full.querySelector<HTMLButtonElement>("button[type=submit]")!;
    button.disabled = true;
    status.className = "join-status";
    status.textContent = "Saving your seat…";
    const result = await join({
      email,
      name: data.get("name"),
      company: data.get("company"),
      role: data.get("role"),
      channels: data.getAll("channels"),
      note: data.get("note"),
      website: data.get("website"),
    });
    button.disabled = false;
    if (!result.ok) {
      status.textContent = result.message;
      status.className = "join-status error";
      return;
    }
    full.hidden = true;
    if (done) {
      done.hidden = false;
      done.setAttribute("tabindex", "-1");
      done.focus();
    }
  });
}

reveal();
nav();
ridges();
steps();
productZoom();
snow();
waitlist();
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll);
onScroll();
