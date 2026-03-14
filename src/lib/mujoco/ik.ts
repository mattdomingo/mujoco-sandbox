/**
 * Analytical 3-DOF arm IK for the MuJoCo humanoid model.
 *
 * Coordinate conventions
 * ──────────────────────
 * All inputs/outputs are in Y-up world space (AVP / Three.js convention).
 * The torsoQuat already encodes Z-up→Y-up + yaw, so torso-local vectors
 * (shoulder offsets, joint axes, rest dirs) rotated by torsoQuat give world
 * positions.
 *
 * Algorithm
 * ─────────
 * 1. Transform shoulder origin to world space.
 * 2. Law-of-cosines → elbow angle.
 * 3. Elbow world position:
 *    a. If elbowHintWorld is provided (AVP forearmArm position), project it
 *       onto the plane perpendicular to shoulder→wrist to get the true elbow
 *       direction. This uses real captured data.
 *    b. Otherwise, fall back to pole-vector with down+outward hint.
 * 4. Derive upper-arm direction; transform to torso-local frame.
 * 5. Swing-twist decompose onto shoulder1 then shoulder2 axes.
 */

import * as THREE from "three";

// ── Segment lengths (body offset magnitudes from humanoid.xml) ────────────
// lower_arm_right pos=".18 -.18 -.18" → ‖(0.18, 0.18, 0.18)‖ = 0.18√3
export const UPPER_ARM_LEN = 0.18 * Math.sqrt(3); // ≈ 0.3118 m
export const LOWER_ARM_LEN = 0.18 * Math.sqrt(3); // ≈ 0.3118 m

// Rest-pose supplementary angle at the elbow.
// upper_arm dir · lower_arm dir = -1/3 for both arms (mirrored geometry).
// supplement = π - acos(-1/3) ≈ 1.231 rad (70.5°)
const REST_ELBOW_SUPPLEMENT = Math.PI - Math.acos(-1 / 3);

// ── Joint axes in torso-local (Z-up humanoid) frame ──────────────────────
export const R_SHOULDER1_AXIS = new THREE.Vector3( 2,  1,  1).normalize();
export const R_SHOULDER2_AXIS = new THREE.Vector3( 0, -1,  1).normalize();
export const R_ELBOW_AXIS     = new THREE.Vector3( 0, -1,  1).normalize();
export const L_SHOULDER1_AXIS = new THREE.Vector3(-2,  1, -1).normalize();
export const L_SHOULDER2_AXIS = new THREE.Vector3( 0, -1, -1).normalize();
export const L_ELBOW_AXIS     = new THREE.Vector3( 0, -1, -1).normalize();

// ── Rest-pose upper-arm direction (torso-local Z-up frame) ───────────────
// From shoulder origin to lower_arm offset: right=(0.18,-0.18,-0.18), left=(0.18,0.18,-0.18)
const R_REST_DIR = new THREE.Vector3( 1, -1, -1).normalize();
const L_REST_DIR = new THREE.Vector3( 1,  1, -1).normalize();

// ── Shoulder origins in torso-local (Z-up humanoid) frame ────────────────
export const R_SHOULDER_LOCAL: [number, number, number] = [0, -0.17, 0.06];
export const L_SHOULDER_LOCAL: [number, number, number] = [0,  0.17, 0.06];

// ── Reusable scratch objects ──────────────────────────────────────────────
const _torsoQuat   = new THREE.Quaternion();
const _invTorso    = new THREE.Quaternion();
const _torsoPos    = new THREE.Vector3();
const _shoulderPos = new THREE.Vector3();
const _wrist       = new THREE.Vector3();
const _d           = new THREE.Vector3();
const _dNorm       = new THREE.Vector3();
const _hint        = new THREE.Vector3();
const _torsoFwdScratch = new THREE.Vector3();
const _n           = new THREE.Vector3();
const _eOut        = new THREE.Vector3();
const _elbowWorld  = new THREE.Vector3();
const _upperDir    = new THREE.Vector3();
const _swingQuat   = new THREE.Quaternion();
const _axis2After1 = new THREE.Vector3();
const _q1          = new THREE.Quaternion();
const _perp        = new THREE.Vector3();
const _elbowOnPlane = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface ArmIKResult {
  shoulder1: number;
  shoulder2: number;
  elbow: number;
  reachable: boolean;
  // true when the raw solve was outside anatomical limits
  shoulder1Clamped: boolean;
  shoulder2Clamped: boolean;
  elbowClamped: boolean;
}

/**
 * Solve IK for one arm.
 *
 * @param torsoPos          torso world position (Y-up)
 * @param torsoQuat         torso world orientation wxyz (includes Z-up→Y-up base)
 * @param shoulderLocalPos  shoulder origin in torso-local Z-up frame
 * @param wristTargetWorld  desired wrist world position (Y-up, from AVP forearmWrist)
 * @param side              "right" or "left"
 * @param elbowHintWorld    optional measured elbow/forearm-arm world position (AVP forearmArm).
 *                          When provided, drives the elbow direction from real data instead
 *                          of the fallback pole-vector guess.
 */
export function solveArmIK(
  torsoPos: [number, number, number],
  torsoQuat: [number, number, number, number], // wxyz
  shoulderLocalPos: [number, number, number],
  wristTargetWorld: [number, number, number],
  side: "right" | "left",
  elbowHintWorld?: [number, number, number]
): ArmIKResult {
  const U = UPPER_ARM_LEN;
  const L = LOWER_ARM_LEN;

  const [qw, qx, qy, qz] = torsoQuat;
  _torsoQuat.set(qx, qy, qz, qw).normalize();
  _invTorso.copy(_torsoQuat).invert();
  _torsoPos.set(torsoPos[0], torsoPos[1], torsoPos[2]);

  _shoulderPos
    .set(shoulderLocalPos[0], shoulderLocalPos[1], shoulderLocalPos[2])
    .applyQuaternion(_torsoQuat)
    .add(_torsoPos);

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
  const elbowSupplement = Math.PI - Math.acos(clamp(cosElbowSup, -1, 1));
  const elbow = elbowSupplement - REST_ELBOW_SUPPLEMENT;

  const cosInner = (U * U + dist * dist - L * L) / (2 * U * dist);
  const innerAngle = Math.acos(clamp(cosInner, -1, 1));

  // ── Elbow world position ─────────────────────────────────────────────────
  if (elbowHintWorld !== undefined) {
    // Project the measured forearmArm position onto the plane perpendicular
    // to the shoulder→wrist axis, centred at the elbow's along-axis position.
    // This gives us the actual elbow direction from real AVP data.
    _elbowOnPlane.set(elbowHintWorld[0], elbowHintWorld[1], elbowHintWorld[2]);
    _elbowOnPlane.sub(_shoulderPos);

    // Component of hint along the reach axis
    const alongAxis = _elbowOnPlane.dot(_dNorm);
    // Perpendicular remainder
    _elbowOnPlane.addScaledVector(_dNorm, -alongAxis);

    if (_elbowOnPlane.lengthSq() < 1e-6) {
      // Hint is exactly on the reach line — fall back to anatomical pole vector
      const _torsoFwd = _torsoFwdScratch.set(1, 0, 0).applyQuaternion(_torsoQuat);
      _hint.set(0, -1, 0).addScaledVector(_torsoFwd, -0.2).normalize();
    } else {
      _elbowOnPlane.normalize();
      _hint.copy(_elbowOnPlane);
    }
  } else {
    // Fallback: anatomical pole-vector — down and slightly behind torso.
    // This matches real elbow-drop anatomy better than biasing outward.
    const _torsoFwd = _torsoFwdScratch.set(1, 0, 0).applyQuaternion(_torsoQuat);
    _hint.set(0, -1, 0).addScaledVector(_torsoFwd, -0.2).normalize();

    if (Math.abs(_hint.dot(_dNorm)) > 0.99) {
      // Degenerate: arm along hint — use torso back
      _hint.set(-1, 0, 0).applyQuaternion(_torsoQuat);
    }
  }

  _n.crossVectors(_dNorm, _hint).normalize();
  _eOut.crossVectors(_n, _dNorm).normalize();

  // ── Frontal-plane constraint: elbow must not go behind the torso ─────────
  // In torso-local Z-up frame, forward is +X. Negative local-X means behind the body.
  const _eOutLocal = _eOut.clone().applyQuaternion(_invTorso);
  if (_eOutLocal.x < 0) {
    _eOutLocal.x = 0;
    if (_eOutLocal.lengthSq() < 1e-6) _eOutLocal.set(0, -1, 0);
    else _eOutLocal.normalize();
    _eOut.copy(_eOutLocal).applyQuaternion(_torsoQuat);
  }

  _elbowWorld
    .copy(_shoulderPos)
    .addScaledVector(_dNorm, U * Math.cos(innerAngle))
    .addScaledVector(_eOut, U * Math.sin(innerAngle));

  // ── Upper-arm direction in torso-local frame ─────────────────────────────
  _upperDir.subVectors(_elbowWorld, _shoulderPos).normalize();
  const upperDirLocal = _upperDir.clone().applyQuaternion(_invTorso);

  // ── Decompose into shoulder1 + shoulder2 (swing-twist) ──────────────────
  const restDir = side === "right" ? R_REST_DIR : L_REST_DIR;
  const s1Axis  = side === "right" ? R_SHOULDER1_AXIS : L_SHOULDER1_AXIS;
  const s2Axis  = side === "right" ? R_SHOULDER2_AXIS : L_SHOULDER2_AXIS;

  const dot = restDir.dot(upperDirLocal);
  if (dot < -0.9999) {
    _perp.set(1, 0, 0);
    if (Math.abs(_perp.dot(restDir)) > 0.9) _perp.set(0, 1, 0);
    _perp.crossVectors(_perp, restDir).normalize();
    _swingQuat.setFromAxisAngle(_perp, Math.PI);
  } else {
    _swingQuat.setFromUnitVectors(restDir, upperDirLocal);
  }

  // Shoulder1 swing-twist decompose
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

  const swingRemain = _q1.clone().invert().multiply(_swingQuat);

  // Shoulder2 after shoulder1
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

  // Shoulder1 (primary swing — up/down elevation)
  const S1_MIN = -85 * (Math.PI / 180);  // matches XML class="shoulder" range="-85 60"
  const S1_MAX =  60 * (Math.PI / 180);
  // Shoulder2 (secondary swing — forward/backward reach)
  const S2_MIN = -85 * (Math.PI / 180);  // matches XML
  const S2_MAX =  60 * (Math.PI / 180);
  // Elbow: negative = flexion, positive = extension beyond rest
  const E_MIN = -100 * (Math.PI / 180);  // matches XML class="elbow" range="-100 50"
  const E_MAX =   50 * (Math.PI / 180);

  const rawS1 = shoulder1;
  const rawS2 = shoulder2;
  const rawE  = elbow;

  return {
    shoulder1: clamp(shoulder1, S1_MIN, S1_MAX),
    shoulder2: clamp(shoulder2, S2_MIN, S2_MAX),
    elbow:     clamp(elbow,     E_MIN,  E_MAX),
    reachable,
    shoulder1Clamped: rawS1 < S1_MIN || rawS1 > S1_MAX,
    shoulder2Clamped: rawS2 < S2_MIN || rawS2 > S2_MAX,
    elbowClamped:     rawE  < E_MIN  || rawE  > E_MAX,
  };
}
