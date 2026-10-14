"""Sons importes, sans doublon.

Un son se reconnait a son contenu (empreinte SHA-1), quel que soit son nom :
  - deja utilise dans une planche (son de case, voix, son ajoute, musique de page) : l'import est refuse
    avec la liste des planches et cases qui l'utilisent (statut 409) ; l'interface previent et peut forcer ;
  - deja importe mais inutilise, ou force : le fichier existant est reutilise (meme planche : tel quel ;
    autre planche : lien physique, sinon copie) au lieu d'etre enregistre une deuxieme fois.
"""

import hashlib
import json
import os
import secrets
import shutil
import threading
import time

from . import store

AUDIO = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus", ".aif", ".aiff"}
INDEX = store.ROOT / "data" / "sound_index.json"
_lock = threading.Lock()
LABELS = {"audio": "son 1", "voice": "son 2 / voix off", "foley": "bruitages"}


class Duplicate(Exception):
    """Son deja utilise ailleurs : used = [{project, name, panel, label}]."""

    def __init__(self, used):
        super().__init__("son déjà utilisé : " + " ; ".join(u["where"] for u in used))
        self.used = used


def _sha_file(f):
    h = hashlib.sha1()
    with open(f, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def matches(data):
    """Fichiers deja importes (toutes planches) au contenu identique : [(projet, chemin relatif)]."""
    size, sha = len(data), hashlib.sha1(data).hexdigest()
    with _lock:
        try:
            idx = json.loads(INDEX.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            idx = {}
        out, dirty = [], False
        for f in store.PROJECTS.glob("*/assets/*"):
            if f.suffix.lower() not in AUDIO:
                continue
            st = f.stat()
            if st.st_size != size:                      # meme contenu = meme taille : on ne lit que ceux-la
                continue
            key = f.relative_to(store.PROJECTS).as_posix()
            cur = idx.get(key)
            if not cur or cur[0] != st.st_size or abs(cur[1] - st.st_mtime) > 0.01:
                cur = idx[key] = [st.st_size, st.st_mtime, _sha_file(f)]
                dirty = True
            if cur[2] == sha:
                out.append((f.parent.parent.name, f"assets/{f.name}"))
        if dirty:
            INDEX.parent.mkdir(exist_ok=True)
            INDEX.write_text(json.dumps(idx), encoding="utf-8")
    return out


def usages(files):
    """Ou ces fichiers [(projet, chemin)] sont utilises : [{project, name, panel, label, where}]."""
    want = set(files)
    out = []
    for pj in store.PROJECTS.glob("*/project.json"):
        try:
            p = json.loads(pj.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        pid, name = p.get("id"), p.get("name") or p.get("id")

        def hit(rel, panel, label):
            if rel and (pid, rel) in want:
                where = f"« {name} »" + (f", case {panel}" if panel else "") + f" ({label})"
                out.append({"project": pid, "name": name, "panel": panel, "label": label, "where": where})
        hit((p.get("pageSound") or {}).get("file"), None, "musique de la page")
        for k, panel in (p.get("panels") or {}).items():
            for layer, label in LABELS.items():
                hit((panel.get(layer) or {}).get("file"), k, label)
            for i, x in enumerate(panel.get("extraSounds") or []):
                hit(x.get("file"), k, f"son ajouté {i + 1}")
    return out


def place(pid, data, name, force=False):
    """Range un son importe dans la planche pid -> {"file", "reused", "used"} ; leve Duplicate s'il sert deja."""
    found = matches(data)
    used = usages(found) if found else []
    if used and not force:
        raise Duplicate(used)
    same = [rel for p, rel in found if p == pid]
    if same:                                            # deja dans cette planche : on le reprend tel quel
        return {"file": same[0], "reused": True, "used": used}
    stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
    if found:                                           # dans une autre planche : lien physique (pas de 2e copie)
        src = store.PROJECTS / found[0][0] / found[0][1]
        dst = store.pdir(pid) / "assets" / store.safe_name(f"{stamp}-{name}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
        return {"file": f"assets/{dst.name}", "reused": True, "used": used}
    rel = store.write_file(pid, "assets", f"{stamp}-{name}", data)
    return {"file": rel, "reused": False, "used": used}
