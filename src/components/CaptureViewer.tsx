"use client";

import { useEffect, useRef, useCallback } from "react";
import type { ParsedCapture, CaptureFrame } from "@/lib/pkg/types";
import { usePlayback } from "@/hooks/usePlayback";
import { loadMuJoCo, applyFrame } from "@/lib/mujoco/loader";
import type { MuJoCoInstance } from "@/lib/mujoco/loader";
import { initThreeScene, renderFrame, resizeRenderer } from "@/lib/three/scene";
import type { ThreeScene } from "@/lib/three/scene";
import PlaybackControlsPanel from "./PlaybackControls";

interface CaptureViewerProps {
  capture: ParsedCapture;
}

export default function CaptureViewer({ capture }: CaptureViewerProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const mujocoRef    = useRef<MuJoCoInstance | null>(null);
  const threeRef     = useRef<ThreeScene | null>(null);
  const loadedRef    = useRef(false);

  // Called by usePlayback each tick with the current frame.
  // 1. Feed frame into MuJoCo  2. Read result back out into Three.js
  const onFrame = useCallback((frame: CaptureFrame) => {
    if (!mujocoRef.current || !threeRef.current) return;
    applyFrame(mujocoRef.current, frame);
    renderFrame(threeRef.current, mujocoRef.current);
  }, []);

  const [playbackState, playbackControls] = usePlayback(capture, onFrame);

  // Init MuJoCo + Three.js once on mount
  useEffect(() => {
    if (loadedRef.current || !canvasRef.current) return;
    loadedRef.current = true;

    const canvas = canvasRef.current;

    // Three.js can init synchronously
    const three = initThreeScene(canvas);
    threeRef.current = three;

    // MuJoCo loads async (fetches XML + WASM)
    loadMuJoCo()
      .then((instance) => {
        mujocoRef.current = instance;
        // Render frame 0 immediately so canvas isn't blank
        if (capture.frames.length > 0) {
          applyFrame(instance, capture.frames[0]);
          renderFrame(three, instance);
        }
      })
      .catch((err) => console.error("MuJoCo failed to load:", err));

    // Resize handler
    const onResize = () => resizeRenderer(three, canvas);
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      three.dispose();
      threeRef.current = null;
      loadedRef.current = false;
    };
  }, [capture]);

  return (
    <div className="flex flex-col flex-1 bg-zinc-950">
      <div className="relative flex-1">
        <canvas
          ref={canvasRef}
          className="w-full h-full"
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
