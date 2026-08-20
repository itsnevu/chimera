import { NextResponse } from "next/server";
import { startRun, getRunState, readLedger, readConfig } from "@/lib/engine";
import { rejectCrossOrigin, boundedNumber } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** Progress comes from the ledger, which is already the engine's own source
 *  of truth for what has been paid for. */
export async function GET() {
  const { entries, spentUSD } = readLedger();
  return NextResponse.json({
    run: getRunState(),
    rendered: entries.length,
    spentUSD,
    latest: entries.slice(-12).map((e) => e.edition),
  });
}

export async function POST(req: Request) {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));
  const { provider, limit, apiKey, maxSpend, confirm } = body as {
    provider?: string;
    limit?: number;
    apiKey?: string;
    maxSpend?: number;
    confirm?: boolean;
  };

  const paid = provider !== "mock";
  if (paid && confirm !== true) {
    return NextResponse.json(
      { error: "A paid run needs explicit confirmation." },
      { status: 400 }
    );
  }
  if (paid && !apiKey) {
    return NextResponse.json({ error: "A paid run needs an API key." }, { status: 400 });
  }

  // `provider` becomes argv, and the CLI matches flags positionally — an
  // unchecked value like "--max-spend" would be read as the next flag.
  if (provider !== undefined && provider !== "mock" && provider !== "openrouter") {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }

  const args: string[] = [];
  if (provider) args.push("--provider", provider);

  const safeLimit = boundedNumber(limit, { min: 1, max: 100000, integer: true });
  if (limit !== undefined && safeLimit === undefined) {
    return NextResponse.json({ error: "limit must be a positive whole number." }, { status: 400 });
  }
  if (safeLimit) args.push("--limit", String(safeLimit));

  // The configured ceiling is documented as hard, so a request may lower it
  // but never raise it. Forwarding the client's number verbatim would let any
  // caller — including a page in another tab — spend past the configured cap.
  const ceiling = readConfig().maxSpendUSD;
  const asked = boundedNumber(maxSpend, { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (maxSpend !== undefined && asked === undefined) {
    return NextResponse.json({ error: "maxSpend must be a number." }, { status: 400 });
  }
  if (asked !== undefined) args.push("--max-spend", String(Math.min(asked, ceiling)));

  if (paid) args.push("--yes");

  try {
    return NextResponse.json(startRun("ai:generate", args, apiKey));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
