import type { CaptureFrame, HandPose } from "@/lib/pkg/types";
import { HAND_JOINT_NAMES } from "@/lib/pkg/types";
import type { MjModel, MjData } from "mujoco-js/dist/mujoco_wasm";

export interface MuJoCoInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mujoco: any;
  model: MjModel;
  data: MjData;
  // Lookup table: body name → mocap index (into data.mocap_pos / mocap_quat)
  mocapIndex: Map<string, number>;
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
  // Rather than reading body_mocapid (a raw WASM int array with unreliable
  // JS bindings), we look up each known body by name and ask MuJoCo for its
  // mocap id via mj_name2id. MuJoCo assigns mocap ids in XML order starting
  // at 0, matching the order we wrote them in holos_hands.xml.
  report("indexing");
  const mocapIndex = new Map<string, number>();
  let mocapCount = 0;
  try {
    const OBJ_BODY: number = m.mjtObj.mjOBJ_BODY.value;
    for (let i = 0; i < model.nbody; i++) {
      const name: string = m.mj_id2name(model, OBJ_BODY, i);
      if (!name) continue; // body 0 is the world body — unnamed
      // Check if this body is a mocap body by looking it up in body_mocapid.
      // body_mocapid may be a typed array or an Emscripten wrapper — handle both.
      const mocapidField = model.body_mocapid;
      let mid: number;
      if (typeof mocapidField?.get === "function") {
        mid = mocapidField.get(i);
      } else if (mocapidField && typeof mocapidField[i] === "number") {
        mid = mocapidField[i];
      } else {
        // Fallback: treat every non-world body as a mocap body in order
        mid = i - 1; // body 0 is world, so first real body → mocap id 0
      }
      if (mid >= 0) {
        mocapIndex.set(name, mid);
        mocapCount++;
      }
    }
    console.log(`[MuJoCo] mocap index built — ${mocapCount} bodies, sample:`,
      [...mocapIndex.entries()].slice(0, 3));
  } catch (e) {
    console.error("[MuJoCo] mocap indexing failed:", e);
    throw e;
  }

  report("ready");
  return { mujoco: m, model, data, mocapIndex };
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

    // mocap_pos / mocap_quat are raw WASM typed arrays — use index access, not .set()
    // mocap_pos: [x, y, z] per mocap body
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

  // mj_forward: runs the full physics pipeline for this frame.
  // For pure replay this resolves contacts and updates body positions.
  // Future work (contact forces, object interaction) builds on this call.
  instance.mujoco.mj_forward(instance.model, instance.data);
}
