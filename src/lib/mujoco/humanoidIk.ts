/**
 * Background IK computation for the humanoid model.
 *
 * Coordinate systems
 * ──────────────────
 * AVP / Three.js world: Y-up.  Head at rest faces  -Z.  Right = +X.  Up = +Y.
 * MuJoCo humanoid:      Z-up.  Torso at rest faces  -Y.  Right = +X.  Up = +Z.
 *
 * The freejoint qpos quaternion rotates the humanoid FROM its Z-up neutral pose
 * TO the desired world orientation.  All IK is solved in AVP Y-up world space
 * using a torsoQuat that carries the correct upright orientation.
 *
 * torsoQuat construction
 * ──────────────────────
 * We want the humanoid to stand upright (Y-up) and face the same horizontal
 * direction as the AVP headset, relative to where it faced at frame 0.
 *
 * Steps:
 *   1. Compute a "stand" quaternion that rotates the Z-up neutral pose to
 *      stand upright in Y-up space: rotate -90° around X  (maps Z→Y).
 *      BUT the neutral humanoid faces -Y (Z-up), which after that rotation
 *      faces -Z in Y-up space.  We want it to face -Z initially (same as the
 *      AVP head at frame 0), so we add a further +90° around Y to make its
 *      neutral facing direction match the AVP reference frame.
 *      Combined base rotation: Ry(+90°) * Rx(-90°)
 *   2. Extract yaw from AVP head quaternion relative to frame-0 head yaw so
 *      the torso rotates only when the user turns their body (use a threshold
 *      to let head-only turns lag the torso).
 *   3. Apply: torsoQuat = Ryaw * BASE_ROTATION
 *
 * Processes capture frames in 50-frame batches via setTimeout so the main
 * thread stays responsive.
 */

import * as THREE from "three";
import type { CaptureFrame, HumanoidFrame } from "@/lib/pkg/types";
import { HAND_JOINT_NAMES } from "@/lib/pkg/types";
import { solveArmIK, R_SHOULDER_LOCAL, L_SHOULDER_LOCAL } from "./ik";

const BATCH_SIZE = 50;
const WRIST_IDX = HAND_JOINT_NAMES.indexOf("forearmWrist");

// ── Base rotation: maps the Z-up neutral humanoid to stand upright in Y-up ──
//
// MuJoCo humanoid neutral pose (Z-up):
//   forward = +X,  up = +Z,  right = -Y
//
// Target Y-up world (AVP / Three.js):
//   forward = -Z,  up = +Y,  right = +X
//
// Derivation (brute-force verified):
//   Apply Rx(-90°) first → maps +Z to +Y, but forward goes to +Z (wrong).
//   Then apply Ry(+90°) → rotates forward from +Z to -Z. ✓
//   Net: ry.multiply(rx)  (THREE convention: rightmost quaternion applied first)
//
//   Verified mappings:
//     +X (fwd)  → (0, 0,-1)  ✓
//     +Z (up)   → (0, 1, 0)  ✓
//     -Y (right)→ (1, 0, 0)  ✓
const _rx90n = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _ry90p = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0),  Math.PI / 2);
// BASE = Ry(+90°) * Rx(-90°)  (Rx applied first, then Ry)
const BASE_ROTATION = _ry90p.clone().multiply(_rx90n);

// Scratch objects
const _headQuat = new THREE.Quaternion();
const _fwd      = new THREE.Vector3();
const _yawQuat  = new THREE.Quaternion();
const _worldFwd = new THREE.Vector3(0, 0, -1);

/**
 * Build the torso quaternion (wxyz, for MuJoCo freejoint qpos).
 *
 * @param qx qy qz qw  AVP device pose quaternion (stored xyzw)
 * @param refYaw        yaw of the head at frame 0 (radians), used to compute
 *                      relative yaw so the body faces the correct direction
 */
function buildTorsoQuat(
  qx: number, qy: number, qz: number, qw: number,
  refYaw: number
): [number, number, number, number] {
  _headQuat.set(qx, qy, qz, qw).normalize();

  // Project head forward onto horizontal (XZ) plane
  _fwd.set(0, 0, -1).applyQuaternion(_headQuat);
  _fwd.y = 0;

  let yaw: number;
  if (_fwd.lengthSq() < 1e-6) {
    // Looking straight up or down — keep reference yaw
    yaw = refYaw;
  } else {
    _fwd.normalize();
    // atan2(x, -z) gives yaw in Y-up space where forward = -Z
    yaw = Math.atan2(_fwd.x, -_fwd.z);
  }

  // Relative yaw from frame-0 reference.
  // Negated because a positive atan2 yaw (turning left in AVP space) should
  // rotate the torso left, but Ry(+θ) rotates the humanoid's forward right.
  const relYaw = -(yaw - refYaw);

  // Build yaw rotation around world Y
  _yawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), relYaw);

  // Compose: yaw in world space, then apply base rotation
  const result = _yawQuat.clone().multiply(BASE_ROTATION);
  return [result.w, result.x, result.y, result.z];
}

/** Extract yaw angle (radians) from an AVP device pose quaternion. */
function extractYaw(qx: number, qy: number, qz: number, qw: number): number {
  _headQuat.set(qx, qy, qz, qw).normalize();
  _fwd.set(0, 0, -1).applyQuaternion(_headQuat);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) return 0;
  _fwd.normalize();
  return Math.atan2(_fwd.x, -_fwd.z);
}

export function computeHumanoidIKBackground(
  frames: CaptureFrame[],
  onProgress: (solved: number, total: number) => void,
  onComplete: (humanoidFrames: HumanoidFrame[]) => void
): () => void {
  let cancelled = false;
  let solved = 0;
  const results: HumanoidFrame[] = [];
  const total = frames.length;

  // Compute reference yaw from frame 0's device pose (or 0 if unavailable)
  const firstDp = frames.find(f => f.devicePose)?.devicePose ?? null;
  const refYaw = firstDp
    ? extractYaw(firstDp.qx, firstDp.qy, firstDp.qz, firstDp.qw)
    : 0;

  // Default base quat (no head data): just the upright base rotation
  const baseWXYZ: [number, number, number, number] = [
    BASE_ROTATION.w, BASE_ROTATION.x, BASE_ROTATION.y, BASE_ROTATION.z,
  ];

  function processBatch() {
    const end = Math.min(solved + BATCH_SIZE, total);

    for (let i = solved; i < end; i++) {
      const frame = frames[i];
      const dp = frame.devicePose;

      // Torso position: device pose is at eye level, torso center ~0.25m below
      const torsoPos: [number, number, number] = dp
        ? [dp.x, dp.y - 0.25, dp.z]
        : [0, 1.0, 0];

      const torsoQuat: [number, number, number, number] = dp
        ? buildTorsoQuat(dp.qx, dp.qy, dp.qz, dp.qw, refYaw)
        : baseWXYZ;

      const rWrist = frame.rightHand?.[WRIST_IDX];
      const lWrist = frame.leftHand?.[WRIST_IDX];

      const rTarget: [number, number, number] = rWrist
        ? [rWrist.px, rWrist.py, rWrist.pz]
        : [torsoPos[0] + 0.4, torsoPos[1] - 0.2, torsoPos[2]];

      const lTarget: [number, number, number] = lWrist
        ? [lWrist.px, lWrist.py, lWrist.pz]
        : [torsoPos[0] - 0.4, torsoPos[1] - 0.2, torsoPos[2]];

      const rIK = solveArmIK(torsoPos, torsoQuat, R_SHOULDER_LOCAL, rTarget, "right");
      const lIK = solveArmIK(torsoPos, torsoQuat, L_SHOULDER_LOCAL, lTarget, "left");

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
