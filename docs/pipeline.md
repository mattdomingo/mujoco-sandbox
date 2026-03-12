# Replay Pipeline

How a `.capture` file becomes a 3D visualization in the browser.

```
.capture file
     │
     ▼
┌─────────────┐
│   parser.ts  │  Reads hand_pose_world.csv.
│              │  Produces CaptureFrame[] — one frame per timestamp,
│              │  each frame holding 26 joint poses per hand
│              │  (world-space position + quaternion from Apple Vision Pro).
└──────┬───────┘
       │  CaptureFrame[]
       ▼
┌─────────────────┐
│  usePlayback.ts  │  rAF loop. Advances the frame index in real time
│                  │  based on elapsed time × playback speed.
│                  │  Calls onFrame(frame) each tick.
└──────┬───────────┘
       │  CaptureFrame (one at a time)
       ▼
┌──────────────┐
│  loader.ts   │  applyFrame():
│  (MuJoCo)    │   1. Writes joint positions into data.mocap_pos
│              │   2. Writes joint rotations into data.mocap_quat
│              │   3. Calls mj_forward() — runs the physics pipeline
│              │
│              │  After mj_forward(), MuJoCo's data holds the fully
│              │  resolved physics state (contacts, forces, etc.)
└──────┬───────┘
       │  MuJoCo data (xpos, xquat per body)
       ▼
┌──────────────────┐
│  CaptureViewer   │  Three.js render loop.
│  (Three.js)      │  Reads body positions back out of MuJoCo data.
│                  │  Moves 3D objects (spheres, bones) to match.
│                  │  Renders to <canvas>.
└──────────────────┘
```

## Data shape at each stage

| Stage | What it looks like |
|---|---|
| CSV row | `t_mono, chirality, thumbKnuckle_px, ..._py, ..._pz, ..._qx, ..._qy, ..._qz, ..._qw, ...` (182 columns per row) |
| `CaptureFrame` | `{ timestamp, leftHand: JointPose[26], rightHand: JointPose[26] }` |
| MuJoCo mocap input | `data.mocap_pos[body * 3 + xyz]`, `data.mocap_quat[body * 4 + wxyz]` |
| Three.js input | `data.xpos[body * 3]`, `data.xquat[body * 4]` (read after mj_forward) |

## Key files

| File | Role |
|---|---|
| `src/lib/pkg/parser.ts` | CSV → `CaptureFrame[]` |
| `src/lib/pkg/types.ts` | Shared data types |
| `src/lib/mujoco/loader.ts` | MuJoCo init + `applyFrame()` |
| `src/hooks/usePlayback.ts` | Playback timing loop |
| `src/components/CaptureViewer.tsx` | Wires everything together, owns Three.js scene |
| `public/models/holos_hands.xml` | MuJoCo hand model (52 mocap bodies) |
