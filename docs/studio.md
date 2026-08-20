# Chimera Studio

A Next.js UI over the same CLI. Nothing it does is unavailable from the
terminal — every button spawns the exact `npm run` a human would type, with
cwd pinned to the repo root.

That single code path is the point. There is no second implementation of the
pipeline to drift out of sync with the first.

```sh
cd studio
npm install
npm run dev        # http://localhost:3000
```

Requires the engine's own `npm install` in the repo root first — the studio
shells out to it.

## Layout

```
398px control column          proof sheet
────────────────────          ────────────────────────────────
01  STYLE REFERENCE           every planned edition as a cell
02  PLAN — FREE, OFFLINE      rendered ones show their art
03  GENERATE                  click any cell -> traits + prompt
04  QUALITY CONTROL           live engine log underneath
```

Each stage shows its own state — `DONE`, `NOW`, `BLOCKED`, or idle — so the
next action is always visible rather than remembered.

## Why an API key field is safe here

The key is posted to a **route handler**, held in the server process for the
lifetime of that run, and passed to the child process through its environment.

It is never written to disk, never returned to the browser, and every line of
engine output passes through a redactor before reaching the client.

This is the reason the studio exists as a server app rather than a static page:
a browser-only tool would have to hold your key in client JavaScript.

## HTTP API

### `GET /api/status`

Everything the UI renders from — config, reference state, plan summary,
rendered count, spend, QC summary, and current run state including the log
tail.

### `GET /api/plan` · `POST /api/plan`

`GET` returns the rolled editions with traits, prompts and seeds.
`POST { size?, model?, maxSpend? }` runs the planner. Free, no key.

### `GET /api/generate` · `POST /api/generate`

`GET` returns progress read from the ledger — the engine's own source of truth,
so the UI cannot disagree with the CLI.

`POST { provider, apiKey?, limit?, maxSpend?, confirm }` starts a run. A paid
run is rejected without both `confirm: true` and a key.

### `POST /api/reference`

`multipart/form-data` with `file` uploads the character image. PNG, JPEG or
WebP, 12 MB maximum, saved to the configured path — the client-supplied
filename is never used.

`{ action: "master" | "anchors" | "approve", apiKey?, provider? }` drives the
style bible.

### `GET /api/qc` · `POST /api/qc`

`GET` returns the last report. `POST { verify?, apiKey?, twinDistance? }` runs
QC.

### `GET /api/image/[id]`

| id | serves |
|---|---|
| `42` | `build/images/42.png` |
| `raw-42` | `build/ai/raw/00042.png` |
| `master`, `base` | the style bible images |
| `anchor-headwear` | an anchor |

Ids are matched against that fixed vocabulary and the resolved path is checked
to remain inside the repo — a crafted id cannot walk out of the build
directory. Anything else is a 404.

## Concurrency

**One run at a time**, enforced in the bridge. Two concurrent `ai:generate`
processes would both append to the same ledger and double-bill the overlap.
A second start returns HTTP 409.

## Polling

The UI polls `/api/status` every 2.5 s idle, 700 ms while a run is active.
Progress comes from the ledger rather than from parsing stdout, so a page
refresh mid-run loses nothing.
