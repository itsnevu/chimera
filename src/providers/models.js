/**
 * Model catalogue.
 *
 * Prices verified 2026-08-21 against live OpenRouter, OpenAI and Google
 * pricing, for a 1024x1024 render carrying one 1024x1024 reference image.
 * `usdPerImage` therefore already includes any reference-image surcharge —
 * flux.2-pro and flux.2-max bill input megapixels, which their /endpoints
 * JSON omits and only their model pages disclose.
 *
 * Re-check before a large run. `npm run ai:plan` re-quotes every time.
 */
const MODELS = {
  "bytedance-seed/seedream-4.5": {
    label: "Seedream 4.5",
    usdPerImage: 0.04,
    maxRefs: 14,
    secondsPerImage: 5,
    billing: "flat per image, no reference surcharge",
    recommended: true,
  },
  "black-forest-labs/flux.2-klein-4b": {
    label: "FLUX.2 klein 4B",
    usdPerImage: 0.014,
    maxRefs: 4,
    secondsPerImage: 4,
    billing: "output megapixels only",
    note: "distilled speed variant; BFL makes no character-consistency claim",
  },
  "openai/gpt-image-1-mini": {
    label: "GPT Image 1 mini",
    usdPerImage: 0.012,
    maxRefs: 16,
    secondsPerImage: 8,
    billing: "token-billed — treat this figure as approximate",
    approximate: true,
  },
  "black-forest-labs/flux.2-pro": {
    label: "FLUX.2 pro",
    usdPerImage: 0.045,
    maxRefs: 8,
    secondsPerImage: 6,
    billing: "$0.030 output + $0.015 per megapixel of reference",
  },
  "google/gemini-3.1-flash-image": {
    label: "Gemini 3.1 Flash Image",
    usdPerImage: 0.067,
    maxRefs: 14,
    secondsPerImage: 4,
    billing: "token-billed",
    note: "every output carries an invisible SynthID watermark",
    approximate: true,
  },
  "black-forest-labs/flux.2-max": {
    label: "FLUX.2 max",
    usdPerImage: 0.1,
    maxRefs: 8,
    secondsPerImage: 7,
    billing: "$0.070 output + $0.030 per megapixel of reference",
  },
  mock: {
    label: "Mock (no API, no cost)",
    usdPerImage: 0,
    maxRefs: 0,
    secondsPerImage: 0,
    billing: "free — renders the prompt onto a canvas",
  },
};

const PRICED_ON = "2026-08-21";

const get = (id) => {
  const m = MODELS[id];
  if (!m) {
    throw new Error(
      `Unknown model "${id}". Known: ${Object.keys(MODELS).join(", ")}`
    );
  }
  return m;
};

/**
 * Fallback price for one QC vision call, used only when the provider reports
 * no cost of its own. A verification call sends a 1024x1024 PNG (~1,300 image
 * tokens) plus a short prompt, and takes back at most 700 tokens — a cent is
 * a deliberate over-estimate on current flash-tier vision pricing.
 *
 * Over-estimating is the safe direction: it halts a run early, which the user
 * can undo by raising the ceiling. Under-estimating overspends their money,
 * which they cannot undo.
 */
const USD_PER_QC_CALL = 0.01;

module.exports = { MODELS, get, PRICED_ON, USD_PER_QC_CALL };
