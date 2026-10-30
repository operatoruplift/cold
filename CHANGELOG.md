# Changelog

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
  ignored.
- `cold dm run`: the day's DMs, copied and opened for you to send, logged when
  you say.
- `cold call sync` and `cold call sheet`: scripts into the dialer's
  `agencyScripts`, or printed for a prospect.
- Every touch logged to Twenty (`coldTouch`, created by `bun run
  twenty:schema`) or to a local file; Do Not Contact shared with the dialer.
- `cold stats`: reply rate per message and per sequence.
