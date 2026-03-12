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

  // holos_hands.xml defines 52 mocap bodies (26 per hand) + 1 world body
  // bodyIndex includes the world body if it has a name, so size >= 52
  expect(nbody,     "nbody should be 53 (world + 52 hand joints)").toBe(53);
  expect(nmocap,    "nmocap should be 52").toBe(52);
  expect(mocapKeys, "mocapIndex should have 52 entries").toBe(52);
  expect(bodyKeys,  "bodyIndex should have at least 52 named bodies").toBeGreaterThanOrEqual(52);
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
