# Replay Pipeline

How a `.capture` file becomes a physics-driven 3D visualization in the browser.

---

## Overview

```
.capture directory
        │
        ▼
┌────────────────────┐
│    PkgDropzone     │  User drops a .capture folder or uses the folder picker.
│                    │  Browser provides a FileList via webkitdirectory /
│                    │  webkitGetAsEntry() (directory traversal).
└────────┬───────────┘
         │  FileList
         ▼
┌────────────────────┐
│    parser.ts       │  Reads hand_pose_world.csv + device_pose.csv.
│                    │  Produces CaptureFrame[] — one frame per timestamp.
│                    │  Left and right hand rows are interleaved; the parser
│                    │  carries the last known pose forward so both hands are
│                    │  always populated (prevents flickering).
└────────┬───────────┘
         │  CaptureFrame[]   (held in React state)
         ▼
┌────────────────────┐
│   usePlayback.ts   │  requestAnimationFrame loop. Advances the current frame
│                    │  index based on elapsed wall-clock time × playback speed.
│                    │  Supports play / pause / seek / variable speed.
│                    │  Calls onFrame(frame) once per rendered frame.
└────────┬───────────┘
         │  CaptureFrame  (one at a time)
         ▼
┌────────────────────────────────────────────────────────────┐
│  loader.ts  —  applyFrame()                                │
│                                                            │
│  1. Writes 26 joint positions → data.mocap_pos             │
│     (world-space XYZ from CSV, indexed by mocap body id)   │
│                                                            │
│  2. Writes 26 joint rotations → data.mocap_quat            │
│     (AVP outputs xyzw; MuJoCo expects wxyz — reordered)    │
│                                                            │
│  3. Calls mj_forward() — runs the full physics pipeline:   │
│       • Resolves contacts between hand geoms and the ball  │
│       • Computes constraint + contact forces               │
│       • Writes resolved body transforms to data.xpos       │
│                                                            │
│  After mj_forward(), data holds the complete physics       │
│  state for this frame — contacts, forces, body positions.  │
└─────────────────────────┬──────────────────────────────────┘
                          │
              ┌───────────┴────────────┐
              │                        │
              ▼                        ▼
┌─────────────────────┐   ┌─────────────────────────────┐
│  readContactPressure│   │  readInterHandPressure       │
│                     │   │                              │
│  Iterates data.ncon │   │  Iterates data.ncon contacts,│
│  contacts, filters  │   │  filters for contacts where  │
│  for contacts       │   │  geom1 ∈ rightHandGeomIds    │
│  involving the ball │   │  and geom2 ∈ leftHandGeomIds │
│  geom.              │   │  (or vice versa).            │
│                     │   │                              │
│  Sums normal force  │   │  Sums normal force via       │
│  via               │   │  mj_contactForce(), falling  │
│  mj_contactForce(), │   │  back to efc_force for       │
│  falling back to    │   │  mocap-driven contacts.      │
│  efc_force for      │   │                              │
│  mocap contacts.    │   │  Returns: { pressure, count }│
│                     │   └──────────────┬───────────────┘
│  Returns: {         │                  │
│    pressure,        │                  │
│    contactCount,    │                  │
│    ballPos          │                  │
│  }                  │                  │
└──────────┬──────────┘                  │
           │                             │
           ▼                             ▼
┌──────────────────────────────────────────────────────────┐
│  CaptureViewer  /  scene.ts  —  Three.js render          │
│                                                          │
│  Per frame:                                              │
│    • renderFromMujoco(): reads data.xpos or data.mocap_  │
│      pos (togglable) → moves joint spheres + bone        │
│      cylinders to match resolved body positions          │
│                                                          │
│    • updatePressureBall(): moves the ball mesh to        │
│      ballPos (MuJoCo xpos output) and shifts its color   │
│      blue → yellow → red based on contact pressure       │
│                                                          │
│    • PressureDisplay HUD: shows numeric pressure (N),    │
│      contact count, and a color bar for both the ball    │
│      and inter-hand pressure simultaneously              │
│                                                          │
│  Renders to <canvas>.                                    │
└──────────────────────────────────────────────────────────┘
```

---

## Data shape at each stage

| Stage | Format |
|---|---|
| CSV row | `t_mono, t_wall, chirality, <joint>_px, _py, _pz, _qx, _qy, _qz, _qw, ...` (182 cols/row) |
| `CaptureFrame` | `{ index, timestamp, leftHand: JointPose[26], rightHand: JointPose[26], devicePose }` |
| `JointPose` | `{ px, py, pz, qx, qy, qz, qw }` — world-space position + quaternion (xyzw) |
| MuJoCo mocap input | `data.mocap_pos[mocapId * 3 + {0,1,2}]`, `data.mocap_quat[mocapId * 4 + {0,1,2,3}]` (wxyz) |
| MuJoCo physics output | `data.xpos[bodyId * 3]` — resolved position after `mj_forward()` |
| Contact force | `data.efc_force[contact.efc_address]` — normal force in Newtons per active contact |

---

## MuJoCo instance (`MuJoCoInstance`)

Loaded once at startup, held in a ref. Contains:

| Field | Type | Description |
|---|---|---|
| `mujoco` | WASM module | The loaded MuJoCo WASM module |
| `model` | `MjModel` | The compiled hand model from `holos_hands.xml` |
| `data` | `MjData` | Live physics state — written and read every frame |
| `mocapIndex` | `Map<name, mocapId>` | Body name → mocap slot index (for writing poses) |
| `bodyIndex` | `Map<name, bodyId>` | Body name → body id (for reading `xpos`) |
| `ballBodyId` | `number` | Body id of `pressure_ball` |
| `ballGeomId` | `number` | Geom id of the ball sphere (for contact matching) |
| `rightHandGeomIds` | `Set<number>` | All geom ids belonging to `r_*` bodies |
| `leftHandGeomIds` | `Set<number>` | All geom ids belonging to `l_*` bodies |

---

## Physics model (`holos_hands.xml`)

```
worldbody
├── r_thumbKnuckle          (mocap, sphere geom, contype=1)
├── r_thumbIntermediateBase (mocap, sphere geom)
├── ... (26 right-hand bodies total, prefix r_)
├── l_thumbKnuckle          (mocap, sphere geom, contype=1)
├── ... (26 left-hand bodies total, prefix l_)
└── pressure_ball           (free body — NOT mocap)
      └── freejoint           MuJoCo owns this body's position
          ball_geom (sphere, radius 0.04m, mass 0.05kg)
```

- **52 mocap bodies** — kinematically driven from CSV data each frame
- **1 free body** — `pressure_ball`, whose position is computed entirely by MuJoCo's contact solver. We never write to it. Its displacement and the forces on it are proof the physics engine is active.
- All geoms share `contype=1 / conaffinity=1` so hand spheres collide with the ball and with each other.

---

## Contact pressure readout

MuJoCo's contact solver runs inside `mj_forward()`. After each call:

1. `data.ncon` — number of active contacts this frame
2. `data.contact.get(i)` — the i-th contact, with fields:
   - `geom1`, `geom2` — which two geoms are touching
   - `exclude` — non-zero if MuJoCo filtered this contact out
   - `efc_address` — index into `efc_force` for this contact's constraint force
3. `mj_contactForce(model, data, i, buf)` — writes `[fx, fy, fz, tx, ty, tz]` into `buf`; `buf[0]` is the normal force
4. **Mocap body fallback:** Because hand bodies are kinematically driven (not dynamic), `mj_contactForce` can return zero for contacts involving them. In that case we read `data.efc_force[contact.efc_address]` directly — this always holds the solver's constraint force regardless of body type.

Two readouts are computed per frame:

| Function | Filters contacts by | Output |
|---|---|---|
| `readContactPressure()` | Either geom === `ballGeomId` | `{ pressure, contactCount, ballPos }` |
| `readInterHandPressure()` | geom1 ∈ right hand AND geom2 ∈ left hand (or vice versa) | `{ pressure, contactCount }` |

---

## Render read mode toggle

The UI exposes a toggle to switch which MuJoCo array Three.js reads joint positions from:

| Mode | Source | What it shows |
|---|---|---|
| `mocap_pos` | `data.mocap_pos[mocapId * 3]` | Raw CSV values written in — ground truth from Apple |
| `xpos` | `data.xpos[bodyId * 3]` | MuJoCo-resolved positions after `mj_forward()` |

For pure replay these are near-identical. Toggling and seeing no change confirms the physics pipeline is passing through cleanly. If `xpos` is broken (bad body id mapping, NaN, all-zeros), the joints will visibly move or disappear — making it a live diagnostic.

---

## Upload flow

`.capture` files are directories, not archives. Two entry points:

| Method | Browser API | How paths are reconstructed |
|---|---|---|
| Folder picker | `<input webkitdirectory>` | Browser sets `file.webkitRelativePath` automatically |
| Drag and drop | `DataTransferItem.webkitGetAsEntry()` | Recursive `readEntries()` traversal; `webkitRelativePath` is attached manually |

Both produce a `FileList` passed to `parseCapture(files)`.

---

## Key files

| File | Role |
|---|---|
| `src/lib/pkg/parser.ts` | CSV → `CaptureFrame[]`, carry-forward for missing hands |
| `src/lib/pkg/types.ts` | `HAND_JOINT_NAMES`, `JointPose`, `CaptureFrame`, `ParsedCapture` |
| `src/lib/mujoco/loader.ts` | MuJoCo init, `applyFrame()`, `readContactPressure()`, `readInterHandPressure()` |
| `src/lib/three/scene.ts` | Three.js scene, `renderFromMujoco()`, `updatePressureBall()` |
| `src/hooks/usePlayback.ts` | rAF playback loop |
| `src/components/CaptureViewer.tsx` | Orchestrates all of the above; owns React state |
| `src/components/PressureDisplay.tsx` | Reusable pressure HUD panel (score + color bar) |
| `src/components/MuJoCoStatus.tsx` | Loading overlay with stage label, elapsed timer, timeout |
| `src/components/PkgDropzone.tsx` | Folder picker + drag-and-drop upload |
| `public/models/holos_hands.xml` | MuJoCo model: 52 mocap bodies + `pressure_ball` |
| `tests/mujoco.spec.ts` | 13 Playwright browser tests (run: `npm test`) |

---

## Running locally

```bash
npm run dev     # start dev server at localhost:3000
npm test        # run all 13 Playwright tests (starts dev server automatically)
npm run test:ui # Playwright UI mode — step through tests interactively
```
