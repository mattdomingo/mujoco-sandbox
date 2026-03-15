"use client";
import { useCallback } from "react";

export interface AudioSyncControls {
  onPlay: (captureTime: number) => void;
  onPause: () => void;
  onSeek: (captureTime: number) => void;
}

export function useAudioSync(
  audioRef: React.RefObject<HTMLAudioElement | null>
): AudioSyncControls {
  const onPlay = useCallback((captureTime: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = captureTime;
    audio.playbackRate = 1;
    audio.play().catch(() => {});
  }, [audioRef]);

  const onPause = useCallback(() => {
    audioRef.current?.pause();
  }, [audioRef]);

  const onSeek = useCallback((captureTime: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = captureTime;
  }, [audioRef]);

  return { onPlay, onPause, onSeek };
}
