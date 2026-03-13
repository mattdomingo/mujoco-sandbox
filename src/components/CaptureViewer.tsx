"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type { ParsedCapture, CaptureFrame, HumanoidFrame, GhostInterpolationStats } from "@/lib/pkg/types";
import { usePlayback } from "@/hooks/usePlayback";
import { useVideoSync } from "@/hooks/useVideoSync";
import type { VideoSyncControls } from "@/hooks/useVideoSync";
import { loadMuJoCo, applyFrame, mujocoTimeoutMs, readContactPressure, readInterHandPressure } from "@/lib/mujoco/loader";
import type { MuJoCoInstance, MuJoCoStage } from "@/lib/mujoco/loader";
import { computeHumanoidIKBackground } from "@/lib/mujoco/humanoidIk";
import {
  initThreeScene,
  renderFromFrame,
  renderFromMujoco,
  aimCameraAtCapture,
  applyCameraFromDevicePose,
  resizeRenderer,
  updatePressureBall,
  makeHumanoidScene,
  setControlsDistance,
} from "@/lib/three/scene";
import type { ThreeScene, MuJoCoReadMode } from "@/lib/three/scene";
import PlaybackControlsPanel from "./PlaybackControls";
import MuJoCoStatus from "./MuJoCoStatus";
import PressureDisplay from "./PressureDisplay";
import IKStatus from "./IKStatus";
import type { IKStage } from "./IKStatus";

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

  const ZOOM_MIN = 0.3;
  const ZOOM_MAX = 15;
  const [zoomDistance, setZoomDistance] = useState(3.0);

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

  // Contact display state — updated each frame via ref to avoid re-render cost,
  // but also synced to React state at ~10fps for the HUD.
  const [ballPressure, setBallPressure]             = useState(0);
  const [ballContactCount, setBallContactCount]     = useState(0);
  const [handPressure, setHandPressure]             = useState(0);
  const [handContactCount, setHandContactCount]     = useState(0);
  const pressureFrameRef = useRef(0); // frame counter for decimating HUD updates

  // IK state
  const [ikStage, setIkStage]   = useState<IKStage>("pending");
  const [ikSolved, setIkSolved] = useState(0);
  const [ikTotal, setIkTotal]   = useState(0);
  const humanoidFramesRef       = useRef<HumanoidFrame[] | null>(null);
  const ikCancelRef             = useRef<(() => void) | null>(null);

  const [showVideoPopup, setShowVideoPopup] = useState(false);
  const videoRef     = useRef<HTMLVideoElement | null>(null);
  const videoSyncRef = useRef<VideoSyncControls | null>(null);

  const [showHumanoid, setShowHumanoid] = useState(true);
  const showHumanoidRef = useRef(true);
  showHumanoidRef.current = showHumanoid;

  const [ghostInterp, setGhostInterp] = useState(false);
  const ghostInterpRef = useRef(false);
  ghostInterpRef.current = ghostInterp;
  const [ghostCount, setGhostCount] = useState({ right: 0, left: 0 });

  // Keep refs so onFrame (memoized) reads the latest toggle values without stale closure
  const followHeadRef = useRef(followHead);
  followHeadRef.current = followHead;

  const onFrame = useCallback((frame: CaptureFrame) => {
    if (!threeRef.current) return;

    if (followHeadRef.current && frame.devicePose) {
      applyCameraFromDevicePose(threeRef.current, frame);
    }

    if (mujocoRef.current) {
      const humanoidFrame = humanoidFramesRef.current?.[frame.index];
      applyFrame(mujocoRef.current, frame, humanoidFrame);

      // Read MuJoCo contact forces and update the ball mesh every frame.
      const ballResult = readContactPressure(mujocoRef.current);
      const handResult = readInterHandPressure(mujocoRef.current);
      updatePressureBall(threeRef.current, ballResult.ballPos, ballResult.pressure);

      // Sync React state at ~10fps (every 6 frames at 60fps) to avoid excessive re-renders
      pressureFrameRef.current++;
      if (pressureFrameRef.current % 6 === 0) {
        setBallPressure(ballResult.pressure);
        setBallContactCount(ballResult.contactCount);
        setHandPressure(handResult.pressure);
        setHandContactCount(handResult.contactCount);
        if (!followHeadRef.current) {
          setZoomDistance(threeRef.current.controls.getDistance());
        }
      }

      renderFromMujoco(threeRef.current, mujocoRef.current, readModeRef.current, showHumanoidRef.current);
    } else {
      renderFromFrame(threeRef.current, frame);
    }
  }, []);

  // Pass videoRef so the rAF tick drives Three.js from video.currentTime
  const [playbackState, rawPlaybackControls] = usePlayback(capture, onFrame, capture.video ? videoRef : undefined);

  // Bind video file to the <video> element via an Object URL
  useEffect(() => {
    if (!videoRef.current || !capture.video) return;
    const url = URL.createObjectURL(capture.video);
    videoRef.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [capture.video]);

  // Video sync controls — just play/pause/seek the video element
  const videoSync = useVideoSync(videoRef);
  videoSyncRef.current = videoSync;

  // Wrap playback controls to drive the video alongside Three.js
  const handlePlay = useCallback(() => {
    // Use frameIndexRef (not React state) to get the true current position
    const frame = capture.frames[playbackState.frameIndexRef.current];
    const captureTime = frame
      ? frame.timestamp - capture.frames[0].timestamp
      : 0;
    videoSyncRef.current?.onPlay(captureTime);
    rawPlaybackControls.play();
  }, [rawPlaybackControls, capture, playbackState.frameIndexRef]);

  const handlePause = useCallback(() => {
    videoSyncRef.current?.onPause();
    rawPlaybackControls.pause();
  }, [rawPlaybackControls]);

  const handleSeek = useCallback((index: number) => {
    rawPlaybackControls.seek(index);
    // Map frame index → actual capture elapsed time for the video seek
    const frame = capture.frames[index];
    const captureTime = frame
      ? frame.timestamp - capture.frames[0].timestamp
      : 0;
    videoSyncRef.current?.onSeek(captureTime);
  }, [rawPlaybackControls, capture]);

  const playbackControls = {
    ...rawPlaybackControls,
    play:  handlePlay,
    pause: handlePause,
    seek:  handleSeek,
  };

  const handleToggleHumanoid = useCallback(() => {
    setShowHumanoid(prev => {
      const next = !prev;
      const h = threeRef.current?.humanoid;
      if (h && !next) {
        h.joints.forEach(m => { m.visible = false; });
        h.bones.forEach(m =>  { m.visible = false; });
      }
      // When turning back on, the next render frame will restore visibility naturally
      return next;
    });
  }, []);

  const triggerIKCompute = useCallback((ghostEnabled: boolean) => {
    ikCancelRef.current?.();
    setIkStage("computing");
    setIkSolved(0);
    setIkTotal(capture.frames.length);
    ikCancelRef.current = computeHumanoidIKBackground(
      capture.frames,
      (s, t) => { setIkSolved(s); setIkTotal(t); },
      (humanoidFrames: HumanoidFrame[], stats: GhostInterpolationStats) => {
        humanoidFramesRef.current = humanoidFrames;
        setIkStage("ready");
        setGhostCount({ right: stats.rightGhostCount, left: stats.leftGhostCount });
        if (threeRef.current && !threeRef.current.humanoid) {
          threeRef.current.humanoid = makeHumanoidScene(threeRef.current.scene);
        }
      },
      ghostEnabled,
    );
  }, [capture.frames]);

  const handleToggleGhostInterp = useCallback(() => {
    setGhostInterp(prev => {
      const next = !prev;
      triggerIKCompute(next);
      return next;
    });
  }, [triggerIKCompute]);

  const handleToggle = useCallback(() => {
    setFollowHead(prev => {
      const next = !prev;
      if (threeRef.current) {
        threeRef.current.controls.enabled = !next;
        if (!next) {
          aimCameraAtCapture(threeRef.current, capture.frames);
        }
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

      three.controls.enabled = !followHeadRef.current;
      setZoomDistance(three.controls.getDistance());

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

          // Start background IK if device pose is available
          const hasDevicePoseFrames = capture.frames.some(f => f.devicePose);
          if (hasDevicePoseFrames) {
            setIkStage("computing");
            setIkTotal(capture.frames.length);
            ikCancelRef.current = computeHumanoidIKBackground(
              capture.frames,
              (s, t) => { setIkSolved(s); setIkTotal(t); },
              (humanoidFrames: HumanoidFrame[], stats: GhostInterpolationStats) => {
                humanoidFramesRef.current = humanoidFrames;
                setIkStage("ready");
                setGhostCount({ right: stats.rightGhostCount, left: stats.leftGhostCount });
                if (threeRef.current) {
                  threeRef.current.humanoid = makeHumanoidScene(threeRef.current.scene);
                }
              },
              ghostInterpRef.current,
            );
          } else {
            setIkStage("skipped");
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
      ikCancelRef.current?.();
      ikCancelRef.current = null;
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

        {/* Humanoid IK progress */}
        <IKStatus stage={ikStage} solved={ikSolved} total={ikTotal} />

        {/* Pressure display — only shown when MuJoCo is running */}
        {mujocoReady && (
          <div className="absolute bottom-16 right-3 flex flex-col gap-3">
            <PressureDisplay
              pressure={ballPressure}
              contactCount={ballContactCount}
              label="Ball pressure"
              caption="MuJoCo contact force on free body"
            />
            <PressureDisplay
              pressure={handPressure}
              contactCount={handContactCount}
              label="Inter-hand pressure"
              caption="MuJoCo left/right hand contact force"
            />
          </div>
        )}

        {/* Top-right controls row */}
        <div className="absolute top-3 right-3 flex items-center gap-2">
          {/* Humanoid toggle — only shown when IK is ready */}
          {ikStage === "ready" && (
            <div className="flex items-center gap-2 bg-zinc-900/80 backdrop-blur-sm border border-zinc-700 rounded-lg px-3 py-2">
              <span className="text-xs text-zinc-400 select-none">Humanoid</span>
              <button
                onClick={handleToggleHumanoid}
                className={[
                  "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent",
                  "transition-colors duration-200 focus:outline-none",
                  showHumanoid ? "bg-blue-500" : "bg-zinc-600",
                ].join(" ")}
                role="switch"
                aria-checked={showHumanoid}
                title={showHumanoid ? "Humanoid visible — click to hide" : "Humanoid hidden — click to show"}
              >
                <span
                  className={[
                    "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow",
                    "transform transition duration-200",
                    showHumanoid ? "translate-x-4" : "translate-x-0",
                  ].join(" ")}
                />
              </button>
            </div>
          )}

          {/* Ghost interpolation toggle — only shown when IK is ready */}
          {ikStage === "ready" && (
            <div className="flex items-center gap-2 bg-zinc-900/80 backdrop-blur-sm border border-zinc-700 rounded-lg px-3 py-2">
              <span className="text-xs text-zinc-400 select-none">Ghost Interp</span>
              <button
                onClick={handleToggleGhostInterp}
                className={[
                  "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent",
                  "transition-colors duration-200 focus:outline-none",
                  ghostInterp ? "bg-amber-500" : "bg-zinc-600",
                ].join(" ")}
                role="switch"
                aria-checked={ghostInterp}
                title={ghostInterp ? "Ghost interpolation on — click to disable" : "Ghost interpolation off — click to enable"}
              >
                <span
                  className={[
                    "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow",
                    "transform transition duration-200",
                    ghostInterp ? "translate-x-4" : "translate-x-0",
                  ].join(" ")}
                />
              </button>
              {ghostInterp && (
                <span className="text-xs font-mono text-amber-400">
                  R {ghostCount.right} / L {ghostCount.left}
                </span>
              )}
            </div>
          )}

          {/* Camera mode toggle */}
          {hasDevicePose && (
            <div className="flex items-center gap-2 bg-zinc-900/80 backdrop-blur-sm border border-zinc-700 rounded-lg px-3 py-2">
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

        {/* Zoom slider — only shown in fixed camera mode */}
        {!followHead && (
          <div className="absolute flex flex-col items-center gap-1" style={{ top: "3.5rem", right: "0.75rem" }}>
            <span className="text-[10px] text-zinc-500 select-none">+</span>
            <input
              type="range"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={0.1}
              value={ZOOM_MAX + ZOOM_MIN - zoomDistance}
              onChange={(e) => {
                const newDist = ZOOM_MAX + ZOOM_MIN - Number(e.target.value);
                setZoomDistance(newDist);
                if (threeRef.current) setControlsDistance(threeRef.current, newDist);
              }}
              className="accent-blue-500 cursor-pointer"
              style={{ writingMode: "vertical-lr", direction: "rtl", height: "96px", width: "20px" }}
              aria-label="Zoom"
            />
            <span className="text-[10px] text-zinc-500 select-none">−</span>
          </div>
        )}

        {/* camera_left — single <video> element always in DOM so the browser
            keeps decoding and currentTime advances even when the popup is
            closed. When hidden, rendered as a 1×1 transparent pixel off-screen
            (visibility:hidden / display:none both suspend decoding). */}
        {capture.video && (
          <>
            <button
              onClick={() => setShowVideoPopup(v => !v)}
              className="absolute bottom-3 left-3 text-xs bg-zinc-900/80 backdrop-blur-sm border border-zinc-700 rounded-lg px-3 py-2 text-zinc-300 hover:text-white hover:border-zinc-500 transition-colors"
            >
              camera_left
            </button>

            {/* Popup panel — conditionally shown, but video element is outside */}
            {showVideoPopup && (
              <div className="absolute bottom-12 left-3 bg-zinc-900/90 backdrop-blur-sm border border-zinc-700 rounded-lg overflow-hidden shadow-xl pointer-events-none">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-700 pointer-events-auto">
                  <span className="text-xs text-zinc-400 font-mono">camera_left</span>
                  <button
                    onClick={() => setShowVideoPopup(false)}
                    className="text-zinc-500 hover:text-white text-sm leading-none ml-4"
                    aria-label="Close video"
                  >
                    ×
                  </button>
                </div>
              </div>
            )}

            {/* Single video element — always decoded; positioned to fill the
                popup slot when open, or shrunk off-screen when closed */}
            <video
              ref={videoRef}
              playsInline
              muted
              preload="auto"
              style={showVideoPopup
                ? { position: "absolute", bottom: "calc(1.5rem + 2rem + 1px)", left: "0.75rem", width: "18rem", display: "block", borderRadius: "0 0 0.5rem 0.5rem" }
                : { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none", bottom: 0, left: 0 }
              }
            />
          </>
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
