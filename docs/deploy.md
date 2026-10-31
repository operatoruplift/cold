# Host COLD

Hosting puts the site and its waitlist on the web, and lets you install the app
on your phone. There are two ways:

- **Vercel**: the site and the app are static files on Vercel's CDN, the API
  is one function, and everything you save lives in a Turso database (free
  plan). Nothing to keep running or patch.
- **The Dockerfile**, on any host that keeps a disk: Railway, Render, Fly or a
  VPS. One container, one volume.

## On Vercel

The repository carries a `vercel.json`: Vercel builds the site and the app
(`bun run build:vercel`), serves them from its CDN with COLD's security
headers, runs `api/index.ts` on Bun for everything under `/api`, and calls the
send runner every minute (a cron job). Your files (cold.yaml, the message
library, prospect lists, campaigns), the touch log, the waitlist, your login
and AI drafts live in Turso, which is SQLite over the network.

1. In Vercel, **Add New, Project**, and import your copy of the repository
   (or, for a project you already have, Settings, Git, Connect Git
   Repository). `vercel.json` sets the build; there is nothing to change.
2. **Storage, Create Database, Turso**: pick the free plan and the region your
   functions run in (Washington, D.C., `iad1`, unless you changed it), and
   connect it to the project for Production and Preview. It adds
   `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
3. **Settings, Environment Variables**, as Sensitive, for Production and
   Preview:
   - `COLD_SECRET_KEY`: a long random string (`openssl rand -base64 36`). It
     encrypts the keys and passwords you save in COLD's Settings; change it
     and the saved ones can no longer be read.
   - `CRON_SECRET`: another random string. Vercel's cron sends it to
     `/api/cron/tick`, and COLD refuses the tick without it.
   - `COLD_PUBLIC_URL`, for Production only, if people should use a custom
     domain rather than `<project>.vercel.app`.
4. **Deploy** (or redeploy, so the new variables apply). The first request
   creates the tables and copies the message library into the database.
5. Open the project's **Logs** and find
   `First run: create your login at https://…/app/?setup=…`. Open that link,
   choose your email and password, and you're in.

Then, in the app's Settings, create cold.yaml and add your mailbox, Anthropic
and Twenty keys: they are saved in the database, encrypted.

How it behaves:

- **Sends** go one email at a time, saved after each. The pause between two
  emails is waited out by the function when it fits before its time limit;
  otherwise the cron job picks the send up within a minute of the next email
  being due. Stop works at any point. An email that was going out when a
  function stopped is never sent twice: it is marked "interrupted", so check
  your Sent folder.
- **AI runs** keep going after the response, up to the function's limit (800
  seconds); one that is cut off shows as failed.
- **Rate limits and the setup code** are counted in the database, so every
  copy of the function agrees.
- **A forgotten password**: pull the project's variables and reset it from
  your computer, which then writes to the same database:

  ```bash
  vercel env pull .env.local
  ```

  ```bash
  bun run cold owner
  ```

- **Updates**: push to the branch Vercel deploys. Your data stays in Turso.
  The message library in the database is your copy, so new messages from an
  update are not copied over it; compare with the repository's `messages/` if
  you want them.

## With the Dockerfile

### What the server needs

| Setting | Value |
|---|---|
| Build | the `Dockerfile` in this repository |
| Volume | mounted at `/data` (500 MB is plenty). It holds `cold.yaml`, `.env.local`, the database (waitlist, login, AI drafts, sends), prospect lists and your copy of the message library. |
| `COLD_PUBLIC_URL` | the address people open, e.g. `https://cold.example.com`. Railway, Render and Fly set it for you from their own domain; set it yourself for a custom domain. |
| `COLD_ALLOWED_HOSTS` | optional: other host names that reach the same server, comma separated. Railway's, Render's and Fly's own domains are added for you. |
| `COLD_PROXY_HOPS` | how many proxies sit in front: 1 (default) for the host's own, 2 when another proxy forwards to it |
| Port | the server reads `PORT` (default 4100) |
| Health check | `GET /api/health` |
| Secrets | optional here: `ANTHROPIC_API_KEY`, `SMTP_URL_*`, `IMAP_URL_*`, `TWENTY_*`. You can also paste them in Settings once you're in; those are saved to `/data/.env.local`. |

Only one instance should run: the database is a file on the volume.

It is small: the Dockerfile bundles the site and the app when the image is
built (`bun run build`), the mail and AI libraries load the first time they're
used, and an idle server holds about 40 MB of memory.

### First start

The logs print a setup link:

```
First run: create your login at https://cold.example.com/app/?setup=K7QM-2XDP-9TAH
```

Open it, choose your email and password, and you're in. The code works once,
until the login exists. To skip the web setup, set the login from the
environment instead:

```bash
bun run cold owner hash
```

and give the server `COLD_OWNER_EMAIL` and `COLD_OWNER_PASSWORD_HASH`. To
reset a forgotten password on the server, open its shell and run
`bun run cold owner`.

### Railway

The repository carries a `railway.json`: Railway builds the `Dockerfile`,
checks `/api/health` before switching traffic, and restarts COLD if it stops.

1. [railway.com](https://railway.com), New Project, Deploy from GitHub repo,
   pick your copy of the repository. The first deploy stops with
   "Set COLD_PUBLIC_URL": expected, the next steps fix it.
2. In the service, Settings, Networking, Generate Domain (target port 4100 if
   it asks). COLD picks the address up as `RAILWAY_PUBLIC_DOMAIN`.
3. Attach a volume to the service, mounted at `/data`.
4. Variables (optional now, or later in COLD's Settings): `ANTHROPIC_API_KEY`
   and your `SMTP_URL_*`, `IMAP_URL_*`, `TWENTY_*`.
5. Deploy. The deploy logs print the setup link for your login.

Leave Serverless (Railway's app sleeping) off: the first request to a sleeping
server can get a 502 while it wakes. Every push redeploys; `/data` stays.

### Render

1. New, Web Service, from your repository; runtime Docker.
2. Add a disk mounted at `/data` (disks need a paid instance).
3. Health check path `/api/health`. Render passes its URL as
   `RENDER_EXTERNAL_URL`; for a custom domain set `COLD_PUBLIC_URL`.
4. Deploy, then open the setup link from the logs.

### Fly

```bash
fly launch --no-deploy
```

```bash
fly volumes create cold_data --size 1
```

Add to the generated `fly.toml`:

```toml
[mounts]
  source = "cold_data"
  destination = "/data"

[http_service]
  internal_port = 4100
  auto_stop_machines = "off"
```

```bash
fly deploy
```

Fly gives COLD `FLY_APP_NAME`, so `https://<app>.fly.dev` works without
setting anything. Keep `auto_stop_machines` off, so a send waiting for its
next email is not left waiting for the next visitor.

### A VPS

Run it behind a reverse proxy that terminates HTTPS (Caddy does it in two
lines):

```bash
docker build -t cold .
```

```bash
docker run -d --name cold --restart unless-stopped -p 127.0.0.1:4100:4100 -v cold-data:/data -e COLD_PUBLIC_URL=https://cold.example.com cold
```

```
cold.example.com {
  reverse_proxy 127.0.0.1:4100
}
```

## Behind the scenes

- The server answers only on its own host names (the public URL's, the
  platform's, and `localhost`), so another domain cannot point at it.
- Session cookies are `Secure`, `HttpOnly` and `SameSite=Strict`; pages carry a
  strict Content Security Policy and HSTS.
- Client addresses for rate limiting come from `X-Forwarded-For`, read
  `COLD_PROXY_HOPS` entries from the end (default 1: the one the host's proxy
  adds; Vercel sets it itself). Set `COLD_TRUST_PROXY=0` if nothing sits in
  front of COLD.
- Updates: redeploy. The service worker notices the new version and the app
  offers to reload.
