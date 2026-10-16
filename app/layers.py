"""Relief en couches (« diorama ») : la case est decoupee en calques, comme un livre pop-up.

Pourquoi : une seule image tordue par une seule carte de profondeur se replie au bord des sujets (bords dedoubles) et
n'a rien a montrer derriere eux. Ici, chaque calque a sa propre profondeur, sans rupture, et c'est son alpha qui gere
qui cache quoi. Le lecteur dessine les calques du fond vers l'avant (player/alive-player.js).

Une tache « couches » de la file, sur un PC ComfyUI qui a SAM 3.1, BiRefNet, Qwen-Image-Edit 2509 et LaMa (voir
docs/INSTALL-MODELES-RELIEF.md) :
1. ComfyUI : SAM 3.1 (« person ») donne un masque exact par personne ; puis, en un seul graphe, les objets tenus
   (OBJECTS), portes (WORN), les surfaces qui montrent des gens (SURFACES) et les mains. Un objet tenu suit la personne
   dont il touche une main, un objet porte celle qu'il touche ; les gens vus sur un ecran, dans un miroir ou un cadre ne
   sont pas des sujets. BiRefNet : seulement les lisieres oubliees par SAM et le bord doux (cheveux, flou).
2. Ici : profondeur de la photo (Depth Pro d'Apple si present, sinon Depth Anything V2 Small). Sujets = les personnes
   assez grandes ; foule (sujets sur plus de 45 % de la case) : seulement le premier plan net (les plus proches, bien
   separes du reste en profondeur), le reste de la foule reste dans le decor ; aucun premier plan net : pas de couches
   (la case glisse d'un bloc, carte plane).
3. Decor cache (voir PLATE) : LaMa sur la place des sujets (prolonge les couleurs, n'invente rien), et Qwen-Image-Edit
   sur une forme neutre (magenta) peinte a leur place : forme convexe (peinte en silhouette, Qwen redessinait des
   jambes) ; foule : silhouette elargie, Qwen y prolonge les gens de derriere. SAM 3.1 controle la plaque Qwen (personne
   inventee, photo recomposee, magenta restant -> autre graine, puis LaMa).
4. Ici, theatre de papier (version 3, demande de David le 16/10) : chaque groupe (devant / derriere par ecart de
   profondeur, une seule carte s'ils se touchent) est une CARTE PLATE au contour net (masque SAM, trous bouches, fentes
   entre voisins comblees, 1 pixel en dedans, adouci d'un pixel, couleurs de la photo) ; le fond est un PLAN (ajuste sur
   la profondeur de la photo hors des sujets) ; le decor reconstruit ne remplace la photo que sous les sujets, sur 3-4
   pixels autour et sur leur bord doux. Rien ne s'etire, ni dans un personnage ni autour de lui.
Au repos, l'image est celle de la photo : l'IA ne sert que DANS la place des sujets.

Fichiers : projects/<id>/layers/<case>/ : raw/ (sam_XX.png, obj_*.png, worn_*.png, surf_*.png, hand.png, birefnet.png,
depth.npy, painted.png, plate.png = Qwen, lama.png = LaMa), bg.jpg (fond sans les sujets), l1.webp et l2.webp (sujets
RGBA, du plus loin au plus proche), ld.png (profondeurs : R = fond, G = l1, B = l2, demi-resolution), meta.json (n
calques, profondeurs, plan net conseille, controles).
"""

import json
import time

from . import depth, store

VERSION = 3                    # 3 : cartes plates a contour net, fond en plan (16/10/2026)
SIDE = "C"                     # tache « couches » dans la file de rendus
SAM_PROMPT = "person:20"       # SAM 3.1 : jusqu'a 20 personnes, un masque chacune
# objets cherches par SAM 3.1 en plus des personnes, tous dans un seul graphe (masques reunis : un objet absent donne
# un masque vide). Objet absent : SAM rend parfois un faux objet (« giraffe » -> un doigt, « screen » -> 98 % de la case),
# d'ou les garde-fous de _subjects. Revue des 71 cases de demo : sans eux, gobelets, feuilles, bouquets, parapluie,
# telephones, cigarettes restaient au fond pendant que la main glissait. « drinking glass » et pas « glass » : SAM y
# prenait la vitre d'une fenetre, qui partait avec la personne dont la main la touchait.
OBJECTS = ("phone", "screen", "cup", "drinking glass", "bottle", "paper", "book", "bouquet", "flower", "umbrella", "camera",
           "microphone", "cigarette", "bag", "knife")             # tenus : suivent la main qui les touche
WORN = ("necktie", "hat", "scarf", "strap")                       # portes : suivent la personne qu'ils touchent
SURFACES = ("mirror", "picture frame")                            # montrent des gens (images, pas des sujets)
HANDS = "hand"
OBJ_MAX = 0.15                 # un objet tenu couvre 15 % de la case au plus (parapluie au-dessus d'un couple : 9 %)
SURFACE_MAX = 0.3
INTRUDER = 0.05                # morceau de personne coupe par le bord du cadre (un avant-bras, une tete de dos)
PROP_MAX = 0.05                # telephone ou ecran : 5 % de la case au plus (le gros telephone de la planche 15 : 3 % ;
                               # faux « ecran » rendu par SAM sur une case sans ecran : 98 %)
MIN_AREA = 0.004               # un sujet couvre au moins 0,4 % de la case (les silhouettes lointaines restent au decor)
# decor cache derriere les sujets : "qwen" (Qwen-Image-Edit invente un decor plausible, parfois faux : un trou noir),
# "lama" (LaMa prolonge les couleurs autour, n'invente rien ; on n'en voit qu'une bande etroite au bord du sujet),
# "hybride" (LaMa pres du contour, la ou la parallaxe le montre, Qwen plus loin). Les deux plaques sont toujours calculees.
PLATE = "qwen"
CROWD = 0.45                   # mesure : bonnes cases 14-37 % de sujets, foules 54-67 %
FRONT_MAX = 0.6                # foule ou gros plan : premier plan detache sur 60 % de la case au plus (a 35 %, une
                               # mariee sur 43 % devant des invites minuscules n'etait pas detachee)...
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


# ------------------------------------------------------------------ sujets (SAM 3.1 + BiRefNet)
def _sam_masks(rd, W, H, pattern="sam_*.png", max_area=1.0):
    """Masques SAM 3.1 ranges dans rd (un par personne, petites comprises ; ou un par objet), doublons fusionnes. Plus
    grands que max_area (part de la case) : ignores avant la fusion (un faux « ecran » de toute la case avalerait sinon
    les vrais telephones)."""
    import numpy as np
    from PIL import Image
    masks = []
    for f in sorted(rd.glob(pattern)):
        m = np.asarray(Image.open(f).convert("L").resize((W, H), Image.NEAREST)) > 127
        if m.sum() < 50 or m.mean() > max_area:
            continue
        for j, o in enumerate(masks):                     # SAM rend parfois deux fois la meme personne : on fusionne
            inter = int((m & o).sum())
            if inter > 0.6 * int((m | o).sum()) or inter > 0.85 * min(int(m.sum()), int(o.sum())):
                masks[j] = m | o
                break
        else:
            masks.append(m)
    return masks


def _components(rd, W, H, patterns, max_area):
    """Objets d'une famille (fichiers raw/ : un masque par objet, ou tous reunis) : une composante connexe par objet,
    les plus grandes que max_area ignorees (faux objets geants), doublons fusionnes."""
    import cv2
    import numpy as np
    from PIL import Image
    out = []
    for pat in patterns:
        for f in sorted(rd.glob(pat)):
            m = np.asarray(Image.open(f).convert("L").resize((W, H), Image.NEAREST)) > 127
            n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
            for c in range(1, n):
                if st[c, 4] < 30 or st[c, 4] > max_area * W * H:
                    continue
                q = lab == c
                for j, o in enumerate(out):
                    inter = int((q & o).sum())
                    if inter > 0.6 * int((q | o).sum()) or inter > 0.85 * min(int(q.sum()), int(o.sum())):
                        out[j] = q | o
                        break
                else:
                    out.append(q)
    return out


def _subjects(im, d, d_im):
    """Sujets de la case a partir des sorties ComfyUI rangees dans raw/ -> ([{mask, soft, region, area, held}],
    personnes de la photo, personnes affichees sur un ecran). mask = masque exact de SAM 3.1 ; region = la personne +
    ce qu'elle tient ; soft = alpha net de la region (sans les autres personnes), voir _sharp.
    Sujet = personne sur MIN_AREA de la case au moins. d_im : profondeur 0-1 de la photo (garde-fou des objets)."""
    import cv2
    import numpy as np
    from PIL import Image
    H, W = im.shape[:2]
    rd = d / "raw"
    k = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r, r))  # noqa: E731
    screens = _components(rd, W, H, ["prop_phone*", "prop_screen*", "obj_phone*", "obj_screen*"], PROP_MAX)
    # une « personne » presque toute dans un ecran, un miroir ou un cadre est une image (les maries filmes sur l'ecran du
    # telephone d'un invite, le conducteur dans le retroviseur, le couple de la photo de mariage posee sur la table) : ce
    # n'est pas un sujet. Si SAM rend la personne elle-meme comme « miroir », elle n'est pas plus petite que lui.
    surfaces = screens + _components(rd, W, H, ["surf_*"], SURFACE_MAX)
    grown = [cv2.dilate(q.astype(np.uint8), k(5)) > 0 for q in surfaces]
    people, shown = [], []
    for m in _sam_masks(rd, W, H):
        flat = any((m & g).sum() >= 0.7 * m.sum() and m.sum() < 0.6 * q.sum() for q, g in zip(surfaces, grown))
        (shown if flat else people).append(m)
    masks = [m for m in people if m.mean() >= MIN_AREA]
    bn = rd / "birefnet.png"
    alpha = np.asarray(Image.open(bn).convert("L").resize((W, H), Image.BILINEAR), np.float32) / 255 if bn.exists() \
        else np.zeros((H, W), np.float32)
    near = [cv2.dilate(o.astype(np.uint8), k(15)) > 0 for o in people]
    hands = np.any(_components(rd, W, H, ["hand*"], PROP_MAX) or [np.zeros((H, W), bool)], axis=0)
    in_hand = lambda x, j: (cv2.dilate(x.astype(np.uint8), k(11)) > 0)[hands & near[j]].sum() >= 20  # noqa: E731
    zof = lambda x: float(np.median(d_im[x])) if x.any() else 0.0  # noqa: E731
    z_people = [zof(cv2.erode(o.astype(np.uint8), k(7)) > 0) or zof(o) for o in people]
    cut = [bool(o[0].any() or o[-1].any() or o[:, 0].any() or o[:, -1].any()) for o in people]
    # BiRefNet : seulement les lisieres collees au contour d'une personne (un bout de costume oublie par SAM). Les objets
    # entiers viennent de SAM : BiRefNet emportait aussi du gravier, du riz ou de la fumee autour d'une main.
    anyone = cv2.dilate(np.any(people or [np.zeros((H, W), bool)], axis=0).astype(np.uint8), k(5)) > 0
    n, lab, stats, _ = cv2.connectedComponentsWithStats(((alpha > 0.5) & ~anyone).astype(np.uint8))
    owner, held = {}, {}
    for c in range(1, n):
        if stats[c, 4] < 30:
            continue
        comp = lab == c
        touch = [int((comp & z).sum()) for z in near]
        if not touch or max(touch) == 0:
            continue
        j = int(np.argmax(touch))
        alone = sum(touch) - touch[j] < 0.2 * touch[j]
        rim = (comp & (cv2.dilate(people[j].astype(np.uint8), k(13)) > 0)).sum() >= 0.8 * stats[c, 4]
        if alone and rim and stats[c, 4] <= 0.1 * people[j].sum():
            owner.setdefault(j, []).append(comp)
    # objets tenus (SAM) : a la personne qui les recouvre ou les touche le plus, s'ils touchent une de ses mains, sont au
    # moins aussi proches qu'elle (une fenetre derriere quelqu'un est plus loin) et pas trop grands (4 fois la partie
    # visible d'une personne coupee par le bord, comme une main qui tient un telephone ; sinon 1,5 fois sa taille).
    # Telephones et ecrans elargis : SAM ne prend que l'ecran, le cadre et la coque restaient au fond.
    grow_screen = k(2 * max(4, round(0.011 * W)) + 1)
    objects = [(q, True) for q in screens] + [(q, False) for q in _components(
        rd, W, H, [f"obj_{x.replace(' ', '_')}*" for x in OBJECTS if x not in ("phone", "screen")], OBJ_MAX)]
    for q, scr in objects:
        touch = [int((q & z).sum()) for z in near]
        if not touch or max(touch) == 0:
            continue
        inside = [int((q & o).sum()) for o in people]
        j = max(range(len(people)), key=lambda i: (inside[i], touch[i]))   # recouvrement reel d'abord (egalites)
        if inside[j] > 0.5 * q.sum():                     # deja a moitie dans son masque : l'objet entier la suit
            held.setdefault(j, []).append(q)              # (un bouquet coupe en deux restait a moitie au fond)
            continue
        if not in_hand(q, j):
            continue                                      # ne touche aucune de ses mains : pas tenu
        if zof(q) >= z_people[j] - 0.15 and q.sum() <= (4.0 if cut[j] else 1.5) * people[j].sum():
            held.setdefault(j, []).append((cv2.dilate(q.astype(np.uint8), grow_screen) > 0) if scr else q)
    # objets portes (cravate, chapeau, couronne en papier, echarpe, sangle) : a la personne qu'ils touchent le plus
    for q in _components(rd, W, H, [f"worn_{x.replace(' ', '_')}*" for x in WORN], OBJ_MAX):
        touch = [int((q & z).sum()) for z in near]
        if not touch or max(touch) == 0:
            continue
        j = int(np.argmax(touch))
        if touch[j] >= 0.3 * q.sum() and q.sum() <= 0.5 * people[j].sum():
            held.setdefault(j, []).append(q)
    out = []
    for m in masks:
        j = next(i for i, o in enumerate(people) if o is m)
        others = np.any([o for o in people if o is not m] or [np.zeros_like(m)], axis=0)
        core = m.copy()
        for q in held.get(j, []):
            core |= q & ~others
        region = core.copy()
        for comp in owner.get(j, []):
            region |= comp
        objs = region & ~m
        if objs.any():                                    # pas de jour entre la main et ce qu'elle tient (le fond s'y
            near_objs = cv2.dilate(objs.astype(np.uint8), k(15)) > 0      # voyait bouger comme un contour)
            closed = cv2.morphologyEx(region.astype(np.uint8), cv2.MORPH_CLOSE, k(9)) > 0
            region |= closed & near_objs & ~others
        # devant la personne (bouteille, accoudoir, couteau, etincelles) : une encoche etroite dans son masque, plus proche
        # qu'elle, rejoint sa carte (sinon elle reste au fond, derriere la carte, et laisse un trou qui bouge)
        kk = max(9, round(0.015 * W)) | 1
        notch = (cv2.morphologyEx(region.astype(np.uint8), cv2.MORPH_CLOSE, k(kk)) > 0) & ~region & ~others
        region |= notch & (d_im >= z_people[j] - 0.05)
        region = _fill_holes(region, alpha) & ~others
        others &= ~region
        out.append({"mask": m, "region": region, "soft": _sharp(region & ~others), "area": float(m.mean()),
                    "held": len(held.get(j, [])), "intruder": cut[j] and float(m.mean()) < INTRUDER})
    return out, people, shown


def _fill_holes(region, alpha):
    """Trous du masque bouches (SAM laisse des trous dans un costume blanc ; le contour flou d'avant les cachait, le
    contour net les montre en taches sombres qui bougent) : un trou ferme est bouche si BiRefNet y voit le sujet
    (alpha moyen > 0,5) ou s'il est minuscule ; le fond vu entre un bras et le corps reste un trou."""
    import cv2
    import numpy as np
    H, W = region.shape
    n, lab, st, _ = cv2.connectedComponentsWithStats((~region).astype(np.uint8), connectivity=4)
    if n <= 2:
        return region
    mean_a = np.bincount(lab.ravel(), weights=alpha.ravel(), minlength=n) / np.maximum(st[:, 4], 1)
    edge = (st[:, 0] == 0) | (st[:, 1] == 0) | (st[:, 0] + st[:, 2] >= W) | (st[:, 1] + st[:, 3] >= H)
    fill = ~edge & ((mean_a > 0.5) | (st[:, 4] < max(30, 0.02 * region.sum())))   # revue : mains et manches trouees
    fill[0] = False
    return region | fill[lab]


def _fill_small(region, max_px):
    """Trous fermes de la region (ne touchant pas le bord du cadre) de moins de max_px pixels : bouches."""
    import cv2
    import numpy as np
    H, W = region.shape
    n, lab, st, _ = cv2.connectedComponentsWithStats((~region).astype(np.uint8), connectivity=4)
    if n <= 2:
        return region
    edge = (st[:, 0] == 0) | (st[:, 1] == 0) | (st[:, 0] + st[:, 2] >= W) | (st[:, 1] + st[:, 3] >= H)
    fill = ~edge & (st[:, 4] < max_px)
    fill[0] = False
    return region | fill[lab]


def _sharp(region):
    """Alpha net d'une region : 2 pixels en dedans (revue : a 1 pixel, un liseré clair du fond partait avec la carte sur
    les fonds lumineux), bord adouci d'un pixel (pas d'escalier). Les pixels retires au bord sont dans le trou de la
    plaque : remplaces par le decor."""
    import cv2
    import numpy as np
    m = cv2.erode(region.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))).astype(np.float32)
    return np.clip(cv2.GaussianBlur(m, (0, 0), 0.7), 0, 1).astype(np.float32)


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
    reste de la foule reste dans le decor ; un gros plan (une mariee sur 43 % de la case devant des invites minuscules,
    ou seule dans la case) est detache en entier. Aucun premier plan net : [] (la carte de la case, un plan)."""
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
    # foule : on choisit parmi les vraies personnes ; un morceau coupe par le bord du cadre (avant-bras, tete de dos) ne
    # suffit jamais seul (revue : un avant-bras detache, les maries laisses au fond) ; il suit si les choisis sont derriere
    total = covers[-1]
    every = subs
    subs = [s for s in subs if not s.get("intruder")] or subs
    if len(subs) < len(every):
        acc, covers = np.zeros(d_im.shape, bool), []
        for s in subs:
            acc |= s["soft"] > 0.5
            covers.append(float(acc.mean()))
    allm = np.any([s["mask"] for s in subs], axis=0)
    z_rest = float(np.median(d_im[~allm])) if (~allm).any() else 0.0     # le decor, derriere le dernier sujet
    k = 0
    for i in range(1, len(subs) + 1):
        if covers[i - 1] > FRONT_MAX:
            break
        gap = subs[i - 1]["z"] - (subs[i]["z"] if i < len(subs) else z_rest)
        # au-dela de 35 % de la case, seulement un premier plan tres net (ecart 0,3) : la mariee devant des invites
        # lointains oui ; 9 personnes sur 52 % d'une foule dansante (ecart 0,12 avec le fond) non. Tout le monde
        # detache (il ne reste que le decor derriere : rien a prolonger) : l'ecart ordinaire suffit.
        if gap >= FRONT_GAP and (covers[i - 1] <= 0.35 or gap >= 0.3 or i == len(subs)):
            k = i
    chosen = subs[:k]
    if chosen:                                            # rang coherent : un voisin en contact, a profondeur voisine,
        zmin = min(s["z"] for s in chosen)                # rejoint les choisis (revue : une invitee laissee au fond entre
        grow = True                                       # deux voisines detachees)
        while grow:
            grow = False
            reg = np.any([s["region"] for s in chosen], axis=0).astype(np.uint8)
            near = cv2.dilate(reg, np.ones((7, 7), np.uint8)) > 0
            for s in subs:
                if any(s is c for c in chosen) or s["z"] < zmin - 0.1 or (s["mask"] & near).sum() <= 50:
                    continue
                if float(np.any([c["soft"] > 0.5 for c in chosen + [s]], axis=0).mean()) <= FRONT_MAX:
                    chosen.append(s)
                    grow = True
        chosen.sort(key=lambda s: -s["z"])
    if chosen and len(subs) < len(every):
        zmin = min(s["z"] for s in chosen)
        chosen = sorted(chosen + [s for s in every if s.get("intruder") and s["z"] >= zmin], key=lambda s: -s["z"])
    return chosen, len(chosen) < len(every), total


def _painted(im, subs, crowd=False):
    """Image a remplir -> (image peinte, forme). Case normale : une forme convexe elargie (magenta) par sujet, Qwen n'y
    voit plus de silhouette a imiter. Foule : la silhouette elargie et arrondie (une forme convexe couvrirait la foule
    entiere, et Qwen y dessinait un mur vide) ; la consigne lui fait prolonger les gens de derriere."""
    import cv2
    import numpy as np
    k = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r, r))  # noqa: E731
    blob = np.zeros(im.shape[:2], np.uint8)
    hulls = np.zeros(im.shape[:2], np.uint8)
    for s in subs:
        blob |= s["region"].astype(np.uint8)
        cnts, _ = cv2.findContours(s["region"].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if cnts:
            cv2.fillConvexPoly(hulls, cv2.convexHull(np.concatenate(cnts)), 1)
    crowd = crowd or hulls.mean() > 0.35                  # gros sujets : la forme convexe couvrirait la case (mur vide)
    if not crowd:
        blob = hulls
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
def lama_hole(subs, W, rd):
    """Zone que LaMa refait : les sujets choisis et 1,2 % de largeur autour. Revue des 71 cases : a 2,2 % avec le bord
    doux, LaMa etalait de plus larges bavures (plus le trou est grand, plus il est flou) ; la bande que la parallaxe montre
    est pres du contour, ou un trou serre le garde fidele."""
    import cv2
    import numpy as np
    region = np.any([s["region"] for s in subs], axis=0).astype(np.uint8)
    r = max(5, round(0.012 * W))
    return cv2.dilate(region, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))


def extra_prompts():
    """Recherches SAM en plus des personnes -> {fichier raw sans .png : texte}. Le « :N » est indispensable : sans lui,
    SAM 3.1 ne rend que sa meilleure detection (une seule main par photo, un seul gobelet...)."""
    out = {f"obj_{x.replace(' ', '_')}": f"{x}:10" for x in OBJECTS}
    out.update({f"worn_{x.replace(' ', '_')}": f"{x}:10" for x in WORN})
    out.update({f"surf_{x.replace(' ', '_')}": f"{x}:5" for x in SURFACES})
    out["hand"] = f"{HANDS}:30"
    return out


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
    for old in [*rd.glob("*.png"), *rd.glob("*.npy")]:    # jamais de sortie d'un calcul precedent, sauf la profondeur
        if old.name == "depth.npy" and old.stat().st_mtime > spec["src_mtime"]:   # de la meme image (20-90 s sur le
            continue                                                               # processeur quand le GPU est pris)
        old.unlink()
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
    im = np.asarray(Image.open(src).convert("RGB"), np.float32) / 255
    H, W = im.shape[:2]
    if not any(m.mean() >= MIN_AREA for m in _sam_masks(rd, W, H)):   # ni objets ni profondeur : rien a detacher
        return build(pid, panel_id, dict(spec, skip="aucune personne assez grande dans la case"))
    prompts = extra_prompts()                             # objets, surfaces, mains : un seul graphe
    g, outs = comfy.sam_multi_graph(name, f"{prefix}_obj", prompts)
    e = _run(server, g, cancelled)
    for key, node in outs.items():
        for it in _images(e, node)[:1]:
            comfy.download(server, it, rd / f"{key}.png")

    timing["segment"] = round(time.time() - t0, 1)
    progress("profondeur")
    d_im = _depth(im, d)
    timing["depth"] = round(time.time() - t0 - timing["segment"], 1)
    subs, people, shown = _subjects(im, d, d_im)
    if not subs:
        return build(pid, panel_id, dict(spec, skip="aucune personne assez grande dans la case"))
    subs, crowd, _ = _plan(subs, d_im)
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
    for m in shown:                                       # affiches sur un ecran reste au decor (pas un telephone emporte)
        if not any((m & s["region"]).sum() > 0.5 * m.sum() for s in subs):
            known |= m.astype(np.uint8)
    known = cv2.dilate(known, np.ones((9, 9), np.uint8)) > 0

    # controle de la plaque. Case normale : une personne dans la forme qui n'est pas une personne de la photo est
    # inventee (score = sa part dans la forme). Foule : des invites prolonges ou ajoutes derriere sont attendus ; seul
    # le sujet redessine a sa place est une faute (score = recouvrement avec son masque).
    limit = 0.6 if crowd else 0.3
    tries = []
    mode = spec.get("plate") or PLATE
    if lama:                                              # LaMa sur la place des sujets (~1 s) : plaque « lama »
        progress("décor caché (LaMa)")
        hole = lama_hole(subs, W, rd)
        Image.fromarray(hole * 255).save(rd / "hole.png")
        try:
            g = comfy.lama_graph(name, comfy.upload(server, rd / "hole.png", sub), prefix + "_lama")
            e = _run(server, g, cancelled)
            comfy.download(server, _images(e, "5")[0], rd / "lama.png")
        except comfy.ComfyError as exc:
            tries.append({"lama": False, "error": str(exc)[:200]})
    for attempt in range(0 if mode == "lama" and (rd / "lama.png").exists() else 3):   # Qwen ; inventee -> autre graine
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
        tries.append({"attempt": attempt, "seed": seed + 101 * attempt, "invented": round(bad, 2), "drift": round(drift, 3),
                      "magenta": round(magenta, 3)})
        if bad < limit:
            break
    qwen = [i for i, t in enumerate(tries) if "invented" in t]
    best = min(qwen, key=lambda i: tries[i]["invented"]) if qwen else None
    if best is not None:
        (rd / f"plate_{tries[best]['attempt']}.png").replace(rd / "plate.png")
    if (best is None or tries[best]["invented"] >= limit) and (rd / "lama.png").exists():
        (rd / "plate.png").write_bytes((rd / "lama.png").read_bytes())   # Qwen invente toujours : LaMa (sans invention)
        tries.append({"lama": True})
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
    d_im = _depth(im, d)
    subs, people, _ = _subjects(im, d, d_im)
    if not subs:
        return give_up("aucune personne assez grande dans la case", True)
    n_all = len(subs)
    subs, crowd, cover = _plan(subs, d_im)                # du plus proche au plus loin
    if not subs:
        return give_up("foule sans premier plan net : les personnes couvrent la moitié de la case ou plus, à des "
                       "profondeurs voisines ; la case glisse d'un bloc", True, subjects=round(cover, 3), n=n_all)
    a_all = np.max([s["soft"] for s in subs], axis=0)
    fill = float((a_all > 0.5).mean())
    plate = d / "raw" / "plate.png"
    if not plate.exists():
        return give_up("plaque de fond manquante")
    filled = np.zeros((H, W), bool)                       # ou les plaques ont vraiment refait le decor
    for f in (d / "raw" / "painted.png", d / "raw" / "hole.png"):
        if f.exists():
            x = np.asarray(Image.open(f).convert("RGB").resize((W, H), Image.NEAREST))
            filled |= (x[..., 0] > 200) & (x[..., 1] < 60) & (x[..., 2] > 200) if f.name == "painted.png" else x[..., 0] > 127
    core = cv2.erode((a_all > 0.5).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    if core.any() and (core & ~filled).sum() > 0.02 * core.sum():
        return give_up("les sujets ont change depuis le calcul du decor cache : relancer le calcul")

    # 2) groupes devant / derriere par ecart de profondeur
    front, back, how = subs, [], "un seul plan"
    if len(subs) > 1:
        zs = [s["z"] for s in subs]
        gaps = [zs[i] - zs[i + 1] for i in range(len(zs) - 1)]
        k = int(np.argmax(gaps))
        if gaps[k] > 0.12:
            front, back, how = subs[:k + 1], subs[k + 1:], "profondeur"
            fr = np.any([s["region"] for s in front], axis=0).astype(np.uint8)
            bk = np.any([s["region"] for s in back], axis=0)
            if ((cv2.dilate(fr, np.ones((7, 7), np.uint8)) > 0) & bk).sum() > 20:
                # deux cartes qui se touchent : en glissant l'une sur l'autre, la partie cachee de celle de derriere
                # (jamais reconstruite) s'ouvrait en croissant de decor ; des gens en contact restent sur une carte
                front, back, how = subs, [], "un seul plan (en contact)"
    # alpha de chaque carte : l'union de ses sujets, sans fente entre voisins. Chaque masque rentre d'un pixel laissait
    # entre deux invites cote a cote une fente ou l'on voyait le decor reconstruit (un tronc sombre) : des lignes qui
    # bougent autour des gens. Les fentes de quelques pixels entre sujets detaches vont a une carte (photo), jamais au
    # decor ; seul le contour exterieur du groupe rentre d'un pixel.
    union = lambda g: np.any([s["region"] for s in g], axis=0)    # noqa: E731
    R_front = union(front)
    R_back = union(back) if back else np.zeros((H, W), bool)
    detached = R_front | R_back
    chosen = [s["mask"] for s in subs]
    rest = np.any([m for m in people if not any(m is c for c in chosen)] or [np.zeros((H, W), bool)], axis=0)
    gaps = (cv2.morphologyEx(detached.astype(np.uint8), cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0) & ~detached & ~rest
    if back:
        near_f = cv2.dilate(R_front.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        near_b = cv2.dilate(R_back.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        R_front |= gaps & near_f & ~near_b                # fente entre deux sujets de devant : carte de devant
        R_back |= gaps & ~(near_f & ~near_b)              # sinon la carte de derriere (elle est dessous)
    else:
        R_front |= gaps
    # petits trous fermes (paillettes, reflets, bijoux : SAM y laisse quelques pixels) bouches avant de rentrer le bord :
    # rentre de 2 px, chaque trou devenait une pastille ou l'on voyait le decor reconstruit (revue 4)
    tiny = max(40, round(4e-4 * W * H))
    R_front = _fill_small(R_front, tiny)
    if back:
        R_back = _fill_small(R_back, tiny) & ~R_front
    a_front = _sharp(R_front)
    a_back = _sharp(R_back) * (1 - a_front) if back else None   # un pixel ne sert qu'a un calque : celui de devant
    a_all = np.maximum(a_front, a_back) if back else a_front

    # 3) plaque : recalee hors de la forme peinte, lumiere de la photo prolongee sous les sujets
    margin = max(6, round(0.012 * W))
    # la plaque remplace la photo sur ~7 px autour du contour net : plus serre, les pixels de bord flous (cheveux, doigts,
    # sujet hors mise au point) restaient au fond en fantome (revue 3). Au repos le lecteur montre la photo : cette bande
    # n'apparait qu'a mesure que le personnage s'ecarte (shader : gapPx / near).
    edge = max(5, round(0.006 * W))
    _, blob = _painted(im, subs, crowd)
    P = _load(plate, (W, H))
    keep = ~(cv2.dilate(blob.astype(np.uint8), np.ones((15, 15), np.uint8)) > 0)
    P, mP = _align(im, P, keep.astype(np.float32))
    P = _color_match(im, P, keep)
    hole = _grow(a_all, edge)
    # bord doux du sujet (cheveux, flou) que le masque net laisse au fond : BiRefNet le voit, il passe sous la plaque
    # (revue : un fantome de l'ancien contour restait sur le decor quand la personne glissait)
    bnf = d / "raw" / "birefnet.png"
    if bnf.exists():
        bnm = np.asarray(Image.open(bnf).convert("L").resize((W, H), Image.BILINEAR), np.float32) / 255
        rr = max(6, round(0.01 * W))
        fringe = (bnm > 0.15) & (cv2.dilate((a_all > 0.5).astype(np.uint8),
                                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * rr + 1, 2 * rr + 1))) > 0)
        hole = np.maximum(hole, _grow((fringe & ~rest).astype(np.float32), 2))
    mode, lama = spec.get("plate") or PLATE, d / "raw" / "lama.png"
    if lama.exists():                                     # hors de la forme peinte, Qwen n'a rien refait : LaMa
        PL = _load(lama, (W, H))
        P = np.where(cv2.dilate(blob.astype(np.uint8), np.ones((5, 5), np.uint8))[..., None] > 0, P, PL)
    if mode in ("lama", "hybride") and lama.exists():     # LaMa : meme cadrage que la photo, rien a recaler
        if mode == "lama":
            P = PL
        else:                                             # LaMa sur 1,5 % de largeur au bord, Qwen au-dela de 3 %
            inner = cv2.distanceTransform((hole > 0.5).astype(np.uint8), cv2.DIST_L2, 5)
            wq = np.clip((inner - 0.015 * W) / (0.015 * W), 0, 1)[..., None]
            P = PL * (1 - wq) + P * wq
    else:
        mode = "qwen"
    bg = _fill_plate(im, P, hole)
    M = _grow(a_all, margin)

    # 4) calques : les couleurs de la photo (contour net : pas de « decontamination », qui calculee sur une plaque tres
    # differente, noire derriere un telephone, eclaircissait le dernier pixel du bord) ; chaque groupe est une carte
    # plate, a la profondeur de ses sujets
    def card(group):
        w = np.array([s["area"] for s in group])
        return np.full((H, W), float(np.sum(w * np.array([s["z"] for s in group])) / max(1e-9, w.sum())), np.float32)

    # (essai du 16/10 : couleur du bord « demelangee » du fond estime par LaMa -> liseré sombre ou clair de 1 px, le bord
    # rentre de 2 px est deja dans le sujet : abandonne)
    layers = []                                           # (couleur, alpha, profondeur), du plus loin au plus proche
    if a_back is not None:
        layers.append((_extend(im, a_back), a_back, card(back)))
    layers.append((_extend(im, a_front), a_front, card(front)))

    # 5) fond : un plan ajuste sur la profondeur de la photo hors des sujets detaches (la foule restee au decor compte),
    # pente bornee (le lecteur ne peut alors jamais replier l'image)
    d_bg = depth.bound_slope(depth.plane(d_im, M < 0.01))

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
    m = dict(base, n=len(layers), z=zs, focus=zs[-1], groups=how, crowd=crowd, plate=mode, depth_model=depth.best_name(),
             qc={"subjects": [{"z": round(s["z"], 3), "area": round(s["area"], 4), "held": s["held"]} for s in subs],
                 "people": n_all, "cover": round(cover, 3), "fill": round(fill, 3), "aligned": mP is not None},
             seconds=round(time.time() - t0, 1))
    (d / "meta.json").write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    return m
