# Holos Capture Viewer

Browser tool for replaying Holos `.capture` folders with MuJoCo WASM and Three.js.

## What It Does

- Parses hand tracking from `tracking/hand_pose_world.csv`
- Optionally loads `tracking/device_pose.csv`, `video/camera_left.mov`, `audio/audio.wav`, and `transcripts/timecoded_transcript.json`
- Drives the bundled MuJoCo humanoid model in `public/models/holos_humanoid.xml`
- Renders either raw mocap data or physics-resolved body positions
- Shows ball pressure, inter-hand pressure, synced video playback, and humanoid IK when device pose data is available

## Requirements

- Node 20+
- npm
- MuJoCo WASM assets in `public/`

The app imports `/mujoco_wasm.js` at runtime and expects the matching `/mujoco_wasm.wasm` alongside it. The repository already includes `public/mujoco_wasm.js`; copying both files from the installed `mujoco-js` package keeps the pair version-matched:

```bash
cp node_modules/mujoco-js/dist/mujoco_wasm.js public/
cp node_modules/mujoco-js/dist/mujoco_wasm.wasm public/
```

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Capture Format

The input is a dropped or selected `.capture` directory, not a zip file. The minimum required structure is:

```text
capture-name/
└── tracking/
    └── hand_pose_world.csv
```

Optional files the app understands:

```text
capture-name/
├── metadata/metadata.json
├── tracking/device_pose.csv
├── video/camera_left.mov
├── audio/audio.wav
└── transcripts/timecoded_transcript.json
```

## Viewer Features

- Folder picker plus drag-and-drop directory traversal
- Play, pause, and timeline scrubbing
- Optional `camera_left` popup synchronized to capture time
- Fixed camera or follow-head camera mode when `device_pose.csv` exists
- MuJoCo read-mode toggle between `mocap_pos` and `xpos`
- Live ball-pressure and inter-hand-pressure HUDs
- Background humanoid IK with progress and ready overlays

## Testing

```bash
npm test
npm run test:ui
```

Playwright starts `npm run dev` when needed and reuses an existing server on `http://localhost:3000`. The MuJoCo test harness page lives at `/test-mujoco`.

## Project Map

| Path | Purpose |
|---|---|
| `src/app/page.tsx` | App entry point and top-level layout |
| `src/components/PkgDropzone.tsx` | Folder upload via picker or drag-and-drop |
| `src/components/CaptureViewer.tsx` | Three.js scene lifecycle, MuJoCo loading, playback wiring, overlays |
| `src/components/MetadataPanel.tsx` | Capture metadata and transcript sidebar |
| `src/hooks/usePlayback.ts` | rAF playback loop and seek controls |
| `src/hooks/useVideoSync.ts` | Synchronizes the optional video element with capture time |
| `src/lib/pkg/parser.ts` | Parses capture folders into `ParsedCapture` frames |
| `src/lib/mujoco/loader.ts` | MuJoCo boot, frame application, contact-force reads |
| `src/lib/mujoco/humanoidIk.ts` | Background torso and arm IK for the humanoid overlay |
| `src/lib/three/scene.ts` | Three.js scene setup and rendering helpers |
| `src/app/test-mujoco/page.tsx` | Browser test harness for Playwright |
| `tests/mujoco.spec.ts` | End-to-end MuJoCo integration tests |

## Notes

- SharedArrayBuffer support is required for MuJoCo WASM. `next.config.ts` sets the needed COOP and COEP headers.
- `public/models/holos_humanoid.xml` is already included in the repo. No extra model download is needed.
- If MuJoCo times out or fails to initialize, the viewer falls back to raw capture rendering instead of crashing the page.
