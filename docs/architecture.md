# Architecture

## The one decision everything follows from

A diffusion model produces a flat image. It does not produce traits.

Ask a model for "a cat wearing something" a thousand times and you have a
thousand pictures that no marketplace can filter, no rarity tool can rank, and
no metadata can honestly describe. Captioning them afterwards does not fix it —
you would be recording a guess about what the model drew, not a fact about what
the collection contains.

So Chimera inverts the order:

```
roll the trait combination  →  build the prompt from it  →  render  →  write
                                                                      metadata
                                                                      from the
                                                                      ROLLED
                                                                      traits
```

Rarity stays computable because the weights were applied before anything was
drawn. Metadata stays truthful because it records what was requested. That is
the entire architectural thesis, and every other decision in this repo is
downstream of it.

## Layer mode and AI mode share one engine

```
                      ┌──────────────────────────┐
                      │  src/core/dna.js         │
                      │  weighted draw           │
                      │  DNA encode/decode       │
                      │  uniqueness set          │
                      └────────────┬─────────────┘
                                   │
             ┌─────────────────────┴─────────────────────┐
             │                                           │
   ┌─────────▼──────────┐                    ┌───────────▼──────────┐
   │  LAYER MODE        │                    │  AI MODE             │
   │  src/main.js       │                    │  src/pipeline/       │
   │                    │                    │                      │
   │  traits are PNGs   │                    │  traits are text     │
   │  render = drawImage│                    │  render = API call   │
   │  free, instant     │                    │  paid, minutes-hours │
   └─────────┬──────────┘                    └───────────┬──────────┘
             │                                           │
             └─────────────────────┬─────────────────────┘
                                   │
                      ┌────────────▼─────────────┐
                      │  src/core/metadata.js    │
                      │  buildMetadata() — pure  │
                      │  ERC-721 and Solana      │
                      └──────────────────────────┘
```

`src/core/dna.js` was lifted **verbatim** out of the original `main.js`. Those
functions were already pure and already correct; they just needed to live
somewhere both renderers could reach. Layer mode requires them back and its
output is byte-identical to before the extraction.

This matters more than it looks. If AI mode had its own weighted-draw
implementation, the two would drift, and you would have two rarity engines that
disagree about what "weight 30" means.

## The render step is a split, not a swap

Replacing `ctx.drawImage` with `await fetch` is not a like-for-like
substitution. The two have opposite properties:

| | PNG layers | AI render |
|---|---|---|
| Cost per attempt | 0 | full price |
| Latency | ~1 ms | 4–12 s |
| Determinism | total | best-effort, via seed |
| Trait fidelity | 100% guaranteed | roughly 85–95% |
| Failure mode | crash | a plausible wrong image |
| Visual uniqueness | follows DNA | **does not** follow DNA |

Each row forces a piece of machinery:

- **cost per attempt** → a ledger, so a retry never re-bills
- **latency** → a worker pool, so a thousand renders finish this afternoon
- **determinism** → seeds derived from DNA, so a lost image can be recreated
- **trait fidelity** → QC, because the metadata's claim needs checking
- **failure mode** → automated checks, because a wrong image looks fine
- **visual uniqueness** → perceptual hashing, because DNA uniqueness is not
  pixel uniqueness

So `startCreating()` becomes two programs:

```
PLAN                                    EXECUTE
free, offline, deterministic            paid, concurrent, resumable
────────────────────────────            ────────────────────────────
roll every DNA                          read the ledger
reject constraint violations            skip what is already done
reject duplicates                       render what remains
build every prompt                      append to the ledger on each success
derive every seed                       halt at the spend ceiling
write plan.json
print the bill  →  STOP
```

You can re-plan a thousand editions as many times as you like for nothing.
Only after you have read the bill does anything spend.

## Module map

```
src/
  core/
    dna.js            weighted draw, DNA encode/decode, uniqueness   [extracted verbatim]
    metadata.js       pure buildMetadata() — ERC-721 + Solana
    traitLayers.js    text traits -> the element shape dna.js expects
    constraints.js    incompatible / required trait combinations
    traitSpace.js     can N unique editions even exist?
  prompt/
    promptBuilder.js  DNA -> prompt string + deterministic seed
  providers/
    base.js           adapter contract, retry policy, key redaction
    models.js         verified model catalogue and pricing
    mock.js           $0 provider — renders the prompt onto a canvas
    openrouter.js     POST /api/v1/images
    vision.js         trait verification via chat completions
    index.js          registry + API-key resolution
  reference/
    prepareReference.js  normalise the upload (local, free)
    styleBible.js        master + anchors, with the approval gate
  pipeline/
    planCollection.js roll offline -> plan.json
    generate.js       execute the plan  [the only file that spends money]
    finalize.js       composite local traits, write metadata
    qc.js             flat/twin detection, optional trait verification
    jobState.js       append-only ledger, atomic writes
    queue.js          worker pool + token bucket
    phash.js          perceptual hash (structure + colour)
  cli/
    doctor.js         pre-flight
    requeue.js        drop QC-flagged editions for re-render
  main.js             layer mode
  config.js           collection metadata
  ai.config.js        AI mode settings
chimera.traits.js     your traits, as text
studio/               Next.js UI over the same CLI
```

## Where state lives

```
build/
  images/            final art
  json/              final metadata, one file per edition + _metadata.json
  ai/
    plan.json        the rolled collection — traits, prompts, seeds
    ledger.jsonl     append-only: what rendered, what it cost   ← source of truth
    qc.json          the last QC report
    raw/             renders before local compositing
    rejects/         QC failures, moved not deleted
    reference/
      base.png       your upload, normalised
      master.png     the approved model sheet
      anchors/       optional trait exemplars
      state.json     approval marker + reference spend
```

`ledger.jsonl` is the important one. It is append-only, `fsync`'d on every
write, and it alone decides what has been paid for. Resume reads it. Progress
reads it. The spend total reads it. A torn final line from `kill -9` is skipped
on read, costing you one image rather than the run.

## Two bugs the structure exists to prevent

**Shared mutable state during concurrent renders.** The original `addMetadata()`
read a module-level `attributesList` and cleared it as a side effect. Safe in a
sequential loop; under a worker pool, edition A's traits land on edition B and
you do not notice until someone checks their NFT. `buildMetadata()` is now a
function of its arguments and nothing else, and a test interleaves three calls
to prove it.

**A rebuild deleting paid work.** `buildSetup()` called
`fs.rmSync(buildDir, {recursive: true})` unconditionally. In layer mode that
costs a few seconds of regeneration. In AI mode it deletes images you paid for.
It now refuses to run when a ledger exists, unless `--force`.
EOF
