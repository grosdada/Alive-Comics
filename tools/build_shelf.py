"""Page d'accueil du site : la liste des livres publies (couverture = premiere page).

    python tools/build_shelf.py --out dist/_racine --book essais=dist/livre-essais [--book ...]

Chaque livre est un dossier produit par build_book.py ; il sera publie dans /<nom>/ a cote.
"""

import argparse
import html
import json
import shutil
from pathlib import Path

PAGE = """<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Alive Comics</title>
<style>
  :root {{ --bg: #121212; --card: #1c1c1c; --ink: #ece8e1; --muted: #9a948a; --accent: #f2b45c; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, "Segoe UI", Roboto, sans-serif; }}
  header {{ padding: 40px 16px 10px; text-align: center; }}
  h1 {{ margin: 0; font-size: clamp(30px, 6vw, 52px); letter-spacing: .04em; }}
  h1 b {{ color: var(--accent); }}
  header p {{ margin: 8px 0 0; color: var(--muted); }}
  main {{ max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; display: grid; gap: 22px;
          grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }}
  a.book {{ display: block; color: inherit; text-decoration: none; background: var(--card); border-radius: 12px;
            overflow: hidden; border: 1px solid #2a2a2a; transition: transform .2s, border-color .2s; }}
  a.book:hover {{ transform: translateY(-3px); border-color: var(--accent); }}
  a.book img {{ display: block; width: 100%; aspect-ratio: 2 / 3; object-fit: cover; object-position: top; background: #fff; }}
  a.book div {{ padding: 10px 14px 14px; }}
  a.book h2 {{ margin: 0; font-size: 17px; }}
  a.book span {{ color: var(--muted); font-size: 14px; }}
</style>
</head>
<body>
<header><h1>ALIVE <b>COMICS</b></h1><p>Des planches de BD qui bougent quand on les touche.</p></header>
<main>
{cards}
</main>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--book", action="append", required=True, help="nom=dossier du livre")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cards = []
    for spec in args.book:
        name, _, folder = spec.partition("=")
        raw = (Path(folder) / "book.js").read_text(encoding="utf-8")
        book = json.loads(raw.split("=", 1)[1].strip().rstrip(";"))
        first = book["pages"][0]
        cover = f"{name}/{first['base']}{first['data']['page']}"
        n = len(book["pages"])
        cards.append(f'<a class="book" href="{name}/"><img src="{html.escape(cover)}" alt="" loading="lazy">'
                     f'<div><h2>{html.escape(book["title"])}</h2><span>{n} page{"s" if n > 1 else ""}</span></div></a>')
    (out / "index.html").write_text(PAGE.format(cards="\n".join(cards)), encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    shutil.copy2(Path(args.book[0].partition("=")[2]) / ".htaccess", out / ".htaccess")
    print("accueil ecrit :", out / "index.html", len(cards), "livre(s)")


if __name__ == "__main__":
    main()
