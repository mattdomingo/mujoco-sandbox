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

// World-space pose of a tracked object anchor (object_pose.csv).
export interface ObjectPose {
  t: number;          // t_mono timestamp
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
}

export interface ArmInputTracking {
  wristTracked: boolean;
  elbowHintTracked: boolean;
}

export interface CaptureFrame {
  index: number;
  timestamp: number;   // seconds since session start (t_mono)
  leftHand: HandPose | null;
  rightHand: HandPose | null;
  devicePose: DevicePose | null;  // headset pose at this timestamp (interpolated)
  objectPose?: ObjectPose;        // tracked object pose at this timestamp (interpolated), if present
  leftArmInput: ArmInputTracking;
  rightArmInput: ArmInputTracking;
}

export interface TranscriptToken {
  startSec: number;
  endSec: number;
  text: string;
}

export interface TranscriptSegment {
  text: string;
  tokens: TranscriptToken[];
  startSec: number;   // tokens[0].startSec — denormalized for O(1) range check
  endSec: number;     // tokens[last].endSec
}

export interface ParsedCapture {
  metadata: CaptureMetadata;
  frames: CaptureFrame[];
  audio: Blob | null;
  transcript: TranscriptSegment[] | null;
  video: File | null;   // camera_left.mov
}

// IK-solved hinge angles for both arms of the humanoid (radians).
export interface HumanoidArmAngles {
  rShoulder1: number;
  rShoulder2: number;
  rElbow: number;
  rReachable: boolean;
  rTrackedDataValid: boolean;
  lShoulder1: number;
  lShoulder2: number;
  lElbow: number;
  lReachable: boolean;
  lTrackedDataValid: boolean;
  // Debug flags — true when the raw solve exceeded anatomical clamp
  rShoulder1Clamped: boolean;
  rShoulder2Clamped: boolean;
  rElbowClamped: boolean;
  lShoulder1Clamped: boolean;
  lShoulder2Clamped: boolean;
  lElbowClamped: boolean;
}

// Per-frame humanoid pose: torso driven from devicePose, arms from IK.
export interface HumanoidFrame {
  frameIndex: number;
  torsoPos: [number, number, number];
  torsoQuat: [number, number, number, number]; // wxyz — shoulder yaw + BASE_ROTATION
  headQuat:  [number, number, number, number]; // wxyz — full AVP head orientation relative to refYaw (Y-up world space)
  arms: HumanoidArmAngles;
  abdomenY?: number;  // forward-bend hinge angle (radians); negative = forward flex
}
