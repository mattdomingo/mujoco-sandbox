"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import type { ParsedCapture, CaptureFrame } from "@/lib/pkg/types";

export interface PlaybackState {
  isPlaying: boolean;
  frameIndex: number;
  speed: number;
}

export interface PlaybackControls {
  play: () => void;
  pause: () => void;
  seek: (frameIndex: number) => void;
  setSpeed: (speed: number) => void;
}

export function usePlayback(
  capture: ParsedCapture,
  onFrame: (f: CaptureFrame) => void
): [PlaybackState, PlaybackControls] {
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeedState] = useState(1);

  const rafRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const frameIndexRef = useRef(0);
  const isPlayingRef = useRef(false);
  const speedRef = useRef(1);

  const frameCount = capture.metadata.frameCount;
  const frameRate = capture.metadata.frameRate;

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

      if (lastTimestampRef.current === null) {
        lastTimestampRef.current = timestamp;
      }

      const elapsed = (timestamp - lastTimestampRef.current) / 1000; // seconds
      lastTimestampRef.current = timestamp;

      const framesToAdvance = elapsed * frameRate * speedRef.current;
      const nextIndex = Math.min(
        Math.floor(frameIndexRef.current + framesToAdvance),
        frameCount - 1
      );

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
    [capture, frameCount, frameRate, onFrame]
  );

  const play = useCallback(() => {
    if (isPlayingRef.current) return;
    // Restart from beginning if at last frame
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

  const setSpeed = useCallback((s: number) => {
    speedRef.current = s;
    setSpeedState(s);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopLoop();
  }, [stopLoop]);

  return [
    { isPlaying, frameIndex, speed },
    { play, pause, seek, setSpeed },
  ];
}
