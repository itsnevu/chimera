/**
 * The ledger: an append-only record of every edition that actually landed.
 *
 * This is the file that makes a stopped run free to resume. It is written the
 * moment bytes hit disk, one JSON object per line, flushed immediately. If the
 * process dies mid-write the worst case is one truncated final line, which is
 * skipped on read — you re-render one image, not a thousand.
 */
const fs = require("fs");
const path = require("path");

class Ledger {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = null;
  }

  open() {
    this.fd = fs.openSync(this.file, "a");
    return this;
  }

  /** Completed editions, plus what they cost. Tolerates a torn last line. */
  read() {
    if (!fs.existsSync(this.file)) return { done: new Map(), spentUSD: 0, torn: 0 };
    const done = new Map();
    let spentUSD = 0;
    let torn = 0;
    const lines = fs.readFileSync(this.file, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.edition == null) continue;
        done.set(rec.edition, rec);
        spentUSD += rec.costUSD || 0;
      } catch {
        torn++; // truncated tail from a hard kill — expected, not fatal
      }
    }
    return { done, spentUSD, torn };
  }

  append(record) {
    if (!this.fd) this.open();
    fs.writeSync(this.fd, JSON.stringify(record) + "\n");
    fs.fsyncSync(this.fd); // survive a kill -9, not just a clean exit
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

/** Write-then-rename, so a reader never sees a half-written file. */
const writeAtomic = (file, data) => {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};

module.exports = { Ledger, writeAtomic };
