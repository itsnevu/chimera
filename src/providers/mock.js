/**
 * The $0 provider.
 *
 * Renders the prompt onto a canvas instead of calling anything. It exists so
 * the entire pipeline — queue, ledger, resume, spend accounting, metadata,
 * finalize — can be exercised over a full thousand-edition run without
 * spending a cent. Every bug this catches is a bug you do not pay to find.
 */
const basePath = process.cwd();
const { createCanvas } = require(`${basePath}/node_modules/canvas`);
const { sleep } = require(`${basePath}/src/providers/base.js`);

/** Deterministic pseudo-random from the seed, so mock output is reproducible. */
const rng = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const render = async ({ prompt, seed, output, traits, latencyMs = 0 }) => {
  if (latencyMs) await sleep(latencyMs);

  const w = output.width;
  const h = output.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const rand = rng(seed);

  // Transparent where the real provider would be transparent, so the
  // compositing step downstream is exercised identically.
  ctx.clearRect(0, 0, w, h);

  // A blobby silhouette stands in for the character.
  const hue = Math.floor(rand() * 360);
  ctx.fillStyle = `hsl(${hue}, 45%, 55%)`;
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 0.58, w * 0.28, h * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(w * 0.28, h * 0.34);
  ctx.lineTo(w * 0.38, h * 0.12);
  ctx.lineTo(w * 0.46, h * 0.33);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(w * 0.72, h * 0.34);
  ctx.lineTo(w * 0.62, h * 0.12);
  ctx.lineTo(w * 0.54, h * 0.33);
  ctx.closePath();
  ctx.fill();

  // The traits, legibly, so a human can verify the pipeline wired them right.
  ctx.fillStyle = "#000000";
  ctx.font = `bold ${Math.round(h / 34)}px sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText("MOCK RENDER — NOT REAL ART", 24, 20);
  ctx.font = `${Math.round(h / 44)}px monospace`;
  let y = 20 + h / 26;
  Object.entries(traits || {}).forEach(([k, v]) => {
    ctx.fillText(`${k}: ${v}`, 24, y);
    y += h / 38;
  });

  return {
    buffer: canvas.toBuffer("image/png"),
    costUSD: 0,
    meta: { provider: "mock", seed, promptChars: prompt.length },
  };
};

module.exports = { id: "mock", maxRefs: 0, render };
