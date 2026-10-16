"""Piles Lytro synthetiques (scene en plans, parallaxe exacte, temps vraiment arrete) pour tester le lecteur
lytro-viewer sur l'axe vertical et la grille 2D, que les rendus H3 ne fournissent pas.

    python tools/lytro_synth.py [dossier]        (defaut : lytro-viewer/demo)

Sortie : <dossier>/synth-grille/ (grille 9 x 5, meta.grid) et <dossier>/synth-y/ (colonne du milieu, axe y), au
format de docs/ROADMAP-LYTRO-CLOUD.md (section 2). Index d'une vue de la grille : ligne * colonnes + colonne,
colonnes de gauche a droite, lignes de bas en haut (s croissante = camera qui monte, comme l'axe y).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W = 768                      # largeur livree
SS = 2                       # sur-echantillonnage (bords lisses)
M = 48                       # marge des plans (px livres) : place pour les decalages
COLS, ROWS = 9, 5
SX = np.linspace(-15, 15, COLS)      # parallaxe fond / sujet de chaque colonne (px a la largeur W)
SY = np.linspace(-8, 8, ROWS)
D_SUBJ = 0.72                        # disparite du sujet (epingle : il ne bouge pas)


def font(px):
    for name in ("DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            pass
    return ImageFont.load_default()


def layers():
    """Plans RGBA (taille W + 2M, sur-echantillonnes) et leur disparite (0 = loin, 1 = proche)."""
    S = (W + 2 * M) * SS
    rng = np.random.default_rng(7)
    out = []
    # fond : ciel degrade, immeubles en briques, texte
    y = np.linspace(0, 1, S)[:, None, None]
    bg = np.concatenate([0.35 + 0.3 * y, 0.45 + 0.25 * y, 0.65 + 0.1 * y], 2) * np.ones((S, S, 3))
    im = Image.fromarray((bg * 255).astype(np.uint8)).convert("RGBA")
    dr = ImageDraw.Draw(im)
    for k in range(9):
        x0 = k * S // 9
        top = int(S * (0.25 + 0.35 * rng.random()))
        col = tuple(int(v) for v in rng.integers(90, 170, 3))
        dr.rectangle([x0, top, x0 + S // 9 - 6 * SS, S], fill=col + (255,))
        for yy in range(top + 10 * SS, S, 22 * SS):
            for xx in range(x0 + 8 * SS, x0 + S // 9 - 20 * SS, 26 * SS):
                dr.rectangle([xx, yy, xx + 12 * SS, yy + 10 * SS], fill=(240, 220, 140, 255) if rng.random() < .4 else (40, 50, 60, 255))
    dr.text((60 * SS, 40 * SS), "ALIVE COMICS  1987", font=font(44 * SS), fill=(255, 255, 255, 255))
    out.append((im, 0.0))
    # plan moyen : panneau a damier
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    x0, y0, x1, y1 = int(S * .56), int(S * .38), int(S * .92), int(S * .86)
    q = 18 * SS
    for yy in range(y0, y1, q):
        for xx in range(x0, x1, q):
            c = (200, 60, 50, 255) if ((xx - x0) // q + (yy - y0) // q) % 2 else (245, 240, 230, 255)
            dr.rectangle([xx, yy, min(x1, xx + q) - 1, min(y1, yy + q) - 1], fill=c)
    dr.rectangle([x0, y0, x1, y1], outline=(30, 30, 30, 255), width=4 * SS)
    out.append((im, 0.42))
    # sujet : disque a anneaux et texte (au centre, epingle)
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    cx, cy, r = S * .42, S * .52, S * .2
    for k in range(10, 0, -1):
        rr = r * k / 10
        dr.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(250, 200, 60, 255) if k % 2 else (40, 70, 160, 255))
    dr.text((cx - 70 * SS, cy - 26 * SS), "NET", font=font(52 * SS), fill=(255, 255, 255, 255), stroke_width=3 * SS, stroke_fill=(0, 0, 0, 255))
    out.append((im, D_SUBJ))
    # premier plan : deux poteaux rayes
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    for x0 in (int(S * .1), int(S * .22)):
        for yy in range(0, S, 30 * SS):
            dr.rectangle([x0, yy, x0 + 26 * SS, yy + 15 * SS], fill=(20, 20, 20, 255))
            dr.rectangle([x0, yy + 15 * SS, x0 + 26 * SS, yy + 30 * SS], fill=(235, 235, 235, 255))
    out.append((im, 1.0))
    return out


def render(lay, sx, sy):
    """Vue : chaque plan decale de s * (D_SUBJ - d) / D_SUBJ (le fond de s, le sujet fixe), composite de l'arriere
    vers l'avant ; disparite composee de la meme facon."""
    S = W * SS
    col = np.zeros((S, S, 3), np.float32)
    dep = np.zeros((S, S), np.float32)
    for im, d in lay:
        g = (D_SUBJ - d) / D_SUBJ
        ox, oy = sx * g * SS, sy * g * SS
        # contenu au point x de la photo -> x + s * g dans la vue : on lit le plan en (x - s g)
        sh = im.transform(im.size, Image.AFFINE, (1, 0, -ox, 0, 1, -oy), resample=Image.BILINEAR)
        a = np.asarray(sh, np.float32)[M * SS:M * SS + S, M * SS:M * SS + S] / 255
        al = a[..., 3:4]
        col = col * (1 - al) + a[..., :3] * al
        dep = dep * (1 - al[..., 0]) + d * al[..., 0]
    v = Image.fromarray((col * 255 + .5).astype(np.uint8)).resize((W, W), Image.LANCZOS)
    dm = Image.fromarray((dep * 255 + .5).astype(np.uint8)).resize((W // 2, W // 2), Image.BILINEAR)
    return v, dm


def save(out, views, meta):
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*"):
        f.unlink()
    for j, (v, dm) in enumerate(views):
        v.save(out / f"v{j:02d}.jpg", quality=90)
        dm.save(out / f"d{j:02d}.png")
    (out / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "lytro-viewer/demo")
    lay = layers()
    grid = [render(lay, sx, sy) for sy in SY for sx in SX]       # ligne par ligne, du bas vers le haut
    c = (ROWS // 2) * COLS + COLS // 2
    base = {"w": W, "h": W, "sides": "deux", "depth": "exacte (scene synthetique)", "crop": [0, 0]}
    save(root / "synth-grille", grid, dict(base, n=len(grid), center=c, axis="x", grid=[COLS, ROWS],
                                          sx=[round(float(x), 2) for x in SX], sy=[round(float(y), 2) for y in SY],
                                          s=[round(float(x), 2) for x in SX]))
    colv = [grid[r * COLS + COLS // 2] for r in range(ROWS)]
    save(root / "synth-y", colv, dict(base, n=ROWS, center=ROWS // 2, axis="y", s=[round(float(y), 2) for y in SY]))
    print(f"{root}/synth-grille : {len(grid)} vues ; {root}/synth-y : {ROWS} vues")


if __name__ == "__main__":
    main()
