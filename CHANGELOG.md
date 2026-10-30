# Changelog

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
