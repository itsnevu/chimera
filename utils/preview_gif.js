const basePath = process.cwd();
const fs = require("fs");
const { createCanvas, loadImage } = require("canvas");
const buildDir = `${basePath}/build`;
const imageDir = `${buildDir}/images`;
const { format, preview_gif } = require(`${basePath}/src/config.js`);
const canvas = createCanvas(format.width, format.height);
const ctx = canvas.getContext("2d");

const ChimeraGiffer = require(`${basePath}/modules/ChimeraGiffer.js`);
let chimeraGiffer = null;

const loadImg = async (_img) => {
  // A `new Promise(async ...)` wrapper can never reject: the await lives in the
  // executor, so a decode failure escaped as an unhandled rejection.
  const loadedImage = await loadImage(`${_img}`);
  return { loadedImage };
};

/**
 * Filenames only, ordered and trimmed to what the gif will actually use.
 *
 * Every PNG in build/images used to be decoded into memory at module load,
 * before the array was sliced to numberOfImages — 1.3 GB resident to produce a
 * five-frame gif, and an OOM on a large collection. Extensions are filtered
 * too: a stray .DS_Store killed the run with "Unsupported image type".
 */
const selectFrames = () => {
  const { numberOfImages, order } = preview_gif;
  let files = fs
    .readdirSync(imageDir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  if (order === "DESC") files.reverse();
  else if (order === "MIXED") files = files.sort(() => Math.random() - 0.5);

  const want = parseInt(numberOfImages, 10);
  if (want > 0) files = files.slice(0, want);
  return files;
};

const saveProjectPreviewGIF = async (_data) => {
  // Extract from preview config
  const { numberOfImages, order, repeat, quality, delay, imageName } =
    preview_gif;
  // Extract from format config
  const { width, height } = format;
  // Prepare canvas
  const previewCanvasWidth = width;
  const previewCanvasHeight = height;

  if (_data.length < numberOfImages) {
    console.log(
      `You do not have enough images to create a gif with ${numberOfImages} images.`
    );
  } else {
    // Shout from the mountain tops
    console.log(
      `Preparing a ${previewCanvasWidth}x${previewCanvasHeight} project preview with ${_data.length} images.`
    );
    const previewPath = `${buildDir}/${imageName}`;

    ctx.clearRect(0, 0, width, height);

    chimeraGiffer = new ChimeraGiffer(
      canvas,
      ctx,
      `${previewPath}`,
      repeat,
      quality,
      delay
    );
    chimeraGiffer.start();

    await Promise.all(_data).then((renderObjectArray) => {
      // Ordering and trimming already happened on filenames in selectFrames(),
      // so only the frames that end up in the gif are ever decoded.

      renderObjectArray.forEach((renderObject, index) => {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(
          renderObject.loadedImage,
          0,
          0,
          previewCanvasWidth,
          previewCanvasHeight
        );
        chimeraGiffer.add();
      });
    });
    chimeraGiffer.stop();
  }
};

const frames = selectFrames();
if (!frames.length) {
  console.error("\n  ERROR  no images in build/images to build a gif from.\n");
  process.exitCode = 1;
} else {
  saveProjectPreviewGIF(frames.map((f) => loadImg(`${imageDir}/${f}`)));
}
