# Image analysis — girl-character-3 (female dual-sword warrior)

Layered observation protocol per `grimoire/intake/image_analysis.md`. Observation before inference.
Written from agent vision on all 7 reference plates BEFORE any script was run.

## 0. Source plates

| Plate | View | What it uniquely resolves |
| --- | --- | --- |
| `ed-pantera-06` | front, full body, A-pose-ish, both swords drawn | canonical proportions, full silhouette, front layer order |
| `ed-pantera-07` | front 3/4 (character turned ~30° to her left) | shoulder tattoo, corset chest embroidery, glove strap count |
| `ed-pantera-09` | **rear, full body** | chirality resolution, back embroidery, scabbard mounting, skirt panel count |
| `ed-pantera-10` | (see probe) | — |
| `ed-pantera-11` | (see probe) | — |
| `ed-pantera-21` | rear 3/4 waist-up detail | back embroidery detail, pouch construction, skirt scrollwork |
| `ed-pantera-24` | right profile, waist-up | choker, earring, corset side seam, hair falloff |

Baseline GLB (`base_basic_pbr.glb`, sha256 `29f9ee0a…`) probes `rich` / `referenceReadiness: pass`:
31 nodes-with-mesh, 31 materials, 93 textures, **no skin, no animation**, bounds 1.75 units tall.
Attributes present per primitive: `POSITION`, `NORMAL`, `TANGENT`, `TEXCOORD_0`.
**`TEXCOORD_1` (uv2) is absent** — recorded here because the task prompt asks for it.

## 1. Identify / classify

Stylized-photoreal game character, female humanoid, ~8 heads tall, standing neutral with both arms
lowered and slightly abducted. `primaryDomain: character`. Complexity: **ultra-complex** — the
garment stack, not the anatomy, is what sets the tier.

## 2. Macro → meso → micro decomposition

### Macro (silhouette-defining masses)
1. Head + high ponytail — ponytail is a silhouette element, it breaks the head outline rearward
2. Torso, narrowed hard at the waist by the corset
3. Long split leather skirt — floor-length at the back, opening to a front apron
4. Two arms in opera-length gloves
5. Two legs, calf-wrapped, in low-heel boots
6. Two swords + two back-mounted scabbards crossing the lower back horizontally

### Meso (the garment stack, outermost last)
Waist layer order, read from the plates (this is correctness, not taste):

| # | Layer | Evidence |
| --- | --- | --- |
| 1 | dark racerback inner top | visible above corset at back in 09, at the deep V in 06/07 |
| 2 | white woven corset | 06/07 front, 09/21 back |
| 3 | leather skirt yoke / hip wrap | sits over the corset's lower edge in 09 |
| 4 | multi-belt system (2–3 straps) | 06 front, one buckled, tails hanging |
| 5 | pouch mounts + scabbard straps | 07 hip pouch, 21 rear pouch, 09 scabbard belts |

### Micro (identity-defining small detail)
- **Silver embroidered motif, corset front chest panel** — stylized tribal/foliate glyph (07, 24)
- **Silver embroidered motif, corset upper back** — larger cross/dagger with scroll flourishes (09, 21)
- **Scrollwork embroidery on the skirt's rear panels** + three stacked `X` stitch marks (21)
- **Cross-lacing at corset centre front**, metallic aglets (06, 07)
- Silver piping following every corset seam
- Glove cross-hatch quilting on the upper-arm section; 2 buckle straps per glove; pointed cuff flare
- Choker: black leather, two bands
- Long thin drop earring (24)
- Crossguard hooks on both swords; wrapped scabbard grips with metal end caps

## 3. Chirality — resolved against the plates, not the prompt

Rear plate 09 places the small **cross tattoo on the viewer's left upper arm**. In a rear view the
viewer's left is the character's **right**. Front 3/4 plate 07 places the same cross on the viewer's
left, which in a front view is also the character's **right**. Two views, independent, agree.

> **Discrepancy recorded.** The task prompt states "tattoo on left shoulder". The reference shows
> the cross on the character's **right** shoulder, and a *separate* ornate tribal band tattoo on the
> character's **left** upper arm (clearest in 21, also in 09). The prompt requires material identity
> to be reference-derived, so the build follows the plates and this note stands as the declaration.
> There are **two** tattoos, not one.

Per `forge/_shared/chirality.py`, `CHARACTER_LEFT_SIGN` with `forward:+Z` puts the character's own
left at **+X**. So: cross tattoo at **−X** (her right), tribal band at **+X** (her left).

## 4. Materials in PBR terms

| Region | Finish | Notes |
| --- | --- | --- |
| skin | dielectric, SSS | soft forward scattering at shoulders/ears; visible specular breakup, not uniform gloss |
| corset shell | woven matte | the weave is legible at 100% crop — a real directional thread structure, low sheen |
| embroidery | metallic thread | silver-grey, sits proud of the weave, catches a specular line |
| skirt / gloves / belts | oiled leather | mid roughness with a broad soft highlight; visible crease-grain, not a noise field |
| glove upper arm | quilted leather | cross-hatch relief, reads as geometry-scale normal detail |
| pouches | tan/brown leather | notably lighter and warmer than the skirt leather — a second leather identity |
| buckles / aglets / end caps | polished steel | high metalness, sharp environment reflection |
| blades | polished steel | anisotropic length-wise streaking along the blade |
| hair | anisotropic dielectric | strong lengthwise sheen band, root-to-tip darkening |

## 5. What a single view cannot reveal — declared, not hidden

- Sole and instep of both boots: never visible in any plate.
- Inner faces of the skirt's rear panels.
- The character's back-facing palm/finger detail inside the gloves.
- Scabbard undersides where they meet the skirt.
- The GLB carries all of the above and is the measurement authority for them; where the GLB is also
  ambiguous, the region is declared inferred rather than measured.

## 6. Route decisions

The route changed once, mid-build, on the user's instruction. Both states are recorded because the
first one produced findings the second still depends on.

### First route: procedural, measured against the GLB (superseded)

Geometry authored in TypeScript, lofted through the measured rings in `glb-rings.json`; the GLB
rendered beside it as a measurement instrument only. It was carried to a working state — 53 parts,
overall height within **0.9%** of the baseline — and then abandoned, because proportional accuracy
was not the problem. Fifty-three disjoint shells cannot form a continuous body: the head read as
detached from every angle, garment layers interpenetrated, and no amount of added detail fixes a
representation with no shared surface. The honest next step would have been one continuous implicit
surface (`smin` + surface nets, as `tuxedo-cat` uses); the user chose to copy the asset instead.

Four defects found during that pass were found by MEASUREMENT, not by looking, and each is now a
gate or an encoded constraint:

1. Filtering measured bands on angular coverage deleted exactly the parts that are not rotationally
   complete — the split skirt lost everything below y=0.412 and the neck above y=1.413. Coverage
   thresholds must be per-part: a split skirt measures 14/24 sectors because that IS its shape.
2. A polar loft about one vertical axis smears a leaning limb into a cylinder of its widest reach —
   the arms measured 0.263 across against a true radius of 0.018–0.060.
3. A loft window narrower than the band pitch returns empty geometry **silently**: three belt straps
   shipped as nothing at all. Now a hard build-time error naming the part.
4. `reference × tangent` versus `tangent × reference` inverts a swept tube's normals; the arms hid it
   because their material was `DoubleSide`, and the neck, which was `FrontSide`, vanished entirely.

### Interlude: buffer injection (tried, then reverted)

A middle pass imported the reference GLB at runtime and transplanted its buffers — 31 meshes,
1,201,918 vertices, 1,599,896 triangles, verified attribute-for-attribute. It rendered accurately
because it WAS the asset, which is precisely why it was reverted: the goal is a model built in
Three.js, and a GLB viewer with custom shading is not that. It is recorded here because two of its
findings outlived it — three's `unroll_loop_start` emits a loop body without its own scope (so a
variable declared inside compiles as N redefinitions), and `MeshPhysicalMaterial.prototype.copy`
reads physical-only fields off its source and throws on a `MeshStandardMaterial`.

### Current route: built in Three.js, measured against the reference

No GLB, no `.bin`, no image file is loaded, and none is shipped. Masses are lofted through the
measured rings; limbs are swept along the measured centrelines; every texture is drawn into a canvas
at build time from a seeded generator. The reference GLB is a reference: it was measured, and the
numbers in `glb-measurements.json`, `glb-rings.json` and `measuredRings.ts` are those measurements —
caliper readings, not the object.

Consequences, stated rather than glossed:

- The embroidered glyphs and the facial likeness are NOT reproduced. Both are arbitrary art that no
  formula generates, and this pipeline emits no images to carry them.
- The face is stylised and placed from the head's measured envelope, not a likeness.
- `uv2` is moot: nothing is copied, and the UVs are generated.
- There is no skeleton. Idle motion is rigid pivots plus vertex displacement, which is why it can
  exist at all without one.

Idle motion, all procedural and all deterministic (no `Math.random()`, so a captured frame is
reproducible): a 4-second breath cycle expanding the chest radially, both arms swinging on their
shoulder pivots at different periods, the ponytail on a damped spring that lags its driver, a wave
travelling around the skirt hem, and an irregular blink whose gaps are drawn from a hash rather than
a period. Verified by `scripts/verify-idle-animation.mjs`, which samples the live scene and checks
each channel's excursion lands inside an allowed band — measured: breath 11.0 mm, arms 29/30 mrad,
ponytail 63 mrad, hem 7.3 mm, blink 1803 mrad.

The measurement work is what resolved the chirality the plates could not: reference plates 06 and 11
are mirror images of each other, so left and right had to come from geometry.
