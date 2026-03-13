import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MuJoCoInstance } from "@/lib/mujoco/loader";
import type { CaptureFrame } from "@/lib/pkg/types";
import { HAND_JOINT_NAMES } from "@/lib/pkg/types";

// Bone connections: pairs of joint indices (into HAND_JOINT_NAMES)
const BONE_PAIRS: [number, number][] = [
  // Thumb
  [0, 1], [1, 2], [2, 3],
  // Index
  [4, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [9, 10], [10, 11], [11, 12], [12, 13],
  // Ring
  [14, 15], [15, 16], [16, 17], [17, 18],
  // Little
  [19, 20], [20, 21], [21, 22], [22, 23],
  // Wrist to knuckles
  [24, 0], [24, 4], [24, 9], [24, 14], [24, 19],
  // Forearm
  [25, 24],
];

export interface HandScene {
  joints: THREE.Mesh[];
  bones:  THREE.Mesh[];
}

export interface HumanoidScene {
  joints: Map<string, THREE.Mesh>;    // body name → sphere mesh
  bones:  THREE.Mesh[];               // cylinder meshes between joint pairs
  segmentPairs: [string, string][];   // body name pairs for bone rendering
}

export interface ThreeScene {
  renderer: THREE.WebGLRenderer;
  scene:    THREE.Scene;
  camera:   THREE.PerspectiveCamera;
  controls: OrbitControls;
  rightHand: HandScene;
  leftHand:  HandScene;
  pressureBall: THREE.Mesh;
  humanoid: HumanoidScene | null;
  dispose:   () => void;
}

function makeJointSphere(color: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(0.012, 8, 8);
  const mat = new THREE.MeshStandardMaterial({ color });
  return new THREE.Mesh(geo, mat);
}

function makeBoneCylinder(color: number): THREE.Mesh {
  // Unit-height along Y; scaled per-frame to match bone length
  const geo = new THREE.CylinderGeometry(0.005, 0.005, 1, 6);
  const mat = new THREE.MeshStandardMaterial({ color });
  return new THREE.Mesh(geo, mat);
}

function makeHandScene(scene: THREE.Scene, color: number): HandScene {
  const joints: THREE.Mesh[] = [];
  for (let i = 0; i < 26; i++) {
    const mesh = makeJointSphere(color);
    scene.add(mesh);
    joints.push(mesh);
  }
  const bones: THREE.Mesh[] = [];
  for (let i = 0; i < BONE_PAIRS.length; i++) {
    const mesh = makeBoneCylinder(color);
    scene.add(mesh);
    bones.push(mesh);
  }
  return { joints, bones };
}

function makeGrid(scene: THREE.Scene) {
  const grid = new THREE.GridHelper(6, 24, 0x334155, 0x1e293b);
  grid.position.set(0, 0.5, 0.5);
  scene.add(grid);

  const backGrid = new THREE.GridHelper(6, 24, 0x334155, 0x1e293b);
  backGrid.rotation.x = Math.PI / 2;
  backGrid.position.set(0, 1.0, -0.5);
  scene.add(backGrid);

  const axes = new THREE.AxesHelper(0.15);
  axes.position.set(0, 0.5, 0.5);
  scene.add(axes);
}

// ---------------------------------------------------------------------------
// Pressure ball — a visible sphere whose color reflects contact pressure.
// Starts translucent blue; shifts yellow then red as force increases.
// The position is driven entirely by MuJoCo xpos output each frame.
// ---------------------------------------------------------------------------
const BALL_RADIUS = 0.04;
const _ballColor  = new THREE.Color();

function makePressureBall(scene: THREE.Scene): THREE.Mesh {
  const geo = new THREE.SphereGeometry(BALL_RADIUS, 16, 16);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3380ff,
    transparent: true,
    opacity: 0.75,
    roughness: 0.3,
    metalness: 0.1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 0.9, 0.5); // matches XML pos
  scene.add(mesh);
  return mesh;
}

// Map pressure (Newtons) → RGB color.
// 0 N     → blue  (0x3380ff)
// ~5 N    → cyan  (0x00e5ff)
// ~15 N   → yellow(0xffe000)
// ≥30 N   → red   (0xff2020)
// Scale is tuned for fingertip contact forces; adjust MAX_PRESSURE as needed.
const MAX_PRESSURE = 30; // N — saturates to full red

function pressureToColor(pressure: number): THREE.Color {
  const t = Math.min(pressure / MAX_PRESSURE, 1);

  // Three-stop gradient: blue → yellow → red
  if (t < 0.5) {
    const s = t * 2; // 0→1 over first half
    _ballColor.setRGB(s * 1.0, s * 0.88, 1.0 - s * 0.75); // blue→yellow
  } else {
    const s = (t - 0.5) * 2; // 0→1 over second half
    _ballColor.setRGB(1.0, 0.88 - s * 0.75, 0.25 - s * 0.11); // yellow→red
  }
  return _ballColor;
}

export function updatePressureBall(
  threeScene: ThreeScene,
  ballPos: [number, number, number],
  pressure: number
) {
  const { pressureBall } = threeScene;
  pressureBall.position.set(ballPos[0], ballPos[1], ballPos[2]);

  const mat = pressureBall.material as THREE.MeshStandardMaterial;
  mat.color.copy(pressureToColor(pressure));

  // Increase opacity with pressure: 0.55 at rest → 0.95 at max
  mat.opacity = 0.55 + Math.min(pressure / MAX_PRESSURE, 1) * 0.40;
}

export function initThreeScene(canvas: HTMLCanvasElement): ThreeScene {
  const w = canvas.clientWidth  || canvas.parentElement?.clientWidth  || 800;
  const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 600;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  renderer.setClearColor(0x09090b); // zinc-950

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x09090b, 8, 20);

  const camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 100);
  camera.position.set(0.1, 1.8, 3.2);
  camera.lookAt(0.1, 1.0, 0.5);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance   = 0.3;
  controls.maxDistance   = 15;
  controls.target.set(0.1, 1.0, 0.5);
  controls.update();

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight(0xffffff, 1.2);
  directional.position.set(2, 4, 3);
  scene.add(directional);

  makeGrid(scene);

  const rightHand    = makeHandScene(scene, 0xe69966); // orange
  const leftHand     = makeHandScene(scene, 0x6699e6); // blue
  const pressureBall = makePressureBall(scene);

  const dispose = () => {
    controls.dispose();
    renderer.dispose();
    scene.clear();
  };

  return { renderer, scene, camera, controls, rightHand, leftHand, pressureBall, humanoid: null, dispose };
}

// ---------------------------------------------------------------------------
// Camera framing
// ---------------------------------------------------------------------------
export function aimCameraAtCapture(
  threeScene: ThreeScene,
  frames: CaptureFrame[]
) {
  const { camera } = threeScene;
  if (frames.length === 0) return;

  let minX =  Infinity, maxX = -Infinity;
  let minY =  Infinity, maxY = -Infinity;
  let minZ =  Infinity, maxZ = -Infinity;

  const step = Math.max(1, Math.floor(frames.length / 500));
  for (let i = 0; i < frames.length; i += step) {
    const f = frames[i];
    for (const hand of [f.rightHand, f.leftHand]) {
      if (!hand) continue;
      const w = hand[24]; // forearmWrist
      if (!w) continue;
      if (w.px < minX) minX = w.px;
      if (w.px > maxX) maxX = w.px;
      if (w.py < minY) minY = w.py;
      if (w.py > maxY) maxY = w.py;
      if (w.pz < minZ) minZ = w.pz;
      if (w.pz > maxZ) maxZ = w.pz;
    }
  }

  if (!isFinite(minX)) return;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  const maxSpan = Math.max(spanX, spanY, spanZ, 0.5);

  const dist = maxSpan * 1.6;
  camera.position.set(cx, cy + maxSpan * 0.3, cz + dist);
  camera.lookAt(cx, cy, cz);
  threeScene.controls.target.set(cx, cy, cz);
  threeScene.controls.update();
}

// ---------------------------------------------------------------------------
// Bone update helper
// ---------------------------------------------------------------------------
const _posA    = new THREE.Vector3();
const _posB    = new THREE.Vector3();
const _mid     = new THREE.Vector3();
const _dir     = new THREE.Vector3();
const _up      = new THREE.Vector3(0, 1, 0);
const _boneQuat = new THREE.Quaternion();

function updateBone(bone: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  _mid.addVectors(a, b).multiplyScalar(0.5);
  bone.position.copy(_mid);
  _dir.subVectors(b, a);
  const length = _dir.length();
  if (length < 0.0001) { bone.visible = false; return; }
  bone.visible = true;
  _boneQuat.setFromUnitVectors(_up, _dir.normalize());
  bone.quaternion.copy(_boneQuat);
  bone.scale.set(1, length, 1);
}

// Index of the forearm bone ([25,24]) and the forearmArm joint (25).
// When the humanoid is active these are hidden — the humanoid arm replaces them.
const FOREARM_BONE_IDX  = BONE_PAIRS.length - 1; // index 24
const FOREARM_ARM_JOINT = 25; // forearmArm joint index

// ---------------------------------------------------------------------------
// Sync hand meshes from a parsed CaptureFrame
// ---------------------------------------------------------------------------
function syncHandFromFrame(
  handScene: HandScene,
  frame: CaptureFrame,
  chirality: "left" | "right",
  hideForarm = false
) {
  const hand = chirality === "right" ? frame.rightHand : frame.leftHand;
  if (!hand) {
    handScene.joints.forEach(j => { j.visible = false; });
    handScene.bones.forEach(b =>  { b.visible = false; });
    return;
  }
  handScene.joints.forEach(j => { j.visible = true; });
  for (let i = 0; i < HAND_JOINT_NAMES.length; i++) {
    const p = hand[i];
    handScene.joints[i].position.set(p.px, p.py, p.pz);
  }
  if (hideForarm) {
    handScene.joints[FOREARM_ARM_JOINT].visible = false;
  }
  for (let b = 0; b < BONE_PAIRS.length; b++) {
    const [ai, bi] = BONE_PAIRS[b];
    _posA.copy(handScene.joints[ai].position);
    _posB.copy(handScene.joints[bi].position);
    updateBone(handScene.bones[b], _posA, _posB);
  }
  if (hideForarm) {
    handScene.bones[FOREARM_BONE_IDX].visible = false;
  }
}

export function renderFromFrame(threeScene: ThreeScene, frame: CaptureFrame) {
  const { renderer, scene, camera, controls, rightHand, leftHand } = threeScene;
  const hideForarm = threeScene.humanoid !== null;
  syncHandFromFrame(rightHand, frame, "right", hideForarm);
  syncHandFromFrame(leftHand,  frame, "left",  hideForarm);
  if (controls.enabled) controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Sync hand meshes from MuJoCo
// ---------------------------------------------------------------------------
export type MuJoCoReadMode = "mocap" | "xpos";

let _lastXposWarnMs = 0;

function syncHandFromMujoco(
  handScene: HandScene,
  instance: MuJoCoInstance,
  prefix: string,
  readMode: MuJoCoReadMode,
  hideForarm = false
) {
  const { data, mocapIndex, bodyIndex } = instance;

  for (let i = 0; i < HAND_JOINT_NAMES.length; i++) {
    const bodyName = `${prefix}${HAND_JOINT_NAMES[i]}`;
    let x: number, y: number, z: number;

    if (readMode === "xpos") {
      const bid = bodyIndex.get(bodyName);
      if (bid === undefined) {
        handScene.joints[i].visible = false;
        continue;
      }
      x = data.xpos[bid * 3 + 0];
      y = data.xpos[bid * 3 + 1];
      z = data.xpos[bid * 3 + 2];

      const now = performance.now();
      if (now - _lastXposWarnMs > 1000) {
        if (isNaN(x) || isNaN(y) || isNaN(z)) {
          console.warn(`[MuJoCo] xpos NaN for body "${bodyName}" (bid=${bid})`);
          _lastXposWarnMs = now;
        } else if (x === 0 && y === 0 && z === 0 && i === 0) {
          console.warn(`[MuJoCo] xpos is (0,0,0) for "${bodyName}" — body id mapping may be wrong`);
          _lastXposWarnMs = now;
        }
      }
    } else {
      const mid = mocapIndex.get(bodyName);
      if (mid === undefined) {
        handScene.joints[i].visible = false;
        continue;
      }
      x = data.mocap_pos[mid * 3 + 0];
      y = data.mocap_pos[mid * 3 + 1];
      z = data.mocap_pos[mid * 3 + 2];
    }

    handScene.joints[i].position.set(x, y, z);
    handScene.joints[i].visible = true;
  }

  if (hideForarm) {
    handScene.joints[FOREARM_ARM_JOINT].visible = false;
  }

  for (let b = 0; b < BONE_PAIRS.length; b++) {
    const [ai, bi] = BONE_PAIRS[b];
    _posA.copy(handScene.joints[ai].position);
    _posB.copy(handScene.joints[bi].position);
    updateBone(handScene.bones[b], _posA, _posB);
  }

  if (hideForarm) {
    handScene.bones[FOREARM_BONE_IDX].visible = false;
  }
}

// ---------------------------------------------------------------------------
// Humanoid stick-figure rendering
// ---------------------------------------------------------------------------

const HUMANOID_SEGMENT_PAIRS: [string, string][] = [
  // Spine
  ["torso", "waist_lower"],
  ["waist_lower", "pelvis"],
  // Right arm: shoulder → elbow → AVP wrist
  ["torso", "upper_arm_right"],
  ["upper_arm_right", "lower_arm_right"],
  ["lower_arm_right", "r_forearmWrist"],
  // Left arm: shoulder → elbow → AVP wrist
  ["torso", "upper_arm_left"],
  ["upper_arm_left", "lower_arm_left"],
  ["lower_arm_left", "l_forearmWrist"],
  // Right leg
  ["pelvis", "thigh_right"],
  ["thigh_right", "shin_right"],
  ["shin_right", "foot_right"],
  // Left leg
  ["pelvis", "thigh_left"],
  ["thigh_left", "shin_left"],
  ["shin_left", "foot_left"],
  // Head
  ["torso", "head"],
];

// Humanoid MuJoCo bodies — positions read from data.xpos
const HUMANOID_BODY_NAMES = [
  "torso", "head", "waist_lower", "pelvis",
  "upper_arm_right", "lower_arm_right",
  "upper_arm_left",  "lower_arm_left",
  "thigh_right", "shin_right", "foot_right",
  "thigh_left",  "shin_left",  "foot_left",
];

// Mocap anchor names used as arm endpoints — positions read from data.mocap_pos
const HUMANOID_MOCAP_ANCHORS = ["r_forearmWrist", "l_forearmWrist"];

export function makeHumanoidScene(scene: THREE.Scene): HumanoidScene {
  const joints = new Map<string, THREE.Mesh>();
  // Body joints (sphere markers at each body origin)
  for (const name of HUMANOID_BODY_NAMES) {
    const geo = new THREE.SphereGeometry(0.04, 8, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    scene.add(mesh);
    joints.set(name, mesh);
  }
  // Mocap wrist anchors — slightly smaller spheres, same color
  for (const name of HUMANOID_MOCAP_ANCHORS) {
    const geo = new THREE.SphereGeometry(0.03, 8, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    scene.add(mesh);
    joints.set(name, mesh);
  }

  const bones: THREE.Mesh[] = [];
  for (let i = 0; i < HUMANOID_SEGMENT_PAIRS.length; i++) {
    const mesh = makeBoneCylinder(0x888888);
    mesh.visible = false;
    scene.add(mesh);
    bones.push(mesh);
  }

  return { joints, bones, segmentPairs: HUMANOID_SEGMENT_PAIRS };
}

const _hPosA = new THREE.Vector3();
const _hPosB = new THREE.Vector3();

function renderHumanoidFromMujoco(
  humanoidScene: HumanoidScene,
  instance: MuJoCoInstance
) {
  const { data, humanoidBodyIds, mocapIndex } = instance;
  const { joints, bones, segmentPairs } = humanoidScene;

  for (const [name, mesh] of joints) {
    // Mocap anchor: read from mocap_pos
    const mid = mocapIndex.get(name);
    if (mid !== undefined) {
      mesh.position.set(
        data.mocap_pos[mid * 3 + 0],
        data.mocap_pos[mid * 3 + 1],
        data.mocap_pos[mid * 3 + 2]
      );
      mesh.visible = true;
      continue;
    }
    // Humanoid dynamic body: read from xpos
    const bid = humanoidBodyIds.get(name);
    if (bid === undefined) { mesh.visible = false; continue; }
    mesh.position.set(
      data.xpos[bid * 3 + 0],
      data.xpos[bid * 3 + 1],
      data.xpos[bid * 3 + 2]
    );
    mesh.visible = true;
  }

  for (let i = 0; i < segmentPairs.length; i++) {
    const [nameA, nameB] = segmentPairs[i];
    const meshA = joints.get(nameA);
    const meshB = joints.get(nameB);
    if (!meshA?.visible || !meshB?.visible) {
      bones[i].visible = false;
      continue;
    }
    _hPosA.copy(meshA.position);
    _hPosB.copy(meshB.position);
    updateBone(bones[i], _hPosA, _hPosB);
  }
}

export function renderFromMujoco(
  threeScene: ThreeScene,
  instance: MuJoCoInstance,
  readMode: MuJoCoReadMode = "mocap"
) {
  const { renderer, scene, camera, controls, rightHand, leftHand } = threeScene;
  const hideForarm = threeScene.humanoid !== null;
  syncHandFromMujoco(rightHand, instance, "r_", readMode, hideForarm);
  syncHandFromMujoco(leftHand,  instance, "l_", readMode, hideForarm);
  if (threeScene.humanoid) renderHumanoidFromMujoco(threeScene.humanoid, instance);
  if (controls.enabled) controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Camera follow
// ---------------------------------------------------------------------------
const _headPos    = new THREE.Vector3();
const _headQuat   = new THREE.Quaternion();
const _forward    = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();

export function applyCameraFromDevicePose(
  threeScene: ThreeScene,
  frame: CaptureFrame
) {
  const { camera } = threeScene;
  const dp = frame.devicePose;
  if (!dp) return;

  _headPos.set(dp.x, dp.y, dp.z);
  _headQuat.set(dp.qx, dp.qy, dp.qz, dp.qw).normalize();
  _forward.set(0, 0, -1).applyQuaternion(_headQuat);

  camera.position.copy(_headPos)
    .addScaledVector(_forward, -0.15)
    .y += 0.05;

  _lookTarget.copy(_headPos).addScaledVector(_forward, 0.8);
  camera.lookAt(_lookTarget);
}

export function resizeRenderer(threeScene: ThreeScene, canvas: HTMLCanvasElement) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  threeScene.renderer.setSize(w, h);
  threeScene.camera.aspect = w / h;
  threeScene.camera.updateProjectionMatrix();
}

export function setControlsDistance(threeScene: ThreeScene, dist: number) {
  const { camera, controls } = threeScene;
  const dir = new THREE.Vector3()
    .subVectors(camera.position, controls.target)
    .normalize();
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  controls.update();
}
