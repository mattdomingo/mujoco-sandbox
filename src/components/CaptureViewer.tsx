"use client";

import { useEffect, useRef, useCallback } from "react";
import type { ParsedCapture, CaptureFrame } from "@/lib/pkg/types";
import type { PlaybackState, PlaybackControls } from "@/hooks/usePlayback";
import { usePlayback } from "@/hooks/usePlayback";
import { loadMuJoCo, applyFrame } from "@/lib/mujoco/loader";
import type { MuJoCoInstance } from "@/lib/mujoco/loader";
import PlaybackControlsPanel from "./PlaybackControls";

interface CaptureViewerProps {
  capture: ParsedCapture;
  playbackState?: PlaybackState;
  playbackControls?: PlaybackControls;
}

export default function CaptureViewer({ capture }: CaptureViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<MuJoCoInstance | null>(null);
  const loadedRef = useRef(false);

  const onFrame = useCallback((frame: CaptureFrame) => {
    if (!instanceRef.current) return;
    applyFrame(instanceRef.current, frame);
    // Rendering: MuJoCo WASM does not include a WebGL renderer.
    // Hook your own Three.js / raw WebGL render call here once you have one.
  }, []);

  const [playbackState, playbackControls] = usePlayback(capture, onFrame);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    loadMuJoCo()
      .then((instance) => {
        instanceRef.current = instance;
        // Render first frame immediately so the canvas isn't blank
        if (capture.frames.length > 0) {
          applyFrame(instance, capture.frames[0]);
        }
      })
      .catch((err) => {
        console.error("Failed to load MuJoCo:", err);
      });
  }, [capture]);

  return (
    <div className="flex flex-col flex-1 bg-zinc-950">
      <div className="relative flex-1 flex items-center justify-center">
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
