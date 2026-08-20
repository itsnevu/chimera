/**
 * Normalise whatever the user dropped in into a clean square reference.
 *
 * Local, free, and deterministic. Centre-crops to a square, scales to the
 * output size, and flattens onto white so a transparent PNG does not confuse
 * the model. Running this before the style bible removes a whole class of
 * drift caused by odd aspect ratios and stray padding.
 */
const basePath = process.cwd();
const fs = require("fs");
const { createCanvas, loadImage } = require(`${basePath}/node_modules/canvas`);

const prepare = async (inputPath, { size = 1024, background = "#FFFFFF" } = {}) => {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`reference image not found: ${inputPath}`);
  }
  const img = await loadImage(inputPath);
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);

  // Centre crop to square — never squash, never letterbox.
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

  return {
    buffer: canvas.toBuffer("image/png"),
    original: { width: img.width, height: img.height },
    cropped: side !== img.width || side !== img.height,
  };
};

module.exports = { prepare };
