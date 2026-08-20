/**
 * OpenRouter Images API adapter.
 *
 *   POST https://openrouter.ai/api/v1/images
 *
 * One key reaches every image model in the catalogue — FLUX.2, Seedream,
 * Gemini, GPT Image, Qwen, Recraft — which is why this is the default
 * provider. Reference images ride in `input_references`, and that is the
 * channel that makes image-to-image work.
 *
 * Verified against the live API on 2026-08-21. Response parsing is written
 * defensively: several shapes are accepted, and an unrecognised one throws
 * with the actual payload rather than silently writing a corrupt PNG.
 */
const { ProviderError, redact } = require(`${process.cwd()}/src/providers/base.js`);

const ENDPOINT = "https://openrouter.ai/api/v1/images";

/** Buffer -> data URI, the form input_references accepts for local files. */
const toDataUri = (buffer, mime = "image/png") =>
  `data:${mime};base64,${buffer.toString("base64")}`;

const asReference = (ref) => {
  const url = Buffer.isBuffer(ref) ? toDataUri(ref) : ref;
  return { type: "image_url", image_url: { url } };
};

/**
 * Pull the image bytes out, whatever shape they arrive in.
 * Returns null rather than guessing if nothing looks like an image.
 */
const extractImage = (json) => {
  const candidates = [
    json?.data?.[0]?.b64_json,
    json?.images?.[0]?.b64_json,
    json?.data?.[0]?.image_url?.url,
    json?.images?.[0]?.image_url?.url,
    json?.data?.[0]?.url,
  ].filter(Boolean);

  for (const c of candidates) {
    if (typeof c !== "string") continue;
    if (c.startsWith("data:")) {
      return { buffer: Buffer.from(c.split(",")[1], "base64") };
    }
    if (c.startsWith("http")) {
      return { url: c };
    }
    // bare base64
    return { buffer: Buffer.from(c, "base64") };
  }
  return null;
};

const render = async ({
  prompt,
  negative,
  seed,
  references = [],
  output,
  model,
  apiKey,
  timeoutMs = 180000,
}) => {
  if (!apiKey) throw new ProviderError("missing OpenRouter API key", { retryable: false });

  const body = {
    model,
    prompt: negative ? `${prompt}\n\nAvoid: ${negative}` : prompt,
    n: 1,
    output_format: output.format === "jpeg" ? "jpeg" : "png",
    seed,
  };
  // No `usage: {include: true}` here on purpose. It is deprecated and has no
  // effect — OpenRouter now returns full usage details, `usage.cost` included,
  // on every response automatically. Sending it is harmless but implies a
  // dependency that does not exist.

  // Square output is the PFP norm; ask explicitly so aspect never drifts.
  if (output.width === output.height) body.aspect_ratio = "1:1";
  if (output.width >= 2048) body.resolution = "2K";

  // Transparent lets us composite the background locally at full fidelity.
  if (output.transparent) body.background = "transparent";

  if (references.length) {
    body.input_references = references.map(asReference);
  }

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
        "X-Title": "Chimera",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // Network faults and timeouts are worth another go.
    throw new ProviderError(`request failed: ${redact(err.message)}`, { retryable: true });
  }
  clearTimeout(timer);

  const text = await res.text();

  if (!res.ok) {
    // 429 and 5xx are transient. 4xx means our request is wrong — retrying
    // that just spends money on the same mistake.
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(
      `OpenRouter ${res.status}: ${redact(text).slice(0, 300)}`,
      { status: res.status, retryable, body: text }
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError(`unparseable response: ${redact(text).slice(0, 200)}`, {
      retryable: true,
    });
  }

  const found = extractImage(json);
  if (!found) {
    throw new ProviderError(
      `no image in response. Keys: ${Object.keys(json).join(", ")}. ` +
        `Body: ${redact(JSON.stringify(json)).slice(0, 300)}`,
      { retryable: false }
    );
  }

  let buffer = found.buffer;
  if (!buffer && found.url) {
    const imgRes = await fetch(found.url);
    if (!imgRes.ok) {
      throw new ProviderError(`could not download image: ${imgRes.status}`, { retryable: true });
    }
    buffer = Buffer.from(await imgRes.arrayBuffer());
  }

  if (!buffer || buffer.length < 100) {
    throw new ProviderError("response contained an empty image", { retryable: true });
  }

  // Prefer what OpenRouter says it charged over our catalogue estimate — the
  // ledger should record real spend, not a guess.
  const reported = json?.usage?.cost;
  const costUSD = typeof reported === "number" ? reported : null;

  return {
    buffer,
    costUSD,
    meta: {
      provider: "openrouter",
      model,
      seed,
      reportedCost: costUSD,
      bytes: buffer.length,
    },
  };
};

module.exports = { id: "openrouter", maxRefs: 14, render, toDataUri, extractImage };
