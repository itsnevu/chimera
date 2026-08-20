import { NextResponse } from "next/server";
import { startRun, readJson, readConfig } from "@/lib/engine";
import { rejectCrossOrigin, boundedNumber } from "@/lib/guard";

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
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;

  const { verify, apiKey, twinDistance, confirm } = await req.json().catch(() => ({}));
  const args: string[] = [];

  // Coerced, not stringified: the CLI reads flags positionally, so a
  // twinDistance of "--verify" would appear as a flag and switch on the paid
  // tier without ever passing the API-key check below.
  const distance = boundedNumber(twinDistance, { min: 0, max: 64, integer: true });
  if (twinDistance !== undefined && distance === undefined) {
    return NextResponse.json(
      { error: "twinDistance must be a whole number between 0 and 64." },
      { status: 400 }
    );
  }
  if (distance !== undefined) args.push("--twin-distance", String(distance));

  if (verify) {
    if (!apiKey) return NextResponse.json({ error: "Trait verification needs an API key." }, { status: 400 });
    // Verification is billed per rendered image, so it gets the same explicit
    // confirmation a paid render run does rather than an auto-supplied --yes.
    if (confirm !== true) {
      return NextResponse.json(
        { error: "Trait verification spends money and needs explicit confirmation." },
        { status: 400 }
      );
    }
    args.push("--verify", "--yes");
    // Keep QC under the configured ceiling; the CLI would otherwise use its
    // own default and spend a second full budget on top of the render spend.
    args.push("--max-spend", String(readConfig().maxSpendUSD));
  }
  try {
    return NextResponse.json(startRun("ai:qc", args, apiKey));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
