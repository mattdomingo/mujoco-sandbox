"use client";
import type { TranscriptSegment } from "@/lib/pkg/types";

interface ClosedCaptionsProps {
  segments: TranscriptSegment[];
  captureTimeSec: number;
  visible: boolean;
}

function findActiveSegment(segments: TranscriptSegment[], t: number): TranscriptSegment | null {
  for (const seg of segments) {
    if (t >= seg.startSec && t < seg.endSec) return seg;
    if (seg.startSec > t) break;
  }
  return null;
}

export default function ClosedCaptions({ segments, captureTimeSec, visible }: ClosedCaptionsProps) {
  if (!visible) return null;
  const active = findActiveSegment(segments, captureTimeSec);
  if (!active) return null;
  return (
    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 max-w-xl px-4 py-2
                    bg-black/70 backdrop-blur-sm rounded-lg text-center pointer-events-none">
      <p className="text-white text-sm leading-snug select-none">{active.text}</p>
    </div>
  );
}
