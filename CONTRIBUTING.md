# Contributing to cold

## Getting started

```bash
git clone https://github.com/operatoruplift/cold.git
cd cold
bun install
bun run check          # typecheck + tests + message lint
```

## Adding or changing a message

1. Copy the closest file in `messages/` and keep the path pattern
   (`email/<voice>/<sequence>/<step>-<slug>.md`, `dm/...`, `call/<voice>/<slug>.md`).
2. Use only the variables in [messages/README.md](messages/README.md), or
   declare new ones under `variables:` in the front matter.
3. `bun run lint:messages`, then read it filled in:
   `bun run cold preview <id> --source csv:examples/prospects.csv`.
4. If the message changes what a sequence does, update the tree in
   `messages/README.md` and the library table in `README.md`. A test checks
   that both match the files.

House rules for copy: plain words, short sentences, one question per message,
no emojis, nothing invented. `proof` lines must be true.

## The site and the app

```bash
bun run dev            # http://localhost:4100 (site) and /app/, restarted on every change
```

- The public site is `src/site/`: plain HTML, CSS and one TypeScript file for
  the motion. No framework, and it must read without JavaScript.
- The app is `src/web/` (React). Pages call the API with `api()` from
  `src/web/lib/api.ts`; the browser imports server types with `import type`
  only, never runtime code (a test checks the bundle).
- The server is `src/domains/web/`: `server/` (the build, the request handler,
  the login gate), `api/` (campaigns and settings), `ai/` (the AI routes).
- Both are bundled when the server starts, so `bun run ui` and `bun run dev`
  always show your latest changes. In production, `bun run build` bundles them
  once into `dist/` (the Dockerfile runs it), and a server with
  `NODE_ENV=production` serves that instead. Files in `public/` are
  served as they are; reference them by absolute path (`/brand/cold-logo.svg`)
  from TypeScript and CSS, and let the server add the head tags.
- Colours, radii and sizes are tokens (`src/web/styles.css`,
  `src/site/site.css`) from the COLD palette in docs/brand.md; use them, and
  the components in `src/web/ui/`, instead of new values.

## AI

Prompts and schemas are in `src/domains/ai/tasks.ts`; the requests are built
in `src/domains/ai/claude.ts`. Tests use a fake Claude (`MessagesCall`), so
they never spend tokens. Keep the rules that make the output safe to send:
facts only from the prospect, the research or a page Claude opened; drafts are
never sent without approval.

## Code

The layout follows [dialer](https://github.com/matthewdonsemail-lab/dialer), the
open-source power dialer on Twenty that `cold` works alongside:

```
src/domains/<domain>/
  types.ts        types only
  helpers/        pure functions, one per file, with tests next to them
  index.ts        the entry point: I/O and wiring
```

- Files and folders are camelCase. Names mirrored from Twenty keep Twenty's
  spelling (`coldTouch`, `agencyProspect`).
- Anything that sends, writes or reads the network takes its dependencies as
  arguments (transport, store, reader, clock), so tests run it for real
  against fakes.
- A refusal says what to do next, in words.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), on a branch,
through a pull request. CI runs `bun run check`.
