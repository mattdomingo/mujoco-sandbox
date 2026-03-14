import type { CaptureFrame, HandPose, HumanoidFrame, HumanoidArmAngles } from "@/lib/pkg/types";
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
  // geom ids belonging to the right-hand and left-hand mocap bodies
  rightHandGeomIds: Set<number>;
  leftHandGeomIds: Set<number>;
  // Humanoid body ids for Three.js rendering (read from data.xpos)
  humanoidBodyIds: Map<string, number>;
  // qpos addresses for arm hinge joints
  rShoulder1QposAdr: number;
  rShoulder2QposAdr: number;
  rElbowQposAdr: number;
  lShoulder1QposAdr: number;
  lShoulder2QposAdr: number;
  lElbowQposAdr: number;
}

export type MuJoCoStage =
  | "booting"      // importing + initialising the WASM module
  | "fetching"     // fetching holos_humanoid.xml
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
    // @ts-expect-error Runtime-served asset loaded outside the Next.js module graph.
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

  // ── Stage 3: fetch humanoid model XML ───────────────────────────────────
  report("fetching");
  console.log("[MuJoCo] fetching /models/holos_humanoid.xml");
  let xml: string;
  try {
    const xmlResponse = await fetch("/models/holos_humanoid.xml");
    if (!xmlResponse.ok) throw new Error(`HTTP ${xmlResponse.status} fetching /models/holos_humanoid.xml`);
    xml = await xmlResponse.text();
    console.log(`[MuJoCo] XML fetched (${xml.length} chars)`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mujoco as any).FS.writeFile("/working/holos_humanoid.xml", xml);
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
    model = m.MjModel.loadFromXML("/working/holos_humanoid.xml");
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
  const bodyNames: string[] = new Array(model.nbody);
  let mocapCount = 0;
  try {
    const OBJ_BODY: number = m.mjtObj.mjOBJ_BODY.value;
    for (let i = 0; i < model.nbody; i++) {
      const name: string = m.mj_id2name(model, OBJ_BODY, i);
      if (!name) continue;

      bodyNames[i] = name;
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

  // ── Stage 6: index humanoid body ids + arm joint qpos addresses ─────────
  const OBJ_JOINT: number = m.mjtObj.mjOBJ_JOINT.value;
  const jntQposAdr = (name: string): number => {
    const id: number = m.mj_name2id(model, OBJ_JOINT, name);
    return id >= 0 ? (model.jnt_qposadr[id] as number) : -1;
  };

  const rShoulder1QposAdr = jntQposAdr("shoulder1_right");
  const rShoulder2QposAdr = jntQposAdr("shoulder2_right");
  const rElbowQposAdr     = jntQposAdr("elbow_right");
  const lShoulder1QposAdr = jntQposAdr("shoulder1_left");
  const lShoulder2QposAdr = jntQposAdr("shoulder2_left");
  const lElbowQposAdr     = jntQposAdr("elbow_left");

  console.log(
    `[MuJoCo] arm joint qpos addresses — ` +
    `rS1=${rShoulder1QposAdr} rS2=${rShoulder2QposAdr} rE=${rElbowQposAdr} ` +
    `lS1=${lShoulder1QposAdr} lS2=${lShoulder2QposAdr} lE=${lElbowQposAdr}`
  );

  const humanoidBodyNames = [
    "torso", "head", "waist_lower", "pelvis",
    "upper_arm_right", "lower_arm_right", "hand_right",
    "upper_arm_left",  "lower_arm_left",  "hand_left",
    "thigh_right", "shin_right", "foot_right",
    "thigh_left",  "shin_left",  "foot_left",
  ];
  const humanoidBodyIds = new Map<string, number>();
  for (const name of humanoidBodyNames) {
    const id = bodyIndex.get(name);
    if (id !== undefined) humanoidBodyIds.set(name, id);
  }
  console.log(`[MuJoCo] humanoid body ids indexed — ${humanoidBodyIds.size} bodies`);

  // ── Stage 7: find pressure_ball geom id + hand geom sets ────────────────
  // These geom ids let us query ball contacts and left↔right hand contacts.
  const ballBodyId = bodyIndex.get("pressure_ball") ?? -1;
  let ballGeomId = -1;
  const rightHandGeomIds = new Set<number>();
  const leftHandGeomIds = new Set<number>();
  const ngeom: number = model.ngeom;
  for (let g = 0; g < ngeom; g++) {
    const geomBodyId = model.geom_bodyid[g];
    if (geomBodyId < 0) continue;

    if (geomBodyId === ballBodyId && ballGeomId < 0) {
      ballGeomId = g;
    }

    const bodyName = bodyNames[geomBodyId];
    if (!bodyName) continue;
    if (bodyName.startsWith("r_")) {
      rightHandGeomIds.add(g);
    } else if (bodyName.startsWith("l_")) {
      leftHandGeomIds.add(g);
    }
  }

  if (ballBodyId >= 0) {
    console.log(`[MuJoCo] pressure_ball — bodyId=${ballBodyId}, geomId=${ballGeomId}`);
  } else {
    console.warn("[MuJoCo] pressure_ball body not found — contact pressure disabled");
  }
  console.log(
    `[MuJoCo] hand geom sets — right=${rightHandGeomIds.size}, left=${leftHandGeomIds.size}`
  );

  report("ready");
  return {
    mujoco: m,
    model,
    data,
    mocapIndex,
    bodyIndex,
    ballGeomId,
    ballBodyId,
    rightHandGeomIds,
    leftHandGeomIds,
    humanoidBodyIds,
    rShoulder1QposAdr,
    rShoulder2QposAdr,
    rElbowQposAdr,
    lShoulder1QposAdr,
    lShoulder2QposAdr,
    lElbowQposAdr,
  };
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

// Write torso freejoint pose into qpos[0..6]: [px, py, pz, qw, qx, qy, qz]
function applyTorso(instance: MuJoCoInstance, hf: HumanoidFrame) {
  const { data } = instance;
  data.qpos[0] = hf.torsoPos[0];
  data.qpos[1] = hf.torsoPos[1];
  data.qpos[2] = hf.torsoPos[2];
  data.qpos[3] = hf.torsoQuat[0]; // w
  data.qpos[4] = hf.torsoQuat[1]; // x
  data.qpos[5] = hf.torsoQuat[2]; // y
  data.qpos[6] = hf.torsoQuat[3]; // z
}

// Write IK-solved arm hinge angles into their qpos slots.
function applyArmIK(instance: MuJoCoInstance, arms: HumanoidArmAngles) {
  const { data } = instance;
  if (instance.rShoulder1QposAdr >= 0) data.qpos[instance.rShoulder1QposAdr] = arms.rShoulder1;
  if (instance.rShoulder2QposAdr >= 0) data.qpos[instance.rShoulder2QposAdr] = arms.rShoulder2;
  if (instance.rElbowQposAdr     >= 0) data.qpos[instance.rElbowQposAdr]     = arms.rElbow;
  if (instance.lShoulder1QposAdr >= 0) data.qpos[instance.lShoulder1QposAdr] = arms.lShoulder1;
  if (instance.lShoulder2QposAdr >= 0) data.qpos[instance.lShoulder2QposAdr] = arms.lShoulder2;
  if (instance.lElbowQposAdr     >= 0) data.qpos[instance.lElbowQposAdr]     = arms.lElbow;
}

export function applyFrame(
  instance: MuJoCoInstance,
  frame: CaptureFrame,
  humanoidFrame?: HumanoidFrame
) {
  if (frame.rightHand) applyHand(instance, "r_", frame.rightHand);
  if (frame.leftHand)  applyHand(instance, "l_", frame.leftHand);
  if (humanoidFrame) {
    applyTorso(instance, humanoidFrame);
    applyArmIK(instance, humanoidFrame.arms);
  }

  instance.mujoco.mj_forward(instance.model, instance.data);
}

// ---------------------------------------------------------------------------
// Contact force readouts — call after applyFrame each frame.
// We read MuJoCo's active contacts and sum the normal force component. For
// mocap-driven geoms, mj_contactForce may report zero, so we fall back to the
// corresponding efc_force slot when needed.
// ---------------------------------------------------------------------------
export interface ContactForceResult {
  pressure: number;           // summed normal contact force in Newtons
  contactCount: number;       // number of active contacts matching the query
}

export interface PressureResult extends ContactForceResult {
  ballPos: [number, number, number];
}

// Reusable Float64Array for mj_contactForce output (6 elements: fx,fy,fz,tx,ty,tz)
const _forceBuffer = new Float64Array(6);

// Plain-object snapshot of the MjContact fields we need — extracted before
// calling contact.delete() so the C++ heap object can be freed immediately.
interface ContactSnapshot {
  exclude: number;
  geom1: number;
  geom2: number;
  efc_address: number;
}

function readNormalForce(
  instance: MuJoCoInstance,
  contactIndex: number,
  contact: ContactSnapshot
): number {
  const { mujoco, model, data } = instance;

  mujoco.mj_contactForce(model, data, contactIndex, _forceBuffer);
  let normalForce = Math.abs(_forceBuffer[0]);

  // Contacts involving mocap bodies often expose their solver force here.
  if (normalForce === 0 && contact.efc_address >= 0) {
    normalForce = Math.abs(data.efc_force[contact.efc_address]);
  }

  return normalForce;
}

function readContactForceSum(
  instance: MuJoCoInstance,
  includeContact: (contact: ContactSnapshot) => boolean
): ContactForceResult {
  const { data } = instance;
  const ncon: number = data.ncon;
  let pressure = 0;
  let contactCount = 0;

  for (let c = 0; c < ncon; c++) {
    const raw = data.contact.get(c);
    if (!raw) continue;

    // Extract all needed fields then free the C++ heap object immediately.
    // Without .delete(), each .get() allocates a new C++ wrapper that is never
    // GC'd, causing WASM memory to grow unboundedly until it hits the 2 GB
    // limit and aborts.
    const contact: ContactSnapshot = {
      exclude:     raw.exclude,
      geom1:       raw.geom1,
      geom2:       raw.geom2,
      efc_address: raw.efc_address,
    };
    raw.delete();

    if (contact.exclude !== 0) continue;
    if (!includeContact(contact)) continue;

    pressure += readNormalForce(instance, c, contact);
    contactCount++;
  }

  return { pressure, contactCount };
}

export function readContactPressure(instance: MuJoCoInstance): PressureResult {
  const { data, ballBodyId, ballGeomId } = instance;

  // Ball world position from xpos
  const ballPos: [number, number, number] = ballBodyId >= 0
    ? [data.xpos[ballBodyId * 3], data.xpos[ballBodyId * 3 + 1], data.xpos[ballBodyId * 3 + 2]]
    : [0, 0.9, 0.5];

  if (ballGeomId < 0) return { pressure: 0, contactCount: 0, ballPos };

  const result = readContactForceSum(
    instance,
    (contact) => contact.geom1 === ballGeomId || contact.geom2 === ballGeomId
  );

  return { ...result, ballPos };
}

export function readInterHandPressure(instance: MuJoCoInstance): ContactForceResult {
  const { rightHandGeomIds, leftHandGeomIds } = instance;

  return readContactForceSum(instance, (contact) => (
    (rightHandGeomIds.has(contact.geom1) && leftHandGeomIds.has(contact.geom2)) ||
    (rightHandGeomIds.has(contact.geom2) && leftHandGeomIds.has(contact.geom1))
  ));
}
