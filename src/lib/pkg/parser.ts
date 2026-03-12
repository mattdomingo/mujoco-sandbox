import type { ParsedCapture } from "./types";

export async function parsePkg(file: File): Promise<ParsedCapture> {
  // TODO: Use jszip to unzip the .pkg file (it's a standard ZIP archive)
  // TODO: Parse metadata/metadata.json — extract start_uptime, start_wall, world_anchor
  // TODO: Parse tracking/hand_pose_world.csv into CaptureFrame[]
  //       Columns: t_mono, t_wall, chirality, then x,y,z per joint
  //       Split rows by chirality ("left" / "right"), group by t_mono into frames
  //       Pack joint positions into Float32Array for leftHand and rightHand
  // TODO: Extract audio/audio.wav as a Blob (type: "audio/wav")
  // TODO: Parse transcripts/timecoded_transcript.json — array of { isFinal, text, tokens }
  //       Concatenate all final segment texts into a single transcript string
  throw new Error("parsePkg not yet implemented");
}
