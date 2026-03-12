"use client";

import { useState } from "react";
import type { ParsedCapture } from "@/lib/pkg/types";
import PkgDropzone from "@/components/PkgDropzone";
import CaptureViewer from "@/components/CaptureViewer";
import MetadataPanel from "@/components/MetadataPanel";
import type { PlaybackState, PlaybackControls } from "@/hooks/usePlayback";

// Placeholder state/controls until usePlayback is implemented
const PLACEHOLDER_STATE: PlaybackState = {
  isPlaying: false,
  frameIndex: 0,
  speed: 1,
};

const noop = () => {};

const PLACEHOLDER_CONTROLS: PlaybackControls = {
  play: noop,
  pause: noop,
  seek: noop,
  setSpeed: noop,
};

export default function Home() {
  const [capture, setCapture] = useState<ParsedCapture | null>(null);

  if (!capture) {
    return (
      <main className="h-full flex items-center justify-center bg-zinc-950">
        <div className="flex flex-col items-center gap-6">
          <h1 className="text-xl font-semibold text-zinc-300 tracking-tight">
            Holos Capture Viewer
          </h1>
          <PkgDropzone onLoad={setCapture} />
        </div>
      </main>
    );
  }

  return (
    <main className="h-full flex">
      {/* TODO: Replace placeholder state/controls with usePlayback(capture, onFrame) */}
      <CaptureViewer
        capture={capture}
        playbackState={PLACEHOLDER_STATE}
        playbackControls={PLACEHOLDER_CONTROLS}
      />
      <MetadataPanel capture={capture} />
    </main>
  );
}
