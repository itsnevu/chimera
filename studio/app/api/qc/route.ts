import { NextResponse } from "next/server";
import { startRun, readJson } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const qc = readJson<{
    checked: number;
    verified: number;
    failures: { edition: number; reasons: string[] }[];
  }>("qc.json");
  if (!qc) return NextResponse.json({ checked: 0, verified: 0, failures: [], flagged: {} });

  // Keyed by edition so the proof sheet can mark cells without scanning an
  // array per cell.
  const flagged: Record<number, string[]> = {};
  qc.failures.forEach((f) => { flagged[f.edition] = f.reasons; });
  return NextResponse.json({ ...qc, flagged });
}

export async function POST(req: Request) {
  const { verify, apiKey, twinDistance } = await req.json().catch(() => ({}));
  const args: string[] = [];
  if (twinDistance) args.push("--twin-distance", String(twinDistance));
  if (verify) {
    if (!apiKey) return NextResponse.json({ error: "Trait verification needs an API key." }, { status: 400 });
    args.push("--verify", "--yes");
  }
  try {
    return NextResponse.json(startRun("ai:qc", args, apiKey));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
