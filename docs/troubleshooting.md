# Troubleshooting

Errors you will actually hit, what they mean, and what to do.

---

### `cannot produce 1,000 unique editions — only ~730 valid combinations exist`

Your trait space is too small. Maximum editions is the product of option counts
across all traits, reduced by constraints.

Add trait values (each new option multiplies the space), relax constraints, or
lower `editionSize`.

> Asking for more than ~50% of the valid space also flattens rarity and slows
> the roll — `ai:plan` warns when you cross that line.

---

### `this run would cost $230.00, above your ceiling of $50.00`

Working as intended. Nothing was written; an existing `plan.json` is untouched.

The message tells you exactly how many editions fit. Lower `--size`, choose a
cheaper `--model`, or raise `maxSpendUSD` deliberately.

---

### `no approved style reference`

A paid run is refusing to start because nothing is holding your character
consistent — every edition would come from the prompt alone.

```sh
npm run ai:ref               # render a master
# LOOK AT build/ai/reference/master.png
npm run ai:ref -- --approve
```

`--no-reference` opts out if you genuinely want prompt-only renders.

---

### `Refusing to clear build/: an AI run ledger exists`

`npm run build` (layer mode) wipes `build/`, which would delete AI renders you
paid for.

Move `build/ai/` elsewhere, or pass `--force` if you really mean it.

---

### `no API key for "openrouter"`

```sh
export OPENROUTER_API_KEY=sk-or-v1-...
```

Or pass `--api-key`. Confirm with `npm run ai:doctor`.

---

### `OpenRouter 400: ...`

A 400 means the request is malformed, so it is **not** retried — three retries
would be three wasted calls on the same mistake.

Usual causes: a model id that does not exist, `n > 1` on a model capped at 1, or
more references than the model accepts (`maxRefs` in `src/providers/models.js`).

---

### `OpenRouter 429`

Rate limited. Retried automatically with exponential backoff and jitter.

If it persists, lower `concurrency` in `src/ai.config.js` or set
`requestsPerMinute` to enable the token bucket.

---

### `no image in response. Keys: ...`

The provider returned something the adapter does not recognise. It throws with
the payload rather than writing a corrupt PNG.

Four response shapes are handled (`data[].b64_json`, `images[].b64_json`,
`data[].image_url.url`, plus http urls). A new one means the API changed —
`extractImage` in `src/providers/openrouter.js` is where to add it.

---

### QC flags almost the entire collection as twins

First check whether it is right. Genuinely repetitive art *should* be flagged —
this happens legitimately with the `mock` provider, which draws the same blob
in different colours.

QC prints the evidence:

```
nearest-neighbour distance over 300 sampled:
  min 0  p25 0  median 0  p75 0  max 4
  ! more than half the collection sits within the 5-bit twin threshold.
```

If your art really is varied, the threshold is too loose for it — use the
suggested `--twin-distance`.

---

### Rarity drift looks high

Drift is sampling variance, not a bug. At 100 editions a 4%-weight trait will
routinely land 2 or 6 times instead of 4.

Raise the edition count and drift shrinks. `npm test` proves the draw is
unbiased to within 4 standard errors over 30,000 samples.

---

### `canvas` fails to install

`canvas@2.8.0` cannot compile on Node 20. This repo pins `2.11.2`, which ships
prebuilt binaries.

```sh
node -v            # expect v20.x — see .nvmrc
rm -rf node_modules package-lock.json && npm install
```

---

### A run was killed — did I lose the money?

No. The ledger is `fsync`'d on every completion.

```sh
npm run ai:resume -- --yes
```

It skips everything already recorded. A torn final line from `kill -9` costs
one image, not the run.

---

### The studio says a run is still going but nothing is happening

One run at a time is enforced in the bridge. If a child process died without
reporting, restart the dev server — run state is in memory, while all real
progress is in the ledger and survives.

---

### Metadata says a trait the picture does not have

Expected, and the reason QC exists. Chimera guarantees metadata matches the
**request**, not the pixels.

```sh
npm run ai:qc -- --verify --yes    # flag mismatches
npm run ai:requeue -- --yes        # re-render the flagged
```

Budget 5–15% for this. The estimate already adds 15%.
