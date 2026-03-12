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
  report("booting");
  // Load from /public at runtime so Turbopack never tries to bundle the
  // ~10MB Emscripten file (which causes a stack overflow in its regex parser).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: loadMujoco } = await import(/* webpackIgnore: true */ "/mujoco_wasm.js") as any;
  const mujoco = await loadMujoco();

  // Set up Emscripten's in-memory virtual filesystem
  mujoco.FS.mkdir("/working");
  mujoco.FS.mount(mujoco.MEMFS, { root: "." }, "/working");

  report("fetching");
  const xmlResponse = await fetch("/models/holos_hands.xml");
  if (!xmlResponse.ok) throw new Error("Failed to fetch /models/holos_hands.xml");
  const xml = await xmlResponse.text();
  mujoco.FS.writeFile("/working/holos_hands.xml", xml);

  report("loading");
  const model: MjModel = mujoco.MjModel.loadFromXML("/working/holos_hands.xml");
  const data: MjData = new mujoco.MjData(model);

  report("indexing");
  const mocapIndex = new Map<string, number>();
  let mocapCount = 0;
  for (let i = 0; i < model.nbody; i++) {
    const mid: number = model.body_mocapid.get(i);
    if (mid >= 0) {
      const name: string = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, i);
      mocapIndex.set(name, mid);
      mocapCount++;
    }
  }

  report("ready");
  console.log(`MuJoCo loaded: ${mocapCount} mocap bodies`);
  return { mujoco, model, data, mocapIndex };
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

    // mocap_pos is a flat array: [x, y, z] per mocap body
    data.mocap_pos.set(mid * 3 + 0, pose.px);
    data.mocap_pos.set(mid * 3 + 1, pose.py);
    data.mocap_pos.set(mid * 3 + 2, pose.pz);

    // mocap_quat is a flat array: [w, x, y, z] per mocap body (MuJoCo uses wxyz order)
    data.mocap_quat.set(mid * 4 + 0, pose.qw);
    data.mocap_quat.set(mid * 4 + 1, pose.qx);
    data.mocap_quat.set(mid * 4 + 2, pose.qy);
    data.mocap_quat.set(mid * 4 + 3, pose.qz);
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
