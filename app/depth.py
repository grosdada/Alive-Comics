"""Cartes de profondeur des cases en relief (parallaxe au survol, au clic ou au glisser).

Modele : Depth Anything V2 Small, licence Apache 2.0 (distribuable, usage commercial permis), en ONNX
(onnx-community/depth-anything-v2-small). Calcul sur le processeur de ce PC, environ 1 s par case : pas de GPU,
pas de file d'attente. Le modele (99 Mo) est telecharge une fois dans data/models/.
Attention : les tailles Base / Large / Giant de Depth Anything V2 sont CC-BY-NC (non commercial) : ne pas les utiliser.

Carte « nappe sans pli » (v2) : niveaux de gris, blanc = proche, noir = loin, normalisee 0-1 par image (centiles 1-99),
lissee en suivant les bords de l'image (Fast Global Smoother d'OpenCV), puis pente bornee : la nappe ne peut plus se
replier sur elle-meme, donc plus de bords dedoubles (la v1 dilatait la carte, ce qui collait une bande de fond au sujet).
Le vrai relief sans etirement vient des couches (app/layers.py) ; cette nappe sert d'apercu immediat et de repli.
Rangement : projects/<id>/depth/<case>.png, recalculee si l'image de depart est plus recente ou si la carte est d'une
ancienne version (texte PNG « alive-depth »).
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
SHEET_VERSION = "2"
K_REF = 0.05          # deplacement maximal (en largeur de case) par unite de profondeur : sert a borner la pente
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


def raw(rgb):
    """Disparite brute (grand = proche) d'une image RGB float32 0-1 (H x W x 3), a la taille de l'image."""
    import numpy as np
    from PIL import Image
    h, w = rgb.shape[:2]
    sc = 518 / min(w, h)                               # entree du modele : petit cote 518, multiples de 14
    W, H = max(14, round(w * sc / 14) * 14), max(14, round(h * sc / 14) * 14)
    im = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC)
    x = (np.asarray(im, np.float32) / 255 - MEAN) / STD
    sess = _session()
    d = sess.run(None, {sess.get_inputs()[0].name: x.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
    return np.asarray(Image.fromarray(d.astype(np.float32), "F").resize((w, h), Image.BICUBIC), np.float32)


def normalize(d, ref=None):
    """0-1 par centiles 1-99 (ceux de ref si donne : meme echelle pour plusieurs cartes)."""
    import numpy as np
    r = d if ref is None else ref
    lo, hi = np.percentile(r, 1), np.percentile(r, 99)
    return np.clip((d - lo) / max(1e-6, hi - lo), 0, 1).astype(np.float32)


def smooth_edges(d, rgb):
    """Lissage qui suit les bords de l'image (Fast Global Smoother, OpenCV contrib ; sinon flou leger)."""
    import cv2
    import numpy as np
    guide = (np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    try:
        return np.clip(cv2.ximgproc.fastGlobalSmootherFilter(guide, d.astype(np.float32), 300, 8), 0, 1)
    except (AttributeError, cv2.error):
        return cv2.GaussianBlur(d, (0, 0), 1.0)


def bound_slope(d, k_ref=K_REF):
    """Enveloppe superieure a pente bornee : |grad z| <= 0,6 / k_ref par largeur de case. Le point fixe du lecteur a
    alors une seule solution : la nappe ne se replie jamais (pas de dedoublement), elle ondule un peu autour des sujets."""
    import cv2
    import numpy as np
    env = d.astype(np.float32).copy()
    step = np.float32(0.6 / k_ref / d.shape[1])        # pente maximale par pixel
    k = np.ones((3, 3), np.uint8)
    for _ in range(int(1 / step) + 2):
        nxt = np.maximum(env, cv2.dilate(env, k) - step)
        if np.array_equal(nxt, env):
            break
        env = nxt
    return env


def save_map(d, dst, version=SHEET_VERSION):
    import numpy as np
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    info = PngInfo()
    info.add_text("alive-depth", version)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp.png")
    Image.fromarray((np.clip(d, 0, 1) * 255 + 0.5).astype(np.uint8)).save(tmp, pnginfo=info)
    tmp.replace(dst)


def compute(src, dst):
    """Carte « nappe sans pli » de l'image src -> dst (PNG 8 bits, meme taille que src)."""
    import numpy as np
    from PIL import Image
    rgb = np.asarray(Image.open(src).convert("RGB"), np.float32) / 255
    d = normalize(raw(rgb))
    d = bound_slope(smooth_edges(d, rgb))
    save_map(d, dst)


def _version(path):
    try:
        from PIL import Image
        with Image.open(path) as im:
            return (getattr(im, "text", None) or {}).get("alive-depth", "1")
    except OSError:
        return None


def ensure(pid, panel_id, force=False, upgrade=True):
    """Carte de la case (calculee si absente ou plus ancienne que l'image de depart) -> chemin relatif, ou None."""
    src = store.path(pid, f"start/{panel_id}.png")
    if not src.exists():
        return None
    dst = store.path(pid, f"depth/{panel_id}.png")
    if (force or not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime
            or (upgrade and _version(dst) != SHEET_VERSION)):          # case verte : on ne change pas sa carte validee
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
