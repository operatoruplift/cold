# Security

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" on this
repository (Security, Advisories), not in a public issue.

## Keeping your setup safe

- **Secrets live in `.env.local` only** on your computer. Mailbox URLs carry
  passwords and the Twenty key opens your CRM. `.env.local`, `.env` and
  `cold.yaml` are gitignored; keep them that way. On Vercel, what you save in
  Settings is stored in the database encrypted (AES-256-GCM) with
  `COLD_SECRET_KEY`, which lives only in Vercel's environment settings; a copy
  of the database alone does not reveal it.
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
  session cookie is `Secure` and browsers get HSTS (on Vercel this is
  automatic). Keep the `/data` volume private: it holds `.env.local` (mailbox
  passwords, API keys) and the database. On Vercel, the cron route answers
  only to `CRON_SECRET`, and sign-in limits are counted in the database, so
  every copy of the function shares them.
- **The Anthropic key is billed to you.** Keep `ANTHROPIC_API_KEY` in
  `.env.local` or the server's secrets, set a spend limit in the Claude
  Console, and rotate it if it leaks. Settings shows what the AI features used
  in the last 30 days.
- **AI never sends.** Research and drafts are suggestions: an email only goes
  out through a campaign send you start, with your caps, window and opt-outs;
  DMs and calls are always yours.
- **Diligence reads only the public internet.** A prospect's website comes
  from a list anyone could have written, so before COLD reads it, every
  address the name resolves to must be public (private, loopback, link-local,
  carrier and reserved ranges are refused, IPv4 and IPv6, in every spelling),
  each redirect is checked again, only `http` and `https` on the normal ports
  are read, and every page has a time and size limit. It honours robots.txt.
  A name that resolves to a public address when checked and a private one when
  fetched (DNS rebinding) is not fully ruled out; on a server with sensitive
  internal services, run diligence where they aren't reachable.
- **Decision models get no contact details.** Jev or Claude see the list row
  without email addresses, phone numbers or record ids. The TypeSafe and SubQ
  keys are billed to you, like the Anthropic key; Settings and the Score tab
  show usage per provider.
- **Prospect lists are personal data.** `prospects*.csv` is gitignored; the
  only CSV in the repository is the fictional example. The waitlist keeps a
  salted hash of each signup's address, never the address itself.
