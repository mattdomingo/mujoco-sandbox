export interface CaptureMetadata {
  filename: string;
  duration: number;       // seconds
  frameRate: number;      // frames per second
  frameCount: number;
}

export interface CaptureFrame {
  index: number;
  timestamp: number;      // seconds since session start
  leftHand: Float32Array;
  rightHand: Float32Array;
}

export interface ParsedCapture {
  metadata: CaptureMetadata;
  frames: CaptureFrame[];
  audio: Blob | null;
  transcript: string | null;
}
