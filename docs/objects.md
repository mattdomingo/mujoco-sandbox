# Object Integration

How tracked physical objects from `.capture` files are parsed, visualized in Three.js, and represented as physics bodies in MuJoCo.

---

## What this is

Apple Vision Pro can track physical objects using its WorldAnchor / object-scanning system. When the Holos app records a session involving a scanned object, the capture directory includes `tracking/object_pose.csv` — the object's world-space pose at ~30 fps, sampled on the same `t_mono` clock as the hand and device pose streams.

The current implementation targets the **Nakamichi 610 speaker** specifically. The photogrammetry scan (`nakamichi_610.usdz`) is bundled as a static asset and loaded as the visual mesh whenever any capture contains object pose data.

---

## Capture file format

`tracking/object_pose.csv` — present when an object was tracked during recording:

```
t_mono, t_wall, anchorID, x, y, z, qx, qy, qz, qw
```

| Column | Type | Notes |
|---|---|---|
| `t_mono` | float (s) | Monotonic system clock — same epoch as hand/device streams |
| `t_wall` | float (s) | Wall-clock timestamp — not used |
| `anchorID` | UUID string | WorldAnchor identifier — one per tracked object |
| `x, y, z` | float (m) | Object centroid position in AVP world space (Y-up) |
| `qx, qy, qz, qw` | float | Orientation quaternion in xyzw order |

**Sampling rate:** ~30 fps (roughly one row per hand-pose frame, sometimes slightly sparser). The reference capture has 729 data rows for a ~24-second session.

**Multiple objects:** The format supports multiple tracked objects in the same file — each with its own `anchorID`. The current parser merges all rows by timestamp regardless of anchor, meaning if two objects are tracked simultaneously the poses will be averaged rather than separated. This is a known gap (see below).

**Coordinate system:** AVP Y-up world space, consistent with `device_pose.csv` and `hand_pose_world.csv`. No conversion is needed before passing to Three.js. MuJoCo is Z-up, but the object body only needs to match visual positions (Y-up AVP coordinates), so no coordinate transform is applied — the same raw values go to both Three.js and MuJoCo mocap slots.

---

## Pipeline

```
tracking/object_pose.csv
        │
        ▼
parseObjectPoseCsv()                              (parser.ts)
  Returns ObjectPose[] sorted by t_mono.

interpolateObjectPoses(poses, timestamps)
  Binary-search lerp onto hand-pose frame timestamps.
  Returns (ObjectPose | undefined)[] — undefined before the
  first tracked sample or if the file was absent.
        │
        ▼
CaptureFrame.objectPose?: ObjectPose              (types.ts)
  Attached to every frame. Optional — absent for captures
  without tracking/object_pose.csv.
        │
        ├──────────────────────────────────────────────────────┐
        ▼                                                      ▼
applyFrame() in loader.ts                    updateScannedObject() in scene.ts

Writes pose to nakamichi_cabinet mocap slot:    Sets group.position + group.quaternion
  mocap_pos[mid*3 + {0,1,2}] = op.{x,y,z}       from objectPose.{x,y,z,qx,qy,qz,qw}
  mocap_quat[mid*4 + {0,1,2,3}] = [qw,qx,qy,qz] (no-op if USDZ not yet loaded)
  (xyzw → wxyz reorder for MuJoCo)

Guarded by: if (frame.objectPose) and
  if (mocapIndex.get("nakamichi_cabinet") !== undefined)
```

---

## MuJoCo physics body

`nakamichi_cabinet` is injected into `holos_humanoid.xml` at load time in `loadMuJoCo()`, via string replacement before `MjModel.loadFromXML()`:

```xml
<body name="nakamichi_cabinet" mocap="true" pos="0 0 10">
  <geom name="nakamichi_geom" type="box" size="0.15 0.09 0.10"
        contype="1" conaffinity="1" rgba="0.4 0.4 0.4 0"/>
</body>
```

Key decisions:

| Decision | Reason |
|---|---|
| `mocap="true"` | Body is kinematically driven from object_pose.csv, same pattern as hand joints. MuJoCo never applies forces to it. |
| `type="box"` with approximate dimensions (30×18×20 cm) | Box geoms are always valid in MuJoCo; mesh geoms from OBJ require correct VFS placement and valid topology. The box is sufficient for contact detection. |
| Default `pos="0 0 10"` (10m above scene) | The body must start somewhere that doesn't generate floor contacts before the first `objectPose` write. The reference capture position `(0.71, 0.715, -0.43)` in AVP Y-up becomes `z = -0.43` in MuJoCo Z-up, which is below the floor plane. Using `pos="0 0 10"` avoids this. |
| `rgba` alpha=0 | The geom is invisible — the USDZ mesh provides the visual. Keeping it in `group="0"` (default) means it participates in contacts. |
| `contype=1 conaffinity=1` | Allows hand geoms to contact the object. Matching values on both sides means contacts will be generated. |

The hull OBJ (`nakamichi_610_hull.obj`) is fetched in parallel with the XML and written to the WASM VFS, but it is **not used for the geom** in the current implementation — the box geom was chosen for reliability. The OBJ could be used as a mesh geom in a future iteration if more accurate contact geometry is needed.

`nakamichiBodyId` and `nakamichiGeomId` are indexed on `MuJoCoInstance` after model load. The body is also registered in `mocapIndex` under `"nakamichi_cabinet"` so `applyFrame` can look it up by name.

---

## Three.js visual

`loadScannedObject(threeScene, url)` — called once at init if the capture contains any `objectPose` frames:

```ts
const loader = new USDLoader();
const group = await loader.loadAsync(url);
threeScene.scene.add(group);
threeScene.scannedObject = group;
```

- The load is fire-and-forget (`.catch()` only logs a warning)
- `threeScene.scannedObject` starts `null`; it's set when the USDZ finishes loading
- `updateScannedObject()` is a no-op if `scannedObject` is still null — frames that arrive before the USDZ loads silently skip the visual update

`updateScannedObject(threeScene, objectPose)` — called every frame in `onFrame` when `frame.objectPose` is present:

```ts
group.position.set(objectPose.x, objectPose.y, objectPose.z);
group.quaternion.set(objectPose.qx, objectPose.qy, objectPose.qz, objectPose.qw);
```

THREE.Quaternion constructor is `(x, y, z, w)` — this matches the `ObjectPose` field order directly.

---

## Universality audit

This implementation is universal in the following respects:

| Scenario | Behavior |
|---|---|
| Capture without `object_pose.csv` | `objectPose` is `undefined` on all frames. `loadScannedObject` is never called. `applyFrame` skips the object write. No USDZ loaded, no extra body used. |
| Capture with `object_pose.csv` | Parser interpolates poses onto frame timestamps. Visual and physics both update every frame. |
| `object_pose.csv` present but empty or malformed | `parseObjectPoseCsv` returns `[]`; `interpolateObjectPoses` returns all `undefined`. Effectively same as absent. |
| USDZ load fails (network, format error) | `loadScannedObject` `.catch()` logs a warning. `scannedObject` stays `null`. Physics body still moves correctly; only the visual is absent. |
| Hull OBJ fetch fails | Warning logged; box geom is injected regardless (hull OBJ is not used for the box geom). No degradation in contact behavior. |
| Object tracked at first frame | `interpolateObjectPoses` binary-search clamps to `poses[0]` for any frame before the first sample — safe. |
| Object tracking ends before capture ends | Clamps to last known pose for trailing frames. |

---

## Known gaps

### 1. Nakamichi-specific USDZ hardcoded

`loadScannedObject` is called with `/models/nakamichi_610.usdz` unconditionally whenever `object_pose.csv` is present, regardless of which object was actually tracked. The `anchorID` field in the CSV (a WorldAnchor UUID) is parsed but ignored.

**Impact:** A capture tracking a different object will still display the Nakamichi speaker model. A future implementation should map `anchorID` → asset URL, either via a manifest bundled with the capture or via a server-side lookup.

### 2. Multi-object captures not supported

The parser merges all rows from `object_pose.csv` regardless of `anchorID`. If a capture tracks two objects simultaneously, their poses are mixed into a single `objectPose` per frame. The second object has no visual or physics representation at all.

**Impact:** No known captures currently have multiple tracked objects. When this becomes relevant, the parser needs to group rows by `anchorID` and produce an `objectPoses: Map<string, ObjectPose>` per frame.

### 3. Coordinate system mismatch not transformed

Object poses from AVP use Y-up world coordinates. MuJoCo uses Z-up. The hand and head tracking data go through the same pipeline without a transform, so the MuJoCo scene effectively operates in a Y-up coordinate system for all mocap-driven bodies. This is intentional and consistent — but it means the MuJoCo floor plane (at z=0 in Z-up) does not correspond to the floor in the AVP world. Contact between the object and the floor will not behave physically.

For the hand-pressure use case (contacts between hands and the object) this is not a problem, because hand and object poses are both in the same AVP Y-up space. The inconsistency would only matter if we wanted the object to rest on the floor in MuJoCo, which is not a current requirement.

### 4. No contact readout for object-hand contacts

`readContactPressure` and `readInterHandPressure` exist for ball-hand and hand-hand contacts. There is no equivalent `readNakamichiPressure()` function. The `nakamichiGeomId` field on `MuJoCoInstance` is indexed for this purpose but nothing reads it yet.

**What's needed:** A `readNakamichiPressure(instance): ContactForceResult` function following the same pattern as `readContactPressure`, filtering for contacts where `geom1 === nakamichiGeomId || geom2 === nakamichiGeomId` AND the other geom is in `rightHandGeomIds ∪ leftHandGeomIds`. A `PressureDisplay` instance in `CaptureViewer` would surface this as a HUD.

### 5. Box geom approximation

The MuJoCo collision geom is a box `(0.30 × 0.18 × 0.20 m)` centered at the object origin. The actual Nakamichi 610 geometry is more complex — the USDZ scan exists but its mesh is not used for collision. Contact forces will be plausible but not accurate for non-center hits (e.g. a finger touching the edge of the speaker).

**What's needed:** Extract the convex hull from the USDZ scan (trimesh or Blender), export as a valid triangulated OBJ, and switch the geom from `type="box"` to `type="mesh"` with `mesh="nakamichi_hull"`. The VFS write for the hull OBJ is already in place in `loadMuJoCo()`.
