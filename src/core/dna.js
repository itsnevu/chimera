/**
 * The rarity engine.
 *
 * Every function here was lifted verbatim out of src/main.js — they were
 * already pure, they were already correct, and they are what makes a
 * collection's rarity provable. AI mode reuses them byte-for-byte rather
 * than reimplementing weighted selection and hoping it matches.
 *
 * The only change is that they now live somewhere both renderers can reach.
 */
const basePath = process.cwd();
const { rarityDelimiter } = require(`${basePath}/src/config.js`);

const DNA_DELIMITER = "-";

/**
 * Strip the extension.
 *
 * `slice(0, -4)` assumed every extension was exactly four characters, so
 * "Gold Leaf.jpeg" became "Gold Leaf." — a trailing dot that shipped straight
 * into the metadata `value` — and a file with no extension lost real
 * characters off its name.
 */
const withoutExtension = (_str) => {
  const dot = _str.lastIndexOf(".");
  return dot > 0 ? _str.slice(0, dot) : _str;
};

const getRarityWeight = (_str) => {
  const nameWithoutExtension = withoutExtension(_str);
  let weight = Number(nameWithoutExtension.split(rarityDelimiter).pop());
  if (isNaN(weight)) {
    weight = 1;
  }
  return weight;
};

const cleanName = (_str) => {
  const nameWithoutExtension = withoutExtension(_str);
  const parts = nameWithoutExtension.split(rarityDelimiter);
  // Only the LAST delimited segment is the weight. Taking the first segment
  // truncated any name that legitimately contains the delimiter:
  // "Hash#Tag#10.png" silently became "Hash", losing "Tag", while the weight
  // still parsed as 10 so nothing looked wrong.
  if (parts.length > 1 && !isNaN(Number(parts[parts.length - 1]))) {
    parts.pop();
  }
  return parts.join(rarityDelimiter);
};

/**
 * Cleaning function for DNA strings. When DNA strings include an option, it
 * is added to the filename with a ?setting=value query string. It needs to be
 * removed to properly access the file name before Drawing.
 */
const removeQueryStrings = (_dna) => {
  const query = /(\?.*$)/;
  return _dna.replace(query, "");
};

const cleanDna = (_str) => {
  const withoutOptions = removeQueryStrings(_str);
  var dna = Number(withoutOptions.split(":").shift());
  return dna;
};

/**
 * In some cases a DNA string may contain optional query parameters for options
 * such as bypassing the DNA isUnique check, this function filters out those
 * items without modifying the stored DNA.
 */
const filterDNAOptions = (_dna) => {
  const dnaItems = _dna.split(DNA_DELIMITER);
  const filteredDNA = dnaItems.filter((element) => {
    const query = /(\?.*$)/;
    const querystring = query.exec(element);
    if (!querystring) {
      return true;
    }
    const options = querystring[1].split("&").reduce((r, setting) => {
      const keyPairs = setting.split("=");
      return { ...r, [keyPairs[0]]: keyPairs[1] };
    }, []);

    return options.bypassDNA;
  });

  return filteredDNA.join(DNA_DELIMITER);
};

const isDnaUnique = (_DnaList = new Set(), _dna = "") => {
  const _filteredDNA = filterDNAOptions(_dna);
  return !_DnaList.has(_filteredDNA);
};

const createDna = (_layers) => {
  let randNum = [];
  _layers.forEach((layer) => {
    var totalWeight = 0;
    layer.elements.forEach((element) => {
      totalWeight += element.weight;
    });
    // A layer whose weights all sum to zero has nothing selectable. Left
    // alone, the loop below never fires, the layer is silently dropped from
    // the DNA, and every later layer decodes at the wrong index.
    if (!(totalWeight > 0)) {
      throw new Error(
        `layer "${layer.name || layer.id}" has no selectable elements ` +
        `(weights sum to ${totalWeight}) — check for an empty folder or zero weights`
      );
    }

    // Not floored: flooring quantises the roll to whole numbers, so any
    // fractional weight is mis-sampled. Two options at weight 0.5 give
    // totalWeight 1, floor() makes every roll 0, and the first option wins
    // 100% of the time. The subtract-until-negative loop below is exact on
    // real numbers, so leave the roll continuous.
    let random = Math.random() * totalWeight;
    for (var i = 0; i < layer.elements.length; i++) {
      // subtract the current weight from the random weight until we reach a sub zero value.
      random -= layer.elements[i].weight;
      if (random < 0) {
        return randNum.push(
          `${layer.elements[i].id}:${layer.elements[i].filename}${
            layer.bypassDNA ? "?bypassDNA=true" : ""
          }`
        );
      }
    }
  });
  return randNum.join(DNA_DELIMITER);
};

const constructLayerToDna = (_dna = "", _layers = []) => {
  let mappedDnaToLayers = _layers.map((layer, index) => {
    let selectedElement = layer.elements.find(
      (e) => e.id == cleanDna(_dna.split(DNA_DELIMITER)[index])
    );
    return {
      name: layer.name,
      blend: layer.blend,
      opacity: layer.opacity,
      selectedElement: selectedElement,
    };
  });
  return mappedDnaToLayers;
};

function shuffle(array) {
  let currentIndex = array.length,
    randomIndex;
  while (currentIndex != 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }
  return array;
}

module.exports = {
  DNA_DELIMITER,
  getRarityWeight,
  cleanName,
  cleanDna,
  removeQueryStrings,
  filterDNAOptions,
  isDnaUnique,
  createDna,
  constructLayerToDna,
  shuffle,
};
