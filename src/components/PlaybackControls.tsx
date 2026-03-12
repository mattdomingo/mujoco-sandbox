"use client";

import type { PlaybackState, PlaybackControls } from "@/hooks/usePlayback";

const SPEEDS = [0.25, 0.5, 1, 2];

interface PlaybackControlsProps {
  state: PlaybackState;
  controls: PlaybackControls;
  frameCount: number;
  frameRate: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

export default function PlaybackControlsPanel({
  state,
  controls,
  frameCount,
  frameRate,
}: PlaybackControlsProps) {
  const currentTime = state.frameIndex / frameRate;
  const totalTime = (frameCount - 1) / frameRate;

  return (
    <div className="flex flex-col gap-3 px-4 py-3 bg-zinc-900 border-t border-zinc-800">
      {/* Scrubber */}
      <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
        <span className="w-12 text-right">{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={frameCount - 1}
          value={state.frameIndex}
          onChange={(e) => controls.seek(Number(e.target.value))}
          className="flex-1 h-1 accent-blue-500 cursor-pointer"
        />
        <span className="w-12">{formatTime(totalTime)}</span>
      </div>

      {/* Controls row */}
      <div className="flex items-center justify-between">
        {/* Play / Pause */}
        <button
          onClick={state.isPlaying ? controls.pause : controls.play}
          className="w-9 h-9 flex items-center justify-center rounded-full bg-zinc-700 hover:bg-zinc-600 transition-colors"
          aria-label={state.isPlaying ? "Pause" : "Play"}
        >
          {state.isPlaying ? (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M5 3.868v16.264c0 .975 1.086 1.54 1.89.986l12.795-8.132a1.2 1.2 0 000-1.972L6.89 2.882C6.086 2.328 5 2.893 5 3.868z" />
            </svg>
          )}
        </button>

        {/* Speed selector */}
        <div className="flex items-center gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => controls.setSpeed(s)}
              className={[
                "px-2 py-1 rounded text-xs font-mono transition-colors",
                state.speed === s
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700",
              ].join(" ")}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
