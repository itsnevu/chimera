/**
 * Pinata adapter for IPFS pinning.
 *
 * Same contract as the image providers: bring your own key, the key never
 * touches disk, and every error message is redacted before it is printed.
 *
 * Verified structurally against Pinata's documented v3 API. It has NOT been
 * exercised against the live service — that needs an account and a JWT.
 */
const { ProviderError, redact } = require(`${process.cwd()}/src/providers/base.js`);

const UPLOAD = "https://uploads.pinata.cloud/v3/files";

/**
 * @returns {{cid: String, id: String, size: Number}}
 */
const uploadFile = async ({ buffer, name, jwt, groupId, timeoutMs = 120000 }) => {
  if (!jwt) throw new ProviderError("missing Pinata JWT", { retryable: false });

  const form = new FormData();
  form.append("file", new Blob([buffer]), name);
  form.append("network", "public");
  if (groupId) form.append("group_id", groupId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(UPLOAD, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new ProviderError(`upload failed: ${redact(err.message)}`, { retryable: true });
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(`Pinata ${res.status}: ${redact(text).slice(0, 300)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError(`unparseable response: ${redact(text).slice(0, 200)}`, { retryable: true });
  }

  const cid = json?.data?.cid ?? json?.cid ?? json?.IpfsHash;
  if (!cid) {
    throw new ProviderError(
      `no CID in response. Keys: ${Object.keys(json).join(", ")}`,
      { retryable: false }
    );
  }
  return { cid, id: json?.data?.id ?? null, size: json?.data?.size ?? buffer.length };
};

module.exports = { id: "pinata", uploadFile, UPLOAD };
