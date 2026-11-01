# Changelog

## Unreleased

- **The dialer's calls come back.** Every call the dialer logs with an
  outcome becomes a touch in COLD, on the business's or the quiz lead's
  timeline: the outcome, the dialer's AI score and tone, and its summary,
  once the call has settled. It runs every ten minutes in the background (on
  your computer and on Vercel, once across servers), from **Log calls** on
  Calls, or with `cold call log`, and a call is never logged twice.
  - A call where you talked with them (interested, appointment set, call
    back, not interested) pauses their sequences for 90 days, like a reply.
  - "Do not call" is an opt-out: nothing goes to them on any channel, and the
    dialer's prospect is marked Do Not Contact.
  - The decision engine reads the calls in their history. Someone who opted
    out is always skipped; "not interested" on a recent call turns reach out
    now into later; a wrong or bad number is no longer a way to reach them;
    and skipping someone who was interested goes to you to check.
  - Quiz leads say how their last call went.
- **Calls at their hour.** A call sheet for a prospect, in the app and from
  `cold call sheet`, says what time it is where they are and whether it is
  inside calling hours: 8am to 9pm every day unless cold.yaml's new `calls:`
  says otherwise (`start`, `end`, `days`). Outside them it says when hours
  open ("call from tomorrow 8:00 AM CST"). The time zone comes from a
  `timezone` column, else from both their phone's area code (from Google's
  libphonenumber, down to the exchange where an area code is split) and
  their state or province, and an area that spans zones is called only when
  it is inside hours in all of them. A number it can't place is said, never
  guessed. Quiz leads it is too early or late to call drop below the ones you
  can call now, their Call button waits, and their push says when to call.
- **Quiz leads get called first.** offer's quiz leads (`agencyLeads` in
  Twenty) are a prospect source, `twenty:agencyLeads`: the person who took
  the quiz (never the business's decision maker, when they came through a
  business's own link), their answers and UTM tags as variables, and "Saw
  you took our quiz on Nov 2." as the trigger when the business has none.
  Calls lists the last two weeks' qualified leads nobody has called yet at
  the top, newest first; picking one fills the script in for them, with a
  Call button and their answers. With `COLD_NTFY_URL`, a push reaches your
  phone through ntfy within a minute of each qualified lead (several at once
  come as one), tapping it opens the lead; it looks once a minute across
  every server on the database, never pushes a lead twice, retries one that
  failed, and never pushes leads from before it was set up. Settings, Lead
  alerts sends a test.
- **Picking a dialer prospect fills the script in again.** Prospects from
  `twenty:agencyProspects` and `twenty:agencyPeople` were never found by
  their key in a call sheet or a research run, so the script kept its
  braces.
- **Leads from listening.** OpenMagpie's webhook action delivers the posts
  its watches match to `/api/listen/magpie` (with `Authorization: Bearer`
  and `COLD_LISTEN_SECRET`). Each match is kept once, however often it is
  delivered, and each watch is a prospect source, `listen:<watch>`: the
  trigger line is the post itself, quoted, and a post on X carries its
  author's handle for an X DM. **Save as a list** in Settings writes a
  watch's matches to one of your own lists to fill in and research; saving
  again only adds what is new. Prospect sources are defined once, so
  research and campaigns accept the same ones.
- **X DMs go out from COLD.** Add your own X developer app in Settings
  (`X_CLIENT_ID`, `X_CLIENT_SECRET`) and press **Connect X** for an account:
  a campaign's X queue then has **Send on X**, one approved DM per click,
  sent from your own account through X's API and logged with X's message
  id. A step goes out once, even after two clicks or on two servers. A
  follow-up is never sent to someone who has answered since: their reply is
  logged instead and the sequence stops for them. **Check X DMs** on the
  Inbox logs answers to earlier DMs. X sign-ins are sealed with
  `COLD_SECRET_KEY` when it is set, which a hosted server requires.
  LinkedIn, Instagram and Facebook stay copy and open.

- **The logs say which database each deployment is on**: at start, a
  fingerprint of its address (never the address or the token), the variable
  it came from, and when COLD first used it. If the fingerprint changes with
  each deploy, the Turso connection is making a database per deployment;
  [docs/deploy.md](docs/deploy.md#every-deploy-starts-from-scratch) says how
  to turn that off or pin one with `COLD_DATABASE_URL`, which now always
  takes `COLD_DATABASE_TOKEN`, never the integration's token.
- **A replaced setup code says why** in the logs: after 20 wrong codes, a
  warning comes just above the new one.
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
