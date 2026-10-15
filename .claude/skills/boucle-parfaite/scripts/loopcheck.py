"""Audit des boucles H3 (premiere image = derniere image).

Pour chaque video :
  motion : ecart moyen entre images successives (comme l'app)
  miroir : a quel point la video ressemble a sa propre lecture a l'envers (effet « aller-retour »).
           Pour chaque t, on compare l'image t a l'image N-1-t et on divise par l'ecart TYPIQUE entre deux images
           separees du meme intervalle. 1 = pas de symetrie (mouvement qui avance), proche de 0 = la deuxieme moitie
           rejoue la premiere a l'envers.
  frein  : vitesse des 12 premieres et 12 dernieres images rapportee a la vitesse du milieu (< 0,5 = H3 freine aux
           raccords : la boucle « marque un temps »).
  raccord: ecart entre la derniere et la premiere image rapporte a l'ecart moyen entre images (> 3 = saut visible).

Usage : python loopcheck.py fichier.mp4 [...]     ou     python loopcheck.py --etat etat3.json
"""
import json
import os
import subprocess
import sys

import numpy as np

ROOT = r"E:\Codex projects\Alive-Comics\projects"


def frames(path, w=192, h=108):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h},format=gray", "-f", "rawvideo", "-"],
                         capture_output=True).stdout
    f = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    # on retire la derive d'exposition globale (pompage) pour ne mesurer que les formes
    return f - f.mean(axis=(1, 2), keepdims=True)


def analyse(path):
    f = frames(path)
    n = len(f)
    d1 = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
    motion = float(d1.mean())
    # symetrie miroir
    ratios, weights = [], []
    for t in range(8, n // 2 - 6):
        s = n - 1 - 2 * t
        pal = np.abs(f[t] - f[n - 1 - t]).mean()
        idx = np.arange(0, n - s)
        typ = np.mean([np.abs(f[u] - f[u + s]).mean() for u in idx[:: max(1, len(idx) // 12)]])
        if typ > 1e-3:
            ratios.append(pal / typ)
            weights.append(typ)
    mirror = float(np.average(ratios, weights=weights)) if ratios else 1.0
    mid = d1[n // 4: 3 * n // 4].mean() + 1e-6
    brake = float(min(d1[:12].mean(), d1[-12:].mean()) / mid)
    seam = float(np.abs(f[-1] - f[0]).mean() / (d1.mean() + 1e-6))
    # forme de l'ecart a la premiere image : 1 bosse = une seule excursion (aller puis retour),
    # plusieurs bosses = rythme, plateau = flux stationnaire (pluie, fumee, passants, orbite)
    d0 = np.array([np.abs(x - f[0]).mean() for x in f])
    k = 9
    sm = np.convolve(d0, np.ones(k) / k, mode="same")
    top = sm.max() + 1e-6
    peaks = [i for i in range(k, n - k) if sm[i] == sm[i - k:i + k + 1].max() and sm[i] > 0.55 * top]
    valleys = 0
    for a, b in zip(peaks, peaks[1:]):
        if sm[a:b].min() < 0.75 * min(sm[a], sm[b]):
            valleys += 1
    bumps = 1 + valleys if peaks else 0
    plateau = float((sm[k:n - k] > 0.7 * top).mean())
    return {"motion": round(motion, 2), "miroir": round(mirror, 2), "frein": round(brake, 2), "raccord": round(seam, 2),
            "bosses": bumps, "plateau": round(plateau, 2), "n": n}


def verdict(r):
    if r["motion"] < 0.35:
        return "FIGE"
    single = r["bosses"] <= 1 and r["plateau"] < 0.6
    if r["miroir"] < 0.55 and single:
        return "ALLER-RETOUR"
    if r["miroir"] < 0.7 and single:
        return "suspect"
    if r["miroir"] < 0.55:
        return "rythme"          # va-et-vient repete (balancier, respiration) : en general acceptable
    return "ok"


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--etat":
        import urllib.request
        st = json.load(open(args[1], encoding="utf-8"))
        for slug, v in st.items():
            p = json.loads(urllib.request.urlopen("http://127.0.0.1:8790/api/projects/" + v["id"]).read())
            for cid, c in sorted(p["panels"].items()):
                ch = list((c.get("chosen") or {}).values())
                if not ch:
                    continue
                r = analyse(os.path.join(ROOT, v["id"], ch[0]))
                print(f"{slug:24s} {cid} {verdict(r):13s} {r}")
    else:
        for a in args:
            r = analyse(a)
            print(os.path.basename(a), verdict(r), r)
