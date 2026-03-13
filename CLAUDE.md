# Holos MuJoCo Sandbox

Browser-based replay tool for Holos `.capture` files. Parses Apple Vision Pro hand tracking data, feeds it through MuJoCo's physics engine (WASM), and visualizes the result with Three.js.

## What this is

A dev tool for the Holos team. Users drop a `.capture` folder into the browser, the app parses the hand tracking CSV, drives 52 MuJoCo mocap bodies with the joint data each frame, runs `mj_forward()`, and renders the physics output using Three.js. When the capture includes `device_pose.csv` (Apple Vision Pro head tracking), a full humanoid stick figure is displayed — torso driven from headset position/orientation, arms posed via analytical IK with wrist targets from the AVP skeleton. A free rigid sphere (`pressure_ball`) sits in the scene — MuJoCo computes contact forces when hands intersect it, which are displayed as a live pressure readout.

## Stack

- **Next.js 16** (App Router, Turbopack) — `npm run dev`
- **React 19**, **TypeScript 5**, **Tailwind CSS 4**
- **Three.js** — 3D visualization
- **mujoco-js** (Google DeepMind npm package) — MuJoCo WASM physics engine
- **Playwright** — browser-based integration tests — `npm test`

## Critical architecture facts

- `public/mujoco_wasm.js` is copied from `node_modules/mujoco-js/dist/mujoco_wasm.js` and served statically. It is loaded at runtime via `import(/* webpackIgnore: true */ "/mujoco_wasm.js")` — **never bundle it through Turbopack** (causes stack overflow).
- COOP/COEP headers are set in `next.config.ts` — required for SharedArrayBuffer/WASM.
- All MuJoCo WASM typed arrays (`mocap_pos`, `mocap_quat`, `xpos`, `efc_force`, `geom_bodyid`, etc.) **must be accessed with `[i]` index notation**, not `.get(i)`. The TypeScript types declare them as `any` and lie about this.
- `.capture` files are **directories**, not ZIPs. Upload uses `webkitdirectory` (folder picker) and `webkitGetAsEntry()` (drag-and-drop).
- AVP quaternions are `xyzw`; MuJoCo expects `wxyz` — reordered in `applyHand()`.
- `mj_contactForce()` returns zero for contacts involving mocap bodies (kinematically driven). Fall back to `data.efc_force[contact.efc_address]` for the actual constraint force.

## Key files

| File | Role |
|---|---|
| `public/models/holos_humanoid.xml` | MuJoCo model: 16 humanoid bodies (freejoint + hinges) + 52 hand mocap bodies + `pressure_ball` |
| `public/models/holos_hands.xml` | Legacy hand-only model (52 mocap bodies + `pressure_ball`); superseded by `holos_humanoid.xml` |
| `src/lib/pkg/types.ts` | `HAND_JOINT_NAMES`, `JointPose`, `CaptureFrame`, `ParsedCapture`, `HumanoidFrame`, `HumanoidArmAngles` |
| `src/lib/pkg/parser.ts` | Parses `.capture` directory `FileList` → `CaptureFrame[]`; carries last known hand pose forward to prevent flickering |
| `src/lib/mujoco/loader.ts` | `loadMuJoCo()`, `applyFrame()`, `readContactPressure()`, `readInterHandPressure()`. `MuJoCoInstance` holds mocap/body indexes, ball ids, hand geom sets, humanoid body ids, and arm joint qpos addresses |
| `src/lib/mujoco/ik.ts` | Analytical 3-DOF arm IK: law-of-cosines elbow angle, pole-vector (or AVP elbow hint) for elbow position, swing-twist decomposition onto shoulder hinge axes |
| `src/lib/mujoco/humanoidIk.ts` | Background IK orchestration: 50-frame `setTimeout` batches, torso pose from head tracking, passes `forearmArm` (AVP joint 25) as elbow hint |
| `src/lib/three/scene.ts` | Three.js scene init, `renderFromFrame()`, `renderFromMujoco(readMode)`, `updatePressureBall()`, `makeHumanoidScene()`, `renderHumanoidFromMujoco()` |
| `src/hooks/usePlayback.ts` | rAF loop: play/pause/seek/speed |
| `src/components/CaptureViewer.tsx` | Main component — owns Three.js init, MuJoCo async load, background IK, playback wiring, all UI overlays |
| `src/components/PressureDisplay.tsx` | Reusable HUD panel: pressure score (N), contact count, color bar, collapsible |
| `src/components/MuJoCoStatus.tsx` | Loading overlay: stage label, elapsed timer, timeout/error handling |
| `src/components/IKStatus.tsx` | IK progress overlay: computing progress bar, ready/skipped states |
| `src/components/PkgDropzone.tsx` | Folder picker + drag-and-drop upload |
| `src/app/test-mujoco/page.tsx` | Test harness page at `/test-mujoco` — loads MuJoCo, exposes `window.__mujocoTest` for Playwright |
| `tests/mujoco.spec.ts` | 13 Playwright browser tests |
| `docs/pipeline.md` | Full data flow documentation — read this for a detailed architectural overview |
| `docs/mujoco.md` | Plain-English explanation of why/how MuJoCo is used |
| `docs/humanoid_model.md` | Humanoid model deep-dive: coordinate systems, IK algorithm, MuJoCo native solver research |

## MuJoCo instance shape

```ts
interface MuJoCoInstance {
  mujoco: any;                        // WASM module
  model: MjModel;                     // compiled from holos_humanoid.xml
  data: MjData;                       // live physics state
  mocapIndex: Map<string, number>;    // body name → mocap slot (for writing poses)
  bodyIndex: Map<string, number>;     // body name → body id (for reading xpos)
  ballBodyId: number;                 // body id of pressure_ball
  ballGeomId: number;                 // geom id of ball sphere (for contact matching)
  rightHandGeomIds: Set<number>;      // all geom ids for r_* bodies
  leftHandGeomIds: Set<number>;       // all geom ids for l_* bodies
  humanoidBodyIds: Map<string, number>; // humanoid body name → body id
  rShoulder1QposAdr: number;          // qpos address for shoulder1_right hinge
  rShoulder2QposAdr: number;          // qpos address for shoulder2_right hinge
  rElbowQposAdr: number;              // qpos address for elbow_right hinge
  lShoulder1QposAdr: number;          // qpos address for shoulder1_left hinge
  lShoulder2QposAdr: number;          // qpos address for shoulder2_left hinge
  lElbowQposAdr: number;              // qpos address for elbow_left hinge
}
```

## Per-frame pipeline

```
CSV → CaptureFrame[]                             (parser.ts)
  → computeHumanoidIKBackground()  [background]  (humanoidIk.ts)
      builds HumanoidFrame[] (torso pose + arm angles) via analytical IK
  → usePlayback rAF loop                         (usePlayback.ts)
    → applyFrame(instance, frame, humanoidFrame) (loader.ts)
        writes mocap_pos / mocap_quat            (hand joints)
        writes qpos[0..6]                        (torso freejoint)
        writes qpos[shoulder1/2, elbow × 2]      (arm hinges)
        calls mj_forward()
    → readContactPressure()            ball ↔ hand contact force (N)
    → readInterHandPressure()          left ↔ right hand contact force (N)
    → renderFromMujoco(readMode)       reads xpos or mocap_pos → Three.js
    → renderHumanoidFromMujoco()       reads xpos (body joints) + mocap_pos (wrist anchors)
    → updatePressureBall()             moves ball mesh, shifts color blue→red
```

## UI features

- **Folder drop zone** — drag `.capture` folder or click to pick
- **Playback controls** — play/pause, scrub, speed (0.25×–4×)
- **Camera toggle** — fixed bounding-box view or follow-head (uses `device_pose.csv`)
- **MuJoCo read mode toggle** — switch between `data.mocap_pos` (raw CSV) and `data.xpos` (physics output) — visible diagnostic for pipeline correctness
- **Ball pressure HUD** — live Newton readout + color bar for ball contact
- **Inter-hand pressure HUD** — live Newton readout for left/right hand contact
- **MuJoCo status overlay** — stage labels, elapsed timer, timeout/error display
- **IK status overlay** — progress bar during background IK computation; auto-hides when ready

## Running

```bash
npm run dev      # dev server at localhost:3000
npm test         # 13 Playwright tests (auto-starts dev server)
npm run test:ui  # Playwright UI mode
```

## Naming conventions

- `r_` prefix = right hand bodies/geoms in the XML and index maps
- `l_` prefix = left hand bodies/geoms
- `mocapIndex` is keyed by the full body name (`"r_thumbTip"`)
- `bodyIndex` is keyed the same way — both use the exact names from `holos_humanoid.xml`
- Humanoid joint names match the official humanoid.xml: `shoulder1_right`, `shoulder2_right`, `elbow_right`, etc.

## Critical IK facts

- **Coordinate mismatch**: MuJoCo humanoid is Z-up; AVP/Three.js is Y-up. `BASE_ROTATION = Ry(+90°) × Rx(-90°)` bridges them. See `docs/humanoid_model.md` for derivation.
- **AVP elbow hint**: `HAND_JOINT_NAMES[25]` = `forearmArm` is a real measured point near the elbow. Passed to `solveArmIK` as `elbowHintWorld` so elbow direction comes from actual data, not guesswork.
- **Torso position**: `TORSO_OFFSET_HEAD_LOCAL = (0, -0.25, 0.05)` rotated by full head orientation — pitch-aware. Not a fixed world offset.
- **Freejoint layout**: `qpos[0..2]` = position, `qpos[3..6]` = quaternion wxyz. Always index 0 for the root freejoint.
- **No built-in IK in MuJoCo WASM**: Jacobian functions (`mj_jacBody`) exist but pseudo-inverse requires an external matrix library. Analytical IK is the right approach for replay.
