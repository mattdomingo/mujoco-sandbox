"use client";

import { useRef, useState, useCallback } from "react";
import { parseCapture } from "@/lib/pkg/parser";
import type { ParsedCapture } from "@/lib/pkg/types";

interface PkgDropzoneProps {
  onLoad: (capture: ParsedCapture) => void;
}

// Recursively read all files out of a DataTransferItem directory entry,
// returning them as a synthetic FileList-compatible array.
async function readDirectoryEntry(entry: FileSystemDirectoryEntry): Promise<File[]> {
  return new Promise((resolve) => {
    const files: File[] = [];
    const reader = entry.createReader();

    const readBatch = () => {
      reader.readEntries(async (entries) => {
        if (entries.length === 0) { resolve(files); return; }

        for (const e of entries) {
          if (e.isFile) {
            const file = await new Promise<File>((res) =>
              (e as FileSystemFileEntry).file((f) => {
                // Attach a synthetic webkitRelativePath so findFile() works
                Object.defineProperty(f, "webkitRelativePath", {
                  value: e.fullPath.replace(/^\//, ""),
                  writable: false,
                });
                res(f);
              })
            );
            files.push(file);
          } else if (e.isDirectory) {
            const nested = await readDirectoryEntry(e as FileSystemDirectoryEntry);
            files.push(...nested);
          }
        }
        readBatch(); // readEntries returns at most 100 entries — loop until done
      });
    };

    readBatch();
  });
}

// Convert a plain File[] into something that satisfies the FileList interface
// (length + indexed access), since parseCapture expects FileList.
function toFileList(files: File[]): FileList {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  return dt.files;
}

export default function PkgDropzone({ onLoad }: PkgDropzoneProps) {
  const [isDragging, setIsDragging]   = useState(false);
  const [isLoading, setIsLoading]     = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const folderInputRef                = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList) => {
      setError(null);
      setIsLoading(true);
      try {
        const capture = await parseCapture(files);
        onLoad(capture);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to parse capture.");
      } finally {
        setIsLoading(false);
      }
    },
    [onLoad]
  );

  // Drag-and-drop: use DataTransferItem API to traverse the dropped directory
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const items = Array.from(e.dataTransfer.items);
      const allFiles: File[] = [];

      for (const item of items) {
        const entry = item.webkitGetAsEntry?.();
        if (!entry) continue;

        if (entry.isDirectory) {
          const nested = await readDirectoryEntry(entry as FileSystemDirectoryEntry);
          allFiles.push(...nested);
        } else if (entry.isFile) {
          const file = await new Promise<File>((res) =>
            (entry as FileSystemFileEntry).file(res)
          );
          allFiles.push(file);
        }
      }

      if (allFiles.length === 0) {
        setError("Nothing readable was dropped.");
        return;
      }

      handleFiles(toFileList(allFiles));
    },
    [handleFiles]
  );

  const onDragOver  = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);

  // Click-to-browse: folder picker via webkitdirectory
  const onFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) handleFiles(e.target.files);
  };

  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onClick={() => !isLoading && folderInputRef.current?.click()}
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
      {/* Folder picker — webkitdirectory lets the user select a whole folder */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error — webkitdirectory is not in React's HTMLInputElement types
        webkitdirectory=""
        multiple
        className="hidden"
        onChange={onFolderChange}
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
              Drop a .capture folder here
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
