"""Cartes de profondeur des cases en relief (parallaxe au survol, au clic ou au glisser).

Modele : Depth Anything V2 Small, licence Apache 2.0 (distribuable, usage commercial permis), en ONNX
(onnx-community/depth-anything-v2-small). Calcul sur le processeur de ce PC, environ 1 s par case : pas de GPU,
pas de file d'attente. Le modele (99 Mo) est telecharge une fois dans data/models/.
Attention : les tailles Base / Large / Giant de Depth Anything V2 sont CC-BY-NC (non commercial) : ne pas les utiliser.

Carte v3 (16/10/2026) : un plan ajuste sur la profondeur (plus aucune deformation locale ; la nappe v2 s'etirait autour
des personnages). Ancienne carte « nappe sans pli » (v2) : niveaux de gris, blanc = proche, noir = loin, normalisee 0-1 par image (centiles 1-99),
lissee en suivant les bords de l'image (Fast Global Smoother d'OpenCV), puis pente bornee : la nappe ne peut plus se
replier sur elle-meme, donc plus de bords dedoubles (la v1 dilatait la carte, ce qui collait une bande de fond au sujet).
Le vrai relief sans etirement vient des couches (app/layers.py) ; cette nappe sert d'apercu immediat et de repli.
Couches : raw_best() prend Depth Pro d'Apple (bords nets ; licence de recherche Apple, a revoir avant un usage
commercial) s'il est dans data/models/hf (tools/install_relief_models.py --extra) et si torch + transformers sont la ;
sinon Depth Anything V2 Small.
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
SHEET_VERSION = "3"
K_REF = 0.05          # deplacement maximal (en largeur de case) par unite de profondeur : sert a borner la pente
DEPTH_PRO = store.ROOT / "data" / "models" / "hf" / "apple__DepthPro-hf"
_lock = threading.Lock()
_sess = None
_dp_lock = threading.Lock()
_dp = None


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


def _depth_pro():
    """(processeur, modele) Depth Pro en fp16, garde en memoire vive ; None s'il manque quelque chose."""
    global _dp
    if _dp is None:
        try:
            if not (DEPTH_PRO / "config.json").exists():
                raise FileNotFoundError(DEPTH_PRO)
            import torch
            from transformers import DepthProForDepthEstimation, DepthProImageProcessorFast
            proc = DepthProImageProcessorFast.from_pretrained(DEPTH_PRO)
            model = DepthProForDepthEstimation.from_pretrained(DEPTH_PRO, torch_dtype=torch.float16).eval()
            _dp = (proc, model)
        except Exception as exc:                        # noqa: BLE001 - repli sur Depth Anything V2 Small
            print("Depth Pro indisponible :", str(exc)[:200])
            _dp = False
    return _dp or None


def best_name():
    with _dp_lock:
        return "depth-pro" if _depth_pro() else MODEL_ID


def raw_best(rgb):
    """Disparite brute (grand = proche) par le meilleur modele present : Depth Pro (carte du GPU s'il reste au moins
    6 Go libres, rendu le temps du calcul ; sinon processeur, ~20 s), a defaut Depth Anything V2 Small."""
    import numpy as np
    with _dp_lock:
        dp = _depth_pro()
        if not dp:
            return raw(rgb)
        import torch
        from PIL import Image
        proc, model = dp
        h, w = rgb.shape[:2]
        im = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))
        gpu = torch.cuda.is_available() and torch.cuda.mem_get_info()[0] > 6e9
        dev, dt = ("cuda", torch.float16) if gpu else ("cpu", torch.float32)
        try:
            model.to(dev, dt)
            with torch.no_grad():
                inp = proc(images=im, return_tensors="pt").to(dev, dt)
                out = proc.post_process_depth_estimation(model(**inp), target_sizes=[(h, w)])
                d = out[0]["predicted_depth"].float().cpu().numpy()
        finally:
            model.to("cpu", torch.float16)
            if gpu:
                torch.cuda.empty_cache()
        return (1.0 / np.maximum(d, 1e-3)).astype(np.float32)


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


def plane(d, keep=None):
    """Plan (sol ou mur) ajuste sur la profondeur d aux pixels keep, sans tenir compte des ecarts (3 passes, residus
    au-dela de 2,5 ecarts robustes ecartes) -> carte H x W. Un plan n'a aucun pli ni bosse : le fond ne s'etire pas
    localement, il garde seulement la perspective d'ensemble."""
    import numpy as np
    H, W = d.shape
    ys, xs = np.nonzero(np.ones(d.shape, bool) if keep is None else keep)
    if xs.size < 500:
        return np.full((H, W), float(np.median(d)), np.float32)
    step = max(1, xs.size // 40000)
    xs, ys = xs[::step], ys[::step]
    z = d[ys, xs].astype(np.float64)
    A = np.stack([np.ones_like(z), xs / W, ys / H], 1)
    w = np.ones_like(z)
    coef = np.array([np.median(z), 0.0, 0.0])
    for _ in range(3):
        if w.sum() < 100:
            break
        coef, *_ = np.linalg.lstsq(A * w[:, None], z * w, rcond=None)
        r = np.abs(A @ coef - z)
        w = (r < 2.5 * (1.4826 * np.median(r) + 1e-4)).astype(np.float64)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    return np.clip(coef[0] + coef[1] * (xx + 0.5) / W + coef[2] * (yy + 0.5) / H, 0, 1).astype(np.float32)


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
    """Carte de la case sans couches -> dst (PNG 8 bits, meme taille que src) : un PLAN ajuste sur la profondeur (v3,
    16/10/2026). La nappe (v2) suivait le relief et s'etirait autour des personnages ; David n'en veut plus : sans
    couches, l'image glisse d'un bloc avec une legere perspective, sans aucune deformation."""
    import numpy as np
    from PIL import Image
    rgb = np.asarray(Image.open(src).convert("RGB"), np.float32) / 255
    d = bound_slope(plane(normalize(raw(rgb))))
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
