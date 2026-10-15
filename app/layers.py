"""Relief en couches (« diorama ») : la case est decoupee en calques, comme un livre pop-up.

Pourquoi : une seule image tordue par une seule carte de profondeur se replie au bord des sujets (bords dedoubles) et
n'a rien a montrer derriere eux. Ici, chaque calque a sa propre profondeur, sans rupture, et c'est son alpha qui gere
qui cache quoi. Le lecteur dessine les calques du fond vers l'avant (player/alive-player.js).

Calcul (une tache « couches » de la file, sur un PC ComfyUI qui a Qwen-Image-Edit 2509, licence Apache-2.0) :
1. l'IA de l'app (si une cle est reglee) decrit les sujets de la case ; sinon prompts generiques ;
2. Qwen-Image-Edit, en un seul graphe : « fond vert » (tout sauf les sujets en vert pur -> masques automatiques),
   « plaque » (la scene sans les sujets) et, s'il y a des sujets devant et derriere, « avant » (sans le plus proche) ;
3. ici, sur le processeur (quelques secondes) : recalage des images generees sur la photo (ECC), masques doux,
   controle (un sujet que l'IA n'a pas retire reste dans le fond), couleurs du sujet sans lisere, profondeur de chaque
   calque (Depth Anything V2 Small) ramenee a l'echelle de la photo, pente bornee.
Au repos, l'image est celle de la photo : l'IA ne sert que DANS la place des sujets (composition, pas confiance).

Fichiers : projects/<id>/layers/<case>/ : raw/ (sorties Qwen), bg.jpg (fond sans les sujets), l1.webp et l2.webp
(sujets RGBA, du plus loin au plus proche), ld.png (profondeurs : R = fond, G = l1, B = l2, demi-resolution),
meta.json (n calques, profondeurs, plan net conseille, controles, prompts).
"""

import json
import time
from pathlib import Path

from . import depth, store

VERSION = 1
SIDE = "C"                     # tache « couches » dans la file de rendus
REMOVED = 0.08                 # ecart moyen minimal (0-1) pour dire qu'un sujet a bien ete retire d'une plaque
GENERIC = "the people, animals and main subjects standing in the foreground"


def folder(pid, panel_id):
    return store.path(pid, f"layers/{panel_id}")


def raw_path(pid, panel_id, key):
    return folder(pid, panel_id) / "raw" / f"{key}.png"


def meta(pid, panel_id):
    """meta.json des couches, ou None (absent, ancienne version, ou image de depart plus recente)."""
    f = folder(pid, panel_id) / "meta.json"
    src = store.path(pid, f"start/{panel_id}.png")
    try:
        m = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if m.get("v") != VERSION or not src.exists() or m.get("src", 0) + 1 < src.stat().st_mtime:
        return None
    return m


def used(panel):
    """Couches utilisees pour cette case ? Defaut : oui, sauf case validee en vert (jamais de changement automatique :
    il faut cocher « Utiliser les couches » dans l'apercu)."""
    panel = panel or {}
    return panel.get("couches", panel.get("review") != "ok") is not False


def ready(pid, panel_id):
    m = meta(pid, panel_id)
    return m if m and m.get("n", 0) > 0 else None


# ------------------------------------------------------------------ prompts
def _the(name):
    name = name.strip().rstrip(".")
    return name if name.split(" ", 1)[0].lower() in ("the", "a", "an", "his", "her", "their", "two", "three") else "the " + name


def _join(names):
    names = [_the(n) for n in names if n and n.strip()]
    if not names:
        return ""
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def describe(start):
    """Sujets de la case vus par l'IA de l'app : {"subjects": [{"name", "plane"}], "background", "style"} ou None."""
    from . import llm
    if not any(llm.available().values()):
        return None
    ask = ('This image is one panel of a comic page. We will cut it into layers like a pop-up book. List the subjects '
           'that stand clearly in front of the background: people, animals, creatures or vehicles only (never furniture, '
           'walls, plants or buildings), at most 3, the most important first. Name each one with a short precise visual '
           'description in English starting with "the" (clothes, colours, position in the frame), so that an image editor '
           'can find it; what a person holds or wears belongs to that person. Give its plane: "front" for the subjects '
           'closest to the camera, "back" for the subjects clearly further away, and its rough bounding box in percent of '
           'the image width and height: [left, top, right, bottom], generous rather than tight. Also describe in a few English words what '
           'is behind the subjects (the background to rebuild), and the style: "photo" or "drawing". If nothing stands out '
           'from the background (landscape, empty room, close-up texture), return an empty subject list. Answer with JSON '
           'only: {"subjects": [{"name": "the ...", "plane": "front", "box": [10, 5, 45, 100]}], "background": "...", '
           '"style": "photo"}')
    try:
        out = llm._json(llm.chat(ask, image=start, max_tokens=600, timeout=90))
    except Exception:                                   # noqa: BLE001 - l'IA est un plus, pas une condition
        return None
    if not isinstance(out, dict) or not isinstance(out.get("subjects"), list):
        return None
    def box(b):
        try:
            v = [float(x) for x in b][:4]
            if len(v) == 4 and max(v) <= 1.0:            # cadre donne en fractions et non en pourcents
                v = [x * 100 for x in v]
            v = [max(0.0, min(100.0, x)) for x in v]
            return v if len(v) == 4 and v[2] > v[0] and v[3] > v[1] else None
        except (TypeError, ValueError):
            return None
    subs = [{"name": str(x.get("name") or "").strip()[:160], "plane": "back" if x.get("plane") == "back" else "front",
             "box": box(x.get("box") or [])}
            for x in out["subjects"][:3] if isinstance(x, dict) and str(x.get("name") or "").strip()]
    return {"subjects": subs, "background": str(out.get("background") or "").strip()[:160],
            "style": "drawing" if out.get("style") == "drawing" else "photo"}


def passes(start, note=None):
    """[(cle, prompt, source)] pour Qwen-Image-Edit, plus la description. Epluchage : s'il y a des sujets devant et
    derriere, « front » retire ceux de devant, puis « plate » retire les autres DE CETTE IMAGE (prompts courts et
    precis : un prompt qui demande tout d'un coup en oublie). note : description deja connue (relance)."""
    info = note if note is not None else describe(start)
    if info is not None and not info["subjects"] and not info.get("generic"):
        return [], info                                 # l'IA ne voit aucun sujet detache : rien a calculer
    info = info or {"subjects": [], "background": "", "style": "photo", "generic": True}
    keep = "the framing, the perspective, the light, the colours and the grain"
    if info.get("style") == "drawing":
        keep += ", in the same drawing style and line weight"
    behind = f": {info['background']}" if info.get("background") else ""
    subs = [x["name"] for x in info["subjects"]]
    who = _join(subs) or GENERIC

    def remove(names, others=None, where=behind):
        k = f"including {others}, " if others else ""
        return (f"Remove {names}. Fill their place with what is behind them{where}, consistent with the rest of the image, "
                f"without adding any new person or object. Keep everything else exactly identical, {k}{keep}.")
    out = [("green", f"Replace everything except {who} by a flat pure green background (#00FF00), with no shadow: the "
                     f"floor, the walls, the furniture, the tables and every other object become green. Keep "
                     f"{who} exactly identical: same position, same size, same pose, same framing, with the clothes they "
                     f"wear and what they hold in their hands.", None)]
    if not subs:                                        # sans description : le plus proche, puis tous les autres
        out += [("front", remove("only the person or subject closest to the camera", "the other people further away", ""),
                 None),
                ("plate", remove("all the remaining people and animals"), "front")]
        return out, info
    # un sujet par passe (une demande groupee en oublie) : ceux de devant d'abord, chaque passe repart de la precedente
    order = [x for x in info["subjects"] if x["plane"] == "front"] + [x for x in info["subjects"] if x["plane"] == "back"]
    nfront = sum(1 for x in order if x["plane"] == "front")
    src = None
    for i, x in enumerate(order):
        last = i == len(order) - 1
        key = "plate" if last else ("front" if i == nfront - 1 else f"r{i + 1}")
        rest = _join([y["name"] for y in order[i + 1:]]) or None
        out.append((key, remove(_the(x["name"]), rest, behind if last else ""), src))
        src = key
    return out, info


# ------------------------------------------------------------------ outils image
def _load(path, size):
    import numpy as np
    from PIL import Image
    im = Image.open(path).convert("RGB")
    if im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im, np.float32) / 255


def _blur(x, sg):
    """Flou gaussien ; les grands rayons sont calcules en quart de resolution (meme resultat, 16 fois moins cher)."""
    import cv2
    if sg < 8:
        return cv2.GaussianBlur(x, (0, 0), sg)
    h, w = x.shape[:2]
    small = cv2.resize(x, (max(1, w // 4), max(1, h // 4)), interpolation=cv2.INTER_AREA)
    return cv2.resize(cv2.GaussianBlur(small, (0, 0), sg / 4), (w, h), interpolation=cv2.INTER_LINEAR)


def _align(ref, mov, roi=None):
    """Recale mov sur ref (affine, ECC sur la zone roi) : les modeles d'edition decalent l'image de quelques pixels.
    Estimation en demi-resolution, image recalee en pleine resolution."""
    import cv2
    import numpy as np
    h, w = ref.shape[:2]
    k = 0.5 if w > 700 else 1.0
    sm = lambda x, it=cv2.INTER_AREA: x if k == 1 else cv2.resize(x, (round(w * k), round(h * k)), interpolation=it)  # noqa: E731
    g1, g2 = cv2.cvtColor(sm(ref), cv2.COLOR_RGB2GRAY), cv2.cvtColor(sm(mov), cv2.COLOR_RGB2GRAY)
    m = np.eye(2, 3, dtype=np.float32)
    mask = None if roi is None else (sm(roi.astype(np.float32), cv2.INTER_NEAREST) * 255).astype(np.uint8)
    try:
        _, m = cv2.findTransformECC(g1, g2, m, cv2.MOTION_AFFINE,
                                    (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 150, 1e-6), mask, 5)
    except cv2.error:
        return mov, None
    m[:, 2] /= k
    corners = np.array([[0, 0, 1], [w, 0, 1], [0, h, 1], [w, h, 1]], np.float32) @ m.T - [[0, 0], [w, 0], [0, h], [w, h]]
    if np.abs(m[:, :2] - np.eye(2)).max() > 0.04 or np.abs(corners).max() > 0.03 * w:
        return mov, None                                  # recalage invraisemblable : on garde l'image telle quelle
    out = cv2.warpAffine(mov, m, (w, h), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return np.clip(out, 0, 1), m


def _color_match(ref, mov, keep):
    import numpy as np
    if keep.sum() < 500:
        return mov
    out = mov.copy()
    for c in range(3):
        a, b = ref[..., c][keep], mov[..., c][keep]
        out[..., c] = (mov[..., c] - b.mean()) * (a.std() / max(1e-6, b.std())) + a.mean()
    return np.clip(out, 0, 1)


def _guided(rgb, p, r=6, eps=1e-3):
    """Filtre guide (He et al.) : un masque suit les bords de l'image (cheveux, contours)."""
    import cv2
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    mean = lambda x: cv2.boxFilter(x, -1, (r, r))     # noqa: E731
    mI, mp = mean(g), mean(p)
    a = (mean(g * p) - mI * mp) / (mean(g * g) - mI * mI + eps)
    return (mean(a) * g + mean(mp - a * mI)).clip(0, 1)


def _grow(a, px):
    """Zone a remplacer par la plaque : le sujet (alpha > 0,02) elargi de px, bord adouci."""
    import cv2
    import numpy as np
    k = max(3, int(px) * 2 + 1)
    hard = cv2.dilate((a > 0.02).astype(np.float32), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    return cv2.GaussianBlur(hard, (0, 0), max(1.0, px / 3)).clip(0, 1)


def _fill_plate(im, P, hole):
    """Fond = la photo partout ou elle est visible ; la plaque IA seulement sous le sujet (hole = 1), corrigee pour
    continuer la lumiere de la photo : le rapport de luminosite photo / plaque mesure autour du sujet (ombre portee au
    sol effacee par l'IA) est prolonge sous lui. Luminosite seule (pas de teinte) et mesure a distance du bord du sujet,
    ou la photo melange encore un peu sa couleur."""
    import cv2
    import numpy as np
    eps = 4 / 255
    near = (hole > 0.01).astype(np.uint8)
    ring = ((cv2.dilate(near, np.ones((41, 41), np.uint8)) > 0) & ~(cv2.dilate(near, np.ones((11, 11), np.uint8)) > 0))
    ring = ring.astype(np.float32)
    lum = lambda x: cv2.GaussianBlur(x.mean(axis=2), (0, 0), 2)    # noqa: E731
    lr = np.log(lum(im) + eps) - np.log(lum(P) + eps)
    out = np.zeros_like(lr)
    done = np.zeros(hole.shape, bool)
    for sg in (4, 8, 16, 32, 64, 128):                   # prolongement par convolution normalisee, du plus fin au plus large
        num = _blur(lr * ring, sg)
        den = _blur(ring, sg)
        ok = (den > 0.05) & ~done
        out[ok] = num[ok] / den[ok]
        done |= ok
    corr = np.exp(np.clip(cv2.GaussianBlur(out, (0, 0), 4), -0.6, 0.6))
    Pc = np.clip(P * corr[..., None], 0, 1)
    return im * (1 - hole[..., None]) + Pc * hole[..., None]


def _decontam(img, a, bg):
    """Couleur du sujet sans le fond melange dans ses bords : I = aF + (1 - a)B, avec B connu."""
    import numpy as np
    aa = np.clip(a, 0.05, 1)[..., None]
    return np.clip((img - (1 - aa) * bg) / aa, 0, 1)


def _extend(F, a):
    """Couleurs prolongees sous l'alpha nul (le filtrage du lecteur ne ramene pas de noir au bord du sujet)."""
    import cv2
    import numpy as np
    core = (a > 0.5).astype(np.float32)
    out = np.zeros_like(F)
    done = np.zeros(a.shape, bool)
    for s in (2, 4, 8, 16, 32, 64, 128):
        num = _blur(F * core[..., None], s)
        den = _blur(core, s)
        ok = (den > 0.02) & ~done
        out[ok] = num[ok] / den[ok][:, None]
        done |= ok
    if (~done).any():
        out[~done] = F[core > 0].mean(axis=0) if core.any() else 0.5
    k = np.clip((a - 0.05) / 0.35, 0, 1)[..., None]      # bords tres transparents : couleur du coeur, sans bruit
    return out * (1 - k) + F * k


def _subject_depth(d, a_core, a_full=None):
    """Profondeur d'un sujet : sa carte lissee dans la silhouette, prolongee tout autour (bord stable au rendu)."""
    import cv2
    import numpy as np
    inside = (a_core > 0.5).astype(np.float32)
    if inside.sum() < 10:
        return np.zeros_like(d)
    ds = cv2.GaussianBlur(d * inside, (0, 0), 6)
    w = cv2.GaussianBlur(inside, (0, 0), 6)
    ds = np.where(w > 1e-3, ds / np.maximum(w, 1e-3), 0).astype(np.float32)
    med = float(np.median(ds[inside > 0]))
    # un sujet bouge d'un bloc, comme une carte de pop-up a peine bombee : la profondeur estimee a l'interieur d'une
    # personne est peu fiable (un pli de cape « plus loin » que le corps dechirerait le calque)
    ds = med + 0.25 * (cv2.GaussianBlur(ds, (0, 0), 10) - med)
    # prolongement (hors du sujet et sous sa partie cachee) : valeur du pixel du sujet le plus proche
    have = inside > 0
    _, near = cv2.distanceTransformWithLabels((~have).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    filled = ds[have][np.clip(near - 1, 0, have.sum() - 1)]
    filled[have] = ds[have]
    del a_full
    return depth.bound_slope(cv2.GaussianBlur(filled.astype(np.float32), (0, 0), 3))


def _fit_depth(d_plate, d_ref, keep):
    """Profondeur d'une plaque ramenee a l'echelle de la photo (echelle + decalage, sur les pixels inchanges)."""
    import numpy as np
    x, y = d_plate[keep].ravel(), d_ref[keep].ravel()
    if x.size < 500:
        return depth.normalize(d_plate)
    A = np.stack([x, np.ones_like(x)], 1)
    (s, t), *_ = np.linalg.lstsq(A, y, rcond=None)
    return np.clip(d_plate * s + t, 0, 1).astype(np.float32)


def _chroma(G):
    """Alpha du sujet sur l'image « fond vert » : distance a la couleur du fond vert mesuree dans l'image (et non la
    « verdeur » : Qwen teinte parfois un vetement blanc en vert pale, qui doit rester du sujet ; et son vert est parfois
    terne, vers (0,35 ; 0,6 ; 0,3)). La couleur est estimee sur le vert franc, a defaut sur les bords de l'image, puis
    affinee sur les pixels proches : un vetement kaki ou vert olive ne la tire pas vers lui."""
    import numpy as np
    g = G[..., 1] - np.maximum(G[..., 0], G[..., 2])
    strong = (g > 0.2) & (G[..., 1] > 0.3)
    border = np.concatenate([G[:8].reshape(-1, 3), G[-8:].reshape(-1, 3), G[:, :8].reshape(-1, 3), G[:, -8:].reshape(-1, 3)])
    bgreen = border[(border[:, 1] - np.maximum(border[:, 0], border[:, 2])) > 0.08]
    if strong.sum() >= 0.05 * g.size:
        key = np.median(G[strong], axis=0)
    elif len(bgreen) >= 200:
        key = np.median(bgreen, axis=0)
    else:
        wide = (g > 0.12) & (G[..., 1] > 0.3)
        key = np.median(G[wide], axis=0) if wide.sum() >= 0.05 * g.size else np.array([0.0, 1.0, 0.0], np.float32)
    near = np.sqrt(((G - key) ** 2).sum(axis=2)) < 0.15
    if near.sum() >= 0.05 * g.size:
        key = np.median(G[near], axis=0)
    dist = np.sqrt(((G - key) ** 2).sum(axis=2))
    return np.clip((dist - 0.12) / 0.18, 0, 1).astype(np.float32)


def _clean(mask, W, H):
    """Masque binaire : composantes minuscules retirees, petits trous bouches."""
    import cv2
    import numpy as np
    m = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    keep = np.zeros_like(m)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] >= 0.003 * W * H:
            keep[lab == i] = 1
    n, lab, st, _ = cv2.connectedComponentsWithStats(1 - keep)
    for i in range(1, n):                               # trous : composantes de fond qui ne touchent pas le bord
        x, y, w, h, area = st[i]
        if area < 0.0015 * W * H and x > 0 and y > 0 and x + w < W and y + h < H:
            keep[lab == i] = 1
    return keep


def _soft(rgb, mask):
    """Masque binaire -> alpha doux qui suit les bords de l'image."""
    import numpy as np
    return np.clip((_guided(rgb, mask.astype(np.float32)) - 0.2) / 0.6, 0, 1)


def _removed(im, Q, within, W, H):
    """Partie de la zone des sujets que l'IA a vraiment effacee dans Q (deja recalee). On ne cherche pas la preuve de
    l'effacement (une cape blanche unie devant un mur clair change a peine) mais la preuve du contraire : des zones
    nettement IDENTIQUES a la photo (meme structure, meme couleur), assez grandes pour etre un sujet laisse par l'IA ou un
    objet garde par le « fond vert » (table, cabine). Tout le reste de la zone compte comme efface."""
    import cv2
    import numpy as np
    zone = within.astype(bool)
    # comparaison a l'echelle des formes (flou de 4 px) : un objet que l'IA a seulement redessine (paille, chemise, decor
    # legerement decale) garde ses formes et ses couleurs ; une personne retiree laisse place a tout autre chose
    a = cv2.GaussianBlur(cv2.cvtColor(im, cv2.COLOR_RGB2GRAY), (0, 0), 4)
    b = cv2.GaussianBlur(cv2.cvtColor(Q, cv2.COLOR_RGB2GRAY), (0, 0), 4)
    mu = lambda x: cv2.GaussianBlur(x, (0, 0), 8)       # noqa: E731
    ma, mb = mu(a), mu(b)
    va, vb = mu(a * a) - ma * ma, mu(b * b) - mb * mb
    ncc = (mu(a * b) - ma * mb) / np.sqrt(np.maximum(va * vb, 1e-8))
    textured = np.minimum(va, vb) > 1e-4
    diff = np.abs(cv2.GaussianBlur(Q, (0, 0), 4) - cv2.GaussianBlur(im, (0, 0), 4)).max(axis=2)
    same = np.where(textured, (ncc > 0.6) & (diff < 0.2), diff < 0.06) & zone
    same = cv2.morphologyEx(same.astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(same)
    kept = np.zeros(same.shape, bool)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] >= 0.004 * W * H:     # un vrai morceau garde, pas des taches de ressemblance
            kept |= lab == i
    kept = cv2.dilate(kept.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))) > 0
    return zone & ~kept


def _recover(im, Q, hard, d_im, W, H):
    """Sujets que le « fond vert » a oublies mais qu'une passe d'effacement a retires : grandes zones nettement changees
    (au moins 1 % de la case), loin des sujets deja trouves, et plus proches que ce qui les entoure (un mur redessine
    par l'IA ne passe pas ce test)."""
    import cv2
    import numpy as np
    diff = np.abs(cv2.GaussianBlur(Q, (0, 0), 3) - cv2.GaussianBlur(im, (0, 0), 3)).max(axis=2)
    cand = (diff > 0.15) & ~(cv2.dilate(hard, np.ones((15, 15), np.uint8)) > 0)
    cand = cv2.morphologyEx(cand.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
    cand = cv2.morphologyEx(cand, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(cand)
    out = np.zeros(hard.shape, bool)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] < 0.01 * W * H:
            continue
        m = np.zeros(hard.shape, np.uint8)
        cnts, _ = cv2.findContours((lab == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(m, cnts, -1, 1, -1)
        ring = (cv2.dilate(m, np.ones((31, 31), np.uint8)) > 0) & (m == 0)
        if ring.any() and np.median(d_im[m > 0]) > np.median(d_im[ring]) + 0.08:
            out |= m > 0
    return out


def _gate(info, W, H):
    """Masque des cadres des sujets decrits par l'IA (elargis de 4 %), ou None (pas de cadres : pas de filtre)."""
    import numpy as np
    subs = (info or {}).get("subjects") or []
    if not subs or any(not x.get("box") for x in subs):   # un sujet sans cadre : on ne filtre pas (il serait ecarte)
        return None
    boxes = [x["box"] for x in subs]
    g = np.zeros((H, W), bool)
    for x0, y0, x1, y1 in boxes:
        g[max(0, int((y0 - 4) * H / 100)):min(H, int((y1 + 4) * H / 100) + 1),
          max(0, int((x0 - 4) * W / 100)):min(W, int((x1 + 4) * W / 100) + 1)] = True
    return g


def _keep_in(mask, gate, frac=0.3):
    """Composantes du masque dont au moins frac de la surface est dans les cadres (toutes si pas de cadres)."""
    import cv2
    import numpy as np
    if gate is None or not mask.any():
        return mask
    n, lab = cv2.connectedComponents(mask.astype(np.uint8))
    out = np.zeros_like(mask)
    for i in range(1, n):
        m = lab == i
        if gate[m].mean() >= frac:
            out[m] = 1
    return out


# ------------------------------------------------------------------ construction des calques
def build(pid, panel_id, spec=None):
    """Sorties Qwen (raw/) -> calques. Renvoie meta (n = 0 et reason si la case ne se decoupe pas)."""
    import cv2
    import numpy as np
    from PIL import Image
    t0 = time.time()
    spec = spec or {}
    d = folder(pid, panel_id)
    src = store.path(pid, f"start/{panel_id}.png")
    im = np.asarray(Image.open(src).convert("RGB"), np.float32) / 255
    H, W = im.shape[:2]
    base = {"v": VERSION, "size": [W, H], "src": src.stat().st_mtime, "created": time.time(),
            "seed": spec.get("seed"), "info": spec.get("info"), "worker": spec.get("worker")}

    def give_up(reason, final=False, **qc):
        m = dict(base, n=0, reason=reason, qc=qc, seconds=round(time.time() - t0, 1))
        old = None if final else ready(pid, panel_id)   # verdict definitif (foule) : pas d'anciennes couches gardees
        if old and files(pid, panel_id):                  # un nouvel essai rate ne jette pas des couches qui marchaient
            m = dict(old, last_try={"reason": reason, "created": m["created"], "seed": m.get("seed")})
        d.mkdir(parents=True, exist_ok=True)
        (d / "meta.json").write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
        return m

    if spec.get("src_mtime") and abs(src.stat().st_mtime - float(spec["src_mtime"])) > 1:
        return give_up("l'image de la case a changé pendant le calcul : relancer")
    if spec.get("skip"):
        return give_up("l'IA ne voit aucun sujet détaché du fond")
    if not raw_path(pid, panel_id, "green").exists() or not raw_path(pid, panel_id, "plate").exists():
        return give_up("sorties de l'IA manquantes")
    raw_im = depth.raw(im)
    d_im = depth.normalize(raw_im)

    # 1) masques : l'image « fond vert », recalee sur la photo par la zone du sujet
    G = _load(raw_path(pid, panel_id, "green"), (W, H))
    hard = _clean(_chroma(G) > 0.5, W, H)
    cover = float(hard.mean())
    if cover < 0.01:
        return give_up("aucun sujet détaché du fond (paysage, gros plan…)", cover=round(cover, 3))
    if cover > 0.8:
        return give_up("l'IA n'a pas remplacé le fond par du vert", cover=round(cover, 3))
    G, mG = _align(im, G, cv2.erode(hard, np.ones((11, 11), np.uint8)).astype(np.float32))   # sans le bord
    key = _chroma(G)
    hard = _clean(key > 0.5, W, H)
    # creux de la silhouette ou le « fond vert » garde une trace de sujet (vetement clair rendu translucide par l'IA) :
    # combles ; un vrai interstice (entre le bras et le corps) est vert pur et reste ouvert
    hard = _clean((hard > 0) | ((cv2.morphologyEx(hard, cv2.MORPH_CLOSE, cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (41, 41))) > 0) & (key > 0.12)), W, H)
    # seules les silhouettes qui recouvrent le cadre d'un sujet demande comptent : quelqu'un que Qwen a garde de lui-meme
    # dans le « fond vert » (puis redessine dans la plaque) reste dans le decor, sinon il serait en double
    gate = _gate(spec.get("info"), W, H)
    pre = hard.copy()                                     # avant filtre : ce qui est ecarte ne doit jamais revenir
    hard = _keep_in(hard, gate)
    dropped = cv2.dilate(((pre > 0) & (hard == 0)).astype(np.uint8), np.ones((15, 15), np.uint8)) > 0
    if not hard.any():
        return give_up("l'IA n'a pas détouré les sujets demandés", cover=round(cover, 3))
    soft = cv2.erode(_soft(im, hard), np.ones((3, 3), np.uint8))   # bord ronge d'un pixel : le fond y deborde toujours
    green = np.clip((soft - 0.12) / 0.76, 0, 1)

    # 2) plaque recalee sur ce qui n'a pas change ; seul ce que l'IA a vraiment efface devient un calque
    margin = max(6, round(0.012 * W))
    M = _grow(green, margin)
    P = _load(raw_path(pid, panel_id, "plate"), (W, H))
    P, _ = _align(im, P, (M < 0.01).astype(np.float32))
    P = _color_match(im, P, M < 0.01)
    # sujet entier oublie par le « fond vert » (ca arrive) mais efface par une passe : on le rattrape
    found = _recover(im, P, pre, d_im, W, H)
    if raw_path(pid, panel_id, "front").exists():
        F0, _ = _align(im, _load(raw_path(pid, panel_id, "front"), (W, H)), (M < 0.01).astype(np.float32))
        found |= _recover(im, _color_match(im, F0, M < 0.01), pre, d_im, W, H)
    found = (_keep_in(found.astype(np.uint8), gate) > 0) & ~dropped
    if found.any():
        hard = (hard | found).astype(np.uint8)
        green = np.maximum(green, _soft(im, found))
    # ce que la plaque a nettement efface juste autour d'un sujet, mais que le « fond vert » a manque (pli de cape teinte
    # en vert par l'IA…) : c'est du sujet ; sinon ce morceau resterait colle au fond et se detacherait en mouvement
    chg = (np.abs(cv2.GaussianBlur(P, (0, 0), 3) - cv2.GaussianBlur(im, (0, 0), 3)).max(axis=2) > 0.15) & (hard == 0) & ~dropped \
        & (cv2.dilate(hard, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61, 61))) > 0)
    chg = cv2.morphologyEx(chg.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    if chg.any():
        nl, ll = cv2.connectedComponents(((chg > 0) | (hard > 0)).astype(np.uint8))
        touch = [i for i in np.unique(ll[hard > 0]) if i]
        extra = np.isin(ll, touch) & (chg > 0)
        # ... et a la profondeur du sujet voisin (un coin de table redessine par l'IA n'en fait pas partie)
        nh, lh = cv2.connectedComponents(hard)
        zc = np.array([0.0] + [float(np.median(d_im[lh == i])) for i in range(1, nh)], np.float32)
        _, near = cv2.distanceTransformWithLabels((hard == 0).astype(np.uint8), cv2.DIST_L2, 5,
                                                  labelType=cv2.DIST_LABEL_PIXEL)
        owner = lh[hard > 0][np.clip(near - 1, 0, int((hard > 0).sum()) - 1)]
        extra &= np.abs(d_im - zc[owner]) < 0.15
        hard = (hard | extra).astype(np.uint8)
        green = np.maximum(green, _soft(im, extra))
    remP = _removed(im, P, hard, W, H)
    # dans une meme silhouette « fond vert » (ex. une femme dans une cabine), un morceau efface bien plus petit que le
    # sujet principal est un objet redessine par l'IA (enseigne, reflet) : il reste dans le fond
    ng, lg = cv2.connectedComponents(hard)
    nr, lr_, sr, _ = cv2.connectedComponentsWithStats(remP.astype(np.uint8))
    for g in range(1, ng):
        ids = [i for i in np.unique(lr_[(lg == g) & remP]) if i]
        if ids:
            big = max(sr[i, cv2.CC_STAT_AREA] for i in ids)
            for i in ids:
                if sr[i, cv2.CC_STAT_AREA] < 0.2 * big:
                    remP[lr_ == i] = False
    alpha = green * _soft(im, cv2.dilate(remP.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0)
    n0, lab0, st0, _ = cv2.connectedComponentsWithStats(hard)
    qc_green = [{"area": round(float(st0[i, cv2.CC_STAT_AREA]) / (W * H), 4),
                 "removed": round(float(remP[lab0 == i].mean()), 3)} for i in range(1, n0)
                if st0[i, cv2.CC_STAT_AREA] >= 0.003 * W * H]
    hard2 = _clean(alpha > 0.5, W, H)
    # petits creux et encoches dans une silhouette : combles (sinon un morceau du sujet reste fige dans le fond)
    # ... a la profondeur du sujet (un vrai jour entre le bras et le corps montre le fond, bien plus loin : il reste ouvert)
    closed = cv2.morphologyEx(hard2, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
    gap = (closed > 0) & (hard2 == 0)
    if gap.any():
        nh, lh = cv2.connectedComponents(hard2)
        zc = np.array([0.0] + [float(np.median(d_im[lh == i])) for i in range(1, nh)], np.float32)
        _, near = cv2.distanceTransformWithLabels((hard2 == 0).astype(np.uint8), cv2.DIST_L2, 5,
                                                  labelType=cv2.DIST_LABEL_PIXEL)
        owner = lh[hard2 > 0][np.clip(near - 1, 0, int((hard2 > 0).sum()) - 1)]
        gap &= np.abs(cv2.GaussianBlur(d_im, (0, 0), 3) - zc[owner]) < 0.12
        closed = ((hard2 > 0) | gap).astype(np.uint8)
        alpha = np.maximum(alpha, _soft(im, closed) * gap)
    hard2 = _clean(alpha > 0.5, W, H)
    alpha *= cv2.dilate(hard2, np.ones((9, 9), np.uint8)) > 0       # miettes retirees
    n, lab, st, _ = cv2.connectedComponentsWithStats(hard2)
    comps = [{"id": i, "z": float(np.median(d_im[lab == i])), "area": round(float(st[i, cv2.CC_STAT_AREA]) / (W * H), 4)}
             for i in range(1, n)]
    if not comps:
        return give_up("l'IA n'a pas retiré les sujets de la case", cover=round(cover, 3), green=qc_green)
    comps.sort(key=lambda c: -c["z"])                     # du plus proche au plus loin
    fill = float((hard2 > 0).mean())
    if fill > 0.45:                                      # mesure : bonnes cases 0,14-0,37 ; foules 0,54-0,62
        return give_up("foule ou gros plan : les sujets couvrent la moitié de la case ou presque, la nappe simple convient mieux", True,
                       cover=round(cover, 3), subjects=round(fill, 3), green=qc_green)
    M = _grow(alpha, margin)
    edge = max(4, round(0.008 * W))                       # le bord du sujet ne doit pas rester dans le fond
    hole = _grow(alpha, edge)                             # sous le sujet et son halo : la seule zone inventee
    bg = _fill_plate(im, P, hole)

    # 3) devant / derriere : ce que la passe « avant » a efface (pixel par pixel), sinon l'ecart de profondeur
    a_front, a_back, F, how = alpha, None, None, "un seul plan"
    if raw_path(pid, panel_id, "front").exists():
        F = _load(raw_path(pid, panel_id, "front"), (W, H))
        F, _ = _align(im, F, (M < 0.01).astype(np.float32))
        F = _color_match(im, F, M < 0.01)
        remF = _removed(im, F, hard2, W, H)
        rest = (hard2 > 0) & ~remF
        if remF.any() and rest.any():                    # coherence : « devant » = plus proche des sujets de devant
            ds = cv2.GaussianBlur(d_im, (0, 0), 3)
            zf, zb = float(np.median(ds[remF])), float(np.median(ds[rest]))
            nf, lf = cv2.connectedComponents(remF.astype(np.uint8))     # par morceau : un chapeau reste a son porteur
            for i in range(1, nf):
                zi = float(np.median(ds[lf == i]))
                if abs(zi - zf) >= abs(zi - zb):
                    remF[lf == i] = False
        fa = alpha * _soft(im, cv2.dilate(remF.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0)
        ba_hard =_clean(cv2.morphologyEx((np.clip(alpha - fa, 0, 1) > 0.5).astype(np.uint8), cv2.MORPH_OPEN,
                                          np.ones((5, 5), np.uint8)), W, H)
        ba = np.clip(alpha - fa, 0, 1) * (cv2.dilate(ba_hard, np.ones((7, 7), np.uint8)) > 0)
        fa_hard = (fa > 0.5).astype(np.uint8)
        solid = cv2.morphologyEx(fa_hard, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13)))
        # un vrai sujet de devant est massif : des bandes fines (bord d'un objet redessine par l'IA) ne font pas un calque
        if fa_hard.mean() > 0.005 and solid.sum() > 0.5 * fa_hard.sum() and ba_hard.mean() > 0.002 \
                and np.median(d_im[fa > 0.5]) > np.median(d_im[ba_hard > 0]) + 0.12:   # sinon : meme parallaxe, un calque
            a_front, a_back, how = fa, ba, "IA (passe avant)"
        else:
            F = None
    if a_back is None and len(comps) > 1:
        zs = [c["z"] for c in comps]
        gaps = [zs[i] - zs[i + 1] for i in range(len(zs) - 1)]
        k = int(np.argmax(gaps))
        if gaps[k] > 0.12:
            near = lambda cs: cv2.dilate(np.isin(lab, [c["id"] for c in cs]).astype(np.uint8),   # noqa: E731
                                         np.ones((15, 15), np.uint8)) > 0
            a_front, a_back, how = alpha * near(comps[:k + 1]), alpha * near(comps[k + 1:]), "profondeur"
    layers = []                                           # (couleur, alpha, profondeur), du plus loin au plus proche
    if a_back is not None:
        MF = _grow(a_front, margin)
        if F is not None:                                 # ce que cache le sujet de devant : vu par l'IA
            SB = _fill_plate(im, F, _grow(a_front, edge))
            hid = (np.abs(SB - bg).max(axis=2) > 0.10) & (MF > 0.5)
            hid = cv2.morphologyEx(hid.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
            u = ((a_back > 0.5) | (hid > 0)).astype(np.uint8)
            nn, ll = cv2.connectedComponents(u)
            touch = set(np.unique(ll[a_back > 0.5])) - {0}
            ext = np.isin(ll, list(touch)) & (hid > 0)
            a_back_full = np.maximum(a_back, _soft(SB, ext) * (MF > 0.5))
        else:
            SB, a_back_full = im, a_back
        FB = _extend(_decontam(SB, a_back_full, bg), a_back_full)
        layers.append((FB, a_back_full, _subject_depth(d_im, a_back, a_back_full)))
        FF = _extend(_decontam(im, a_front, SB), a_front)
    else:
        FF = _extend(_decontam(im, a_front, bg), a_front)
    layers.append((FF, a_front, _subject_depth(d_im, a_front)))

    # 4) profondeur du fond : calculee sur la plaque, a l'echelle de la photo, jamais devant les sujets
    d_bg = _fit_depth(depth.raw(bg), d_im, M < 0.01)       # M (plus large) : pixels surs, loin des sujets
    for _, a, dz in layers:
        inside = _grow(a, margin) > 0.5
        d_bg[inside] = np.minimum(d_bg[inside], dz[inside] - 0.03)
    d_bg = depth.bound_slope(depth.smooth_edges(np.clip(d_bg, 0, 1), bg))

    # 5) fichiers
    d.mkdir(parents=True, exist_ok=True)
    u8 = lambda x: (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)   # noqa: E731
    Image.fromarray(u8(bg)).save(d / "bg.jpg", "JPEG", quality=90)
    for i, (Fi, ai, _) in enumerate(layers, 1):
        Image.fromarray(np.dstack([u8(Fi), u8(ai)])).save(d / f"l{i}.webp", "WEBP", quality=90, exact=True,
                                                                    method=4)
    for old in d.glob("l*.webp"):
        if old.stem not in {f"l{i}" for i in range(1, len(layers) + 1)}:
            old.unlink()
    zero = np.zeros((H, W), np.float32)
    maps = [d_bg] + [x[2] for x in layers] + [zero] * (2 - len(layers))
    ld = Image.fromarray(np.dstack([u8(x) for x in maps[:3]]))
    ld.resize((max(2, W // 2), max(2, H // 2)), Image.BILINEAR).save(d / "ld.png", optimize=True)
    zs = [round(float(np.median(d_bg[M > 0.5])) if (M > 0.5).any() else float(np.median(d_bg)), 3)]
    zs += [round(float(np.median(x[2][x[1] > 0.5])), 3) for x in layers]
    m = dict(base, n=len(layers), z=zs, focus=zs[-1], groups=how,
             qc={"cover": round(cover, 3), "green": qc_green, "subjects": [{"z": round(c["z"], 3), "area": c["area"]}
                                                                          for c in comps],
                 "aligned": mG is not None},
             seconds=round(time.time() - t0, 1))
    (d / "meta.json").write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    return m


def files(pid, panel_id):
    """Fichiers des couches prets pour l'export : {"bg", "fg": [..], "ld"} (chemins absolus), ou None."""
    m = ready(pid, panel_id)
    if not m:
        return None
    d = folder(pid, panel_id)
    out = {"bg": d / "bg.jpg", "fg": [d / f"l{i}.webp" for i in range(1, m["n"] + 1)], "ld": d / "ld.png", "meta": m}
    if not all(p.exists() for p in [out["bg"], out["ld"], *out["fg"]]):
        return None
    return out
