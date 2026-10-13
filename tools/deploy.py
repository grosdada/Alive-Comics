"""Met en ligne un dossier (livre ou page) sur un hebergement SSH (Hostinger), sans mot de passe.

    python tools/deploy.py dist/livre-essais                 # vers la racine du site
    python tools/deploy.py dist/livre-essais --to essais     # vers https://<site>/essais/

Reglages dans local_settings.json (jamais dans le depot) :
    "deploy": {"host": "46.202.158.181", "port": 65002, "user": "u335969729",
               "key": "~/.ssh/alive_comics_hostinger",
               "root": "domains/alive-comics.placenta.tv/public_html",
               "url": "https://alive-comics.placenta.tv"}
Envoi par tar + ssh (rien a installer sur le serveur). Les fichiers deja presents et identiques
(meme taille, meme date) ne sont pas renvoyes.
"""

import argparse
import io
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def settings():
    f = ROOT / "local_settings.json"
    if not f.exists():
        sys.exit("local_settings.json manquant (voir l'en-tete de ce script)")
    return json.loads(f.read_text(encoding="utf-8"))["deploy"]


def ssh_cmd(cfg, remote):
    return ["ssh", "-i", os.path.expanduser(cfg["key"]), "-o", "BatchMode=yes", "-p", str(cfg["port"]),
            f"{cfg['user']}@{cfg['host']}", remote]


def remote_listing(cfg, dest):
    """{chemin relatif: (taille, mtime)} des fichiers deja en ligne."""
    script = (f"mkdir -p '{dest}' && cd '{dest}' && find . -type f -printf '%P\\t%s\\t%T@\\n'")
    out = subprocess.run(ssh_cmd(cfg, script), capture_output=True, text=True, check=True).stdout
    files = {}
    for line in out.splitlines():
        rel, size, mtime = line.split("\t")
        files[rel] = (int(size), float(mtime))
    return files


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--to", default="", help="sous-dossier du site (vide = racine)")
    ap.add_argument("--all", action="store_true", help="tout renvoyer, meme les fichiers identiques")
    args = ap.parse_args()
    cfg = settings()
    src = Path(args.folder)
    dest = cfg["root"].rstrip("/") + ("/" + args.to.strip("/") if args.to.strip("/") else "")
    online = {} if args.all else remote_listing(cfg, dest)
    todo = []
    for f in sorted(p for p in src.rglob("*") if p.is_file()):
        rel = f.relative_to(src).as_posix()
        st = f.stat()
        old = online.get(rel)
        if old and old[0] == st.st_size and old[1] >= int(st.st_mtime):
            continue
        todo.append((f, rel))
    if not todo:
        print("rien a envoyer : tout est deja en ligne")
    else:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            for f, rel in todo:
                tar.add(f, arcname=rel)
        size = buf.tell()
        print(f"envoi de {len(todo)} fichiers ({size / 1e6:.1f} Mo) vers {dest}")
        subprocess.run(ssh_cmd(cfg, f"mkdir -p '{dest}' && tar -xf - -C '{dest}'"), input=buf.getvalue(), check=True)
    print("en ligne :", cfg["url"].rstrip("/") + "/" + (args.to.strip("/") + "/" if args.to.strip("/") else ""))


if __name__ == "__main__":
    main()
