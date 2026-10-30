# Changelog

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
