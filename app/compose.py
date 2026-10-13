"""Composition cote serveur (sans navigateur) : ce que l'editeur fait en canvas, en Python/Pillow.

    compose(pid) ->  project.geometry, start/<case>.png (image de depart H3), page/page.jpg, page/frames.png,
                     page/thumb.jpg

Sert au pilotage par API (une instance de Claude remplit la planche par HTTP, sans interface).
"""

from PIL import Image, ImageDraw

from . import geometry as G
from . import store

Image.MAX_IMAGE_PIXELS = None


def _hex(c, default):
    c = (c or default).lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4)) if len(c) == 6 else _hex(default, default)


def _placed(img, bb, view, scale=1.0, origin=(0, 0)):
    """(image redimensionnee, position) de l'image d'une case, dans un repere mis a l'echelle."""
    pl = G.placement(bb, img.width, img.height, view)
    w, h = max(1, round(pl["w"] * scale)), max(1, round(pl["h"] * scale))
    return img.resize((w, h), Image.LANCZOS), (round((pl["x"] - origin[0]) * scale), round((pl["y"] - origin[1]) * scale))


def compose(pid, panels_only=None):
    p = store.get(pid)
    d = store.pdir(pid)
    page = dict(G.PAGE_DEFAULTS, **(p.get("page") or {}))
    geo = G.compute(page, p["layout"])
    W, H = page["width"], page["height"]
    bg, stroke, sw = _hex(page.get("bg"), "#ffffff"), _hex(page.get("stroke"), "#111111"), int(page.get("strokeWidth") or 0)
    canvas = Image.new("RGB", (W, H), bg)
    frames = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    made = []
    for g in geo:
        panel = p["panels"].get(g["id"]) or {}
        bb, poly = g["bbox"], [tuple(pt) for pt in g["poly"]]
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).polygon(poly, fill=255)
        layer = Image.new("RGB", (W, H), (255, 255, 255))
        img = None
        im_info = panel.get("image") or {}
        if im_info.get("file") and (d / im_info["file"]).exists():
            img = Image.open(d / im_info["file"]).convert("RGB")
            pic, pos = _placed(img, bb, panel.get("view"))
            layer.paste(pic, pos)
        canvas = Image.composite(layer, canvas, mask)
        # image de depart de la case, a la taille de generation H3
        if img is not None and (panels_only is None or g["id"] in panels_only):
            gw, gh = G.gen_size(bb["w"], bb["h"])
            k = gw / bb["w"]
            start = Image.new("RGB", (gw, gh), (255, 255, 255))
            pic, pos = _placed(img, bb, panel.get("view"), k, (bb["x0"], bb["y0"]))
            start.paste(pic, pos)
            start.save(d / "start" / f"{g['id']}.png")
            panel["startSig"] = None                     # l'editeur refera la sienne s'il en a besoin
            made.append({"id": g["id"], "order": g["order"], "size": [gw, gh]})
    if sw > 0:
        for g in geo:
            pts = [tuple(pt) for pt in g["poly"]] + [tuple(g["poly"][0])]
            ImageDraw.Draw(canvas).line(pts, fill=stroke, width=sw, joint="curve")
            ImageDraw.Draw(frames).line(pts, fill=stroke + (255,), width=sw, joint="curve")
    (d / "page").mkdir(exist_ok=True)
    (d / "start").mkdir(exist_ok=True)
    canvas.save(d / "page" / "page.jpg", quality=92)
    frames.save(d / "page" / "frames.png")
    thumb = canvas.copy()
    thumb.thumbnail((360, 360 * H // W))
    thumb.save(d / "page" / "thumb.jpg", quality=80)

    def setgeo(pp):
        pp["geometry"] = {"size": [W, H], "panels": [
            {"id": g["id"], "order": g["order"],
             "rect": [round(v, 1) for v in (g["bbox"]["x0"], g["bbox"]["y0"], g["bbox"]["x1"], g["bbox"]["y1"])],
             "poly": [[round(x, 1), round(y, 1)] for x, y in g["poly"]]} for g in geo]}
        pp["thumb"] = f"/projects/{pid}/page/thumb.jpg"
        for m in made:
            pp["panels"].setdefault(m["id"], {})["startSig"] = None
    store.mutate(pid, setgeo)
    return {"panels": [{"id": g["id"], "order": g["order"], "has_image": bool((p["panels"].get(g["id"]) or {}).get("image")),
                        "rect": [round(v) for v in (g["bbox"]["x0"], g["bbox"]["y0"], g["bbox"]["x1"], g["bbox"]["y1"])]}
                       for g in geo],
            "start_images": made, "page": f"/projects/{pid}/page/page.jpg"}
