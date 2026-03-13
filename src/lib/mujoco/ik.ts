/**
 * Analytical 3-DOF arm IK for the MuJoCo humanoid model.
 *
 * Coordinate conventions
 * ──────────────────────
 * Everything in this file is in Y-up world space (AVP / Three.js convention).
 * The torsoQuat passed in already encodes the full Z-up→Y-up + yaw rotation,
 * so rotating torso-local vectors (shoulder offsets, joint axes, rest dirs) by
 * torsoQuat correctly places them in world space.
 *
 * Torso-local frame (what the XML defines, Z-up humanoid):
 *   +X = right,  +Y = body-left / toward left shoulder,  +Z = up
 *
 * Segment lengths from body offsets in humanoid.xml:
 *   upper_arm_right body offset to lower_arm: (.18, -.18, -.18) → ‖‖ = 0.18√3
 *   lower_arm_right body offset to hand:      (.18,  .18,  .18) → ‖‖ = 0.18√3
 *
 * Algorithm
 * ─────────
 *   1. Transform shoulder origin to world space.
 *   2. Law-of-cosines → elbow angle.
 *   3. Pole-vector → elbow world position (elbow hints backward from body).
 *   4. Derive upper-arm direction; transform to torso-local frame.
 *   5. Swing-twist decompose onto shoulder1 then shoulder2 axes.
 */

import * as THREE from "three";

// ── Segment lengths ────────────────────────────────────────────────────────
export const UPPER_ARM_LEN = 0.18 * Math.sqrt(3); // ≈ 0.3118 m
export const LOWER_ARM_LEN = 0.18 * Math.sqrt(3); // ≈ 0.3118 m

// ── Joint axes in torso-local (Z-up humanoid) frame ───────────────────────
// From humanoid.xml:
//   shoulder1_right axis="2 1 1"   shoulder2_right axis="0 -1 1"
//   elbow_right     axis="0 -1 1"
//   shoulder1_left  axis="-2 1 -1" shoulder2_left  axis="0 -1 -1"
//   elbow_left      axis="0 -1 -1"
export const R_SHOULDER1_AXIS = new THREE.Vector3( 2,  1,  1).normalize();
export const R_SHOULDER2_AXIS = new THREE.Vector3( 0, -1,  1).normalize();
export const R_ELBOW_AXIS     = new THREE.Vector3( 0, -1,  1).normalize();
export const L_SHOULDER1_AXIS = new THREE.Vector3(-2,  1, -1).normalize();
export const L_SHOULDER2_AXIS = new THREE.Vector3( 0, -1, -1).normalize();
export const L_ELBOW_AXIS     = new THREE.Vector3( 0, -1, -1).normalize();

// ── Rest-pose upper-arm direction in torso-local frame ────────────────────
// The upper_arm body origin is at the shoulder; lower_arm body offset is
// (.18, -.18, -.18) for right and (.18, .18, -.18) for left (Z-up humanoid).
const R_REST_DIR = new THREE.Vector3( 1, -1, -1).normalize();
const L_REST_DIR = new THREE.Vector3( 1,  1, -1).normalize();

// ── Shoulder origins in torso-local frame (Z-up humanoid) ─────────────────
// upper_arm_right pos="0 -.17 .06",  upper_arm_left pos="0 .17 .06"
export const R_SHOULDER_LOCAL: [number, number, number] = [0, -0.17, 0.06];
export const L_SHOULDER_LOCAL: [number, number, number] = [0,  0.17, 0.06];

// ── Reusable scratch objects ───────────────────────────────────────────────
const _torsoQuat   = new THREE.Quaternion();
const _invTorso    = new THREE.Quaternion();
const _torsoPos    = new THREE.Vector3();
const _shoulderPos = new THREE.Vector3();
const _wrist       = new THREE.Vector3();
const _d           = new THREE.Vector3();
const _dNorm       = new THREE.Vector3();
const _hint        = new THREE.Vector3();
const _n           = new THREE.Vector3();
const _eOut        = new THREE.Vector3();
const _elbowWorld  = new THREE.Vector3();
const _upperDir    = new THREE.Vector3();
const _swingQuat   = new THREE.Quaternion();
const _axis2After1 = new THREE.Vector3();
const _q1          = new THREE.Quaternion();
const _perp        = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface ArmIKResult {
  shoulder1: number; // radians
  shoulder2: number; // radians
  elbow: number;     // radians
  reachable: boolean;
}

/**
 * Solve IK for one arm.
 *
 * @param torsoPos          torso world position (Y-up)
 * @param torsoQuat         torso world orientation wxyz (Y-up, includes Z-up→Y-up base)
 * @param shoulderLocalPos  shoulder origin in torso-local Z-up frame
 * @param wristTargetWorld  desired wrist world position (Y-up)
 * @param side              "right" or "left"
 */
export function solveArmIK(
  torsoPos: [number, number, number],
  torsoQuat: [number, number, number, number], // wxyz
  shoulderLocalPos: [number, number, number],
  wristTargetWorld: [number, number, number],
  side: "right" | "left"
): ArmIKResult {
  const U = UPPER_ARM_LEN;
  const L = LOWER_ARM_LEN;

  // MuJoCo wxyz → THREE xyzw
  const [qw, qx, qy, qz] = torsoQuat;
  _torsoQuat.set(qx, qy, qz, qw).normalize();
  _invTorso.copy(_torsoQuat).invert();
  _torsoPos.set(torsoPos[0], torsoPos[1], torsoPos[2]);

  // Shoulder world position: rotate local offset, then add torso world pos
  _shoulderPos
    .set(shoulderLocalPos[0], shoulderLocalPos[1], shoulderLocalPos[2])
    .applyQuaternion(_torsoQuat)
    .add(_torsoPos);

  // Vector shoulder → wrist
  _wrist.set(wristTargetWorld[0], wristTargetWorld[1], wristTargetWorld[2]);
  _d.subVectors(_wrist, _shoulderPos);

  const maxReach = U + L - 0.005;
  const minReach = 0.02;
  let dist = _d.length();
  const reachable = dist <= maxReach;
  dist = clamp(dist, minReach, maxReach);
  _dNorm.copy(_d).normalize();

  // ── Elbow angle (law of cosines) ─────────────────────────────────────────
  const cosElbowSup = (U * U + L * L - dist * dist) / (2 * U * L);
  const elbow = Math.PI - Math.acos(clamp(cosElbowSup, -1, 1));

  // ── Elbow world position (pole vector) ───────────────────────────────────
  const cosInner = (U * U + dist * dist - L * L) / (2 * U * dist);
  const innerAngle = Math.acos(clamp(cosInner, -1, 1));

  // Pole hint: elbow bends backward from the body in world space.
  // The humanoid faces -Z in Y-up world, so its back is +Z.
  // Torso local -X maps to world +Z (back) — verified from coordinate derivation.
  // Using torso-local -X rotated to world space as the elbow hint.
  _hint.set(-1, 0, 0).applyQuaternion(_torsoQuat);

  if (Math.abs(_hint.dot(_dNorm)) > 0.99) {
    // Degenerate: arm points straight back — fall back to world down
    _hint.set(0, -1, 0);
  }

  _n.crossVectors(_dNorm, _hint).normalize();
  _eOut.crossVectors(_n, _dNorm).normalize();

  _elbowWorld
    .copy(_shoulderPos)
    .addScaledVector(_dNorm, U * Math.cos(innerAngle))
    .addScaledVector(_eOut, U * Math.sin(innerAngle));

  // ── Upper-arm direction in torso-local frame ─────────────────────────────
  _upperDir.subVectors(_elbowWorld, _shoulderPos).normalize();
  const upperDirLocal = _upperDir.clone().applyQuaternion(_invTorso);

  // ── Decompose into shoulder1 + shoulder2 angles ───────────────────────────
  const restDir = side === "right" ? R_REST_DIR : L_REST_DIR;
  const s1Axis  = side === "right" ? R_SHOULDER1_AXIS : L_SHOULDER1_AXIS;
  const s2Axis  = side === "right" ? R_SHOULDER2_AXIS : L_SHOULDER2_AXIS;

  // Swing quaternion: restDir → upperDirLocal
  const dot = restDir.dot(upperDirLocal);
  if (dot < -0.9999) {
    // Anti-parallel: pick any perpendicular axis
    _perp.set(1, 0, 0);
    if (Math.abs(_perp.dot(restDir)) > 0.9) _perp.set(0, 1, 0);
    _perp.crossVectors(_perp, restDir).normalize();
    _swingQuat.setFromAxisAngle(_perp, Math.PI);
  } else {
    _swingQuat.setFromUnitVectors(restDir, upperDirLocal);
  }

  // ── Swing-twist decompose: shoulder1 around s1Axis ───────────────────────
  const { x: sx, y: sy, z: sz, w: sw } = _swingQuat;
  const dot1 = s1Axis.x * sx + s1Axis.y * sy + s1Axis.z * sz;
  const t1x = s1Axis.x * dot1, t1y = s1Axis.y * dot1, t1z = s1Axis.z * dot1;
  const t1Len = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z + sw * sw);

  let shoulder1: number;
  if (t1Len < 1e-10) {
    shoulder1 = 0;
    _q1.set(0, 0, 0, 1);
  } else {
    const nx = t1x / t1Len, ny = t1y / t1Len, nz = t1z / t1Len, nw = sw / t1Len;
    shoulder1 = 2 * Math.atan2(Math.sqrt(nx * nx + ny * ny + nz * nz), nw);
    if (dot1 < 0) shoulder1 = -shoulder1;
    _q1.set(nx, ny, nz, nw);
  }

  // Remaining rotation after shoulder1
  const swingRemain = _q1.clone().invert().multiply(_swingQuat);

  // ── Swing-twist decompose: shoulder2 around s2Axis (rotated by q1) ───────
  _axis2After1.copy(s2Axis).applyQuaternion(_q1);
  const { x: r2x, y: r2y, z: r2z, w: r2w } = swingRemain;
  const dot2 = _axis2After1.x * r2x + _axis2After1.y * r2y + _axis2After1.z * r2z;

  let shoulder2: number;
  if (Math.abs(r2w) < 1e-10 && Math.abs(dot2) < 1e-10) {
    shoulder2 = 0;
  } else {
    shoulder2 = 2 * Math.atan2(
      Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z),
      r2w
    );
    if (dot2 < 0) shoulder2 = -shoulder2;
  }

  // ── Joint limit clamping ─────────────────────────────────────────────────
  const S_MIN = -85 * (Math.PI / 180);
  const S_MAX =  60 * (Math.PI / 180);
  const E_MIN = -100 * (Math.PI / 180);
  const E_MAX =   50 * (Math.PI / 180);

  return {
    shoulder1: clamp(shoulder1, S_MIN, S_MAX),
    shoulder2: clamp(shoulder2, S_MIN, S_MAX),
    elbow:     clamp(elbow,     E_MIN, E_MAX),
    reachable,
  };
}
