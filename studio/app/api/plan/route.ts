import { NextResponse } from "next/server";
import { startRun, readJson, readConfig } from "@/lib/engine";
import { rejectCrossOrigin, boundedNumber } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** The rolled collection — traits and prompts, for the proof sheet. */
export async function GET() {
  const plan = readJson<{ editions: unknown[] }>("plan.json");
  if (!plan) return NextResponse.json({ editions: [] });
  return NextResponse.json({ editions: plan.editions });
}

export async function POST(req: Request) {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;

  const { size, model, maxSpend } = await req.json().catch(() => ({}));
  const args: string[] = [];

  // Planning is free, but it overwrites plan.json — the only mapping from
  // edition number to traits, including for editions already paid for. An
  // unbounded size also drives a roll loop of size * 200 attempts.
  const safeSize = boundedNumber(size, { min: 1, max: 100000, integer: true });
  if (size !== undefined && safeSize === undefined) {
    return NextResponse.json(
      { error: "size must be a whole number between 1 and 100000." },
      { status: 400 }
    );
  }
  if (safeSize) args.push("--size", String(safeSize));

  // Model ids are matched positionally by the CLI, so anything starting with
  // "--" would be read as a flag rather than a value.
  if (model !== undefined) {
    if (typeof model !== "string" || model.startsWith("--") || !/^[\w.\-]+\/[\w.\-]+$/.test(model)) {
      return NextResponse.json({ error: "Invalid model id." }, { status: 400 });
    }
    args.push("--model", model);
  }

  const ceiling = readConfig().maxSpendUSD;
  const asked = boundedNumber(maxSpend, { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (asked !== undefined) args.push("--max-spend", String(Math.min(asked, ceiling)));

  try {
    // Planning is free and offline — no key, no confirmation needed.
    return NextResponse.json(startRun("ai:plan", args));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
