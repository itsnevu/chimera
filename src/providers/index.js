const basePath = process.cwd();

const REGISTRY = {
  mock: () => require(`${basePath}/src/providers/mock.js`),
  openrouter: () => require(`${basePath}/src/providers/openrouter.js`),
};

/**
 * Key resolution, most explicit first. The key is read here and nowhere else,
 * and never written back to disk, the plan, or the ledger.
 */
const resolveKey = (providerId, explicit) => {
  if (explicit) return explicit;
  const envName = { openrouter: "OPENROUTER_API_KEY" }[providerId];
  if (envName && process.env[envName]) return process.env[envName];
  return null;
};

const getProvider = (id) => {
  const load = REGISTRY[id];
  if (!load) {
    throw new Error(
      `Unknown provider "${id}". Known: ${Object.keys(REGISTRY).join(", ")}`
    );
  }
  return load();
};

module.exports = { getProvider, resolveKey, PROVIDERS: Object.keys(REGISTRY) };
