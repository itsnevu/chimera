"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Label, Row, Stage, money, num } from "./components/ui";
import { ProofSheet, type Edition } from "./components/ProofSheet";
import { Progress } from "./components/Progress";
import { TraitEditor } from "./components/TraitEditor";

type Status = {
  config: {
    editionSize: number; model: string; provider: string;
    maxSpendUSD: number; rerollAllowance: number; concurrency: number; reference: string;
  };
  referenceUploaded: boolean;
  reference: { master: boolean; approved: boolean; anchors: string[]; spentUSD: number };
  plan: { editionSize: number; model: string; usdPerImage: number; estimatedUSD: number } | null;
  rendered: number;
  spentUSD: number;
  qc: { checked: number; flagged: number } | null;
  run: { running: boolean; script: string | null; log: string[]; exitCode: number | null };
};

/** A destructive or paid action, held until the user explicitly acknowledges it. */
type Confirmation = {
  title: string;
  lines: [string, string][];
  body: string;
  cta: string;
  run: () => void;
};

const POLL_IDLE = 2500;
const POLL_ACTIVE = 700;

export default function Studio() {
  const [status, setStatus] = useState<Status | null>(null);
  const [editions, setEditions] = useState<Edition[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [size, setSize] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [mock, setMock] = useState(true);
  const [flagged, setFlagged] = useState<Record<number, string[]>>({});
  const [showTraits, setShowTraits] = useState(false);
  const [pending, setPending] = useState<Confirmation | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // Seeding the size field is a one-shot: re-seeding on every poll would
  // overwrite whatever the user is in the middle of typing.
  const sizeSeeded = useRef(false);
  // Status requests overlap (interval + post + upload), so an older response
  // must never be allowed to land on top of a newer one.
  const statusSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++statusSeq.current;
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      if (!r.ok) {
        if (seq === statusSeq.current) setError(`Engine status unavailable (${r.status})`);
        return;
      }
      const s: Status = await r.json();
      if (seq !== statusSeq.current) return; // a newer request already answered
      setStatus(s);
      if (!sizeSeeded.current) {
        sizeSeeded.current = true;
        setSize(s.config.editionSize);
      }
    } catch {
      if (seq === statusSeq.current) setError("Cannot reach the engine. Is the dev server still running?");
    }
  }, []);

  // Poll faster while something is running; idle polling stays cheap.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, status?.run.running ? POLL_ACTIVE : POLL_IDLE);
    return () => clearInterval(id);
  }, [refresh, status?.run.running]);

  // Pull the rolled collection once a plan exists, and again after each run.
  useEffect(() => {
    if (!status?.plan) return;
    const ac = new AbortController();
    fetch("/api/plan", { cache: "no-store", signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`plan unavailable (${r.status})`);
        return r.json();
      })
      .then((d) => setEditions(d.editions ?? []))
      .catch((e: Error) => {
        // Swallowing this would render a fully-planned collection as the
        // "nothing rolled yet" empty state, inviting a destructive re-roll.
        if (e.name !== "AbortError") setError("Could not load the rolled collection — it may still exist on disk.");
      });
    return () => ac.abort();
  }, [status?.plan, status?.run.exitCode]);

  // Keyed on the last line, not the count: the engine caps the buffer at 400
  // lines, so length stops changing exactly when the run gets interesting.
  const lastLogLine = status?.run.log[status.run.log.length - 1];
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lastLogLine]);

  const post = async (url: string, body: unknown) => {
    setError(null);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
    } catch (e) {
      setError(`Could not reach the engine: ${(e as Error).message}`);
    }
    refresh();
  };

  const upload = async (file: File) => {
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/reference", { method: "POST", body: fd });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Upload failed");
    } catch (e) {
      setError(`Upload failed: ${(e as Error).message}`);
    }
    refresh();
  };

  if (!status) {
    return (
      <main style={{ padding: 40 }}>
        <span className="mono" style={{ color: "var(--ink-3)", fontSize: 12 }}>
          {error ?? "Reading engine state…"}
        </span>
      </main>
    );
  }

  const { config, reference, plan, run } = status;
  const busy = run.running;
  const provider = mock ? "mock" : "openrouter";
  const paid = !mock;
  const unit = plan?.usdPerImage ?? 0;
  const remaining = Math.max(0, (plan?.editionSize ?? 0) - status.rendered);
  const projected = paid ? remaining * unit : 0;
  const overCeiling = status.spentUSD + projected > config.maxSpendUSD;

  const blockedReason = !plan
    ? "Roll a collection first — that step is free and offline."
    : remaining === 0
      ? "Every planned edition is already rendered."
      : paid && !apiKey
        ? "Paid mode needs an OpenRouter API key."
        : paid && !reference.approved
          ? "Approve a master reference first, so every edition is rendered against it."
          : paid && overCeiling
            ? "This run would pass your spend ceiling."
            : null;

  const smokeCount = Math.min(5, remaining);
  const smokeCost = paid ? smokeCount * unit : 0;
  const qcUnit = plan?.usdPerImage ?? 0;
  const qcCost = status.rendered * qcUnit;

  // Nothing that costs money or destroys work may be dispatched straight from a
  // click. `confirm: true` is only ever produced inside one of these callbacks,
  // which run after the user has seen the totals and acknowledged them.
  const confirmPaidRun = (limit?: number) => {
    const count = limit ?? remaining;
    const cost = paid ? count * unit : 0;
    const send = () => post("/api/generate", { provider, apiKey, ...(limit ? { limit } : {}), confirm: true });
    if (!paid) return send();
    setPending({
      title: limit ? "Spend real money on a smoke test?" : "Spend real money on this run?",
      lines: [
        ["editions", num(count)],
        ["model", plan?.model.split("/").pop() ?? "—"],
        ["per image", `$${unit.toFixed(3)}`],
        ["this run", money(cost)],
        ["already spent", money(status.spentUSD)],
        ["ceiling", money(config.maxSpendUSD)],
      ],
      body:
        "Billing starts immediately and each rendered image is charged whether or not you keep it. " +
        "You can stop the run, but you cannot refund what it has already spent.",
      cta: `SPEND ${money(cost)}`,
      run: send,
    });
  };

  const confirmReroll = () => {
    const send = () => post("/api/plan", { size });
    // Re-rolling rewrites the only mapping from edition number to traits, so
    // any edition already paid for would end up describing art it isn't.
    if (status.rendered === 0) return send();
    setPending({
      title: "Re-roll and invalidate paid renders?",
      lines: [
        ["already rendered", num(status.rendered)],
        ["already spent", money(status.spentUSD)],
        ["new edition size", num(typeof size === "number" ? size : config.editionSize)],
      ],
      body:
        `Re-rolling assigns new traits and prompts to every edition number. The ${num(status.rendered)} ` +
        `image${status.rendered === 1 ? "" : "s"} you have already paid for would stay on disk but would no ` +
        "longer match their metadata. This cannot be undone.",
      cta: "RE-ROLL ANYWAY",
      run: send,
    });
  };

  const confirmVerify = () => {
    setPending({
      title: "Spend real money on trait verification?",
      lines: [
        ["images to check", num(status.rendered)],
        ["per image", `~$${qcUnit.toFixed(3)}`],
        ["this run", `~${money(qcCost)}`],
        ["already spent", money(status.spentUSD)],
        ["ceiling", money(config.maxSpendUSD)],
      ],
      body:
        "Every rendered image is sent to a vision model, one paid call each. The estimate assumes one " +
        "call per image; retries on unparseable answers cost extra.",
      cta: `SPEND ~${money(qcCost)}`,
      run: () => post("/api/qc", { verify: true, apiKey, confirm: true }),
    });
  };

  const stage = (want: string): "done" | "active" | "blocked" | "idle" => {
    if (want === "ref") {
      if (reference.approved) return "done";
      if (reference.master) return "blocked";
      return status.referenceUploaded ? "active" : "idle";
    }
    if (want === "plan") return plan ? "done" : reference.approved ? "active" : "idle";
    if (want === "gen") {
      if (!plan) return "idle";
      if (status.rendered >= plan.editionSize) return "done";
      return status.rendered > 0 ? "active" : "idle";
    }
    return status.qc ? "done" : "idle";
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "398px minmax(0,1fr)", minHeight: "100vh" }}>
      {/* ───────────────────────── control column ───────────────────────── */}
      <aside style={{ borderRight: "1px solid var(--rule)", position: "sticky", top: 0, alignSelf: "start", maxHeight: "100vh", overflowY: "auto" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 18px", borderBottom: "1px solid var(--rule)" }}>
          <span style={{ width: 9, height: 9, background: "var(--ember)" }} />
          <span className="mono" style={{ fontWeight: 800, fontSize: 13, letterSpacing: "-0.06em" }}>
            CHIMERA STUDIO
          </span>
        </header>

        {/* 01 — reference */}
        <Stage n={1} title="STYLE REFERENCE" state={stage("ref")}>
          <label
            style={{
              display: "flex", alignItems: "center", gap: 13, padding: 11, cursor: "pointer",
              background: "var(--pane)", border: "1px dashed var(--rule-2)",
            }}
          >
            <input
              type="file" accept="image/png,image/jpeg,image/webp" hidden
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
            <span style={{ width: 46, height: 46, flex: "none", background: "var(--pane-2)", display: "grid", placeItems: "center", overflow: "hidden" }}>
              {reference.master ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src="/api/image/master" alt="Approved master reference" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <span className="mono" style={{ fontSize: 9, color: "var(--ink-3)" }}>IMG</span>
              )}
            </span>
            <span style={{ minWidth: 0 }}>
              <strong style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>
                {status.referenceUploaded ? config.reference : "Drop your character"}
              </strong>
              <small style={{ display: "block", fontSize: 11.5, color: "var(--ink-3)" }}>
                {reference.approved ? "Master approved — style locked" : "PNG, JPEG or WebP"}
              </small>
            </span>
          </label>

          {status.referenceUploaded && !reference.approved && (
            <div style={{ display: "flex", gap: 6, marginTop: 11, flexWrap: "wrap" }}>
              <Button disabled={busy} onClick={() => post("/api/reference", { action: "master", provider, apiKey })}>
                {reference.master ? "RE-RENDER MASTER" : "RENDER MASTER"}
              </Button>
              {reference.master && (
                <Button tone="solid" disabled={busy} onClick={() => post("/api/reference", { action: "approve" })}>
                  APPROVE
                </Button>
              )}
            </div>
          )}

          {reference.master && !reference.approved && (
            <p style={{ marginTop: 11, fontSize: 11.5, lineHeight: 1.5, color: "var(--warn)" }}>
              Look at the master before approving. Every edition you pay for is rendered
              against it — if the character is wrong here, all {num(config.editionSize)} will be.
            </p>
          )}

          {reference.approved && (
            <div style={{ marginTop: 11, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Button disabled={busy} onClick={() => post("/api/reference", { action: "anchors", provider, apiKey })}>
                {reference.anchors.length ? `ANCHORS · ${reference.anchors.length}` : "ADD ANCHORS"}
              </Button>
              <Button disabled={busy} onClick={() => post("/api/reference", { action: "master", provider, apiKey })}>
                RE-RENDER
              </Button>
            </div>
          )}
        </Stage>

        {/* 02 — plan */}
        <Stage n={2} title="PLAN — FREE, OFFLINE" state={stage("plan")}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
            <input
              type="number" min={1} max={10000} value={size}
              onChange={(e) => setSize(e.target.value === "" ? "" : Number(e.target.value))}
              aria-label="Edition size"
              className="mono"
              style={{
                width: "100%", minWidth: 0, background: "none", border: "none", padding: 0,
                color: "var(--ink)", fontWeight: 800, fontSize: 38, letterSpacing: "-0.07em",
              }}
            />
            <span style={{ fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>editions</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <Button full disabled={busy} onClick={confirmReroll}>
              {plan ? "RE-ROLL COLLECTION" : "ROLL COLLECTION"}
            </Button>
          </div>
          {plan && status.rendered > 0 && (
            <p style={{ marginTop: 9, fontSize: 11.5, color: "var(--warn)", lineHeight: 1.5 }}>
              Re-rolling reassigns traits to every edition number — the {num(status.rendered)} image
              {status.rendered === 1 ? "" : "s"} you have already paid for would no longer match their metadata.
            </p>
          )}
          {plan && (
            <div style={{ marginTop: 12 }}>
              <Row k="model" v={plan.model.split("/").pop() ?? plan.model} />
              <Row k="per image" v={`$${plan.usdPerImage.toFixed(3)}`} />
              <Row k="estimate" v={money(plan.estimatedUSD)} accent="var(--ember)" />
            </div>
          )}

          <div style={{ marginTop: 12, borderTop: "1px solid var(--rule)", paddingTop: 12 }}>
            <button
              onClick={() => setShowTraits((v) => !v)}
              className="mono"
              style={{ background: "none", border: "none", padding: 0, fontSize: 10, letterSpacing: "0.06em", color: "var(--ink-3)" }}
            >
              {showTraits ? "− HIDE TRAIT WEIGHTS" : "+ EDIT TRAIT WEIGHTS"}
            </button>
            {showTraits && (
              <div style={{ marginTop: 10 }}>
                <TraitEditor disabled={busy} onSaved={refresh} />
              </div>
            )}
          </div>
        </Stage>

        {/* 03 — generate */}
        <Stage n={3} title="GENERATE" state={stage("gen")}>
          <div style={{ display: "flex", border: "1px solid var(--rule-2)", marginBottom: 12 }}>
            {[
              { id: true, label: "MOCK · FREE" },
              { id: false, label: "OPENROUTER · PAID" },
            ].map((opt) => (
              <button
                key={String(opt.id)}
                onClick={() => setMock(opt.id)}
                style={{
                  flex: 1, border: "none", padding: "7px 0",
                  fontFamily: "var(--font-mono)", fontSize: 10,
                  background: mock === opt.id ? "var(--ember)" : "transparent",
                  color: mock === opt.id ? "var(--void)" : "var(--ink-3)",
                  fontWeight: mock === opt.id ? 600 : 400,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {paid && (
            <input
              type="password"
              placeholder="sk-or-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              aria-label="OpenRouter API key"
              className="mono"
              style={{
                width: "100%", background: "var(--pane)", border: "1px solid var(--rule-2)",
                color: "var(--ink)", padding: "9px 11px", fontSize: 11, marginBottom: 11,
              }}
            />
          )}
          {paid && (
            <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--ink-3)", marginBottom: 11 }}>
              Your key is held in the server process for this run only. It is never written
              to disk and is stripped from every log line.
            </p>
          )}

          <Row k="rendered" v={`${num(status.rendered)} / ${num(plan?.editionSize ?? 0)}`} />
          <Row k="spent" v={money(status.spentUSD)} />
          {paid && <Row k="this run" v={money(projected)} accent={overCeiling ? "var(--warn)" : undefined} />}
          <Row k="ceiling" v={money(config.maxSpendUSD)} />

          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            <Button
              tone="solid"
              disabled={busy || !plan || (paid && (!apiKey || overCeiling || !reference.approved)) || remaining === 0}
              onClick={() => confirmPaidRun()}
            >
              {status.rendered > 0 && remaining > 0 ? `RESUME · ${num(remaining)}` : `RUN · ${num(remaining)}`}
            </Button>
            <Button
              // Smoke spends real money too, so it carries the same gates as RUN.
              disabled={busy || !plan || smokeCount === 0 || (paid && (!apiKey || !reference.approved || status.spentUSD + smokeCost > config.maxSpendUSD))}
              onClick={() => confirmPaidRun(smokeCount)}
            >
              {paid ? `SMOKE · ${smokeCount} · ${money(smokeCost)}` : `SMOKE · ${smokeCount}`}
            </Button>
          </div>

          {/* The reason an action is blocked must be readable without hovering a
              disabled control, which is not focusable and has no tooltip on touch. */}
          {blockedReason && (
            <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.5 }}>{blockedReason}</p>
          )}

          {plan && (
            <div style={{ margin: "12px -18px 0" }}>
              <Progress
                done={status.rendered}
                total={plan.editionSize}
                spent={status.spentUSD}
                ceiling={config.maxSpendUSD}
                running={busy}
              />
            </div>
          )}

          {paid && overCeiling && (
            <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--warn)", lineHeight: 1.5 }}>
              This run would reach {money(status.spentUSD + projected)}, past your{" "}
              {money(config.maxSpendUSD)} ceiling. Raise maxSpendUSD in src/ai.config.js
              deliberately, or render fewer.
            </p>
          )}
          {paid && !reference.approved && (
            <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--warn)", lineHeight: 1.5 }}>
              No approved reference — every edition would be rendered from the prompt alone,
              with nothing holding the character consistent.
            </p>
          )}
        </Stage>

        {/* 04 — QC */}
        <Stage n={4} title="QUALITY CONTROL" state={stage("qc")}>
          {status.qc && (
            <>
              <Row k="checked" v={num(status.qc.checked)} />
              <Row
                k="flagged"
                v={num(status.qc.flagged)}
                accent={status.qc.flagged ? "var(--warn)" : "var(--good)"}
              />
              {status.qc.flagged > 0 && (
                <p style={{ marginTop: 8, fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5 }}>
                  Flagged editions carry an amber corner in the proof sheet. Hover one for
                  the reason.
                </p>
              )}
            </>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: status.qc ? 12 : 0, flexWrap: "wrap" }}>
            <Button disabled={busy || status.rendered === 0} onClick={() => post("/api/qc", {})}>
              SCAN · FREE
            </Button>
            <Button
              disabled={busy || status.rendered === 0 || !apiKey}
              onClick={confirmVerify}
            >
              {`VERIFY TRAITS · ~${money(qcCost)}`}
            </Button>
          </div>
          {status.rendered > 0 && !apiKey && (
            <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
              Trait verification needs an OpenRouter API key — enter it in step 03.
            </p>
          )}
        </Stage>

        {error && (
          <div style={{ padding: 18, borderBottom: "1px solid var(--rule)" }}>
            <p style={{ fontSize: 11.5, color: "var(--warn)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{error}</p>
          </div>
        )}
      </aside>

      {/* ───────────────────────── proof sheet ───────────────────────── */}
      <main style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 18px", borderBottom: "1px solid var(--rule)", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: 13 }}>PROOF SHEET</h1>
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            {num(status.rendered)} RENDERED · {num(editions.length)} PLANNED · {money(status.spentUSD)} SPENT
          </span>
          {busy && (
            <span className="mono" style={{ fontSize: 10, color: "var(--ember)", marginLeft: "auto" }}>
              {run.script} RUNNING…
            </span>
          )}
        </div>

        {editions.length === 0 ? (
          <p style={{ padding: 18, fontSize: 12.5, color: "var(--ink-3)" }}>
            Nothing rolled yet. Plan a collection to see it here — that step is free and offline.
          </p>
        ) : (
          <ProofSheet
            editions={editions}
            rendered={status.rendered}
            flagged={flagged}
            selected={selected}
            onSelect={setSelected}
          />
        )}

        {/* inspector */}
        {selected !== null && (() => {
          const e = editions.find((x) => x.edition === selected);
          if (!e) return null;
          return (
            <div style={{ borderTop: "1px solid var(--rule)", display: "grid", gridTemplateColumns: "1fr 1fr" }}>
              <div style={{ padding: 18, borderRight: "1px solid var(--rule)" }}>
                <h2 style={{ fontSize: 22, marginBottom: 14 }}>#{String(e.edition).padStart(4, "0")}</h2>
                {Object.entries(e.traits).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", gap: 11, padding: "6px 0", borderBottom: "1px solid var(--rule)", fontSize: 13 }}>
                    <span className="mono" style={{ width: 78, flex: "none", fontSize: 9.5, color: "var(--ink-3)" }}>{k}</span>
                    <span style={{ fontWeight: 500 }}>{v}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: 18 }}>
                <Label>Prompt sent to the model</Label>
                <div className="mono" style={{ background: "var(--pane)", border: "1px solid var(--rule)", padding: 14, fontSize: 11.5, lineHeight: 1.9, color: "var(--ink-2)", wordBreak: "break-word" }}>
                  {e.prompt}
                </div>
                <p className="mono" style={{ marginTop: 9, fontSize: 10, color: "var(--ink-3)" }}>
                  seed {e.seed}
                </p>
              </div>
            </div>
          );
        })()}

        {/* engine log */}
        {run.log.length > 0 && (
          <div style={{ borderTop: "1px solid var(--rule)" }}>
            <div style={{ padding: "13px 18px", borderBottom: "1px solid var(--rule)", display: "flex", gap: 12, alignItems: "baseline" }}>
              <h2 style={{ fontSize: 12 }}>ENGINE LOG</h2>
              <span className="mono" style={{ fontSize: 10, color: run.exitCode === 0 ? "var(--good)" : run.exitCode ? "var(--warn)" : "var(--ink-3)" }}>
                {busy ? "running" : run.exitCode === 0 ? "finished cleanly" : `exit ${run.exitCode}`}
              </span>
            </div>
            <div ref={logRef} className="mono" style={{ maxHeight: 260, overflowY: "auto", padding: 18, fontSize: 11, lineHeight: 1.75, color: "var(--ink-2)", background: "var(--pane)", whiteSpace: "pre-wrap" }}>
              {run.log.join("\n")}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
