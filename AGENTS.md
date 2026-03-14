# Holos MuJoCo Sandbox — Agent Guide

Browser-based replay tool for Holos `.capture` files. Parses Apple Vision Pro hand tracking data, feeds it through MuJoCo's physics engine (WASM), and visualizes the result with Three.js.

## What this is

A dev tool for the Holos team. Users drop a `.capture` folder into the browser, the app parses the hand tracking CSV, drives 52 MuJoCo mocap bodies with the joint data each frame, runs `mj_forward()`, and renders the physics output using Three.js. When the capture includes `device_pose.csv` (Apple Vision Pro head tracking), a full humanoid stick figure is displayed — torso driven from headset position/orientation, arms posed via analytical IK with wrist targets from the AVP skeleton. A free rigid sphere (`pressure_ball`) sits in the scene — MuJoCo computes contact forces when hands intersect it, which are displayed as a live pressure readout.

## Stack

- **Next.js 16** (App Router, Turbopack) — `npm run dev`
- **React 19**, **TypeScript 5**, **Tailwind CSS 4**
- **Three.js** — 3D visualization
- **mujoco-js** (Google DeepMind npm package) — MuJoCo WASM physics engine
- **Playwright** — browser-based integration tests — `npm test`

## Commands

```bash
npm run dev      # dev server at localhost:3000
npm test         # 17 Playwright tests (auto-starts dev server)
npm run test:ui  # Playwright UI mode
npm run build    # production build
```

## Critical Architecture Facts

- `public/mujoco_wasm.js` is copied from `node_modules/mujoco-js/dist/mujoco_wasm.js` and served statically. It is loaded at runtime via `import(/* webpackIgnore: true */ "/mujoco_wasm.js")` — **never bundle it through Turbopack** (causes stack overflow).
- COOP/COEP headers are set in `next.config.ts` — required for SharedArrayBuffer/WASM.
- All MuJoCo WASM typed arrays (`mocap_pos`, `mocap_quat`, `xpos`, `efc_force`, `geom_bodyid`, etc.) **must be accessed with `[i]` index notation**, not `.get(i)`. The TypeScript types declare them as `any` and lie about this.
- `.capture` files are **directories**, not ZIPs. Upload uses `webkitdirectory` (folder picker) and `webkitGetAsEntry()` (drag-and-drop).
- AVP quaternions are `xyzw`; MuJoCo expects `wxyz` — reordered in `applyHand()`.
- `mj_contactForce()` returns zero for contacts involving mocap bodies (kinematically driven). Fall back to `data.efc_force[contact.efc_address]` for the actual constraint force.
- `MjContact` C++ wrappers **must be freed** after use (call `.free()`) to prevent WASM heap exhaustion over long playback sessions.
- The `onFrame` callback in the rAF loop is wrapped in try/catch — WASM exceptions must not escape or the render loop freezes permanently.

## Key Files

| File | Role |
|---|---|
| `public/models/holos_humanoid.xml` | MuJoCo model: 16 humanoid bodies (freejoint + hinges) + 52 hand mocap bodies + `pressure_ball` |
| `public/models/holos_hands.xml` | Legacy hand-only model (52 mocap bodies + `pressure_ball`); superseded by `holos_humanoid.xml` |
| `src/lib/pkg/types.ts` | `HAND_JOINT_NAMES`, `JointPose`, `CaptureFrame`, `ParsedCapture`, `HumanoidFrame`, `HumanoidArmAngles`, `ArmInputTracking` |
| `src/lib/pkg/parser.ts` | Parses `.capture` directory `FileList` → `CaptureFrame[]`; carries last known hand pose forward to prevent flickering; parses `device_pose.csv`, `timecoded_transcript.json`, audio, and `camera_left.mov` |
| `src/lib/mujoco/loader.ts` | `loadMuJoCo()`, `applyFrame()`, `readContactPressure()`, `readInterHandPressure()`. `MuJoCoInstance` holds mocap/body indexes, ball ids, hand geom sets, humanoid body ids, and arm joint qpos addresses |
| `src/lib/mujoco/ik.ts` | Analytical 3-DOF arm IK: law-of-cosines elbow angle, pole-vector (or AVP elbow hint) for elbow position, swing-twist decomposition onto shoulder hinge axes. `resolveTrackedArmSide()` handles tracking loss. |
| `src/lib/mujoco/humanoidIk.ts` | Background IK orchestration: 50-frame `setTimeout` batches, torso pose from head tracking, passes `forearmArm` (AVP joint 25) as elbow hint; produces `HumanoidFrame[]` |
| `src/lib/three/scene.ts` | Three.js scene init, `renderFromFrame()`, `renderFromMujoco(readMode)`, `updatePressureBall()`, `makeHumanoidScene()`, `renderHumanoidFromMujoco()` — includes head-facing stick visualization |
| `src/hooks/usePlayback.ts` | rAF loop: play/pause/seek/speed (`PlaybackState`, `PlaybackControls`) |
| `src/hooks/useVideoSync.ts` | Syncs `camera_left.mov` video element to capture playback time (`VideoSyncControls`) |
| `src/components/CaptureViewer.tsx` | Main component — owns Three.js init, MuJoCo async load, background IK, playback wiring, video player, all UI overlays |
| `src/components/PlaybackControls.tsx` | Standalone scrubber + play/pause panel (`PlaybackControlsPanel`) |
| `src/components/MetadataPanel.tsx` | Sidebar panel showing capture filename, duration, fps, frame count, audio, and transcript |
| `src/components/PressureDisplay.tsx` | Reusable HUD panel: pressure score (N), contact count, color bar, collapsible |
| `src/components/MuJoCoStatus.tsx` | Loading overlay: stage label, elapsed timer, timeout/error handling |
| `src/components/IKStatus.tsx` | IK progress overlay: computing progress bar, ready/skipped states |
| `src/components/PkgDropzone.tsx` | Folder picker + drag-and-drop upload |
| `src/app/test-mujoco/page.tsx` | Test harness page at `/test-mujoco` — loads MuJoCo, exposes `window.__mujocoTest` for Playwright |
| `tests/mujoco.spec.ts` | 17 Playwright browser tests |
| `docs/pipeline.md` | Full data flow documentation |
| `docs/mujoco.md` | Plain-English explanation of why/how MuJoCo is used |
| `docs/humanoid_model.md` | Humanoid model deep-dive: coordinate systems, IK algorithm, MuJoCo native solver research |

## MuJoCo Instance Shape

```ts
interface MuJoCoInstance {
  mujoco: any;                          // WASM module
  model: MjModel;                       // compiled from holos_humanoid.xml
  data: MjData;                         // live physics state
  mocapIndex: Map<string, number>;      // body name → mocap slot (for writing poses)
  bodyIndex: Map<string, number>;       // body name → body id (for reading xpos)
  ballBodyId: number;                   // body id of pressure_ball
  ballGeomId: number;                   // geom id of ball sphere (for contact matching)
  rightHandGeomIds: Set<number>;        // all geom ids for r_* bodies
  leftHandGeomIds: Set<number>;         // all geom ids for l_* bodies
  humanoidBodyIds: Map<string, number>; // humanoid body name → body id
  rShoulder1QposAdr: number;            // qpos address for shoulder1_right hinge
  rShoulder2QposAdr: number;            // qpos address for shoulder2_right hinge
  rElbowQposAdr: number;                // qpos address for elbow_right hinge
  lShoulder1QposAdr: number;            // qpos address for shoulder1_left hinge
  lShoulder2QposAdr: number;            // qpos address for shoulder2_left hinge
  lElbowQposAdr: number;                // qpos address for elbow_left hinge
}
```

## Per-Frame Pipeline

```
CSV → CaptureFrame[]                               (parser.ts)
  → computeHumanoidIKBackground()  [background]    (humanoidIk.ts)
      builds HumanoidFrame[] (torso pose + arm angles) via analytical IK
  → usePlayback rAF loop                           (usePlayback.ts)
    → applyFrame(instance, frame, humanoidFrame)   (loader.ts)
        writes mocap_pos / mocap_quat              (hand joints)
        writes qpos[0..6]                          (torso freejoint)
        writes qpos[shoulder1/2, elbow × 2]        (arm hinges)
        calls mj_forward()
    → readContactPressure()          ball ↔ hand contact force (N)
    → readInterHandPressure()        left ↔ right hand contact force (N)
    → renderFromMujoco(readMode)     reads xpos or mocap_pos → Three.js
    → renderHumanoidFromMujoco()     reads xpos (body joints) + mocap_pos (wrist anchors)
    → updatePressureBall()           moves ball mesh, shifts color blue→red
    → useVideoSync                   keeps camera_left.mov in sync
```

## UI Features

- **Folder drop zone** — drag `.capture` folder or click to pick
- **Playback controls** — play/pause, scrub (`PlaybackControlsPanel`)
- **Video player** — synced `camera_left.mov` overlay (`useVideoSync`)
- **Camera toggle** — fixed bounding-box view or follow-head (uses `device_pose.csv`)
- **Humanoid toggle** — show/hide the stick figure overlay
- **MuJoCo read mode toggle** — switch between `data.mocap_pos` (raw CSV) and `data.xpos` (physics output) — visible diagnostic for pipeline correctness
- **Ball pressure HUD** — live Newton readout + color bar for ball contact
- **Inter-hand pressure HUD** — live Newton readout for left/right hand contact
- **IK rule-break indicator** — visual flag when a solved angle exceeded anatomical clamp
- **MuJoCo status overlay** — stage labels, elapsed timer, timeout/error display
- **IK status overlay** — progress bar during background IK computation; auto-hides when ready
- **Metadata panel** — sidebar: filename, duration, fps, frame count, audio presence, transcript

## Naming Conventions

- `r_` prefix = right hand bodies/geoms in the XML and index maps
- `l_` prefix = left hand bodies/geoms
- `mocapIndex` is keyed by the full body name (`"r_thumbTip"`)
- `bodyIndex` is keyed the same way — both use the exact names from `holos_humanoid.xml`
- Humanoid joint names match the official humanoid.xml: `shoulder1_right`, `shoulder2_right`, `elbow_right`, etc.

## Critical IK Facts

- **Coordinate mismatch**: MuJoCo humanoid is Z-up; AVP/Three.js is Y-up. `BASE_ROTATION = Ry(+90°) × Rx(-90°)` bridges them. See `docs/humanoid_model.md` for derivation.
- **AVP elbow hint**: `HAND_JOINT_NAMES[25]` = `forearmArm` is a real measured point near the elbow. Passed to `solveArmIK` as `elbowHintWorld` so elbow direction comes from actual data, not guesswork.
- **Torso position**: `TORSO_OFFSET_HEAD_LOCAL = (0, -0.25, 0.05)` rotated by full head orientation — pitch-aware. Not a fixed world offset.
- **Freejoint layout**: `qpos[0..2]` = position, `qpos[3..6]` = quaternion wxyz. Always index 0 for the root freejoint.
- **No built-in IK in MuJoCo WASM**: Jacobian functions (`mj_jacBody`) exist but pseudo-inverse requires an external matrix library. Analytical IK is the right approach for replay.
- **Tracking loss**: `resolveTrackedArmSide()` in `ik.ts` detects when `wristTracked` or `elbowHintTracked` is false and freezes the last valid pose rather than snapping to origin. Returns a neutral pose before any valid sample has been seen.
- **Anatomical clamping**: Each shoulder and elbow hinge angle is clamped to a physiologically plausible range. `HumanoidArmAngles` carries `*Clamped` debug flags; the UI surfaces these as a red rule-break indicator.
- **Background batch processing**: IK is computed in 50-frame `setTimeout` batches in `humanoidIk.ts` to avoid blocking the main thread. `IKStatus` shows progress.

## Capture File Format

`.capture` is a **directory** (not a ZIP) containing:

| File | Content |
|---|---|
| `hand_pose_*.csv` | Per-frame hand joint poses (26 joints × position + quaternion per hand) |
| `device_pose.csv` | Per-frame AVP headset world pose (timestamp, position, quaternion) |
| `timecoded_transcript.json` | Speech transcript with per-token start/end timestamps |
| `camera_left.mov` | Passthrough camera video, synchronized with capture timestamps |
| (audio file) | Audio recording from the session |

## Test Suite

17 Playwright tests in `tests/mujoco.spec.ts`, running against the live dev server at `localhost:3000/test-mujoco`. The test harness page exposes `window.__mujocoTest` for direct WASM access.

Tests cover:
- Model loading (body/mocap counts)
- Index maps (all 26 joints × 2 hands)
- `mocap_pos` write/read roundtrip
- `mj_forward` propagation into `xpos`
- `applyFrame` correctness
- `pressure_ball` geom/body presence and initial position
- `readContactPressure` (zero when apart, non-zero on overlap)
- `readInterHandPressure` (zero when apart, non-zero on overlap)
- `resolveTrackedArmSide` — freeze on tracking loss, neutral before first valid sample, resume on retrack
- `solveArmIK` — unclamped angles for natural arm poses

## Coding Standards

- TypeScript strict mode; no `any` except at WASM boundaries
- React components are `"use client"` where they use hooks or browser APIs
- Prefer named exports for utilities, default exports for React components
- No comments that narrate what the code does — only explain non-obvious intent or constraints
- Use `[i]` index notation (never `.get(i)`) for all MuJoCo WASM typed arrays
- Always free `MjContact` wrappers after reading contact data
- Guard all `onFrame` / rAF callbacks against WASM exceptions with try/catch
