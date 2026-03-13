"use client";

import { useRef, useCallback } from "react";
import type { CaptureFrame } from "@/lib/pkg/types";

// Maximum drift (seconds) corrected by playbackRate nudge.
// Beyond this threshold, a hard seek is used instead.
const DRIFT_NUDGE_THRESHOLD = 0.5;

// playbackRate applied to catch up / slow down during small drift.
const RATE_FAST = 1.1;
const RATE_SLOW = 0.9;

export interface VideoSyncControls {
  /** Call when playback starts. Seeks video to the correct position and starts playback. */
  onPlay: (frame: CaptureFrame, frameRate: number) => void;
  /** Call when playback pauses. */
  onPause: () => void;
  /** Call on every rAF tick during playback to correct drift. */
  onTick: (frame: CaptureFrame, frameRate: number) => void;
  /** Call when the user scrubs while paused. */
  onSeek: (frame: CaptureFrame, frameRate: number) => void;
}

export function useVideoSync(
  videoRef: React.RefObject<HTMLVideoElement | null>
): VideoSyncControls {
  // Wall-clock time (ms) when the current play segment started, and the
  // corresponding capture time (s) at that moment — used to compute expected
  // video.currentTime without touching video.currentTime every tick.
  const anchorWallRef    = useRef<number>(0);
  const anchorCaptureRef = useRef<number>(0);
  const speedRef         = useRef<number>(1);

  const onPlay = useCallback((frame: CaptureFrame, frameRate: number) => {
    const video = videoRef.current;
    if (!video) return;
    const captureTime = frame.index / frameRate;
    video.currentTime = captureTime;
    anchorWallRef.current    = performance.now();
    anchorCaptureRef.current = captureTime;
    speedRef.current         = 1;
    video.playbackRate       = 1;
    video.play().catch(() => {});
  }, [videoRef]);

  const onPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.playbackRate = 1;
  }, [videoRef]);

  const onSeek = useCallback((frame: CaptureFrame, frameRate: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = frame.index / frameRate;
  }, [videoRef]);

  const onTick = useCallback((frame: CaptureFrame, frameRate: number) => {
    const video = videoRef.current;
    if (!video || video.paused) return;

    const expectedTime = anchorCaptureRef.current +
      (performance.now() - anchorWallRef.current) / 1000 * speedRef.current;
    const drift = video.currentTime - expectedTime;  // positive = video ahead

    if (Math.abs(drift) > DRIFT_NUDGE_THRESHOLD) {
      // Large drift — hard seek and re-anchor
      const captureTime = frame.index / frameRate;
      video.currentTime  = captureTime;
      anchorWallRef.current    = performance.now();
      anchorCaptureRef.current = captureTime;
      video.playbackRate = 1;
    } else if (drift > 0.05) {
      // Video is ahead — slow it down
      video.playbackRate = RATE_SLOW;
    } else if (drift < -0.05) {
      // Video is behind — speed it up
      video.playbackRate = RATE_FAST;
    } else {
      video.playbackRate = 1;
    }
  }, [videoRef]);

  return { onPlay, onPause, onSeek, onTick };
}
