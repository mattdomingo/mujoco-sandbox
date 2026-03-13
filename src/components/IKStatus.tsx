"use client";

import { useEffect, useState } from "react";

export type IKStage = "pending" | "computing" | "ready" | "skipped";

interface Props {
  stage: IKStage;
  solved: number;
  total: number;
}

export default function IKStatus({ stage, solved, total }: Props) {
  const [visible, setVisible] = useState(true);

  // Auto-hide after 3s when ready (mirrors MuJoCo status behavior)
  useEffect(() => {
    if (stage === "ready") {
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), 3000);
      return () => clearTimeout(timer);
    } else {
      setVisible(true);
    }
  }, [stage]);

  if (stage === "pending" || stage === "skipped" || !visible) return null;

  const pct = total > 0 ? Math.round((solved / total) * 100) : 0;

  return (
    <div className="absolute bottom-20 left-3 bg-zinc-900/90 backdrop-blur-sm border border-zinc-700 rounded-lg px-3 py-2 min-w-48">
      {stage === "computing" && (
        <>
          <p className="text-xs text-zinc-300 mb-1">
            Computing humanoid IK… ({solved.toLocaleString()} / {total.toLocaleString()})
          </p>
          <div className="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 transition-all duration-150"
              style={{ width: `${pct}%` }}
            />
          </div>
        </>
      )}
      {stage === "ready" && (
        <p className="text-xs text-green-400">Humanoid ready</p>
      )}
    </div>
  );
}
