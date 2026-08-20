const basePath = process.cwd();
const fs = require("fs");
const { createCanvas, loadImage } = require("canvas");
const buildDir = `${basePath}/build`;

const { preview } = require(`${basePath}/src/config.js`);

// read json data
const rawdata = fs.readFileSync(`${basePath}/build/json/_metadata.json`);
const metadataList = JSON.parse(rawdata);

const saveProjectPreviewImage = async (_data) => {
  // Extract from preview config
  const { thumbWidth, thumbPerRow, imageRatio, imageName } = preview;
  // Calculate height on the fly
  const thumbHeight = thumbWidth * imageRatio;
  // Prepare canvas
  const previewCanvasWidth = thumbWidth * thumbPerRow;
  let previewCanvasHeight = thumbHeight * Math.ceil(_data.length / thumbPerRow);

  // node-canvas segfaults (SIGSEGV, uncatchable) above 32767px, which at the
  // shipped 50px/5-per-row config is any collection over ~3,276 editions.
  // Refuse with an explanation rather than dying with no output.
  const MAX_DIM = 32767;
  if (previewCanvasHeight > MAX_DIM) {
    const fits = Math.floor(MAX_DIM / thumbHeight) * thumbPerRow;
    console.error(
      `\n  ERROR  a ${previewCanvasWidth}x${previewCanvasHeight} preview exceeds the ` +
      `${MAX_DIM}px canvas limit.\n` +
      `         ${_data.length} editions at thumbWidth ${thumbWidth} / thumbPerRow ` +
      `${thumbPerRow} does not fit.\n` +
      `         Raise thumbPerRow, lower thumbWidth, or preview at most ${fits} editions.\n`
    );
    process.exitCode = 1;
    return;
  }
  // Shout from the mountain tops
  console.log(
    `Preparing a ${previewCanvasWidth}x${previewCanvasHeight} project preview with ${_data.length} thumbnails.`
  );

  // Initiate the canvas now that we have calculated everything
  const previewPath = `${buildDir}/${imageName}`;
  const previewCanvas = createCanvas(previewCanvasWidth, previewCanvasHeight);
  const previewCtx = previewCanvas.getContext("2d");

  // Iterate all NFTs and insert thumbnail into preview image
  // Don't want to rely on "edition" for assuming index
  for (let index = 0; index < _data.length; index++) {
    const nft = _data[index];
    await loadImage(`${buildDir}/images/${nft.edition}.png`).then((image) => {
      previewCtx.drawImage(
        image,
        thumbWidth * (index % thumbPerRow),
        thumbHeight * Math.trunc(index / thumbPerRow),
        thumbWidth,
        thumbHeight
      );
    });
  }

  // Write Project Preview to file
  fs.writeFileSync(previewPath, previewCanvas.toBuffer("image/png"));
  console.log(`Project preview image located at: ${previewPath}`);
};

saveProjectPreviewImage(metadataList);
