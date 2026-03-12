"use client";

import { useState } from "react";

interface PressureDisplayProps {
  pressure: number;       // Newtons
  contactCount: number;
  label?: string;
  caption?: string;
  className?: string;
  defaultCollapsed?: boolean;
}

const MAX_PRESSURE = 30; // N — must match scene.ts

// Returns a CSS rgb() string matching the Three.js gradient in scene.ts
function pressureToCss(pressure: number): string {
  const t = Math.min(pressure / MAX_PRESSURE, 1);
  let r: number, g: number, b: number;
  if (t < 0.5) {
    const s = t * 2;
    r = Math.round(s * 255);
    g = Math.round(s * 224);
    b = Math.round((1 - s * 0.75) * 255);
  } else {
    const s = (t - 0.5) * 2;
    r = 255;
    g = Math.round((0.88 - s * 0.75) * 255);
    b = Math.round((0.25 - s * 0.11) * 255);
  }
  return `rgb(${r},${g},${b})`;
}

export default function PressureDisplay({
  pressure,
  contactCount,
  label = "Ball pressure",
  caption = "MuJoCo contact force",
  className = "",
  defaultCollapsed = false,
}: PressureDisplayProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const barFill = Math.min(pressure / MAX_PRESSURE, 1);
  const color   = pressureToCss(pressure);
  const active  = contactCount > 0;

  return (
    <div className={[
      "w-56 bg-zinc-900/90 backdrop-blur-sm border border-zinc-700 rounded-lg px-3 py-2.5 flex flex-col gap-2",
      className,
    ].join(" ").trim()}>

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span
            className={["flex-shrink-0 w-1.5 h-1.5 rounded-full", active ? "animate-pulse" : ""].join(" ")}
            style={{ background: active ? color : "#52525b" }}
          />
          <span className="text-xs text-zinc-400 select-none">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-zinc-500">
            {contactCount} contact{contactCount !== 1 ? "s" : ""}
          </span>
          <button
            type="button"
            onClick={() => setCollapsed(prev => !prev)}
            className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
            aria-expanded={!collapsed}
            title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          >
            {collapsed ? "Show" : "Hide"}
          </button>
        </div>
      </div>

      {collapsed ? (
        <div className="flex items-baseline justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1.5">
          <div className="flex items-baseline gap-1">
            <span
              className="text-sm font-mono font-semibold tabular-nums leading-none"
              style={{ color: active ? color : "#71717a" }}
            >
              {pressure.toFixed(1)}
            </span>
            <span className="text-[10px] text-zinc-500">N</span>
          </div>
          <span className="text-[10px] text-zinc-600 select-none">Collapsed</span>
        </div>
      ) : (
        <>
          {/* Score */}
          <div className="flex items-baseline gap-1">
            <span
              className="text-2xl font-mono font-semibold tabular-nums leading-none"
              style={{ color: active ? color : "#71717a" }}
            >
              {pressure.toFixed(1)}
            </span>
            <span className="text-xs text-zinc-500">N</span>
          </div>

          {/* Color bar */}
          <div className="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-75"
              style={{
                width: `${barFill * 100}%`,
                background: active
                  ? `linear-gradient(to right, #3380ff, ${color})`
                  : "#3f3f46",
              }}
            />
          </div>

          <p className="text-[10px] text-zinc-600 leading-snug select-none">
            {caption} · blue→yellow→red
          </p>
        </>
      )}
    </div>
  );
}
