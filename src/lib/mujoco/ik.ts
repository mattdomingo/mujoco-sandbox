/**
 * Analytical 3-DOF arm IK for the MuJoCo humanoid model.
 *
 * The humanoid uses two sequential hinge joints for the shoulder and one for
 * the elbow. We solve in three steps:
 *   1. Place the elbow via law-of-cosines + pole vector.
 *   2. Compute the desired upper-arm direction in torso-local space.
 *   3. Decompose that direction into shoulder1 + shoulder2 angles by
 *      sequentially projecting onto each axis.
 *
 * Segment lengths come from the humanoid.xml body offsets:
 *   lower_arm_right  pos=".18 -.18 -.18"  → ‖(.18,-.18,-.18)‖ = 0.18√3
 *   hand_right       pos=".18  .18  .18"  → ‖(.18, .18, .18)‖ = 0.18√3
 */

import * as THREE from "three";

// ── Segment lengths (body-offset magnitudes, not geom capsule extents) ───────
export const UPPER_ARM_LEN = 0.18 * Math.sqrt(3); // ≈ 0.3118 m
export const LOWER_ARM_LEN = 0.18 * Math.sqrt(3); // ≈ 0.3118 m

// ── Shoulder joint axes in torso-local frame (from humanoid.xml) ──────────────
// Right arm
export const R_SHOULDER1_AXIS = new THREE.Vector3(2,  1,  1).normalize();
export const R_SHOULDER2_AXIS = new THREE.Vector3(0, -1,  1).normalize();
export const R_ELBOW_AXIS     = new THREE.Vector3(0, -1,  1).normalize();
// Left arm (mirrored Y/Z axes)
export const L_SHOULDER1_AXIS = new THREE.Vector3(-2, 1, -1).normalize();
export const L_SHOULDER2_AXIS = new THREE.Vector3(0, -1, -1).normalize();
export const L_ELBOW_AXIS     = new THREE.Vector3(0, -1, -1).normalize();

// ── Rest-pose upper-arm direction in torso-local frame ────────────────────────
// upper_arm body origin → lower_arm body offset (.18, -.18, -.18) normalized
const R_REST_DIR = new THREE.Vector3(1, -1, -1).normalize();
const L_REST_DIR = new THREE.Vector3(1,  1, -1).normalize();

// ── Shoulder origins in torso-local frame ─────────────────────────────────────
// upper_arm_right pos="0 -.17 .06", upper_arm_left pos="0 .17 .06"
export const R_SHOULDER_LOCAL: [number, number, number] = [0, -0.17, 0.06];
export const L_SHOULDER_LOCAL: [number, number, number] = [0,  0.17, 0.06];

// ── Reusable scratch objects (module-level, not per-call) ────────────────────
const _torsoQuat   = new THREE.Quaternion();
const _shoulderPos = new THREE.Vector3();
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
 * Solve IK for one arm given world-space torso pose and wrist target.
 *
 * @param torsoPos     world position of torso body
 * @param torsoQuat    world orientation of torso body (wxyz)
 * @param shoulderLocalPos  shoulder origin in torso-local frame
 * @param wristTargetWorld  desired wrist position in world frame
 * @param side         "right" or "left"
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

  // THREE.Quaternion uses xyzw
  const [qw, qx, qy, qz] = torsoQuat;
  _torsoQuat.set(qx, qy, qz, qw).normalize();

  // Shoulder world position
  _shoulderPos
    .set(shoulderLocalPos[0], shoulderLocalPos[1], shoulderLocalPos[2])
    .applyQuaternion(_torsoQuat)
    .add(new THREE.Vector3(torsoPos[0], torsoPos[1], torsoPos[2]));

  // Vector from shoulder to wrist target
  _d.set(
    wristTargetWorld[0] - _shoulderPos.x,
    wristTargetWorld[1] - _shoulderPos.y,
    wristTargetWorld[2] - _shoulderPos.z
  );

  const maxReach = U + L - 0.005;
  const minReach = 0.02;
  let dist = _d.length();
  const reachable = dist <= maxReach;
  dist = clamp(dist, minReach, maxReach);

  // Clamp target to reachable distance
  _dNorm.copy(_d).normalize();

  // ── Elbow angle via law of cosines ────────────────────────────────────────
  // cos(elbow-supplement) = (U²+L²-dist²)/(2UL), elbow measured from straight
  const cosElbowSup = (U * U + L * L - dist * dist) / (2 * U * L);
  const elbow = Math.PI - Math.acos(clamp(cosElbowSup, -1, 1));

  // ── Elbow world position via pole vector ─────────────────────────────────
  // inner angle at shoulder
  const cosInner = (U * U + dist * dist - L * L) / (2 * U * dist);
  const innerAngle = Math.acos(clamp(cosInner, -1, 1));

  // Pole hint: elbow points backward/downward in world space.
  // Use (0, 0, -1) for right arm, (0, 0, -1) for left arm.
  // Fall back to perpendicular if hint is parallel to d.
  _hint.set(0, -1, 0); // elbow hint: down
  if (Math.abs(_hint.dot(_dNorm)) > 0.99) {
    _hint.set(side === "right" ? -1 : 1, 0, 0);
  }

  _n.crossVectors(_dNorm, _hint).normalize();
  _eOut.crossVectors(_n, _dNorm).normalize();

  _elbowWorld
    .copy(_shoulderPos)
    .addScaledVector(_dNorm, U * Math.cos(innerAngle))
    .addScaledVector(_eOut, U * Math.sin(innerAngle));

  // ── Upper-arm direction in world space ───────────────────────────────────
  _upperDir.subVectors(_elbowWorld, _shoulderPos).normalize();

  // ── Transform upper-arm direction to torso-local frame ───────────────────
  const _invTorso = _torsoQuat.clone().invert();
  const upperDirLocal = _upperDir.clone().applyQuaternion(_invTorso);

  // ── Decompose into shoulder1 + shoulder2 angles ───────────────────────────
  // Rest-pose upper-arm direction in local frame
  const restDir = side === "right" ? R_REST_DIR : L_REST_DIR;
  const s1Axis = side === "right" ? R_SHOULDER1_AXIS : L_SHOULDER1_AXIS;
  const s2Axis = side === "right" ? R_SHOULDER2_AXIS : L_SHOULDER2_AXIS;

  // Use swing rotation from restDir to upperDirLocal
  if (restDir.dot(upperDirLocal) < -0.9999) {
    // Anti-parallel: use a 180° rotation around any perpendicular
    _swingQuat.setFromAxisAngle(
      new THREE.Vector3(1, 0, 0).cross(restDir).normalize(),
      Math.PI
    );
  } else {
    _swingQuat.setFromUnitVectors(restDir, upperDirLocal);
  }

  // Shoulder1 angle: project swing rotation onto s1Axis.
  // We extract the component of the swing that rotates around s1Axis.
  // swing = q1(s1) * q2(s2_rotated)
  // Approximate: shoulder1 angle = 2 * asin(clamp(swingQuat · s1Axis, -1, 1))
  // More accurate: swing-twist decomposition.

  // ── Swing-twist decompose for shoulder1 ──────────────────────────────────
  // Project quaternion onto axis s1
  const { x: sx, y: sy, z: sz, w: sw } = _swingQuat;
  const dot1 = s1Axis.x * sx + s1Axis.y * sy + s1Axis.z * sz;
  // Twist quaternion around s1Axis
  const t1x = s1Axis.x * dot1;
  const t1y = s1Axis.y * dot1;
  const t1z = s1Axis.z * dot1;
  const t1w = sw;
  const t1Len = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z + t1w * t1w);
  let shoulder1: number;
  if (t1Len < 1e-10) {
    shoulder1 = 0;
    _q1.set(0, 0, 0, 1);
  } else {
    const nx = t1x / t1Len, ny = t1y / t1Len, nz = t1z / t1Len, nw = t1w / t1Len;
    shoulder1 = 2 * Math.atan2(Math.sqrt(nx * nx + ny * ny + nz * nz), nw);
    if (dot1 < 0) shoulder1 = -shoulder1;
    _q1.set(nx, ny, nz, nw);
  }

  // Remaining swing after shoulder1: swing2 = q1_inv * swing
  const swingRemain = _q1.clone().invert().multiply(_swingQuat);

  // ── Swing-twist decompose remaining rotation onto shoulder2 ──────────────
  // Transform s2Axis by q1 to get the actual s2Axis after shoulder1 rotation
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

  // Clamp to joint limits: shoulder range="-85 60" → [-1.484, 1.047]
  const SHOULDER_MIN = -85 * (Math.PI / 180);
  const SHOULDER_MAX =  60 * (Math.PI / 180);
  shoulder1 = clamp(shoulder1, SHOULDER_MIN, SHOULDER_MAX);
  shoulder2 = clamp(shoulder2, SHOULDER_MIN, SHOULDER_MAX);

  // Clamp elbow: range="-100 50" → [-1.745, 0.873]
  const ELBOW_MIN = -100 * (Math.PI / 180);
  const ELBOW_MAX =   50 * (Math.PI / 180);
  const elbowClamped = clamp(elbow, ELBOW_MIN, ELBOW_MAX);

  return { shoulder1, shoulder2, elbow: elbowClamped, reachable };
}
