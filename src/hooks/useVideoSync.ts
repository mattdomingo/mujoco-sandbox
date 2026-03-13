"use client";

import { useCallback } from "react";

export interface VideoSyncControls {
  onPlay: (captureTime: number) => void;
  onPause: () => void;
  onSeek: (captureTime: number) => void;
}

export function useVideoSync(
  videoRef: React.RefObject<HTMLVideoElement | null>
): VideoSyncControls {
  const onPlay = useCallback((captureTime: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = captureTime;
    video.playbackRate = 1;
    video.play().catch(() => {});
  }, [videoRef]);

  const onPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
  }, [videoRef]);

  const onSeek = useCallback((captureTime: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = captureTime;
  }, [videoRef]);

  return { onPlay, onPause, onSeek };
}
