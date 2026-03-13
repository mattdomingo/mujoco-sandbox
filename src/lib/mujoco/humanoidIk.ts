/**
 * Background IK computation for the humanoid model.
 *
 * Processes capture frames in 50-frame batches via setTimeout so the main
 * thread stays responsive. Hand spheres render immediately while IK solves
 * in the background.
 */

import type { CaptureFrame, HumanoidFrame } from "@/lib/pkg/types";
import { HAND_JOINT_NAMES } from "@/lib/pkg/types";
import { solveArmIK, R_SHOULDER_LOCAL, L_SHOULDER_LOCAL } from "./ik";

const BATCH_SIZE = 50;

// forearmWrist is at index 24 in HAND_JOINT_NAMES
const WRIST_IDX = HAND_JOINT_NAMES.indexOf("forearmWrist");

/**
 * Start background IK computation. Returns a cancel function.
 *
 * @param frames         parsed capture frames
 * @param onProgress     called after each batch with (solved, total)
 * @param onComplete     called once with the full HumanoidFrame array
 */
export function computeHumanoidIKBackground(
  frames: CaptureFrame[],
  onProgress: (solved: number, total: number) => void,
  onComplete: (humanoidFrames: HumanoidFrame[]) => void
): () => void {
  let cancelled = false;
  let solved = 0;
  const results: HumanoidFrame[] = [];
  const total = frames.length;

  function processBatch() {
    const end = Math.min(solved + BATCH_SIZE, total);

    for (let i = solved; i < end; i++) {
      const frame = frames[i];
      const dp = frame.devicePose;

      // Torso: device pose is at eye level; humanoid torso center is ~0.25m below
      const torsoPos: [number, number, number] = dp
        ? [dp.x, dp.y - 0.25, dp.z]
        : [0, 1.0, 0];

      // Convert device pose quat xyzw → wxyz for MuJoCo
      const torsoQuat: [number, number, number, number] = dp
        ? [dp.qw, dp.qx, dp.qy, dp.qz]
        : [1, 0, 0, 0];

      const rWrist = frame.rightHand?.[WRIST_IDX];
      const lWrist = frame.leftHand?.[WRIST_IDX];

      const rTarget: [number, number, number] = rWrist
        ? [rWrist.px, rWrist.py, rWrist.pz]
        : [torsoPos[0] + 0.4, torsoPos[1] - 0.2, torsoPos[2]];

      const lTarget: [number, number, number] = lWrist
        ? [lWrist.px, lWrist.py, lWrist.pz]
        : [torsoPos[0] - 0.4, torsoPos[1] - 0.2, torsoPos[2]];

      const rIK = solveArmIK(torsoPos, torsoQuat, R_SHOULDER_LOCAL, rTarget, "right");
      const lIK = solveArmIK(torsoPos, torsoQuat, L_SHOULDER_LOCAL, lTarget, "left");

      results.push({
        frameIndex: frame.index,
        torsoPos,
        torsoQuat,
        arms: {
          rShoulder1: rIK.shoulder1,
          rShoulder2: rIK.shoulder2,
          rElbow: rIK.elbow,
          rReachable: rIK.reachable,
          lShoulder1: lIK.shoulder1,
          lShoulder2: lIK.shoulder2,
          lElbow: lIK.elbow,
          lReachable: lIK.reachable,
        },
      });
    }

    solved = end;
    onProgress(solved, total);

    if (!cancelled && solved < total) {
      setTimeout(processBatch, 0);
    } else if (!cancelled) {
      onComplete(results);
    }
  }

  setTimeout(processBatch, 0);
  return () => { cancelled = true; };
}
