# Changelog

## Unreleased

- **Whole lists are scored on the server.** Score and prioritize starts a
  job that carries on when the page is closed: a few prospects at a time,
  each saved as it finishes, carried on by the cron job on Vercel and the
  app's timer on your computer, with retries, a Stop button and live
  progress. One job per list and offer, up to 500 prospects each.
- **The decision engine.** Prospects has a new tab, **Score and prioritize**:
  - **Diligence** reads a prospect's public website (only public addresses,
    redirects re-checked, robots.txt honoured, size and time limits) and
    writes down what they need, each need with the words that show it.
    Sources that were never read are dropped and quotes are checked against
    the page. SubQ (Subquadratic's long-context model, `SUBQ_API_KEY`) reads
    every page at once; without it, Claude does, with a few searches.
  - **Scoring** asks ten typed questions (fit, need, timing, who decides, can
    they pay, tone, opening, objection, channel, next step). Jev, TypeSafe's
    decision model (`TYPESAFE_API_KEY`), answers them; without it, Claude
    does. The answers become a 0 to 100 score, a tier from A to D, a next step
    with its reasons, and a flag when the call should be checked by you.
  - **Drafts in their style.** Personalize writes in the tone and opening
    picked for that person, around the need diligence confirmed; pick your
    own from two menus. The draft says which style it used and why.
  - **Highest score first.** A campaign can give the daily cap's sends to the
    most promising prospects.
  - **It learns from replies.** Every approved draft's style is matched to
    what happened to it, and Thompson sampling, with the decision model's
    opinion as its prior, shifts later picks toward what gets answered.
    **Stats, What's working** shows reply rates by tone and opening, with
    90% ranges, the chance each is best, and whether higher scores reply more.
  - A `decide:` section in cold.yaml pins the providers, the review threshold
    and exploration. How it all works, and the plan to sell it to other
    businesses: docs/decision-engine.md.
- **Runs on Vercel.** The site and the app are served from Vercel's CDN, the
  API runs as one function (`api/index.ts`, on Bun), and everything you save
  lives in a free Turso database: your files, the touch log, the waitlist,
  your login, and the keys you save in Settings, encrypted with
  `COLD_SECRET_KEY`. Rate limits and the setup code are shared by every copy
  of the function. See docs/deploy.md.
- **Sends outlive the server.** A send is kept in the database and saved
  after every email: it carries on after a restart (on Vercel, the cron job
  picks it up every minute), an email that was going out when a server
  stopped is never sent twice, and Stop ends a send in its pause.
- **One storage layer.** cold.yaml, the message library, prospect lists,
  campaigns and the Twenty journal go through it: a folder on your computer
  (as before, so the command line still reads them), or the database.
- **Smaller and faster to start.** The Dockerfile bundles the site and the app
  when the image is built (`bun run build`), and the mail and AI libraries
  load the first time they're used: an idle server holds about 40 MB instead
  of 75.
- `railway.json` and `COLD_PROXY_HOPS` for Docker hosts behind a proxy.

## 0.3.0 - 2026-10-30

COLD: the brand, a public site, a login, an installable app, and AI.

- **Brand.** The COLD logo set (outlined wordmark, mark, app icons, favicon,
  share image), the Sky, Glacier, Ice, Snow and Midnight palette, and Inter
  with Inter Display for headings, across the site and the app. See
  docs/brand.md.
- **The site** at `/`: hero with drifting cloud banks and alpine ridges that
  part on scroll, a pinned four-step section (discover, write, reach,
  connect), the product, features, the two voices, the principles, FAQ and
  the waitlist. Motion in the style of ListeningKit's site; reduced motion
  respected.
- **Waitlist.** Signups from the site (honeypot, fill-time check and a
  per-address limit against bots), stored in SQLite, managed on the new
  Waitlist page: status, search, CSV export.
- **Your login.** The app moved to `/app/` and sits behind a single owner
  login: argon2id password, 30-day sessions in a `HttpOnly`,
  `SameSite=Strict` cookie, a one-time setup code printed at first start,
  sign-in rate limits, a sessions list and sign out everywhere.
  `bun run cold owner` creates or resets it; `COLD_OWNER_EMAIL` and
  `COLD_OWNER_PASSWORD_HASH` set it from the environment.
- **Desktop and phone.** A web app manifest, icons and a service worker that
  keeps the app's shell offline; install from the browser, or
  `bun run desktop` for an app window. Phone layout with tabs along the
  bottom.
- **AI with Claude.** Find prospects with web search and save them as a list;
  research a prospect for one true trigger line and save it to the CSV or
  Twenty; personalize any due email or DM (approved drafts go out instead of
  the template, with COLD's footer); call prep; reply triage with drafted
  answers and a one-click opt-out. Sources Claude didn't open are dropped,
  and nothing is sent without you.
- **Hosting.** `COLD_PUBLIC_URL` (detected on Railway, Render and Fly),
  `COLD_HOME` for a data volume, a Dockerfile and docs/deploy.md. Pages carry
  a strict Content Security Policy, and HSTS over HTTPS.
- **Home** gets the greeting and the five tiles from the brand board; the
  sidebar is Home, Prospects, Campaigns, Sequences, Calls, Inbox, Analytics
  and Waitlist.

## 0.2.0 - 2026-10-30

- The app: `bun run ui` opens a local web app in the dialer's style. It has
  Today, campaigns (email send with live progress and a stop button, the DM
  queue with Copy, Open profile and outcome buttons), call scripts with sync to
  the dialer, the message library with preview and editing, replies, stats,
  and settings with connection tests.
- Campaigns: a saved sequence, account, offer and prospect list
  (.cold/campaigns.json). CSV upload from the app.
- The server listens on 127.0.0.1 only and refuses cross-site requests (Host,
  Origin and a required header).
- The email and DM runners now also expose structured plans and progress
  events, and call sheets come as structured data. The CLI is unchanged.

## 0.1.0 - 2026-10-30

First release.

- The message library: 7 email sequences, 7 DM sequences (LinkedIn, X,
  Instagram, Facebook), 7 call scripts and 11 objections, in a personal and a
  company voice (Facebook DMs are personal only: a Page cannot message first).
- Template syntax with fallbacks and per-prospect variants, a variable contract,
  and a linter for every message.
- `cold email run`: due steps from your own mailbox over SMTP, threaded
  follow-ups, daily caps, a sending window, opt-out footer and
  `List-Unsubscribe`.
- `cold email sync`: replies, opt-outs and bounces from IMAP; out-of-office
  replies and delivery delays ignored; per-recipient delivery reports.
- Never the same email twice: one message per address per run, and a send that
  cannot be logged stops the run and is saved before the next one plans.
- `cold dm run`: the day's DMs, copied and opened for you to send, logged when
  you say.
- `cold call sync` and `cold call sheet`: scripts into the dialer's
  `agencyScripts`, or printed for a prospect.
- Every touch logged to Twenty (`coldTouch`, created by `bun run
  twenty:schema`) or to a local file; Do Not Contact shared with the dialer.
- `cold stats`: reply rate per message and per sequence.
