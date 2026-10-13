"""Assemble un livre jouable (plusieurs pages animees) dans un dossier autonome.

    python tools/build_book.py --title "Alive Comics, essais" --out dist/livre-essais \
        --page "Planche 1=E:/H3-Orbital/planche1/viewer" \
        --page "Planche 2=E:/H3-Orbital/planche2/viewer" \
        --page "Planche 3=E:/H3-Orbital/planche3/viewer"

Chaque page est un dossier contenant manga_data.js (window.MANGA = {...}), l'image de page, les
videos et les sons qu'il reference. Sortie :
    index.html  alive-player.js  alive-player.css  book.js  .htaccess  robots.txt
    pages/<slug>/  (page.jpg, frames.png, videos/, sons/)
Le dossier marche en double-clic (file://) et tel quel sur un hebergement web.
"""

import argparse
import json
import re
import shutil
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAYER = ROOT / "player"

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


def slug(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "page"


def read_page_data(folder):
    raw = (folder / "manga_data.js").read_text(encoding="utf-8")
    return json.loads(raw.split("=", 1)[1].strip().rstrip(";"))


def copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists() or dst.stat().st_size != src.stat().st_size or dst.stat().st_mtime < src.stat().st_mtime:
        shutil.copy2(src, dst)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--title", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--page", action="append", required=True, help='"Titre=dossier" (repetable, dans l\'ordre)')
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    book = {"title": args.title, "pages": []}
    used = set()
    for spec in args.page:
        title, _, folder = spec.partition("=")
        folder = Path(folder)
        data = read_page_data(folder)
        name = slug(title)
        while name in used:
            name += "-b"
        used.add(name)
        base = f"pages/{name}/"
        files = [data["page"]] + ([data["frames"]] if data.get("frames") else [])
        for p in data["panels"]:
            files += [p[k] for k in ("video", "idle", "audio") if p.get(k)]
            files += [p[k]["src"] for k in ("voice", "foley") if p.get(k)]
        if data.get("sound"):
            files.append(data["sound"]["src"])
        for rel in files:
            copy(folder / rel, out / base / rel)
        book["pages"].append({"title": title, "base": base, "data": data})
        print(f"{title}: {len(data['panels'])} cases, {len(files)} fichiers -> {base}")
    (out / "book.js").write_text("window.ALIVE_BOOK = " + json.dumps(book, ensure_ascii=False) + ";\n", encoding="utf-8")
    shutil.copy2(PLAYER / "book.html", out / "index.html")
    for f in ("alive-player.js", "alive-player.css"):
        shutil.copy2(PLAYER / f, out / f)
    (out / ".htaccess").write_text(HTACCESS, encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"livre ecrit dans {out} ({len(book['pages'])} pages, {size / 1e6:.1f} Mo)")


if __name__ == "__main__":
    main()
