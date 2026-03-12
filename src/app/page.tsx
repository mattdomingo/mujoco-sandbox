"use client";

import { useState } from "react";
import type { ParsedCapture } from "@/lib/pkg/types";
import PkgDropzone from "@/components/PkgDropzone";
import CaptureViewer from "@/components/CaptureViewer";
import MetadataPanel from "@/components/MetadataPanel";

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
      <CaptureViewer capture={capture} />
      <MetadataPanel capture={capture} />
    </main>
  );
}
