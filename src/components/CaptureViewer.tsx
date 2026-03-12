"use client";

import { useRef } from "react";
import type { ParsedCapture } from "@/lib/pkg/types";
import type { PlaybackState, PlaybackControls } from "@/hooks/usePlayback";
import PlaybackControlsPanel from "./PlaybackControls";

interface CaptureViewerProps {
  capture: ParsedCapture;
  playbackState: PlaybackState;
  playbackControls: PlaybackControls;
}

export default function CaptureViewer({
  capture,
  playbackState,
  playbackControls,
}: CaptureViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // TODO: Call loadMuJoCo() on mount (import from @/lib/mujoco/loader)
  //       Store { mujoco, model, data } in a ref
  // TODO: Set up WebGL render loop using the canvas ref
  //       On each rAF tick, call applyFrame(instance, currentFrame) then render
  // TODO: Pass onFrame callback to usePlayback that calls applyFrame + render

  return (
    <div className="flex flex-col flex-1 bg-zinc-950">
      <div className="relative flex-1 flex items-center justify-center">
        <canvas
          ref={canvasRef}
          className="w-full h-full"
          style={{ display: "block" }}
        />
        {/* Placeholder until MuJoCo WASM is wired up */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-500">
          <p className="text-sm font-mono">MuJoCo not set up yet</p>
          <p className="text-xs text-zinc-600">
            See README — place WASM binaries in /public/mujoco/
          </p>
        </div>
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
