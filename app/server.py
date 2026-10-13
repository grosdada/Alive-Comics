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
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import assemble, falapi, jobs, llm, presets, publish, settings, store

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "app" / "web"
PLAYER = ROOT / "player"
BOOKS = ROOT / "data" / "books.json"
VERSION = "0.1.0"
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("audio/mpeg", ".mp3")


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
        for layer in ("audio", "voice", "foley"):
            cur = dict(panel.get(layer) or {})
            prev = old.get(layer) or {}
            cur["generated"] = prev.get("generated", [])
            if prev.get("file") and cur.get("file") != "":
                cur["file"] = prev["file"]
            panel[layer] = cur
        panels[pid] = panel
    out["panels"] = panels
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
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

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
                return self.send_json(S.list(q.get("project")))
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
        if head == "books":
            return self.books(m, parts, q)
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
                return self.send_json(store.create(b.get("name") or "Nouvelle planche", b.get("page"), b.get("layout")))
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
            rel = store.write_file(pid, "assets", f"{stamp}-{name}", data)
            if q.get("kind") in ("audio", "voice") and q.get("panel"):
                def setaud(p):
                    aud = p["panels"].setdefault(q["panel"], {}).setdefault(q["kind"], {})
                    aud.update(mode="file", file=rel, name=name)
                store.mutate(pid, setaud)
            return self.send_json({"file": rel, "url": f"/projects/{pid}/{rel}"})
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
            for panel in b.get("panels", []):
                try:
                    created += S.enqueue_panel(pid, panel, b.get("target", "local"), b.get("machines"),
                                               b.get("seeds", {}).get(panel))
                except (FileNotFoundError, KeyError, ValueError) as e:
                    errors.append(f"{panel} : {e}")
            return self.send_json({"jobs": created, "errors": errors})
        if sub == "audio" and m == "POST":
            b = self.jbody()
            return self.send_json({"jobs": S.enqueue_audio(pid, parts[3], b.get("machines"), b.get("seed"))})
        if sub == "voice" and m == "POST":
            b = self.jbody()
            return self.send_json({"jobs": S.enqueue_voice(pid, parts[3], b.get("machines"), b.get("seed"))})
        if sub == "foley" and m == "POST":
            b = self.jbody()
            return self.send_json({"jobs": S.enqueue_foley(pid, parts[3], seed=b.get("seed"))})
        if sub == "choose" and m == "POST":
            b = self.jbody()

            def choose(p):
                panel = p["panels"].setdefault(b["panel"], {})
                layer = {"A": "audio", "B": "voice", "F": "foley"}.get(b.get("side"))
                if layer:
                    panel.setdefault(layer, {})["file"] = b["file"]
                else:
                    panel.setdefault("chosen", {})[b["side"]] = b["file"]
            return self.send_json(store.mutate(pid, choose))
        if sub == "export" and m == "POST":
            return self.send_json(assemble.build(pid))
        if sub == "publish" and m == "POST":
            b = self.jbody()
            p = store.get(pid)
            name = store.slug(b.get("name") or p.get("name") or pid)
            rep = assemble.build(pid)
            res = publish.publish_folder(store.pdir(pid) / "export", name, p.get("name", name), 1, "page.jpg")
            store.mutate(pid, lambda pp: pp.update(published={"name": name, "url": res["url"], "at": time.time()}))
            return self.send_json(dict(res, report=rep["report"]))
        raise ApiError("route projet inconnue", 404)

    def books(self, m, parts, q):
        books = json.loads(BOOKS.read_text(encoding="utf-8")) if BOOKS.exists() else []
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
        if len(parts) >= 4 and parts[2] == "file" and m in ("GET", "HEAD"):
            return self.send_file(self.inside(ROOT / "data" / "books" / parts[1], "/".join(parts[3:])))
        raise ApiError("route livre inconnue", 404)


def main():
    cfg = settings.load()["server"]
    host, port = cfg.get("host", "127.0.0.1"), int(os.environ.get("ALIVE_PORT") or cfg.get("port", 8790))
    if not shutil.which("ffmpeg"):
        print("ATTENTION : ffmpeg introuvable dans le PATH (necessaire pour l'export)")
    jobs.SCHEDULER.start()
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}/"
    print(f"Alive-Comics {VERSION} : {url}  (Ctrl+C pour arreter)")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
