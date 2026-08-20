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
 * The naive form compares every pair: 1,000 images is 500k comparisons, which
 * is fine, but 10,000 is 50 million and QC hangs for minutes. So candidates
 * are narrowed first by locality-sensitive hashing — the structural hash is
 * cut into bands, and only images sharing a band are compared in full.
 *
 * Two images within a few bits of each other are overwhelmingly likely to
 * agree on at least one band, so this keeps the pairs that matter while
 * discarding the vast majority that cannot possibly be twins.
 *
 * @param {Array} entries  [{ id, hash }]
 * @param {Number} maxDistance  bits of difference still considered a twin
 * @returns {Array<Array>} clusters of 2+ ids
 */
const BANDS = 8;      // 64-bit structural hash -> 8 bands of 8 bits
const BAND_BITS = 8n;
const BAND_MASK = 0xffn;

const bandKeys = (hash) => {
  const structure = typeof hash === "bigint" ? hash : hash.structure;
  const keys = [];
  for (let b = 0; b < BANDS; b++) {
    keys.push(`${b}:${(structure >> (BigInt(b) * BAND_BITS)) & BAND_MASK}`);
  }
  return keys;
};

const findTwins = (entries, maxDistance = 5) => {
  const n = entries.length;
  const exhaustiveWork = (n * (n - 1)) / 2;

  // The recall guarantee is pigeonhole: d differing bits can spoil at most d
  // of the BANDS bands, so any pair within d < BANDS bits must still agree on
  // at least one band. Past that the prefilter would start dropping real
  // twins, so don't use it.
  if (maxDistance >= BANDS) return findTwinsExhaustive(entries, maxDistance);

  const buckets = new Map();
  entries.forEach((entry, index) => {
    bandKeys(entry.hash).forEach((key) => {
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      bucket.push(index);
    });
  });

  // Degenerate hashes (a whole band identical across the collection) make the
  // prefilter no cheaper than comparing everything. Skipping those buckets
  // would break the guarantee above, so fall back honestly instead.
  let work = 0;
  for (const members of buckets.values()) {
    work += (members.length * (members.length - 1)) / 2;
    if (work >= exhaustiveWork) return findTwinsExhaustive(entries, maxDistance);
  }

  const candidates = new Map(); // index -> Set(index)
  const link = (a, b) => {
    let set = candidates.get(a);
    if (!set) candidates.set(a, (set = new Set()));
    set.add(b);
  };
  buckets.forEach((members) => {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        link(members[i], members[j]);
        link(members[j], members[i]);
      }
    }
  });

  const seen = new Set();
  const clusters = [];
  for (let i = 0; i < n; i++) {
    if (seen.has(i)) continue;
    const group = [entries[i].id];
    // Ascending, so grouping is deterministic and matches the exhaustive form
    // exactly. Set iteration order would partition the same relation
    // differently from run to run.
    const near = [...(candidates.get(i) || [])].sort((a, b) => a - b);
    for (const j of near) {
      if (j <= i || seen.has(j)) continue;
      if (distance(entries[i].hash, entries[j].hash) <= maxDistance) {
        group.push(entries[j].id);
        seen.add(j);
      }
    }
    if (group.length > 1) {
      seen.add(i);
      clusters.push(group);
    }
  }
  return clusters;
};

/** The exhaustive form, kept so tests can prove the fast path agrees with it. */
const findTwinsExhaustive = (entries, maxDistance = 5) => {
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

module.exports = {
  hashImage, structureHash, colourHash, distance, isFlat,
  findTwins, findTwinsExhaustive,
};
