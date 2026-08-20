import { NextResponse } from "next/server";
import { startRun, readJson } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const qc = readJson<{
    checked: number;
    verified: number;
    failures: { edition: number; reasons: string[] }[];
  }>("qc.json");
  return NextResponse.json(qc ?? { checked: 0, verified: 0, failures: [] });
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
