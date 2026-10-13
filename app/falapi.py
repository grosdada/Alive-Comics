"""fal.ai : MiniMax H3 dans le cloud, avec le LoRA 360 Orbit charge depuis Hugging Face.

Endpoints (verifies le 13/10/2026 sur le schema OpenAPI de fal) :
  minimax/h3/image-to-video        image_url, end_image_url, prompt, duration (5..15 s), resolution, seed
  minimax/h3/image-to-video/lora   idem + loras: [{path, scale, weight_name}]
prompt_expansion_mode = "disabled" : nos prompts sont ecrits a la main, fal ne doit pas les reecrire.
Limites par rapport au local : pas de fiche perso ni de vues du decor, duree en secondes entieres
(5 s minimum), et H3 y genere une bande-son (retiree a l'assemblage).
"""

import base64
import io
import json
import math
import time
import urllib.error
import urllib.request
from pathlib import Path

QUEUE = "https://queue.fal.run/"
LORA = {"path": "pablodawson/MiniMax-H3-360-Orbit-LoRA", "weight_name": "minimax_h3_flf2v_lora_v1.safetensors"}


class FalError(RuntimeError):
    pass


def _req(url, key, payload=None, method=None, timeout=60):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Authorization": "Key " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        raise FalError("fal %s : %s" % (e.code, e.read().decode("utf-8", "replace")[:1200]))


def data_uri(path):
    path = Path(path)
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    raw = path.read_bytes()
    if len(raw) > 3_000_000 and mime == "image/png":       # alleger les gros PNG
        try:
            from PIL import Image          # optionnel
            buf = io.BytesIO()
            Image.open(path).convert("RGB").save(buf, "JPEG", quality=93)
            raw, mime = buf.getvalue(), "image/jpeg"
        except ImportError:
            pass
    return "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode())


def seconds_for(length_frames):
    return max(5, min(15, math.ceil(length_frames / 24)))


def payload(spec, start_path, resolution="768P"):
    p = {"prompt": spec["full_prompt"], "image_url": data_uri(start_path), "duration": seconds_for(spec["length"]),
         "resolution": resolution, "prompt_expansion_mode": "disabled", "seed": int(spec["seed"]),
         "enable_safety_checker": True}
    if spec.get("last_is_first"):
        p["end_image_url"] = p["image_url"]
    endpoint = "minimax/h3/image-to-video"
    if float(spec.get("lora", 0)) > 0:
        endpoint += "/lora"
        p["loras"] = [dict(LORA, scale=float(spec["lora"]))]
    return endpoint, p


def submit(key, endpoint, body):
    res = _req(QUEUE + endpoint, key, body)
    return {"request_id": res["request_id"], "status_url": res.get("status_url"),
            "response_url": res.get("response_url"), "cancel_url": res.get("cancel_url"), "endpoint": endpoint}


def poll(key, handle):
    """None tant que ce n'est pas fini, sinon la reponse (dict)."""
    st = _req(handle["status_url"], key, timeout=30)
    status = st.get("status")
    if status in ("IN_QUEUE", "IN_PROGRESS"):
        return None
    if status != "COMPLETED":
        raise FalError("fal : statut %s" % status)
    res = _req(handle["response_url"], key, timeout=60)
    if not res or "video" not in res:
        raise FalError("fal : reponse sans video : %s" % json.dumps(res)[:800])
    return res


def cancel(key, handle):
    try:
        if handle.get("cancel_url"):
            _req(handle["cancel_url"], key, method="PUT", timeout=20)
    except (FalError, OSError):
        pass


def download(url, dest):
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=600) as r:
        dest.write_bytes(r.read())
    return dest


def check_key(key):
    """Verifie la cle sans rien lancer : un statut sur une requete inexistante doit repondre 404, pas 401."""
    try:
        _req(QUEUE + "minimax/h3/image-to-video/requests/00000000-0000-0000-0000-000000000000/status", key, timeout=15)
        return True, ""
    except FalError as e:
        msg = str(e)
        if " 401" in msg or " 403" in msg:
            return False, "clé refusée par fal"
        return True, ""
    except OSError as e:
        return False, "fal injoignable (%s)" % e.__class__.__name__
