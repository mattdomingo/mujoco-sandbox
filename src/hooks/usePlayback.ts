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
  // TODO: Use useRef to track frameIndex, isPlaying, speed, lastTimestamp
  // TODO: Implement rAF loop:
  //       - Compute elapsed time since last frame scaled by speed
  //       - Advance frameIndex based on elapsed time and capture.metadata.frameRate
  //       - Call onFrame(capture.frames[frameIndex])
  //       - Stop loop at last frame or when paused
  // TODO: Implement play() — set isPlaying=true, kick off rAF loop
  // TODO: Implement pause() — set isPlaying=false, cancel rAF
  // TODO: Implement seek(frameIndex) — jump to frame, call onFrame immediately
  // TODO: Implement setSpeed(speed) — update speed multiplier
  // TODO: Cleanup rAF on unmount
  throw new Error("usePlayback not yet implemented");
}
