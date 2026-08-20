# Configuration reference

Four files. Each owns one concern.

| File | Owns |
|---|---|
| `src/config.js` | collection identity — name, description, baseUri, chain |
| `src/ai.config.js` | AI mode — model, budget, concurrency |
| `chimera.traits.js` | your traits, weights, constraints, style anchor |
| `.env` | not read by the engine — see "API keys" below |

---

## `chimera.traits.js`

The file you will actually edit.

### Structure

```js
module.exports = {
  styleAnchor: "...",        // appended verbatim to EVERY prompt
  avoid: "...",              // what should never appear
  compositeLocally: ["Background"],
  traits: [ /* ... */ ],
  constraints: [ /* ... */ ],
};
```

### `traits[]`

```js
{
  name: "Headwear",              // becomes trait_type in metadata
  bypassDNA: false,              // optional: exclude from the uniqueness check
  options: [
    { value: "None",           weight: 34, prompt: null },
    { value: "Pirate Tricorn", weight: 12,
      prompt: "a black pirate tricorn hat with a skull emblem" },
    { value: "Sky Blue",       weight: 25, hex: "#7FB2E5" },
  ],
}
```

| Field | Meaning |
|---|---|
| `value` | what lands in metadata. Human-readable, title case |
| `weight` | relative within its own trait, **not** a percentage |
| `prompt` | what the model reads. Omit to use `value.toLowerCase()`. `null` contributes nothing |
| `hex` | required for traits in `compositeLocally` — the exact colour to fill |

**Weights are relative.** Given `25 / 20 / 18`, the odds are 25/63, 20/63,
18/63. They do not need to sum to 100.

**`prompt: null`** is how "None" works — the trait is rolled and recorded, but
adds nothing to the prompt.

### Reserved characters

`-`, `#` and `:` are structural in the DNA string. A value containing them is
slugged for encoding and the substitution is **logged, not silent**:

```
! trait "Expression" value "Wide-Eyed" contains a character reserved
  by DNA encoding; encoded as "Wide Eyed"
```

The display name survives intact — metadata still says `Wide-Eyed`. Only the
internal encoding changes. Left unhandled, this bug decodes DNA to the wrong
trait and corrupts an entire collection's metadata.

### `constraints[]`

Combinations that look wrong or confuse the model. Checked during the roll,
**before** the uniqueness check, so a rejection costs nothing.

```js
constraints: [
  { when: { Eyes: "Closed" },     forbid: { Accessory: ["Monocle"] } },
  { when: { Headwear: "Crown" },  forbid: { Outfit: ["Hoodie", "Bomber"] } },
  { when: { Outfit: "Suit" },     require: { Accessory: ["Neck Tie", "Monocle"] } },
]
```

`when`, `forbid` and `require` all accept a single value or an array. Every
key in `when` must match for the rule to fire.

Watch the impact on trait space — `ai:plan` reports how much survives:

```
combinations    806,736 total, ~730,055 valid after 4 constraints
```

### `compositeLocally`

Traits rendered by canvas instead of the model. Each option needs a `hex`.
See lever 6 in [consistency.md](consistency.md).

---

## `src/ai.config.js`

```js
module.exports = {
  reference: "./reference.png",
  editionSize: 1000,
  provider: "openrouter",
  model: "bytedance-seed/seedream-4.5",
  maxSpendUSD: 50,
  rerollAllowance: 0.15,
  concurrency: 4,
  maxAttemptsPerEdition: 3,
  output: { width: 1024, height: 1024, format: "png" },
};
```

| Option | Notes |
|---|---|
| `reference` | path to your character image, relative to the repo root |
| `editionSize` | override per run with `--size` |
| `provider` | `openrouter` or `mock` |
| `model` | see the table below |
| `maxSpendUSD` | **hard ceiling.** `0` allows only `mock` |
| `rerollAllowance` | fraction added to the estimate for QC failures |
| `concurrency` | simultaneous requests. Raise carefully |
| `maxAttemptsPerEdition` | retries before giving up on one edition |
| `qcModel` | optional; vision model for `ai:qc --verify` |
| `requestsPerMinute` | optional; enables the rate limiter |

### Models

One OpenRouter key reaches all of them. Prices verified 2026-08-21 for a
1024×1024 render carrying one 1024×1024 reference.

| Model | Per image | 1,000 +15% | Refs | Billing |
|---|---|---|---|---|
| `bytedance-seed/seedream-4.5` **default** | $0.040 | $46 | 14 | flat, no reference surcharge |
| `black-forest-labs/flux.2-klein-4b` | $0.014 | $16 | 4 | output only; no consistency claim |
| `openai/gpt-image-1-mini` | ~$0.012 | ~$14 | 16 | token-billed, approximate |
| `black-forest-labs/flux.2-pro` | $0.045 | $52 | 8 | $0.030 output + $0.015/MP input |
| `google/gemini-3.1-flash-image` | $0.067 | $77 | 14 | token-billed; SynthID watermark |
| `black-forest-labs/flux.2-max` | $0.100 | $115 | 8 | $0.070 output + $0.030/MP input |

Seedream 4.5 is the default because it charges **flat per image with no
surcharge for reference images**, even at 14 of them — which matters when every
call in an image-to-image run carries one.

Two things the API does not tell you:

- `flux.2-pro` and `flux.2-max` **do** bill input megapixels. Their `/endpoints`
  JSON omits this; only the model pages state it. The prices above already
  include it.
- Gemini output carries an invisible **SynthID watermark**.

**Stable Diffusion and SDXL are not on OpenRouter** — zero matches across its
417-model catalogue. Those need Replicate or fal.ai.

---

## `src/config.js`

Shared with layer mode. Collection identity: `namePrefix`, `description`,
`baseUri`, `network` (`eth` or `sol`), `solanaMetadata`, `extraMetadata`,
`rarityDelimiter`.

`extraMetadata` is merged into every metadata file:

```js
const extraMetadata = { creator: "navy" };
```

---

## API keys

Resolution order, most explicit first:

1. `--api-key <key>`
2. `OPENROUTER_API_KEY` in the environment
3. ~~`.env` in the repo root~~ — **not implemented.** There is no `dotenv`
   dependency, so a `.env` file is never loaded. Export the variable in your
   shell, or pass `--api-key`. `PINATA_JWT` for publishing is read the same
   way, from the environment only.

The key **never** enters `src/config.js`, `plan.json`, the ledger, or any error
dump. Every log line passes through a redactor that strips `sk-*` and
`Bearer *` patterns before printing — verified by a test.

```sh
export OPENROUTER_API_KEY=sk-or-v1-...
```
