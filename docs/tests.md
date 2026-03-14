# Test Suite

How the tests are structured, what they verify, and how to run them.

---

## Overview

17 Playwright browser tests in `tests/mujoco.spec.ts`. They run against a live dev server at `localhost:3000/test-mujoco` — a dedicated test harness page that boots MuJoCo WASM and exposes the instance and helper functions on `window.__mujocoTest`.

Every test independently navigates to `/test-mujoco` and waits for MuJoCo to reach `"ready"` status before asserting anything. There is no shared state between tests.

---

## Running

```bash
npm test           # all 17 tests (auto-starts dev server)
npm run test:ui    # Playwright UI mode — step through tests interactively
```

Playwright config (`playwright.config.ts`) starts `npm run dev` as the dev server dependency. The WASM boot can take ~10–15s; the `waitForMuJoCo` helper allows up to 45s.

---

## Test harness: `/test-mujoco`

`src/app/test-mujoco/page.tsx` is a minimal React page with no UI. On mount it calls `loadMuJoCo()` and attaches the result to `window.__mujocoTest`:

```ts
window.__mujocoTest = {
  instance,           // MuJoCoInstance — the loaded model + data
  HAND_JOINT_NAMES,   // readonly string[] — the 26 joint names
  applyFrame,         // function — write a CaptureFrame into MuJoCo
  readContactPressure,      // function
  readInterHandPressure,    // function
  resolveTrackedArmSide,    // function — from humanoidIk.ts
  solveArmIK,               // function — from ik.ts
  R_SHOULDER_LOCAL, L_SHOULDER_LOCAL, UPPER_ARM_LEN, LOWER_ARM_LEN,
};
```

The page has a single `<p data-testid="status">` element. `waitForMuJoCo(page)` polls it until it reads `"ready"`. Tests call into `window.__mujocoTest` via `page.evaluate()`, which runs the code in the browser (WASM context).

---

## Tests by group

### Group 1 — Model integrity (Tests 1–2)

Verify that the model loads with the expected structure.

| # | Name | What it checks |
|---|---|---|
| 1 | `model loads with correct body and mocap counts` | `model.nbody === 71`, `model.nmocap === 53`, `mocapIndex.size === 53`, `bodyIndex.size >= 69` |
| 2 | `mocap and body index contain all 26 joints for both hands` | Every `r_<joint>` and `l_<joint>` name appears in both `mocapIndex` and `bodyIndex` |

**Expected counts:** 1 world + 16 humanoid bodies + 52 hand mocap bodies + 1 `pressure_ball` + 1 `nakamichi_cabinet` = 71 bodies. 52 hand joints + 1 nakamichi = 53 mocap bodies.

---

### Group 2 — Mocap write/read (Tests 3–7)

Verify that the WASM typed arrays behave correctly.

| # | Name | What it checks |
|---|---|---|
| 3 | `writing mocap_pos is immediately readable without calling mj_forward` | Write 3 floats to `mocap_pos`, read them back — exact equality, no forward needed |
| 4 | `mj_forward propagates mocap_pos into xpos` | Write a position, call `mj_forward`, confirm `xpos` matches within 1e-4 |
| 5 | `applyFrame writes all 26 right-hand joints and mj_forward reflects them in xpos` | Build a synthetic frame with predictable joint positions (index × scalar), call `applyFrame`, verify all 26 joints in both `mocap_pos` and `xpos` |
| 6 | `mocap_pos and xpos are separate arrays that can hold different values before mj_forward` | Write to `mocap_pos`, call `mj_forward`, write a different value to `mocap_pos` without a second forward — `xpos` should still hold the old value |
| 7 | `writing one joint does not corrupt adjacent mocap slots` | Zero three adjacent slots, write only the middle one, verify the outer two remain zero |

These tests are the proof that the `[i]` index notation is correct and that the WASM typed arrays are stable across calls.

---

### Group 3 — Pressure ball (Tests 8–11)

Verify the pressure ball body is present and that contact forces are computed.

| # | Name | What it checks |
|---|---|---|
| 8 | `pressure_ball body and geom are found after model load` | `ballBodyId >= 0`, `ballGeomId >= 0`, `pressure_ball` in `bodyIndex`, right/left hand geom sets have 26 entries each |
| 9 | `pressure_ball starts near its XML position after mj_forward` | Ball xpos is within 5cm of `(0, 0.9, 0.5)` after one `mj_forward` call |
| 10 | `readContactPressure returns zero when hands are far from the ball` | All joints at `(5, 5, 5)` — pressure and contactCount both 0 |
| 11 | `readContactPressure returns non-zero pressure when a hand joint overlaps the ball` | All right-hand joints placed at ball position — at least 1 contact, pressure > 0 |

Test 9 uses a 5cm tolerance because a single `mj_forward` call with gravity applied may move the ball slightly from its rest position.

---

### Group 4 — Inter-hand pressure (Tests 12–13)

| # | Name | What it checks |
|---|---|---|
| 12 | `readInterHandPressure returns zero when hands are far apart` | Left at `(-5, 5, 5)`, right at `(5, 5, 5)` — pressure 0 |
| 13 | `readInterHandPressure returns non-zero pressure when left and right joints overlap` | `thumbKnuckle` on both hands placed at the same point — pressure > 0 |

**Note:** Test 13 (`readInterHandPressure` non-zero) is a **known flaky test** that was intermittently failing before the object integration work. It fails in approximately 1 in 3 runs on the current hardware. The root cause is believed to be a timing or contact-detection sensitivity issue in MuJoCo's broadphase when only a single pair of tiny sphere geoms overlaps. Test 12 (zero when apart) is reliable. This flakiness is pre-existing and not related to any recent changes.

---

### Group 5 — IK tracking gap handling (Tests 14–16)

These tests call `resolveTrackedArmSide` directly — no MuJoCo state is written.

| # | Name | What it checks |
|---|---|---|
| 14 | `resolveTrackedArmSide freezes the last valid pose when wrist or elbow data is not tracked` | Valid solve followed by a gap frame (`wristTracked: false`) — gap frame returns the same angles, `trackedDataValid: false`, `reachable: false`, clamp flags cleared |
| 15 | `resolveTrackedArmSide uses the neutral arm pose before any valid tracked sample exists` | First call with `wristTracked: false` and no prior pose — returns all zeros, `trackedDataValid: false` |
| 16 | `resolveTrackedArmSide resumes solving when tracked wrist and elbow data return` | valid → gap → valid with different wrist position — third call produces different angles, `trackedDataValid: true` |

---

### Group 6 — IK angle correctness (Test 17)

| # | Name | What it checks |
|---|---|---|
| 17 | `solveArmIK produces unclamped angles for natural arm poses` | Two arm poses (arms at sides reaching forward, arms reaching forward at chest height) — all six arm joints `reachable: true` and `*Clamped: false`; elbows are non-zero |

This test exercises the actual IK math with a known-good geometry. The test constructs `BASE_ROTATION` (Ry(90°) × Rx(-90°)) inline to remain self-contained, places the torso at `(0, 1.0, 0)`, and places wrist targets at physiologically natural positions. The intent is to catch regressions in the `solveArmIK` function that would cause unclamped natural poses to be incorrectly flagged.

---

## What is NOT tested

| Gap | Notes |
|---|---|
| `object_pose.csv` parsing | No test verifies `parseObjectPoseCsv`, `interpolateObjectPoses`, or that `frame.objectPose` is populated. The object integration path has no automated coverage. |
| `loadScannedObject` / USDZ loading | No test verifies the Three.js USDZ load path. |
| Nakamichi contact force | `nakamichiGeomId` is indexed but no test verifies hand-object contacts. |
| `humanoidIk.ts` background processing | `computeHumanoidIKBackground` and its 50-frame batch loop are not tested. |
| `parseCapture` integration | No end-to-end test drives a real `.capture` FileList through the full parser. |
| `renderFromMujoco` / Three.js rendering | Three.js scene state is not inspected by any test — only physics data is verified. |
| Multi-object captures | The anchorID merge behavior is not tested. |
| Tracking loss interpolation in parser | `interpolateHandPoses` gap-fill behavior has no test coverage. |

---

## Architecture decisions

**Why Playwright, not Jest/Vitest?**
MuJoCo WASM requires `SharedArrayBuffer`, which in turn requires COOP/COEP headers. These headers can only be served from a real HTTP server. Running tests in Node (Jest/Vitest) would require a separate WASM host. Playwright tests run in a real Chromium instance against the live dev server, so the full browser environment — including SharedArrayBuffer, the WASM module, and the typed arrays — is exactly what production uses.

**Why a dedicated `/test-mujoco` page?**
The main `CaptureViewer` requires a `ParsedCapture` prop and a real `.capture` FileList to load. Constructing a synthetic capture for every test would be complex and fragile. The test harness page boots MuJoCo directly and exposes the raw instance, so tests can write arbitrary positions, call `mj_forward`, and read contacts without going through the UI.

**Why does each test call `waitForMuJoCo(page)` separately?**
Playwright tests can run in parallel across workers. Shared page state would create data races when tests write different values to the same WASM arrays. Navigating fresh each time costs ~10–15s of WASM boot but guarantees isolation.
