"""Page d'accueil du site : la liste des livres publies (couverture = premiere page).

    python tools/build_shelf.py --out dist/_racine --book essais=dist/livre-essais [--book ...]

Chaque livre est un dossier produit par build_book.py ; il sera publie dans /<nom>/ a cote.
Modele : player/shelf.html (partage avec l'application).
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.publish import shelf_html  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--book", action="append", required=True, help="nom=dossier du livre")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    books = {}
    for spec in args.book:
        name, _, folder = spec.partition("=")
        raw = (Path(folder) / "book.js").read_text(encoding="utf-8")
        book = json.loads(raw.split("=", 1)[1].strip().rstrip(";"))
        first = book["pages"][0]
        books[name] = {"title": book["title"], "pages": len(book["pages"]),
                       "cover": f"{first['base']}{first['data']['page']}"}
    (out / "index.html").write_text(shelf_html(books), encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    print("accueil ecrit :", out / "index.html", len(books), "livre(s)")


if __name__ == "__main__":
    main()
