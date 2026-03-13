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
import type { CaptureFrame, HumanoidFrame } from "@/lib/pkg/types";
import { HAND_JOINT_NAMES } from "@/lib/pkg/types";
import { solveArmIK, R_SHOULDER_LOCAL, L_SHOULDER_LOCAL } from "./ik";

const BATCH_SIZE = 50;
const WRIST_IDX    = HAND_JOINT_NAMES.indexOf("forearmWrist"); // 24
const FOREARM_IDX  = HAND_JOINT_NAMES.indexOf("forearmArm");  // 25

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
const _fwd        = new THREE.Vector3();
const _yawQuat    = new THREE.Quaternion();
const _torsoOffset = new THREE.Vector3();

/** Extract horizontal yaw angle (radians) from an AVP device pose quaternion. */
function extractYaw(qx: number, qy: number, qz: number, qw: number): number {
  _headQuat.set(qx, qy, qz, qw).normalize();
  _fwd.set(0, 0, -1).applyQuaternion(_headQuat);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) return 0;
  _fwd.normalize();
  return Math.atan2(_fwd.x, -_fwd.z);
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
 * Build the torso quaternion (wxyz for MuJoCo freejoint qpos).
 * Extracts horizontal yaw relative to the frame-0 reference, then composes
 * with BASE_ROTATION so the humanoid stands upright and faces correctly.
 */
function buildTorsoQuat(
  qx: number, qy: number, qz: number, qw: number,
  refYaw: number
): [number, number, number, number] {
  _headQuat.set(qx, qy, qz, qw).normalize();
  _fwd.set(0, 0, -1).applyQuaternion(_headQuat);
  _fwd.y = 0;

  let yaw: number;
  if (_fwd.lengthSq() < 1e-6) {
    yaw = refYaw;
  } else {
    _fwd.normalize();
    yaw = Math.atan2(_fwd.x, -_fwd.z);
  }

  // Negative because Ry(+θ) rotates humanoid forward rightward, but positive
  // atan2 yaw means the user turned left.
  const relYaw = -(yaw - refYaw);
  _yawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), relYaw);

  const result = _yawQuat.clone().multiply(BASE_ROTATION);
  return [result.w, result.x, result.y, result.z];
}

const baseWXYZ: [number, number, number, number] = [
  BASE_ROTATION.w, BASE_ROTATION.x, BASE_ROTATION.y, BASE_ROTATION.z,
];

export function computeHumanoidIKBackground(
  frames: CaptureFrame[],
  onProgress: (solved: number, total: number) => void,
  onComplete: (humanoidFrames: HumanoidFrame[]) => void
): () => void {
  let cancelled = false;
  let solved = 0;
  const results: HumanoidFrame[] = [];
  const total = frames.length;

  // Reference yaw from first frame that has device pose
  const firstDp = frames.find(f => f.devicePose)?.devicePose ?? null;
  const refYaw = firstDp
    ? extractYaw(firstDp.qx, firstDp.qy, firstDp.qz, firstDp.qw)
    : 0;

  function processBatch() {
    const end = Math.min(solved + BATCH_SIZE, total);

    for (let i = solved; i < end; i++) {
      const frame = frames[i];
      const dp = frame.devicePose;

      // Torso position: derived from head pose with pitch-aware offset
      const torsoPos: [number, number, number] = dp
        ? buildTorsoPos(dp.x, dp.y, dp.z, dp.qx, dp.qy, dp.qz, dp.qw)
        : [0, 1.0, 0];

      // Torso orientation: upright + yaw only
      const torsoQuat: [number, number, number, number] = dp
        ? buildTorsoQuat(dp.qx, dp.qy, dp.qz, dp.qw, refYaw)
        : baseWXYZ;

      // Wrist targets from AVP forearmWrist (index 24)
      const rWrist = frame.rightHand?.[WRIST_IDX];
      const lWrist = frame.leftHand?.[WRIST_IDX];

      const rTarget: [number, number, number] = rWrist
        ? [rWrist.px, rWrist.py, rWrist.pz]
        : [torsoPos[0] + 0.4, torsoPos[1] - 0.2, torsoPos[2]];

      const lTarget: [number, number, number] = lWrist
        ? [lWrist.px, lWrist.py, lWrist.pz]
        : [torsoPos[0] - 0.4, torsoPos[1] - 0.2, torsoPos[2]];

      // Elbow hints from AVP forearmArm (index 25) — real measured elbow region.
      // When present this drives the elbow direction from actual data.
      const rForearm = frame.rightHand?.[FOREARM_IDX];
      const lForearm = frame.leftHand?.[FOREARM_IDX];

      const rElbowHint: [number, number, number] | undefined = rForearm
        ? [rForearm.px, rForearm.py, rForearm.pz]
        : undefined;

      const lElbowHint: [number, number, number] | undefined = lForearm
        ? [lForearm.px, lForearm.py, lForearm.pz]
        : undefined;

      const rIK = solveArmIK(torsoPos, torsoQuat, R_SHOULDER_LOCAL, rTarget, "right", rElbowHint);
      const lIK = solveArmIK(torsoPos, torsoQuat, L_SHOULDER_LOCAL, lTarget, "left",  lElbowHint);

      results.push({
        frameIndex: frame.index,
        torsoPos,
        torsoQuat,
        arms: {
          rShoulder1: rIK.shoulder1,
          rShoulder2: rIK.shoulder2,
          rElbow:     rIK.elbow,
          rReachable: rIK.reachable,
          lShoulder1: lIK.shoulder1,
          lShoulder2: lIK.shoulder2,
          lElbow:     lIK.elbow,
          lReachable: lIK.reachable,
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
