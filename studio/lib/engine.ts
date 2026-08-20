/**
 * Bridge to the Chimera engine.
 *
 * The engine is a Node CLI in the parent directory that resolves everything
 * from process.cwd(). Rather than requiring its modules into Next's runtime —
 * where cwd would be studio/ and every path would be wrong — we spawn the same
 * npm scripts a human would run, with cwd pinned to the repo root.
 *
 * That keeps one code path: whatever the UI does, you could have typed.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export const REPO_ROOT = path.resolve(process.cwd(), "..");
export const AI_DIR = path.join(REPO_ROOT, "build", "ai");

export type RunState = {
  running: boolean;
  script: string | null;
  startedAt: number | null;
  log: string[];
  exitCode: number | null;
  error: string | null;
};

/**
 * One run at a time, deliberately. Two concurrent generates would both append
 * to the same ledger and double-bill the overlap.
 */
const state: RunState = {
  running: false,
  script: null,
  startedAt: null,
  log: [],
  exitCode: null,
  error: null,
};

const MAX_LOG = 400;

/** Strip anything key-shaped before it reaches a browser. */
export const redact = (text: string) =>
  text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***");

export function getRunState(): RunState {
  return { ...state, log: [...state.log] };
}

export function startRun(script: string, args: string[] = [], apiKey?: string) {
  if (state.running) {
    throw new Error(`"${state.script}" is still running — wait for it to finish`);
  }

  state.running = true;
  state.script = script;
  state.startedAt = Date.now();
  state.log = [];
  state.exitCode = null;
  state.error = null;

  const env = { ...process.env };
  // The key lives in this process only. It is never written to disk, never
  // returned to the browser, and is stripped from every log line below.
  if (apiKey) env.OPENROUTER_API_KEY = apiKey;

  const child = spawn("npm", ["run", script, "--silent", "--", ...args], {
    cwd: REPO_ROOT,
    env,
  });

  const push = (chunk: Buffer) => {
    redact(chunk.toString())
      .split("\n")
      .filter((l) => l.trim())
      .forEach((line) => {
        state.log.push(line);
        if (state.log.length > MAX_LOG) state.log.shift();
      });
  };

  child.stdout.on("data", push);
  child.stderr.on("data", push);

  child.on("error", (err) => {
    state.error = redact(err.message);
    state.running = false;
  });
  child.on("close", (code) => {
    state.exitCode = code;
    state.running = false;
  });

  return { script, startedAt: state.startedAt };
}

// ── reading engine state ────────────────────────────────────────────────────

export type LedgerEntry = {
  edition: number;
  traits: Record<string, string>;
  costUSD: number;
  file: string;
};

export function readLedger(): { entries: LedgerEntry[]; spentUSD: number } {
  const file = path.join(AI_DIR, "ledger.jsonl");
  if (!fs.existsSync(file)) return { entries: [], spentUSD: 0 };

  const entries: LedgerEntry[] = [];
  let spentUSD = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.edition == null) continue;
      entries.push(rec);
      spentUSD += rec.costUSD || 0;
    } catch {
      // torn final line from a killed run — the engine tolerates it, so do we
    }
  }
  return { entries, spentUSD };
}

export function readJson<T>(file: string): T | null {
  const full = path.join(AI_DIR, file);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readConfig() {
  // Parsed rather than required: importing the CommonJS config into Next's
  // module graph would resolve its own requires against the wrong cwd.
  const file = path.join(REPO_ROOT, "src", "ai.config.js");
  const text = fs.readFileSync(file, "utf8");
  const pick = (key: string) => {
    const m = text.match(new RegExp(`${key}:\\s*([0-9.]+|"[^"]*")`));
    if (!m) return null;
    return m[1].startsWith('"') ? m[1].slice(1, -1) : Number(m[1]);
  };
  return {
    editionSize: (pick("editionSize") as number) ?? 1000,
    model: (pick("model") as string) ?? "",
    provider: (pick("provider") as string) ?? "",
    maxSpendUSD: (pick("maxSpendUSD") as number) ?? 0,
    rerollAllowance: (pick("rerollAllowance") as number) ?? 0.15,
    concurrency: (pick("concurrency") as number) ?? 4,
    reference: (pick("reference") as string) ?? "./reference.png",
  };
}
