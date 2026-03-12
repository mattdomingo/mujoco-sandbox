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

export async function loadMuJoCo(): Promise<MuJoCoInstance> {
  // mujoco-js ships a plain Emscripten ESM with no bundler-friendly types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: loadMujoco } = await import("mujoco-js/dist/mujoco_wasm.js") as any;
  const mujoco = await loadMujoco();

  // Set up Emscripten's in-memory virtual filesystem
  mujoco.FS.mkdir("/working");
  mujoco.FS.mount(mujoco.MEMFS, { root: "." }, "/working");

  const xmlResponse = await fetch("/models/holos_hands.xml");
  if (!xmlResponse.ok) throw new Error("Failed to fetch /models/holos_hands.xml");
  const xml = await xmlResponse.text();
  mujoco.FS.writeFile("/working/holos_hands.xml", xml);

  const model: MjModel = mujoco.MjModel.loadFromXML("/working/holos_hands.xml");
  const data: MjData = new mujoco.MjData(model);

  // Build a map from body name → mocap index so applyFrame can look up fast.
  // MuJoCo assigns mocap indices in the order bodies appear in the XML.
  const mocapIndex = new Map<string, number>();
  let mocapCount = 0;
  for (let i = 0; i < model.nbody; i++) {
    // model.body_mocapid[i] is -1 for non-mocap bodies, >=0 for mocap bodies
    const mid: number = model.body_mocapid.get(i);
    if (mid >= 0) {
      // Decode the body name from MuJoCo's name buffer
      const name: string = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, i);
      mocapIndex.set(name, mid);
      mocapCount++;
    }
  }

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
