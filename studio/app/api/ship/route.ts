import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { startRun, REPO_ROOT } from "@/lib/engine";
import { rejectCrossOrigin } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** Whether there is anything to ship, and whether it has been pinned. */
export async function GET() {
  const metadata = path.join(REPO_ROOT, "build", "json", "_metadata.json");
  const pins = path.join(REPO_ROOT, "build", "ai", "pins.jsonl");

  let editions = 0;
  let placeholders = 0;
  if (fs.existsSync(metadata)) {
    try {
      const data = JSON.parse(fs.readFileSync(metadata, "utf8"));
      editions = data.length;
      placeholders = data.filter(
        (m: { image?: string; description?: string }) =>
          /NewUriToReplace/.test(m.image ?? "") || /Remember to replace/i.test(m.description ?? "")
      ).length;
    } catch {
      // a half-written file during finalize — report nothing rather than guess
    }
  }

  const pinned = fs.existsSync(pins)
    ? fs.readFileSync(pins, "utf8").split("\n").filter((l) => l.trim()).length
    : 0;

  return NextResponse.json({ editions, placeholders, pinned });
}

/**
 * doctor and validate are free and read-only. publish spends nothing on a dry
 * run and is irreversible with --yes, so it needs both a JWT and confirmation.
 */
export async function POST(req: Request) {
  // This is the only route whose actions are irreversible, and it was the one
  // route left without an origin check.
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;

  const { action, jwt, confirm } = await req.json().catch(() => ({}));

  try {
    if (action === "doctor") return NextResponse.json(startRun("ai:doctor"));
    if (action === "validate") return NextResponse.json(startRun("validate"));

    if (action === "publish") {
      if (confirm !== true) return NextResponse.json(startRun("ai:publish")); // dry run
      if (typeof jwt !== "string" || !jwt.trim()) {
        return NextResponse.json({ error: "Pinning needs a Pinata JWT." }, { status: 400 });
      }

      // Restore whatever was there before, rather than deleting conditionally.
      // The previous form only cleaned up when no prior value existed — which
      // was never true — so a JWT pasted once into the browser silently became
      // the credential for every later run in this server process.
      const had = Object.prototype.hasOwnProperty.call(process.env, "PINATA_JWT");
      const prev = process.env.PINATA_JWT;
      process.env.PINATA_JWT = jwt;
      try {
        return NextResponse.json(startRun("ai:publish", ["--yes"]));
      } finally {
        if (had) process.env.PINATA_JWT = prev;
        else delete process.env.PINATA_JWT;
      }
    }

    return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
