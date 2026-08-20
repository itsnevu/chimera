# The pipeline, stage by stage

Six stages. **Money moves in three of them**, and each of those three stops and
asks first.

```
0  DOCTOR      free      validate before anything is at risk
1  REFERENCE   ~$0.05    one master model sheet + human approval  ← THE GATE
2  PLAN        free      roll the whole collection offline
3  SMOKE       ~$0.20    render 5, look at them, decide
4  GENERATE    N × unit  the real run, resumable
5  QC          free/paid catch what came back wrong
6  FINALIZE    free      composite, write metadata
```

---

## Stage 0 — Doctor

```sh
npm run ai:doctor
```

Checks, in order, everything that can be wrong before money is at risk:

- trait config parses, no duplicate names or values, all weights positive
- **the trait space is large enough** — can N unique combinations even exist
  after constraints? Discovering this halfway through a paid run is expensive
- provider and model are known
- an API key is present in the environment
- projected cost sits under `maxSpendUSD`
- the reference image exists
- a ledger already exists (so you know a re-run will skip, not redo)

Exits non-zero on failure, so it works in a script.

```
CHIMERA — DOCTOR
──────────────────────────────────────────────────────────────
  OK    trait config valid — 7 categories
  OK    trait space: ~730,015 valid for 1,000 editions
  OK    provider "openrouter"
  OK    model Seedream 4.5 — $0.04/image
  WARN  no API key in the environment
  OK    budget: ~$46.00 of $50 ceiling
```

---

## Stage 1 — Style bible

```sh
npm run ai:ref                  # normalise + render the master
npm run ai:ref -- --approve     # after you have LOOKED at it
npm run ai:ref -- --anchors     # optional, 2 more calls
npm run ai:ref -- --status      # what exists right now
```

### Why this stage exists

Pointing a thousand renders at whatever photo you happened to upload is the
single biggest cause of style drift. Your upload has its own lighting, crop,
pose and background, and the model reinterprets all of it differently every
time.

### What it does

**Normalise** (local, free). Centre-crops to a square — never squashes, never
letterboxes — scales to the output size, and flattens onto white so a
transparent source does not hash as noise. → `build/ai/reference/base.png`

**Render the master** (one paid call). Asks for a *reference sheet*, not
artwork:

```
character reference sheet of this exact character,
front-facing, centred bust portrait, neutral calm expression,
no headwear, no clothing, no accessories,
plain flat neutral grey background, even studio lighting,
<your styleAnchor>
```

Deliberately the most neutral possible version of the character, so later
prompts only ever *add*. → `build/ai/reference/master.png`

**Then it stops.** Approval is manual and required:

```
>>> LOOK AT IT NOW. <<<
Every edition you pay for will be rendered against this image.
If the character is wrong here, all 1000 will be wrong.
```

**Anchors** (optional, 2 calls) show the character wearing a hat and a jacket.
Seedream accepts 14 references at no extra charge, so this costs about $0.08
and teaches the model how your character *wears* things, not just what its face
looks like.

### Approval is revoked when the master changes

Re-running `ai:ref` clears the approval flag. A reference nobody has looked at
must never silently become the basis for a thousand images.

---

## Stage 2 — Plan

```sh
npm run ai:plan
npm run ai:plan -- --size 500 --model black-forest-labs/flux.2-klein-4b
```

Free, offline, no network. Rolls every DNA, rejects constraint violations and
duplicates, builds every prompt, derives every seed, writes `plan.json`, prints
the bill, and stops.

```
CHIMERA — PLAN
──────────────────────────────────────────────────────────────
  traits          7 categories, 49 values
  combinations    806,736 total, ~730,055 valid after 4 constraints
  rolled          1,000 unique editions in 1,030 attempts
  rejected        24 by constraint, 6 as duplicate

  RARITY — target vs actual (flagged when off by more than 2 points)
    Background   max drift  2.3 pts
    ...
    worst drift across all traits: 3.10 points

  COST
    model         Seedream 4.5  (bytedance-seed/seedream-4.5)
    billing       flat per image, no reference surcharge
    per image     $0.040   priced 2026-08-21
    1,000 editions  $40.00
    +15% rerolls  $46.00   <- plan for this
    wall time     ~21m at concurrency 4
    ceiling       $50.00  (maxSpendUSD)
```

Because planning is free, iterate here. Change weights, re-plan, read the
drift, repeat. Nothing is spent until stage 3.

### Reading the rarity report

Under `rollMode: "urn"` — the default — drift is **0.00 points**. Counts are
allocated exactly before anything is dealt, so the only residual is integer
rounding when a weight does not divide the edition count.

Under `rollMode: "independent"` drift has two separate sources, and only one of
them is variance:

- **Sampling variance.** At 100 editions a 4%-weight trait will routinely land
  2 or 6 times instead of 4. This shrinks as the edition count grows.
- **Rejection bias, which does not shrink.** Discarding a tuple that violates a
  constraint discards *every* trait in it, so values named by constraints come
  up systematically short. Measured over 400,000 accepted rolls of the sample
  config:

  | Trait | Declared | Shipped | Deficit |
  |---|---|---|---|
  | Headwear / Crown | 4.00% | 3.24% | −0.76 |
  | Accessory / Monocle | 10.00% | 9.31% | −0.69 |
  | Outfit / Hoodie | 15.00% | 14.43% | −0.57 |
  | Expression / Grin | 12.00% | 11.44% | −0.56 |

  The standard error at that sample size is ±0.031 points. A 0.76 point gap is
  twenty-four standard errors — it is bias, and more editions will not fix it.

Earlier versions of this page told you all drift was variance. That was wrong
for any collection with constraints.

---

## Stage 3 — Smoke

```sh
npm run ai:smoke -- --yes
```

Renders **five** editions from the plan and stops. About $0.20.

This is the decision point. If five images come back on-model and on-trait, the
remaining 995 probably will too. If they do not, you have learned it for pocket
change instead of $46.

Adjust `styleAnchor` or `avoid` in `chimera.traits.js`, re-plan, smoke again.

---

## Stage 4 — Generate

```sh
npm run ai:generate -- --provider mock      # full dry run, free
npm run ai:generate -- --yes                # the real thing
npm run ai:resume -- --yes                  # continue after a stop
```

`ai:resume` is the same command — the ledger makes resumption automatic, so
there is nothing separate to remember.

### What happens per edition

1. check cumulative spend against the ceiling; halt if the next call would cross it
2. take a token from the rate-limit bucket
3. send `[master, ...anchors]` + prompt + seed to the provider
4. retry on 429/5xx with exponential backoff and jitter; **never** retry a 4xx
5. write the PNG
6. append to `ledger.jsonl` and `fsync` — cost recorded first
7. report progress every 50 editions

### Resumption, demonstrated

A full run was killed with `kill -9` at edition 212:

```
already done    212  ($0.00 already spent)
to render       788
rendered        788 in 22.5s
```

Ledger held exactly 1,000 unique entries afterwards, zero duplicates. Nothing
was billed twice.

---

## Stage 5 — QC

```sh
npm run ai:qc                        # free
npm run ai:qc -- --verify --yes      # paid, per-edition vision call
npm run ai:requeue -- --yes          # drop the flagged, re-render them
```

### Free tier

- unreadable or missing files
- **flat renders** — solid colour, blank, or an error card. These still cost
  money and would otherwise ship
- **visual twins** — a 160-bit perceptual hash, 64 bits of structure plus 96 of
  colour

Colour is in the hash because structure alone is not enough. Measured on real
output: two finished editions whose backgrounds were entirely different colours
scored **0 bits apart** under a structure-only dHash. It is brightness-based and
nearly colour-blind, so on a collection where Background is a trait it would
flag almost everything as duplicate.

QC also reports the nearest-neighbour distance spread and suggests a threshold,
because the right value depends on how varied your art is:

```
nearest-neighbour distance over 300 sampled:
  min 0  p25 0  median 0  p75 0  max 4
  ! more than half the collection sits within the 5-bit twin threshold.
    Either the art really is repetitive, or the threshold is too loose
    for it — try --twin-distance 1
```

### Paid tier

`--verify` shows each render to a vision model with its trait list and asks,
**per trait**, whether it is visible. Per-trait rather than an overall score,
because "is the tricorn there" is answerable and "is this edition good" is not.

A trait the model does not mention is recorded `present: null` — unverified,
never a pass. Silence is not approval.

### Requeue

The one destructive operation in the repo, so it is careful: it timestamps a
ledger backup, **moves** rejected images to `build/ai/rejects/` rather than
deleting them (you paid for those), and prints the re-render cost unless given
`--yes`.

---

## Stage 6 — Finalize

```sh
npm run ai:finalize
```

Free, local, re-runnable. Never touches `build/ai/raw`, so you can finalize
repeatedly without re-rendering.

- composites the traits listed in `compositeLocally` under each render
- writes `build/images/N.png` and `build/json/N.json` plus `_metadata.json`
- reports rarity **as shipped**, which is what the collection actually contains

### Why compositing locally beats generating

Backgrounds in the sample config are flat colours whose hex values are already
known. Asking a model to paint `#EFA0B4` is paying for a worse result:

| | generated | composited |
|---|---|---|
| Trait fidelity | approximate | exact |
| Cost | included in the render | free |
| Prompt length | longer | shorter → better adherence elsewhere |

The render asks for `background: transparent`; `finalize` fills the exact hex
underneath. Same trick works for frames, borders and watermarks.
EOF
