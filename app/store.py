"""Projets : un dossier par planche dans projects/<id>/.

    project.json   la planche (format, cadres, cases, reglages) : source unique de verite
    assets/        images et sons importes
    start/         image de depart de chaque case, a la taille de generation (envoyee a H3)
    renders/       toutes les variantes rendues
    export/        la page jouable (lecteur + videos), refaite a chaque export
"""

import json
import re
import secrets
import shutil
import threading
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECTS = ROOT / "projects"
TRASH = PROJECTS / "_corbeille"
_lock = threading.RLock()


def slug(text):
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "planche"


def safe_name(name):
    name = unicodedata.normalize("NFKD", name or "fichier").encode("ascii", "ignore").decode()
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "fichier"
    return name[:80]


def pdir(pid):
    if not re.fullmatch(r"[a-z0-9-]+", pid or ""):
        raise ValueError("identifiant de projet invalide")
    d = PROJECTS / pid
    if not (d / "project.json").exists():
        raise FileNotFoundError(pid)
    return d


def list_projects():
    out = []
    if PROJECTS.exists():
        for f in PROJECTS.glob("*/project.json"):
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            out.append({"id": p["id"], "name": p.get("name", p["id"]), "updated": p.get("updated", 0),
                        "panels": len(p.get("panels", {})), "thumb": p.get("thumb")})
    return sorted(out, key=lambda x: -x["updated"])


def create(name, page=None, layout=None):
    with _lock:
        pid = slug(name) + "-" + secrets.token_hex(2)
        d = PROJECTS / pid
        for sub in ("assets", "start", "renders", "export"):
            (d / sub).mkdir(parents=True, exist_ok=True)
        now = time.time()
        p = {"id": pid, "name": name or "Nouvelle planche", "created": now, "updated": now, "version": 1,
             "page": page or {}, "layout": layout or {}, "panels": {}, "style": "", "audio_volume": 1.0}
        (d / "project.json").write_text(json.dumps(p, indent=1, ensure_ascii=False), encoding="utf-8")
        return p


def get(pid):
    return json.loads((pdir(pid) / "project.json").read_text(encoding="utf-8"))


def save(p):
    with _lock:
        d = pdir(p["id"])
        p["updated"] = time.time()
        tmp = d / "project.json.tmp"
        tmp.write_text(json.dumps(p, indent=1, ensure_ascii=False), encoding="utf-8")
        tmp.replace(d / "project.json")
        return p


def mutate(pid, fn):
    """Lit, modifie (fn(p) -> None) et enregistre sous verrou : pour le moteur de rendu."""
    with _lock:
        p = get(pid)
        fn(p)
        return save(p)


def trash(pid):
    with _lock:
        d = pdir(pid)
        TRASH.mkdir(parents=True, exist_ok=True)
        shutil.move(str(d), str(TRASH / f"{pid}-{int(time.time())}"))


def write_file(pid, sub, name, data):
    d = pdir(pid) / sub
    d.mkdir(parents=True, exist_ok=True)
    f = d / safe_name(name)
    f.write_bytes(data)
    return f"{sub}/{f.name}"


def path(pid, rel):
    """Chemin absolu d'un fichier du projet, sans sortir du dossier."""
    d = pdir(pid).resolve()
    f = (d / rel).resolve()
    if d not in f.parents and f != d:
        raise PermissionError(rel)
    return f
