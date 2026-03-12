"use client";

import { useEffect, useState } from "react";
import type { MuJoCoStage } from "@/lib/mujoco/loader";

interface MuJoCoStatusProps {
  stage: MuJoCoStage;
  elapsedMs: number;
  settled: boolean;
  errorMessage?: string | null;
}

const STAGE_LABEL: Record<MuJoCoStage, string> = {
  booting:  "Booting WASM module…",
  fetching: "Fetching hand model…",
  loading:  "Loading physics model…",
  indexing: "Building body index…",
  ready:    "Physics engine ready",
  timeout:  "MuJoCo timed out",
  error:    "MuJoCo failed to load",
};

const STAGE_PROGRESS: Record<MuJoCoStage, number> = {
  booting:  0.10,
  fetching: 0.70,
  loading:  0.85,
  indexing: 0.95,
  ready:    1.00,
  timeout:  1.00,
  error:    1.00,
};

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function MuJoCoStatus({ stage, elapsedMs, settled, errorMessage }: MuJoCoStatusProps) {
  const [visible, setVisible] = useState(true);

  // Auto-hide 3s after settling — but keep failure states visible longer (8s)
  useEffect(() => {
    if (!settled) return;
    const delay = stage === "ready" ? 3_000 : 8_000;
    const id = setTimeout(() => setVisible(false), delay);
    return () => clearTimeout(id);
  }, [settled, stage]);

  if (!visible) return null;

  const isSuccess = stage === "ready";
  const isFailure = stage === "timeout" || stage === "error";
  const isActive  = !isSuccess && !isFailure;
  const progress  = STAGE_PROGRESS[stage];

  return (
    <div className={[
      "absolute bottom-16 left-3 w-64",
      "bg-zinc-900/90 backdrop-blur-sm border rounded-lg px-3 py-2.5 flex flex-col gap-2",
      "transition-opacity duration-500",
      settled ? "opacity-80 hover:opacity-100" : "opacity-100",
      isFailure ? "border-red-800" : "border-zinc-700",
    ].join(" ")}>

      {/* Stage label + elapsed */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={[
            "flex-shrink-0 w-1.5 h-1.5 rounded-full",
            isSuccess ? "bg-green-400" :
            isFailure ? "bg-red-400" :
            "bg-blue-400 animate-pulse",
          ].join(" ")} />
          <span className={[
            "text-xs truncate",
            isSuccess ? "text-green-400" :
            isFailure ? "text-red-400" :
            "text-zinc-300",
          ].join(" ")}>
            {STAGE_LABEL[stage]}
          </span>
        </div>
        <span className="text-xs text-zinc-500 flex-shrink-0 font-mono">
          {formatMs(elapsedMs)}
        </span>
      </div>

      {/* Progress bar — shown while loading */}
      {isActive && (
        <div className="w-full h-0.5 bg-zinc-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-300"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}

      {/* Failure note */}
      {isFailure && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-zinc-500 leading-snug">
            {stage === "timeout"
              ? "WASM exceeded the time limit. Visualization continues without physics."
              : "WASM failed to initialize. Visualization continues without physics."}
          </p>
          {errorMessage && (
            <p className="text-xs text-red-400/70 font-mono break-all leading-snug">
              {errorMessage}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
