import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@/lib/engine";

export const dynamic = "force-dynamic";

const OVERRIDES = path.join(REPO_ROOT, "chimera.overrides.json");

type Option = { value: string; weight: number; prompt?: string | null; hex?: string };
type Trait = { name: string; options: Option[] };

/**
 * Read the trait config by spawning node in the repo root. Importing it here
 * would resolve its own fs paths against studio/ and silently miss the
 * overrides file.
 */
function readTraits(): { traits: Trait[]; hasOverrides: boolean } {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const out = execFileSync(
    process.execPath,
    ["-e", "const c=require('./chimera.traits.js');process.stdout.write(JSON.stringify({traits:c.traits,hasOverrides:c.hasOverrides}))"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  return JSON.parse(out);
}

export async function GET() {
  try {
    const { traits, hasOverrides } = readTraits();
    const overrides = fs.existsSync(OVERRIDES)
      ? JSON.parse(fs.readFileSync(OVERRIDES, "utf8"))
      : {};
    const space = traits.reduce((acc, t) => acc * t.options.length, 1);
    return NextResponse.json({ traits, hasOverrides, overrides, combinations: space });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * Weights only, and into a separate file. Rewriting chimera.traits.js would
 * mean regexing a commented JS source — a good way to destroy someone's
 * configuration. Deleting the overrides file restores the original exactly.
 */
export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a JSON object." }, { status: 400 });
  }

  const { overrides, reset } = body as {
    overrides?: Record<string, Record<string, number>>;
    reset?: boolean;
  };

  if (reset) {
    if (fs.existsSync(OVERRIDES)) fs.unlinkSync(OVERRIDES);
    return NextResponse.json({ reset: true });
  }

  if (!overrides) return NextResponse.json({ error: "No overrides supplied." }, { status: 400 });

  // Validate against the real trait names — a typo'd key would silently do
  // nothing, which is worse than an error.
  const { traits } = readTraits();
  const known = new Map(traits.map((t) => [t.name, new Set(t.options.map((o) => o.value))]));
  const clean: Record<string, Record<string, number>> = {};

  for (const [traitName, values] of Object.entries(overrides)) {
    const valid = known.get(traitName);
    if (!valid) {
      return NextResponse.json({ error: `Unknown trait "${traitName}".` }, { status: 400 });
    }
    for (const [value, weight] of Object.entries(values)) {
      if (!valid.has(value)) {
        return NextResponse.json({ error: `Unknown value "${value}" for ${traitName}.` }, { status: 400 });
      }
      if (!Number.isFinite(weight) || weight <= 0 || weight > 100000) {
        return NextResponse.json(
          { error: `Weight for ${traitName}/${value} must be a positive number.` },
          { status: 400 }
        );
      }
      clean[traitName] = clean[traitName] ?? {};
      clean[traitName][value] = weight;
    }
  }

  fs.writeFileSync(OVERRIDES, JSON.stringify(clean, null, 2) + "\n");
  return NextResponse.json({ saved: Object.keys(clean).length });
}
