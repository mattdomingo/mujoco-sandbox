import type { CaptureFrame } from "../pkg/types";

export async function loadMuJoCo() {
  // TODO: Dynamically import /public/mujoco/mujoco_wasm.js
  //       e.g. const mujoco = await import("/mujoco/mujoco_wasm.js")
  // TODO: Mount Emscripten virtual filesystem (VFS)
  //       Fetch /public/models/hand.xml (and any mesh files) and write into VFS
  // TODO: Call mujoco.MjModel.from_xml_path("hand.xml") to load the model
  // TODO: Call mujoco.MjData(model) to create simulation data
  // TODO: Return { mujoco, model, data }
  throw new Error("loadMuJoCo not yet implemented");
}

export function applyFrame(instance: unknown, frame: CaptureFrame) {
  // TODO: Write frame.leftHand joint positions into data.qpos (left-hand DOF range)
  // TODO: Write frame.rightHand joint positions into data.qpos (right-hand DOF range)
  // TODO: Call mujoco.mj_forward(model, data) — kinematics only, no physics step
}
