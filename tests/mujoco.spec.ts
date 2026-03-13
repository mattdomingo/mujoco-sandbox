/**
 * MuJoCo integration tests — run against the live dev server.
 *
 * These tests prove that the WASM physics pipeline is actually working, not
 * just that the JS wrapper loaded. Each test navigates to /test-mujoco, waits
 * for MuJoCo to reach "ready", then calls into the exposed window.__mujocoTest
 * API to inspect raw WASM state.
 *
 * What we verify:
 *  1. Model loads with the expected number of bodies and mocap bodies
 *  2. Body index contains expected joint names for both hands
 *  3. Mocap index maps every known joint name to a valid slot
 *  4. Writing to mocap_pos is reflected back when read (round-trip)
 *  5. mj_forward() propagates mocap_pos into xpos (physics output ≈ input)
 *  6. mocap_pos and xpos diverge only after we deliberately write different values
 *  7. mj_forward() doesn't corrupt adjacent mocap slots
 *  8. Ball and hand geoms are indexed for contact queries
 *  9. Ball contact pressure stays zero when hands are far away
 * 10. Ball contact pressure becomes non-zero on overlap
 * 11. Inter-hand contact pressure stays zero when hands are far apart
 * 12. Inter-hand contact pressure becomes non-zero on overlap
 */

import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helper: navigate and wait for MuJoCo to be ready (up to 45s for WASM boot)
// ---------------------------------------------------------------------------
async function waitForMuJoCo(page: Page) {
  await page.goto("/test-mujoco");
  await page.waitForFunction(
    () => document.querySelector("[data-testid='status']")?.textContent === "ready",
    { timeout: 45_000 }
  );
}

// ---------------------------------------------------------------------------
// Test 1 — Model integrity
// ---------------------------------------------------------------------------
test("model loads with correct body and mocap counts", async ({ page }) => {
  await waitForMuJoCo(page);

  const { nbody, nmocap, mocapKeys, bodyKeys } = await page.evaluate(() => {
    const t = window.__mujocoTest!;
    return {
      nbody:     t.instance.model.nbody,
      nmocap:    t.instance.model.nmocap,
      mocapKeys: t.instance.mocapIndex.size,
      bodyKeys:  t.instance.bodyIndex.size,
    };
  });

  // holos_humanoid.xml = humanoid (16 bodies) + 52 hand mocap bodies + pressure_ball + world
  // Total nbody = 1 (world) + 16 (humanoid) + 52 (hands) + 1 (ball) = 70
  expect(nbody,     "nbody should be 70 (world + 16 humanoid + 52 hand joints + pressure_ball)").toBe(70);
  expect(nmocap,    "nmocap should be 52").toBe(52);
  expect(mocapKeys, "mocapIndex should have 52 entries").toBe(52);
  expect(bodyKeys,  "bodyIndex should have at least 69 named bodies").toBeGreaterThanOrEqual(69);
});

// ---------------------------------------------------------------------------
// Test 2 — Index completeness: every joint in both hands must be indexed
// ---------------------------------------------------------------------------
test("mocap and body index contain all 26 joints for both hands", async ({ page }) => {
  await waitForMuJoCo(page);

  const { missingMocap, missingBody } = await page.evaluate(() => {
    const { instance, HAND_JOINT_NAMES } = window.__mujocoTest!;
    const prefixes = ["r_", "l_"];
    const missingMocap: string[] = [];
    const missingBody: string[] = [];
    for (const prefix of prefixes) {
      for (const joint of HAND_JOINT_NAMES) {
        const name = prefix + joint;
        if (!instance.mocapIndex.has(name)) missingMocap.push(name);
        if (!instance.bodyIndex.has(name))  missingBody.push(name);
      }
    }
    return { missingMocap, missingBody };
  });

  expect(missingMocap, `mocapIndex missing: ${missingMocap.join(", ")}`).toHaveLength(0);
  expect(missingBody,  `bodyIndex missing: ${missingBody.join(", ")}`).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 3 — mocap_pos round-trip: write a position, read it back
// ---------------------------------------------------------------------------
test("writing mocap_pos is immediately readable without calling mj_forward", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { instance, HAND_JOINT_NAMES } = window.__mujocoTest!;
    const { data, mocapIndex } = instance;

    // Use the first right-hand joint (thumbTip or similar)
    const bodyName = "r_" + HAND_JOINT_NAMES[0];
    const mid = mocapIndex.get(bodyName);
    if (mid === undefined) return { ok: false, error: `no mocap id for ${bodyName}` };

    const testX = 0.1234, testY = 0.5678, testZ = 0.9012;
    data.mocap_pos[mid * 3 + 0] = testX;
    data.mocap_pos[mid * 3 + 1] = testY;
    data.mocap_pos[mid * 3 + 2] = testZ;

    const readX = data.mocap_pos[mid * 3 + 0];
    const readY = data.mocap_pos[mid * 3 + 1];
    const readZ = data.mocap_pos[mid * 3 + 2];

    return {
      ok: readX === testX && readY === testY && readZ === testZ,
      wrote: [testX, testY, testZ],
      read:  [readX, readY, readZ],
    };
  });

  expect(result.ok, `mocap_pos round-trip failed: wrote ${JSON.stringify(result.wrote)}, read ${JSON.stringify(result.read)}`).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 4 — mj_forward propagates mocap_pos into xpos
// ---------------------------------------------------------------------------
test("mj_forward propagates mocap_pos into xpos (physics output matches input)", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { instance, HAND_JOINT_NAMES } = window.__mujocoTest!;
    const { mujoco, model, data, mocapIndex, bodyIndex } = instance;

    const jointName = HAND_JOINT_NAMES[0];
    const bodyName  = "r_" + jointName;
    const mid = mocapIndex.get(bodyName);
    const bid = bodyIndex.get(bodyName);
    if (mid === undefined || bid === undefined) {
      return { ok: false, error: `missing index for ${bodyName}` };
    }

    // Write a distinctive position
    const wx = 0.333, wy = 0.444, wz = 0.555;
    data.mocap_pos[mid * 3 + 0] = wx;
    data.mocap_pos[mid * 3 + 1] = wy;
    data.mocap_pos[mid * 3 + 2] = wz;

    // Run the physics pipeline
    mujoco.mj_forward(model, data);

    const xpos_x = data.xpos[bid * 3 + 0];
    const xpos_y = data.xpos[bid * 3 + 1];
    const xpos_z = data.xpos[bid * 3 + 2];

    const tol = 1e-4;
    const ok =
      Math.abs(xpos_x - wx) < tol &&
      Math.abs(xpos_y - wy) < tol &&
      Math.abs(xpos_z - wz) < tol;

    return {
      ok,
      wrote:  [wx, wy, wz],
      xpos:   [xpos_x, xpos_y, xpos_z],
      delta:  [xpos_x - wx, xpos_y - wy, xpos_z - wz],
    };
  });

  expect(result.ok,
    `xpos did not match mocap_pos after mj_forward.\n` +
    `  wrote: ${JSON.stringify(result.wrote)}\n` +
    `  xpos:  ${JSON.stringify(result.xpos)}\n` +
    `  delta: ${JSON.stringify(result.delta)}`
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 5 — applyFrame: full frame write + forward gives consistent xpos
// ---------------------------------------------------------------------------
test("applyFrame writes all 26 right-hand joints and mj_forward reflects them in xpos", async ({ page }) => {
  await waitForMuJoCo(page);

  const failures = await page.evaluate(() => {
    const { instance, HAND_JOINT_NAMES, applyFrame } = window.__mujocoTest!;
    const { data, mocapIndex, bodyIndex } = instance;

    // Build a synthetic right-hand frame: each joint at a unique, predictable position
    const hand = HAND_JOINT_NAMES.map((_, i) => ({
      px: i * 0.01,
      py: i * 0.02,
      pz: i * 0.03,
      qx: 0, qy: 0, qz: 0, qw: 1,
    }));

    const frame = {
      index: 0,
      timestamp: 0,
      rightHand: hand,
      leftHand: null,
      devicePose: null,
      rightArmInput: { wristTracked: true, elbowHintTracked: true },
      leftArmInput: { wristTracked: false, elbowHintTracked: false },
    };

    applyFrame(instance, frame);

    const tol = 1e-4;
    const failures: string[] = [];

    for (let i = 0; i < HAND_JOINT_NAMES.length; i++) {
      const bodyName = "r_" + HAND_JOINT_NAMES[i];
      const mid = mocapIndex.get(bodyName);
      const bid = bodyIndex.get(bodyName);
      if (mid === undefined || bid === undefined) {
        failures.push(`${bodyName}: missing index`);
        continue;
      }

      const expectedX = i * 0.01;
      const expectedY = i * 0.02;
      const expectedZ = i * 0.03;

      // Check mocap_pos was written correctly
      const mx = data.mocap_pos[mid * 3 + 0];
      const my = data.mocap_pos[mid * 3 + 1];
      const mz = data.mocap_pos[mid * 3 + 2];
      if (Math.abs(mx - expectedX) > tol || Math.abs(my - expectedY) > tol || Math.abs(mz - expectedZ) > tol) {
        failures.push(`${bodyName}: mocap_pos [${mx.toFixed(4)}, ${my.toFixed(4)}, ${mz.toFixed(4)}] ≠ expected [${expectedX}, ${expectedY}, ${expectedZ}]`);
        continue;
      }

      // Check xpos matches (mj_forward was called inside applyFrame)
      const xx = data.xpos[bid * 3 + 0];
      const xy = data.xpos[bid * 3 + 1];
      const xz = data.xpos[bid * 3 + 2];
      if (Math.abs(xx - expectedX) > tol || Math.abs(xy - expectedY) > tol || Math.abs(xz - expectedZ) > tol) {
        failures.push(`${bodyName}: xpos [${xx.toFixed(4)}, ${xy.toFixed(4)}, ${xz.toFixed(4)}] ≠ mocap_pos [${expectedX}, ${expectedY}, ${expectedZ}]`);
      }
    }

    return failures;
  });

  expect(failures, `applyFrame / xpos mismatches:\n${failures.join("\n")}`).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 6 — mocap_pos and xpos diverge when we deliberately write different values
// (Sanity check: proves we're reading two genuinely separate arrays)
// ---------------------------------------------------------------------------
test("mocap_pos and xpos are separate arrays that can hold different values before mj_forward", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { instance, HAND_JOINT_NAMES } = window.__mujocoTest!;
    const { mujoco, model, data, mocapIndex, bodyIndex } = instance;

    const bodyName = "l_" + HAND_JOINT_NAMES[0];
    const mid = mocapIndex.get(bodyName);
    const bid = bodyIndex.get(bodyName);
    if (mid === undefined || bid === undefined) return { ok: false, error: `missing index for ${bodyName}` };

    // Set mocap_pos to a known value and call mj_forward so xpos agrees
    data.mocap_pos[mid * 3 + 0] = 1.0;
    data.mocap_pos[mid * 3 + 1] = 1.0;
    data.mocap_pos[mid * 3 + 2] = 1.0;
    mujoco.mj_forward(model, data);

    const xposAfterFirst = data.xpos[bid * 3 + 0];

    // Now write a completely different value to mocap_pos WITHOUT calling mj_forward
    data.mocap_pos[mid * 3 + 0] = 99.0;

    const xposBeforeSecondForward = data.xpos[bid * 3 + 0];

    // xpos should still reflect the OLD value (1.0), not 99.0
    return {
      ok: xposBeforeSecondForward === xposAfterFirst && xposBeforeSecondForward !== 99.0,
      xposAfterFirst,
      xposBeforeSecondForward,
      mocapAfterWrite: data.mocap_pos[mid * 3 + 0],
    };
  });

  expect(result.ok,
    `Expected xpos to still hold old value before mj_forward.\n` +
    `  xpos after first forward: ${result.xposAfterFirst}\n` +
    `  xpos before second forward: ${result.xposBeforeSecondForward}\n` +
    `  mocap_pos after write: ${result.mocapAfterWrite}`
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 7 — Adjacent mocap slots are not corrupted by a single write
// ---------------------------------------------------------------------------
test("writing one joint does not corrupt adjacent mocap slots", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { instance, HAND_JOINT_NAMES } = window.__mujocoTest!;
    const { data, mocapIndex } = instance;

    // Zero out the first 3 right-hand joints
    for (let i = 0; i < 3; i++) {
      const mid = mocapIndex.get("r_" + HAND_JOINT_NAMES[i])!;
      data.mocap_pos[mid * 3 + 0] = 0;
      data.mocap_pos[mid * 3 + 1] = 0;
      data.mocap_pos[mid * 3 + 2] = 0;
    }

    // Write only to joint 1 (middle of the three)
    const mid1 = mocapIndex.get("r_" + HAND_JOINT_NAMES[1])!;
    data.mocap_pos[mid1 * 3 + 0] = 7.77;

    // Joints 0 and 2 should still be zero
    const mid0 = mocapIndex.get("r_" + HAND_JOINT_NAMES[0])!;
    const mid2 = mocapIndex.get("r_" + HAND_JOINT_NAMES[2])!;

    return {
      joint0x: data.mocap_pos[mid0 * 3 + 0],
      joint1x: data.mocap_pos[mid1 * 3 + 0],
      joint2x: data.mocap_pos[mid2 * 3 + 0],
    };
  });

  expect(result.joint0x, "joint 0 should be unaffected (0)").toBe(0);
  expect(result.joint1x, "joint 1 should hold the written value (7.77)").toBeCloseTo(7.77, 5);
  expect(result.joint2x, "joint 2 should be unaffected (0)").toBe(0);
});

// ---------------------------------------------------------------------------
// Test 8 — pressure_ball is indexed correctly
// ---------------------------------------------------------------------------
test("pressure_ball body and geom are found after model load", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { instance } = window.__mujocoTest!;
    return {
      ballBodyId: instance.ballBodyId,
      ballGeomId: instance.ballGeomId,
      ballInBodyIndex: instance.bodyIndex.has("pressure_ball"),
      rightHandGeomCount: instance.rightHandGeomIds.size,
      leftHandGeomCount: instance.leftHandGeomIds.size,
    };
  });

  expect(result.ballBodyId, "ballBodyId should be >= 0").toBeGreaterThanOrEqual(0);
  expect(result.ballGeomId, "ballGeomId should be >= 0").toBeGreaterThanOrEqual(0);
  expect(result.ballInBodyIndex, "pressure_ball should appear in bodyIndex").toBe(true);
  expect(result.rightHandGeomCount, "right hand should expose 26 geoms").toBe(26);
  expect(result.leftHandGeomCount, "left hand should expose 26 geoms").toBe(26);
});

// ---------------------------------------------------------------------------
// Test 9 — ball xpos is initialised near its XML pos (0, 0.9, 0.5)
// ---------------------------------------------------------------------------
test("pressure_ball starts near its XML position after mj_forward", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { instance } = window.__mujocoTest!;
    const { mujoco, model, data, ballBodyId } = instance;
    mujoco.mj_forward(model, data);
    return {
      x: data.xpos[ballBodyId * 3 + 0],
      y: data.xpos[ballBodyId * 3 + 1],
      z: data.xpos[ballBodyId * 3 + 2],
    };
  });

  const tol = 0.05; // 5cm tolerance — gravity hasn't moved it far in one step
  expect(Math.abs(result.x - 0.0), `ball x=${result.x} should be near 0`).toBeLessThan(tol);
  expect(Math.abs(result.y - 0.9), `ball y=${result.y} should be near 0.9`).toBeLessThan(tol);
  expect(Math.abs(result.z - 0.5), `ball z=${result.z} should be near 0.5`).toBeLessThan(tol);
});

// ---------------------------------------------------------------------------
// Test 10 — contact pressure is zero when no hand joints overlap the ball
// ---------------------------------------------------------------------------
test("readContactPressure returns zero when hands are far from the ball", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { instance, HAND_JOINT_NAMES, applyFrame, readContactPressure } = window.__mujocoTest!;

    // Place all hand joints 5m away from the ball (which sits near 0, 0.9, 0.5)
    const farHand = HAND_JOINT_NAMES.map(() => ({
      px: 5.0, py: 5.0, pz: 5.0,
      qx: 0, qy: 0, qz: 0, qw: 1,
    }));
    applyFrame(instance, {
      index: 0, timestamp: 0,
      rightHand: farHand, leftHand: farHand,
      devicePose: null,
      rightArmInput: { wristTracked: true, elbowHintTracked: true },
      leftArmInput: { wristTracked: true, elbowHintTracked: true },
    });

    const { pressure, contactCount } = readContactPressure(instance);
    return { pressure, contactCount };
  });

  expect(result.pressure,     "pressure should be 0 when hands are far away").toBe(0);
  expect(result.contactCount, "contactCount should be 0 when hands are far away").toBe(0);
});

// ---------------------------------------------------------------------------
// Test 11 — contact pressure is non-zero when a joint is placed inside the ball
// ---------------------------------------------------------------------------
test("readContactPressure returns non-zero pressure when a hand joint overlaps the ball", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { instance, HAND_JOINT_NAMES, applyFrame, readContactPressure } = window.__mujocoTest!;

    // Ball starts at (0, 0.9, 0.5). Place all right-hand joints exactly on top of it
    // so at least one geom sphere overlaps the ball geom.
    const onBallHand = HAND_JOINT_NAMES.map(() => ({
      px: 0.0, py: 0.9, pz: 0.5,
      qx: 0, qy: 0, qz: 0, qw: 1,
    }));
    // Left hand far away
    const farHand = HAND_JOINT_NAMES.map(() => ({
      px: 5.0, py: 5.0, pz: 5.0,
      qx: 0, qy: 0, qz: 0, qw: 1,
    }));
    applyFrame(instance, {
      index: 0, timestamp: 0,
      rightHand: onBallHand, leftHand: farHand,
      devicePose: null,
      rightArmInput: { wristTracked: true, elbowHintTracked: true },
      leftArmInput: { wristTracked: true, elbowHintTracked: true },
    });

    const { pressure, contactCount, ballPos } = readContactPressure(instance);
    return { pressure, contactCount, ballPos };
  });

  expect(result.contactCount, "at least one contact should be detected").toBeGreaterThan(0);
  expect(result.pressure,     "pressure should be > 0 when hand overlaps ball").toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test 12 — inter-hand pressure is zero when hands are far apart
// ---------------------------------------------------------------------------
test("readInterHandPressure returns zero when hands are far apart", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { instance, HAND_JOINT_NAMES, applyFrame, readInterHandPressure } = window.__mujocoTest!;

    const farLeftHand = HAND_JOINT_NAMES.map(() => ({
      px: -5.0, py: 5.0, pz: 5.0,
      qx: 0, qy: 0, qz: 0, qw: 1,
    }));
    const farRightHand = HAND_JOINT_NAMES.map(() => ({
      px: 5.0, py: 5.0, pz: 5.0,
      qx: 0, qy: 0, qz: 0, qw: 1,
    }));
    applyFrame(instance, {
      index: 0, timestamp: 0,
      rightHand: farRightHand, leftHand: farLeftHand,
      devicePose: null,
      rightArmInput: { wristTracked: true, elbowHintTracked: true },
      leftArmInput: { wristTracked: true, elbowHintTracked: true },
    });

    return readInterHandPressure(instance);
  });

  expect(result.pressure, "inter-hand pressure should be 0 when hands are far apart").toBe(0);
  expect(result.contactCount, "inter-hand contactCount should be 0 when hands are far apart").toBe(0);
});

// ---------------------------------------------------------------------------
// Test 13 — inter-hand pressure is non-zero when one left and one right joint overlap
// ---------------------------------------------------------------------------
test("readInterHandPressure returns non-zero pressure when left and right joints overlap", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { instance, HAND_JOINT_NAMES, applyFrame, readInterHandPressure } = window.__mujocoTest!;

    const overlapPoint = { px: 0.3, py: 1.2, pz: 0.8, qx: 0, qy: 0, qz: 0, qw: 1 };
    const farLeftHand = HAND_JOINT_NAMES.map(() => ({
      px: -5.0, py: 5.0, pz: 5.0,
      qx: 0, qy: 0, qz: 0, qw: 1,
    }));
    const farRightHand = HAND_JOINT_NAMES.map(() => ({
      px: 5.0, py: 5.0, pz: 5.0,
      qx: 0, qy: 0, qz: 0, qw: 1,
    }));

    farLeftHand[0] = overlapPoint;
    farRightHand[0] = overlapPoint;

    applyFrame(instance, {
      index: 0, timestamp: 0,
      rightHand: farRightHand, leftHand: farLeftHand,
      devicePose: null,
      rightArmInput: { wristTracked: true, elbowHintTracked: true },
      leftArmInput: { wristTracked: true, elbowHintTracked: true },
    });

    return readInterHandPressure(instance);
  });

  expect(result.contactCount, "at least one inter-hand contact should be detected").toBeGreaterThan(0);
  expect(result.pressure, "inter-hand pressure should be > 0 when left/right joints overlap").toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test 14 — arm resolve freezes to the last valid pose when tracking gaps occur
// ---------------------------------------------------------------------------
test("resolveTrackedArmSide freezes the last valid pose when wrist or elbow data is not tracked", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { resolveTrackedArmSide } = window.__mujocoTest!;
    const torsoPos: [number, number, number] = [0, 0, 0];
    const torsoQuat: [number, number, number, number] = [1, 0, 0, 0];
    const shoulderLocal: [number, number, number] = [0, -0.17, 0.06];
    const wrist = { px: 0.32, py: -0.24, pz: -0.06, qx: 0, qy: 0, qz: 0, qw: 1 };
    const elbow = { px: 0.16, py: -0.30, pz: -0.12, qx: 0, qy: 0, qz: 0, qw: 1 };

    const valid = resolveTrackedArmSide(
      torsoPos,
      torsoQuat,
      shoulderLocal,
      wrist,
      elbow,
      { wristTracked: true, elbowHintTracked: true },
      "right"
    );
    const frozen = resolveTrackedArmSide(
      torsoPos,
      torsoQuat,
      shoulderLocal,
      wrist,
      elbow,
      { wristTracked: false, elbowHintTracked: false },
      "right",
      valid
    );

    return {
      validTracked: valid.trackedDataValid,
      frozenTracked: frozen.trackedDataValid,
      sameShoulder1: frozen.shoulder1 === valid.shoulder1,
      sameShoulder2: frozen.shoulder2 === valid.shoulder2,
      sameElbow: frozen.elbow === valid.elbow,
      frozenReachable: frozen.reachable,
      clampFlags: [frozen.shoulder1Clamped, frozen.shoulder2Clamped, frozen.elbowClamped],
    };
  });

  expect(result.validTracked, "valid tracked data should produce a tracked solve").toBe(true);
  expect(result.frozenTracked, "gap frames should be marked invalid").toBe(false);
  expect(result.sameShoulder1, "gap frame should freeze shoulder1").toBe(true);
  expect(result.sameShoulder2, "gap frame should freeze shoulder2").toBe(true);
  expect(result.sameElbow, "gap frame should freeze elbow").toBe(true);
  expect(result.frozenReachable, "frozen gap frame should not report a fresh solve").toBe(false);
  expect(result.clampFlags, "frozen gap frame should clear clamp/debug flags").toEqual([false, false, false]);
});

// ---------------------------------------------------------------------------
// Test 15 — leading tracking gaps fall back to the neutral arm pose
// ---------------------------------------------------------------------------
test("resolveTrackedArmSide uses the neutral arm pose before any valid tracked sample exists", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { resolveTrackedArmSide } = window.__mujocoTest!;
    return resolveTrackedArmSide(
      [0, 0, 0],
      [1, 0, 0, 0],
      [0, 0.17, 0.06],
      null,
      null,
      { wristTracked: false, elbowHintTracked: false },
      "left"
    );
  });

  expect(result.trackedDataValid, "leading gap should be marked invalid").toBe(false);
  expect(result.shoulder1, "leading gap shoulder1 should stay at neutral").toBe(0);
  expect(result.shoulder2, "leading gap shoulder2 should stay at neutral").toBe(0);
  expect(result.elbow, "leading gap elbow should stay at neutral").toBe(0);
  expect(result.reachable, "leading gap should not report reachability").toBe(false);
});

// ---------------------------------------------------------------------------
// Test 16 — solving resumes when tracked arm data returns after a gap
// ---------------------------------------------------------------------------
test("resolveTrackedArmSide resumes solving when tracked wrist and elbow data return", async ({ page }) => {
  await waitForMuJoCo(page);

  const result = await page.evaluate(() => {
    const { resolveTrackedArmSide } = window.__mujocoTest!;
    const torsoPos: [number, number, number] = [0, 0, 0];
    const torsoQuat: [number, number, number, number] = [1, 0, 0, 0];
    const shoulderLocal: [number, number, number] = [0, -0.17, 0.06];
    const wristA = { px: 0.32, py: -0.24, pz: -0.06, qx: 0, qy: 0, qz: 0, qw: 1 };
    const elbowA = { px: 0.16, py: -0.30, pz: -0.12, qx: 0, qy: 0, qz: 0, qw: 1 };
    const wristB = { px: 0.08, py: -0.52, pz: 0.22, qx: 0, qy: 0, qz: 0, qw: 1 };
    const elbowB = { px: 0.02, py: -0.34, pz: 0.12, qx: 0, qy: 0, qz: 0, qw: 1 };

    const valid = resolveTrackedArmSide(
      torsoPos,
      torsoQuat,
      shoulderLocal,
      wristA,
      elbowA,
      { wristTracked: true, elbowHintTracked: true },
      "right"
    );
    const frozen = resolveTrackedArmSide(
      torsoPos,
      torsoQuat,
      shoulderLocal,
      wristA,
      elbowA,
      { wristTracked: false, elbowHintTracked: false },
      "right",
      valid
    );
    const resumed = resolveTrackedArmSide(
      torsoPos,
      torsoQuat,
      shoulderLocal,
      wristB,
      elbowB,
      { wristTracked: true, elbowHintTracked: true },
      "right",
      frozen
    );

    const changed =
      Math.abs(resumed.shoulder1 - frozen.shoulder1) > 1e-4 ||
      Math.abs(resumed.shoulder2 - frozen.shoulder2) > 1e-4 ||
      Math.abs(resumed.elbow - frozen.elbow) > 1e-4;

    return {
      resumedTracked: resumed.trackedDataValid,
      changed,
      resumedReachable: resumed.reachable,
    };
  });

  expect(result.resumedTracked, "tracked data returning should clear the gap flag").toBe(true);
  expect(result.changed, "a resumed solve should update at least one joint angle").toBe(true);
  expect(typeof result.resumedReachable, "resumed solve should report reachability").toBe("boolean");
});
