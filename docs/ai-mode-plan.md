# Chimera AI Mode — Requirements & Implementation Plan

**Status:** proposal, not yet built
**Written:** 2026-08-21
**Prerequisite reading:** [README](../README.md) § Status

---

## 1. What we are building

> Give Chimera **one** reference image of a character. Get back **N** unique variations, each carrying discrete traits with real rarity weights and metadata that actually matches the art.

The hard part is not calling an image API. It is making 1,000 calls come back **on-model** and **on-label**, without silently burning money.

### Requirements

| # | Requirement | Why it is hard |
|---|---|---|
| R1 | Every edition has discrete, queryable traits | Diffusion models emit a flat image, not traits |
| R2 | Rarity is computable and matches the target | Requires rolling traits *before* rendering |
| R3 | Art style stays consistent across all N | Reference drift is the default failure mode |
| R4 | The image actually contains the traits in its metadata | Models silently skip instructions |
| R5 | No duplicate editions | Trait-level *and* pixel-level |
| R6 | Never pay twice for the same image | Crashes, stops and reruns must be free |
| R7 | Cost is known and confirmed before spending | A 1,000 run is a three-figure bill |
| R8 | User's API key never leaks | Not into config, plan, ledger, or logs |

### Non-goals

- Training a LoRA (that is the real fix for R3, but needs Replicate/fal + hours + a dataset)
- Minting, contracts, or marketplace upload
- A hosted web UI — `web/index.html` stays a configurator

---

## 2. The flow

This is the part that determines whether output is usable or garbage. Six stages, and **money is only spent in three of them**.

```
STAGE 0   SETUP                                                    free
          ai:init    key, provider, model, reference path
          ai:doctor  validate key, trait names, and that N unique
                     combinations can even exist
                                    |
STAGE 1   STYLE BIBLE                              ~$0.05 - $0.25 ONCE
          1. normalize upload -> base.png          (local, free)
             square crop, 1024x1024, centred
          2. render master model sheet             (1 paid call)
             front-facing, neutral, plain background,
             target art style
          3. >>> HUMAN APPROVES master.png <<<     ** THE GATE **
          4. optional: 2-4 trait anchors
             (same character wearing a hat / an outfit)
                                    |
                     master.png + anchors[] become the reference set
                     sent with EVERY production call
                                    |
STAGE 2   PLAN                                                     free
          roll N unique DNA (existing createDna + isDnaUnique)
          reject incompatible combinations
          build prompt per edition
          derive deterministic seed from DNA
          -> build/ai/plan.json
          print cost + trait distribution, then STOP
                                    |
                     >>> EXPLICIT CONFIRMATION REQUIRED <<<
                                    |
STAGE 3   SMOKE                                                  ~$0.20
          render 5 editions from the plan, show them, stop
          human decides: proceed, or fix prompts and re-plan
                                    |
STAGE 4   GENERATE                                    N x per-image
          worker pool, rate-limited, resumable
          each job: [master, ...anchors] + prompt + seed
          append to ledger.jsonl the moment bytes land
                                    |
STAGE 5   QC                                    small VLM cost or free
          automated: valid file, right size, not blank,
                     not a near-duplicate (perceptual hash)
          verified:  ask a vision model "does this image
                     contain a pirate tricorn?" per trait
          failures -> rejects/ and re-queued
                                    |
STAGE 6   FINALIZE                                                 free
          composite Background locally (canvas)
          write metadata from the ROLLED traits
          -> build/images/  build/json/
```

### The seven levers that decide accuracy

Everything above exists to serve these. This is the answer to *"how do we make the AI actually hit what we want?"*

**1. Never reference the raw upload.**
Pointing 1,000 calls at an arbitrary user photo is the number one cause of drift. We spend one call to produce a clean canonical *model sheet* — front-facing, neutral, plain background — and a human approves it. Every later call references that. If the master is wrong, everything after is wrong, so it is the one place we deliberately stop and ask.

**2. Send multiple references, not one.**
Seedream 4.5 accepts 14 reference images at no extra charge. Sending `master + "wearing a hat" + "wearing an outfit"` teaches the model the character *and* how the character wears things. One reference teaches only the face.

**3. Roll traits first, write the prompt from them.**
This is the whole architecture. We never ask the model what it drew — we told it what to draw and we record what we told it. Guarantees R1 and R2 by construction.

**4. Freeze the style anchor.**
One constant string appended to every prompt (framing, medium, line weight, lighting), plus an explicit avoid-list. Any wording that varies between editions is a chance for the style to wander.

**5. Derive the seed from the DNA.**
Same traits → same seed → reproducible. Lets a lost image be regenerated identically instead of re-rolled.

**6. Do not let the AI draw the background.**
Ask for `background: transparent`, composite the Background trait locally with the canvas code we already have. Result: that trait is 100% accurate, the prompt gets shorter (which improves adherence on everything else), and it costs nothing. Same trick works for frames and watermarks.

**7. Close the loop with a vision model.**
This is what makes it *"combined with an LLM"* in a way that earns its cost. After rendering, send the image back to a vision model with the trait list and ask, per trait, whether it is present. Mismatches are flagged, not shipped. Without this step, R4 is a hope; with it, it is a measurement.

> **Honest limit:** even with all seven, expect roughly 5–15% of renders to need re-rolling. Budget for it — the estimator already adds 15%.

---

## 3. Architecture — plan / execute split

The single most important structural decision.

`startCreating()` today rolls and renders in one loop. That is fine when rendering is free and instant. It is dangerous when each iteration costs money, so it splits in two:

| Phase | Cost | Deterministic | Resumable |
|---|---|---|---|
| **plan** — roll all DNA, build prompts, estimate | free | yes | n/a |
| **execute** — render each job | paid | no | yes |

Consequences:
- You can inspect and diff the entire collection **before** paying
- A crash resumes from the ledger, never re-billing
- Re-planning is free, so iterating on prompts costs nothing

### Two bugs in current code that must be fixed first

**Concurrency corruption.** [`src/main.js:29`](../src/main.js#L29) `attributesList` is module-level; `addAttributes()` pushes to it and `addMetadata()` clears it. Safe in today's sequential loop, **corrupts under any parallelism**. Fix: pure `buildMetadata({dna, edition, attributes, ...})`.

**`buildSetup` deletes the build directory.** [`src/main.js:38`](../src/main.js#L38) calls `fs.rmSync(buildDir, {recursive:true})`. In AI mode a re-run would **delete images you already paid for**. Fix: create-if-missing; refuse to wipe when a ledger exists unless `--force`.

---

## 4. Files

New code, all CommonJS, no new runtime dependencies (Node 20 has `fetch`).

```
src/
  core/
    dna.js            EXTRACTED verbatim from main.js — the rarity engine, reused byte-for-byte
    traitLayers.js    text traits -> element objects (replaces fs-based getElements)
    constraints.js    incompatibleWith / requires / onlyIf
    metadata.js       pure buildMetadata() — fixes the concurrency bug
    traitSpace.js     can N unique combinations even exist?
  prompt/
    styleProfile.js   the frozen style anchor + avoid-list
    promptBuilder.js  DNA -> prompt + derived seed
  providers/
    index.js          getProvider(id, {apiKey})
    models.js         verified model catalogue + pricing
    mock.js           $0 provider — renders the prompt onto canvas
    openrouter.js     POST /api/v1/images
  reference/
    prepareReference.js  normalize upload (local, free)
    styleBible.js        master + anchors, human-approved
  pipeline/
    planCollection.js  roll everything -> plan.json
    estimateCost.js    plan + model -> USD, confirmation table
    generate.js        worker pool, resumable
    queue.js           concurrency + token-bucket rate limit
    jobState.js        append-only ledger, atomic writes
    qc.js              automated checks + pHash + VLM trait verify
    finalize.js        composite backgrounds, write metadata
  cli/
    doctor.js  smoke.js

chimera.traits.js     YOUR trait definitions, as text
build/ai/             gitignored — plan.json, ledger.jsonl, cache/, raw/, rejects/
```

`src/main.js` keeps working unchanged for layer mode; it just `require`s the extracted pure functions back.

### npm scripts

```
ai:doctor    validate config, key, trait space
ai:ref       build the style bible (paid, once)
ai:plan      roll the collection, estimate cost
ai:smoke     render 5, stop
ai:generate  run it
ai:resume    continue after a stop
ai:qc        verify traits, flag rejects
ai:finalize  composite + write metadata
```

### API key handling

Resolution order: `--api-key` → `process.env.OPENROUTER_API_KEY` → `.env` → `~/.chimera/credentials.json` (chmod 600).

The key **never** enters `src/config.js`, `plan.json`, the ledger, or any error dump. `.env` is already gitignored; `build/ai/` gets added.

---

## 5. Milestones

Each is independently useful and independently verifiable. **Nothing costs money until M4.**

| M | Deliverable | Done when | Cost |
|---|---|---|---|
| **M1** | Extract `core/dna.js`, pure `metadata.js`, safe `buildSetup` | `npm run build` still produces 5 identical editions; no globals left in the metadata path | free |
| **M2** | Text traits + constraints + `ai:plan` | `plan.json` holds 1,000 unique, constraint-valid DNA with prompts; distribution matches weights | free |
| **M3** | `mock` provider + full pipeline + `ai:resume` | A 1,000-edition run completes end-to-end for **$0**; killing it mid-run and resuming re-bills nothing | free |
| **M4** | OpenRouter adapter + style bible + `ai:smoke` | 5 real images render on-model from an approved master | ~$0.30 |
| **M5** | QC: pHash dedupe + VLM trait verification | Deliberately mismatched renders get flagged, not shipped | small |

**M3 is the important one.** It proves plan, ledger, resume, concurrency, rate limiting and metadata — the entire risky surface — before a single cent is spent.

### Acceptance criteria for the whole thing

- [ ] 1,000 editions, zero duplicate DNA
- [ ] Actual rarity within 2 points of target on every trait
- [ ] Metadata validates as ERC-721 and matches the rolled traits
- [ ] Killing the run at edition 500 and resuming costs nothing extra
- [ ] Cost estimate shown and confirmed before the first paid call
- [ ] API key absent from every file on disk except the credentials store
- [ ] QC flags a render whose trait is missing

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Style drifts over a long run | Style bible + frozen anchor + multi-reference; QC catches outliers |
| Model silently omits a trait | VLM verification in M5; until then, metadata matches the *request*, and the README says so |
| Provider changes pricing | `models.js` is a single catalogue; `ai:plan` re-quotes every time |
| Rate limits / 429s | Token bucket + exponential backoff; ledger means retries are free |
| Runaway spend | Hard `maxSpendUSD` ceiling in config; the run aborts when it is reached |
| Two visually identical images | Perceptual hash dedupe at QC; re-roll with a different seed |

---

## 7. Open questions

1. **Collection size?** Cost, runtime and trait-space requirements all scale from this.
2. **Art style?** Determines the style anchor and whether transparent-background rendering is viable.
3. **How many traits per category?** CATSDAQ has 269 traits total; the demo config has 49.
4. **Budget ceiling?** Sets `maxSpendUSD` and which model is the sensible default.
