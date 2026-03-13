"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import type { ParsedCapture, CaptureFrame } from "@/lib/pkg/types";

export interface PlaybackState {
  isPlaying: boolean;
  frameIndex: number;
}

export interface PlaybackControls {
  play: () => void;
  pause: () => void;
  seek: (frameIndex: number) => void;
}

export function usePlayback(
  capture: ParsedCapture,
  onFrame: (f: CaptureFrame) => void,
  // Optional video element — when provided, video.currentTime drives frame
  // selection instead of wall-clock elapsed time, so Three.js stays locked
  // to the video's actual decoded position.
  videoRef?: React.RefObject<HTMLVideoElement | null>
): [PlaybackState, PlaybackControls] {
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const rafRef          = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const frameIndexRef   = useRef(0);
  const isPlayingRef    = useRef(false);

  const frameCount = capture.metadata.frameCount;
  const frameRate  = capture.metadata.frameRate;

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastTimestampRef.current = null;
  }, []);

  const tick = useCallback(
    (timestamp: number) => {
      if (!isPlayingRef.current) return;

      let nextIndex: number;

      const video = videoRef?.current;
      if (video && !video.paused && video.readyState >= 2) {
        // Video-driven: binary-search frames by capture timestamp so Three.js
        // stays locked to the actual decoded video position regardless of
        // whether CSV frame rate matches the video's native frame rate.
        const t0 = capture.frames[0].timestamp;
        const target = t0 + video.currentTime;
        let lo = 0, hi = frameCount - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (capture.frames[mid].timestamp <= target) lo = mid;
          else hi = mid - 1;
        }
        nextIndex = lo;
      } else {
        // Wall-clock fallback (no video, or video not yet ready)
        if (lastTimestampRef.current === null) {
          lastTimestampRef.current = timestamp;
        }
        const elapsed = (timestamp - lastTimestampRef.current) / 1000;
        lastTimestampRef.current = timestamp;
        nextIndex = Math.min(
          Math.floor(frameIndexRef.current + elapsed * frameRate),
          frameCount - 1
        );
      }

      if (nextIndex !== frameIndexRef.current) {
        frameIndexRef.current = nextIndex;
        setFrameIndex(nextIndex);
        onFrame(capture.frames[nextIndex]);
      }

      if (nextIndex >= frameCount - 1) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        return;
      }

      rafRef.current = requestAnimationFrame(tick);
    },
    [capture, frameCount, frameRate, onFrame, videoRef]
  );

  const play = useCallback(() => {
    if (isPlayingRef.current) return;
    if (frameIndexRef.current >= frameCount - 1) {
      frameIndexRef.current = 0;
      setFrameIndex(0);
      onFrame(capture.frames[0]);
    }
    isPlayingRef.current = true;
    setIsPlaying(true);
    lastTimestampRef.current = null;
    rafRef.current = requestAnimationFrame(tick);
  }, [capture, frameCount, onFrame, tick]);

  const pause = useCallback(() => {
    isPlayingRef.current = false;
    setIsPlaying(false);
    stopLoop();
  }, [stopLoop]);

  const seek = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, frameCount - 1));
      frameIndexRef.current = clamped;
      setFrameIndex(clamped);
      onFrame(capture.frames[clamped]);
    },
    [capture, frameCount, onFrame]
  );

  useEffect(() => {
    return () => stopLoop();
  }, [stopLoop]);

  return [
    { isPlaying, frameIndex },
    { play, pause, seek },
  ];
}
