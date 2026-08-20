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

/** CIDv0 (`Qm…`, base58btc) or CIDv1 (`b…`, base32 lower). Pinata v3 defaults
 *  to v1, but accepts a v0 request, so both shapes are legitimate. */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

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

  // The timer is cleared only after the body is read. Clearing it at headers
  // leaves the body untimed, so a server that sends headers then stalls hangs
  // the worker forever — a few of those deadlock the whole publish.
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new ProviderError(`upload body read failed: ${redact(err.message)}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

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

  // JSON.parse accepts the literal `null`, and Object.keys(null) throws a
  // raw TypeError that withRetry would treat as retryable — four re-uploads
  // of the same bytes for a condition that is not retryable.
  if (!json || typeof json !== "object") {
    throw new ProviderError(`unexpected response body: ${redact(text).slice(0, 200)}`, {
      retryable: false,
    });
  }

  const cid = json?.data?.cid ?? json?.cid ?? json?.IpfsHash;
  if (!cid) {
    throw new ProviderError(
      `no CID in response. Keys: ${Object.keys(json).join(", ")}`,
      { retryable: false }
    );
  }
  // A truthy non-string would be written into every metadata file as
  // `ipfs://[object Object]` — permanently, with no backup of what it replaced.
  if (typeof cid !== "string" || !CID.test(cid)) {
    throw new ProviderError(
      `response CID is not a valid IPFS CID: ${JSON.stringify(cid).slice(0, 120)}`,
      { retryable: false }
    );
  }
  return { cid, id: json?.data?.id ?? null, size: json?.data?.size ?? buffer.length };
};

module.exports = { id: "pinata", uploadFile, UPLOAD };
