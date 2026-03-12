"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type { ParsedCapture, CaptureFrame } from "@/lib/pkg/types";
import { usePlayback } from "@/hooks/usePlayback";
import { loadMuJoCo, applyFrame, mujocoTimeoutMs, readContactPressure } from "@/lib/mujoco/loader";
import type { MuJoCoInstance, MuJoCoStage } from "@/lib/mujoco/loader";
import {
  initThreeScene,
  renderFromFrame,
  renderFromMujoco,
  aimCameraAtCapture,
  applyCameraFromDevicePose,
  resizeRenderer,
  updatePressureBall,
} from "@/lib/three/scene";
import type { ThreeScene, MuJoCoReadMode } from "@/lib/three/scene";
import PlaybackControlsPanel from "./PlaybackControls";
import MuJoCoStatus from "./MuJoCoStatus";
import PressureDisplay from "./PressureDisplay";

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

  // MuJoCo load status
  const [mujocoStage, setMujocoStage]     = useState<MuJoCoStage>("booting");
  const [mujocoElapsed, setMujocoElapsed] = useState(0);
  const [mujocoError, setMujocoError]     = useState<string | null>(null);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mujocoStartRef     = useRef<number>(0);

  // Read mode toggle
  const [readMode, setReadMode] = useState<MuJoCoReadMode>("mocap");
  const readModeRef = useRef<MuJoCoReadMode>("mocap");
  readModeRef.current = readMode;

  // Pressure display state — updated each frame via ref to avoid re-render cost,
  // but also synced to React state at ~10fps for the HUD.
  const [pressure, setPressure]         = useState(0);
  const [contactCount, setContactCount] = useState(0);
  const pressureFrameRef = useRef(0); // frame counter for decimating HUD updates

  // Keep refs so onFrame (memoized) reads the latest toggle values without stale closure
  const followHeadRef = useRef(followHead);
  followHeadRef.current = followHead;

  const onFrame = useCallback((frame: CaptureFrame) => {
    if (!threeRef.current) return;

    if (followHeadRef.current && frame.devicePose) {
      applyCameraFromDevicePose(threeRef.current, frame);
    }

    if (mujocoRef.current) {
      applyFrame(mujocoRef.current, frame);

      // Read contact pressure and update the ball mesh every frame
      const result = readContactPressure(mujocoRef.current);
      updatePressureBall(threeRef.current, result.ballPos, result.pressure);

      // Sync React state at ~10fps (every 6 frames at 60fps) to avoid excessive re-renders
      pressureFrameRef.current++;
      if (pressureFrameRef.current % 6 === 0) {
        setPressure(result.pressure);
        setContactCount(result.contactCount);
      }

      renderFromMujoco(threeRef.current, mujocoRef.current, readModeRef.current);
    } else {
      renderFromFrame(threeRef.current, frame);
    }
  }, []);

  const [playbackState, playbackControls] = usePlayback(capture, onFrame);

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

      mujocoStartRef.current = performance.now();
      elapsedIntervalRef.current = setInterval(() => {
        setMujocoElapsed(Math.round(performance.now() - mujocoStartRef.current));
      }, 100);

      const timeout = mujocoTimeoutMs(capture.metadata.frameCount);

      loadMuJoCo(
        (progress) => {
          setMujocoStage(progress.stage);
          setMujocoElapsed(progress.elapsedMs);
        },
        timeout
      )
        .then((instance) => {
          mujocoRef.current = instance;
          if (elapsedIntervalRef.current) {
            clearInterval(elapsedIntervalRef.current);
            elapsedIntervalRef.current = null;
          }
          if (frame0) {
            applyFrame(instance, frame0);
            renderFromMujoco(three, instance, readModeRef.current);
          }
        })
        .catch((err: Error) => {
          if (elapsedIntervalRef.current) {
            clearInterval(elapsedIntervalRef.current);
            elapsedIntervalRef.current = null;
          }
          setMujocoElapsed(Math.round(performance.now() - mujocoStartRef.current));
          if (err.message === "timeout") {
            setMujocoStage("timeout");
          } else {
            setMujocoStage("error");
            setMujocoError(err.message ?? String(err));
          }
        });
    });

    const onResize = () => {
      if (threeRef.current) resizeRenderer(threeRef.current, canvas);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(rafId);
      if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current);
      window.removeEventListener("resize", onResize);
      threeRef.current?.dispose();
      threeRef.current = null;
      loadedRef.current = false;
    };
  }, [capture]);

  const mujocoSettled = mujocoStage === "ready" || mujocoStage === "timeout" || mujocoStage === "error";
  const mujocoReady   = mujocoStage === "ready";

  return (
    <div className="flex flex-col flex-1 bg-zinc-950">
      <div className="relative flex-1">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ display: "block" }}
        />

        {/* MuJoCo load status */}
        <MuJoCoStatus
          stage={mujocoStage}
          elapsedMs={mujocoElapsed}
          settled={mujocoSettled}
          errorMessage={mujocoError}
        />

        {/* Pressure display — only shown when MuJoCo is running */}
        {mujocoReady && (
          <PressureDisplay pressure={pressure} contactCount={contactCount} />
        )}

        {/* Camera mode toggle */}
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

        {/* Read mode toggle */}
        {mujocoReady && (
          <div className="absolute top-3 left-3 flex items-center gap-2 bg-zinc-900/80 backdrop-blur-sm border border-zinc-700 rounded-lg px-3 py-2">
            <span className="text-xs text-zinc-400 select-none">MuJoCo read</span>
            <button
              onClick={() => setReadMode(m => m === "mocap" ? "xpos" : "mocap")}
              className={[
                "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent",
                "transition-colors duration-200 focus:outline-none",
                readMode === "xpos" ? "bg-green-500" : "bg-zinc-600",
              ].join(" ")}
              role="switch"
              aria-checked={readMode === "xpos"}
              title={readMode === "xpos" ? "Reading data.xpos — click for mocap_pos" : "Reading data.mocap_pos — click for xpos"}
            >
              <span
                className={[
                  "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow",
                  "transform transition duration-200",
                  readMode === "xpos" ? "translate-x-4" : "translate-x-0",
                ].join(" ")}
              />
            </button>
            <span className={[
              "text-xs select-none w-16 font-mono",
              readMode === "xpos" ? "text-green-400" : "text-zinc-300",
            ].join(" ")}>
              {readMode === "xpos" ? "xpos" : "mocap_pos"}
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
