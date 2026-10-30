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
- **The app has one login: yours.** Everything under `/app/` and every API
  call except signing in and the waitlist needs the owner's session. Use a
  long password (12 characters is the minimum; a short sentence is better).
  Settings lists every signed-in device and can sign the others out;
  `bun run cold owner` resets the password from the server.
- **On your computer** `bun run ui` listens on 127.0.0.1 only. Anywhere, the
  server refuses requests whose Host or Origin is not its own and requires its
  own header on every API call, so other websites open in your browser cannot
  drive it.
- **Hosted, use HTTPS.** Set `COLD_PUBLIC_URL` to an `https://` address so the
  session cookie is `Secure` and browsers get HSTS. Keep the `/data` volume
  private: it holds `.env.local` (mailbox passwords, API keys) and the
  database.
- **The Anthropic key is billed to you.** Keep `ANTHROPIC_API_KEY` in
  `.env.local` or the server's secrets, set a spend limit in the Claude
  Console, and rotate it if it leaks. Settings shows what the AI features used
  in the last 30 days.
- **AI never sends.** Research and drafts are suggestions: an email only goes
  out through a campaign send you start, with your caps, window and opt-outs;
  DMs and calls are always yours.
- **Prospect lists are personal data.** `prospects*.csv` is gitignored; the
  only CSV in the repository is the fictional example. The waitlist keeps a
  salted hash of each signup's address, never the address itself.
