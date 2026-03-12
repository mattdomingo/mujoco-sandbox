"use client";

import type { ParsedCapture } from "@/lib/pkg/types";

interface MetadataPanelProps {
  capture: ParsedCapture | null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-zinc-500 uppercase tracking-wider">{label}</span>
      <span className="text-sm text-zinc-200 font-mono">{value}</span>
    </div>
  );
}

export default function MetadataPanel({ capture }: MetadataPanelProps) {
  if (!capture) {
    return (
      <aside className="w-80 bg-zinc-900 border-l border-zinc-800 flex items-center justify-center">
        <p className="text-xs text-zinc-600">No capture loaded</p>
      </aside>
    );
  }

  const { metadata } = capture;

  return (
    <aside className="w-80 bg-zinc-900 border-l border-zinc-800 flex flex-col overflow-y-auto">
      <div className="px-4 py-3 border-b border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-300">Capture Info</h2>
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        <Row label="File" value={metadata.filename} />
        <Row label="Duration" value={`${metadata.duration.toFixed(2)}s`} />
        <Row label="Frame Rate" value={`${metadata.frameRate} fps`} />
        <Row label="Frames" value={String(metadata.frameCount)} />
        <Row label="Audio" value={capture.audio ? "Present" : "None"} />
      </div>

      {/* TODO: Display timecoded transcript */}
      {/* Each entry from timecoded_transcript.json has: isFinal, text, tokens[{startSec, endSec, text}] */}
      {capture.transcript && (
        <div className="flex flex-col gap-2 px-4 pb-4 border-t border-zinc-800 pt-4">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">Transcript</span>
          <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">
            {capture.transcript}
          </p>
        </div>
      )}
    </aside>
  );
}
