// Joint names matching Apple Vision Pro HandAnchor skeleton.
// Order here defines the index used throughout the pipeline.
export const HAND_JOINT_NAMES = [
  "thumbKnuckle",
  "thumbIntermediateBase",
  "thumbIntermediateTip",
  "thumbTip",
  "indexFingerMetacarpal",
  "indexFingerKnuckle",
  "indexFingerIntermediateBase",
  "indexFingerIntermediateTip",
  "indexFingerTip",
  "middleFingerMetacarpal",
  "middleFingerKnuckle",
  "middleFingerIntermediateBase",
  "middleFingerIntermediateTip",
  "middleFingerTip",
  "ringFingerMetacarpal",
  "ringFingerKnuckle",
  "ringFingerIntermediateBase",
  "ringFingerIntermediateTip",
  "ringFingerTip",
  "littleFingerMetacarpal",
  "littleFingerKnuckle",
  "littleFingerIntermediateBase",
  "littleFingerIntermediateTip",
  "littleFingerTip",
  "forearmWrist",
  "forearmArm",
] as const;

export type HandJointName = typeof HAND_JOINT_NAMES[number];
export const JOINT_COUNT = HAND_JOINT_NAMES.length; // 26

// World-space pose for a single joint: position (meters) + quaternion (xyzw).
export interface JointPose {
  px: number; py: number; pz: number;  // position
  qx: number; qy: number; qz: number; qw: number;  // rotation
}

// One hand's pose: array of 26 joint poses, indexed by HAND_JOINT_NAMES order.
export type HandPose = JointPose[];

export interface CaptureMetadata {
  filename: string;
  duration: number;    // seconds
  frameRate: number;   // frames per second
  frameCount: number;
}

// World-space pose of the AVP headset (device_pose.csv).
export interface DevicePose {
  timestamp: number;  // t_mono
  x: number; y: number; z: number;           // position (meters)
  qx: number; qy: number; qz: number; qw: number; // orientation
}

export interface CaptureFrame {
  index: number;
  timestamp: number;   // seconds since session start (t_mono)
  leftHand: HandPose | null;
  rightHand: HandPose | null;
  devicePose: DevicePose | null;  // headset pose at this timestamp (interpolated)
}

export interface ParsedCapture {
  metadata: CaptureMetadata;
  frames: CaptureFrame[];
  audio: Blob | null;
  transcript: string | null;
}
