const basePath = process.cwd();
const { NETWORK } = require(`${basePath}/constants/network.js`);
const fs = require("fs");
const sha1 = require(`${basePath}/node_modules/sha1`);
const { createCanvas, loadImage } = require(`${basePath}/node_modules/canvas`);
const buildDir = `${basePath}/build`;
const layersDir = `${basePath}/layers`;
const {
  format,
  baseUri,
  description,
  background,
  uniqueDnaTorrance,
  layerConfigurations,
  rarityDelimiter,
  shuffleLayerConfigurations,
  debugLogs,
  extraMetadata,
  text,
  namePrefix,
  network,
  solanaMetadata,
  gif,
} = require(`${basePath}/src/config.js`);
const canvas = createCanvas(format.width, format.height);
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = format.smoothing;
var metadataList = [];
var dnaList = new Set();

// The rarity engine and metadata builder now live in src/core/ so AI mode can
// reuse them. Layer mode behaviour is unchanged.
const {
  DNA_DELIMITER,
  getRarityWeight,
  cleanName,
  filterDNAOptions,
  isDnaUnique,
  createDna,
  constructLayerToDna,
  shuffle,
} = require(`${basePath}/src/core/dna.js`);
const {
  buildMetadata,
  collectAttributes,
} = require(`${basePath}/src/core/metadata.js`);
const ChimeraGiffer = require(`${basePath}/modules/ChimeraGiffer.js`);

let chimeraGiffer = null;

const buildSetup = () => {
  // A ledger means an AI run has spent real money into this directory.
  // Wiping it would destroy paid-for images, so refuse unless forced.
  const ledger = `${buildDir}/ai/ledger.jsonl`;
  if (fs.existsSync(ledger) && !process.argv.includes("--force")) {
    console.error(
      `Refusing to clear ${buildDir}: an AI run ledger exists at ${ledger}.\n` +
        `Those images were paid for. Move them, or pass --force to wipe anyway.`
    );
    process.exit(1);
  }
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true });
  }
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(`${buildDir}/json`, { recursive: true });
  fs.mkdirSync(`${buildDir}/images`, { recursive: true });
  if (gif.export) {
    fs.mkdirSync(`${buildDir}/gifs`, { recursive: true });
  }
};

const getElements = (path) => {
  return fs
    .readdirSync(path)
    .filter((item) => !/(^|\/)\.[^\/\.]/g.test(item))
    .map((i, index) => {
      if (i.includes("-")) {
        throw new Error(`layer name can not contain dashes, please fix: ${i}`);
      }
      return {
        id: index,
        name: cleanName(i),
        filename: i,
        path: `${path}${i}`,
        weight: getRarityWeight(i),
      };
    });
};

const layersSetup = (layersOrder) => {
  const layers = layersOrder.map((layerObj, index) => ({
    id: index,
    elements: getElements(`${layersDir}/${layerObj.name}/`),
    name:
      layerObj.options?.["displayName"] != undefined
        ? layerObj.options?.["displayName"]
        : layerObj.name,
    blend:
      layerObj.options?.["blend"] != undefined
        ? layerObj.options?.["blend"]
        : "source-over",
    opacity:
      layerObj.options?.["opacity"] != undefined
        ? layerObj.options?.["opacity"]
        : 1,
    bypassDNA:
      layerObj.options?.["bypassDNA"] !== undefined
        ? layerObj.options?.["bypassDNA"]
        : false,
  }));
  return layers;
};

const saveImage = (_editionCount) => {
  fs.writeFileSync(
    `${buildDir}/images/${_editionCount}.png`,
    canvas.toBuffer("image/png")
  );
};

const genColor = () => {
  let hue = Math.floor(Math.random() * 360);
  let pastel = `hsl(${hue}, 100%, ${background.brightness})`;
  return pastel;
};

const drawBackground = () => {
  ctx.fillStyle = background.static ? background.default : genColor();
  ctx.fillRect(0, 0, format.width, format.height);
};

const loadLayerImg = async (_layer) => {
  // No `new Promise(async ...)` wrapper: the await used to sit inside the
  // executor, so a decode failure escaped both the executor and the catch.
  // Promise.all never settled and Node killed the run with an unhandled
  // rejection, after images were already on disk and before writeMetaData.
  try {
    const image = await loadImage(`${_layer.selectedElement.path}`);
    return { layer: _layer, loadedImage: image };
  } catch (error) {
    throw new Error(
      `could not load ${_layer.selectedElement.path}: ${error.message}`
    );
  }
};

const addText = (_sig, x, y, size) => {
  ctx.fillStyle = text.color;
  ctx.font = `${text.weight} ${size}pt ${text.family}`;
  ctx.textBaseline = text.baseline;
  ctx.textAlign = text.align;
  ctx.fillText(_sig, x, y);
};

const drawElement = (_renderObject, _index, _layersLen) => {
  ctx.globalAlpha = _renderObject.layer.opacity;
  ctx.globalCompositeOperation = _renderObject.layer.blend;
  text.only
    ? addText(
        `${_renderObject.layer.name}${text.spacer}${_renderObject.layer.selectedElement.name}`,
        text.xGap,
        text.yGap * (_index + 1),
        text.size
      )
    : ctx.drawImage(
        _renderObject.loadedImage,
        0,
        0,
        format.width,
        format.height
      );
};

const writeMetaData = (_data) => {
  fs.writeFileSync(`${buildDir}/json/_metadata.json`, _data);
};

const saveMetaDataSingleFile = (metadata) => {
  const _editionCount = metadata.edition;
  debugLogs
    ? console.log(
        `Writing metadata for ${_editionCount}: ${JSON.stringify(metadata)}`
      )
    : null;
  fs.writeFileSync(
    `${buildDir}/json/${_editionCount}.json`,
    JSON.stringify(metadata, null, 2)
  );
};

const startCreating = async () => {
  let layerConfigIndex = 0;
  let editionCount = 1;
  let failedCount = 0;
  let abstractedIndexes = [];
  // Solana is 0-indexed and ETH is 1-indexed, so only the ETH bound is
  // inclusive. Building both inclusively gave Solana N+1 indexes for N
  // editions, and with shuffling on, the extra one displaced a real token id.
  const lastConfig = layerConfigurations[layerConfigurations.length - 1];
  const firstIndex = network == NETWORK.sol ? 0 : 1;
  const lastIndex =
    network == NETWORK.sol
      ? lastConfig.growEditionSizeTo - 1
      : lastConfig.growEditionSizeTo;
  for (let i = firstIndex; i <= lastIndex; i++) {
    abstractedIndexes.push(i);
  }
  if (shuffleLayerConfigurations) {
    abstractedIndexes = shuffle(abstractedIndexes);
  }
  debugLogs
    ? console.log("Editions left to create: ", abstractedIndexes)
    : null;
  while (layerConfigIndex < layerConfigurations.length) {
    const layers = layersSetup(
      layerConfigurations[layerConfigIndex].layersOrder
    );
    while (
      editionCount <= layerConfigurations[layerConfigIndex].growEditionSizeTo
    ) {
      let newDna = createDna(layers);
      if (isDnaUnique(dnaList, newDna)) {
        let results = constructLayerToDna(newDna, layers);
        let loadedElements = [];

        results.forEach((layer) => {
          loadedElements.push(loadLayerImg(layer));
        });

        await Promise.all(loadedElements).then((renderObjectArray) => {
          debugLogs ? console.log("Clearing canvas") : null;
          ctx.clearRect(0, 0, format.width, format.height);
          if (gif.export) {
            chimeraGiffer = new ChimeraGiffer(
              canvas,
              ctx,
              `${buildDir}/gifs/${abstractedIndexes[0]}.gif`,
              gif.repeat,
              gif.quality,
              gif.delay
            );
            chimeraGiffer.start();
          }
          if (background.generate) {
            drawBackground();
          }
          renderObjectArray.forEach((renderObject, index) => {
            drawElement(
              renderObject,
              index,
              layerConfigurations[layerConfigIndex].layersOrder.length
            );
            if (gif.export) {
              chimeraGiffer.add();
            }
          });
          if (gif.export) {
            chimeraGiffer.stop();
          }
          debugLogs
            ? console.log("Editions left to create: ", abstractedIndexes)
            : null;
          saveImage(abstractedIndexes[0]);
          const metadata = buildMetadata({
            dna: newDna,
            edition: abstractedIndexes[0],
            attributes: collectAttributes(renderObjectArray),
            cfg: {
              namePrefix,
              description,
              baseUri,
              network,
              solanaMetadata,
              extraMetadata,
            },
          });
          metadataList.push(metadata);
          saveMetaDataSingleFile(metadata);
          console.log(
            `Created edition: ${abstractedIndexes[0]}, with DNA: ${sha1(
              newDna
            )}`
          );
        });
        dnaList.add(filterDNAOptions(newDna));
        editionCount++;
        failedCount = 0; // consecutive failures, not lifetime — a long healthy
                         // run would otherwise trip the bailout eventually
        abstractedIndexes.shift();
      } else {
        console.log("DNA exists!");
        failedCount++;
        if (failedCount >= uniqueDnaTorrance) {
          console.log(
            `You need more layers or elements to grow your edition to ${layerConfigurations[layerConfigIndex].growEditionSizeTo} artworks!`
          );
          // Persist what was actually built, then fail. A bare process.exit()
          // is exit code 0, so CI and `&&` chains read a half-finished
          // collection as success — and it skipped writeMetaData entirely,
          // leaving per-edition JSON with no _metadata.json.
          writeMetaData(JSON.stringify(metadataList, null, 2));
          process.exit(1);
        }
      }
    }
    layerConfigIndex++;
  }
  writeMetaData(JSON.stringify(metadataList, null, 2));
};

module.exports = { startCreating, buildSetup, getElements };
