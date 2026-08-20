import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { startRun, REPO_ROOT } from "@/lib/engine";

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
  const { action, jwt, confirm } = await req.json().catch(() => ({}));

  try {
    if (action === "doctor") return NextResponse.json(startRun("ai:doctor"));
    if (action === "validate") return NextResponse.json(startRun("validate"));

    if (action === "publish") {
      if (!confirm) return NextResponse.json(startRun("ai:publish")); // dry run
      if (!jwt) {
        return NextResponse.json({ error: "Pinning needs a Pinata JWT." }, { status: 400 });
      }
      const env = { ...process.env, PINATA_JWT: jwt };
      // startRun takes an OpenRouter key; publish reads PINATA_JWT, so pass it
      // through the same one-run-only channel.
      process.env.PINATA_JWT = jwt;
      try {
        return NextResponse.json(startRun("ai:publish", ["--yes"]));
      } finally {
        if (env.PINATA_JWT === undefined) delete process.env.PINATA_JWT;
      }
    }

    return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
