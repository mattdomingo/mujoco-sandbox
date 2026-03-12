# Holos Capture Viewer

Dev tool for replaying Holos `.pkg` capture files using MuJoCo WASM in the browser.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get MuJoCo WASM binaries

Download from the stable community fork:

```
https://github.com/zalo/mujoco_wasm
```

Place these two files in `/public/mujoco/`:

```
public/mujoco/
├── mujoco_wasm.js
└── mujoco_wasm.wasm
```

> The official binaries live at `https://github.com/google-deepmind/mujoco/tree/main/wasm`
> but the zalo fork is generally easier to use from the browser.

### 3. Get a hand MJCF model

Download a hand model from MuJoCo Menagerie:

```
https://github.com/google-deepmind/mujoco_menagerie
```

Place the model and any mesh assets in `/public/models/`:

```
public/models/
├── hand.xml
└── assets/          # meshes, textures, etc.
```

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Usage

Drop a `.pkg` or `.capture` file onto the dropzone. The app will:
1. Unzip the package
2. Parse `metadata/metadata.json` and `tracking/hand_pose_world.csv`
3. Extract `audio/audio.wav` and `transcripts/timecoded_transcript.json`
4. Show the capture viewer with playback controls and metadata panel

## What's implemented vs stubbed

| File | Status |
|------|--------|
| `next.config.ts` | Done — COOP/COEP headers, WASM experiments |
| `src/lib/pkg/types.ts` | Done — all types |
| `src/app/page.tsx` | Done — dropzone / viewer layout |
| `src/components/PkgDropzone.tsx` | Done — drag-and-drop, loading, error |
| `src/components/PlaybackControls.tsx` | Done — full UI, props-driven |
| `src/components/MetadataPanel.tsx` | Stub — renders metadata, TODO for transcript |
| `src/components/CaptureViewer.tsx` | Stub — canvas placeholder, TODO for MuJoCo |
| `src/lib/pkg/parser.ts` | Stub — TODO: jszip parsing |
| `src/lib/mujoco/loader.ts` | Stub — TODO: WASM load + applyFrame |
| `src/hooks/usePlayback.ts` | Stub — TODO: rAF playback loop |

## .pkg file format

A `.pkg` file is a standard ZIP archive with this structure:

```
session_folder/
├── metadata/
│   ├── metadata.json          # start_uptime, start_wall, world_anchor
│   └── stereo_calibration.json
├── video/
│   ├── camera_left.mov
│   ├── camera_right.mov
│   └── camera_sbs.mov
├── audio/
│   └── audio.wav
├── transcripts/
│   ├── timecoded_transcript.json   # [{isFinal, text, tokens:[{startSec,endSec,text}]}]
│   └── full_transcript.txt
└── tracking/
    ├── hand_pose_world.csv    # t_mono, t_wall, chirality, x/y/z per joint
    ├── hand_pose_local.csv
    ├── device_pose.csv
    └── object_pose.csv
```

## Notes

- SharedArrayBuffer is required for MuJoCo WASM. The `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers are set in `next.config.ts`.
- `parsePkg` is a stub — implement it in `src/lib/pkg/parser.ts` using jszip.
- `loadMuJoCo` / `applyFrame` are stubs — implement in `src/lib/mujoco/loader.ts`.
- `usePlayback` is a stub — implement the rAF loop in `src/hooks/usePlayback.ts`.
