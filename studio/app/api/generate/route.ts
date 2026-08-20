import { NextResponse } from "next/server";
import { startRun, getRunState, readLedger } from "@/lib/engine";

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
  const body = await req.json().catch(() => ({}));
  const { provider, limit, apiKey, maxSpend, confirm } = body as {
    provider?: string;
    limit?: number;
    apiKey?: string;
    maxSpend?: number;
    confirm?: boolean;
  };

  const paid = provider !== "mock";
  if (paid && !confirm) {
    return NextResponse.json(
      { error: "A paid run needs explicit confirmation." },
      { status: 400 }
    );
  }
  if (paid && !apiKey) {
    return NextResponse.json({ error: "A paid run needs an API key." }, { status: 400 });
  }

  const args: string[] = [];
  if (provider) args.push("--provider", provider);
  if (limit) args.push("--limit", String(limit));
  if (maxSpend) args.push("--max-spend", String(maxSpend));
  if (paid) args.push("--yes");

  try {
    return NextResponse.json(startRun("ai:generate", args, apiKey));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
