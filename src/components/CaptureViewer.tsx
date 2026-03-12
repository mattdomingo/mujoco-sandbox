"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type { ParsedCapture, CaptureFrame } from "@/lib/pkg/types";
import { usePlayback } from "@/hooks/usePlayback";
import { loadMuJoCo, applyFrame } from "@/lib/mujoco/loader";
import type { MuJoCoInstance } from "@/lib/mujoco/loader";
import {
  initThreeScene,
  renderFromFrame,
  renderFromMujoco,
  aimCameraAtCapture,
  applyCameraFromDevicePose,
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

  const hasDevicePose = capture.frames.some(f => f.devicePose !== null);
  const [followHead, setFollowHead] = useState(hasDevicePose);
  const [playbackState, playbackControls] = usePlayback(capture, onFrame);

  // Keep a ref so onFrame (memoized via useCallback) can always read the latest toggle value
  const followHeadRef = useRef(followHead);
  followHeadRef.current = followHead;

  const onFrame = useCallback((frame: CaptureFrame) => {
    if (!threeRef.current) return;

    if (followHeadRef.current && frame.devicePose) {
      applyCameraFromDevicePose(threeRef.current, frame);
    }

    if (mujocoRef.current) {
      applyFrame(mujocoRef.current, frame);
      renderFromMujoco(threeRef.current, mujocoRef.current);
    } else {
      renderFromFrame(threeRef.current, frame);
    }
  }, []);

  // When the toggle switches to fixed, snap back to the bounding-box view
  const handleToggle = useCallback(() => {
    setFollowHead(prev => {
      const next = !prev;
      if (!next && threeRef.current) {
        aimCameraAtCapture(threeRef.current, capture.frames);
      }
      return next;
    });
  }, [capture.frames]);

  useEffect(() => {
    if (loadedRef.current || !canvasRef.current) return;
    loadedRef.current = true;

    const canvas = canvasRef.current;
    let three: ThreeScene;
    let rafId: number;

    rafId = requestAnimationFrame(() => {
      three = initThreeScene(canvas);
      threeRef.current = three;

      const frame0 = capture.frames[0];
      if (frame0?.devicePose && followHeadRef.current) {
        applyCameraFromDevicePose(three, frame0);
      } else {
        aimCameraAtCapture(three, capture.frames);
      }
      if (frame0) renderFromFrame(three, frame0);

      loadMuJoCo()
        .then((instance) => {
          mujocoRef.current = instance;
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

        {/* Camera mode toggle — only shown when device pose data exists */}
        {hasDevicePose && (
          <div className="absolute top-3 right-3 flex items-center gap-2 bg-zinc-900/80 backdrop-blur-sm border border-zinc-700 rounded-lg px-3 py-2">
            <span className="text-xs text-zinc-400 select-none">Camera</span>
            <button
              onClick={handleToggle}
              className={[
                "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent",
                "transition-colors duration-200 focus:outline-none",
                followHead ? "bg-blue-500" : "bg-zinc-600",
              ].join(" ")}
              role="switch"
              aria-checked={followHead}
              title={followHead ? "Following head — click for fixed view" : "Fixed view — click to follow head"}
            >
              <span
                className={[
                  "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow",
                  "transform transition duration-200",
                  followHead ? "translate-x-4" : "translate-x-0",
                ].join(" ")}
              />
            </button>
            <span className="text-xs text-zinc-300 select-none w-16">
              {followHead ? "Follow head" : "Fixed"}
            </span>
          </div>
        )}
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
