"""Reparer les boucles H3 d'un livre Alive-Comics sans re-rendu (reglages du mode edition, reversibles).

Pour chaque case en boucle (sauf celles que David a validees : review == "ok") :
  1. note toutes les variantes rendues (loopcheck) et choisit la meilleure (POST /choose) ;
  2. coupe l'ARRET au raccord : H3 ralentit jusqu'a l'arret sur les premieres et dernieres images pour retomber sur
     l'image de depart. On retire ces images presque identiques tant que le mouvement total retire reste inferieur a
     une demi-image de mouvement normal : le saut au raccord est alors plus petit qu'un pas ordinaire (invisible) ;
  3. accelere le reste du freinage (edit.ease {head, tail, gain}) pour une vitesse reguliere ;
  4. liste les cases a re-rendre (aller-retour, fige, raccord visible).

Usage :
  python loopfix.py etat5.json            (applique)
  python loopfix.py etat5.json --dry      (montre seulement)
  python loopfix.py etat5.json --pages 1 3
"""
import json
import os
import sys
import urllib.request

import numpy as np

import loopcheck as LC

BASE = "http://127.0.0.1:8790/api"
ROOT = r"E:\Codex projects\Alive-Comics\projects"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "loopcache.json")


def api(m, p, b=None):
    r = urllib.request.Request(BASE + p, data=json.dumps(b).encode() if b is not None else None, method=m,
                               headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r, timeout=600).read() or b"null")


def load_cache():
    try:
        return json.load(open(CACHE, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def measure(path, cache):
    key = f"{path}|{os.path.getmtime(path)}"
    if key not in cache:
        f = LC.frames(path)
        d1 = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
        r = LC.analyse(path)
        r["d1"] = [round(float(x), 3) for x in d1]
        cache[key] = r
    return cache[key]


def score(r, orbit):
    v = LC.verdict(r)
    s = 2.0 * min(r["miroir"], 1.1) - 0.4 * r["raccord"]
    s += min(r["motion"], 2.5) if not orbit else 2.5
    return s + {"ALLER-RETOUR": -100, "FIGE": -40, "suspect": -8}.get(v, 0), v


def trim_and_ease(d1):
    """d1[i] = ecart entre l'image i et i+1. Renvoie (a, b, head, tail, gain) pour edit.range / edit.ease."""
    d1 = np.asarray(d1, dtype=float)
    n = len(d1) + 1
    mid = float(np.median(d1[n // 4: 3 * n // 4])) + 1e-6
    budget = 0.5 * mid
    a, b, used = 0, n - 1, 0.0          # on joue [a, b) : le raccord va de l'image b-1 a l'image a
    while b - a > 72:
        head_cost, tail_cost = d1[a], d1[b - 1]
        nxt = min(head_cost, tail_cost)
        if used + nxt > budget or a >= 22 or (n - 1 - b) >= 22:
            break
        used += nxt
        if head_cost <= tail_cost:
            a += 1
        else:
            b -= 1
    # freinage restant : images dont la vitesse est sous 70 % du milieu, en partant de chaque bord
    head = 0
    while a + head < b and d1[a + head] < 0.7 * mid and head < 24:
        head += 1
    tail = 0
    while b - 1 - tail > a and d1[b - 1 - tail] < 0.7 * mid and tail < 24:
        tail += 1
    slow = [d1[a:a + head].mean() if head else mid, d1[b - tail:b].mean() if tail else mid]
    gain = float(np.clip(mid / max(min(slow), 1e-3), 1.0, 3.0))
    if gain < 1.3:
        head = tail = 0
    return a, b, head, tail, round(gain, 2)


def fix_project(pid, cache, dry=False, log=print):
    p = api("GET", f"/projects/{pid}")
    redo = []
    for cid, panel in sorted(p["panels"].items()):
        if panel.get("review") == "ok":
            log(f"  {cid} validee par David : intouchee")
            continue
        plan = api("POST", "/plan", {"panel": panel, "style": p.get("style", "")})
        if not plan.get("autoplay") or not plan.get("loop"):
            continue                                  # cases pilotees au glisser (arc, orbite figee) : pas de boucle
        orbit = (panel.get("camera") or {}).get("id") == "orbit360"
        best = None
        for r in panel.get("renders") or []:
            if r.get("side") != "V":
                continue
            path = os.path.join(ROOT, pid, r["file"])
            if not os.path.exists(path):
                continue
            m = measure(path, cache)
            sc, v = score(m, orbit)
            if best is None or sc > best[0]:
                best = (sc, v, r, m)
        if not best:
            redo.append((cid, "aucun rendu"))
            continue
        sc, v, r, m = best
        a, b, head, tail, gain = trim_and_ease(m["d1"])
        edit = dict(panel.get("edit") or {})
        edit["range"] = [int(a), int(b)]
        if head or tail:
            edit["ease"] = {"head": int(head), "tail": int(tail), "gain": gain}
        else:
            edit.pop("ease", None)
        log(f"  {cid} {v:12s} motion {m['motion']:5.2f} miroir {m['miroir']:4.2f} frein {m['frein']:4.2f} "
            f"-> boucle [{a},{b}] ease {head}/{tail} x{gain}  ({os.path.basename(r['file'])})")
        if v in ("ALLER-RETOUR", "FIGE", "suspect") or m["raccord"] > 3:
            redo.append((cid, v))
        if dry:
            continue
        chosen = list((panel.get("chosen") or {}).values())
        if not chosen or chosen[0] != r["file"]:
            api("POST", f"/projects/{pid}/choose", {"panel": cid, "side": "V", "file": r["file"]})
        api("POST", f"/projects/{pid}/edit/{cid}", {"edit": edit})
    return redo


if __name__ == "__main__":
    args = sys.argv[1:]
    st = json.load(open(args[0], encoding="utf-8"))
    dry = "--dry" in args
    pages = [int(x) for x in args[args.index("--pages") + 1:] if x.isdigit()] if "--pages" in args else None
    cache = load_cache()
    todo = {}
    for i, (slug, v) in enumerate(st.items(), 1):
        if pages and i not in pages:
            continue
        print(slug)
        todo[slug] = fix_project(v["id"], cache, dry)
        json.dump(cache, open(CACHE, "w", encoding="utf-8"))
    print("\nA RE-RENDRE :", {k: v for k, v in todo.items() if v})
