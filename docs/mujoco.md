# Why MuJoCo

## What MuJoCo is

MuJoCo is a physics engine — it simulates how physical objects move, collide, and exert forces on each other. It runs in the browser via WebAssembly (the `mujoco-js` npm package).

## Why we use it for replay

Apple Vision Pro already solved the hard problem — it tracked the hands and gave us world-space joint positions and rotations directly. We don't need MuJoCo to figure out where the hands are.

We use MuJoCo because the company needs a physics layer in place. Replay is just the first use case. Future work will layer on:
- Detecting when hands touch virtual objects
- Computing contact forces (how hard did they grip?)
- Simulating object reactions to hand movement

Without MuJoCo in the pipeline now, adding those things later would require a significant rewrite.

## How we use it: mocap bodies

MuJoCo has a feature called **mocap bodies** — objects in a simulation that you can teleport to any position and rotation each frame, bypassing the normal physics solver. They're designed for exactly this: driving simulated objects from real motion capture data.

Our hand model (`public/models/holos_hands.xml`) defines 52 mocap bodies — one per joint, per hand. Each frame:

1. We write the 26 joint positions and rotations (from the CSV) into MuJoCo's mocap slots
2. We call `mj_forward()` — MuJoCo runs its physics pipeline
3. Three.js reads the resolved body positions back out and renders them

In pure replay mode, step 2 is mostly a passthrough — the mocap positions go in and come back unchanged. But once virtual objects are added to the scene, `mj_forward()` is what handles the interaction between the hands and those objects.

## The hand model

`public/models/holos_hands.xml` mirrors Apple's HandAnchor skeleton exactly:

- **52 bodies total** — 26 per hand, prefixed `r_` (right) and `l_` (left)
- **No joints between bodies** — each is positioned independently from the CSV
- **Sphere geoms** — small spheres on each joint, used for contact detection and as a placeholder for future mesh geometry
- **contype/conaffinity = 1** — bodies can collide with objects that share these flags

Right hand bodies are colored orange `(0.9, 0.6, 0.4)`, left hand blue `(0.4, 0.6, 0.9)` for visual distinction.

## Key MuJoCo concepts used here

| Concept | What it means |
|---|---|
| `mocap="true"` | Body is driven externally each frame, not by the physics solver |
| `data.mocap_pos` | Flat array of body positions — `[x, y, z]` per mocap body |
| `data.mocap_quat` | Flat array of body rotations — `[w, x, y, z]` per mocap body (note: wxyz order, not xyzw like Apple's data) |
| `mj_forward()` | Runs the physics pipeline for one timestep — resolves contacts, updates body transforms |
| `data.xpos` / `data.xquat` | Where bodies ended up after `mj_forward()` — what Three.js reads |

## Quaternion order difference

Apple Vision Pro outputs quaternions as `(x, y, z, w)`.
MuJoCo expects `(w, x, y, z)`.

This is handled in `applyFrame()` in `loader.ts` — the reordering happens there before writing into `data.mocap_quat`.

---

## What MuJoCo can and cannot do

### What it can do

| Capability | How it's used here |
|---|---|
| **Physics simulation** — rigid body dynamics, gravity, collision response | `mj_forward()` called every frame to resolve contacts |
| **Mocap bodies** — kinematically driven bodies that bypass the solver | All 52 hand joints driven from AVP CSV data |
| **Contact detection** — detects when geoms intersect | Ball ↔ hand and hand ↔ hand contacts |
| **Contact forces** — computes constraint forces at contact points | Pressure readout (Newtons) displayed in the HUD |
| **Body Jacobians** — `mj_jac()` maps joint velocities ↔ end-effector velocities | Not used here, but available as a building block |
| **Forward kinematics** — given joint angles, compute world positions of all bodies | Used implicitly: writing `qpos` hinge values and calling `mj_forward()` places humanoid limbs correctly |

### What it cannot do

**MuJoCo has no built-in inverse kinematics solver.** This is a deliberate design decision, stated explicitly in the [official docs](https://mujoco.readthedocs.io/en/stable/programming/simulation.html):

> *"The opposite mapping [from Cartesian positions back to joint angles] is called inverse kinematics but it is not uniquely defined and is not implemented in MuJoCo."*

IK is "not uniquely defined" because for a given hand position there are infinitely many shoulder/elbow combinations that reach it — MuJoCo won't guess which one you want.

What MuJoCo *does* provide (`mj_jac`, `mj_jacBody`) are the **Jacobian matrices** that form the mathematical foundation of iterative IK algorithms like damped least squares. But implementing that loop — and the matrix pseudo-inverse it requires — is left entirely to the user. The JS/WASM build used here doesn't include a matrix library, making iterative IK impractical.

The Python bindings include a nonlinear least-squares solver that *can* be used for IK, but this is Python-only and not available in the browser WASM package.

### Why we use analytical IK instead

For this use case — **motion capture replay with known wrist targets and fixed segment lengths** — analytical IK is the correct approach:

- **Closed-form**: one pass per frame, no iteration
- **Exact**: produces the precise answer given the geometry, no convergence tolerance
- **Elbow hint**: the AVP provides a real measured point near the elbow (`forearmArm`, joint 25), which pins down the otherwise-ambiguous elbow direction
- **No external dependencies**: pure TypeScript math, runs in the browser without a matrix library

The analytical solver lives in `src/lib/mujoco/ik.ts`. It uses the law of cosines to find the elbow bend angle, the AVP elbow hint to place the elbow in space, and swing-twist decomposition to extract the two shoulder hinge angles. See `docs/humanoid_model.md` for a full derivation.
