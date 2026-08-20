"use client";
import React from "react";

export const S = {
  blk: {
    padding: 18,
    borderBottom: "1px solid var(--rule)",
  } as React.CSSProperties,
  lbl: {
    fontFamily: "var(--font-mono)",
    fontSize: 9.5,
    letterSpacing: "0.06em",
    color: "var(--ink-3)",
    textTransform: "uppercase",
    display: "block",
    marginBottom: 11,
  } as React.CSSProperties,
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
    padding: "5px 0",
    fontSize: 12.5,
  } as React.CSSProperties,
};

export function Label({ children }: { children: React.ReactNode }) {
  return <span style={S.lbl}>{children}</span>;
}

export function Row({ k, v, accent }: { k: string; v: React.ReactNode; accent?: string }) {
  return (
    <div style={S.row}>
      <span style={{ color: "var(--ink-3)" }}>{k}</span>
      <span className="mono" style={{ fontSize: 12, color: accent ?? "var(--ink)" }}>{v}</span>
    </div>
  );
}

export function Button({
  children, onClick, disabled, tone = "ghost", full, title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "ghost" | "solid" | "danger";
  full?: boolean;
  title?: string;
}) {
  const base: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.02em",
    padding: "9px 15px",
    border: "1px solid var(--rule-2)",
    background: "transparent",
    color: "var(--ink-2)",
    width: full ? "100%" : undefined,
    transition: "border-color .18s, color .18s, background .18s",
  };
  const tones: Record<string, React.CSSProperties> = {
    ghost: {},
    solid: { background: "var(--ember)", borderColor: "var(--ember)", color: "var(--void)" },
    danger: { borderColor: "var(--warn)", color: "var(--warn)" },
  };
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{ ...base, ...tones[tone] }}
      onMouseEnter={(e) => {
        if (disabled || tone === "solid") return;
        e.currentTarget.style.borderColor = "var(--ember)";
        e.currentTarget.style.color = "var(--ember)";
      }}
      onMouseLeave={(e) => {
        if (disabled || tone === "solid") return;
        e.currentTarget.style.borderColor = tone === "danger" ? "var(--warn)" : "var(--rule-2)";
        e.currentTarget.style.color = tone === "danger" ? "var(--warn)" : "var(--ink-2)";
      }}
    >
      {children}
    </button>
  );
}

/** A step in the pipeline, with its state made visible rather than implied. */
export function Stage({
  n, title, state, children,
}: {
  n: number;
  title: string;
  state: "done" | "active" | "blocked" | "idle";
  children: React.ReactNode;
}) {
  const colour = {
    done: "var(--good)",
    active: "var(--ember)",
    blocked: "var(--warn)",
    idle: "var(--ink-3)",
  }[state];
  const mark = { done: "DONE", active: "NOW", blocked: "BLOCKED", idle: "" }[state];

  return (
    <section style={{ borderBottom: "1px solid var(--rule)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 18px 0" }}>
        <span className="mono" style={{ fontSize: 10, color: colour }}>
          {String(n).padStart(2, "0")}
        </span>
        <h2 style={{ fontSize: 12, flex: 1 }}>{title}</h2>
        {mark && (
          <span
            className="mono"
            style={{
              fontSize: 8.5, letterSpacing: "0.1em", padding: "2px 7px",
              color: colour, background: `color-mix(in srgb, ${colour} 12%, transparent)`,
            }}
          >
            {mark}
          </span>
        )}
      </div>
      <div style={{ padding: 18 }}>{children}</div>
    </section>
  );
}

export const money = (n: number) => `$${n.toFixed(2)}`;
export const num = (n: number) => n.toLocaleString("en-US");
