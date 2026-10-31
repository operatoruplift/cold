# Host COLD

Hosting puts the site and its waitlist on the web, and lets you install the app
on your phone. It is one container with one volume. Pick any host that runs a
Dockerfile and keeps a disk: the steps for Railway, Render and Fly are below,
and any VPS works the same way.

## What the server needs

| Setting | Value |
|---|---|
| Build | the `Dockerfile` in this repository |
| Volume | mounted at `/data` (500 MB is plenty). It holds `cold.yaml`, `.env.local`, the database (waitlist, login, AI drafts), prospect lists and your copy of the message library. |
| `COLD_PUBLIC_URL` | the address people open, e.g. `https://cold.example.com`. Railway, Render and Fly set it for you from their own domain; set it yourself for a custom domain. |
| `COLD_ALLOWED_HOSTS` | optional: other host names that reach the same server, comma separated. Railway's, Render's and Fly's own domains are added for you. |
| `COLD_PROXY_HOPS` | how many proxies sit in front: 1 (default) for the host's own, 2 with a front door such as Vercel |
| Port | the server reads `PORT` (default 4100) |
| Health check | `GET /api/health` |
| Secrets | optional here: `ANTHROPIC_API_KEY`, `SMTP_URL_*`, `IMAP_URL_*`, `TWENTY_*`. You can also paste them in Settings once you're in; those are saved to `/data/.env.local`. |

Only one instance should run: the login rate limits and running sends live in
the server's memory, and the database is a file on the volume.

It is small: the Dockerfile bundles the site and the app when the image is
built (`bun run build`), the mail and AI libraries load the first time they're
used, and an idle server holds about 40 MB of memory.

## First start

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

## Railway

The repository carries a `railway.json`: Railway builds the `Dockerfile`,
checks `/api/health` before switching traffic, and restarts COLD if it stops.
COLD fits in Railway's free plan, whose monthly credit covers a server this
size running all the time.

1. [railway.com](https://railway.com), New Project, Deploy from GitHub repo,
   pick `operatoruplift/cold` (let Railway's GitHub app see it if asked).
   The first deploy stops with "Set COLD_PUBLIC_URL": expected, the next steps
   fix it.
2. In the service, Settings, Networking, Generate Domain (target port 4100 if
   it asks). You get an address like `cold-production.up.railway.app`, which
   COLD picks up as `RAILWAY_PUBLIC_DOMAIN`; you can edit the name before the
   `.up.railway.app`.
3. Attach a volume to the service, mounted at `/data`.
4. Variables (optional now, or later in COLD's Settings): `ANTHROPIC_API_KEY`
   and your `SMTP_URL_*`, `IMAP_URL_*`, `TWENTY_*`. Behind a front door such as
   Vercel (next section), also `COLD_PUBLIC_URL` and `COLD_PROXY_HOPS=2`.
5. Deploy. The deploy logs print the setup link for your login.

Leave Serverless (Railway's app sleeping) off: the first request to a sleeping
server can get a 502 while it wakes, and a send would stop halfway. Every push
to `main` redeploys; `/data` stays.

## A front door on Vercel

Vercel cannot run COLD itself (no disk, no long-running process), but a
Vercel address can stand in front of it, so people see
`https://coldthecompany.vercel.app` while Railway does the work. Deploy a
project that holds only this `vercel.json`, with your Railway domain:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "routes": [{ "src": "/(.*)", "dest": "https://cold-production.up.railway.app/$1" }]
}
```

On Railway set `COLD_PUBLIC_URL=https://coldthecompany.vercel.app` (cookies,
links and the setup link use it; Railway's own domain keeps working) and
`COLD_PROXY_HOPS=2`, so rate limits read the visitor's address that Vercel
records rather than Vercel's own. Every AI request runs in the background, so
no request waits on Claude behind the proxy.

## Render

1. New, Web Service, from your repository; runtime Docker.
2. Add a disk mounted at `/data` (disks need a paid instance).
3. Health check path `/api/health`. Render passes its URL as
   `RENDER_EXTERNAL_URL`; for a custom domain set `COLD_PUBLIC_URL`.
4. Deploy, then open the setup link from the logs.

## Fly

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
setting anything. Keep `auto_stop_machines` off: a stopped machine stops a
send halfway through its batch.

## A VPS

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

## Serverless hosts

Vercel, Netlify and other function hosts are not a fit: COLD keeps a database
on disk, and a send runs for minutes in the background. Host the container
somewhere that keeps it running.

## Behind the scenes

- The server answers only on `COLD_PUBLIC_URL`'s host name (and `localhost`),
  so another domain cannot point at it.
- Session cookies are `Secure`, `HttpOnly` and `SameSite=Strict`; pages carry a
  strict Content Security Policy and HSTS.
- Client addresses for rate limiting come from `X-Forwarded-For`, read
  `COLD_PROXY_HOPS` entries from the end (default 1: the one your host's proxy
  adds; 2 with a front door like Vercel). Set `COLD_TRUST_PROXY=0` if nothing
  sits in front of COLD.
- Updates: redeploy. The service worker notices the new version and the app
  offers to reload. Your files on `/data` stay; the message library there is
  your copy, so new messages from an update are not copied over it. Compare
  with the repository's `messages/` if you want them.
