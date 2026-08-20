# Chimera

Generative NFT collection engine. Roll traits against real rarity weights, render the art, write metadata that matches.

---

## Status — read this first

Chimera is being built in two stages. Be clear on which one you're using.

| Stage | What it does | State |
|---|---|---|
| **Layer mode** | Composites transparent PNG layers you supply. Free, instant, fully deterministic. | ✅ **Working** |
| **AI mode** | Rolls traits, builds prompts, renders through an image model, writes matching metadata. | ✅ **Working** — end to end |
| **QC verification** | Vision-model check that each render contains the traits its metadata claims. | 🚧 **Not built yet** |

Both modes work. The pipeline has been run end to end for 1,000 editions on the
free `mock` provider — plan, render, hard-kill, resume, finalize — with zero
duplicate editions and zero double-billing.

**Real renders have not been run against a paid provider.** The OpenRouter
adapter is written and unit-tested against the documented response shapes, but
it needs your API key and your money to exercise for real. Start with
`npm run ai:smoke` (5 images, ~$0.20) before committing to a full run.

The page in [`web/`](web/) is a **design prototype and run configurator**. It demonstrates the trait-rolling algorithm and the rarity ledger in the browser, and emits a config file. It does not call any image API and cannot generate art.

---

## Requirements

- **Node.js 20** (see `.nvmrc`)
- `canvas` 2.11.2 — ships prebuilt binaries for Node 20, so no Cairo/Pango toolchain needed

```sh
npm install
```

> The original engine pinned `canvas@2.8.0`, which fails to compile on Node 20. Chimera pins 2.11.2.

---

## Usage — layer mode

Put your artwork in `layers/`, one folder per trait category. The number after `#` is the rarity weight:

```
layers/
├── Background/
│   ├── Black#1.png
│   └── Sky#40.png
├── Eyeball/
│   ├── Red#50.png
│   └── White#50.png
└── Top lid/
    ├── High#30.png
    ├── Low#20.png
    └── Middle#50.png
```

Every layer must be the **same dimensions** and have a **transparent background**, or they'll cover each other.

Then declare the draw order — back to front — in `src/config.js`:

```js
const layerConfigurations = [
  {
    growEditionSizeTo: 5,
    layersOrder: [
      { name: "Background" },
      { name: "Eyeball" },
      { name: "Eye color" },
      { name: "Iris" },
      { name: "Shine" },
      { name: "Bottom lid" },
      { name: "Top lid" },
    ],
  },
];
```

Generate:

```sh
npm run build
```

Output lands in `build/images/` and `build/json/`.

### Layer options

Each entry in `layersOrder` takes an optional `options` object:

| Option | Effect |
|---|---|
| `blend: MODE.overlay` | Canvas blend mode — see `constants/blend_mode.js` |
| `opacity: 0.7` | Layer alpha |
| `bypassDNA: true` | Exclude from the uniqueness check (still drawn) |
| `displayName: "Fur"` | Rename the trait in metadata |

### Scripts

| Command | Does |
|---|---|
| `npm run build` | Generate the collection |
| `npm run rarity` | Print actual trait distribution across the run |
| `npm run preview` | Contact-sheet collage of the collection |
| `npm run pixelate` | Pixelated copies into `build/pixel_images/` |
| `npm run update_info` | Rewrite `baseUri` / description in existing metadata |
| `npm run preview_gif` | Animated GIF preview |

---

## How rarity works

Weights are relative within a category, not percentages. Given `Low#20`, `Middle#50`, `High#30`, the odds are 20/100, 50/100, 30/100.

Small runs will not match those odds. At 5 editions a 30%-weight trait frequently lands zero times — that's variance, not a bug. Run `npm run rarity` to see actual distribution, and expect it to converge only as the edition count grows.

Maximum unique editions is the product of the option counts across every layer in `layersOrder`. Exceed it and the engine stops with a "you need more layers" error rather than emitting duplicates.

---

## Usage — AI mode

Declare your traits as text in [`chimera.traits.js`](chimera.traits.js), set your
budget in [`src/ai.config.js`](src/ai.config.js), then:

```sh
npm run ai:doctor                        # pre-flight: traits, space, key, budget
npm run ai:plan                          # roll offline, estimate cost. FREE
npm run ai:generate -- --provider mock   # full dry run. FREE
npm run ai:finalize                      # composite backgrounds, write metadata

export OPENROUTER_API_KEY=sk-or-...
npm run ai:smoke -- --yes                # 5 real images, ~$0.20
npm run ai:generate -- --yes             # the real thing
npm run ai:resume -- --yes               # continue after a stop. Never re-bills
```

### The spend ceiling

`maxSpendUSD` in `src/ai.config.js` is a hard ceiling, not a warning. It is
enforced twice — `ai:plan` refuses to write an over-budget plan, and
`ai:generate` halts mid-run the moment cumulative spend would cross it.
Override per run with `--max-spend`.

```
ERROR  this run would cost $230.00, above your ceiling of $50.00.
       Nothing was written. Choose one:
         - lower --size (1086 editions fits)
         - pick a cheaper --model
         - raise maxSpendUSD in src/ai.config.js deliberately
```

Paid runs also require `--yes`. Without it the command prints the bill and exits.

### Why traits come first

A diffusion model produces no discrete traits on its own. Chimera rolls the
combination first — with the same weighted engine layer mode uses — then writes
the prompt from it. Metadata therefore records what you *asked for*, and rarity
stays computable.

The full reasoning, including the seven levers that keep 1,000 renders on-model,
is in [docs/ai-mode-plan.md](docs/ai-mode-plan.md).

### Tests

```sh
npm test        # 30 tests, no dependencies
```

Includes statistical checks that the weighted draw converges within 4 standard
errors over 30,000 samples, that a hard-killed ledger resumes without
double-billing, and that a 4xx is never retried.

### Models

One **OpenRouter** key reaches every model below via `POST /api/v1/images`, whose `input_references` field carries the reference image. Prices verified 2026-08-21 for a 1024x1024 render with one 1024x1024 reference.

| Model | Per image | 1000 (+15% rerolls) | Refs | Billing |
|---|---|---|---|---|
| `bytedance-seed/seedream-4.5` **default** | $0.040 | $46 | 14 | flat, no reference surcharge |
| `black-forest-labs/flux.2-klein-4b` | $0.014 | $16 | 4 | output only; no consistency claim |
| `openai/gpt-image-1-mini` | ~$0.012 | ~$14 | 16 | token-billed, approximate |
| `black-forest-labs/flux.2-pro` | $0.045 | $52 | 8 | $0.030 output + $0.015/MP input |
| `google/gemini-3.1-flash-image` | $0.067 | $77 | 14 | token-billed; SynthID watermark |
| `black-forest-labs/flux.2-max` | $0.100 | $115 | 8 | $0.070 output + $0.030/MP input |

Seedream 4.5 is the default because it bills flat per image with **no surcharge for reference images** even at 14 of them — which matters when every call in the run carries one.

**Stable Diffusion / SDXL are not on OpenRouter** (0 matches across its 417-model catalog). Those need Replicate or fal.ai, which is also the only route to a custom character LoRA.

Known costs of that approach, which will be documented rather than hidden: every render is a paid API call, style drifts across a long run, and the model can silently omit a trait you asked for — so metadata matches the *request*, not the pixels.

---

## Credit

Chimera is a derivative of [HashLips Art Engine](https://github.com/HashLips/hashlips_art_engine) by Daniel Eugene Botha. The DNA, rarity, uniqueness and metadata engine is his work. MIT licensed — see [LICENSE](LICENSE), which retains the original copyright.
