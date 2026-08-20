"use client";
import { useEffect, useState } from "react";
import { Button } from "./ui";

type Option = { value: string; weight: number };
type Trait = { name: string; options: Option[] };

/**
 * Weight editing.
 *
 * Planning is free, so the loop "change a weight, re-roll, read the drift"
 * should cost nothing but a click. Edits go to chimera.overrides.json — the
 * source trait file is never rewritten, and Reset deletes the overrides to
 * restore exactly what was authored.
 */
export function TraitEditor({ onSaved, disabled }: { onSaved: () => void; disabled: boolean }) {
  const [traits, setTraits] = useState<Trait[]>([]);
  const [draft, setDraft] = useState<Record<string, Record<string, number>>>({});
  const [hasOverrides, setHasOverrides] = useState(false);
  const [combinations, setCombinations] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => {
    fetch("/api/traits", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setError(d.error);
        setTraits(d.traits);
        setHasOverrides(d.hasOverrides);
        setCombinations(d.combinations);
        setDraft({});
      })
      .catch(() => setError("Could not read the trait config."));
  };
  useEffect(load, []);

  const weightOf = (t: Trait, o: Option) => draft[t.name]?.[o.value] ?? o.weight;
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    // Send the full picture, not just edits — a partial file would silently
    // drop overrides the user set earlier.
    const merged: Record<string, Record<string, number>> = {};
    traits.forEach((t) => {
      t.options.forEach((o) => {
        const w = weightOf(t, o);
        if (w !== o.weight || draft[t.name]?.[o.value] !== undefined) {
          merged[t.name] = merged[t.name] ?? {};
          merged[t.name][o.value] = w;
        }
      });
    });
    const r = await fetch("/api/traits", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: merged }),
    });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Save failed");
    setBusy(false);
    load();
    onSaved();
  };

  const reset = async () => {
    setBusy(true);
    await fetch("/api/traits", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });
    setBusy(false);
    load();
    onSaved();
  };

  if (error) return <p style={{ fontSize: 11.5, color: "var(--warn)" }}>{error}</p>;
  if (!traits.length) return <p style={{ fontSize: 11.5, color: "var(--ink-3)" }}>Reading traits…</p>;

  return (
    <div>
      <p className="mono" style={{ fontSize: 10, color: "var(--ink-3)", marginBottom: 10 }}>
        {combinations.toLocaleString("en-US")} COMBINATIONS
        {hasOverrides && <span style={{ color: "var(--ember)" }}> · OVERRIDDEN</span>}
      </p>

      {traits.map((t) => {
        const total = t.options.reduce((a, o) => a + weightOf(t, o), 0);
        const expanded = open === t.name;
        return (
          <div key={t.name} style={{ borderBottom: "1px solid var(--rule)" }}>
            <button
              onClick={() => setOpen(expanded ? null : t.name)}
              style={{
                display: "flex", width: "100%", alignItems: "center", gap: 8,
                background: "none", border: "none", padding: "8px 0", textAlign: "left",
              }}
            >
              <span className="mono" style={{ fontSize: 9, color: "var(--ink-3)", width: 10 }}>
                {expanded ? "−" : "+"}
              </span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{t.name}</span>
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {t.options.length}
              </span>
            </button>

            {expanded && (
              <div style={{ paddingBottom: 8 }}>
                {t.options.map((o) => {
                  const w = weightOf(t, o);
                  const pct = (w / total) * 100;
                  const changed = w !== o.weight;
                  return (
                    <div key={o.value} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0 3px 18px" }}>
                      <span style={{ flex: 1, fontSize: 12, color: changed ? "var(--ember)" : "var(--ink-2)" }}>
                        {o.value}
                      </span>
                      <input
                        type="number" min={1} max={100000} value={w}
                        aria-label={`Weight for ${t.name} ${o.value}`}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (!Number.isFinite(n) || n < 1) return;
                          setDraft((d) => ({ ...d, [t.name]: { ...(d[t.name] ?? {}), [o.value]: n } }));
                        }}
                        className="mono"
                        style={{
                          width: 52, background: "var(--pane)", border: "1px solid var(--rule-2)",
                          color: changed ? "var(--ember)" : "var(--ink)", padding: "3px 6px", fontSize: 11,
                        }}
                      />
                      <span className="mono" style={{ width: 42, textAlign: "right", fontSize: 10, color: "var(--ink-3)" }}>
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 6, marginTop: 11, flexWrap: "wrap" }}>
        <Button tone={dirty ? "solid" : "ghost"} disabled={!dirty || busy || disabled} onClick={save}>
          SAVE WEIGHTS
        </Button>
        {hasOverrides && (
          <Button disabled={busy || disabled} onClick={reset} title="Delete overrides and restore chimera.traits.js">
            RESET
          </Button>
        )}
      </div>
      {dirty && (
        <p style={{ marginTop: 8, fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5 }}>
          Saving writes chimera.overrides.json. Re-roll the plan to see the new
          distribution — planning is free.
        </p>
      )}
    </div>
  );
}
