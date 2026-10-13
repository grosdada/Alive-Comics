"""ComfyUI par HTTP : graphes H3 (temps fige / anime) et MiniMax Music 3, envoi, attente, recuperation.

Rien a installer cote client (bibliotheque standard). Cote worker : ComfyUI >= 0.33, le noeud
comfyui-h3-orbital (H3OrbitalConditioning), le LoRA 360 Orbit et, pour le son, MiniMax Music 3.
"""

import json
import mimetypes
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

H3_UNET = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
H3_LORA = "minimax_h3_flf2v_lora_v1.safetensors"
H3_CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
H3_VAE = "minimax_h3_video_vae_fp16.safetensors"
H3_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"   # piste son native (bruitages)
M3_DIT = "minimax_music3_dit_fp16.safetensors"
M3_TE = "minimax_music3_text_encoder_pruned_int8_convrot.safetensors"
M3_VAE = "minimax_music3_dav.safetensors"


class ComfyError(RuntimeError):
    pass


def http_json(url, payload=None, timeout=30):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8") or "null")


def upload(server, path, subfolder):
    """POST /upload/image ; renvoie 'sous-dossier/nom' pour LoadImage.image."""
    path = Path(path)
    boundary = "----alivecomics-" + uuid.uuid4().hex
    mime = mimetypes.guess_type(path.name)[0] or "image/png"

    def part(name, value, ctype=None, filename=None):
        head = '--%s\r\nContent-Disposition: form-data; name="%s"' % (boundary, name)
        if filename:
            head += '; filename="%s"' % filename
        if ctype:
            head += "\r\nContent-Type: %s" % ctype
        body = value if isinstance(value, bytes) else str(value).encode()
        return head.encode() + b"\r\n\r\n" + body + b"\r\n"

    body = b"".join([part("image", path.read_bytes(), mime, path.name), part("type", "input"),
                     part("subfolder", subfolder), part("overwrite", "true"), ("--%s--\r\n" % boundary).encode()])
    req = urllib.request.Request(server.rstrip("/") + "/upload/image", data=body, method="POST",
                                 headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=120) as r:
        res = json.loads(r.read().decode("utf-8"))
    return "%s/%s" % (res["subfolder"], res["name"]) if res.get("subfolder") else res["name"]


# ------------------------------------------------------------------ graphes
def _h3_common(g, lora):
    g.update({
        "4": {"class_type": "UNETLoader", "inputs": {"unet_name": H3_UNET, "weight_dtype": "default"}},
        "5": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["4", 0], "lora_name": H3_LORA,
                                                               "strength_model": float(lora)}},
        "6": {"class_type": "CLIPLoader", "inputs": {"clip_name": H3_CLIP, "type": "minimax", "device": "default"}},
        "7": {"class_type": "VAELoader", "inputs": {"vae_name": H3_VAE}},
    })


def h3_graph(spec, image_names, prefix, steps=28, audio=True):
    """spec : {mode: orbit|path|animated, prompt, lora, length, seed, megapixels, last_is_first, refs}
    image_names : {"start": "...", "character": [...], "set": [...]} (noms renvoyes par upload)."""
    g = {
        "1": {"class_type": "LoadImage", "inputs": {"image": image_names["start"]}},
        "2": {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": ["1", 0], "upscale_method": "lanczos",
                                                                  "megapixels": float(spec["megapixels"]),
                                                                  "resolution_steps": 32}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(spec["seed"])}},
        "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "11": {"class_type": "BasicScheduler", "inputs": {"model": ["5", 0], "scheduler": "simple", "steps": int(steps),
                                                          "denoise": 1.0}},
        "12": {"class_type": "BasicGuider", "inputs": {"model": ["5", 0], "conditioning": ["8", 0]}},
        "13": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["12", 0],
                                                                 "sampler": ["10", 0], "sigmas": ["11", 0],
                                                                 "latent_image": ["8", 1]}},
        "14": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["7", 0]}},
        "15": {"class_type": "CreateVideo", "inputs": {"images": ["14", 0], "fps": 24, "bit_depth": 8}},
        "16": {"class_type": "SaveVideo", "inputs": {"video": ["15", 0], "filename_prefix": prefix,
                                                     "format": "auto", "codec": "auto"}},
    }
    _h3_common(g, spec.get("lora", 0.0))
    if audio:   # comme le modele officiel : la piste son du latent AV, decodee et jointe a la video
        g["50"] = {"class_type": "VAELoader", "inputs": {"vae_name": H3_AUDIO_VAE}}
        g["51"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["13", 0], "vae": ["50", 0]}}
        g["15"]["inputs"]["audio"] = ["51", 0]
    if spec["mode"] in ("orbit", "path"):
        cond = {"clip": ["6", 0], "vae": ["7", 0], "start_image": ["2", 0], "mode": spec["mode"],
                "prompt": spec.get("prompt", ""), "length": int(spec["length"]), "ref_image_size": "match",
                "mirror": False}
        for kind, base in (("character", 21), ("set", 31)):
            for i, name in enumerate((image_names.get(kind) or [])[:4]):
                nid = str(base + i)
                g[nid] = {"class_type": "LoadImage", "inputs": {"image": name}}
                cond[f"{kind}_{i + 1}"] = [nid, 0]
        g["8"] = {"class_type": "H3OrbitalConditioning", "inputs": cond}
    else:   # plan anime : noeud natif, sans preambule « temps fige »
        g["3"] = {"class_type": "GetImageSize", "inputs": {"image": ["2", 0]}}
        cond = {"clip": ["6", 0], "vae": ["7", 0], "first_frame": ["2", 0], "width": ["3", 0], "height": ["3", 1],
                "length": int(spec["length"]), "prompt": spec.get("prompt", "")}
        if spec.get("last_is_first"):
            cond["last_frame"] = ["2", 0]
        g["8"] = {"class_type": "MiniMaxH3ImageToVideo", "inputs": cond}
    return g


def music_graph(caption, lyrics, seed, seconds, prefix):
    return {
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": M3_TE, "type": "minimax", "device": "default"}},
        "6": {"class_type": "UNETLoader", "inputs": {"unet_name": M3_DIT, "weight_dtype": "default"}},
        "7": {"class_type": "VAELoader", "inputs": {"vae_name": M3_VAE}},
        "13": {"class_type": "MiniMaxMusic3TextEncode",
               "inputs": {"caption": caption, "lyrics": lyrics, "seed": int(seed), "max_duration": int(seconds),
                          "cfg_scale": 1.7, "top_k": 50, "clip": ["3", 0]}},
        "10": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["13", 0]}},
        "15": {"class_type": "EmptyMiniMaxMusic3LatentAudio", "inputs": {"seconds": ["13", 1], "batch_size": 1}},
        "9": {"class_type": "KSampler", "inputs": {"seed": int(seed), "steps": 30, "cfg": 1.7, "sampler_name": "euler",
                                                   "scheduler": "simple", "denoise": 1, "model": ["6", 0],
                                                   "positive": ["13", 0], "negative": ["10", 0],
                                                   "latent_image": ["15", 0]}},
        "12": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["9", 0], "vae": ["7", 0]}},
        "35": {"class_type": "SaveAudioAdvanced", "inputs": {"filename_prefix": prefix, "format": "mp3",
                                                             "format.quality": "V0", "audio": ["12", 0]}},
    }


# ------------------------------------------------------------------ execution
def submit(server, graph):
    try:
        res = http_json(server.rstrip("/") + "/prompt", {"prompt": graph, "client_id": str(uuid.uuid4())})
    except urllib.error.HTTPError as e:
        raise ComfyError("ComfyUI a refuse le graphe : " + e.read().decode("utf-8", "replace")[:1500])
    return res["prompt_id"]


def poll(server, prompt_id):
    """None tant que ce n'est pas fini ; sinon l'entree d'historique. Leve ComfyError si erreur."""
    entry = http_json("%s/history/%s" % (server.rstrip("/"), prompt_id)).get(prompt_id)
    if not entry:
        return None
    status = entry.get("status") or {}
    if status.get("status_str") == "error":
        msgs = [m for m in status.get("messages", []) if m and m[0] == "execution_error"]
        detail = msgs[0][1].get("exception_message", "") if msgs else ""
        raise ComfyError("rendu en erreur : " + (detail or json.dumps(msgs))[:1500])
    return entry if status.get("completed") else None


def outputs(entry, exts):
    for node_output in (entry.get("outputs") or {}).values():
        for key in ("images", "videos", "gifs", "audio"):
            for item in node_output.get(key) or []:
                if item.get("filename", "").lower().endswith(exts):
                    yield item


def download(server, item, dest):
    q = urllib.parse.urlencode({"filename": item["filename"], "subfolder": item.get("subfolder", ""),
                                "type": item.get("type", "output")})
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(f"{server.rstrip('/')}/view?{q}", timeout=600) as r:
        dest.write_bytes(r.read())
    return dest


def queue_load(server):
    """Nombre de travaux en cours + en attente sur ce ComfyUI (tous clients confondus)."""
    q = http_json(server.rstrip("/") + "/queue", timeout=8)
    return len(q.get("queue_running", [])) + len(q.get("queue_pending", []))


def cancel(server, prompt_id):
    try:
        http_json(server.rstrip("/") + "/queue", {"delete": [prompt_id]}, timeout=8)
        q = http_json(server.rstrip("/") + "/queue", timeout=8)
        if any(item[1] == prompt_id for item in q.get("queue_running", [])):
            http_json(server.rstrip("/") + "/interrupt", {}, timeout=8)
    except (OSError, ValueError):
        pass


def preflight(server):
    """{online, version, video: bool, music: bool, missing: [...], load} pour l'interface et le planificateur."""
    out = {"online": False, "version": "", "video": False, "music": False, "h3audio": False, "missing": [], "load": 0,
           "gpu": ""}
    try:
        stats = http_json(server.rstrip("/") + "/system_stats", timeout=6)
    except (OSError, ValueError) as exc:
        out["missing"] = ["injoignable (%s)" % exc.__class__.__name__]
        return out
    out["online"] = True
    out["version"] = stats.get("system", {}).get("comfyui_version", "")
    devs = stats.get("devices") or []
    if devs:
        name = re.sub(r"^cuda:\d+\s*", "", devs[0].get("name", "")).split(" : ")[0]
        out["gpu"] = name.replace("NVIDIA GeForce ", "")[:30]
    if tuple(int(x) for x in re.findall(r"\d+", out["version"])[:3]) < (0, 33, 0):
        out["missing"].append("ComfyUI %s < 0.33" % out["version"])

    def has(node, field=None, fname=None):
        try:
            info = http_json("%s/object_info/%s" % (server.rstrip("/"), node), timeout=10)
        except (OSError, ValueError):
            return False
        if node not in info:
            return False
        if field:
            opts = info[node]["input"]["required"][field][0]
            return fname in opts
        return True

    video_checks = [("H3OrbitalConditioning", None, None, "noeud H3OrbitalConditioning"),
                    ("MiniMaxH3ImageToVideo", None, None, "noeud MiniMaxH3ImageToVideo"),
                    ("UNETLoader", "unet_name", H3_UNET, "modele H3 fl2va"),
                    ("LoraLoaderModelOnly", "lora_name", H3_LORA, "LoRA 360 Orbit"),
                    ("CLIPLoader", "clip_name", H3_CLIP, "encodeur qwen3vl")]
    miss_v = [label for node, f, fn, label in video_checks if not has(node, f, fn)]
    out["video"] = not miss_v and not out["missing"]
    miss_m = [label for node, f, fn, label in [("MiniMaxMusic3TextEncode", None, None, "noeud Music 3"),
                                               ("UNETLoader", "unet_name", M3_DIT, "modele Music 3")]
              if not has(node, f, fn)]
    out["music"] = not miss_m and not out["missing"]
    out["h3audio"] = has("VAELoader", "vae_name", H3_AUDIO_VAE)
    out["missing"] += miss_v + miss_m
    try:
        out["load"] = queue_load(server)
    except (OSError, ValueError):
        pass
    return out
