# Keeping 1,000 renders on-model

The question this answers: *how do we make the AI actually produce what we
want, a thousand times, from one image?*

Seven levers. They compound — none alone is sufficient.

---

## 1. Never reference the raw upload

**The failure it prevents:** style drift.

Your upload has its own lighting, crop, pose and background. Referenced a
thousand times, the model reinterprets all of it differently every time.

Instead, spend one call producing a canonical *model sheet* — front-facing,
neutral expression, no headwear or clothing, plain grey background — and have a
human approve it. Every production render references that.

The master is deliberately the **most neutral** version of your character, so
later prompts only ever add. If the master already wears a hat, every "wearing
a pirate tricorn" prompt is fighting it.

> This is the only place the pipeline refuses to proceed without you. If the
> master is wrong, all N editions are wrong.

---

## 2. Send several references, not one

Seedream 4.5 accepts **14 reference images at no extra charge**. That is
unusual — `flux.2-pro` and `flux.2-max` bill input megapixels — and it is why
Seedream is the default.

One reference teaches the model a face. Adding two anchors — the same character
wearing a hat, and wearing a jacket — teaches it how the character *wears
things*, which is what a trait-varied collection actually needs.

Cost: two extra calls, about $0.08. Saves far more in rerolls.

---

## 3. Roll traits first, write the prompt from them

The architectural thesis. See [architecture.md](architecture.md).

We never ask the model what it drew. We told it what to draw, and we record
what we told it. This is what makes rarity computable and metadata truthful.

---

## 4. Freeze the style anchor

One constant string appended to every prompt, unchanged for the whole
collection:

```js
styleAnchor:
  "flat vector PFP illustration, bold clean linework, centred bust portrait, " +
  "even studio lighting, no text, no watermark, no signature"
```

Any wording that varies between editions is a chance for style to wander. The
anchor covers medium, line weight, framing and lighting — everything that
should be identical across all N.

Paired with an `avoid` list for what should never appear:

```js
avoid:
  "photorealism, 3d render, extra limbs, deformed anatomy, cropped head, " +
  "busy background, text, watermark, signature, blurry"
```

A test asserts the anchor is present in every generated prompt.

---

## 5. Derive the seed from the DNA

```js
const seedFrom = (dna) => {
  let h = 2166136261;
  for (let i = 0; i < dna.length; i++) {
    h ^= dna.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};
```

Same traits → same seed → same image, as far as the provider honours seeds.
A lost or corrupted render can be recreated rather than re-rolled into
something different.

---

## 6. Do not let the model draw what you already know

Flat backgrounds are a known hex value. Asking a model to paint `#EFA0B4` is
paying for a worse result.

Traits listed in `compositeLocally` are:

- excluded from the prompt (which shortens it, improving adherence on
  everything that remains)
- requested as `background: transparent` from the provider
- filled in locally by `finalize` at their exact colour

Result: **100% fidelity on those traits, at zero cost.**

Works for anything deterministic — frames, borders, watermarks, flat colour
fields. Does not work for anything the character must interact with.

---

## 7. Close the loop with a vision model

Levers 1–6 improve the odds. This one **measures** the result.

```sh
npm run ai:qc -- --verify --yes
```

Each render goes back to a vision model with its trait list, and the model is
asked per trait whether it is visible:

```json
{"traits":[
  {"trait":"Headwear","claimed":"Pirate Tricorn","present":false,"note":"bare head"},
  {"trait":"Eyes","claimed":"Amber","present":true,"note":""}
]}
```

Two rules make this trustworthy:

- **per-trait, not overall.** "Is the tricorn there" is answerable. "Is this
  edition good" is not.
- **silence is not approval.** A trait the model fails to mention is recorded
  `present: null` — unverified. It never counts as a pass.

Without this step, "the metadata matches the picture" is a hope. With it, it is
a number you can look at.

---

## The honest limit

Even with all seven, expect roughly **5–15% of renders to need re-rolling**.
The cost estimate adds 15% for exactly this, and the number is shown to you as
the figure to plan against rather than the optimistic one.

The real fix for the remaining drift is training a LoRA on your character —
which needs Replicate or fal.ai, a dataset, and hours of GPU time. That is
deliberately out of scope here.
