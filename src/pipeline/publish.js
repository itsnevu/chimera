#!/usr/bin/env node
/**
 * Pin the collection to IPFS and rewrite metadata to point at it.
 *
 * Two passes, because metadata cannot be written until the images have a CID:
 *
 *   1. upload every image, recording each CID in a ledger
 *   2. rewrite each metadata file's `image` to its real CID, then upload those
 *
 * The ledger means a stopped upload resumes rather than re-pinning. Nothing is
 * uploaded without --yes: pinning is public and effectively permanent, so a
 * dry run is the default.
 */
const basePath = process.cwd();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const cfg = require(`${basePath}/src/config.js`);
const ai = require(`${basePath}/src/ai.config.js`);
const { uploadFile } = require(`${basePath}/src/publish/pinata.js`);
const { validateCollection } = require(`${basePath}/src/core/validateMetadata.js`);
const { Ledger, writeAtomic } = require(`${basePath}/src/pipeline/jobState.js`);
const { pool } = require(`${basePath}/src/pipeline/queue.js`);
const { withRetry, redact } = require(`${basePath}/src/providers/base.js`);
const { parser, fail } = require(`${basePath}/src/cli/args.js`);

const IMAGES = `${basePath}/build/images`;
const JSON_DIR = `${basePath}/build/json`;
const PIN_LEDGER = `${basePath}/build/ai/pins.jsonl`;

const num = (n) => n.toLocaleString("en-US");
const die = (m) => { console.error(`\n  ERROR  ${m}\n`); process.exit(1); };

/** Content identity for a rendered image, so a re-render is not mistaken for
 *  the file that was already pinned under the same edition number. */
const digest = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// Pinata documents 180 requests/minute. Staying under it turns rate limiting
// from a source of failed uploads into a non-event.
const PINS_PER_MINUTE = 150;

async function main() {
  const { has, number, endArgs } = parser(process.argv.slice(2));

  // Read from the environment only. On argv the credential would be visible
  // in `ps`, in shell history, and in ~/.npm/_logs on any npm-level failure.
  const jwt = process.env.PINATA_JWT;
  const yes = has("--yes");
  const rewriteOnly = has("--rewrite");
  const concurrency = number("--concurrency", 6, { min: 1, max: 32, integer: true });
  endArgs();

  if (!fs.existsSync(IMAGES)) die(`no images at build/images. Run:  npm run ai:finalize`);

  // Only editions that actually have metadata get pinned. Anything else in
  // this directory — leftovers from a larger previous run, a stray cover.png —
  // would otherwise be published permanently and billed.
  const metaEditions = new Set(
    fs.readdirSync(JSON_DIR).filter((f) => /^\d+\.json$/.test(f)).map((f) => parseInt(f, 10))
  );

  const images = [];
  const strays = [];
  for (const f of fs.readdirSync(IMAGES)) {
    if (!f.endsWith(".png")) continue;
    const edition = Number(f.replace(/\.png$/, ""));
    // parseInt would turn "cover.png" into NaN, which serialises to null and
    // is skipped by the ledger — re-pinning and re-billing it on every run.
    if (!Number.isInteger(edition) || !metaEditions.has(edition)) { strays.push(f); continue; }
    images.push({ file: f, edition });
  }
  images.sort((a, b) => a.edition - b.edition);
  if (!images.length) die("no image in build/images matches a metadata file in build/json");

  console.log(`\nCHIMERA — PUBLISH\n${"─".repeat(62)}`);
  console.log(`  images          ${num(images.length)}`);
  console.log(`  metadata        ${num(metaEditions.size)}`);
  if (strays.length) {
    console.log(`  ! ignoring      ${num(strays.length)} file(s) with no matching metadata: ` +
      `${strays.slice(0, 3).join(", ")}${strays.length > 3 ? "…" : ""}`);
  }

  // Placeholders are the one mistake that cannot be walked back once pinned,
  // so this gate fails closed: no manifest means nothing has been verified.
  const metaPath = `${JSON_DIR}/_metadata.json`;
  if (!fs.existsSync(metaPath)) {
    die(`no build/json/_metadata.json to validate. Run:  npm run ai:finalize`);
  }
  const traitNames = fs.existsSync(`${basePath}/chimera.traits.js`)
    ? require(`${basePath}/chimera.traits.js`).traits.map((t) => t.name)
    : [];
  const { errors } = validateCollection(
    JSON.parse(fs.readFileSync(metaPath, "utf8")),
    { network: cfg.network, traitNames }
  );
  if (errors.length) {
    // Errors are {edition, problem} objects — interpolating them directly
    // printed "[object Object]" and told the operator nothing.
    const shown = errors.slice(0, 3).map((e) => `#${e.edition}: ${e.problem}`);
    die(
      `metadata has ${num(errors.length)} validation error(s); publishing is permanent.\n` +
      `         ${shown.join("\n         ")}\n` +
      `         Run:  npm run validate    for the full report`
    );
  }

  const ledger = new Ledger(PIN_LEDGER);
  const { done } = ledger.read();

  // An edition counts as pinned only if the bytes on disk are the bytes that
  // were pinned. Keying on edition number alone means the QC -> requeue ->
  // re-render loop silently welds the rejected art's CID to the new metadata.
  const pending = images.filter(({ file, edition }) => {
    const prior = done.get(edition);
    if (!prior) return true;
    if (!prior.sha256) return true; // pinned before hashes were recorded
    return prior.sha256 !== digest(fs.readFileSync(`${IMAGES}/${file}`));
  });
  const rerendered = pending.filter(({ edition }) => done.has(edition)).length;

  console.log(`  already pinned  ${num(done.size)}`);
  console.log(`  to pin          ${num(pending.length)}` +
    (rerendered ? `  (${num(rerendered)} changed since they were pinned)` : ""));

  if (!yes) {
    console.log(`\n  DRY RUN. Pinning to IPFS is public and effectively permanent —`);
    console.log(`  a CID cannot be unpublished once others have fetched it.`);
    console.log(`  Nothing was uploaded and no metadata was touched.`);
    console.log(`  Re-run with --yes to pin ${num(pending.length)} image(s).\n`);
    return;
  }
  if (!jwt) die(`no Pinata JWT.\n         export PINATA_JWT=...`);
  if (!pending.length && !rewriteOnly) {
    console.log(`\n  Everything is pinned and unchanged. Use --rewrite to regenerate metadata.\n`);
    return;
  }

  // ── pass 1: images ───────────────────────────────────────────────────────
  ledger.open();
  let ok = 0, failed = 0;

  // A bad JWT would otherwise fail all N uploads one by one, burning the rate
  // limit before anyone sees the problem.
  let authFailed = false;

  await pool(pending, async ({ file, edition }) => {
    const buffer = fs.readFileSync(`${IMAGES}/${file}`);
    try {
      const result = await withRetry(
        () => uploadFile({ buffer, name: file, jwt }),
        { attempts: 4, onRetry: (n, w, e) => console.log(`    retry ${n} for ${file} — ${redact(e.message)}`) }
      );
      ledger.append({
        edition,
        file,
        cid: result.cid,
        sha256: digest(buffer),
        size: result.size,
        at: new Date().toISOString(),
      });
      ok++;
      if (ok % 50 === 0) console.log(`    ${num(ok)}/${num(pending.length)} pinned`);
    } catch (err) {
      failed++;
      if (err.status === 401 || err.status === 403) authFailed = true;
      console.error(`    FAILED ${file} — ${redact(err.message)}`);
    }
  }, { concurrency, perMinute: PINS_PER_MINUTE, shouldStop: () => authFailed });

  ledger.close();
  console.log(`\n  pinned          ${num(ok)}${failed ? `,  ${num(failed)} failed` : ""}`);

  if (authFailed) die("Pinata rejected the JWT. Nothing further was uploaded and metadata is untouched.");

  // Rewriting metadata for only the editions that happened to succeed would
  // publish a collection with holes in it — and `_metadata.json` would be
  // replaced by the short list, destroying the record of what is missing.
  if (failed) {
    die(
      `${num(failed)} upload(s) failed, so metadata was NOT rewritten.\n` +
      `         Successful pins are recorded and will be skipped — re-run to finish.`
    );
  }

  // ── pass 2: metadata ─────────────────────────────────────────────────────
  const pins = new Map([...ledger.read().done.values()].map((p) => [p.edition, p.cid]));
  if (!pins.size) die("nothing pinned, so there is no CID to point metadata at");

  const collection = [];
  let rewritten = 0, missing = 0;

  fs.readdirSync(JSON_DIR)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b))
    .forEach((f) => {
      const meta = JSON.parse(fs.readFileSync(`${JSON_DIR}/${f}`, "utf8"));
      const cid = pins.get(meta.edition);
      if (!cid) { missing++; return; }
      // Solana keeps a bare filename in `image` and the URI under properties.
      if (cfg.network === "sol") {
        meta.image = `ipfs://${cid}`;
        if (meta.properties?.files?.[0]) meta.properties.files[0].uri = `ipfs://${cid}`;
      } else {
        meta.image = `ipfs://${cid}`;
      }
      writeAtomic(`${JSON_DIR}/${f}`, JSON.stringify(meta, null, 2));
      collection.push(meta);
      rewritten++;
    });

  // A gap here means a token would point at nothing. Better to leave the
  // previous _metadata.json intact and say so than to ship a holed collection.
  if (missing) {
    die(
      `${num(missing)} edition(s) have metadata but no pin, so _metadata.json was NOT rewritten.\n` +
      `         Re-run to pin them, or remove their metadata if they are not part of the drop.`
    );
  }

  writeAtomic(`${JSON_DIR}/_metadata.json`, JSON.stringify(collection, null, 2));
  console.log(`  rewritten       ${num(rewritten)} metadata files`);
  console.log(`\n  Each token's \`image\` now holds its own ipfs:// CID, so baseUri is`);
  console.log(`  no longer used — do NOT re-run ai:finalize, it would overwrite them.`);
  console.log(`\n  Next:  npm run validate            confirm no placeholders remain`);
  console.log(`         pin build/json/ separately    for the tokenURI directory\n`);
}

// Guarded, and this one matters most: requiring this module unguarded would
// pin the whole collection to public IPFS, which cannot be undone.
if (require.main === module) main().catch((e) => fail(e, redact));

module.exports = { main };
