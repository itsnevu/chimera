"use client";
import { useEffect, useRef, useState } from "react";

export type Edition = { edition: number; traits: Record<string, string>; prompt: string; seed: number };

const CELL = 58;
const GAP = 3;
const OVERSCAN = 4;

/**
 * Windowed grid.
 *
 * The previous version capped at 600 cells, which meant a 10,000-edition
 * collection showed 6% of itself. This renders only the rows actually on
 * screen, so the cap is gone and the DOM stays small regardless of size.
 */
export function ProofSheet({
  editions, rendered, flagged, selected, onSelect,
}: {
  editions: Edition[];
  rendered: number;
  flagged: Record<number, string[]>;
  selected: number | null;
  onSelect: (edition: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      setCols(Math.max(1, Math.floor((host.clientWidth + GAP) / (CELL + GAP))));
      setViewport(window.innerHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  useEffect(() => {
    const onScroll = () => setScrollTop(window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const rowHeight = CELL + GAP;
  const rows = Math.ceil(editions.length / cols);
  const top = hostRef.current?.offsetTop ?? 0;
  const firstRow = Math.max(0, Math.floor((scrollTop - top) / rowHeight) - OVERSCAN);
  const lastRow = Math.min(rows, Math.ceil((scrollTop - top + viewport) / rowHeight) + OVERSCAN);
  const from = firstRow * cols;
  const to = Math.min(editions.length, lastRow * cols);
  const visible = editions.slice(from, Math.max(from, to));

  return (
    <div ref={hostRef} style={{ padding: 18 }}>
      <div style={{ height: rows * rowHeight, position: "relative" }}>
        <div
          style={{
            position: "absolute", top: firstRow * rowHeight, left: 0, right: 0,
            display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gap: GAP,
          }}
        >
          {visible.map((e) => {
            const done = e.edition <= rendered;
            const bad = flagged[e.edition];
            return (
              <button
                key={e.edition}
                onClick={() => onSelect(e.edition)}
                title={bad ? `#${e.edition} — ${bad[0]}` : `#${e.edition}`}
                style={{
                  aspectRatio: "1", padding: 0, overflow: "hidden", position: "relative",
                  background: "var(--pane-2)",
                  border: selected === e.edition ? "1.5px solid var(--ember)" : "1px solid var(--rule)",
                }}
              >
                {done ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/image/${e.edition}`} alt={`Edition ${e.edition}`} loading="lazy"
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                ) : (
                  <span className="mono" style={{
                    position: "absolute", inset: 0, display: "grid", placeItems: "center",
                    fontSize: 8, color: "var(--ink-3)",
                  }}>{e.edition}</span>
                )}
                {bad && (
                  <span
                    aria-label="flagged by QC"
                    style={{
                      position: "absolute", top: 0, right: 0, width: 0, height: 0,
                      borderTop: "11px solid var(--warn)", borderLeft: "11px solid transparent",
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
