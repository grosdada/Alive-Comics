"""Assemblage d'une planche : videos du lecteur (tout-intra), sons, donnees, lecteur -> projects/<id>/export/.

Types de case (presets.plan_panel) :
  arc    deux demi-arcs L et R : L inverse + R sans sa 1re image, la case au milieu (center = nL - 1)
  loop   orbite 360 (1re = derniere image), tourne sans fin au glisser
  seul   une video, la case au debut ; autoplay = aller-retour, ou vers l'avant si elle boucle
  static pas de video
L'export est un livre d'une page (index.html + book.js) et contient aussi manga_data.js, pour
pouvoir etre repris tel quel dans un livre de plusieurs pages (tools/build_book.py).
"""

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

from . import presets, store

ROOT = Path(__file__).resolve().parent.parent
PLAYER = ROOT / "player"
FPS = 24
ENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-g", "1", "-keyint_min", "1",
       "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"]
NOFLASH = {"creationflags": 0x08000000} if hasattr(subprocess, "CREATE_NO_WINDOW") else {}


def frames(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                          "stream=nb_read_frames", "-of", "json", str(video)], capture_output=True, text=True,
                         **NOFLASH).stdout
    return int(json.loads(out)["streams"][0]["nb_read_frames"])


def has_audio(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0",
                          str(video)], capture_output=True, text=True, **NOFLASH).stdout
    return bool(out.strip())


# niveaux cibles (LUFS) : la voix devant, l'ambiance derriere, les bruitages entre les deux
LEVELS = {"audio": -24, "voice": -17, "foley": -21, "page": -23}


def normalize(src, dst, layer):
    """Copie un son en mp3 au niveau cible de sa couche (les curseurs de volume restent comparables)."""
    ffmpeg(["-i", str(src), "-vn", "-af", f"loudnorm=I={LEVELS[layer]}:TP=-1.5:LRA=11", "-ar", "44100",
            "-c:a", "libmp3lame", "-q:a", "2", str(dst)])


def ffmpeg(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True, text=True, **NOFLASH)
    if r.returncode:
        raise RuntimeError("ffmpeg : " + r.stderr[-1200:])


def grow(poly, px):
    """Elargit le polygone (la video passe sous le trait)."""
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    out = []
    for x, y in poly:
        dx, dy = x - cx, y - cy
        d = (dx * dx + dy * dy) ** 0.5 or 1
        out.append([round(x + dx / d * px, 1), round(y + dy / d * px, 1)])
    return out


def _encode(srcs, player, dst):
    if player == "arc":
        ffmpeg(["-i", str(srcs["L"]), "-i", str(srcs["R"]), "-filter_complex",
                "[0:v]reverse,setpts=PTS-STARTPTS[l];[1:v]trim=start_frame=1,setpts=PTS-STARTPTS[r];"
                "[l][r]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-r", str(FPS), *ENC, str(dst)])
        return frames(srcs["L"]) - 1
    ffmpeg(["-i", str(srcs["V"]), "-map", "0:v:0", "-r", str(FPS), *ENC, str(dst)])
    return 0


def _mtime(f):
    try:
        return round(Path(f).stat().st_mtime, 3)
    except OSError:
        return None


def page_key(p, d):
    """Empreinte de tout ce qui change la page exportee : si elle n'a pas bouge, l'export existant est bon."""
    panels = {}
    for pid_, panel in sorted((p.get("panels") or {}).items()):
        plan = presets.plan_panel(panel, p.get("style", ""))
        chosen = panel.get("chosen") or {}
        layers = {}
        for layer, keys in (("audio", ("mode", "file", "volume")), ("voice", ("mode", "file", "volume", "loop")),
                            ("foley", ("on", "engine", "file", "volume"))):
            cur = panel.get(layer) or {}
            layers[layer] = {k: cur.get(k) for k in keys}
            if cur.get("file"):
                layers[layer]["mtime"] = _mtime(d / cur["file"])
        panels[pid_] = {"player": plan["player"], "autoplay": plan["autoplay"], "loop": plan["loop"],
                        "sides": [j["side"] for j in plan["jobs"]],
                        "chosen": {k: [v, _mtime(d / v)] for k, v in sorted(chosen.items())}, "layers": layers}
    ps = p.get("pageSound") or {}
    page_sound = {k: ps.get(k) for k in ("mode", "file", "volume")}
    if ps.get("file"):
        page_sound["mtime"] = _mtime(d / ps["file"])
    blob = {"v": 3, "name": p.get("name"), "geometry": p.get("geometry"), "pageSound": page_sound,
            "stroke": (p.get("page") or {}).get("strokeWidth"), "panels": panels,
            "page": [_mtime(d / "page" / n) for n in ("page.jpg", "frames.png")],
            "player": [_mtime(PLAYER / n) for n in ("book.html", "alive-player.js", "alive-player.css")]}
    return hashlib.sha1(json.dumps(blob, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def build(pid, log=print, force=False):
    p = store.get(pid)
    d = store.pdir(pid)
    geo = p.get("geometry") or {}
    if not geo.get("panels"):
        raise ValueError("géométrie de la planche absente : ouvrir la planche dans l'éditeur une fois")
    out = d / "export"
    (out / "videos").mkdir(parents=True, exist_ok=True)
    (out / "sons").mkdir(parents=True, exist_ok=True)
    cache_f = out / ".cache.json"
    cache = json.loads(cache_f.read_text(encoding="utf-8")) if cache_f.exists() else {}
    pkey = page_key(p, d)
    done = cache.get("_page") or {}
    if not force and done.get("key") == pkey and (out / "index.html").exists() and done.get("result"):
        return dict(done["result"], cached=True)          # rien n'a change : la page deja assemblee est bonne
    sons_cache = cache.setdefault("_sons", {})

    def norm(src, name, layer):
        """Egalise un son, sauf s'il l'a deja ete a l'identique."""
        dst = out / "sons" / name
        sig = f"{src}|{_mtime(src)}|{layer}|{LEVELS[layer]}"
        if sons_cache.get(name) != sig or not dst.exists():
            normalize(src, dst, layer)
            sons_cache[name] = sig
        return dst
    for name in ("page.jpg", "frames.png"):
        src = d / "page" / name
        if not src.exists():
            raise FileNotFoundError(f"{name} manquant : l'éditeur l'envoie à chaque enregistrement")
        shutil.copy2(src, out / name)
    stroke = float((p.get("page") or {}).get("strokeWidth", 4))
    data = {"page": "page.jpg", "frames": "frames.png", "size": geo["size"], "fps": FPS, "panels": []}
    report = []
    for g in geo["panels"]:
        panel = p["panels"].get(g["id"]) or {}
        plan = presets.plan_panel(panel, p.get("style", ""))
        entry = {"id": g["id"], "rect": [round(v) for v in g["rect"]], "poly": grow(g["poly"], stroke / 2 + 1),
                 "video": None}
        chosen = panel.get("chosen") or {}
        need = [j["side"] for j in plan["jobs"]]
        srcs = {s: d / chosen[s] for s in need if chosen.get(s) and (d / chosen[s]).exists()}
        if plan["player"] != "static" and need and len(srcs) == len(need):
            dst = out / "videos" / f"{g['id']}.mp4"
            key = json.dumps({"player": plan["player"], "src": {s: [str(f), f.stat().st_mtime] for s, f in srcs.items()}})
            if cache.get(g["id"], {}).get("key") == key and dst.exists():
                center, n = cache[g["id"]]["center"], cache[g["id"]]["frames"]
            else:
                log(f"{g['id']} : encodage ({plan['player']})")
                center = _encode(srcs, plan["player"], dst)
                n = frames(dst)
                cache[g["id"]] = {"key": key, "center": center, "frames": n}
            entry.update(video=f"videos/{dst.name}", frames=n, center=center,
                         loop=plan["loop"] or plan["player"] == "loop", autoplay=plan["autoplay"])
            report.append(f"{g['id']} {plan['player']} {n} images")
        elif plan["player"] != "static" and need:
            report.append(f"{g['id']} : rendu manquant ({', '.join(s for s in need if s not in srcs)})")
        # ---- sons : 1 ambiance / musique (boucle), 2 voix off ou second son, 3 bruitages (foley)
        aud = panel.get("audio") or {}
        if aud.get("mode") in ("file", "generate") and aud.get("file") and (d / aud["file"]).exists():
            src = d / aud["file"]
            name = f"{g['id']}.mp3"
            norm(src, name, "audio")
            entry["audio"] = f"sons/{name}"
            entry["audioVol"] = float(aud.get("volume", 0.8))
        voice = panel.get("voice") or {}
        if voice.get("mode") in ("file", "tts", "music") and voice.get("file") and (d / voice["file"]).exists():
            src = d / voice["file"]
            name = f"{g['id']}_voix.mp3"
            norm(src, name, "voice")
            entry["voice"] = {"src": f"sons/{name}", "vol": float(voice.get("volume", 1.0)),
                              "loop": bool(voice.get("loop", voice.get("mode") == "music"))}
        foley = panel.get("foley") or {}
        if foley.get("on") and entry.get("video"):
            name = f"{g['id']}_foley.mp3"
            src = None
            if foley.get("engine", "h3") == "h3":
                side = "R" if plan["player"] == "arc" else "V"
                vid = d / chosen[side] if chosen.get(side) else None
                if vid and vid.exists() and has_audio(vid):
                    src = norm(vid, name, "foley")
                else:
                    report.append(f"{g['id']} : pas de piste son H3 dans ce rendu (refaire le rendu, ou bruitages cloud)")
            elif foley.get("file") and (d / foley["file"]).exists():
                src = norm(d / foley["file"], name, "foley")
            if src:
                entry["foley"] = {"src": f"sons/{name}", "vol": float(foley.get("volume", 0.9)),
                                  "sync": bool(entry.get("autoplay"))}
        data["panels"].append(entry)
    ps = p.get("pageSound") or {}
    if ps.get("mode") in ("file", "generate") and ps.get("file") and (d / ps["file"]).exists():
        norm(d / ps["file"], "page.mp3", "page")
        data["sound"] = {"src": "sons/page.mp3", "vol": float(ps.get("volume", 0.7))}
    (out / "manga_data.js").write_text("window.MANGA = " + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8")
    book = {"title": p.get("name", "Planche"), "pages": [{"title": p.get("name", ""), "base": "", "data": data}]}
    (out / "book.js").write_text("window.ALIVE_BOOK = " + json.dumps(book, ensure_ascii=False) + ";\n", encoding="utf-8")
    shutil.copy2(PLAYER / "book.html", out / "index.html")
    for f in ("alive-player.js", "alive-player.css"):
        shutil.copy2(PLAYER / f, out / f)
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    # ne garder que les videos et sons encore utilises
    used = ({e.get("video") for e in data["panels"]} | {e.get("audio") for e in data["panels"]}
            | {(e.get("voice") or {}).get("src") for e in data["panels"]}
            | {(e.get("foley") or {}).get("src") for e in data["panels"]}
            | {(data.get("sound") or {}).get("src")})
    for sub in ("videos", "sons"):
        for f in (out / sub).iterdir():
            if f"{sub}/{f.name}" not in used:
                f.unlink()
    result = {"ok": True, "report": report, "url": f"/projects/{pid}/export/index.html",
              "videos": sum(1 for e in data["panels"] if e.get("video")), "panels": len(data["panels"])}
    cache["_page"] = {"key": pkey, "result": result}
    cache_f.write_text(json.dumps(cache), encoding="utf-8")
    return dict(result, cached=False)


def build_book(book, out, log=print):
    """Livre de plusieurs planches : book = {"title", "pages": [project_id...]} -> dossier out."""
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    pages = []
    for i, pid in enumerate(book["pages"]):
        build(pid, log)
        src = store.pdir(pid) / "export"
        base = f"pages/{i + 1:02d}-{store.slug(store.get(pid).get('name', pid))}/"
        data = json.loads((src / "manga_data.js").read_text(encoding="utf-8").split("=", 1)[1].strip().rstrip(";"))
        files = [data["page"], data["frames"]] + [e[k] for e in data["panels"] for k in ("video", "audio") if e.get(k)]
        files += [e[k]["src"] for e in data["panels"] for k in ("voice", "foley") if e.get(k)]
        if data.get("sound"):
            files.append(data["sound"]["src"])
        for rel in files:
            (out / base / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src / rel, out / base / rel)
        pages.append({"title": store.get(pid).get("name", ""), "base": base, "data": data})
    (out / "book.js").write_text("window.ALIVE_BOOK = " + json.dumps({"title": book["title"], "pages": pages},
                                                                       ensure_ascii=False) + ";\n", encoding="utf-8")
    shutil.copy2(PLAYER / "book.html", out / "index.html")
    for f in ("alive-player.js", "alive-player.css"):
        shutil.copy2(PLAYER / f, out / f)
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    return out
