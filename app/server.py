"""Serveur local d'Alive-Comics (bibliotheque standard uniquement).

    python -m app.server            (ou Lancer_Alive_Comics.bat)

Sert l'interface (app/web), le lecteur (player/), les fichiers des projets (avec requetes Range,
indispensables pour sauter dans les videos) et l'API JSON /api/... .
"""

import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import assemble, compose, depth, director, edit, falapi, geometry, jobs, layers, llm, presets, publish, settings, sounds, store

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "app" / "web"
PLAYER = ROOT / "player"
BOOKS = ROOT / "data" / "books.json"
FOLDERS = ROOT / "data" / "folders.json"      # projets de rangement : {"folders": [{id, name, color}], "assign": {planche: projet}}
VERSION = "0.1.0"
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("audio/mpeg", ".mp3")


def open_folder(path):
    """Ouvre un dossier dans l'explorateur du poste (le serveur tourne sur la machine de l'utilisateur)."""
    path = Path(path)
    if not path.is_dir():
        raise FileNotFoundError(str(path))
    if os.name == "nt":
        os.startfile(str(path))                      # noqa: S606 - dossier interne a l'application
    else:
        import subprocess
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])


class ApiError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def merge_project(server_p, ui_p):
    """La version de l'interface gagne, sauf ce que le moteur ecrit : rendus, choix, sons generes."""
    out = dict(ui_p)
    out["id"], out["created"] = server_p["id"], server_p.get("created")
    panels = {}
    for pid, panel in (ui_p.get("panels") or {}).items():
        old = (server_p.get("panels") or {}).get(pid, {})
        panel = dict(panel)
        panel["renders"] = old.get("renders", [])
        panel["chosen"] = old.get("chosen", {})
        if old.get("layers"):                       # relief en couches : ecrit par la file de rendus
            panel["layers"] = old["layers"]
        for k in ("edit", "extraSounds", "prompt_override", "review", "relief", "treatment", "couches"):   # mode edition
            if k not in panel and k in old:
                panel[k] = old[k]
        for layer in ("audio", "voice", "foley"):
            cur = dict(panel.get(layer) or {})
            prev = old.get(layer) or {}
            cur["generated"] = prev.get("generated", [])
            if prev.get("file") and cur.get("file") != "":
                cur["file"] = prev["file"]
            panel[layer] = cur
        panels[pid] = panel
    out["panels"] = panels
    # son global : l'import et le moteur l'ecrivent aussi ; « rev » dit qui est le plus recent
    prev, cur = server_p.get("pageSound") or {}, dict(ui_p.get("pageSound") or {})
    if (prev.get("rev") or 0) > (cur.get("rev") or 0):
        out["pageSound"] = prev                       # interface en retard : la version du serveur gagne
    else:
        cur["generated"] = prev.get("generated", [])
        out["pageSound"] = cur
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "AliveComics/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        first = str(args[0]) if args else ""
        if "/api/jobs" in first or "/api/workers" in first:
            return
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------------------------------------------------------- reponses
    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, cache="no-cache"):
        path = Path(path)
        if not path.is_file():
            self.send_error(404)
            return
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
        if m and size:
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(262144, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                    return
                left -= len(chunk)

    def body(self):
        # le corps est lu UNE fois des l'arrivee de la requete (route) : sinon, en keep-alive, des octets non lus
        # se collent a la requete suivante (« {}GET ... » -> erreur 501)
        return getattr(self, "_raw", b"")

    def jbody(self):
        raw = self.body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    # ---------------------------------------------------------- routage
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        n = int(self.headers.get("Content-Length") or 0)
        self._raw = self.rfile.read(n) if n else b""
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if path.startswith("/api/"):
                return self.api(method, path[5:].strip("/").split("/"), q)
            if method not in ("GET", "HEAD"):
                raise ApiError("méthode non permise", 405)
            if path in ("/", "/index.html"):
                return self.send_file(WEB / "index.html")
            if path.startswith("/web/"):
                return self.send_file(self.inside(WEB, path[5:]))
            if path.startswith("/player/"):
                return self.send_file(self.inside(PLAYER, path[8:]))
            if path.startswith("/projects/"):
                pid, _, rel = path[10:].partition("/")
                return self.send_file(store.path(pid, rel))
            self.send_error(404)
        except sounds.Duplicate as e:            # son deja utilise ailleurs : l'interface previent (et peut forcer)
            self.send_json({"error": str(e), "duplicate": True, "used": e.used}, 409)
        except ApiError as e:
            self.send_json({"error": str(e)}, e.status)
        except FileNotFoundError as e:
            self.send_json({"error": "introuvable : %s" % e}, 404)
        except (PermissionError, ValueError) as e:
            self.send_json({"error": str(e)}, 400)
        except (llm.LLMError, falapi.FalError, publish.PublishError) as e:
            self.send_json({"error": str(e)}, 502)
        except Exception as e:                    # noqa: BLE001
            traceback.print_exc()
            self.send_json({"error": "%s: %s" % (e.__class__.__name__, e)}, 500)

    @staticmethod
    def inside(base, rel):
        base = base.resolve()
        f = (base / rel).resolve()
        if base not in f.parents:
            raise PermissionError(rel)
        return f

    # ---------------------------------------------------------- API
    def api(self, m, parts, q):
        S = jobs.SCHEDULER
        head = parts[0]
        if head == "info" and m == "GET":
            return self.send_json({"version": VERSION, "llm": llm.available(),
                                   "fal": bool(settings.load()["fal"].get("key"))})
        if head == "presets" and m == "GET":
            return self.send_json(presets.public())
        if head == "layouts" and m == "GET":          # decoupages prets (pilotage par API)
            return self.send_json([{"id": k, "label": v[0]} for k, v in geometry.PRESETS.items()]
                                  + [{"id": "random:N", "label": "N cases au hasard (ex. random:6)"}])
        if head == "plan" and m == "POST":
            b = self.jbody()
            plan = presets.plan_panel(b.get("panel") or {}, b.get("style", ""))
            for j in plan["jobs"]:
                j["full_prompt"] = jobs.full_prompt(j["mode"], j["prompt"])
            ok, msg = presets.compatible(((b.get("panel") or {}).get("camera") or {}).get("id", "fixe"),
                                         ((b.get("panel") or {}).get("action") or {}).get("id", "fige"))
            return self.send_json(dict(plan, warning=msg))
        if head == "settings":
            if m == "GET":
                return self.send_json(settings.public())
            if m == "PUT":
                res = settings.update(self.jbody())
                S.refresh_workers()
                return self.send_json(res)
        if head == "workers" and m == "GET":
            return self.send_json(S.workers_status())
        if head == "jobs":
            if len(parts) == 1 and m == "GET":
                js = S.list(q.get("project"))
                if q.get("active"):                     # seulement ce qui calcule ou attend (pastilles de l'accueil)
                    js = [j for j in js if j["status"] in ("queued", "running")]
                return self.send_json(js)
            if len(parts) == 3 and parts[2] == "cancel" and m == "POST":
                return self.send_json({"ok": S.cancel(parts[1])})
            if len(parts) == 2 and parts[1] == "clear" and m == "POST":
                S.clear_finished(self.jbody().get("project"))
                return self.send_json({"ok": True})
        if head == "llm":
            if parts[1:] == ["suggest"] and m == "POST":
                b = self.jbody()
                img = store.path(b["project"], f"start/{b['panel']}.png")
                if not img.exists():
                    raise ApiError("importer une image dans la case d'abord")
                return self.send_json(llm.suggest_panel(img, b.get("camera", "arc"), b.get("action", "fige"),
                                                        b.get("audio"), b.get("note", "")))
            if parts[1:] == ["translate"] and m == "POST":
                b = self.jbody()
                return self.send_json({"text": llm.translate(b.get("text", ""), b.get("purpose", "video"))})
            if parts[1:] == ["test"] and m == "POST":
                b = self.jbody()
                return self.send_json({"text": llm.chat("Réponds juste : OK", provider=b.get("provider"), max_tokens=20)})
            if parts[1:] == ["models"] and m == "GET":
                return self.send_json(llm.list_models(q.get("provider", "anthropic")))
            if parts[1:] == ["voice"] and m == "POST":
                b = self.jbody()
                img = store.path(b["project"], f"start/{b['panel']}.png")
                return self.send_json({"text": llm.voice_line(img if img.exists() else None, b.get("note", ""),
                                                              b.get("language", "French"))})
        if head == "fal" and parts[1:] == ["test"] and m == "POST":
            ok, msg = falapi.check_key(settings.load()["fal"].get("key", ""))
            return self.send_json({"ok": ok, "message": msg})
        if head == "publish":
            if parts[1:] == ["key"] and m == "GET":
                return self.send_json({"public_key": publish.ensure_key()})
            if parts[1:] == ["test"] and m == "POST":
                return self.send_json({"ok": publish.test()})
        if head == "userpresets":                    # prereglages de l'utilisateur (tremble), pour toutes les planches
            if m == "GET":
                return self.send_json(edit.user_presets())
            if m == "POST":
                return self.send_json(edit.save_user_preset(self.jbody()))
        if head == "books":
            return self.books(m, parts, q)
        if head == "folders":                        # rangement des planches par projet (distinct des livres)
            if m == "GET":
                return self.send_json(json.loads(FOLDERS.read_text(encoding="utf-8")) if FOLDERS.exists() else {"folders": [], "assign": {}})
            if m == "PUT":
                b = self.jbody()
                ids = {f["id"] for f in b.get("folders", [])}
                clean = {"folders": [{"id": f["id"], "name": str(f.get("name") or "Projet"), "color": f.get("color") or "#f2b45c"}
                                     for f in b.get("folders", [])],
                         "assign": {k: v for k, v in (b.get("assign") or {}).items() if v in ids}}
                FOLDERS.parent.mkdir(exist_ok=True)
                FOLDERS.write_text(json.dumps(clean, indent=1, ensure_ascii=False), encoding="utf-8")
                return self.send_json({"ok": True})
        if head == "projects":
            return self.projects(m, parts, q)
        raise ApiError("route inconnue : /api/" + "/".join(parts), 404)

    def projects(self, m, parts, q):
        S = jobs.SCHEDULER
        if len(parts) == 1:
            if m == "GET":
                return self.send_json(store.list_projects())
            if m == "POST":
                b = self.jbody()
                page, layout, nxt = b.get("page"), b.get("layout"), None
                if not layout:                         # pilotage : format + sens + decoupage pret (ou au hasard)
                    w, hh = geometry.page_size(b.get("format", "bd"), b.get("orientation", "portrait"))
                    page = dict(geometry.PAGE_DEFAULTS, format=b.get("format", "bd"),
                                orientation=b.get("orientation", "portrait"), width=w, height=hh, **(page or {}))
                    preset = b.get("preset") or "3x2"
                    if preset.startswith("random:"):
                        layout, nxt = geometry.random_layout(int(preset.split(":")[1]), float(b.get("tilt", 0.05)), b.get("seed"))
                    else:
                        layout, nxt = geometry.make_layout(preset)
                p = store.create(b.get("name") or "Nouvelle planche", page, layout)
                ids = geometry.leaves(p["layout"])

                def init(pp):
                    for i in ids:
                        pp["panels"].setdefault(i, store.new_panel())
                    pp["nextId"] = nxt or (max([int(i[1:]) for i in ids if i[1:].isdigit()] or [0]) + 1)
                p = store.mutate(p["id"], init)
                if not b.get("layout"):
                    compose.compose(p["id"])
                    p = store.get(p["id"])
                return self.send_json(p)
        pid = parts[1]
        sub = parts[2] if len(parts) > 2 else ""
        if not sub:
            if m == "GET":
                return self.send_json(store.get(pid))
            if m == "PUT":
                ui = self.jbody()
                with store._lock:
                    merged = merge_project(store.get(pid), ui)
                    return self.send_json(store.save(merged))
            if m == "DELETE":
                store.trash(pid)
                return self.send_json({"ok": True})
        if sub == "upload" and m == "POST":
            data = self.body()
            name = q.get("name") or "fichier"
            stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
            snd = None
            if q.get("kind") in ("page", "audio", "voice"):    # sons : jamais deux fois le meme fichier
                snd = sounds.place(pid, data, name, q.get("force") == "1")
                rel = snd["file"]
            else:
                rel = store.write_file(pid, "assets", f"{stamp}-{name}", data)
            if q.get("kind") == "page":
                store.mutate(pid, lambda p: p.setdefault("pageSound", {}).update(mode="file", file=rel, name=name,
                                                                                rev=time.time()))
            if q.get("kind") in ("audio", "voice") and q.get("panel"):
                def setaud(p):
                    aud = p["panels"].setdefault(q["panel"], {}).setdefault(q["kind"], {})
                    aud.update(mode="file", file=rel, name=name)
                store.mutate(pid, setaud)
            return self.send_json(dict(snd or {}, file=rel, url=f"/projects/{pid}/{rel}"))
        if sub == "rev" and m == "GET":                 # numero de version (l'interface se recharge s'il bouge)
            p = store.get(pid)
            return self.send_json({"rev": p.get("rev", 0), "updated": p.get("updated")})
        if sub == "compose" and m == "POST":            # images de depart + page, cote serveur
            b = self.jbody()
            return self.send_json(compose.compose(pid, b.get("panels")))
        if sub == "update" and m == "POST":             # reglages de la planche (nom, style, page, son global, decoupage)
            b = self.jbody()

            def upd(p):
                for k in ("name", "style"):
                    if k in b:
                        p[k] = b[k]
                if isinstance(b.get("page"), dict):
                    p["page"] = dict(p.get("page") or {}, **b["page"])
                    if "format" in b["page"] or "orientation" in b["page"]:
                        w, hh = geometry.page_size(p["page"].get("format", "bd"), p["page"].get("orientation", "portrait"))
                        p["page"].update(width=w, height=hh)
                if isinstance(b.get("pageSound"), dict):
                    p["pageSound"] = dict(p.get("pageSound") or {}, **b["pageSound"], rev=time.time())
                if isinstance(b.get("layout"), dict):
                    p["layout"] = b["layout"]
                    for i in geometry.leaves(p["layout"]):
                        p["panels"].setdefault(i, store.new_panel())
            return self.send_json(store.mutate(pid, upd))
        if sub == "panels" and len(parts) == 4 and m == "POST":     # reglages d'une case (cles remplacees en entier)
            b = self.jbody()
            allowed = {"camera", "action", "audio", "voice", "foley", "seed", "view"}
            bad = set(b) - allowed
            if bad:
                raise ApiError("clés inconnues : " + ", ".join(sorted(bad)) + " (permises : " + ", ".join(sorted(allowed)) + ")")

            def setp(p):
                panel = p["panels"].get(parts[3])
                if panel is None:
                    raise KeyError(parts[3])
                for k, v in b.items():
                    if k in ("audio", "voice", "foley") and isinstance(v, dict):
                        old = panel.get(k) or {}
                        v = dict(v, generated=old.get("generated", []))
                        if "file" not in v and v.get("mode") == old.get("mode"):
                            v["file"] = old.get("file")
                    panel[k] = v
            p = store.mutate(pid, setp)
            return self.send_json(p["panels"][parts[3]])
        if sub == "panels" and len(parts) == 5 and parts[4] in ("image", "sound") and m == "POST":
            data = self.body()
            name = q.get("name") or ("image.png" if parts[4] == "image" else "son.mp3")
            stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
            snd = None
            if parts[4] == "sound":                           # sons : jamais deux fois le meme fichier
                if q.get("layer", "audio") not in ("audio", "voice", "extra"):
                    raise ApiError("layer : audio, voice ou extra (son ajouté en plus)")
                snd = sounds.place(pid, data, name, q.get("force") == "1")
                rel = snd["file"]
            else:
                rel = store.write_file(pid, "assets", f"{stamp}-{name}", data)
            if parts[4] == "image":
                from PIL import Image
                with Image.open(store.path(pid, rel)) as im:
                    w, hh = im.size

                def setimg(p):
                    panel = p["panels"].get(parts[3])
                    if panel is None:
                        raise KeyError(parts[3])
                    panel["image"] = {"file": rel, "url": f"/projects/{pid}/{rel}", "w": w, "h": hh, "name": name}
                    panel["view"] = {"zoom": 1, "ox": 0, "oy": 0}
                    panel["startSig"] = None
                store.mutate(pid, setimg)
                return self.send_json({"file": rel, "w": w, "h": hh})
            layer = q.get("layer", "audio")
            if layer not in ("audio", "voice", "extra"):
                raise ApiError("layer : audio, voice ou extra (son ajouté en plus)")
            if layer == "extra":
                p = store.mutate(pid, lambda pp: edit.add_extra_sound(pp, parts[3], rel, name))
                return self.send_json(dict(snd, layer=layer, extra=p["panels"][parts[3]]["extraSounds"]))

            def setsnd(p):
                panel = p["panels"].get(parts[3])
                if panel is None:
                    raise KeyError(parts[3])
                panel.setdefault(layer, {}).update(mode="file", file=rel, name=name)
            store.mutate(pid, setsnd)
            return self.send_json(dict(snd, layer=layer))
        if sub == "start" and m == "POST":
            rel = store.write_file(pid, "start", f"{parts[3]}.png", self.body())
            return self.send_json({"file": rel})
        if sub == "page" and m == "POST":
            name = q.get("name", "")
            if name not in ("page.jpg", "frames.png", "thumb.jpg"):
                raise ApiError("nom de fichier de page invalide")
            rel = store.write_file(pid, "page", name, self.body())
            if name == "thumb.jpg":
                store.mutate(pid, lambda p: p.update(thumb=f"/projects/{pid}/{rel}"))
            return self.send_json({"file": rel})
        if sub == "estimate" and m == "POST":
            return self.send_json(S.estimate(pid, self.jbody().get("panels", [])))
        if sub == "render" and m == "POST":
            b = self.jbody()
            created, errors = [], []
            missing = [x for x in b.get("panels", []) if not store.path(pid, f"start/{x}.png").exists()]
            if missing or not store.get(pid).get("geometry"):
                compose.compose(pid, missing or None)
            relief = []
            for panel in b.get("panels", []):
                try:
                    pan = store.get(pid)["panels"].get(panel) or {}
                    if presets.treatment(pan) == "relief":
                        if depth.ensure(pid, panel, upgrade=pan.get("review") != "ok"):   # relief : la carte en ~1 s
                            relief.append(panel)
                        # puis les couches (sans dedoublement) sur une machine : jamais sur une case validee en vert,
                        # jamais si elles existent deja (meme ratees : le bouton de l'editeur relance)
                        if (pan.get("couches", True) is not False and pan.get("review") != "ok"
                                and not layers.meta(pid, panel) and S.can_layers()):
                            created += S.enqueue_layers(pid, panel, b.get("machines"))
                    created += S.enqueue_panel(pid, panel, b.get("target", "local"), b.get("machines"),
                                               b.get("seeds", {}).get(panel))
                except (FileNotFoundError, KeyError, ValueError) as e:
                    errors.append(f"{panel} : {e}")
            ps = store.get(pid).get("pageSound") or {}
            pending = any(j["project"] == pid and j["panel"] == "_page" and j["status"] in ("queued", "running")
                          for j in S.list(pid))
            if ps.get("mode") == "generate" and not ps.get("file") and not pending:
                created += S.enqueue_audio(pid, "_page", b.get("machines"))          # son global pas encore genere
            return self.send_json({"jobs": created, "errors": errors, "relief": relief})
        if sub == "audio" and m == "POST":
            b = self.jbody()
            return self.send_json({"jobs": S.enqueue_audio(pid, parts[3], b.get("machines"), b.get("seed"))})
        if sub == "edit" and len(parts) == 4 and m == "POST":     # mode edition de l'apercu : retouches d'une case
            b = self.jbody()
            edit.apply(pid, parts[3], b)
            if "review" in b and set(b) <= {"review", "book"}:     # pastille de suivi seulement : rien a assembler
                return self.send_json({"ok": True, "page": assemble.read_data(store.pdir(pid) / "export"),
                                       "encoded": [], "report": [], "project": store.get(pid)})
            res = assemble.build(pid)                   # rapide : les retouches ne re-encodent rien
            book = next((x for x in self.books_list() if x["id"] == b.get("book")), None) if b.get("book") else None
            if book:
                assemble.sync_book_page(book, pid)
            return self.send_json({"ok": True, "page": assemble.read_data(store.pdir(pid) / "export"),
                                   "encoded": res.get("encoded", []), "report": res.get("report", []),
                                   "project": store.get(pid)})
        if sub == "depth" and len(parts) == 4 and m == "POST":    # carte de profondeur d'une case (relief)
            t0 = time.time()
            rel = depth.ensure(pid, parts[3], bool(self.jbody().get("force")))
            if not rel:
                raise ApiError("pas d'image de départ pour cette case : poser une image d'abord")
            return self.send_json({"file": rel, "url": f"/projects/{pid}/{rel}?t={int(time.time())}",
                                   "seconds": round(time.time() - t0, 2), "model": depth.MODEL_ID})
        if sub == "layers" and len(parts) == 4:                  # relief en couches d'une case
            panel = (store.get(pid)["panels"].get(parts[3]) or {})
            if m == "POST":
                b = self.jbody()
                prev = (panel.get("layers") or {}).get("seed")
                seed = b.get("seed") if b.get("seed") is not None else (int(prev) + 7 if prev is not None else None)
                if not S.can_layers():
                    raise ApiError("aucune machine n'a les modèles des couches (SAM 3.1, BiRefNet, Qwen-Image-Edit 2509 : "
                                   "docs/INSTALL-MODELES-RELIEF.md) : couches impossibles pour l'instant")
                return self.send_json({"jobs": S.enqueue_layers(pid, parts[3], b.get("machines"), seed)})
            job = next((j for j in sorted(S.list(pid), key=lambda j: -j["created"])
                        if j["panel"] == parts[3] and j["kind"] == "layers"), None)
            return self.send_json({"meta": layers.meta(pid, parts[3]), "job": job, "possible": S.can_layers()})
        if sub == "regen" and len(parts) == 4 and m == "POST":    # regenerer la video d'une case (consigne, graine)
            return self.send_json(edit.regen(pid, parts[3], self.jbody()))
        if sub == "regensound" and len(parts) == 4 and m == "POST":
            return self.send_json(edit.regen_sound(pid, parts[3], self.jbody()))
        if sub == "direct" and m == "POST":             # realisateur IA : l'IA regle toute la page
            b = self.jbody()
            return self.send_json(director.direct(pid, b.get("instruction", ""), b.get("options") or {}))
        if sub == "pagesound" and m == "POST":
            b = self.jbody()
            return self.send_json({"jobs": S.enqueue_audio(pid, "_page", b.get("machines"), b.get("seed"))})
        if sub == "voice" and m == "POST":
            b = self.jbody()
            return self.send_json({"jobs": S.enqueue_voice(pid, parts[3], b.get("machines"), b.get("seed"))})
        if sub == "foley" and m == "POST":
            b = self.jbody()
            return self.send_json({"jobs": S.enqueue_foley(pid, parts[3], seed=b.get("seed"))})
        if sub == "choose" and m == "POST":
            b = self.jbody()

            def choose(p):
                if b.get("side") == "P":
                    p.setdefault("pageSound", {}).update(file=b["file"], rev=time.time())
                    return
                panel = p["panels"].setdefault(b["panel"], {})
                layer = {"A": "audio", "B": "voice", "F": "foley"}.get(b.get("side"))
                if layer:
                    panel.setdefault(layer, {})["file"] = b["file"]
                else:
                    panel.setdefault("chosen", {})[b["side"]] = b["file"]
            return self.send_json(store.mutate(pid, choose))
        if sub == "export" and m == "POST":
            if not store.get(pid).get("geometry") or not store.path(pid, "page/page.jpg").exists():
                compose.compose(pid)
            return self.send_json(assemble.build(pid))
        if sub == "reveal" and m == "POST":
            folder = store.pdir(pid) / "export"
            if not (folder / "index.html").exists():
                assemble.build(pid)
            open_folder(folder)
            return self.send_json({"ok": True, "folder": str(folder)})
        if sub == "publish" and m == "POST":
            b = self.jbody()
            p = store.get(pid)
            name = store.slug(b.get("name") or p.get("name") or pid)
            rep = assemble.build(pid)
            res = publish.publish_folder(store.pdir(pid) / "export", name, p.get("name", name), 1, "page.jpg")
            store.mutate(pid, lambda pp: pp.update(published={"name": name, "url": res["url"], "at": time.time()}))
            return self.send_json(dict(res, report=rep["report"]))
        raise ApiError("route projet inconnue", 404)

    @staticmethod
    def books_list():
        return json.loads(BOOKS.read_text(encoding="utf-8")) if BOOKS.exists() else []

    def books(self, m, parts, q):
        books = self.books_list()
        if len(parts) == 1:
            if m == "GET":
                return self.send_json(books)
            if m == "PUT":
                BOOKS.parent.mkdir(exist_ok=True)
                BOOKS.write_text(json.dumps(self.jbody(), indent=1, ensure_ascii=False), encoding="utf-8")
                return self.send_json({"ok": True})
        if len(parts) == 3 and parts[2] in ("export", "publish") and m == "POST":
            book = next((b for b in books if b["id"] == parts[1]), None)
            if not book or not book.get("pages"):
                raise ApiError("livre vide ou introuvable", 404)
            out = assemble.build_book(book, ROOT / "data" / "books" / book["id"])
            if parts[2] == "export":
                return self.send_json({"ok": True, "url": f"/api/books/{book['id']}/file/index.html"})
            name = store.slug(book.get("slug") or book["title"])
            first = json.loads((out / "book.js").read_text(encoding="utf-8").split("=", 1)[1].strip().rstrip(";"))
            cover = first["pages"][0]["base"] + "page.jpg"
            res = publish.publish_folder(out, name, book["title"], len(book["pages"]), cover)
            return self.send_json(res)
        if len(parts) == 3 and parts[2] == "reveal" and m == "POST":
            open_folder(self.inside(ROOT / "data" / "books", parts[1]))
            return self.send_json({"ok": True})
        if len(parts) >= 4 and parts[2] == "file" and m in ("GET", "HEAD"):
            return self.send_file(self.inside(ROOT / "data" / "books" / parts[1], "/".join(parts[3:])))
        raise ApiError("route livre inconnue", 404)


class Server(ThreadingHTTPServer):
    """Port exclusif : sous Windows, SO_REUSEADDR laisse deux serveurs se partager le port (l'ancien
    continue alors de repondre a une partie des requetes). Un deuxieme lancement doit echouer proprement."""
    allow_reuse_address = os.name != "nt"
    daemon_threads = True

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def _console_safe():
    """Windows : un clic dans la fenetre du serveur passe la console en « selection » (QuickEdit) et suspend tout
    programme qui y ecrit -> l'application se fige. On coupe QuickEdit et on envoie le journal dans un fichier."""
    if os.name == "nt":
        try:
            import ctypes
            k = ctypes.windll.kernel32
            h = k.GetStdHandle(-10)                       # entree de la console
            mode = ctypes.c_uint32()
            if k.GetConsoleMode(h, ctypes.byref(mode)):
                k.SetConsoleMode(h, (mode.value & ~0x0040) | 0x0080)   # sans QuickEdit, avec ENABLE_EXTENDED_FLAGS
        except (OSError, AttributeError):
            pass
    log = ROOT / "data" / "server.log"
    log.parent.mkdir(exist_ok=True)
    if log.exists() and log.stat().st_size > 5_000_000:
        log.replace(log.with_suffix(".old.log"))
    f = open(log, "a", encoding="utf-8", buffering=1)
    f.write("\n===== demarrage %s =====\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
    sys.stdout = sys.stderr = f
    return log


def main():
    cfg = settings.load()["server"]
    host, port = cfg.get("host", "127.0.0.1"), int(os.environ.get("ALIVE_PORT") or cfg.get("port", 8790))
    if not shutil.which("ffmpeg"):
        print("ATTENTION : ffmpeg introuvable dans le PATH (necessaire pour l'export)")
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}/"
    try:
        srv = Server((host, port), Handler)
    except OSError:
        print(f"Alive-Comics tourne deja sur {url} : ouverture de la page. (Pour le relancer, fermer l'autre fenetre.)")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        return
    print(f"Alive-Comics {VERSION} : {url}")
    print("Laisser cette fenetre ouverte (la fermer arrete l'application).")
    log = _console_safe()
    if sys.__stdout__:                                   # absent si lance sans console (pythonw)
        sys.__stdout__.write(f"Journal : {log}\n")
        sys.__stdout__.flush()
    jobs.SCHEDULER.start()
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
