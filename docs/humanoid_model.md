# Humanoid Model: Architecture, IK Pipeline, and Design Decisions

This document describes the full implementation of the MuJoCo humanoid stick figure with IK-driven arms. It covers coordinate systems, the analytical IK solver, background computation, Three.js rendering, and what we found when researching MuJoCo's native solver capabilities.

---

## Overview

The humanoid model adds a stick-figure body to the existing hand-tracking visualization. When a capture contains `device_pose.csv` (Apple Vision Pro head tracking), the system:

1. Drives the humanoid **torso** from the headset position and orientation.
2. Computes **arm IK** in the background (50-frame batches via `setTimeout`) to pose the shoulders and elbows so wrists reach the AVP-tracked hand positions.
3. Renders a **stick figure** (spheres at body joints, cylinders for bones) that overlays the floating hand spheres.

Captures without device pose skip IK entirely — the hand visualization is unchanged.

---

## Model file: `holos_humanoid.xml`

`public/models/holos_humanoid.xml` merges two sources:

- **`humanoid.xml`** from google-deepmind/mujoco — 16 rigid bodies, 1 freejoint (`root` on `torso`), 21 hinge joints (2 shoulder + 1 elbow per arm, hips/knees/ankles/feet for legs).
- **`holos_hands.xml`** content — 52 hand mocap bodies (`r_*` / `l_*`) and the free `pressure_ball` body.

Key XML decisions:
- Model name changed to `holos_humanoid`.
- The `<actuator>` section is retained — unused when calling `mj_forward()` only (no `mj_step()`).
- Gravity `0 0 -9.81` (Z-up in MuJoCo frame).
- Body count: world(1) + humanoid(16) + hands(52) + ball(1) = **70 bodies total**.

---

## Coordinate systems

This is the most critical source of bugs in the whole pipeline.

### MuJoCo humanoid (Z-up)
- **Up**: +Z
- **Forward** (neutral rest): +X
- **Right**: -Y

### AVP / Three.js world (Y-up)
- **Up**: +Y
- **Forward** (head at rest): -Z
- **Right**: +X

### BASE_ROTATION

A fixed quaternion that maps the humanoid's neutral Z-up pose into the Y-up world so the figure stands upright:

```
BASE_ROTATION = Ry(+90°) × Rx(-90°)
```

In Three.js (right-to-left composition):
```typescript
const _rx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), -Math.PI/2);
const _ry = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),  Math.PI/2);
const BASE_ROTATION = _ry.clone().multiply(_rx); // Rx first, then Ry
```

Verification (apply to humanoid axes):
| MuJoCo axis | Expected world | Result |
|---|---|---|
| +X (fwd) | -Z (into screen) | ✓ |
| +Z (up) | +Y (up) | ✓ |
| -Y (right) | +X (right) | ✓ |

**Common mistake**: using `rx.clone().multiply(ry)` (wrong order) produces a 90° rotation error that makes the shoulders face sideways.

---

## Torso pose from device pose

Each frame, the torso world pose is derived from the AVP headset pose (`device_pose.csv`).

### Position

The head is at eye level; the torso centre is approximately 0.25 m below and 0.05 m behind the head. Rather than a fixed world-space offset, the offset is defined in **head-local space** and rotated by the head orientation:

```typescript
const TORSO_OFFSET_HEAD_LOCAL = new THREE.Vector3(0, -0.25, 0.05);
// -Y = down, +Z = behind head
```

This makes the torso follow pitch and lean naturally — if the user bends forward, the torso moves forward and down, not just down.

### Orientation (yaw only)

The humanoid's torso only rotates horizontally (yaw). Pitch and roll from the head are intentionally ignored — a walking human's torso stays mostly upright even when they look down.

Algorithm:
1. Project head forward vector (`-Z` applied by head quat) onto the XZ plane.
2. Compute `yaw = atan2(x, -z)`.
3. Subtract the reference yaw (frame-0 heading) to get relative yaw.
4. Negate — positive `atan2` (turn left) should produce negative rotation in Three.js `Ry`.
5. Compose: `torsoQuat = Ry(relYaw) × BASE_ROTATION`.

```typescript
const relYaw = -(yaw - refYaw);
_yawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), relYaw);
const result = _yawQuat.clone().multiply(BASE_ROTATION);
```

---

## Analytical arm IK (`src/lib/mujoco/ik.ts`)

### Segment lengths

Read from `humanoid.xml` body offsets:
- `lower_arm_right pos=".18 -.18 -.18"` → `‖(0.18, 0.18, 0.18)‖ = 0.18√3 ≈ 0.3118 m`
- Both upper and lower arm use the same length in the current model.

```typescript
export const UPPER_ARM_LEN = 0.18 * Math.sqrt(3); // ≈ 0.3118 m
export const LOWER_ARM_LEN = 0.18 * Math.sqrt(3);
```

### Shoulder joint axes (torso-local, Z-up frame)

```typescript
export const R_SHOULDER1_AXIS = new THREE.Vector3( 2,  1,  1).normalize();
export const R_SHOULDER2_AXIS = new THREE.Vector3( 0, -1,  1).normalize();
export const R_ELBOW_AXIS     = new THREE.Vector3( 0, -1,  1).normalize();
export const L_SHOULDER1_AXIS = new THREE.Vector3(-2,  1, -1).normalize();
export const L_SHOULDER2_AXIS = new THREE.Vector3( 0, -1, -1).normalize();
export const L_ELBOW_AXIS     = new THREE.Vector3( 0, -1, -1).normalize();
```

### Shoulder origins (torso-local, Z-up frame)

From `upper_arm_right pos="0 -.17 .06"` in the XML:
```typescript
export const R_SHOULDER_LOCAL: [number,number,number] = [0, -0.17,  0.06];
export const L_SHOULDER_LOCAL: [number,number,number] = [0,  0.17,  0.06];
```

### Algorithm

**Step 1 — Shoulder world position**

```
shoulderWorld = torsoPos + torsoQuat × shoulderLocalPos
```

**Step 2 — Elbow angle (law of cosines)**

```
cos(elbowSup) = (U² + L² - dist²) / (2UL)
elbow = π - acos(clamp(cos, -1, 1))
```

**Step 3 — Elbow world position**

*With AVP elbow hint (preferred):*

The AVP skeleton provides `forearmArm` (joint index 25) — a measured point on the upper forearm near the elbow. We project this point onto the plane perpendicular to the shoulder→wrist axis to get the true elbow direction:

```
elbowOnPlane = (forearmArm - shoulder) - ((forearmArm - shoulder) · dNorm) × dNorm
hint = elbowOnPlane.normalize()
```

*Fallback (no elbow hint):*

Anatomical pole vector — primarily downward, biased outward per side:
```
hint = world_down + 0.5 × torso_right × outSign
```

**Step 4 — Elbow world position via triangle geometry**

```
innerAngle = acos((U² + dist² - L²) / (2U·dist))
n = (dNorm × hint).normalize()
eOut = (n × dNorm).normalize()
elbowWorld = shoulder + dNorm × U×cos(innerAngle) + eOut × U×sin(innerAngle)
```

**Step 5 — Decompose into shoulder1 + shoulder2 (swing-twist)**

Transform upper-arm direction to torso-local frame, then:
1. Compute swing quaternion from rest direction to target direction: `setFromUnitVectors(restDir, upperDirLocal)`.
2. Swing-twist decompose: project swing quat onto each axis sequentially.
3. Extract signed angle from each twist component.

Rest-pose upper-arm directions (torso-local Z-up):
```typescript
const R_REST_DIR = new THREE.Vector3( 1, -1, -1).normalize();
const L_REST_DIR = new THREE.Vector3( 1,  1, -1).normalize();
```

**Joint limits** (radians):
```typescript
const S_MIN = -85° = -1.484;  // shoulder1 and shoulder2
const S_MAX =  60° =  1.047;
const E_MIN = -100° = -1.745; // elbow
const E_MAX =   50° =  0.873;
```

---

## Background IK computation (`src/lib/mujoco/humanoidIk.ts`)

IK is compute-heavy for long captures. It runs in `setTimeout`-batched chunks of 50 frames to keep the main thread responsive:

```typescript
export function computeHumanoidIKBackground(
  frames: CaptureFrame[],
  onProgress: (solved: number, total: number) => void,
  onComplete: (humanoidFrames: HumanoidFrame[]) => void
): () => void  // returns cancel function
```

The cancel function sets `cancelled = true`; called on component unmount to avoid state updates after cleanup.

IK starts immediately after MuJoCo loads (not during MuJoCo loading). If no device pose exists in the capture, IK is skipped entirely.

### What "Computing humanoid IK…" actually does

When the progress bar is visible, the system is pre-computing a `HumanoidFrame` for every frame in the capture. Per frame:

1. **Torso position** — takes the AVP headset position and rotates a fixed head-local offset `(0, -0.25, 0.05)` by the head orientation. This places the torso ~25 cm below and ~5 cm behind the head, and makes it follow pitch/lean naturally rather than just tracking horizontal position.

2. **Torso rotation** — extracts only the horizontal yaw from the headset orientation (pitch and roll are discarded so the stick figure stands upright even when the user looks down). Yaw is computed relative to the first frame's heading so the figure starts facing forward.

3. **Right arm IK** — given the torso pose, shoulder origin, wrist target (`forearmWrist`, AVP joint 24), and elbow hint (`forearmArm`, AVP joint 25 — a real measured point near the elbow), solves for the three hinge angles: `shoulder1_right`, `shoulder2_right`, `elbow_right`.

4. **Left arm IK** — same for the left side.

5. **Stores result** — pushes a `HumanoidFrame` with torso pose + 3 arm angles per side into the output array.

### Why batching is necessary

Processing thousands of frames synchronously would freeze the browser. Each batch of 50 frames runs inside a `setTimeout(processBatch, 0)` call, which hands control back to the browser between batches. The progress bar counts batches completing. Once the final batch finishes, `onComplete` fires and playback becomes available.

### The output

A `HumanoidFrame[]` array — one entry per capture frame — with pre-baked joint angles ready to be written directly into MuJoCo `qpos` during playback. **No IK math runs during the playback loop** — it just looks up the pre-computed answer for the current frame index.

---

## MuJoCo integration (`src/lib/mujoco/loader.ts`)

### Freejoint layout

The humanoid's `root` freejoint occupies `qpos[0..6]`:
- `qpos[0..2]` = torso position (x, y, z)
- `qpos[3..6]` = torso quaternion (w, x, y, z) — MuJoCo wxyz convention

All other hinge joint addresses come after index 6 and are looked up at load time:

```typescript
const jntQposAdr = (name: string) => {
  const id = m.mj_name2id(model, OBJ_JOINT, name);
  return id >= 0 ? model.jnt_qposadr[id] : -1;
};
```

### Per-frame application

```
applyFrame(instance, captureFrame, humanoidFrame?)
  → applyHand()          writes r_* / l_* mocap_pos + mocap_quat
  → applyTorso()         writes qpos[0..6]
  → applyArmIK()         writes qpos[shoulder1/2, elbow] for both arms
  → mj_forward()         resolves contacts + updates xpos for all bodies
```

### Leg ragdoll note

The legs are dynamic (unconstrained below the pelvis). `mj_forward()` does not advance time, so gravity doesn't move them — they stay in their last qpos. On playback scrub they'll be in the pose from the last simulated step. This is accepted behavior; calling `mj_resetData()` each frame would reset them to bind pose but lose continuity.

---

## Three.js rendering (`src/lib/three/scene.ts`)

### HumanoidScene

```typescript
interface HumanoidScene {
  joints:        Map<string, THREE.Mesh>;   // body/mocap name → sphere
  bones:         THREE.Mesh[];              // bone cylinders
  segmentPairs:  [string, string][];        // name pairs for bone endpoints
}
```

### Segment pairs

```
head → torso → waist_lower → pelvis
torso → upper_arm_right → lower_arm_right → r_forearmWrist
torso → upper_arm_left  → lower_arm_left  → l_forearmWrist
pelvis → thigh_right → shin_right → foot_right
pelvis → thigh_left  → shin_left  → foot_left
```

The arm segments terminate at `r_forearmWrist` / `l_forearmWrist` (AVP mocap_pos), not at the humanoid `hand_right` / `hand_left` bodies. This ensures the stick figure's "hands" visually connect to the tracked hand position from the CSV.

### Forearm deduplication

The hand skeleton includes a `forearmArm` (index 25) sphere and a `[forearmArm, forearmWrist]` bone (BONE_PAIRS index 24). When the humanoid is active, these are hidden to avoid showing two overlapping forearms:

```typescript
const hideForarm = threeScene.humanoid !== null;
syncHandFromMujoco(threeScene, instance, "r_", rJoints, rBones, hideForarm);
```

This hides:
- `forearmArm` sphere (joint index 25)
- The bone connecting `forearmArm` → `forearmWrist` (bone index 24)

The humanoid's own `lower_arm_right → r_forearmWrist` bone provides the replacement connection.

---

## MuJoCo native IK research

We investigated whether MuJoCo provides built-in IK or resolvers we should use instead of the analytical approach.

**Finding: MuJoCo has no built-in IK solver.**

What MuJoCo does provide:
- `mj_jacBody(model, data, jacp, jacr, body_id)` — computes the 3×nv positional Jacobian and 3×nv rotational Jacobian for a body.
- `mj_jac(model, data, jacp, jacr, point, body_id)` — same but for an arbitrary world point.
- `mj_jacDot` — Jacobian time derivative.

To use these for IK you would need a full pseudo-inverse (Jacobian transpose or damped least squares), which requires a matrix library not included in the WASM build. The Python bindings include `mujoco.minimize` for trajectory optimization, but that is not exposed in the JS/WASM package.

**Conclusion**: The analytical 3-DOF arm IK is the correct approach for this use case (motion capture replay with known wrist targets). Jacobian IK would be more flexible but requires more infrastructure and is unnecessary when segment lengths and joint axes are fixed.

---

## Data types (`src/lib/pkg/types.ts`)

```typescript
export interface HumanoidArmAngles {
  rShoulder1: number;   // shoulder1_right hinge (radians)
  rShoulder2: number;   // shoulder2_right hinge
  rElbow:     number;   // elbow_right hinge
  rReachable: boolean;  // false if wrist target was outside arm reach
  lShoulder1: number;
  lShoulder2: number;
  lElbow:     number;
  lReachable: boolean;
}

export interface HumanoidFrame {
  frameIndex: number;
  torsoPos:   [number, number, number];           // world Y-up
  torsoQuat:  [number, number, number, number];   // wxyz
  arms:       HumanoidArmAngles;
}
```

---

## UI: IKStatus overlay (`src/components/IKStatus.tsx`)

Positioned bottom-left, above the MuJoCo status overlay.

| Stage | Display |
|---|---|
| `"pending"` | Nothing |
| `"computing"` | Green progress bar + "Computing humanoid IK… (N / M)" |
| `"ready"` | "Humanoid ready" — auto-hides after 3 s |
| `"skipped"` | Nothing (no device pose in capture) |

---

## Key gotchas

1. **THREE.Quaternion constructor is `(x, y, z, w)`** — wxyz input must be reordered: `new THREE.Quaternion(qx, qy, qz, qw)`. The `torsoQuat` stored in `HumanoidFrame` is wxyz; set via `.set(qx, qy, qz, qw)`.

2. **Joint axes are in the body's parent frame** — shoulder axes `"2 1 1"` for `shoulder1_right` are defined relative to `torso`, not world space. Always transform axes by `torsoQuat` before projecting.

3. **`WRIST_IDX = 24`, `FOREARM_IDX = 25`** — confirmed from `HAND_JOINT_NAMES.indexOf()`. BONE_PAIRS `[25, 24]` is the forearmArm → forearmWrist bone; this is bone index 24 in the array.

4. **`mj_forward()` only, no `mj_step()`** — we never advance simulation time. Contacts and forces are computed but no velocity integration happens. This means leg positions only change if we explicitly write to `qpos`.

5. **`nmocap = 52`** — unchanged. The 16 humanoid bodies are dynamic, not mocap. Total `nbody = 70`.

6. **Scratch vectors** — `solveArmIK` is called 120 times/second (2 arms × 60fps). All intermediate vectors are module-level scratch objects, never allocated inside the function.
