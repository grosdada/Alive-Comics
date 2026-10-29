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
PAGE_DEFAULTS = {"format": "bd", "orientation": "portrait", "width": 1600, "height": 2400, "bg": "#ffffff", "fill": "#ffffff",
                 "stroke": "#111111", "strokeWidth": 5, "gutter": 22, "margin": 60}


def page_size(fmt, orientation="portrait"):
    w, h, _ = FORMATS.get(fmt, FORMATS["bd"])
    return (h, w) if orientation == "paysage" else (w, h)


def gen_size(w, h, mp=0.8, long_max=1344):
    """Taille de generation H3 : ~0,8 Mpx au ratio de la case, cote long <= 1344, multiples de 32."""
    ratio = w / h
    gw = math.sqrt(mp * 1024 * 1024 * ratio)
    gh = gw / ratio
    if max(gw, gh) > long_max:
        s = long_max / max(gw, gh)
        gw, gh = gw * s, gh * s
    return max(32, round(gw / 32) * 32), max(32, round(gh / 32) * 32)


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
        if len(poly) < 3:                  # case refermee (animation) : ses sous-cases n'existent pas a cet instant
            walk(node["c"][0], [])
            walk(node["c"][1], [])
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


def grow(poly, px):
    """Elargit le polygone depuis son centre (la video passe sous le trait)."""
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    out = []
    for x, y in poly:
        dx, dy = x - cx, y - cy
        d = (dx * dx + dy * dy) ** 0.5 or 1
        out.append([round(x + dx / d * px, 1), round(y + dy / d * px, 1)])
    return out


def offset(poly, d):
    """Polygone convexe decale de d vers l'exterieur (d < 0 : vers l'interieur), coins en onglet : le contour
    d'un trait d'epaisseur w = offset(+w/2) moins offset(-w/2), comme le trait du canevas (lineJoin miter)."""
    n = len(poly)
    s = sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1] for i in range(n))
    sign = 1 if s > 0 else -1                 # sens de parcours : normale sortante de chaque cote
    lines = []
    for i in range(n):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1
        nx, ny = dy / L * sign, -dx / L * sign
        lines.append(((x1 + nx * d, y1 + ny * d), (dx, dy)))
    out = []
    for i in range(n):
        (p, r), (q, s2) = lines[i - 1], lines[i]
        den = r[0] * s2[1] - r[1] * s2[0]
        if abs(den) < 1e-9:
            out.append([q[0], q[1]])
            continue
        t = ((q[0] - p[0]) * s2[1] - (q[1] - p[1]) * s2[0]) / den
        out.append([p[0] + r[0] * t, p[1] + r[1] * t])
    return out


# ------------------------------------------------------------------ animation du cadrage (« Animate framing »)
# Chaque trait a un identifiant (c1, c2...) ; chacun de ses deux bouts (a, b) peut avoir une piste d'images cles :
# anim = {"tracks": {"c2.a": [{"t": secondes, "v": 0..1, "e": courbe}]}}. Entre deux cles, la valeur suit la courbe
# de la premiere. MEME CALCUL que app/web/js/geometry.js et player/alive-player.js.
EASES = ("ease", "linear", "in", "out", "ease2", "in2", "out2", "hold")


def ease(e, u):
    """Courbe entre deux cles (u de 0 a 1). Les memes dans app/web/js/geometry.js et player/alive-player.js."""
    if e == "linear":
        return u
    if e == "in":
        return u ** 3
    if e == "out":
        return 1 - (1 - u) ** 3
    if e == "in2":
        return u ** 5
    if e == "out2":
        return 1 - (1 - u) ** 5
    if e == "ease2":
        return 16 * u ** 5 if u < 0.5 else 1 - (-2 * u + 2) ** 5 / 2
    if e == "hold":
        return 0.0
    return 4 * u ** 3 if u < 0.5 else 1 - (-2 * u + 2) ** 3 / 2


def track_value(keys, t, fallback):
    if not keys:
        return fallback
    if t <= keys[0]["t"]:
        return keys[0]["v"]
    for k0, k1 in zip(keys, keys[1:]):
        if t < k1["t"]:
            u = (t - k0["t"]) / max(1e-9, k1["t"] - k0["t"])
            return k0["v"] + (k1["v"] - k0["v"]) * ease(k0.get("e"), u)
    return keys[-1]["v"]


def has_anim(anim):
    return bool(anim) and any((anim.get("tracks") or {}).values())


def layout_at(layout, anim, t):
    """Le decoupage a l'instant t (arbre recopie, bouts animes remplaces)."""
    if not has_anim(anim):
        return layout
    T = anim["tracks"]

    def walk(n):
        if n["t"] == "leaf":
            return n
        return dict(n, a=track_value(T.get(f"{n.get('id')}.a"), t, n["a"]),
                    b=track_value(T.get(f"{n.get('id')}.b"), t, n["b"]), c=[walk(n["c"][0]), walk(n["c"][1])])
    return walk(layout)


# style de page anime (module « Style de page » de la timeline) : pistes "page.<cle>"
PAGE_COLORS = ("bg", "fill", "stroke")
PAGE_NUMS = {"strokeWidth": (0, 30), "gutter": (0, 120), "margin": (0, 400)}


def hex_rgb(h):
    s = str(h or "#ffffff").lstrip("#")
    try:
        return [int(s[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    except ValueError:
        return [1.0, 1.0, 1.0]


def color_value(keys, t, fallback):
    """Couleur a l'instant t (composantes 0..1, interpolees une a une) : meme calcul que colorValue (JS)."""
    if not keys:
        return hex_rgb(fallback)
    if t <= keys[0]["t"]:
        return hex_rgb(keys[0]["v"])
    for k0, k1 in zip(keys, keys[1:]):
        if t < k1["t"]:
            e = ease(k0.get("e"), (t - k0["t"]) / max(1e-9, k1["t"] - k0["t"]))
            a, b = hex_rgb(k0["v"]), hex_rgb(k1["v"])
            return [x + (y - x) * e for x, y in zip(a, b)]
    return hex_rgb(keys[-1]["v"])


def page_at(page, anim, t):
    """La page a l'instant t : nombres interpoles ; couleurs en composantes 0..1 dans out["rgb"]."""
    T = (anim or {}).get("tracks") or {}
    out = dict(page)
    rgb = {}
    for k in PAGE_COLORS:
        rgb[k] = color_value(T.get(f"page.{k}"), t, page.get(k) or ("#111111" if k == "stroke" else "#ffffff"))
    for k in PAGE_NUMS:
        out[k] = track_value(T.get(f"page.{k}"), t, page.get(k))
    out["rgb"] = rgb
    return out


def anim_end(anim):
    return max([k["t"] for keys in ((anim or {}).get("tracks") or {}).values() for k in keys or []] or [0.0])


def cut_ids(node, out=None):
    out = [] if out is None else out
    if node and node["t"] == "split":
        if node.get("id"):
            out.append(node["id"])
        cut_ids(node["c"][0], out)
        cut_ids(node["c"][1], out)
    return out


def ensure_cut_ids(layout):
    """Donne un identifiant aux traits qui n'en ont pas (modifie l'arbre) ; meme regle que l'editeur."""
    n = [max([int(i[1:]) for i in cut_ids(layout) if i[1:].isdigit()] or [0])]

    def walk(x):
        if not x or x["t"] != "split":
            return
        if not x.get("id"):
            n[0] += 1
            x["id"] = f"c{n[0]}"
        walk(x["c"][0])
        walk(x["c"][1])
    walk(layout)
    return layout


def clean_anim(anim, layout, max_t=600.0):
    """Pistes propres : traits existants, cles triees, valeurs 0..1, une cle par instant, courbes connues."""
    ids = set(cut_ids(layout))
    out = {}
    for key, keys in ((anim or {}).get("tracks") or {}).items():
        cid, _, end = str(key).rpartition(".")
        page = cid == "page" and (end in PAGE_COLORS or end in PAGE_NUMS)
        if not isinstance(keys, list) or not (page or (cid in ids and end in ("a", "b"))):
            continue
        clean = {}
        for k in keys:
            try:
                t = round(max(0.0, min(max_t, float(k["t"]))), 4)
                if page and end in PAGE_COLORS:
                    v = str(k["v"]).lower()
                    if not (len(v) == 7 and v[0] == "#" and all(c in "0123456789abcdef" for c in v[1:])):
                        continue
                elif page:
                    lo, hi = PAGE_NUMS[end]
                    v = round(max(lo, min(hi, float(k["v"]))), 3)
                else:
                    v = round(max(0.0, min(1.0, float(k["v"]))), 5)
            except (KeyError, TypeError, ValueError):
                continue
            clean[t] = {"t": t, "v": v, "e": k.get("e") if k.get("e") in EASES else "ease"}
        if clean:
            out[key] = [clean[t] for t in sorted(clean)]
    return {"tracks": out} if out else {}


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
    return ensure_cut_ids(PRESETS[preset][1](lambda: _L(new))), n[0] + 1


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
    return ensure_cut_ids(build(count, 2, 3)), n[0] + 1


def leaves(node, out=None):
    out = [] if out is None else out
    if node:
        if node["t"] == "leaf":
            out.append(node["id"])
        else:
            leaves(node["c"][0], out)
            leaves(node["c"][1], out)
    return out
