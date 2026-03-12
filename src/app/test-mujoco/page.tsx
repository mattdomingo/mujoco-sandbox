"use client";

/**
 * Test harness page — not for production use.
 * Loads MuJoCo and exposes the instance + helpers on window.__mujocoTest
 * so Playwright tests can call them directly via page.evaluate().
 *
 * Visit /test-mujoco in the browser to trigger the boot sequence.
 * The page shows a status string that tests can wait on.
 */

import { useEffect, useState } from "react";
import { loadMuJoCo, applyFrame, readContactPressure } from "@/lib/mujoco/loader";
import type { MuJoCoInstance } from "@/lib/mujoco/loader";
import { HAND_JOINT_NAMES } from "@/lib/pkg/types";

declare global {
  interface Window {
    __mujocoTest?: {
      instance: MuJoCoInstance;
      HAND_JOINT_NAMES: string[];
      applyFrame: typeof applyFrame;
      readContactPressure: typeof readContactPressure;
    };
  }
}

export default function MuJoCoTestPage() {
  const [status, setStatus] = useState("loading");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    loadMuJoCo((p) => setStatus(`stage:${p.stage}`))
      .then((instance) => {
        window.__mujocoTest = { instance, HAND_JOINT_NAMES, applyFrame, readContactPressure };
        setStatus("ready");
        setDetail(
          `nbody=${instance.model.nbody} nmocap=${instance.model.nmocap} ` +
          `mocapKeys=${instance.mocapIndex.size} bodyKeys=${instance.bodyIndex.size} ` +
          `ballBodyId=${instance.ballBodyId} ballGeomId=${instance.ballGeomId}`
        );
      })
      .catch((e: Error) => {
        setStatus("error");
        setDetail(e.message);
      });
  }, []);

  return (
    <div style={{ fontFamily: "monospace", padding: 24 }}>
      <h1>MuJoCo Test Harness</h1>
      <p data-testid="status">{status}</p>
      <p data-testid="detail">{detail}</p>
    </div>
  );
}
