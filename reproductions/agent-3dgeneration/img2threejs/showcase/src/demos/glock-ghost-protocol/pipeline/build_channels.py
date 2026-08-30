"""Author the shell's roughness / metalness / AO / normal channels.

Hard rule: none of these is derived from the albedo. They are built from the traced
GEOMETRY (silhouette distance field, the trigger-guard hole, the slide/frame seam, the
measured serration and rail-slot bands) plus deterministic value noise, so each channel
carries independent information instead of re-tinting the colour map.
"""
import json
import numpy as np
from PIL import Image

W, H = 1730, 1125
X0, Y0 = 136, 0                      # texture crop origin in source-image pixels
geo = json.load(open("../../src/demos/glock-ghost-protocol/geo.json"))
F = geo["features"]
rng = np.random.default_rng(1809)    # deterministic: Glock 18 -> 1809


def tx(px):
    return px - X0


def band(x0, x1, y0, y1):
    m = np.zeros((H, W), bool)
    m[max(0, y0):min(H, y1), max(0, tx(x0)):min(W, tx(x1))] = True
    return m


def blur(a, r):
    pad = np.pad(a.astype(np.float64), r, mode="edge")
    c = pad.cumsum(0).cumsum(1)
    k = 2 * r + 1
    y = np.arange(H)[:, None]
    x = np.arange(W)[None, :]
    c = np.pad(c, ((1, 0), (1, 0)))
    return (c[y + k, x + k] - c[y, x + k] - c[y + k, x] + c[y, x]) / (k * k)


def value_noise(cell):
    """Successive calls draw from the seeded module rng, so the sequence is reproducible."""
    g = rng.random(((H // cell) + 2, (W // cell) + 2))
    im = Image.fromarray((g * 255).astype(np.uint8)).resize((W + cell * 2, H + cell * 2), Image.BICUBIC)
    return np.asarray(im, dtype=np.float64)[cell:cell + H, cell:cell + W] / 255.0


# ---- masks straight off the traced silhouette -------------------------------------
alpha = np.asarray(Image.open("crop_front.png").convert("RGBA"))[..., 3] > 96
# distance from the silhouette edge, cheap: iterated erosion via box-blur of the mask
soft = blur(alpha.astype(np.float64), 9)
edge = np.clip((0.985 - soft) / 0.985, 0, 1) * alpha          # 1 at the rim, 0 inside
edge = np.clip(edge * 2.4, 0, 1)

seam = np.zeros((H, W), bool)
seam[int(geo["meta"]["splitYPx"]) - 5:int(geo["meta"]["splitYPx"]) + 6, :] = True
seam &= alpha

guard = band(*F["gripPanel"]["xPx"], *F["gripPanel"]["yPx"])   # grip panel recess border
panel_edge = np.clip(np.abs(blur(guard.astype(np.float64), 11) - guard) * 6, 0, 1)

worn = band(*F["wornMagwellLip"]["xPx"], *F["wornMagwellLip"]["yPx"]) & alpha
# taper the worn lip to the bright specular streak only (upper 45% of the band)
wy0, wy1 = F["wornMagwellLip"]["yPx"]
grad = np.zeros((H, W))
yy = np.arange(H)[:, None]
grad += np.clip(1 - np.abs(yy - (wy0 + 26)) / 34.0, 0, 1)
worn_f = worn * grad


def ribs(spec, axis, duty=0.46):
    """count evenly-spaced grooves across a measured band; axis 'x' = vertical grooves."""
    x0, x1 = spec["xPx"]
    y0, y1 = spec["yPx"]
    m = np.zeros((H, W))
    n = spec["count"]
    # Taper the band along its own length: a hard boundary put a bright specular line across
    # the end of every groove run (a row of white ticks along the slide's lower edge).
    fade = 26
    if axis == "x":
        pitch = (x1 - x0) / n
        for i in range(n):
            c = tx(x0) + pitch * (i + 0.5)
            lo, hi = int(c - pitch * duty / 2), int(c + pitch * duty / 2)
            m[y0:y1, max(0, lo):max(0, hi)] = 1
        t = np.clip(np.minimum(np.arange(H) - y0, y1 - np.arange(H)) / fade, 0, 1)[:, None]
    else:
        pitch = (y1 - y0) / n
        for i in range(n):
            c = y0 + pitch * (i + 0.5)
            lo, hi = int(c - pitch * duty / 2), int(c + pitch * duty / 2)
            m[max(0, lo):max(0, hi), tx(x0):tx(x1)] = 1
        t = np.clip(np.minimum(np.arange(W) - tx(x0), tx(x1) - np.arange(W)) / fade, 0, 1)[None, :]
    return m * t * alpha


relief = np.zeros((H, W))
relief += ribs(F["rearSerrations"], "x") * 1.0
relief += ribs(F["frontSerrations"], "x") * 0.9
relief += ribs(F["railSlots"], "x", 0.55) * 1.0
relief += ribs(F["magSerrations"], "y", 0.5) * 0.8
relief += ribs(F["gripSerrations"], "y", 0.5) * 0.7
relief = np.clip(relief, 0, 1)
# Keep the relief off the silhouette rim: on the rolled edge these grooves turned into a row
# of bright dashes running along the top and bottom of the slide that the references do not have.
relief *= 1 - edge

# grip stria: the fine diagonal hatch the references show across the grip panel
gx, gy = np.meshgrid(np.arange(W), np.arange(H))
stria = (np.sin((gx * 0.62 + gy * 1.0) * 0.36) * 0.5 + 0.5) * guard * alpha * (1 - edge)

micro = value_noise(3) - 0.5
speckle = value_noise(11)

# ---- roughness --------------------------------------------------------------------
rough = np.full((H, W), 0.235)
rough += edge * 0.16                       # Well-Worn: the rim is scuffed matte
rough += guard * 0.055 + stria * 0.05      # textured grip panel
rough += relief * 0.06
rough -= worn_f * 0.16                     # polished worn-through metal is smoother
rough += (speckle - 0.5) * 0.05 + micro * 0.03
rough = np.clip(rough, 0.05, 0.85)

# ---- metalness: only where the polymer is worn through to bare metal ---------------
metal = np.clip(worn_f * 0.85, 0, 1)

# ---- AO: crevices, not edges ------------------------------------------------------
ao = np.ones((H, W))
ao -= seam * 0.42
ao -= panel_edge * 0.3
ao -= relief * 0.22
ao -= np.clip(1 - blur(alpha.astype(np.float64), 5), 0, 1) * 0.25
ao = np.clip(ao, 0.25, 1.0)
ao = blur(ao, 2)

# ---- normal from a height field ---------------------------------------------------
height = relief * -0.55 + stria * 0.12 + micro * 0.14 + seam * -0.6 + panel_edge * -0.25
height = blur(height, 1)
gyv, gxv = np.gradient(height)
strength = 3.2
nx = np.clip(-gxv * strength * 0.5 + 0.5, 0, 1)
ny = np.clip(gyv * strength * 0.5 + 0.5, 0, 1)
nz = np.full((H, W), 1.0)
n = np.stack([nx, ny, nz], -1)


def save_gray(a, path):
    Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L").save(path)


out = "../../src/demos/glock-ghost-protocol/"
save_gray(rough, out + "roughness.png")
save_gray(metal, out + "metalness.png")
save_gray(ao, out + "ao.png")
Image.fromarray((n * 255).astype(np.uint8), "RGB").save(out + "normal.png")

for src, dst in (("delit_front.png", "front-albedo.png"), ("delit_back.png", "back-albedo.png")):
    Image.open(src).convert("RGBA").save(out + dst)

json.dump({
    "frame": {"width": W, "height": H, "cropOriginPx": [X0, Y0]},
    "channels": {
        "albedoFront": {"file": "front-albedo.png", "colorSpace": "srgb",
                        "source": "FRONT reference, alpha-aware de-lit (strength 0.55, r=110)"},
        "albedoBack": {"file": "back-albedo.png", "colorSpace": "srgb",
                       "source": "BACK reference, mirrored into the FRONT UV frame, same de-light"},
        "roughness": {"file": "roughness.png", "colorSpace": "linear",
                      "source": "silhouette distance field + measured serration/panel bands + seeded noise",
                      "derivedFromAlbedo": False},
        "metalness": {"file": "metalness.png", "colorSpace": "linear",
                      "source": "worn-magwell-lip band only (Well-Worn polymer worn through)",
                      "derivedFromAlbedo": False},
        "ao": {"file": "ao.png", "colorSpace": "linear",
               "source": "slide/frame seam + grip-panel recess + relief bands + silhouette falloff",
               "derivedFromAlbedo": False},
        "normal": {"file": "normal.png", "colorSpace": "linear", "encoding": "tangent, +Y up (OpenGL)",
                   "source": "height field from the measured relief bands + grip stria + seeded micro noise",
                   "derivedFromAlbedo": False},
    },
    "uvOrientation": "planar XY in model space; u = (x - cropX0)/cropW, v = 1 - y/cropH",
    "limitations": [
        "de-lighting is an approximation: the polished magwell specular streak and the slide's top gloss line stay baked into the albedo",
        "no raw skin texture maps were available, so this is image-only, not exact-texture",
    ],
}, open(out + "channels.json", "w"), indent=1)
print("channels written")
