import { NextResponse } from "next/server";
import { startRun, readJson } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** The rolled collection — traits and prompts, for the proof sheet. */
export async function GET() {
  const plan = readJson<{ editions: unknown[] }>("plan.json");
  if (!plan) return NextResponse.json({ editions: [] });
  return NextResponse.json({ editions: plan.editions });
}

export async function POST(req: Request) {
  const { size, model, maxSpend } = await req.json().catch(() => ({}));
  const args: string[] = [];
  if (size) args.push("--size", String(size));
  if (model) args.push("--model", String(model));
  if (maxSpend) args.push("--max-spend", String(maxSpend));

  try {
    // Planning is free and offline — no key, no confirmation needed.
    return NextResponse.json(startRun("ai:plan", args));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
