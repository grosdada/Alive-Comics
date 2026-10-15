"""Relief en couches (« diorama ») : la case est decoupee en calques, comme un livre pop-up.

Pourquoi : une seule image tordue par une seule carte de profondeur se replie au bord des sujets (bords dedoubles) et
n'a rien a montrer derriere eux. Ici, chaque calque a sa propre profondeur, sans rupture, et c'est son alpha qui gere
qui cache quoi. Le lecteur dessine les calques du fond vers l'avant (player/alive-player.js).

Version 2 (detourage de precision) : une tache « couches » de la file, sur un PC ComfyUI qui a SAM 3.1, BiRefNet et
Qwen-Image-Edit 2509 (voir docs/INSTALL-MODELES-RELIEF.md) :
1. ComfyUI : SAM 3.1 (« person ») donne un masque exact par personne ; BiRefNet donne le bord doux (cheveux) et les
   objets tenus (une valise accrochee a la main appartient a la personne).
2. Ici : profondeur de la photo (Depth Pro d'Apple si present, sinon Depth Anything V2 Small). Sujets = les personnes
   assez grandes ; foule (sujets sur plus de 45 % de la case) : seulement le premier plan net (les plus proches, bien
   separes du reste en profondeur), le reste de la foule reste dans le decor ; aucun premier plan net : nappe simple.
3. Une forme neutre (magenta) est peinte a la place des sujets : forme convexe (peinte en silhouette, Qwen redessinait
   des jambes ou des gens) ; foule : silhouette elargie et arrondie, Qwen y prolonge les gens de derriere.
4. ComfyUI : Qwen-Image-Edit remplit la forme avec le decor cache, et SAM 3.1 controle la plaque dans le meme graphe :
   une personne inventee dans la forme (pas une personne de la photo prolongee) -> autre graine, puis LaMa (flou mais
   sans invention).
5. Ici : groupes devant / derriere par ecart de profondeur, plaque recalee, lumiere prolongee sous les sujets, couleurs
   des sujets sans lisere, sujets en cartes a peine bombees, profondeur du fond calculee sur la plaque.
Au repos, l'image est celle de la photo : l'IA ne sert que DANS la place des sujets.

Fichiers : projects/<id>/layers/<case>/ : raw/ (sam_XX.png, birefnet.png, depth.npy, painted.png, plate.png), bg.jpg (fond sans
les sujets), l1.webp et l2.webp (sujets RGBA, du plus loin au plus proche), ld.png (profondeurs : R = fond, G = l1,
B = l2, demi-resolution), meta.json (n calques, profondeurs, plan net conseille, controles).
"""

import json
import time

from . import depth, store

VERSION = 2
SIDE = "C"                     # tache « couches » dans la file de rendus
SAM_PROMPT = "person:20"       # SAM 3.1 : jusqu'a 20 personnes, un masque chacune
MIN_AREA = 0.004               # un sujet couvre au moins 0,4 % de la case (les silhouettes lointaines restent au decor)
CROWD = 0.45                   # mesure : bonnes cases 14-37 % de sujets, foules 54-67 %
FRONT_MAX = 0.35               # foule : premier plan detache sur 35 % de la case au plus...
FRONT_GAP = 0.08               # ... et seulement s'il est net (ecart de profondeur avec la personne suivante)
FILL_PROMPT = ("Fill the magenta area with the background that is hidden behind it: continue the walls, the floor and "
               "the scenery around it, so that the magenta area disappears completely. The area must contain only empty "
               "scenery, no person, no body part, no clothes, no animal. Keep everything else exactly identical: the "
               "framing, the perspective, the light, the colours and the grain.")
FILL_PROMPT_CROWD = ("Fill the magenta area with what is hidden behind it: continue the people, the walls, the floor and "
                     "the scenery around it, so that the magenta area disappears completely. Do not add anyone new in "
                     "the foreground. Keep everything else exactly identical: the framing, the perspective, the light, "
                     "the colours and the grain.")


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


# ------------------------------------------------------------------ sujets (SAM 3.1 + BiRefNet)
def _sam_masks(rd, W, H):
    """Masques SAM 3.1 ranges dans rd (un par personne, petites comprises), doublons fusionnes."""
    import numpy as np
    from PIL import Image
    masks = []
    for f in sorted(rd.glob("sam_*.png")):
        m = np.asarray(Image.open(f).convert("L").resize((W, H), Image.NEAREST)) > 127
        if m.sum() < 50:
            continue
        for j, o in enumerate(masks):                     # SAM rend parfois deux fois la meme personne : on fusionne
            inter = int((m & o).sum())
            if inter > 0.6 * int((m | o).sum()) or inter > 0.85 * min(int(m.sum()), int(o.sum())):
                masks[j] = m | o
                break
        else:
            masks.append(m)
    return masks


def _subjects(im, d):
    """Sujets de la case a partir des sorties ComfyUI rangees dans raw/ -> ([{mask, soft, region, area}], tous les
    masques de personnes). mask = masque exact de SAM 3.1 ; region = la personne + ce qu'elle tient (objets vus par
    BiRefNet qui ne touchent qu'elle) ; soft = alpha doux (BiRefNet) limite a la region, sans les autres personnes, coeur de la
    personne toujours opaque. Sujet = personne sur MIN_AREA de la case au moins."""
    import cv2
    import numpy as np
    from PIL import Image
    H, W = im.shape[:2]
    rd = d / "raw"
    people = _sam_masks(rd, W, H)
    masks = [m for m in people if m.mean() >= MIN_AREA]
    bn = rd / "birefnet.png"
    alpha = np.asarray(Image.open(bn).convert("L").resize((W, H), Image.BILINEAR), np.float32) / 255 if bn.exists() \
        else np.zeros((H, W), np.float32)
    k = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r, r))  # noqa: E731
    # objets tenus : ce que BiRefNet voit en plus des personnes (valise, verre, telephone), objet par objet. Un objet va a
    # la personne qu'il touche s'il ne touche qu'elle et reste petit devant elle (mesure : valise 16 % de la taille de
    # l'homme, telephones 1-3 %) ; un gateau touche par quatre invites ou un banc (92 %) restent au decor.
    anyone = cv2.dilate(np.any(people or [np.zeros((H, W), bool)], axis=0).astype(np.uint8), k(5)) > 0
    n, lab, stats, _ = cv2.connectedComponentsWithStats(((alpha > 0.5) & ~anyone).astype(np.uint8))
    near = [cv2.dilate(o.astype(np.uint8), k(15)) > 0 for o in people]
    owner = {}
    for c in range(1, n):
        if stats[c, 4] < 30:
            continue
        comp = lab == c
        touch = [int((comp & z).sum()) for z in near]
        if not touch or max(touch) == 0:
            continue
        j = int(np.argmax(touch))
        alone = sum(touch) - touch[j] < 0.2 * touch[j]
        if alone and stats[c, 4] <= 0.35 * people[j].sum():
            owner.setdefault(j, []).append(comp)
    out = []
    for i, m in enumerate(masks):
        region = m.copy()
        for comp in owner.get(next(j for j, o in enumerate(people) if o is m), []):
            region |= comp
        others = np.any([o for o in people if o is not m] or [np.zeros_like(m)], axis=0) & ~region
        zone = (cv2.dilate(region.astype(np.uint8), k(9)) > 0) & ~others      # jamais un bout du voisin
        soft = np.maximum(alpha * zone, (cv2.erode(m.astype(np.uint8), k(5)) > 0).astype(np.float32))
        out.append({"mask": m, "region": region, "soft": soft.astype(np.float32), "area": float(m.mean())})
    return out, people


def _depth(im, d):
    """Profondeur 0-1 de la photo (brute gardee dans raw/depth.npy : compute et build lisent la meme)."""
    import numpy as np
    f = d / "raw" / "depth.npy"
    try:
        r = np.load(f)
        if r.shape == im.shape[:2]:
            return depth.normalize(r)
    except (OSError, ValueError):
        pass
    r = depth.raw_best(im).astype(np.float32)
    f.parent.mkdir(parents=True, exist_ok=True)
    np.save(f, r)
    return depth.normalize(r)


def _plan(subs, d_im):
    """Sujets a detacher, du plus proche au plus loin -> (sujets, foule ?, part de la case couverte par tous).
    Case normale : tous. Foule (plus de CROWD de la case) : le premier plan seulement, c.-a-d. les plus proches,
    separes de la personne suivante par FRONT_GAP de profondeur au moins et sur FRONT_MAX de la case au plus ; le
    reste de la foule reste dans le decor. Aucun premier plan net : [] (la nappe simple)."""
    import cv2
    import numpy as np
    for s in subs:
        core = cv2.erode(s["mask"].astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
        s["z"] = float(np.median(d_im[core if core.any() else s["mask"]]))
    subs = sorted(subs, key=lambda s: -s["z"])
    acc, covers = np.zeros(d_im.shape, bool), []
    for s in subs:
        acc |= s["soft"] > 0.5
        covers.append(float(acc.mean()))
    if covers[-1] <= CROWD:
        return subs, False, covers[-1]
    k = 0
    for i in range(1, len(subs)):
        if covers[i - 1] > FRONT_MAX:
            break
        if subs[i - 1]["z"] - subs[i]["z"] >= FRONT_GAP:
            k = i
    return subs[:k], True, covers[-1]


def _painted(im, subs, crowd=False):
    """Image a remplir -> (image peinte, forme). Case normale : une forme convexe elargie (magenta) par sujet, Qwen n'y
    voit plus de silhouette a imiter. Foule : la silhouette elargie et arrondie (une forme convexe couvrirait la foule
    entiere, et Qwen y dessinait un mur vide) ; la consigne lui fait prolonger les gens de derriere."""
    import cv2
    import numpy as np
    k = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r, r))  # noqa: E731
    blob = np.zeros(im.shape[:2], np.uint8)
    for s in subs:
        if crowd:
            blob |= s["region"].astype(np.uint8)
            continue
        cnts, _ = cv2.findContours(s["region"].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if cnts:
            cv2.fillConvexPoly(blob, cv2.convexHull(np.concatenate(cnts)), 1)
    if crowd:
        blob = cv2.morphologyEx(cv2.dilate(blob, k(31)), cv2.MORPH_CLOSE, k(max(15, round(0.05 * im.shape[1])) | 1))
    else:
        blob = cv2.dilate(blob, k(41))
    painted = (np.clip(im, 0, 1) * 255).astype(np.uint8)
    painted[blob > 0] = (255, 0, 255)
    return painted, blob > 0


def _plate_faults(im, plate, blob):
    """Defauts d'une plaque rendue par Qwen -> (ecart median hors de la forme, part de magenta restant dans la forme).
    Mesure : bonnes plaques 0,005-0,03 d'ecart ; une photo entierement recomposee (autre cadrage, fond magenta) 0,28+."""
    import cv2
    import numpy as np
    H, W = im.shape[:2]
    P = _load(plate, (W, H))
    keep = ~(cv2.dilate(blob.astype(np.uint8), np.ones((31, 31), np.uint8)) > 0)
    diff = np.abs(cv2.GaussianBlur(im.mean(2), (0, 0), 3) - cv2.GaussianBlur(P.mean(2), (0, 0), 3))
    hsv = cv2.cvtColor((P * 255).astype(np.uint8), cv2.COLOR_RGB2HSV)       # teinte OpenCV 0-180 : magenta ~150
    mag = (hsv[..., 0] > 135) & (hsv[..., 0] < 168) & (hsv[..., 1] > 115) & (hsv[..., 2] > 64)
    return (float(np.median(diff[keep])) if keep.any() else 0.0), (float(mag[blob].mean()) if blob.any() else 0.0)


# ------------------------------------------------------------------ calcul complet (tache de la file)
def _run(server, graph, cancelled):
    from . import comfy
    pid = comfy.submit(server, graph)
    while True:
        if cancelled():
            comfy.cancel(server, pid)
            raise InterruptedError("annule")
        e = comfy.poll(server, pid)
        if e:
            return e
        time.sleep(1.5)


def _images(entry, node):
    return ((entry.get("outputs") or {}).get(node) or {}).get("images") or []


def compute(server, pid, panel_id, spec, progress=print, cancelled=lambda: False, fast=True, lama=True):
    """La tache entiere sur la machine server (ComfyUI) puis ici. -> meta (n = 0 et reason si pas de calques)."""
    import cv2
    import numpy as np
    from PIL import Image
    from . import comfy
    src = store.path(pid, f"start/{panel_id}.png")
    spec["src_mtime"] = src.stat().st_mtime
    d = folder(pid, panel_id)
    rd = d / "raw"
    rd.mkdir(parents=True, exist_ok=True)
    for old in [*rd.glob("*.png"), *rd.glob("*.npy")]:
        old.unlink()                                      # jamais de sortie d'un calcul precedent
    sub, prefix = f"alivecomics/{pid}", f"AliveComics/{pid}/{panel_id}_C"
    seed = int(spec.get("seed") or 20261015)

    t0 = time.time()
    timing = spec["timing"] = {}
    progress("détourage (SAM 3.1, BiRefNet)")
    name = comfy.upload(server, src, sub)
    try:
        e = _run(server, comfy.segment_graph(name, prefix, SAM_PROMPT), cancelled)
    except comfy.ComfyError as exc:
        if not comfy.no_detection(exc):
            raise
        return build(pid, panel_id, dict(spec, skip="aucune personne dans la case"))
    for i, it in enumerate(_images(e, "6")):
        comfy.download(server, it, rd / f"sam_{i:02d}.png")
    for it in _images(e, "10"):
        comfy.download(server, it, rd / "birefnet.png")

    timing["segment"] = round(time.time() - t0, 1)
    im = np.asarray(Image.open(src).convert("RGB"), np.float32) / 255
    H, W = im.shape[:2]
    subs, people = _subjects(im, d)
    if not subs:
        return build(pid, panel_id, dict(spec, skip="aucune personne assez grande dans la case"))
    progress("profondeur")
    subs, crowd, _ = _plan(subs, _depth(im, d))
    timing["depth"] = round(time.time() - t0 - timing["segment"], 1)
    if not subs:
        return build(pid, panel_id, spec)                 # verdict « foule » ecrit par build
    painted, blob = _painted(im, subs, crowd)
    Image.fromarray(painted).save(rd / "painted.png")
    pname = comfy.upload(server, rd / "painted.png", sub)
    # personnes de la photo laissees dans le decor (petites, ou la foule derriere le premier plan) : les prolonger
    # dans la forme n'est pas « inventer quelqu'un »
    known = np.zeros((H, W), np.uint8)
    for m in people:
        if not any(m is s["mask"] for s in subs):
            known |= m.astype(np.uint8)
    known = cv2.dilate(known, np.ones((9, 9), np.uint8)) > 0

    # controle de la plaque. Case normale : une personne dans la forme qui n'est pas une personne de la photo est
    # inventee (score = sa part dans la forme). Foule : des invites prolonges ou ajoutes derriere sont attendus ; seul
    # le sujet redessine a sa place est une faute (score = recouvrement avec son masque).
    limit = 0.6 if crowd else 0.3
    tries = []
    for attempt in range(3):                              # plaque : Qwen ; une personne inventee -> autre graine
        progress("décor caché (Qwen-Image-Edit)" + (f", essai {attempt + 1}" if attempt else ""))
        g, node = comfy.fill_graph(pname, FILL_PROMPT_CROWD if crowd else FILL_PROMPT, seed + 101 * attempt,
                                   prefix + "_fill", fast)
        e = _run(server, g, cancelled)
        plate = comfy.download(server, _images(e, node)[0], rd / f"plate_{attempt}.png")
        try:                                              # SAM 3.1 sur la plaque : qui y voit-on ?
            check = comfy.sam_graph(comfy.upload(server, plate, sub), prefix + "_check", SAM_PROMPT)
            e = _run(server, check, cancelled)
        except comfy.ComfyError as exc:
            if not comfy.no_detection(exc):
                raise
            e = {}                                        # personne : parfait
        bad = 0.0
        for i, it in enumerate(_images(e, "6")):
            p = rd / f"check_{i:02d}.png"
            comfy.download(server, it, p)
            m = np.asarray(Image.open(p).convert("L").resize((W, H), Image.NEAREST)) > 127
            p.unlink()
            if m.mean() < MIN_AREA / 2:
                continue
            if crowd:
                bad = max([bad] + [float((m & s["mask"]).sum() / max(1, (m | s["mask"]).sum())) for s in subs])
            elif (m & known).sum() < 0.4 * m.sum():
                bad = max(bad, float((m & blob).sum() / max(1, m.sum())))
        drift, magenta = _plate_faults(im, rd / f"plate_{attempt}.png", blob)
        if drift > 0.06 or magenta > 0.05:                # photo recomposee ou forme mal remplie : essai rate
            bad = 1.0
        tries.append({"seed": seed + 101 * attempt, "invented": round(bad, 2), "drift": round(drift, 3),
                      "magenta": round(magenta, 3)})
        if bad < limit:
            break
    best = min(range(len(tries)), key=lambda i: tries[i]["invented"])
    (rd / f"plate_{best}.png").replace(rd / "plate.png")
    if tries[best]["invented"] >= limit and lama:         # toujours quelqu'un d'invente : LaMa (flou, sans invention)
        progress("décor caché (LaMa)")
        try:
            Image.fromarray((blob * 255).astype(np.uint8)).save(rd / "hole.png")
            g = comfy.lama_graph(name, comfy.upload(server, rd / "hole.png", sub), prefix + "_lama")
            e = _run(server, g, cancelled)
            comfy.download(server, _images(e, "5")[0], rd / "plate.png")
            tries.append({"lama": True})
        except comfy.ComfyError as exc:                   # LaMa absent ou en erreur : le moins mauvais essai Qwen
            tries.append({"lama": False, "error": str(exc)[:200]})
    for old in rd.glob("plate_*.png"):
        old.unlink()
    spec["fill"] = tries
    timing["fill"] = round(time.time() - t0 - timing["segment"] - timing["depth"], 1)
    progress("découpe des calques")
    return build(pid, panel_id, spec)


# ------------------------------------------------------------------ construction des calques (sur ce PC)
def build(pid, panel_id, spec=None):
    """Sorties ComfyUI (raw/) -> calques. Renvoie meta (n = 0 et reason si la case ne se decoupe pas)."""
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
            "seed": spec.get("seed"), "worker": spec.get("worker"), "fill": spec.get("fill"), "timing": spec.get("timing")}

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
        return give_up(spec["skip"], True)

    # 1) sujets : masques exacts (SAM 3.1), bords doux (BiRefNet)
    subs, _ = _subjects(im, d)
    if not subs:
        return give_up("aucune personne assez grande dans la case", True)
    n_all = len(subs)
    d_im = _depth(im, d)
    subs, crowd, cover = _plan(subs, d_im)                # du plus proche au plus loin
    if not subs:
        return give_up("foule sans premier plan net : les personnes couvrent la moitié de la case ou plus, à des "
                       "profondeurs voisines ; la nappe simple convient mieux", True, subjects=round(cover, 3), n=n_all)
    a_all = np.max([s["soft"] for s in subs], axis=0)
    fill = float((a_all > 0.5).mean())
    plate = d / "raw" / "plate.png"
    if not plate.exists():
        return give_up("plaque de fond manquante")

    # 2) groupes devant / derriere par ecart de profondeur
    front, back, how = subs, [], "un seul plan"
    if len(subs) > 1:
        zs = [s["z"] for s in subs]
        gaps = [zs[i] - zs[i + 1] for i in range(len(zs) - 1)]
        k = int(np.argmax(gaps))
        if gaps[k] > 0.12:
            front, back, how = subs[:k + 1], subs[k + 1:], "profondeur"
    a_front = np.max([s["soft"] for s in front], axis=0)
    a_back = np.max([s["soft"] for s in back], axis=0) if back else None
    if a_back is not None:                                # un pixel ne sert qu'a un calque : celui de devant gagne
        a_back = a_back * (1 - a_front)

    # 3) plaque : recalee hors de la forme peinte, lumiere de la photo prolongee sous les sujets
    margin = max(6, round(0.012 * W))
    edge = max(4, round(0.008 * W))
    _, blob = _painted(im, subs, crowd)
    P = _load(plate, (W, H))
    keep = ~(cv2.dilate(blob.astype(np.uint8), np.ones((15, 15), np.uint8)) > 0)
    P, mP = _align(im, P, keep.astype(np.float32))
    P = _color_match(im, P, keep)
    hole = _grow(a_all, edge)
    bg = _fill_plate(im, P, hole)
    M = _grow(a_all, margin)

    # 4) calques : couleurs sans lisere, profondeur de chaque sujet (carte a peine bombee)
    layers = []                                           # (couleur, alpha, profondeur), du plus loin au plus proche
    if a_back is not None:
        layers.append((_extend(_decontam(im, a_back, bg), a_back), a_back, _subject_depth(d_im, a_back)))
        behind = bg * (1 - a_back[..., None]) + im * a_back[..., None]
    else:
        behind = bg
    layers.append((_extend(_decontam(im, a_front, behind), a_front), a_front, _subject_depth(d_im, a_front)))

    # 5) profondeur du fond : calculee sur la plaque, a l'echelle de la photo, jamais devant les sujets
    d_bg = _fit_depth(depth.raw_best(bg), d_im, M < 0.01)
    for _, a, dz in layers:
        inside = _grow(a, margin) > 0.5
        d_bg[inside] = np.minimum(d_bg[inside], dz[inside] - 0.03)
    d_bg = depth.bound_slope(depth.smooth_edges(np.clip(d_bg, 0, 1), bg))

    # 6) fichiers
    d.mkdir(parents=True, exist_ok=True)
    u8 = lambda x: (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)   # noqa: E731
    Image.fromarray(u8(bg)).save(d / "bg.jpg", "JPEG", quality=90)
    for i, (Fi, ai, _) in enumerate(layers, 1):
        Image.fromarray(np.dstack([u8(Fi), u8(ai)])).save(d / f"l{i}.webp", "WEBP", quality=90, exact=True, method=4)
    for old in d.glob("l*.webp"):
        if old.stem not in {f"l{i}" for i in range(1, len(layers) + 1)}:
            old.unlink()
    zero = np.zeros((H, W), np.float32)
    maps = [d_bg] + [x[2] for x in layers] + [zero] * (2 - len(layers))
    Image.fromarray(np.dstack([u8(x) for x in maps[:3]])).resize((max(2, W // 2), max(2, H // 2)), Image.BILINEAR) \
        .save(d / "ld.png", optimize=True)
    zs = [round(float(np.median(d_bg[M > 0.5])) if (M > 0.5).any() else float(np.median(d_bg)), 3)]
    zs += [round(float(np.median(x[2][x[1] > 0.5])), 3) for x in layers]
    m = dict(base, n=len(layers), z=zs, focus=zs[-1], groups=how, crowd=crowd, depth_model=depth.best_name(),
             qc={"subjects": [{"z": round(s["z"], 3), "area": round(s["area"], 4)} for s in subs],
                 "people": n_all, "cover": round(cover, 3), "fill": round(fill, 3), "aligned": mP is not None},
             seconds=round(time.time() - t0, 1))
    (d / "meta.json").write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    return m
