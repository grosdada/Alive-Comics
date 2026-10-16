"""Emulation Lytro : vues d'une case (deux demi-arcs H3 « temps fige », gauche et droite, partant de la photo) ->
pile de vues regulierement espacees + profondeur par vue, pour le lecteur lytro.html.

    python tools/lytro_build.py <projet> [case ...]

Sortie : projects/<projet>/lytro/<case>/v00.jpg ... (gauche -> droite, la photo au milieu), d00.png ... (disparite
0-255, grand = proche), meta.json {n, center, w, h, s (decalage mesure de chaque vue, px), spread (relief), ...}.

Mesure : flot optique DIS entre la photo et chaque image ; s = mediane du decalage horizontal (la camera tourne
autour du sujet : le decor glisse), spread = ecart p95 - p5 (le relief visible). Les images sont reprises a pas
egaux de s (H3 accelere et freine), jusqu'a un relief de SPREAD_MAX de la largeur.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, r"E:\Codex projects\Alive-Comics")
from app import depth, store  # noqa: E402

W_OUT = 1024              # largeur des vues livrees
N_SIDE = 20               # vues de chaque cote de la photo (41 en tout) : pas de ~1,5 px entre voisines
SPREAD_MAX = 0.03         # relief maximal garde : 3 % de la largeur (un fondu entre voisines ecartees de plus de
                          # ~1,5 px montre des doubles contours ; le lecteur en montre 1,5 % par defaut)
MEAS_W = 512              # largeur de mesure du flot


def frames(path):
    cap = cv2.VideoCapture(str(path))
    out = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        out.append(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
    cap.release()
    return out


def measure(ref_g, g, dis):
    fl = dis.calc(ref_g, g, None)
    fx = fl[..., 0]
    return float(np.median(fx)), float(np.percentile(fx, 95) - np.percentile(fx, 5)), fl


def build(pid, pan):
    pj = store.get(pid)
    panel = pj["panels"][pan]
    ch = panel.get("chosen") or {}
    if not (ch.get("L") or ch.get("R")):
        return f"{pid} {pan} : aucun rendu"
    L = frames(store.path(pid, ch["L"])) if ch.get("L") else []
    R = frames(store.path(pid, ch["R"])) if ch.get("R") else []
    H, W = (L or R)[0].shape[:2]
    start = np.asarray(Image.open(store.path(pid, f"start/{pan}.png")).convert("RGB").resize((W, H), Image.LANCZOS))
    psnr = lambda a, b: 10 * np.log10(255 ** 2 / max(1e-6, np.mean((a.astype(np.float32) - b.astype(np.float32)) ** 2)))  # noqa: E731
    p0 = [round(float(psnr(start, x[0])), 1) for x in (L, R) if x]
    mh = round(MEAS_W * H / W)
    gray = lambda im: cv2.cvtColor(cv2.resize(im, (MEAS_W, mh), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY)  # noqa: E731
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    k = W_OUT / MEAS_W                                     # px de mesure -> px de sortie

    # parallaxe signee : decalage du decor lointain moins celui du premier plan (masques par la profondeur de la photo,
    # pixels textures seulement : le flot des aplats est du bruit). Monotone avec la position de la camera.
    g0 = gray(start)
    d0 = depth.normalize(depth.raw(cv2.resize(start, (MEAS_W, mh), interpolation=cv2.INTER_AREA).astype(np.float32) / 255))
    gm = np.hypot(cv2.Sobel(g0, cv2.CV_32F, 1, 0), cv2.Sobel(g0, cv2.CV_32F, 0, 1))
    tex = gm > np.percentile(gm, 50)
    near = tex & (d0 >= np.percentile(d0, 70))
    far = tex & (d0 <= np.percentile(d0, 30))
    if far.sum() < 200:                                    # fond lisse (ciel, mur uni) : on garde tous ses pixels
        far = d0 <= np.percentile(d0, 30)
    if near.sum() < 200:
        near = d0 >= np.percentile(d0, 70)

    ax = 1 if (panel.get("camera") or {}).get("id") == "vertical" else 0      # arc vertical : decalage vertical

    def par(a, b):
        fx = dis.calc(a, b, None)[..., ax]
        pn = float(np.median(fx[near]))
        return float(np.median(fx[far])) - pn, pn

    def track(seq):
        """Parallaxe cumulee de chaque image depuis la photo, par images cles (le flot n'est fiable qu'a petit pas)."""
        key, s_key, p_key, out = g0, 0.0, 0.0, []
        for f in seq[1:]:
            g = gray(f)
            s, pn = par(key, g)
            out.append(((s_key + s) * k, abs(s_key + s) * k, f, (p_key + pn) * k))
            if abs(s) > 4:
                key, s_key, p_key = g, s_key + s, p_key + pn
        return out

    arcs = [track(L), track(R)]
    ends = [a[-1][0] if a else 0.0 for a in arcs]
    lim = SPREAD_MAX * W_OUT
    if ends[0] * ends[1] < 0:                              # deux sens opposes : la photo au milieu
        neg, pos = (arcs[0], arcs[1]) if ends[0] < 0 else (arcs[1], arcs[0])
        side = "deux"
    else:                                                  # H3 a tourne du meme cote les deux fois : le plus long arc
        best = max(arcs, key=lambda a: abs(a[-1][0]) if a else -1)
        neg, pos = (best, []) if best and best[-1][0] < 0 else ([], best)
        side = "un"
    keep = lambda a, sg: [c for c in a if c[0] * sg > 0 and c[1] <= lim]  # noqa: E731
    neg, pos = keep(neg, -1), keep(pos, 1)
    cand = sorted(neg + pos + [(0.0, 0.0, start, 0.0)], key=lambda c: c[0])
    s_all = np.array([c[0] for c in cand])
    sp_all = np.array([c[1] for c in cand])
    if len(cand) < 8:
        return f"{pid} {pan} : trop peu d'images utilisables ({len(cand)}), fins d'arcs {ends}"
    # vues a pas egaux de s, du bout gauche au bout droit ; repos = la photo si elle est entre les deux, sinon le milieu
    n = 2 * N_SIDE + 1
    targets = np.linspace(s_all.min(), s_all.max(), n)
    if side == "deux":
        targets = np.concatenate([np.linspace(s_all.min(), 0, N_SIDE + 1)[:-1], [0.0], np.linspace(0, s_all.max(), N_SIDE + 1)[1:]])
    picks = [int(np.argmin(np.abs(s_all - t))) for t in targets]
    out = store.pdir(pid) / "lytro" / pan
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*"):
        f.unlink()
    ho = round(W_OUT * H / W)
    views = []
    # couleur des images H3 recalee sur la photo (moyenne / ecart par canal en Lab : H3 assombrit de ~2 L*) : pas de
    # saut de teinte entre la photo au repos et sa premiere voisine
    ref_lab = cv2.cvtColor(start, cv2.COLOR_RGB2LAB).astype(np.float32)

    def match(im):
        lab = cv2.cvtColor(im, cv2.COLOR_RGB2LAB).astype(np.float32)
        for ch in range(3):
            a, b = lab[..., ch], ref_lab[..., ch]
            lab[..., ch] = (a - a.mean()) * (b.std() / max(1e-3, a.std())) + b.mean()
        return cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)

    # sujet epingle : chaque vue decalee de -p (deplacement du premier plan mesure), comme une orbite autour de lui ;
    # toutes les vues recadrees de la meme marge (le plus grand decalage + 2 px) puis remises a la largeur W_OUT
    pins = [cand[i][3] * W / W_OUT for i in picks]       # en px de la video
    mx = int(np.ceil(max(abs(x) for x in pins))) + 2
    mgy = round(mx * H / W)

    def pin(im, dpx):
        M = np.float32([[1, 0, -dpx if ax == 0 else 0], [0, 1, -dpx if ax == 1 else 0]])
        im = cv2.warpAffine(im, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        return im[mgy:H - mgy, mx:W - mx]

    for j, i in enumerate(picks):
        src_im = cand[i][2] if cand[i][2] is start else match(cand[i][2])
        im = cv2.resize(pin(src_im, pins[j]), (W_OUT, ho), interpolation=cv2.INTER_AREA)
        Image.fromarray(im).save(out / f"v{j:02d}.jpg", quality=90)
        views.append(im)
    # profondeur : Depth Anything V2 Small (processeur, ~1 s) par vue, meme echelle que la photo du milieu
    c = N_SIDE
    raws = [depth.raw(v.astype(np.float32) / 255) for v in views]
    for j, r in enumerate(raws):
        d = depth.normalize(r)                             # chaque vue sur ses centiles 1-99 (contenus presque egaux)
        Image.fromarray((d * 255 + 0.5).astype(np.uint8)).resize((W_OUT // 2, ho // 2), Image.BILINEAR).save(out / f"d{j:02d}.png")
    meta = {"n": len(picks), "center": c, "w": W_OUT, "h": ho, "src": [W, H], "sides": side, "axis": "y" if ax else "x", "pin": [round(x, 1) for x in pins], "crop": [mx, mgy], "ends": [round(float(e), 1) for e in ends],
            "s": [round(float(s_all[i]), 2) for i in picks], "spread": [round(float(sp_all[i]), 2) for i in picks],
            "psnr_first": p0, "frames": {"L": len(L), "R": len(R)},
            "range_all": [round(float(s_all.min()), 1), round(float(s_all.max()), 1)]}
    (out / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return (f"{pid} {pan} : {meta['n']} vues ({side} cote(s), fins {meta['ends']}), s {meta['s'][0]} .. {meta['s'][-1]} px, "
            f"relief max {max(meta['spread']):.1f} px, psnr image 0 / photo {p0}")


if __name__ == "__main__":
    pid = sys.argv[1]
    pans = sys.argv[2:] or sorted(store.get(pid)["panels"])
    for p in pans:
        print(build(pid, p), flush=True)
