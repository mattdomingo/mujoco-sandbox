import * as THREE from "three";
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
  // Use the canvas's actual pixel dimensions. If it hasn't painted yet (0x0),
  // fall back to the parent's size or a sensible default — resizeRenderer()
  // will correct it on the next frame.
  const w = canvas.clientWidth  || canvas.parentElement?.clientWidth  || 800;
  const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 600;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  renderer.setClearColor(0x09090b); // zinc-950

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 100);
  // Default position — will be re-aimed at the hands once frame 0 is available
  camera.position.set(0, 1.0, 2.0);
  camera.lookAt(0, 1.0, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight(0xffffff, 1.2);
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

// Reusable vectors — avoid per-frame allocation
const _posA = new THREE.Vector3();
const _posB = new THREE.Vector3();
const _mid  = new THREE.Vector3();
const _dir  = new THREE.Vector3();
const _up   = new THREE.Vector3(0, 1, 0);
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

// ---------------------------------------------------------------------------
// Aim the camera at the centroid of the hands in a given frame.
// Called once after the first frame is available so the camera is never
// pointing at empty space.
// ---------------------------------------------------------------------------
export function aimCameraAtFrame(threeScene: ThreeScene, frame: CaptureFrame) {
  const { camera } = threeScene;
  const hand = frame.rightHand ?? frame.leftHand;
  if (!hand) return;

  // Use the wrist (index 24 = forearmWrist) as the focal point
  const wrist = hand[24] ?? hand[0];
  const target = new THREE.Vector3(wrist.px, wrist.py, wrist.pz);

  // Place camera 0.5m behind and 0.3m above the wrist, looking at it
  camera.position.set(target.x, target.y + 0.3, target.z + 0.5);
  camera.lookAt(target);
}

// ---------------------------------------------------------------------------
// Render directly from a CaptureFrame — used when MuJoCo hasn't loaded yet,
// or as a fast-path that bypasses MuJoCo when physics output isn't needed.
// ---------------------------------------------------------------------------
function syncHandFromFrame(handScene: HandScene, frame: CaptureFrame, chirality: "left" | "right") {
  const hand = chirality === "right" ? frame.rightHand : frame.leftHand;

  if (!hand) {
    // Hide all meshes for this hand
    handScene.joints.forEach(j => { j.visible = false; });
    handScene.bones.forEach(b => { b.visible = false; });
    return;
  }

  handScene.joints.forEach(j => { j.visible = true; });

  for (let i = 0; i < HAND_JOINT_NAMES.length; i++) {
    const pose = hand[i];
    handScene.joints[i].position.set(pose.px, pose.py, pose.pz);
  }

  for (let b = 0; b < BONE_PAIRS.length; b++) {
    const [ai, bi] = BONE_PAIRS[b];
    _posA.copy(handScene.joints[ai].position);
    _posB.copy(handScene.joints[bi].position);
    updateBone(handScene.bones[b], _posA, _posB);
  }
}

export function renderFromFrame(threeScene: ThreeScene, frame: CaptureFrame) {
  const { renderer, scene, camera, rightHand, leftHand } = threeScene;
  syncHandFromFrame(rightHand, frame, "right");
  syncHandFromFrame(leftHand,  frame, "left");
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Render from MuJoCo state — used during playback after MuJoCo has loaded.
// ---------------------------------------------------------------------------
function syncHandFromMujoco(
  handScene: HandScene,
  instance: MuJoCoInstance,
  mocapOffset: number
) {
  const { data } = instance;
  for (let i = 0; i < 26; i++) {
    const mid = mocapOffset + i;
    const x = data.mocap_pos.get(mid * 3 + 0);
    const y = data.mocap_pos.get(mid * 3 + 1);
    const z = data.mocap_pos.get(mid * 3 + 2);
    handScene.joints[i].position.set(x, y, z);
    handScene.joints[i].visible = true;
  }
  for (let b = 0; b < BONE_PAIRS.length; b++) {
    const [ai, bi] = BONE_PAIRS[b];
    _posA.copy(handScene.joints[ai].position);
    _posB.copy(handScene.joints[bi].position);
    updateBone(handScene.bones[b], _posA, _posB);
  }
}

export function renderFromMujoco(threeScene: ThreeScene, instance: MuJoCoInstance) {
  const { renderer, scene, camera, rightHand, leftHand } = threeScene;
  const { mocapIndex } = instance;
  const rightOffset = mocapIndex.get("r_thumbKnuckle") ?? 0;
  const leftOffset  = mocapIndex.get("l_thumbKnuckle") ?? 26;
  syncHandFromMujoco(rightHand, instance, rightOffset);
  syncHandFromMujoco(leftHand,  instance, leftOffset);
  renderer.render(scene, camera);
}

export function resizeRenderer(threeScene: ThreeScene, canvas: HTMLCanvasElement) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  threeScene.renderer.setSize(w, h);
  threeScene.camera.aspect = w / h;
  threeScene.camera.updateProjectionMatrix();
}
