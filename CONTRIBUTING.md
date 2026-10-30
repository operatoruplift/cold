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
