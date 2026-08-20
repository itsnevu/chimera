"use client";

/** Progress from the ledger, not from parsing stdout. */
export function Progress({
  done, total, spent, ceiling, running,
}: {
  done: number; total: number; spent: number; ceiling: number; running: boolean;
}) {
  if (!total) return null;
  const pct = Math.min(100, (done / total) * 100);
  const spendPct = ceiling > 0 ? Math.min(100, (spent / ceiling) * 100) : 0;
  const nearCeiling = spendPct > 80;

  return (
    <div style={{ padding: "0 18px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
          {done.toLocaleString("en-US")} / {total.toLocaleString("en-US")} rendered
        </span>
        <span className="mono" style={{ fontSize: 10, color: running ? "var(--ember)" : "var(--ink-3)" }}>
          {pct.toFixed(1)}%
        </span>
      </div>
      <div style={{ height: 4, background: "var(--pane-2)", overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%",
          background: pct >= 100 ? "var(--good)" : "var(--ember)",
          transition: "width .3s",
        }} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", margin: "10px 0 6px" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
          ${spent.toFixed(2)} of ${ceiling.toFixed(2)} ceiling
        </span>
        {nearCeiling && (
          <span className="mono" style={{ fontSize: 10, color: "var(--warn)" }}>
            {spendPct.toFixed(0)}% USED
          </span>
        )}
      </div>
      <div style={{ height: 4, background: "var(--pane-2)", overflow: "hidden" }}>
        <div style={{
          width: `${spendPct}%`, height: "100%",
          background: nearCeiling ? "var(--warn)" : "var(--good)",
          transition: "width .3s",
        }} />
      </div>
    </div>
  );
}
