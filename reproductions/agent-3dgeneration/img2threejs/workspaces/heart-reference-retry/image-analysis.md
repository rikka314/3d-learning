# Heart Reference Retry — Image Analysis

## Source and suitability

- View ID: `reference`; 1122 × 1402 PNG; single anterior three-quarter view on a white background.
- Subject: stylized external anatomical heart teaching render, isolated and fully legible at macro scale.
- Suitability: conditional pass for a front-matched procedural reconstruction. The image supplies strong silhouette, palette, vessel-opening, and anterior surface-layout evidence. It does not reveal the rear surface, exact cross-sections, or true depth.
- Intended output: real-time procedural Three.js prop with semantic groups, clickable/explodable hierarchy, and a strict blockout-first review loop.

## Observation before inference

The visible object is an asymmetric organic ventricular body, broad near `y≈0.95`, tapering continuously to an apex near `x≈0.85, y≈-2.0`. Its image-right side is the dominant long ventricular mass; image-left is a broader wrap partly occluded by the right atrium and caval tube. Approximate visible bounds are `x=-1.2..1.46` in the supplied coordinate plan.

The red arterial aorta rises from `x≈-0.55, y≈0.9`, arches through `x≈-0.25, y≈1.85` toward `x≈0.3, y≈1.65`, and presents exactly three superior hollow branch mouths reaching `y≈2.0..2.4`. The blue pulmonary trunk starts near `x≈-0.1, y≈0.6`, rises anterior to the ascending aorta through `x≈0.25, y≈1.3`, then turns toward image right and ends in a large hollow mouth near `x≈0.83, y≈1.5`. The hidden opposite pulmonary branch is not directly observed.

The blue superior vena cava is visible on image left from about `x=-0.95, y=0.9` to `x=-1.0, y=1.9`. Its inferior continuation is visible behind the lower image-left heart edge from roughly `x=-0.83, y=-1.3` to `x=-1.0, y=-1.7`. Four short red pulmonary-vein stubs are visible laterally behind the atrial region, two per side, with hollow or deeply shaded ends.

Deep salmon-pink right and left atrial/auricular masses overlap the upper ventricular body. The image-left atrial mass is broad and vertically elongated; the image-right auricle is smaller, lobulated, and projects forward. Gold epicardial fat follows the atrioventricular and anterior interventricular/coronary grooves as attached bands and lobules. It does not form a broad upper cap.

Red coronary arteries and blue coronary veins form a branching, surface-attached network. Primary trunks descend from the superior groove; thinner branches taper across both ventricles. Vessel paths follow the myocardial surface and gold fat channels rather than floating above them.

## Materials and light

- Myocardium: salmon-red dielectric, broad semi-gloss response, restrained directional fiber relief and shallow folds.
- Aorta and pulmonary veins: saturated warm red dielectric with slightly smoother walls and visible wall thickness at openings.
- SVC, IVC, pulmonary trunk, and coronary veins: saturated medium blue dielectric with broad highlights.
- Auricles/atria: deeper salmon pink with pronounced lobulated/folded relief.
- Epicardial fat: warm gold/peach dielectric, brighter and softer-looking than myocardium, clustered along grooves.
- Coronary arteries: saturated red; coronary veins: saturated blue; both smooth and narrower than great vessels.
- Lumens: dark recessed interiors, never flat dark decals.
- Lighting: large soft white key from upper-left/front, weak neutral fill, white background, soft contact-free studio presentation.

## Coordinate and camera contract

Use `x=(pixelX-560)/280`, `y=(700-pixelY)/280`, Y up, and `+Z` toward the viewer. The reference is perspective-like and uncalibrated; use an approximate front three-quarter review camera. Pixel-derived X/Y locations are observations. Z placement, rear geometry, and tube cross-section depth are reconstruction inferences.

## Identity-defining systems

1. Asymmetric continuous body with apex biased strongly toward image right.
2. Red aortic arch with exactly three separated superior hollow mouths.
3. Blue pulmonary trunk crossing anterior to the ascending aorta and turning to image right.
4. Blue SVC/IVC continuous vertical caval system on image left.
5. Deep salmon atrial/auricular masses, gold groove-following fat, and red/blue surface-attached coronary branching.

## Explicit limitations

The single source cannot establish posterior coronary routing, exact rear atrial geometry, the full hidden right pulmonary branch, the posterior aorta, or true vessel depth. Those regions must be conservative, anatomically plausible continuations and must be labeled inferred. This is a stylized external teaching model, not diagnostic anatomy. The white background is excluded from model geometry and materials.
