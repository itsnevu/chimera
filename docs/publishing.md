# Publishing and validation

Two steps between a finished collection and a mint. Do them in this order —
validation is free and catches things that are permanent once pinned.

## Validate first

```sh
npm run validate
```

Marketplaces do not tell you your metadata is malformed. They render the
collection wrong, or not at all, after it is minted and immutable.

Run against the sample config, straight out of the box:

```
ERRORS (2000)
  image URI is still a placeholder: ipfs://NewUriToReplace/N.png   [#1, 2, 3, 4, …]  x1000
  description is still the placeholder                             [#1, 2, 3, 4, …]  x1000

  2000 error(s) — do NOT mint this collection.
```

That is the single most common shipping mistake, and it exists in every fresh
clone until you edit `src/config.js`.

### What it checks

**Errors** — exit code 1, do not mint:

| Check | Why |
|---|---|
| Required fields present | ERC-721 / Metaplex minimums |
| Placeholder URIs and descriptions | `NewUriToReplace`, `example.com`, `YOUR_` |
| Duplicate edition numbers | breaks every tool that keys on token id |
| Reused image URIs | two tokens showing the same art |
| Duplicate DNA | two editions sharing a trait combination |
| Attribute shape | `trait_type` a string, `value` a scalar, no repeats |
| Uniform trait sets | rarity tools silently compute different denominators otherwise |
| Missing expected traits | compared against `chimera.traits.js` |
| Solana `properties.files` | non-empty, with `uri` and `type` |

**Warnings** — worth a look, not fatal: URIs without a scheme, unexpected extra
traits, gaps in edition numbering.

Errors are grouped by kind rather than listed 1,000 times.

---

## Publish to IPFS

```sh
npm run ai:publish                    # dry run — always the default
export PINATA_JWT=...
npm run ai:publish -- --yes           # actually pin
npm run validate                      # confirm no placeholders survived
```

### Dry run is the default, deliberately

```
DRY RUN. Pinning to IPFS is public and effectively permanent —
a CID cannot be unpublished once others have fetched it.
Check build/json/1.json looks right, then re-run with --yes.
```

Unlike a bad render, a bad pin cannot be undone. Unpinning removes *your*
copy; anyone who fetched it can keep serving it.

### Two passes

Metadata cannot be written until images have a CID, so:

1. **Images.** Every PNG is pinned, each CID appended to `build/ai/pins.jsonl`.
   Same ledger discipline as rendering — a stopped upload resumes rather than
   re-pinning.
2. **Metadata.** Each file's `image` is rewritten to its real `ipfs://CID`,
   then `_metadata.json` is rebuilt. Solana keeps `properties.files[0].uri` in
   sync too.

Afterwards, pin `build/json/` yourself and set `baseUri` to that CID.

### Honest status

The Pinata adapter is written against their documented v3 API and unit-tested
structurally, but **has not been exercised against the live service** — that
needs an account and a JWT. Expect to hit at least one shape mismatch on the
first real run; the adapter throws with the actual payload rather than writing
a corrupt record.

Start small: finalize a 10-edition collection and publish that before a
thousand.

---

## Training a LoRA — the path not taken

The real fix for style drift is a character LoRA: fine-tune a small adapter on
20–30 images of your character, then every generation starts from a model that
already knows it. Reference conditioning approximates this; a LoRA *is* it.

**Chimera does not do this, and shipping an untested trainer would be worse
than shipping nothing.** Here is the honest shape of it:

| | Reference conditioning (what Chimera does) | LoRA |
|---|---|---|
| Setup cost | one $0.04 master render | $2–10 GPU time, plus a dataset |
| Setup effort | upload one image | curate 20–30 consistent images |
| Per-image cost | same | same or lower |
| Consistency | good — 5–15% reroll rate | excellent — low single digits |
| Iteration | re-render the master, seconds | retrain, tens of minutes |
| Where | OpenRouter | Replicate or fal.ai; **not** OpenRouter |

**The bootstrap problem:** training needs 20–30 consistent images of a
character you do not have yet. In practice you use Chimera as it stands to
generate a first batch, hand-pick the best 25, train on those, then re-run
against the LoRA.

So the sequence is *reference conditioning first, LoRA second* — which is why
it is not the starting point.

If you want it: `replicate.com/ostris/flux-dev-lora-trainer` (or the current
equivalent) takes a zip of images and returns a LoRA weights URL. Wiring that
in means a new provider adapter — the `src/providers/` contract is one async
`render()` function, so it is a contained piece of work. Ask when you have the
dataset.
