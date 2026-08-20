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

const cfg = require(`${basePath}/src/config.js`);
const ai = require(`${basePath}/src/ai.config.js`);
const { uploadFile } = require(`${basePath}/src/publish/pinata.js`);
const { Ledger, writeAtomic } = require(`${basePath}/src/pipeline/jobState.js`);
const { pool } = require(`${basePath}/src/pipeline/queue.js`);
const { withRetry, redact } = require(`${basePath}/src/providers/base.js`);
const { parser, fail } = require(`${basePath}/src/cli/args.js`);

const IMAGES = `${basePath}/build/images`;
const JSON_DIR = `${basePath}/build/json`;
const PIN_LEDGER = `${basePath}/build/ai/pins.jsonl`;

const num = (n) => n.toLocaleString("en-US");
const die = (m) => { console.error(`\n  ERROR  ${m}\n`); process.exit(1); };

async function main() {
  const { has, arg, number } = parser(process.argv.slice(2));

  const jwt = arg("--jwt", process.env.PINATA_JWT);
  const yes = has("--yes");
  const concurrency = number("--concurrency", 6, { min: 1, max: 32, integer: true });

  if (!fs.existsSync(IMAGES)) die(`no images at build/images. Run:  npm run ai:finalize`);
  const images = fs.readdirSync(IMAGES).filter((f) => f.endsWith(".png"))
    .sort((a, b) => parseInt(a) - parseInt(b));
  if (!images.length) die("build/images is empty");

  console.log(`\nCHIMERA — PUBLISH\n${"─".repeat(62)}`);
  console.log(`  images          ${num(images.length)}`);
  console.log(`  metadata        ${num(fs.readdirSync(JSON_DIR).filter((f) => /^\d+\.json$/.test(f)).length)}`);

  const ledger = new Ledger(PIN_LEDGER);
  const { done } = ledger.read();
  const pending = images.filter((f) => !done.has(parseInt(f)));

  console.log(`  already pinned  ${num(done.size)}`);
  console.log(`  to pin          ${num(pending.length)}`);

  if (!yes) {
    console.log(`\n  DRY RUN. Pinning to IPFS is public and effectively permanent —`);
    console.log(`  a CID cannot be unpublished once others have fetched it.`);
    console.log(`  Check build/json/1.json looks right, then re-run with --yes.\n`);
    return;
  }
  if (!jwt) die(`no Pinata JWT.\n         export PINATA_JWT=...   or pass --jwt`);
  if (!pending.length && !has("--rewrite")) {
    console.log(`\n  Everything is pinned. Use --rewrite to regenerate metadata.\n`);
  }

  // ── pass 1: images ───────────────────────────────────────────────────────
  ledger.open();
  let ok = 0, failed = 0;

  await pool(pending, async (file) => {
    const edition = parseInt(file);
    try {
      const result = await withRetry(
        () => uploadFile({ buffer: fs.readFileSync(`${IMAGES}/${file}`), name: file, jwt }),
        { attempts: 4, onRetry: (n, w, e) => console.log(`    retry ${n} for ${file} — ${redact(e.message)}`) }
      );
      ledger.append({ edition, file, cid: result.cid, size: result.size, at: new Date().toISOString() });
      ok++;
      if (ok % 50 === 0) console.log(`    ${num(ok)}/${num(pending.length)} pinned`);
    } catch (err) {
      failed++;
      console.error(`    FAILED ${file} — ${redact(err.message)}`);
    }
  }, { concurrency });

  ledger.close();
  console.log(`\n  pinned          ${num(ok)}${failed ? `,  ${num(failed)} failed` : ""}`);

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

  writeAtomic(`${JSON_DIR}/_metadata.json`, JSON.stringify(collection, null, 2));
  console.log(`  rewritten       ${num(rewritten)} metadata files${missing ? `,  ${num(missing)} had no pin` : ""}`);
  console.log(`\n  Next:  npm run validate    confirm no placeholders remain`);
  console.log(`         then pin build/json/ and set baseUri to that CID\n`);
}

main().catch((e) => fail(e, redact));
