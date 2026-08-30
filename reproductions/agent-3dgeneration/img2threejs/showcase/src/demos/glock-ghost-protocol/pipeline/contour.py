"""Marching-squares contour of the reference alpha + part-splitting into Glock-18 sub-shapes.

The whole silhouette is one connected blob with one enclosed hole (the trigger guard).
Per-column top/bottom rows are NOT enough: the beavertail overhangs the backstrap, so some
columns carry two disjoint spans.  So we trace real contours and cut them with lines.

Frame: FRONT reference = muzzle to +X (image right), sights up.
"""
import json
import numpy as np
from PIL import Image
from collections import deque

A_THRESH = 96


def mask(path):
    return np.array(Image.open(path).convert("RGBA"))[..., 3] > A_THRESH


def contours(m):
    """Boundary-following (Moore) on a binary mask -> [outer, hole0, ...] as pixel polygons."""
    H, W = m.shape
    pad = np.zeros((H + 2, W + 2), bool)
    pad[1:-1, 1:-1] = m

    def follow(start, inside):
        # 8-connected Moore boundary trace; `inside` selects tracing solid (outer) or void (hole)
        nbr = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
        poly = [start]
        cur = start
        b = 7
        for _ in range(400000):
            found = False
            for k in range(8):
                d = nbr[(b + 1 + k) % 8]
                n = (cur[0] + d[0], cur[1] + d[1])
                if pad[n] == inside:
                    b = (b + 1 + k + 4) % 8
                    cur = n
                    poly.append(n)
                    found = True
                    break
            if not found:
                break
            if cur == start and len(poly) > 2:
                break
        return poly[:-1]

    ys, xs = np.nonzero(pad)
    outer = follow((int(ys[0]), int(xs[np.flatnonzero(ys == ys[0])[0]])), True)

    # holes: flood the void from the border, whatever void is left is enclosed
    void = ~pad
    seen = np.zeros_like(void)
    dq = deque([(0, 0)])
    seen[0, 0] = True
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (y + dy, x + dx)
            if 0 <= n[0] < pad.shape[0] and 0 <= n[1] < pad.shape[1] and void[n] and not seen[n]:
                seen[n] = True
                dq.append(n)
    enclosed = void & ~seen
    holes = []
    hseen = np.zeros_like(enclosed)
    for y in range(pad.shape[0]):
        xs = np.flatnonzero(enclosed[y] & ~hseen[y])
        for x in xs:
            if hseen[y, x]:
                continue
            dq = deque([(y, int(x))])
            hseen[y, x] = True
            px = []
            while dq:
                cy, cx = dq.popleft()
                px.append((cy, cx))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    n = (cy + dy, cx + dx)
                    if enclosed[n] and not hseen[n]:
                        hseen[n] = True
                        dq.append(n)
            if len(px) < 200:
                continue
            holes.append(follow(min(px), False))
    # back to unpadded pixel coords, as (x, y)
    conv = lambda poly: [(p[1] - 1, p[0] - 1) for p in poly]
    return conv(outer), [conv(h) for h in holes]


def rdp(pts, eps):
    """Douglas-Peucker on a closed polygon (keeps the loop closed)."""
    def seg(a, b, ps):
        if not ps:
            return []
        ax, ay = a
        bx, by = b
        dx, dy = bx - ax, by - ay
        n = (dx * dx + dy * dy) ** 0.5 or 1e-9
        d = [abs((p[0] - ax) * dy - (p[1] - ay) * dx) / n for p in ps]
        i = int(np.argmax(d))
        if d[i] <= eps:
            return []
        return seg(a, ps[i], ps[:i]) + [ps[i]] + seg(ps[i], b, ps[i + 1:])

    n = len(pts)
    a, b = pts[0], pts[n // 2]
    out = [a] + seg(a, b, pts[1:n // 2]) + [b] + seg(b, a, pts[n // 2 + 1:])
    return out


def cut_below(poly, yline):
    """Clip a closed pixel polygon to y >= yline(x) (image coords: larger y = lower)."""
    return _clip(poly, lambda p: p[1] >= yline(p[0]))


def cut_above(poly, yline):
    return _clip(poly, lambda p: p[1] <= yline(p[0]))


def _clip(poly, keep):
    out = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        ka, kb = keep(a), keep(b)
        if ka:
            out.append(a)
        if ka != kb:
            # bisect along the edge for the crossing (yline may be non-constant)
            lo, hi = 0.0, 1.0
            for _ in range(24):
                t = (lo + hi) / 2
                p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                if keep(p) == ka:
                    lo = t
                else:
                    hi = t
            t = (lo + hi) / 2
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


if __name__ == "__main__":
    m = mask("ref_front.png")
    outer, holes = contours(m)
    print("outer pts", len(outer), "holes", [len(h) for h in holes])
    o = rdp(outer, 1.2)
    hs = [rdp(h, 1.0) for h in holes]
    print("simplified outer", len(o), "hole", [len(h) for h in hs])
    json.dump({"outer": o, "holes": hs}, open("contour_front.json", "w"))

    mb = mask("ref_back.png")
    ob, hb = contours(mb)
    ob = [(1999 - p[0], p[1]) for p in rdp(ob, 1.2)][::-1]
    hb = [[(1999 - p[0], p[1]) for p in rdp(h, 1.0)][::-1] for h in hb]
    json.dump({"outer": ob, "holes": hb}, open("contour_back.json", "w"))
    print("back simplified outer", len(ob), "hole", [len(h) for h in hb])
