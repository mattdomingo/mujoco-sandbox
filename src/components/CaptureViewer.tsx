"use client";

import { useEffect, useRef, useCallback } from "react";
import type { ParsedCapture, CaptureFrame } from "@/lib/pkg/types";
import { usePlayback } from "@/hooks/usePlayback";
import { loadMuJoCo, applyFrame } from "@/lib/mujoco/loader";
import type { MuJoCoInstance } from "@/lib/mujoco/loader";
import {
  initThreeScene,
  renderFromFrame,
  renderFromMujoco,
  aimCameraAtFrame,
  resizeRenderer,
} from "@/lib/three/scene";
import type { ThreeScene } from "@/lib/three/scene";
import PlaybackControlsPanel from "./PlaybackControls";

interface CaptureViewerProps {
  capture: ParsedCapture;
}

export default function CaptureViewer({ capture }: CaptureViewerProps) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const mujocoRef  = useRef<MuJoCoInstance | null>(null);
  const threeRef   = useRef<ThreeScene | null>(null);
  const loadedRef  = useRef(false);

  const onFrame = useCallback((frame: CaptureFrame) => {
    if (!threeRef.current) return;

    if (mujocoRef.current) {
      // MuJoCo loaded — run physics pipeline then render from its state
      applyFrame(mujocoRef.current, frame);
      renderFromMujoco(threeRef.current, mujocoRef.current);
    } else {
      // MuJoCo still loading — render directly from frame data so the
      // canvas isn't blank while the WASM boots up
      renderFromFrame(threeRef.current, frame);
    }
  }, []);

  const [playbackState, playbackControls] = usePlayback(capture, onFrame);

  useEffect(() => {
    if (loadedRef.current || !canvasRef.current) return;
    loadedRef.current = true;

    const canvas = canvasRef.current;

    // Three.js init — defer one rAF so the canvas has been painted by the
    // browser and clientWidth/clientHeight are non-zero
    let three: ThreeScene;
    let rafId: number;

    rafId = requestAnimationFrame(() => {
      three = initThreeScene(canvas);
      threeRef.current = three;

      // Show frame 0 immediately using direct frame rendering (no MuJoCo needed)
      const frame0 = capture.frames[0];
      if (frame0) {
        aimCameraAtFrame(three, frame0);
        renderFromFrame(three, frame0);
      }

      // Now kick off MuJoCo async load
      loadMuJoCo()
        .then((instance) => {
          mujocoRef.current = instance;
          // Re-render frame 0 now through the MuJoCo pipeline
          if (frame0) {
            applyFrame(instance, frame0);
            renderFromMujoco(three, instance);
          }
          console.log("MuJoCo ready");
        })
        .catch((err) => console.error("MuJoCo failed to load:", err));
    });

    const onResize = () => {
      if (threeRef.current) resizeRenderer(threeRef.current, canvas);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
      threeRef.current?.dispose();
      threeRef.current = null;
      loadedRef.current = false;
    };
  }, [capture]);

  return (
    <div className="flex flex-col flex-1 bg-zinc-950">
      <div className="relative flex-1">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ display: "block" }}
        />
      </div>

      <PlaybackControlsPanel
        state={playbackState}
        controls={playbackControls}
        frameCount={capture.metadata.frameCount}
        frameRate={capture.metadata.frameRate}
      />
    </div>
  );
}
