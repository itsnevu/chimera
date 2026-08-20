import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { readLedger, readJson, readConfig, getRunState, usdPerQcCall, AI_DIR, REPO_ROOT } from "@/lib/engine";

export const dynamic = "force-dynamic";

type Plan = {
  editionSize: number;
  model: string;
  usdPerImage: number;
  estimatedUSD: number;
  compositeLocally: string[];
  editions: { edition: number; traits: Record<string, string>; prompt: string; seed: number }[];
};

export async function GET() {
  const cfg = readConfig();
  const plan = readJson<Plan>("plan.json");
  const { entries, spentUSD } = readLedger();
  const refState = readJson<{ approvedAt: string | null; masterAt: string | null; spentUSD: number }>(
    path.join("reference", "state.json")
  );

  const masterExists = fs.existsSync(path.join(AI_DIR, "reference", "master.png"));
  const anchorDir = path.join(AI_DIR, "reference", "anchors");
  const anchors = fs.existsSync(anchorDir)
    ? fs.readdirSync(anchorDir).filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/, ""))
    : [];

  const qc = readJson<{ checked: number; failures: { edition: number; reasons: string[] }[] }>("qc.json");

  return NextResponse.json({
    config: { ...cfg, usdPerQcCall: usdPerQcCall() },
    referenceUploaded: fs.existsSync(path.join(REPO_ROOT, cfg.reference.replace(/^\.\//, ""))),
    reference: {
      master: masterExists,
      approved: Boolean(refState?.approvedAt),
      approvedAt: refState?.approvedAt ?? null,
      anchors,
      spentUSD: refState?.spentUSD ?? 0,
    },
    plan: plan
      ? {
          editionSize: plan.editionSize,
          model: plan.model,
          usdPerImage: plan.usdPerImage,
          estimatedUSD: plan.estimatedUSD,
          compositeLocally: plan.compositeLocally,
        }
      : null,
    rendered: entries.length,
    spentUSD,
    qc: qc ? { checked: qc.checked, flagged: qc.failures.length } : null,
    run: getRunState(),
  });
}
