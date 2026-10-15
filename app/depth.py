"""Cartes de profondeur des cases en relief (parallaxe au survol, au clic ou au glisser).

Modele : Depth Anything V2 Small, licence Apache 2.0 (distribuable, usage commercial permis), en ONNX
(onnx-community/depth-anything-v2-small). Calcul sur le processeur de ce PC, environ 1 s par case : pas de GPU,
pas de file d'attente. Le modele (99 Mo) est telecharge une fois dans data/models/.
Attention : les tailles Base / Large / Giant de Depth Anything V2 sont CC-BY-NC (non commercial) : ne pas les utiliser.

Carte : niveaux de gris, blanc = proche, noir = loin, normalisee 0-1 par image (centiles 1-99), dilatee autour des
sujets proches (filtre max) puis lissee (flou 1,5 px) pour eviter les dechirures au bord des personnages.
Rangement : projects/<id>/depth/<case>.png, recalculee des que l'image de depart (start/<case>.png) est plus recente.
"""

import threading
import time
import urllib.request

from . import store

MODEL_ID = "depth-anything-v2-small"
MODEL_URL = "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx"
MODEL = store.ROOT / "data" / "models" / "depth-anything-v2-small.onnx"
LICENSE = ("Depth Anything V2 Small (Apache License 2.0) : https://huggingface.co/depth-anything/Depth-Anything-V2-Small ; "
           "ONNX : https://huggingface.co/onnx-community/depth-anything-v2-small")
MEAN, STD = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)
_lock = threading.Lock()
_sess = None


def _session():
    """Session ONNX (chargee une fois ; le modele est telecharge au premier usage)."""
    global _sess
    with _lock:
        if _sess is None:
            if not MODEL.exists():
                MODEL.parent.mkdir(parents=True, exist_ok=True)
                tmp = MODEL.with_suffix(".part")
                urllib.request.urlretrieve(MODEL_URL, tmp)
                tmp.replace(MODEL)
                (MODEL.parent / "LICENSE-depth-anything-v2-small.txt").write_text(LICENSE + "\n", encoding="utf-8")
            import onnxruntime as ort
            _sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
        return _sess


def compute(src, dst):
    """Carte de profondeur de l'image src -> dst (PNG 8 bits, meme taille que src)."""
    import numpy as np
    from PIL import Image, ImageFilter
    im = Image.open(src).convert("RGB")
    w, h = im.size
    sc = 518 / min(w, h)                               # entree du modele : petit cote 518, multiples de 14
    W, H = max(14, round(w * sc / 14) * 14), max(14, round(h * sc / 14) * 14)
    x = (np.asarray(im.resize((W, H), Image.BICUBIC), np.float32) / 255 - MEAN) / STD
    sess = _session()
    d = sess.run(None, {sess.get_inputs()[0].name: x.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
    lo, hi = np.percentile(d, 1), np.percentile(d, 99)  # sortie : disparite relative (grand = proche)
    d = np.clip((d - lo) / max(1e-6, hi - lo), 0, 1)
    m = Image.fromarray((d * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
    m = m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.5))
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp.png")
    m.save(tmp)
    tmp.replace(dst)


def ensure(pid, panel_id, force=False):
    """Carte de la case (calculee si absente ou plus ancienne que l'image de depart) -> chemin relatif, ou None."""
    src = store.path(pid, f"start/{panel_id}.png")
    if not src.exists():
        return None
    dst = store.path(pid, f"depth/{panel_id}.png")
    if force or not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
        t0 = time.time()
        compute(src, dst)
        print(f"profondeur {pid}/{panel_id} : {time.time() - t0:.2f} s")
    return f"depth/{panel_id}.png"


def auto_focus(path):
    """Plan net automatique : profondeur mediane du centre de la case (la ou est souvent le sujet)."""
    try:
        import numpy as np
        from PIL import Image
        a = np.asarray(Image.open(path).convert("L"), np.float32) / 255
        h, w = a.shape
        return round(float(np.median(a[h // 4: 3 * h // 4, w // 4: 3 * w // 4])), 3)
    except Exception:                                   # noqa: BLE001
        return 0.7
