import type { ParsedCapture, CaptureFrame, HandPose, JointPose } from "./types";
import { HAND_JOINT_NAMES, JOINT_COUNT } from "./types";

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function parseJointPose(
  row: string[],
  colIndex: Map<string, number>,
  jointName: string
): JointPose | null {
  const get = (suffix: string) => {
    const idx = colIndex.get(`${jointName}_${suffix}`);
    return idx !== undefined ? parseFloat(row[idx]) : NaN;
  };
  const px = get("px"), py = get("py"), pz = get("pz");
  const qx = get("qx"), qy = get("qy"), qz = get("qz"), qw = get("qw");
  if ([px, py, pz, qx, qy, qz, qw].some(isNaN)) return null;
  return { px, py, pz, qx, qy, qz, qw };
}

function parseCsv(csv: string): Map<number, { left: HandPose | null; right: HandPose | null }> {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return new Map();

  const headers = lines[0].split(",").map(h => h.trim());
  const colIndex = new Map<string, number>();
  headers.forEach((h, i) => colIndex.set(h, i));

  const tMonoIdx    = colIndex.get("t_mono")!;
  const chiralityIdx = colIndex.get("chirality")!;

  const frameMap = new Map<number, { left: HandPose | null; right: HandPose | null }>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const row = line.split(",");
    const tMono    = parseFloat(row[tMonoIdx]);
    const chirality = row[chiralityIdx]?.trim();
    if (isNaN(tMono) || (chirality !== "left" && chirality !== "right")) continue;

    const hand: HandPose = [];
    let valid = true;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const pose = parseJointPose(row, colIndex, HAND_JOINT_NAMES[j]);
      if (!pose) { valid = false; break; }
      hand.push(pose);
    }
    if (!valid) continue;

    if (!frameMap.has(tMono)) frameMap.set(tMono, { left: null, right: null });
    const entry = frameMap.get(tMono)!;
    if (chirality === "left")  entry.left  = hand;
    if (chirality === "right") entry.right = hand;
  }

  return frameMap;
}

// ---------------------------------------------------------------------------
// File list helpers
// ---------------------------------------------------------------------------

// Find a file within a FileList by matching the end of its webkitRelativePath.
// e.g. findFile(files, "tracking/hand_pose_world.csv")
function findFile(files: FileList, relativePath: string): File | null {
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // webkitRelativePath looks like "capture-name/tracking/hand_pose_world.csv"
    if (f.webkitRelativePath.endsWith(relativePath) || f.name === relativePath) {
      return f;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Parse a .capture directory from a FileList (produced by a folder picker or
// drag-and-drop directory traversal). Requires at minimum hand_pose_world.csv.
export async function parseCapture(files: FileList): Promise<ParsedCapture> {
  const csvFile = findFile(files, "tracking/hand_pose_world.csv");
  if (!csvFile) throw new Error("Could not find tracking/hand_pose_world.csv in the dropped folder.");

  // Parse the CSV into frames
  const csvText  = await csvFile.text();
  const frameMap = parseCsv(csvText);
  const timestamps = Array.from(frameMap.keys()).sort((a, b) => a - b);

  // Left and right rows arrive at slightly different t_mono values, so most
  // entries have only one hand. Carry the last known pose forward so both
  // hands are always present — prevents flickering in the renderer.
  let lastLeft:  HandPose | null = null;
  let lastRight: HandPose | null = null;

  const frames: CaptureFrame[] = timestamps.map((t, idx) => {
    const entry = frameMap.get(t)!;
    if (entry.left)  lastLeft  = entry.left;
    if (entry.right) lastRight = entry.right;
    return { index: idx, timestamp: t, leftHand: lastLeft, rightHand: lastRight };
  });

  const frameRate = frames.length > 1
    ? 1 / (frames[1].timestamp - frames[0].timestamp)
    : 60;

  // metadata.json — optional, used for duration + filename
  let filename = csvFile.webkitRelativePath.split("/")[0] || "capture";
  let duration = frames.length > 0
    ? frames[frames.length - 1].timestamp - frames[0].timestamp
    : 0;

  const metaFile = findFile(files, "metadata/metadata.json");
  if (metaFile) {
    try {
      const meta = JSON.parse(await metaFile.text());
      if (meta.id)       filename = meta.id;
      if (meta.duration) duration = meta.duration;
    } catch { /* ignore malformed metadata */ }
  }

  // audio/audio.wav — optional
  const audioFile = findFile(files, "audio/audio.wav");
  const audio = audioFile ? new Blob([await audioFile.arrayBuffer()], { type: "audio/wav" }) : null;

  // transcripts/timecoded_transcript.json — optional
  let transcript: string | null = null;
  const transcriptFile = findFile(files, "transcripts/timecoded_transcript.json");
  if (transcriptFile) {
    try {
      const segments: { isFinal: boolean; text: string }[] = JSON.parse(await transcriptFile.text());
      transcript = segments.filter(s => s.isFinal).map(s => s.text).join(" ").trim() || null;
    } catch { /* ignore malformed transcript */ }
  }

  return {
    metadata: { filename, duration, frameRate: Math.round(frameRate), frameCount: frames.length },
    frames,
    audio,
    transcript,
  };
}
