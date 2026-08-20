import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { startRun, readConfig, REPO_ROOT } from "@/lib/engine";

export const dynamic = "force-dynamic";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Upload the source character image, or drive the style-bible steps. */
export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";

  // ── file upload ──────────────────────────────────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file supplied." }, { status: 400 });
    }
    if (!ALLOWED.has(file.type)) {
      return NextResponse.json(
        { error: `Unsupported type ${file.type}. Use PNG, JPEG or WebP.` },
        { status: 415 }
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Image is larger than 12 MB." }, { status: 413 });
    }

    const cfg = readConfig();
    // Pin the destination to the configured path — never trust a client-supplied name.
    const dest = path.join(REPO_ROOT, cfg.reference.replace(/^\.\//, ""));
    if (!dest.startsWith(REPO_ROOT)) {
      return NextResponse.json({ error: "Invalid reference path." }, { status: 400 });
    }
    fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ saved: cfg.reference, bytes: file.size });
  }

  // ── style bible actions ──────────────────────────────────────────────────
  const { action, apiKey, provider } = await req.json().catch(() => ({}));

  if (action === "approve") {
    try {
      return NextResponse.json(startRun("ai:ref", ["--approve"]));
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 409 });
    }
  }

  if (action === "master" || action === "anchors") {
    const paid = provider !== "mock";
    if (paid && !apiKey) {
      return NextResponse.json({ error: "Rendering the reference needs an API key." }, { status: 400 });
    }
    const args = action === "anchors" ? ["--anchors"] : [];
    if (provider) args.push("--provider", provider);
    try {
      return NextResponse.json(startRun("ai:ref", args, apiKey));
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 409 });
    }
  }

  return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
}
