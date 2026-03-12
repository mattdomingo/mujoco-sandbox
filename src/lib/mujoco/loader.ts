import type { CaptureFrame, HandPose } from "@/lib/pkg/types";
import { HAND_JOINT_NAMES } from "@/lib/pkg/types";
import type { MjModel, MjData } from "mujoco-js/dist/mujoco_wasm";

export interface MuJoCoInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mujoco: any;
  model: MjModel;
  data: MjData;
  // body name → mocap id (index into data.mocap_pos / data.mocap_quat)
  mocapIndex: Map<string, number>;
  // body name → body id (index into data.xpos / data.xquat)
  bodyIndex: Map<string, number>;
  // geom id of the pressure_ball geom (-1 if not found)
  ballGeomId: number;
  // body id of the pressure_ball body (-1 if not found)
  ballBodyId: number;
}

export type MuJoCoStage =
  | "booting"      // importing + initialising the WASM module
  | "fetching"     // fetching holos_hands.xml
  | "loading"      // MjModel.loadFromXML + MjData
  | "indexing"     // building the mocap index map
  | "ready"        // fully loaded
  | "timeout"      // timed out
  | "error";       // hard failure

export interface MuJoCoProgress {
  stage: MuJoCoStage;
  elapsedMs: number;
}

export type MuJoCoProgressCallback = (p: MuJoCoProgress) => void;

// Timeout heuristic: base of 15s + 5s per 1 000 frames of capture data.
// The main cost is booting the WASM (~10MB); the model load itself is fast.
export function mujocoTimeoutMs(frameCount: number): number {
  return 15_000 + Math.ceil(frameCount / 1_000) * 5_000;
}

export async function loadMuJoCo(
  onProgress?: MuJoCoProgressCallback,
  timeoutMs = 30_000
): Promise<MuJoCoInstance> {
  const startMs = performance.now();
  const elapsed = () => Math.round(performance.now() - startMs);
  const report = (stage: MuJoCoStage) => onProgress?.({ stage, elapsedMs: elapsed() });

  // Wrap the whole thing in a race against the timeout
  return Promise.race([
    _load(report),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs)
    ),
  ]);
}

async function _load(report: (stage: MuJoCoStage) => void): Promise<MuJoCoInstance> {
  // ── Stage 1: boot WASM ──────────────────────────────────────────────────
  report("booting");
  console.log("[MuJoCo] booting WASM module from /mujoco_wasm.js");

  let loadMujoco: (...args: unknown[]) => Promise<unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import(/* webpackIgnore: true */ "/mujoco_wasm.js") as any;
    loadMujoco = mod.default;
    if (typeof loadMujoco !== "function") throw new Error("mujoco_wasm.js did not export a default function");
  } catch (e) {
    console.error("[MuJoCo] failed to import /mujoco_wasm.js:", e);
    throw e;
  }

  let mujoco: unknown;
  try {
    mujoco = await loadMujoco();
    console.log("[MuJoCo] WASM module initialised");
  } catch (e) {
    console.error("[MuJoCo] WASM initialisation threw:", e);
    throw e;
  }

  // ── Stage 2: set up virtual filesystem ──────────────────────────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = mujoco as any;
    m.FS.mkdir("/working");
    m.FS.mount(m.MEMFS, { root: "." }, "/working");
    console.log("[MuJoCo] VFS mounted at /working");
  } catch (e) {
    console.error("[MuJoCo] VFS setup failed:", e);
    throw e;
  }

  // ── Stage 3: fetch hand model XML ───────────────────────────────────────
  report("fetching");
  console.log("[MuJoCo] fetching /models/holos_hands.xml");
  let xml: string;
  try {
    const xmlResponse = await fetch("/models/holos_hands.xml");
    if (!xmlResponse.ok) throw new Error(`HTTP ${xmlResponse.status} fetching /models/holos_hands.xml`);
    xml = await xmlResponse.text();
    console.log(`[MuJoCo] XML fetched (${xml.length} chars)`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mujoco as any).FS.writeFile("/working/holos_hands.xml", xml);
  } catch (e) {
    console.error("[MuJoCo] XML fetch/write failed:", e);
    throw e;
  }

  // ── Stage 4: load model + data ───────────────────────────────────────────
  report("loading");
  console.log("[MuJoCo] loading MjModel from XML");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = mujoco as any;
  let model: MjModel;
  let data: MjData;
  try {
    model = m.MjModel.loadFromXML("/working/holos_hands.xml");
    console.log(`[MuJoCo] MjModel loaded — nbody=${model.nbody}, nmocap=${model.nmocap}`);
    data = new m.MjData(model);
    console.log("[MuJoCo] MjData created");
  } catch (e) {
    console.error("[MuJoCo] model/data creation failed:", e);
    throw e;
  }

  // ── Stage 5: build mocap index ───────────────────────────────────────────
  report("indexing");
  const mocapIndex = new Map<string, number>();
  const bodyIndex  = new Map<string, number>();
  let mocapCount = 0;
  try {
    const OBJ_BODY: number = m.mjtObj.mjOBJ_BODY.value;
    for (let i = 0; i < model.nbody; i++) {
      const name: string = m.mj_id2name(model, OBJ_BODY, i);
      if (!name) continue;

      bodyIndex.set(name, i);

      const mocapidField = model.body_mocapid;
      let mid: number;
      if (typeof mocapidField?.get === "function") {
        mid = mocapidField.get(i);
      } else if (mocapidField && typeof mocapidField[i] === "number") {
        mid = mocapidField[i];
      } else {
        mid = i - 1;
      }
      if (mid >= 0) {
        mocapIndex.set(name, mid);
        mocapCount++;
      }
    }
    console.log(`[MuJoCo] index built — ${mocapCount} mocap bodies, ${bodyIndex.size} total bodies`);
  } catch (e) {
    console.error("[MuJoCo] mocap indexing failed:", e);
    throw e;
  }

  // ── Stage 6: find pressure_ball geom id ─────────────────────────────────
  // We need the geom id to match contacts involving the ball each frame.
  // Scan model.geom_bodyid to find geoms belonging to the ball body.
  const ballBodyId = bodyIndex.get("pressure_ball") ?? -1;
  let ballGeomId = -1;
  if (ballBodyId >= 0) {
    const ngeom: number = model.ngeom;
    for (let g = 0; g < ngeom; g++) {
      if (model.geom_bodyid[g] === ballBodyId) {
        ballGeomId = g;
        break;
      }
    }
    console.log(`[MuJoCo] pressure_ball — bodyId=${ballBodyId}, geomId=${ballGeomId}`);
  } else {
    console.warn("[MuJoCo] pressure_ball body not found — contact pressure disabled");
  }

  report("ready");
  return { mujoco: m, model, data, mocapIndex, bodyIndex, ballGeomId, ballBodyId };
}

// Write one hand's joint poses into MuJoCo mocap slots.
// prefix is "r_" or "l_" matching body names in holos_hands.xml.
function applyHand(instance: MuJoCoInstance, prefix: string, hand: HandPose) {
  const { data, mocapIndex } = instance;

  for (let i = 0; i < HAND_JOINT_NAMES.length; i++) {
    const bodyName = `${prefix}${HAND_JOINT_NAMES[i]}`;
    const mid = mocapIndex.get(bodyName);
    if (mid === undefined) continue;

    const pose = hand[i];

    data.mocap_pos[mid * 3 + 0] = pose.px;
    data.mocap_pos[mid * 3 + 1] = pose.py;
    data.mocap_pos[mid * 3 + 2] = pose.pz;

    // mocap_quat: [w, x, y, z] per mocap body (MuJoCo wxyz order, AVP gives xyzw)
    data.mocap_quat[mid * 4 + 0] = pose.qw;
    data.mocap_quat[mid * 4 + 1] = pose.qx;
    data.mocap_quat[mid * 4 + 2] = pose.qy;
    data.mocap_quat[mid * 4 + 3] = pose.qz;
  }
}

export function applyFrame(instance: MuJoCoInstance, frame: CaptureFrame) {
  if (frame.rightHand) applyHand(instance, "r_", frame.rightHand);
  if (frame.leftHand)  applyHand(instance, "l_", frame.leftHand);

  instance.mujoco.mj_forward(instance.model, instance.data);
}

// ---------------------------------------------------------------------------
// Contact pressure readout — call after applyFrame each frame.
// Iterates data.contact[0..ncon], finds contacts involving the ball geom,
// calls mj_contactForce to get the 6-DOF wrench, uses the normal component.
// Returns total pressure (N) and current ball world-space position.
// ---------------------------------------------------------------------------
export interface PressureResult {
  pressure: number;           // summed normal contact force in Newtons
  contactCount: number;       // number of active contacts on the ball
  ballPos: [number, number, number];
}

// Reusable Float64Array for mj_contactForce output (6 elements: fx,fy,fz,tx,ty,tz)
const _forceBuffer = new Float64Array(6);

export function readContactPressure(instance: MuJoCoInstance): PressureResult {
  const { mujoco, model, data, ballBodyId, ballGeomId } = instance;

  // Ball world position from xpos
  const ballPos: [number, number, number] = ballBodyId >= 0
    ? [data.xpos[ballBodyId * 3], data.xpos[ballBodyId * 3 + 1], data.xpos[ballBodyId * 3 + 2]]
    : [0, 0.9, 0.5];

  if (ballGeomId < 0) return { pressure: 0, contactCount: 0, ballPos };

  const ncon: number = data.ncon;
  let pressure = 0;
  let contactCount = 0;

  for (let c = 0; c < ncon; c++) {
    const contact = data.contact.get(c);
    if (!contact) continue;

    // Check if either geom in this contact is the ball
    if (contact.geom1 !== ballGeomId && contact.geom2 !== ballGeomId) continue;
    // Skip inactive contacts (exclude != 0 means filtered out by MuJoCo)
    if (contact.exclude !== 0) continue;

    // Try mj_contactForce first (standard path for dynamic bodies).
    // For contacts involving mocap bodies, the solver may store the normal
    // force in efc_force[efc_address] instead of the contact wrench.
    mujoco.mj_contactForce(model, data, c, _forceBuffer);
    let normalForce = Math.abs(_forceBuffer[0]);

    // Fallback: read directly from efc_force if mj_contactForce returned zero
    if (normalForce === 0 && contact.efc_address >= 0) {
      normalForce = Math.abs(data.efc_force[contact.efc_address]);
    }

    pressure += normalForce;
    contactCount++;
  }

  return { pressure, contactCount, ballPos };
}
