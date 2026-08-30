"""Alpha-aware de-lighting for the Glock-18 reference crops.

The stock delight_albedo.py blurs across the transparent background, so the whole body
reads as "brighter than its neighbourhood" and gets crushed. Here the low-frequency
lighting proxy is a MASK-WEIGHTED box blur, so only body pixels contribute.

This is still an approximation, not inverse rendering: specular hotspots narrower than
the blur radius (the polished magwell lip, the slide's top gloss line) stay baked in,
and that is recorded as a projection limitation.
"""
import numpy as np
from PIL import Image


def boxblur(a, r):
    """Separable box blur via summed-area table; `a` may be 2-D or 3-D."""
    pad = np.pad(a, ((r + 1, r), (r + 1, r)) + ((0, 0),) * (a.ndim - 2), mode="edge")
    c = pad.cumsum(0).cumsum(1)
    H, W = a.shape[:2]
    k = 2 * r + 1
    y0 = np.arange(H)
    x0 = np.arange(W)
    A = c[np.ix_(y0, x0)]
    B = c[np.ix_(y0, x0 + k)]
    C = c[np.ix_(y0 + k, x0)]
    D = c[np.ix_(y0 + k, x0 + k)]
    return (D - B - C + A) / (k * k)


def delight(path, out, strength=0.32, radius=130, floor=0.62, ceil=1.28):
    im = np.array(Image.open(path).convert("RGBA")).astype(np.float64)
    rgb, al = im[..., :3] / 255.0, im[..., 3:4] / 255.0
    m = (al > 0.35).astype(np.float64)

    lum = (rgb * [0.2126, 0.7152, 0.0722]).sum(2)
    num = boxblur(lum * m[..., 0], radius)
    den = boxblur(m[..., 0], radius)
    low = num / np.maximum(den, 1e-4)                      # mask-weighted lighting proxy
    target = float((lum * m[..., 0]).sum() / max(m.sum(), 1))  # body mean luminance

    gain = np.clip(target / np.maximum(low, 1e-3), floor, ceil)
    gain = 1.0 + (gain - 1.0) * strength
    out_rgb = np.clip(rgb * gain[..., None], 0, 1)

    res = np.concatenate([out_rgb * 255, al * 255], axis=2).astype(np.uint8)
    Image.fromarray(res, "RGBA").save(out)
    return {"targetLuma": round(target, 4), "gainRange": [round(float(gain.min()), 3), round(float(gain.max()), 3)]}


if __name__ == "__main__":
    for src, dst in (("crop_front.png", "delit_front.png"), ("crop_back.png", "delit_back.png")):
        print(dst, delight(src, dst))
