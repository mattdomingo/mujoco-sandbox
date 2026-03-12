import type { ParsedCapture, CaptureFrame, HandPose, JointPose } from "./types";
import { HAND_JOINT_NAMES, JOINT_COUNT } from "./types";

// Parse a JointPose from a CSV row given a column index map and joint name.
// Returns null if any expected column is missing.
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

// Parse hand_pose_world.csv text into a map of timestamp → { left, right }.
function parseCsv(csv: string): Map<number, { left: HandPose | null; right: HandPose | null }> {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return new Map();

  // Build column index map from header
  const headers = lines[0].split(",").map(h => h.trim());
  const colIndex = new Map<string, number>();
  headers.forEach((h, i) => colIndex.set(h, i));

  const tMonoIdx = colIndex.get("t_mono")!;
  const chiralityIdx = colIndex.get("chirality")!;

  const frameMap = new Map<number, { left: HandPose | null; right: HandPose | null }>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const row = line.split(",");
    const tMono = parseFloat(row[tMonoIdx]);
    const chirality = row[chiralityIdx]?.trim();
    if (isNaN(tMono) || (chirality !== "left" && chirality !== "right")) continue;

    // Parse all 26 joint poses for this hand row
    const hand: HandPose = [];
    let valid = true;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const pose = parseJointPose(row, colIndex, HAND_JOINT_NAMES[j]);
      if (!pose) { valid = false; break; }
      hand.push(pose);
    }
    if (!valid) continue;

    // Group left and right rows by t_mono timestamp
    if (!frameMap.has(tMono)) {
      frameMap.set(tMono, { left: null, right: null });
    }
    const entry = frameMap.get(tMono)!;
    if (chirality === "left")  entry.left  = hand;
    if (chirality === "right") entry.right = hand;
  }

  return frameMap;
}

export async function parsePkg(file: File): Promise<ParsedCapture> {
  // .capture files arrive from the browser as a ZIP (when the user zips the
  // directory before uploading) or as a flat File object. The scaffold
  // currently receives a single File — this will be revisited when the
  // upload flow is finalized. For now we parse whatever text content we can.
  //
  // TODO: finalize upload strategy (zip vs directory picker vs API download)
  //       and implement ZIP extraction with jszip if needed.

  // For development: read the file as text and attempt CSV parse directly.
  // This works if the file IS the hand_pose_world.csv (useful for testing).
  const text = await file.text();

  const frameMap = parseCsv(text);
  const timestamps = Array.from(frameMap.keys()).sort((a, b) => a - b);

  const frames: CaptureFrame[] = timestamps.map((t, idx) => {
    const entry = frameMap.get(t)!;
    return {
      index: idx,
      timestamp: t,
      leftHand: entry.left,
      rightHand: entry.right,
    };
  });

  const frameRate = frames.length > 1
    ? 1 / (frames[1].timestamp - frames[0].timestamp)
    : 60;

  return {
    metadata: {
      filename: file.name,
      duration: frames.length > 0 ? frames[frames.length - 1].timestamp - frames[0].timestamp : 0,
      frameRate: Math.round(frameRate),
      frameCount: frames.length,
    },
    frames,
    audio: null,      // TODO: extract from zip when upload flow is finalized
    transcript: null, // TODO: extract from zip when upload flow is finalized
  };
}
