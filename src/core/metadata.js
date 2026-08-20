/**
 * Metadata construction, made pure.
 *
 * The original addMetadata() read a module-level `attributesList` and cleared
 * it as a side effect. That is safe in a sequential loop and silently corrupts
 * the moment two editions are in flight at once — edition A's attributes end
 * up on edition B. AI mode renders concurrently, so this had to become a
 * function of its arguments and nothing else.
 *
 * The ETH and Solana output shapes are preserved exactly.
 */
const basePath = process.cwd();
const sha1 = require(`${basePath}/node_modules/sha1`);
const { NETWORK } = require(`${basePath}/constants/network.js`);

/**
 * Pull the attribute list out of rendered layers without touching shared state.
 *
 * @param {Array} renderObjects  [{ layer: { name, selectedElement } }]
 * @returns {Array} [{ trait_type, value }]
 */
const collectAttributes = (renderObjects) =>
  renderObjects.map((renderObject) => {
    const layer = renderObject.layer || renderObject;
    return {
      trait_type: layer.name,
      value: layer.selectedElement.name,
    };
  });

/**
 * @param {Object}  args
 * @param {String}  args.dna         raw DNA string (hashed here, never stored raw)
 * @param {Number}  args.edition
 * @param {Array}   args.attributes  from collectAttributes()
 * @param {Object}  args.cfg         { namePrefix, description, baseUri, network,
 *                                     solanaMetadata, extraMetadata }
 * @param {Number} [args.date]       injectable so runs are reproducible in tests
 * @returns {Object} metadata, ready to serialise
 */
const buildMetadata = ({ dna, edition, attributes, cfg, date }) => {
  const {
    namePrefix,
    description,
    baseUri,
    network,
    solanaMetadata,
    extraMetadata = {},
  } = cfg;

  const tempMetadata = {
    name: `${namePrefix} #${edition}`,
    description: description,
    image: `${baseUri}/${edition}.png`,
    dna: sha1(dna),
    edition: edition,
    date: date === undefined ? Date.now() : date,
    ...extraMetadata,
    attributes: attributes,
    compiler: "Chimera",
  };

  if (network == NETWORK.sol) {
    return {
      name: tempMetadata.name,
      symbol: solanaMetadata.symbol,
      description: tempMetadata.description,
      seller_fee_basis_points: solanaMetadata.seller_fee_basis_points,
      image: `${edition}.png`,
      external_url: solanaMetadata.external_url,
      edition: edition,
      ...extraMetadata,
      attributes: tempMetadata.attributes,
      properties: {
        files: [
          {
            uri: `${edition}.png`,
            type: "image/png",
          },
        ],
        category: "image",
        creators: solanaMetadata.creators,
      },
    };
  }

  return tempMetadata;
};

module.exports = { buildMetadata, collectAttributes };
