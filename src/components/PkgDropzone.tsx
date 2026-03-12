"use client";

import { useRef, useState, useCallback } from "react";
import { parsePkg } from "@/lib/pkg/parser";
import type { ParsedCapture } from "@/lib/pkg/types";

interface PkgDropzoneProps {
  onLoad: (capture: ParsedCapture) => void;
}

export default function PkgDropzone({ onLoad }: PkgDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.endsWith(".pkg") && !file.name.endsWith(".capture")) {
        setError("Please drop a .pkg or .capture file.");
        return;
      }
      setError(null);
      setIsLoading(true);
      try {
        const capture = await parsePkg(file);
        onLoad(capture);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to parse capture file.");
      } finally {
        setIsLoading(false);
      }
    },
    [onLoad]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => setIsDragging(false);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onClick={() => !isLoading && inputRef.current?.click()}
      className={[
        "flex flex-col items-center justify-center gap-4",
        "w-96 h-64 rounded-xl border-2 border-dashed cursor-pointer",
        "transition-colors select-none",
        isDragging
          ? "border-blue-400 bg-blue-950/30"
          : "border-zinc-600 bg-zinc-900 hover:border-zinc-400",
        isLoading ? "cursor-wait opacity-70" : "",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pkg,.capture"
        className="hidden"
        onChange={onInputChange}
      />

      {isLoading ? (
        <>
          <div className="w-8 h-8 rounded-full border-2 border-zinc-500 border-t-blue-400 animate-spin" />
          <p className="text-sm text-zinc-400">Parsing capture…</p>
        </>
      ) : (
        <>
          <svg
            className="w-10 h-10 text-zinc-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
            />
          </svg>
          <div className="text-center">
            <p className="text-sm font-medium text-zinc-200">
              Drop a .pkg file here
            </p>
            <p className="text-xs text-zinc-500 mt-1">or click to browse</p>
          </div>
          {error && (
            <p className="text-xs text-red-400 text-center px-4">{error}</p>
          )}
        </>
      )}
    </div>
  );
}
