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
  bones:  THREE.Mesh[];
}

export interface ThreeScene {
  renderer: THREE.WebGLRenderer;
  scene:    THREE.Scene;
  camera:   THREE.PerspectiveCamera;
  rightHand: HandScene;
  leftHand:  HandScene;
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
  // Horizontal floor grid at Y=0.5 (just below where hands typically sit).
  // AVP hand data spans roughly X: -1.3→1.1, Z: 0→1.0.
  // GridHelper(size, divisions, centerColor, gridColor)
  const grid = new THREE.GridHelper(6, 24, 0x334155, 0x1e293b);
  grid.position.set(0, 0.5, 0.5);  // center on the activity zone
  scene.add(grid);

  // Vertical back-wall grid for depth reference
  const backGrid = new THREE.GridHelper(6, 24, 0x334155, 0x1e293b);
  backGrid.rotation.x = Math.PI / 2;
  backGrid.position.set(0, 1.0, -0.5);
  scene.add(backGrid);

  // Axis helper at the activity center — small, just for orientation
  const axes = new THREE.AxesHelper(0.15);
  axes.position.set(0, 0.5, 0.5);
  scene.add(axes);
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

  // Camera starts at a fixed wide-angle position that keeps the full
  // activity zone (X: -1.3→1.1, Y: 0.5→1.6, Z: 0→1.0) in frame.
  // aimCameraAtCapture() refines this once frame data is available.
  const camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 100);
  camera.position.set(0.1, 1.8, 3.2);
  camera.lookAt(0.1, 1.0, 0.5);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight(0xffffff, 1.2);
  directional.position.set(2, 4, 3);
  scene.add(directional);

  makeGrid(scene);

  const rightHand = makeHandScene(scene, 0xe69966); // orange
  const leftHand  = makeHandScene(scene, 0x6699e6); // blue

  const dispose = () => {
    renderer.dispose();
    scene.clear();
  };

  return { renderer, scene, camera, rightHand, leftHand, dispose };
}

// ---------------------------------------------------------------------------
// Camera framing — called once with all frames to compute a stable wide view
// that keeps the entire capture in frame at all times.
// ---------------------------------------------------------------------------
export function aimCameraAtCapture(
  threeScene: ThreeScene,
  frames: CaptureFrame[]
) {
  const { camera } = threeScene;
  if (frames.length === 0) return;

  // Sample wrist positions across all frames to find the bounding box
  let minX =  Infinity, maxX = -Infinity;
  let minY =  Infinity, maxY = -Infinity;
  let minZ =  Infinity, maxZ = -Infinity;

  const step = Math.max(1, Math.floor(frames.length / 500)); // sample up to 500 frames
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

  if (!isFinite(minX)) return; // no valid data

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  // Span across all axes — use the largest to ensure nothing is clipped
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  const maxSpan = Math.max(spanX, spanY, spanZ, 0.5);

  // Pull camera back far enough to fit the full span with padding,
  // and position it slightly above and behind the center
  const dist = maxSpan * 1.6;
  camera.position.set(cx, cy + maxSpan * 0.3, cz + dist);
  camera.lookAt(cx, cy, cz);
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

// ---------------------------------------------------------------------------
// Sync hand meshes from a parsed CaptureFrame
// ---------------------------------------------------------------------------
function syncHandFromFrame(
  handScene: HandScene,
  frame: CaptureFrame,
  chirality: "left" | "right"
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
// Sync hand meshes from MuJoCo mocap state (used during playback)
// ---------------------------------------------------------------------------
function syncHandFromMujoco(
  handScene: HandScene,
  instance: MuJoCoInstance,
  mocapOffset: number
) {
  const { data } = instance;
  for (let i = 0; i < 26; i++) {
    const mid = mocapOffset + i;
    handScene.joints[i].position.set(
      data.mocap_pos.get(mid * 3 + 0),
      data.mocap_pos.get(mid * 3 + 1),
      data.mocap_pos.get(mid * 3 + 2)
    );
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
  syncHandFromMujoco(rightHand, instance, mocapIndex.get("r_thumbKnuckle") ?? 0);
  syncHandFromMujoco(leftHand,  instance, mocapIndex.get("l_thumbKnuckle") ?? 26);
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Camera follow — call each frame when devicePose is available.
// Places the camera slightly behind and above the head, looking in the
// direction the head was facing. This gives a natural "over-the-shoulder"
// perspective matching what the user saw during the capture.
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
  // AVP quaternion is xyzw; Three.js Quaternion is also xyzw
  _headQuat.set(dp.qx, dp.qy, dp.qz, dp.qw).normalize();

  // Head's local forward is -Z; rotate it to world space
  _forward.set(0, 0, -1).applyQuaternion(_headQuat);

  // Camera sits 0.15m behind and 0.05m above the head
  camera.position.copy(_headPos)
    .addScaledVector(_forward, -0.15)
    .y += 0.05;

  // Look 0.8m ahead of the head
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
