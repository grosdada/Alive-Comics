"""Geometrie des planches, cote serveur (meme calcul que app/web/js/geometry.js, pour le pilotage par API).

feuille : {"t": "leaf", "id": "p3"}
decoupe : {"t": "split", "dir": "h" | "v", "a": 0..1, "b": 0..1, "c": [enfant1, enfant2]}
  dir "h" = trait plutot horizontal (enfant1 au-dessus) ; "v" = trait plutot vertical (enfant1 a gauche).
  a, b = position du trait a ses deux bouts dans la boite du parent (a != b : trait penche).
"""

import math
import random

FORMATS = {
    "bd": (1600, 2400, "Page BD (2:3)"),
    "manga": (1500, 2120, "Manga B5"),
    "portrait45": (1600, 2000, "4:5"),
    "carre": (2000, 2000, "Carré"),
    "ecran": (1350, 2400, "Écran 9:16"),
}
PAGE_DEFAULTS = {"format": "bd", "orientation": "portrait", "width": 1600, "height": 2400, "bg": "#ffffff",
                 "stroke": "#111111", "strokeWidth": 5, "gutter": 22, "margin": 60}


def page_size(fmt, orientation="portrait"):
    w, h, _ = FORMATS.get(fmt, FORMATS["bd"])
    return (h, w) if orientation == "paysage" else (w, h)


def bbox(poly):
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    return {"x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}


def area(poly):
    s = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def centroid(poly):
    return [sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)]


def _clip_half(poly, f):
    out = []
    for i in range(len(poly)):
        P, Q = poly[i], poly[(i + 1) % len(poly)]
        fp, fq = f(P), f(Q)
        if fp <= 0:
            out.append(P)
        if (fp < 0 < fq) or (fp > 0 > fq):
            t = fp / (fp - fq)
            out.append([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t])
    return out


def _cut_line(node, bb):
    if node["dir"] == "h":
        P = [bb["x0"], bb["y0"] + node["a"] * bb["h"]]
        Q = [bb["x1"], bb["y0"] + node["b"] * bb["h"]]
    else:
        P = [bb["x0"] + node["a"] * bb["w"], bb["y0"]]
        Q = [bb["x0"] + node["b"] * bb["w"], bb["y1"]]
    dx, dy = Q[0] - P[0], Q[1] - P[1]
    L = math.hypot(dx, dy) or 1
    n = [-dy / L, dx / L]
    if node["dir"] == "h" and n[1] < 0:
        n = [-n[0], -n[1]]
    if node["dir"] == "v" and n[0] < 0:
        n = [-n[0], -n[1]]
    return P, Q, n


def compute(page, layout):
    """Cases de la planche : [{id, poly, bbox, order}] dans l'ordre de lecture."""
    m, W, H, g = page["margin"], page["width"], page["height"], page["gutter"]
    panels = []

    def walk(node, poly):
        if not node:
            return
        if node["t"] == "leaf":
            panels.append({"id": node["id"], "poly": poly, "bbox": bbox(poly) if len(poly) >= 3 else None})
            return
        bb = bbox(poly)
        P, n = _cut_line(node, bb)[0], _cut_line(node, bb)[2]
        f = lambda X: n[0] * (X[0] - P[0]) + n[1] * (X[1] - P[1])
        A = _clip_half(poly, lambda X: f(X) + g / 2)
        B = _clip_half(poly, lambda X: -f(X) + g / 2)
        walk(node["c"][0], A if len(A) >= 3 else [])
        walk(node["c"][1], B if len(B) >= 3 else [])

    walk(layout, [[m, m], [W - m, m], [W - m, H - m], [m, H - m]])
    live = [p for p in panels if len(p["poly"]) >= 3]
    row_h = H * 0.06

    def before(p, q):                      # meme regle que l'editeur : rangees, puis gauche -> droite
        (px, py), (qx, qy) = centroid(p["poly"]), centroid(q["poly"])
        overlap = min(p["bbox"]["y1"], q["bbox"]["y1"]) - max(p["bbox"]["y0"], q["bbox"]["y0"])
        if overlap > min(p["bbox"]["h"], q["bbox"]["h"]) * 0.5:
            return px - qx
        return px - qx if abs(py - qy) < row_h else py - qy

    import functools
    live.sort(key=functools.cmp_to_key(before))
    for i, p in enumerate(live):
        p["order"] = i + 1
    return live


def gen_size(w, h, mp=0.8, long_max=1344):
    """Taille de generation H3 : ~0,8 Mpx au ratio de la case, cote long <= 1344, multiples de 32."""
    ratio = w / h
    gw = math.sqrt(mp * 1024 * 1024 * ratio)
    gh = gw / ratio
    if max(gw, gh) > long_max:
        s = long_max / max(gw, gh)
        gw, gh = gw * s, gh * s
    return max(32, round(gw / 32) * 32), max(32, round(gh / 32) * 32)


def placement(bb, iw, ih, view=None):
    """Image dans la boite de la case : couverture * zoom, decalage (ox, oy) en fraction de la boite."""
    v = view or {}
    zoom = max(1.0, float(v.get("zoom") or 1))
    s = max(bb["w"] / iw, bb["h"] / ih) * zoom
    dw, dh = iw * s, ih * s
    mx, my = (dw - bb["w"]) / (2 * bb["w"]), (dh - bb["h"]) / (2 * bb["h"])
    ox = max(-mx, min(mx, float(v.get("ox") or 0)))
    oy = max(-my, min(my, float(v.get("oy") or 0)))
    return {"x": bb["x0"] + bb["w"] / 2 - dw / 2 + ox * bb["w"], "y": bb["y0"] + bb["h"] / 2 - dh / 2 + oy * bb["h"],
            "w": dw, "h": dh}


# ------------------------------------------------------------------ decoupages prets (memes que l'editeur)
def _L(new):
    return {"t": "leaf", "id": new()}


def _S(d, a, b, c0, c1):
    return {"t": "split", "dir": d, "a": a, "b": b, "c": [c0, c1]}


def _rows(n, mk):
    return mk() if n == 1 else _S("h", 1 / n, 1 / n, mk(), _rows(n - 1, mk))


def _cols(n, mk):
    return mk() if n == 1 else _S("v", 1 / n, 1 / n, mk(), _cols(n - 1, mk))


PRESETS = {
    "plein": ("Pleine page", lambda L: L()),
    "2b": ("2 bandes", lambda L: _rows(2, L)),
    "3b": ("3 bandes", lambda L: _rows(3, L)),
    "2x2": ("4 cases", lambda L: _rows(2, lambda: _cols(2, L))),
    "3x2": ("6 cases", lambda L: _rows(3, lambda: _cols(2, L))),
    "3x3": ("9 cases", lambda L: _rows(3, lambda: _cols(3, L))),
    "g3": ("Grande + 3", lambda L: _S("h", 0.56, 0.56, L(), _cols(3, L))),
    "col2": ("Colonne + 2", lambda L: _S("v", 0.58, 0.58, L(), _S("h", 0.5, 0.5, L(), L()))),
    "hmb": ("Haut, 2, bas", lambda L: _S("h", 0.3, 0.3, L(), _S("h", 0.58, 0.58, _S("v", 0.5, 0.5, L(), L()), L()))),
    "action": ("Action penchée", lambda L: _S("h", 0.34, 0.27, L(), _S("h", 0.55, 0.64, _S("v", 0.56, 0.44, L(), L()), L()))),
    "david": ("Cadres penchés (planche 3)", lambda L: _S("h", 0.31, 0.285, L(),
              _S("h", 0.74, 0.70, _S("v", 0.475, 0.47, _S("h", 0.53, 0.49, L(), L()), L()), L()))),
    "manga": ("Manga dynamique", lambda L: _S("h", 0.24, 0.24, _cols(2, L), _S("h", 0.5, 0.42, _S("v", 0.64, 0.4, L(), L()),
              _S("v", 0.33, 0.37, L(), _S("h", 0.5, 0.55, L(), L()))))),
}


def make_layout(preset, start=1):
    """(layout, prochain numero). Les cases s'appellent p1, p2… dans l'ordre de creation (pas forcement de lecture)."""
    n = [start - 1]

    def new():
        n[0] += 1
        return f"p{n[0]}"
    return PRESETS[preset][1](lambda: _L(new)), n[0] + 1


def random_layout(count, tilt=0.05, seed=None, start=1):
    rnd = random.Random(seed)
    n = [start - 1]

    def new():
        n[0] += 1
        return f"p{n[0]}"

    def tilted(x):
        return max(0.2, min(0.8, x + (rnd.random() - 0.5) * 2 * tilt))

    def build(k, w, h):
        if k <= 1:
            return _L(new)
        d = "v" if w / h > 1.25 else ("h" if h / w > 1.25 else ("h" if rnd.random() < 0.5 else "v"))
        k1 = max(1, min(k - 1, round(k * (0.3 + rnd.random() * 0.4))))
        pos = k1 / k * 0.6 + 0.2 + (rnd.random() - 0.5) * 0.1
        w1, h1, w2, h2 = (w, h * pos, w, h * (1 - pos)) if d == "h" else (w * pos, h, w * (1 - pos), h)
        return _S(d, tilted(pos), tilted(pos), build(k1, w1, h1), build(k - k1, w2, h2))
    return build(count, 2, 3), n[0] + 1


def leaves(node, out=None):
    out = [] if out is None else out
    if node:
        if node["t"] == "leaf":
            out.append(node["id"])
        else:
            leaves(node["c"][0], out)
            leaves(node["c"][1], out)
    return out
