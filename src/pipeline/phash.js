/**
 * Perceptual hashing — dHash.
 *
 * DNA uniqueness guarantees no two editions share a trait combination. It
 * guarantees nothing about the pixels: a model can answer two different
 * prompts with two nearly identical pictures, and a collection with visual
 * twins is a collection with a rarity problem nobody can see in the metadata.
 *
 * The hash has two halves, because neither alone is enough:
 *
 *   structure — dHash, relative brightness between adjacent pixels. Survives
 *               resizing, catches shape differences, and is almost entirely
 *               blind to colour.
 *   colour    — a coarse 4x4 grid of quantised RGB. Measured: two renders
 *               differing only in background colour scored 0 structural bits
 *               apart, so a structure-only hash would call every edition in a
 *               colour-varied collection a duplicate.
 *
 * Compared by Hamming distance over both halves.
 */
const basePath = process.cwd();
const { createCanvas, loadImage } = require(`${basePath}/node_modules/canvas`);

const W = 9; // one extra column: 8 comparisons per row
const H = 8;

/** @returns {BigInt} 64-bit structural hash (brightness gradients only) */
const structureHash = async (pathOrBuffer) => {
  const img = await loadImage(pathOrBuffer);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Flatten onto white first — a transparent PNG otherwise hashes as noise.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0, W, H);

  const { data } = ctx.getImageData(0, 0, W, H);
  const grey = [];
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 601 luma — matches how the eye weights the channels.
    grey.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }

  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const left = grey[y * W + x];
      const right = grey[y * W + x + 1];
      if (left > right) hash |= 1n << bit;
      bit++;
    }
  }
  return hash;
};

const GRID = 4;

/**
 * 96-bit colour signature: a GRID x GRID mosaic with each channel quantised
 * to 2 bits. Coarse on purpose — it should notice "rose background became
 * mint", not "this pixel is one shade warmer".
 */
const colourHash = async (pathOrBuffer) => {
  const img = await loadImage(pathOrBuffer);
  const canvas = createCanvas(GRID, GRID);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, GRID, GRID);
  ctx.drawImage(img, 0, 0, GRID, GRID);

  const { data } = ctx.getImageData(0, 0, GRID, GRID);
  let hash = 0n;
  let shift = 0n;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const level = BigInt(Math.min(3, data[i + c] >> 6)); // 0-255 -> 0-3
      hash |= level << shift;
      shift += 2n;
    }
  }
  return hash;
};

/** @returns {{structure: BigInt, colour: BigInt}} */
const hashImage = async (pathOrBuffer) => ({
  structure: await structureHash(pathOrBuffer),
  colour: await colourHash(pathOrBuffer),
});

const popcount = (x) => {
  let count = 0;
  while (x) { x &= x - 1n; count++; }
  return count;
};

/**
 * Differing bits across both halves. Accepts either a composite hash or a
 * bare BigInt, so the structural hash can still be compared on its own.
 */
const distance = (a, b) => {
  if (typeof a === "bigint" && typeof b === "bigint") return popcount(a ^ b);
  return popcount(a.structure ^ b.structure) + popcount(a.colour ^ b.colour);
};

/**
 * Is the image essentially one flat colour? Catches renders that came back
 * blank, all-black, or as a solid error card — which still cost money and
 * would otherwise ship.
 */
const isFlat = async (pathOrBuffer, threshold = 4) => {
  const img = await loadImage(pathOrBuffer);
  const size = 32;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, 0, 0, size, size);

  const { data } = ctx.getImageData(0, 0, size, size);
  const values = [];
  for (let i = 0; i < data.length; i += 4) {
    values.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { flat: Math.sqrt(variance) < threshold, stdDev: Math.sqrt(variance) };
};

/**
 * Group near-identical images.
 *
 * @param {Array} entries  [{ id, hash: BigInt }]
 * @param {Number} maxDistance  bits of difference still considered a twin
 * @returns {Array<Array>} clusters of 2+ ids
 */
const findTwins = (entries, maxDistance = 5) => {
  const seen = new Set();
  const clusters = [];
  for (let i = 0; i < entries.length; i++) {
    if (seen.has(entries[i].id)) continue;
    const group = [entries[i].id];
    for (let j = i + 1; j < entries.length; j++) {
      if (seen.has(entries[j].id)) continue;
      if (distance(entries[i].hash, entries[j].hash) <= maxDistance) {
        group.push(entries[j].id);
        seen.add(entries[j].id);
      }
    }
    if (group.length > 1) {
      seen.add(entries[i].id);
      clusters.push(group);
    }
  }
  return clusters;
};

module.exports = { hashImage, structureHash, colourHash, distance, isFlat, findTwins };
