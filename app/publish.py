"""Publication sur un hebergement SSH (Hostinger) : une cle par poste, aucun mot de passe.

- ensure_key()   cree la cle de ce poste si besoin et renvoie la ligne publique a coller dans hPanel
- test()         verifie la connexion
- deploy()       envoie un dossier (tar + ssh), seulement les fichiers nouveaux ou modifies
- publish_*      publie une planche ou un livre dans /<nom>/ et met a jour la page d'accueil
Registre des publications : data/published.json (nom -> titre, pages, couverture).
"""

import html
import io
import json
import os
import re
import subprocess
import tarfile
import time
from pathlib import Path

from . import settings

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "data" / "published.json"
NOFLASH = {"creationflags": 0x08000000} if os.name == "nt" else {}
HTACCESS = """# Alive-Comics : pas d'indexation, types et cache des medias
Header set X-Robots-Tag "noindex, nofollow"
AddType video/mp4 .mp4
AddType audio/mpeg .mp3
<FilesMatch "[.](html|js|css)$">
  Header set Cache-Control "no-cache"
</FilesMatch>
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType video/mp4 "access plus 30 days"
  ExpiresByType audio/mpeg "access plus 30 days"
  ExpiresByType image/jpeg "access plus 30 days"
  ExpiresByType image/png "access plus 30 days"
</IfModule>
"""


class PublishError(RuntimeError):
    pass


def cfg():
    c = settings.load()["deploy"]
    if not (c.get("host") and c.get("user") and c.get("root")):
        raise PublishError("publication non réglée : renseigner hôte, utilisateur et dossier dans Réglages › Publication")
    return c


def key_path():
    return Path(os.path.expanduser(settings.load()["deploy"].get("key") or "~/.ssh/alive_comics_hostinger"))


def ensure_key():
    k = key_path()
    if not k.exists():
        k.parent.mkdir(parents=True, exist_ok=True)
        host = os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "poste"
        subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", f"alive-comics@{host}", "-f", str(k), "-q"],
                       check=True, **NOFLASH)
    return (k.with_suffix(".pub") if k.suffix else Path(str(k) + ".pub")).read_text(encoding="utf-8").strip()


def _ssh(c, remote, data=None, timeout=900):
    cmd = ["ssh", "-i", os.path.expanduser(c["key"]), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
           "-o", "ConnectTimeout=15", "-p", str(c["port"]), f"{c['user']}@{c['host']}", remote]
    r = subprocess.run(cmd, input=data, capture_output=True, timeout=timeout, **NOFLASH)
    if r.returncode:
        err = r.stderr.decode("utf-8", "replace").strip()
        if "Permission denied" in err:
            raise PublishError("connexion refusée : la clé de ce poste n'est pas encore ajoutée dans hPanel (Accès SSH)")
        raise PublishError("ssh : " + err[-600:])
    return r.stdout.decode("utf-8", "replace")


def test():
    c = cfg()
    out = _ssh(c, f"test -d '{c['root']}' && echo OK", timeout=40)
    return "OK" in out


def deploy(folder, to="", everything=False, log=print):
    c = cfg()
    folder = Path(folder)
    to = to.strip("/")
    if to and not re.fullmatch(r"[a-z0-9][a-z0-9-]*", to):
        raise PublishError("nom de publication invalide (minuscules, chiffres et tirets)")
    dest = c["root"].rstrip("/") + ("/" + to if to else "")
    online = {}
    if not everything:
        listing = _ssh(c, f"mkdir -p '{dest}' && cd '{dest}' && find . -type f -printf '%P\\t%s\\t%T@\\n'", timeout=120)
        for line in listing.splitlines():
            rel, size, mtime = line.split("\t")
            online[rel] = (int(size), float(mtime))
    todo = []
    for f in sorted(p for p in folder.rglob("*") if p.is_file() and p.name != ".cache.json"):
        rel = f.relative_to(folder).as_posix()
        st = f.stat()
        old = online.get(rel)
        if old and old[0] == st.st_size and old[1] >= int(st.st_mtime):
            continue
        todo.append((f, rel))
    if todo:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            for f, rel in todo:
                tar.add(f, arcname=rel)
        log(f"envoi de {len(todo)} fichiers ({buf.tell() / 1e6:.1f} Mo) vers {dest}")
        _ssh(c, f"mkdir -p '{dest}' && tar -xf - -C '{dest}'", data=buf.getvalue())
    return {"sent": len(todo), "url": c["url"].rstrip("/") + "/" + (to + "/" if to else "")}


def shelf_html(books):
    tpl = (ROOT / "player" / "shelf.html").read_text(encoding="utf-8")
    cards = []
    for name, b in sorted(books.items(), key=lambda kv: -kv[1].get("published", 0)):
        n = b.get("pages", 1)
        cards.append(f'<a class="book" href="{name}/"><img src="{html.escape(name + "/" + b["cover"])}" alt="" loading="lazy">'
                     f'<div><h2>{html.escape(b["title"])}</h2><span>{n} page{"s" if n > 1 else ""}</span></div></a>')
    return tpl.replace("{cards}", "\n".join(cards))


def _registry():
    if REGISTRY.exists():
        return json.loads(REGISTRY.read_text(encoding="utf-8"))
    return {}


def publish_folder(folder, name, title, pages, cover, log=print):
    """Publie un dossier jouable (planche ou livre) dans /<name>/ et met a jour l'accueil."""
    res = deploy(folder, name, log=log)
    reg = _registry()
    # les publications faites a la main avant l'application (ex. « essais ») restent dans l'accueil
    reg[name] = {"title": title, "pages": pages, "cover": cover, "published": time.time()}
    REGISTRY.parent.mkdir(exist_ok=True)
    REGISTRY.write_text(json.dumps(reg, indent=1, ensure_ascii=False), encoding="utf-8")
    root = ROOT / "data" / "_racine"
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.html").write_text(shelf_html(reg), encoding="utf-8")
    (root / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    (root / ".htaccess").write_text(HTACCESS, encoding="utf-8")
    deploy(root, "", log=log)
    return res
