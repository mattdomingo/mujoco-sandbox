/**
 * Background IK computation for the humanoid model.
 *
 * Coordinate systems
 * ──────────────────
 * AVP / Three.js world: Y-up.  Head at rest faces -Z.  Right = +X.  Up = +Y.
 * MuJoCo humanoid:      Z-up.  Torso at rest faces +X.  Right = -Y. Up = +Z.
 *
 * BASE_ROTATION maps the Z-up humanoid neutral pose to Y-up world:
 *   Rx(-90°) first, then Ry(+90°):  ry.multiply(rx)  in THREE convention.
 * Verified: +X(fwd)→-Z, +Z(up)→+Y, -Y(right)→+X.
 *
 * Torso position
 * ──────────────
 * The AVP device pose is at eye level. The torso centre is offset from the
 * head by rotating a fixed body-offset vector by the head orientation, so
 * when the user pitches forward the torso follows naturally.
 *
 * Elbow from AVP data
 * ───────────────────
 * The AVP skeleton provides forearmArm (index 25) — a measured point on the
 * upper forearm, close to the elbow. We use this as the elbow pole-vector hint
 * so the IK reflects real captured arm posture rather than guessing.
 *
 * Processed in 50-frame batches via setTimeout to keep the main thread free.
 */

import * as THREE from "three";
import type { ArmInputTracking, CaptureFrame, HumanoidFrame, JointPose } from "@/lib/pkg/types";
import { HAND_JOINT_NAMES } from "@/lib/pkg/types";
import { solveArmIK, R_SHOULDER_LOCAL, L_SHOULDER_LOCAL } from "./ik";

const BATCH_SIZE = 50;
const IK_SMOOTH_ALPHA = 0.4; // 0 = frozen, 1 = no filter

function smoothAngle(current: number, prev: number): number {
  return prev + IK_SMOOTH_ALPHA * (current - prev);
}

const WRIST_IDX   = HAND_JOINT_NAMES.indexOf("forearmWrist"); // 24
const FOREARM_IDX = HAND_JOINT_NAMES.indexOf("forearmArm");  // 25

// ── Base rotation: Z-up humanoid neutral → Y-up world ──────────────────────
const _rx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _ry = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0),  Math.PI / 2);
// Apply Rx first, then Ry:  BASE = Ry * Rx  (THREE right-to-left)
const BASE_ROTATION = _ry.clone().multiply(_rx);

// ── Torso offset from head in head-local space ────────────────────────────
// The torso centre is approximately 0.25 m below the head along the head's
// down axis and 0.05 m behind (toward the back of the head). Rotating this
// by the head orientation places the torso correctly when the user pitches.
// Head-local: down = -Y (0, -1, 0), behind = +Z (0, 0, 1) in AVP head frame.
const TORSO_OFFSET_HEAD_LOCAL = new THREE.Vector3(0, -0.25, 0.05);

// Scratch objects
const _headQuat   = new THREE.Quaternion();
const _yawQuat    = new THREE.Quaternion();
const _torsoOffset = new THREE.Vector3();
const _refYawQuat = new THREE.Quaternion();

/**
 * Compute the shoulder-alignment yaw from the left→right wrist vector.
 *
 * After BASE_ROTATION, the humanoid's shoulder line is along world +X.
 * Ry(θ) rotates +X to (cos θ, 0, −sin θ).
 * To align with wrist line (dx, 0, dz), we need:
 *   cos θ = dx/len,  −sin θ = dz/len  →  θ = atan2(−dz, dx)
 *
 * Returns null if either wrist is missing or the vector is degenerate.
 */
function computeHandMidpointYaw(
  leftWrist: JointPose | null | undefined,
  rightWrist: JointPose | null | undefined
): number | null {
  if (!leftWrist || !rightWrist) return null;
  const dx = rightWrist.px - leftWrist.px;
  const dz = rightWrist.pz - leftWrist.pz;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-4) return null;
  return Math.atan2(-dz, dx);
}

/**
 * Build torso world position from head pose.
 * Rotates a fixed head-local offset by the head orientation so the torso
 * follows head pitch/lean, not just horizontal position.
 */
function buildTorsoPos(
  headX: number, headY: number, headZ: number,
  qx: number, qy: number, qz: number, qw: number
): [number, number, number] {
  _headQuat.set(qx, qy, qz, qw).normalize();
  _torsoOffset.copy(TORSO_OFFSET_HEAD_LOCAL).applyQuaternion(_headQuat);
  return [headX + _torsoOffset.x, headY + _torsoOffset.y, headZ + _torsoOffset.z];
}

/**
 * Build the torso quaternion from a pre-computed absolute shoulder yaw.
 * Used when shoulder yaw comes from hand midpoint rather than head gaze.
 */
function buildTorsoQuatFromYaw(
  absoluteYaw: number,
  refYaw: number
): [number, number, number, number] {
  const relYaw = absoluteYaw - refYaw;
  _yawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), relYaw);
  const result = _yawQuat.clone().multiply(BASE_ROTATION);
  return [result.w, result.x, result.y, result.z];
}

/**
 * Build the head quaternion (wxyz) in Y-up world space, relative to refYaw.
 * This is the full AVP head orientation — pitch + yaw + roll — for Three.js display.
 * Does NOT apply BASE_ROTATION (this is Three.js, not MuJoCo).
 */
function buildHeadQuat(
  qx: number, qy: number, qz: number, qw: number,
  refYaw: number
): [number, number, number, number] {
  _headQuat.set(qx, qy, qz, qw).normalize();
  _refYawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -refYaw);
  const result = _refYawQuat.clone().multiply(_headQuat);
  return [result.w, result.x, result.y, result.z];
}

const baseWXYZ: [number, number, number, number] = [
  BASE_ROTATION.w, BASE_ROTATION.x, BASE_ROTATION.y, BASE_ROTATION.z,
];

export interface ResolvedArmState {
  shoulder1: number;
  shoulder2: number;
  elbow: number;
  reachable: boolean;
  trackedDataValid: boolean;
  shoulder1Clamped: boolean;
  shoulder2Clamped: boolean;
  elbowClamped: boolean;
}

const NEUTRAL_ARM_STATE: ResolvedArmState = {
  shoulder1: 0,
  shoulder2: 0,
  elbow: 0,
  reachable: false,
  trackedDataValid: false,
  shoulder1Clamped: false,
  shoulder2Clamped: false,
  elbowClamped: false,
};

function freezeArmState(previous?: ResolvedArmState): ResolvedArmState {
  const frozen = previous ?? NEUTRAL_ARM_STATE;
  return {
    shoulder1: frozen.shoulder1,
    shoulder2: frozen.shoulder2,
    elbow: frozen.elbow,
    reachable: false,
    trackedDataValid: false,
    shoulder1Clamped: false,
    shoulder2Clamped: false,
    elbowClamped: false,
  };
}

function poseToWorldTuple(pose: JointPose): [number, number, number] {
  return [pose.px, pose.py, pose.pz];
}

export function resolveTrackedArmSide(
  torsoPos: [number, number, number],
  torsoQuat: [number, number, number, number],
  shoulderLocalPos: [number, number, number],
  wristPose: JointPose | null | undefined,
  elbowHintPose: JointPose | null | undefined,
  inputTracking: ArmInputTracking,
  side: "right" | "left",
  previous?: ResolvedArmState
): ResolvedArmState {
  const trackedDataValid =
    inputTracking.wristTracked &&
    inputTracking.elbowHintTracked &&
    wristPose !== null &&
    wristPose !== undefined &&
    elbowHintPose !== null &&
    elbowHintPose !== undefined;

  if (!trackedDataValid) {
    return freezeArmState(previous);
  }

  const ik = solveArmIK(
    torsoPos,
    torsoQuat,
    shoulderLocalPos,
    poseToWorldTuple(wristPose),
    side,
    poseToWorldTuple(elbowHintPose)
  );

  return {
    shoulder1: previous ? smoothAngle(ik.shoulder1, previous.shoulder1) : ik.shoulder1,
    shoulder2: previous ? smoothAngle(ik.shoulder2, previous.shoulder2) : ik.shoulder2,
    elbow:     previous ? smoothAngle(ik.elbow,     previous.elbow)     : ik.elbow,
    reachable: ik.reachable,
    trackedDataValid: true,
    shoulder1Clamped: ik.shoulder1Clamped,
    shoulder2Clamped: ik.shoulder2Clamped,
    elbowClamped: ik.elbowClamped,
  };
}

export function computeHumanoidIKBackground(
  frames: CaptureFrame[],
  onProgress: (solved: number, total: number) => void,
  onComplete: (humanoidFrames: HumanoidFrame[]) => void
): () => void {
  let cancelled = false;
  let solved = 0;
  const results: HumanoidFrame[] = [];
  let prevRight: ResolvedArmState | undefined;
  let prevLeft: ResolvedArmState | undefined;
  const total = frames.length;

  // No refYaw subtraction needed — computeHandMidpointYaw returns the absolute
  // yaw angle that aligns the shoulder line with the wrist-to-wrist direction.
  // Ry(absoluteYaw) × BASE_ROTATION places shoulders correctly in world space.
  const refYaw = 0;

  let prevShoulderYaw: number = refYaw;

  function processBatch() {
    const end = Math.min(solved + BATCH_SIZE, total);

    for (let i = solved; i < end; i++) {
      const frame = frames[i];
      const dp = frame.devicePose;

      // Torso position: derived from head pose with pitch-aware offset
      const torsoPos: [number, number, number] = dp
        ? buildTorsoPos(dp.x, dp.y, dp.z, dp.qx, dp.qy, dp.qz, dp.qw)
        : [0, 1.0, 0];

      // Arm-driving inputs come only from tracked forearmWrist + forearmArm.
      // Interpolated hand poses still render, but they do not drive humanoid IK.
      const rWrist = frame.rightHand?.[WRIST_IDX] ?? null;
      const lWrist = frame.leftHand?.[WRIST_IDX] ?? null;

      // Shoulder yaw from hand midpoint direction; fall back to last known value
      const currentHandYaw = computeHandMidpointYaw(lWrist, rWrist);
      const shoulderYaw = currentHandYaw !== null ? currentHandYaw : prevShoulderYaw;
      if (currentHandYaw !== null) prevShoulderYaw = currentHandYaw;

      // Torso orientation: upright + shoulder yaw from hand midpoint
      const torsoQuat: [number, number, number, number] = dp
        ? buildTorsoQuatFromYaw(shoulderYaw, refYaw)
        : baseWXYZ;

      // Full head orientation (pitch + yaw + roll) for Three.js head mesh override
      const headQuat: [number, number, number, number] = dp
        ? buildHeadQuat(dp.qx, dp.qy, dp.qz, dp.qw, refYaw)
        : baseWXYZ;
      const rForearm = frame.rightHand?.[FOREARM_IDX] ?? null;
      const lForearm = frame.leftHand?.[FOREARM_IDX] ?? null;

      const rInput = frame.rightArmInput ?? {
        wristTracked: rWrist !== null,
        elbowHintTracked: rForearm !== null,
      };
      const lInput = frame.leftArmInput ?? {
        wristTracked: lWrist !== null,
        elbowHintTracked: lForearm !== null,
      };

      const rResolved = resolveTrackedArmSide(
        torsoPos,
        torsoQuat,
        R_SHOULDER_LOCAL,
        rWrist,
        rForearm,
        rInput,
        "right",
        prevRight
      );
      const lResolved = resolveTrackedArmSide(
        torsoPos,
        torsoQuat,
        L_SHOULDER_LOCAL,
        lWrist,
        lForearm,
        lInput,
        "left",
        prevLeft
      );

      prevRight = rResolved;
      prevLeft = lResolved;

      results.push({
        frameIndex: frame.index,
        torsoPos,
        torsoQuat,
        headQuat,
        arms: {
          rShoulder1: rResolved.shoulder1,
          rShoulder2: rResolved.shoulder2,
          rElbow:     rResolved.elbow,
          rReachable: rResolved.reachable,
          rTrackedDataValid: rResolved.trackedDataValid,
          lShoulder1: lResolved.shoulder1,
          lShoulder2: lResolved.shoulder2,
          lElbow:     lResolved.elbow,
          lReachable: lResolved.reachable,
          lTrackedDataValid: lResolved.trackedDataValid,
          rShoulder1Clamped: rResolved.shoulder1Clamped,
          rShoulder2Clamped: rResolved.shoulder2Clamped,
          rElbowClamped:     rResolved.elbowClamped,
          lShoulder1Clamped: lResolved.shoulder1Clamped,
          lShoulder2Clamped: lResolved.shoulder2Clamped,
          lElbowClamped:     lResolved.elbowClamped,
        },
      });
    }

    solved = end;
    onProgress(solved, total);

    if (!cancelled && solved < total) {
      setTimeout(processBatch, 0);
    } else if (!cancelled) {
      onComplete(results);
    }
  }

  setTimeout(processBatch, 0);
  return () => { cancelled = true; };
}
