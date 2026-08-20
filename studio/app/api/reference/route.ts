import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { startRun, readConfig, REPO_ROOT } from "@/lib/engine";
import { rejectCrossOrigin } from "@/lib/guard";

export const dynamic = "force-dynamic";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * The declared Content-Type of a multipart part is written by the caller, so
 * it says nothing about the bytes. Sniff the real signature before writing —
 * this file is fed to node-canvas's native decoders, and it is the image the
 * entire collection's identity is derived from.
 */
const looksLikeImage = (buf: Buffer) => {
  if (buf.length < 12) return false;
  const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const webp = buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP";
  return png || jpeg || webp;
};

/** Upload the source character image, or drive the style-bible steps. */
export async function POST(req: Request) {
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;

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
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!looksLikeImage(bytes)) {
      return NextResponse.json(
        { error: "That file is not a PNG, JPEG or WebP, whatever its type says." },
        { status: 415 }
      );
    }
    // Write-then-rename: a concurrent ai:ref must never read a half-written
    // reference and normalise a truncated image into the collection master.
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, dest);
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
