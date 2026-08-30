"""Alpha-trace the FRONT/BACK Glock-18 references into per-column silhouette rows.

Emits raw pixel measurements only; the world-space geo.json is assembled later.
FRONT: muzzle +X (right).  BACK: muzzle -X (left) -> mirrored into the FRONT frame.
"""
import json
import numpy as np
from PIL import Image

W, H = 2000, 1125
A_THRESH = 96  # alpha above this counts as solid body (kills the soft AA fringe)


def load(name):
    im = Image.open(f"{name}.png").convert("RGBA")
    a = np.array(im)
    return a[..., :3].astype(np.float64), a[..., 3]


def spans(mask_col):
    """Contiguous True runs in a boolean column -> [(y0, y1), ...] inclusive."""
    idx = np.flatnonzero(mask_col)
    if idx.size == 0:
        return []
    brk = np.flatnonzero(np.diff(idx) > 1)
    starts = np.concatenate(([0], brk + 1))
    ends = np.concatenate((brk, [idx.size - 1]))
    return [(int(idx[s]), int(idx[e])) for s, e in zip(starts, ends)]


def trace(name, mirror):
    rgb, al = load(name)
    solid = al > A_THRESH
    if mirror:
        solid = solid[:, ::-1]
        rgb = rgb[:, ::-1]
    out = {"top": [], "bot": [], "spans": {}}
    for x in range(W):
        sp = spans(solid[:, x])
        if not sp:
            out["top"].append(-1)
            out["bot"].append(-1)
            continue
        out["top"].append(sp[0][0])
        out["bot"].append(sp[-1][1])
        if len(sp) > 1:
            out["spans"][x] = sp
    return out, rgb, solid


def slide_split(rgb, solid, x0, x1):
    """The slide/frame parting line: the darkest row per column inside the y band."""
    band = slice(170, 275)
    lum = rgb[band, :, :].mean(axis=2)
    ys = []
    for x in range(x0, x1):
        col = lum[:, x].copy()
        col[~solid[band, x]] = 1e6
        ys.append(170 + int(np.argmin(col)))
    return ys


if __name__ == "__main__":
    res = {}
    for name, mirror in (("ref_front", False), ("ref_back", True)):
        tr, rgb, solid = trace(name, mirror)
        xs = [x for x in range(W) if tr["top"][x] >= 0]
        tr["xRange"] = [xs[0], xs[-1]]
        tr["split"] = slide_split(rgb, solid, xs[0], xs[-1])
        tr["splitX0"] = xs[0]
        res[name] = tr
        print(name, "x", tr["xRange"], "holes at", len(tr["spans"]), "cols")

    # front/back silhouette agreement (back already mirrored into the front frame)
    f, b = res["ref_front"], res["ref_back"]
    both = [x for x in range(W) if f["top"][x] >= 0 and b["top"][x] >= 0]
    dt = np.mean([abs(f["top"][x] - b["top"][x]) for x in both])
    db = np.mean([abs(f["bot"][x] - b["bot"][x]) for x in both])
    onlyf = sum(1 for x in range(W) if f["top"][x] >= 0 and b["top"][x] < 0)
    onlyb = sum(1 for x in range(W) if b["top"][x] >= 0 and f["top"][x] < 0)
    print(f"agreement: topMean={dt:.1f}px botMean={db:.1f}px  frontOnlyCols={onlyf} backOnlyCols={onlyb}")
    res["agreement"] = {"topEdgeMean": round(float(dt), 2), "bottomEdgeMean": round(float(db), 2)}
    json.dump(res, open("trace.json", "w"))
