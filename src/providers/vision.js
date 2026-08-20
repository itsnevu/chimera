/**
 * Trait verification with a vision model.
 *
 * This is the step that turns "the metadata matches what we asked for" into
 * "the metadata matches what is actually in the picture". Without it, R4 in
 * docs/ai-mode-plan.md is a hope. With it, it is a measurement.
 *
 * The model is shown one render and asked, per trait, whether it can see it.
 * We deliberately ask for a verdict per trait rather than a single overall
 * score, because "is the pirate tricorn there" is answerable and "is this
 * edition good" is not.
 *
 * Costs money. Every call is metered through the same ledger and ceiling as
 * rendering.
 */
const { ProviderError, redact } = require(`${process.cwd()}/src/providers/base.js`);

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM = `You verify NFT artwork against a trait list.
For each trait you are given, decide whether it is clearly visible in the image.
Judge only what you can see. If a trait is "None", confirm the thing is absent.
Be strict: a trait that is ambiguous or barely suggested is NOT present.
Reply with JSON only, no prose, in exactly this shape:
{"traits":[{"trait":"Headwear","claimed":"Pirate Tricorn","present":true,"note":""}]}`;

/**
 * @param {Object}  args
 * @param {Buffer}  args.image
 * @param {Object}  args.traits    { TraitName: "Value" }
 * @param {Array}   args.skip      trait names not rendered by the model
 * @param {String}  args.model     an OpenRouter model that accepts image input
 * @param {String}  args.apiKey
 * @returns {{verdicts:Array, costUSD:Number|null, raw:String}}
 */
const verifyTraits = async ({
  image,
  traits,
  skip = [],
  model,
  apiKey,
  timeoutMs = 120000,
}) => {
  if (!apiKey) throw new ProviderError("missing API key for QC", { retryable: false });

  const checkable = Object.entries(traits).filter(([name]) => !skip.includes(name));
  if (!checkable.length) return { verdicts: [], costUSD: 0, raw: "" };

  const list = checkable.map(([name, value]) => `- ${name}: ${value}`).join("\n");

  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: `Verify these traits:\n${list}` },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
          },
        ],
      },
    ],
    // Low temperature: this is a judgement, not a creative task.
    temperature: 0,
    max_tokens: 700,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/itsnevu/chimera",
        "X-Title": "Chimera QC",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new ProviderError(`QC request failed: ${redact(err.message)}`, { retryable: true });
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(`QC ${res.status}: ${redact(text).slice(0, 300)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }

  const json = JSON.parse(text);
  const content = json?.choices?.[0]?.message?.content ?? "";

  const parsed = parseVerdict(content, checkable);
  return {
    verdicts: parsed,
    costUSD: typeof json?.usage?.cost === "number" ? json.usage.cost : null,
    raw: content,
  };
};

/**
 * Models wrap JSON in prose and fences no matter how firmly you ask them not
 * to. Dig it out; if it genuinely is not there, say so rather than silently
 * passing every trait.
 */
const parseVerdict = (content, checkable) => {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : content;
  const braced = candidate.match(/\{[\s\S]*\}/);

  let data;
  try {
    data = JSON.parse(braced ? braced[0] : candidate);
  } catch {
    throw new ProviderError(
      `QC returned unparseable output: ${redact(content).slice(0, 200)}`,
      { retryable: true }
    );
  }

  const rows = Array.isArray(data.traits) ? data.traits : [];
  // Anything the model failed to mention counts as unverified, not as a pass.
  return checkable.map(([name, value]) => {
    const row = rows.find((r) => r && r.trait === name);
    if (!row) {
      return { trait: name, claimed: value, present: null, note: "not addressed by QC model" };
    }
    return {
      trait: name,
      claimed: value,
      present: typeof row.present === "boolean" ? row.present : null,
      note: row.note || "",
    };
  });
};

module.exports = { verifyTraits, parseVerdict };
