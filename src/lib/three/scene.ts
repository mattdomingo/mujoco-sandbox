import * as THREE from "three";
import type { MuJoCoInstance } from "@/lib/mujoco/loader";

// Bone connections: pairs of joint indices (into HAND_JOINT_NAMES) to draw
// cylinders between. Mirrors the anatomical structure of the AVP skeleton.
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
  // Joint spheres: index = mocap body index
  joints: THREE.Mesh[];
  // Bone cylinders: one per BONE_PAIRS entry
  bones: THREE.Mesh[];
}

export interface ThreeScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  rightHand: HandScene;
  leftHand: HandScene;
  dispose: () => void;
}

function makeJointSphere(color: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(0.012, 8, 8);
  const mat = new THREE.MeshStandardMaterial({ color });
  return new THREE.Mesh(geo, mat);
}

function makeBoneCylinder(color: number): THREE.Mesh {
  // Unit-height cylinder along Y axis; we scale and reposition each frame
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

export function initThreeScene(canvas: HTMLCanvasElement): ThreeScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.setClearColor(0x09090b); // zinc-950

  const scene = new THREE.Scene();

  // Camera: positioned ~1.5m back, looking at origin (where hands start)
  const camera = new THREE.PerspectiveCamera(
    60,
    canvas.clientWidth / canvas.clientHeight,
    0.01,
    100
  );
  camera.position.set(0, 1.2, 1.5);
  camera.lookAt(0, 1.0, 0);

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight(0xffffff, 1.0);
  directional.position.set(1, 2, 2);
  scene.add(directional);

  // Right hand: orange, Left hand: blue
  const rightHand = makeHandScene(scene, 0xe69966);
  const leftHand  = makeHandScene(scene, 0x6699e6);

  const dispose = () => {
    renderer.dispose();
    scene.clear();
  };

  return { renderer, scene, camera, rightHand, leftHand, dispose };
}

// Reusable vectors to avoid per-frame allocation
const _posA = new THREE.Vector3();
const _posB = new THREE.Vector3();
const _mid  = new THREE.Vector3();
const _dir  = new THREE.Vector3();
const _up   = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();

function updateBone(bone: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  _mid.addVectors(a, b).multiplyScalar(0.5);
  bone.position.copy(_mid);

  _dir.subVectors(b, a);
  const length = _dir.length();
  if (length < 0.0001) { bone.visible = false; return; }
  bone.visible = true;

  _quat.setFromUnitVectors(_up, _dir.normalize());
  bone.quaternion.copy(_quat);
  bone.scale.set(1, length, 1);
}

function syncHandMeshes(
  handScene: HandScene,
  instance: MuJoCoInstance,
  // mocapBodyOffset: the first mocap index belonging to this hand
  mocapOffset: number
) {
  const { data } = instance;

  // Update joint sphere positions from MuJoCo xpos
  // xpos is indexed by body id (not mocap id), but for pure mocap bodies
  // body position === mocap position after mj_forward.
  // We read from mocap_pos directly since we wrote it and mj_forward preserves it.
  for (let i = 0; i < 26; i++) {
    const mid = mocapOffset + i;
    const x = data.mocap_pos.get(mid * 3 + 0);
    const y = data.mocap_pos.get(mid * 3 + 1);
    const z = data.mocap_pos.get(mid * 3 + 2);
    handScene.joints[i].position.set(x, y, z);
  }

  // Update bone cylinders
  for (let b = 0; b < BONE_PAIRS.length; b++) {
    const [ai, bi] = BONE_PAIRS[b];
    _posA.copy(handScene.joints[ai].position);
    _posB.copy(handScene.joints[bi].position);
    updateBone(handScene.bones[b], _posA, _posB);
  }
}

export function renderFrame(threeScene: ThreeScene, instance: MuJoCoInstance) {
  const { renderer, scene, camera, rightHand, leftHand } = threeScene;
  const { mocapIndex } = instance;

  // Find the mocap offset for each hand by looking up the first joint.
  // mocapIndex maps body name → mocap id; right hand starts at r_thumbKnuckle.
  const rightOffset = mocapIndex.get("r_thumbKnuckle") ?? 0;
  const leftOffset  = mocapIndex.get("l_thumbKnuckle") ?? 26;

  syncHandMeshes(rightHand, instance, rightOffset);
  syncHandMeshes(leftHand,  instance, leftOffset);

  renderer.render(scene, camera);
}

export function resizeRenderer(threeScene: ThreeScene, canvas: HTMLCanvasElement) {
  const { renderer, camera } = threeScene;
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
}
