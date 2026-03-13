import type { ParsedCapture, CaptureFrame, HandPose, JointPose, DevicePose } from "./types";
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
// Device pose parsing + interpolation
// ---------------------------------------------------------------------------

function parseDevicePoseCsv(csv: string): DevicePose[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const tIdx = col("t_mono");
  const xIdx = col("x"), yIdx = col("y"), zIdx = col("z");
  const qxIdx = col("qx"), qyIdx = col("qy"), qzIdx = col("qz"), qwIdx = col("qw");

  const poses: DevicePose[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].trim().split(",");
    if (row.length < 8) continue;
    const timestamp = parseFloat(row[tIdx]);
    const x = parseFloat(row[xIdx]), y = parseFloat(row[yIdx]), z = parseFloat(row[zIdx]);
    const qx = parseFloat(row[qxIdx]), qy = parseFloat(row[qyIdx]);
    const qz = parseFloat(row[qzIdx]), qw = parseFloat(row[qwIdx]);
    if ([timestamp, x, y, z, qx, qy, qz, qw].some(isNaN)) continue;
    poses.push({ timestamp, x, y, z, qx, qy, qz, qw });
  }
  return poses;
}

// Linear interpolation of device poses sorted by timestamp.
// For each frame timestamp, finds the two nearest device poses and lerps between them.
function interpolateDevicePoses(poses: DevicePose[], timestamps: number[]): (DevicePose | null)[] {
  if (poses.length === 0) return timestamps.map(() => null);

  return timestamps.map((t) => {
    // Binary search for the first pose with timestamp >= t
    let lo = 0, hi = poses.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (poses[mid].timestamp < t) lo = mid + 1;
      else hi = mid;
    }

    if (lo === 0) return poses[0];
    if (lo >= poses.length) return poses[poses.length - 1];

    const a = poses[lo - 1];
    const b = poses[lo];
    const range = b.timestamp - a.timestamp;
    const alpha = range < 1e-9 ? 0 : (t - a.timestamp) / range;

    const lerp = (v0: number, v1: number) => v0 + (v1 - v0) * alpha;

    return {
      timestamp: t,
      x:  lerp(a.x,  b.x),
      y:  lerp(a.y,  b.y),
      z:  lerp(a.z,  b.z),
      qx: lerp(a.qx, b.qx),
      qy: lerp(a.qy, b.qy),
      qz: lerp(a.qz, b.qz),
      qw: lerp(a.qw, b.qw),
    };
  });
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
// Hand pose interpolation helpers
// ---------------------------------------------------------------------------

function lerpJoint(a: JointPose, b: JointPose, t: number): JointPose {
  const lerp = (v0: number, v1: number) => v0 + (v1 - v0) * t;
  return {
    px: lerp(a.px, b.px), py: lerp(a.py, b.py), pz: lerp(a.pz, b.pz),
    qx: lerp(a.qx, b.qx), qy: lerp(a.qy, b.qy), qz: lerp(a.qz, b.qz), qw: lerp(a.qw, b.qw),
  };
}

function lerpHandPose(a: HandPose, b: HandPose, t: number): HandPose {
  return a.map((joint, i) => lerpJoint(joint, b[i], t));
}

/**
 * Fill gaps in a sparse array of hand poses using linear interpolation.
 * Entries that are null represent frames where tracking was lost.
 * Each null run is filled by lerping between the last known pose before
 * the gap and the first known pose after it, so the hand moves smoothly
 * through the gap instead of freezing.
 *
 * Frames before the first valid pose or after the last valid pose are
 * filled with the nearest boundary pose (hold, no extrapolation).
 */
function interpolateHandPoses(poses: (HandPose | null)[]): (HandPose | null)[] {
  const result = poses.slice();
  const n = result.length;

  // Find first and last valid indices
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) if (result[i]) { if (first < 0) first = i; last = i; }
  if (first < 0) return result; // all null — nothing to do

  // Hold first pose backward to frame 0
  for (let i = 0; i < first; i++) result[i] = result[first];

  // Hold last pose forward to end
  for (let i = last + 1; i < n; i++) result[i] = result[last];

  // Lerp across interior gaps
  let gapStart = -1;
  for (let i = first; i <= last; i++) {
    if (result[i] === null && gapStart < 0) {
      gapStart = i;
    } else if (result[i] !== null && gapStart >= 0) {
      // Gap runs from gapStart to i-1; anchor poses are at gapStart-1 and i
      const before = result[gapStart - 1]!;
      const after  = result[i]!;
      const span   = i - gapStart + 1; // total steps including endpoints
      for (let j = gapStart; j < i; j++) {
        result[j] = lerpHandPose(before, after, (j - gapStart + 1) / span);
      }
      gapStart = -1;
    }
  }

  return result;
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

  // Parse device pose CSV — optional, used for camera follow
  let devicePoses: (DevicePose | null)[] = timestamps.map(() => null);
  const deviceFile = findFile(files, "tracking/device_pose.csv");
  if (deviceFile) {
    try {
      const rawPoses = parseDevicePoseCsv(await deviceFile.text());
      devicePoses = interpolateDevicePoses(rawPoses, timestamps);
    } catch { /* non-fatal */ }
  }

  // Left and right rows arrive at slightly different t_mono values, so most
  // entries have only one hand. Build sparse arrays then interpolate across
  // gaps so hands move smoothly through tracking drop-outs instead of freezing.
  const rawLeft:  (HandPose | null)[] = timestamps.map(t => frameMap.get(t)!.left);
  const rawRight: (HandPose | null)[] = timestamps.map(t => frameMap.get(t)!.right);
  const interpLeft  = interpolateHandPoses(rawLeft);
  const interpRight = interpolateHandPoses(rawRight);

  const frames: CaptureFrame[] = timestamps.map((t, idx) => ({
    index: idx,
    timestamp: t,
    leftHand:  interpLeft[idx],
    rightHand: interpRight[idx],
    devicePose: devicePoses[idx],
  }));

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

  // video/camera_left.mov — optional
  const videoFile = findFile(files, "video/camera_left.mov");

  return {
    metadata: { filename, duration, frameRate: Math.round(frameRate), frameCount: frames.length },
    frames,
    audio,
    transcript,
    video: videoFile ?? null,
  };
}
