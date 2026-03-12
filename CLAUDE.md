# Holos MuJoCo Sandbox

Browser-based replay tool for Holos `.capture` files. Parses Apple Vision Pro hand tracking data, feeds it through MuJoCo's physics engine (WASM), and visualizes the result with Three.js.

## What this is

A dev tool for the Holos team. Users drop a `.capture` folder into the browser, the app parses the hand tracking CSV, drives 52 MuJoCo mocap bodies with the joint data each frame, runs `mj_forward()`, and renders the physics output using Three.js. A free rigid sphere (`pressure_ball`) sits in the scene — MuJoCo computes contact forces when hands intersect it, which are displayed as a live pressure readout. This proves MuJoCo physics is active, not just CSV passthrough.

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
| `public/models/holos_hands.xml` | MuJoCo model: 52 mocap bodies (26/hand) + free `pressure_ball` body |
| `src/lib/pkg/types.ts` | `HAND_JOINT_NAMES`, `JointPose`, `CaptureFrame`, `ParsedCapture` |
| `src/lib/pkg/parser.ts` | Parses `.capture` directory `FileList` → `CaptureFrame[]`; carries last known hand pose forward to prevent flickering |
| `src/lib/mujoco/loader.ts` | `loadMuJoCo()`, `applyFrame()`, `readContactPressure()`, `readInterHandPressure()`. `MuJoCoInstance` holds `mocapIndex`, `bodyIndex`, `ballGeomId`, `ballBodyId`, `rightHandGeomIds`, `leftHandGeomIds` |
| `src/lib/three/scene.ts` | Three.js scene init, `renderFromFrame()`, `renderFromMujoco(readMode)`, `updatePressureBall()` |
| `src/hooks/usePlayback.ts` | rAF loop: play/pause/seek/speed |
| `src/components/CaptureViewer.tsx` | Main component — owns Three.js init, MuJoCo async load, playback wiring, all UI overlays |
| `src/components/PressureDisplay.tsx` | Reusable HUD panel: pressure score (N), contact count, color bar, collapsible |
| `src/components/MuJoCoStatus.tsx` | Loading overlay: stage label, elapsed timer, timeout/error handling |
| `src/components/PkgDropzone.tsx` | Folder picker + drag-and-drop upload |
| `src/app/test-mujoco/page.tsx` | Test harness page at `/test-mujoco` — loads MuJoCo, exposes `window.__mujocoTest` for Playwright |
| `tests/mujoco.spec.ts` | 13 Playwright browser tests |
| `docs/pipeline.md` | Full data flow documentation — read this for a detailed architectural overview |
| `docs/mujoco.md` | Plain-English explanation of why/how MuJoCo is used |

## MuJoCo instance shape

```ts
interface MuJoCoInstance {
  mujoco: any;                        // WASM module
  model: MjModel;                     // compiled from holos_hands.xml
  data: MjData;                       // live physics state
  mocapIndex: Map<string, number>;    // body name → mocap slot (for writing poses)
  bodyIndex: Map<string, number>;     // body name → body id (for reading xpos)
  ballBodyId: number;                 // body id of pressure_ball
  ballGeomId: number;                 // geom id of ball sphere (for contact matching)
  rightHandGeomIds: Set<number>;      // all geom ids for r_* bodies
  leftHandGeomIds: Set<number>;       // all geom ids for l_* bodies
}
```

## Per-frame pipeline

```
CSV → CaptureFrame[]                   (parser.ts)
  → usePlayback rAF loop               (usePlayback.ts)
    → applyFrame(instance, frame)      (loader.ts)
        writes mocap_pos / mocap_quat
        calls mj_forward()
    → readContactPressure()            ball ↔ hand contact force (N)
    → readInterHandPressure()          left ↔ right hand contact force (N)
    → renderFromMujoco(readMode)       reads xpos or mocap_pos → Three.js
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
- `bodyIndex` is keyed the same way — both use the exact names from `holos_hands.xml`
