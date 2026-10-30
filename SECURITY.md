# Security

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" on this
repository (Security, Advisories), not in a public issue.

## Keeping your setup safe

- **Secrets live in `.env.local` only.** Mailbox URLs carry passwords and the
  Twenty key opens your CRM. `.env.local`, `.env` and `cold.yaml` are
  gitignored; keep them that way.
- **Use app passwords, not account passwords,** for Gmail, Google Workspace
  and Microsoft 365 mailboxes, and revoke them when a mailbox is retired.
- **Scope the Twenty key.** Give it a role that can read people, companies and
  the dialer's objects and write `coldTouches` and `agencyScripts`. It does not
  need workspace settings.
- **Reacher is for your machine or private network.** If you expose it, set
  `RCH__HEADER_SECRET` on the server and `REACHER_SECRET` here.
- **The app is for your own computer.** `bun run ui` listens on 127.0.0.1
  only, refuses requests whose Host or Origin is not its own, and requires its
  own header on every API call, so other websites open in your browser cannot
  drive it. Do not put it behind a public proxy: it has no login.
- **Prospect lists are personal data.** `prospects*.csv` is gitignored; the
  only CSV in the repository is the fictional example.
