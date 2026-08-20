import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, AI_DIR } from "@/lib/engine";

export const dynamic = "force-dynamic";

/**
 * Serve a rendered image. Ids are constrained to a known vocabulary so a
 * crafted id cannot walk out of the build directory.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  let file: string | null = null;

  if (/^\d+$/.test(id)) {
    file = path.join(REPO_ROOT, "build", "images", `${id}.png`);
  } else if (/^raw-\d+$/.test(id)) {
    const n = id.slice(4).padStart(5, "0");
    file = path.join(AI_DIR, "raw", `${n}.png`);
  } else if (id === "master") {
    file = path.join(AI_DIR, "reference", "master.png");
  } else if (id === "base") {
    file = path.join(AI_DIR, "reference", "base.png");
  } else if (/^anchor-[a-z]+$/.test(id)) {
    file = path.join(AI_DIR, "reference", "anchors", `${id.slice(7)}.png`);
  }

  if (!file) return new NextResponse("Not found", { status: 404 });

  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(REPO_ROOT))) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  if (!fs.existsSync(resolved)) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(fs.readFileSync(resolved)), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
