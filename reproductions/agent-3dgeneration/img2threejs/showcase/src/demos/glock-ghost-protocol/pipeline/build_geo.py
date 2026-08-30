"""Assemble the Glock-18 | Ghost Protocol geo.json from the traced reference contours.

Everything here is a measurement off the FRONT reference (the BACK reference is the
cross-check: mean silhouette disagreement is 1.6 px on both the top and the bottom edge).
Pixel -> world: world = (px - centre) * SCALE, with image +y flipped to world -y.
"""
import json
from contour import mask, contours, rdp, cut_above, cut_below
import numpy as np
from PIL import Image, ImageDraw

SCALE = 0.002
XC, YC = 1001.0, 561.0
SPLIT_Y = 221.0                      # slide / frame parting line (darkest seam row, x 350..1250)
MAG_A, MAG_B = (240.0, 920.0), (660.0, 950.0)   # magwell-mouth seam: frame above, magazine below


def w(p):
    return [round((p[0] - XC) * SCALE, 5), round((YC - p[1]) * SCALE, 5)]


def wx(px):
    return round((px - XC) * SCALE, 5)


def wy(py):
    return round((YC - py) * SCALE, 5)


def wl(px):
    return round(px * SCALE, 5)


def mag_line(x):
    return MAG_A[1] + (x - MAG_A[0]) * (MAG_B[1] - MAG_A[1]) / (MAG_B[0] - MAG_A[0])


def area(poly):
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2


def ccw(poly):
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        a += x0 * y1 - x1 * y0
    # image y grows downward, so a NEGATIVE shoelace in pixel space is CCW in world space
    return poly if a < 0 else poly[::-1]


# ---------------------------------------------------------------- trigger footprint
# Declared before the contours because the guard hole is traced from a mask with the trigger
# PUNCHED OUT (see below).
# trigger: the free right-hand (finger-facing) edge is traced off the dark-shoe component;
# the left edge is the guard's inner rear wall, which the reference never shows uncovered.
TRIG_RIGHT = [(975, 372), (972, 388), (965, 402), (955, 420), (947, 434), (940, 448),
              (934, 462), (934, 476), (937, 492), (941, 508), (947, 524), (955, 540),
              (963, 552), (968, 562), (962, 572), (946, 580), (925, 583), (905, 580),
              # forked tail: the shoe prong, a V-notch, then the safety-blade prong. Both
              # references show two separate prongs here, not one rounded tongue.
              (896, 556), (884, 540), (872, 558), (866, 578)]
TRIG_LEFT_X = 845

trigger = [(TRIG_LEFT_X, 370)] + TRIG_RIGHT + [(TRIG_LEFT_X, 578)]


def punch(m, poly, grow=2):
    """Clear a polygon out of a boolean mask, dilated by `grow` px."""
    img = Image.new("1", (m.shape[1], m.shape[0]), 0)
    d = ImageDraw.Draw(img)
    d.polygon([(int(x), int(y)) for x, y in poly], fill=1)
    d.line([(int(x), int(y)) for x, y in poly] + [(int(poly[0][0]), int(poly[0][1]))],
           fill=1, width=grow * 2)
    return m & ~np.array(img, bool)


# ---------------------------------------------------------------- contours
src = mask("ref_front.png")
outer_px, _ = contours(src)
outer = rdp(outer_px, 0.9)

# The trigger is opaque in the reference and joins the frame at the top, so a plain trace of
# the enclosed void gives a guard hole that wraps AROUND the trigger — leaving the frame a
# solid trigger-shaped tongue at full receiver thickness. The build then carries TWO triggers:
# that tongue, and the real 3D shoe sitting on top of it. Punch the trigger footprint out of
# the mask first, so the traced opening is the whole guard interior plus the slot the trigger
# passes through, and the only trigger in the model is the one that is actually modelled.
_, holes_open = contours(punch(src, trigger))
guard_hole = rdp(max(holes_open, key=len), 0.7)

slide_px = cut_above(outer, lambda p: SPLIT_Y)
lower_px = cut_below(outer, lambda p: SPLIT_Y)
frame_px = cut_above(lower_px, mag_line)
mag_px = cut_below(lower_px, mag_line)

print("slide %d pts area %.0f" % (len(slide_px), area(slide_px)))
print("frame %d pts area %.0f" % (len(frame_px), area(frame_px)))
print("mag   %d pts area %.0f" % (len(mag_px), area(mag_px)))
print("hole  %d pts area %.0f" % (len(guard_hole), area(guard_hole)))

# ---------------------------------------------------------------- hardware, measured in px
# ---------------------------------------------------------------- assemble
geo = {
    "meta": {
        "item": "Glock-18 | Ghost Protocol (Well-Worn)",
        "scale": SCALE,
        "xc": XC,
        "yc": YC,
        "frame": "+X muzzle, +Y sights, Z across the gun; +Z face = FRONT reference, -Z face = BACK reference (mirrored into the same UV frame)",
        "sourceViews": ["ref_front.png", "ref_back.png"],
        "silhouetteAgreementPx": json.load(open("trace.json"))["agreement"],
        "textureCrop": {"x0": 136, "x1": 1866, "y0": 0, "y1": 1125},
        "totalLengthWorld": round((1856 - 146) * SCALE, 4),
        "totalHeightWorld": round((1116 - 6) * SCALE, 4),
        "splitYPx": SPLIT_Y,
        "magSeamPx": [list(MAG_A), list(MAG_B)],
    },
    "parts": {
        "slide": {"outline": [w(p) for p in ccw(slide_px)]},
        "frame": {"outline": [w(p) for p in ccw(frame_px)], "holes": [[w(p) for p in ccw(guard_hole)[::-1]]]},
        "magazine": {"outline": [w(p) for p in ccw(mag_px)]},
        "trigger": {"outline": [w(p) for p in ccw(trigger)]},
    },
    # Z is INFERRED: both supplied views are broadside and neither resolves depth.
    # Scaled from the published Glock 18 cross-sections against the traced 1110 px height
    # (138 mm -> 2.22 world, i.e. 0.01609 world/mm).
    "thickness": {
        "slide": 0.410,
        "frame": 0.386,
        "gripPanelProud": 0.014,
        "magazine": 0.462,
        "trigger": 0.075,
        "triggerSafety": 0.026,
        "breechBlock": 0.300,
        "barrelOuter": 0.232,
        "confidence": 0.45,
        "basis": "no supplied view resolves Z; widths are the published Glock-18 slide/frame/grip "
                 "cross-sections (25.5 / 24.6 / 29.5 mm) scaled by the traced 138 mm height",
    },
    "features": {
        "rearSight": {"xPx": [242, 308], "topPx": 7, "baseYPx": 35, "confidence": 0.94},
        "frontSight": {"xPx": [1745, 1782], "topPx": 21, "baseYPx": 35, "confidence": 0.92},
        "ejectionPort": {"xPx": [880, 1145], "yPx": [40, 132], "cornerRPx": 26, "confidence": 0.95,
                         "note": "steel breech face visible through the port; 'G18' engraved at x 925..1045"},
        "extractor": {"xPx": [702, 892], "yPx": [70, 124], "confidence": 0.88},
        "rearSerrations": {"xPx": [300, 545], "yPx": [40, 205], "count": 9, "confidence": 0.9},
        "frontSerrations": {"xPx": [1628, 1790], "yPx": [45, 200], "count": 7, "confidence": 0.85},
        "railSlots": {"xPx": [1552, 1800], "yPx": [318, 372], "count": 4, "confidence": 0.8},
        "triggerPin": {"cxPx": 925, "cyPx": 255, "rPx": 13, "confidence": 0.9},
        "lockingBlockPin": {"cxPx": 962, "cyPx": 320, "rPx": 17, "confidence": 0.9},
        "slideStop": {"xPx": [1148, 1338], "yPx": [296, 350], "confidence": 0.86},
        "magRelease": {"xPx": [662, 762], "yPx": [486, 606], "confidence": 0.78,
                       "note": "partly read as a frame relief; the two views disagree on its rear edge"},
        "triggerSafety": {"xPx": [878, 906], "yPx": [382, 566], "confidence": 0.62,
                          "note": "the blade split is only faintly resolved on the trigger face"},
        "gripPanel": {"xPx": [352, 700], "yPx": [300, 900], "cornerRPx": 70, "confidence": 0.8},
        "cyberModule": {"xPx": [988, 1142], "yPx": [238, 300], "barXPx": [1035, 1078],
                        "barYPx": [244, 322], "confidence": 0.72,
                        "note": "ribbon-cable module seen THROUGH the translucent frame; depth is inferred"},
        "magSerrations": {"xPx": [578, 648], "yPx": [956, 1096], "count": 6, "confidence": 0.85},
        "gripSerrations": {"xPx": [592, 660], "yPx": [812, 940], "count": 5, "confidence": 0.82},
        "wornMagwellLip": {"xPx": [178, 640], "yPx": [858, 940], "confidence": 0.9,
                           "note": "Well-Worn: polymer worn through to bright metal along the magwell mouth"},
    },
    "internals": {
        "barrel": {"xPx": [878, 1856], "cyPx": 148, "rPx": 56, "confidence": 0.5,
                   "note": "OD from the published 14.5 mm barrel scaled by the traced height; the bore "
                           "axis sits under the ejection-port floor, which the port opening confirms"},
        "recoilRod": {"xPx": [962, 1852], "cyPx": 200, "rPx": 20, "confidence": 0.35},
        "breechFace": {"xPx": [880, 1150], "yPx": [42, 208], "confidence": 0.6},
        "magBody": {"topPx": 300, "confidence": 0.4},
    },
    "chamfer": {
        "shellRollFrac": 0.09,
        "basis": "the references show a thin bright edge line, not a wide bevel band; 9% of half-thickness "
                 "keeps the roll shading continuous without drawing a chrome outline round the silhouette",
    },
}

# world convenience copies for everything the factory places by centre/radius
f = geo["features"]
for k in ("triggerPin", "lockingBlockPin"):
    d = f[k]
    d.update(cx=wx(d["cxPx"]), cy=wy(d["cyPx"]), r=wl(d["rPx"]))
for k, d in list(f.items()) + list(geo["internals"].items()):
    if "xPx" in d:
        d["x"] = [wx(d["xPx"][0]), wx(d["xPx"][1])]
    if "yPx" in d:
        d["y"] = [wy(d["yPx"][1]), wy(d["yPx"][0])]
    if "cyPx" in d and "cy" not in d:
        d["cy"] = wy(d["cyPx"])
    if "rPx" in d and "r" not in d:
        d["r"] = wl(d["rPx"])
    if "barXPx" in d:
        d["barX"] = [wx(d["barXPx"][0]), wx(d["barXPx"][1])]
        d["barY"] = [wy(d["barYPx"][1]), wy(d["barYPx"][0])]
    if "topPx" in d and k != "rearSight" and k != "frontSight":
        d["top"] = wy(d["topPx"])
for k in ("rearSight", "frontSight"):
    d = f[k]
    d["top"] = wy(d["topPx"])
    d["base"] = wy(d["baseYPx"])
f["ejectionPort"]["cornerR"] = wl(f["ejectionPort"]["cornerRPx"])
f["gripPanel"]["cornerR"] = wl(f["gripPanel"]["cornerRPx"])

json.dump(geo, open("../../src/demos/glock-ghost-protocol/geo.json", "w"), indent=1)
print("wrote geo.json  length=%.3f height=%.3f" % (geo["meta"]["totalLengthWorld"], geo["meta"]["totalHeightWorld"]))
