"""L'intelligence branchee a l'application : Anthropic (defaut), OpenAI, Google, DeepSeek.

Usages en mode manuel :
- suggest_panel() : regarde l'image d'une case et remplit les champs (en anglais) du mouvement
  de camera, de l'action et de l'ambiance sonore choisis ;
- translate() : met un texte libre en anglais propre pour H3 / Music 3 ;
- ask() : question libre (aide).
Les cles restent dans local_settings.json. DeepSeek ne voit pas les images (texte seulement).
"""

import base64
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

from . import presets, settings


class LLMError(RuntimeError):
    pass


def _post(url, headers, body, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=dict(headers, **{"Content-Type": "application/json"}))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise LLMError(f"{e.code} : {e.read().decode('utf-8', 'replace')[:600]}")
    except OSError as e:
        raise LLMError(f"injoignable : {e}")


def available():
    cfg = settings.load()["llm"]
    return {p: bool(cfg[p].get("key")) for p in ("anthropic", "openai", "google", "deepseek")}


def chat(prompt, image=None, system="", provider=None, max_tokens=1200):
    """image : chemin d'un PNG/JPEG ou None. Renvoie le texte."""
    cfg = settings.load()["llm"]
    provider = provider or cfg.get("provider") or "anthropic"
    pc = cfg.get(provider) or {}
    if not pc.get("key"):
        others = [p for p, ok in available().items() if ok]
        if not others:
            raise LLMError("aucune clé d'IA : en ajouter une dans Réglages › Intelligence")
        provider, pc = others[0], cfg[others[0]]
    b64 = mime = None
    if image:
        raw = Path(image).read_bytes()
        b64 = base64.b64encode(raw).decode()
        mime = "image/png" if raw[:4] == b"\x89PNG" else "image/jpeg"
    if provider == "anthropic":
        content = ([{"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}}] if b64 else [])
        content.append({"type": "text", "text": prompt})
        body = {"model": pc["model"], "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}]}
        if system:
            body["system"] = system
        res = _post("https://api.anthropic.com/v1/messages",
                    {"x-api-key": pc["key"], "anthropic-version": "2023-06-01"}, body)
        return "".join(b.get("text", "") for b in res.get("content", []))
    if provider in ("openai", "deepseek"):
        url = "https://api.openai.com/v1/chat/completions" if provider == "openai" else "https://api.deepseek.com/chat/completions"
        if b64 and provider == "openai":
            content = [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}]
        else:
            content = prompt + ("\n\n(Image non transmise : ce modèle ne lit que du texte.)" if b64 else "")
        msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": content}]
        res = _post(url, {"Authorization": "Bearer " + pc["key"]}, {"model": pc["model"], "messages": msgs})
        return res["choices"][0]["message"]["content"]
    if provider == "google":
        parts = ([{"inline_data": {"mime_type": mime, "data": b64}}] if b64 else []) + [{"text": prompt}]
        body = {"contents": [{"role": "user", "parts": parts}]}
        if system:
            body["system_instruction"] = {"parts": [{"text": system}]}
        res = _post(f"https://generativelanguage.googleapis.com/v1beta/models/{pc['model']}:generateContent",
                    {"x-goog-api-key": pc["key"]}, body)
        return "".join(p.get("text", "") for p in res["candidates"][0]["content"]["parts"])
    raise LLMError("fournisseur inconnu : " + provider)


def _json(text):
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise LLMError("réponse sans JSON : " + text[:300])
    return json.loads(m.group(0))


SYSTEM = ("You write prompts for MiniMax H3, an image-to-video model, for an animated comic page. Rules learned by "
          "testing: describe where the camera ENDS (what we see at the end), never just 'left' or 'right'; name the "
          "subject precisely; keep each field short (under 25 words), concrete and visual, in English. For motion, "
          "describe it as strong, constant and clearly visible. Answer with JSON only.")


def suggest_panel(image, camera_id, action_id, audio_preset=None, note=""):
    cam = presets.camera(camera_id)
    act = presets.action(action_id)
    want = {f: presets.FIELDS[f][0] for f in cam.get("fields", []) if f != "text"}
    want_act = {f: presets.FIELDS[f][0] for f in act.get("fields", []) if f != "text"}
    prompt = (
        f"This image is one panel of a comic page. Camera move chosen: '{cam['label']}' ({cam['hint']}). "
        f"Action chosen: '{act['label']}' ({act['hint']}).\n"
        f"Fill these camera fields: {json.dumps(want, ensure_ascii=False)}.\n"
        f"Fill these action fields: {json.dumps(want_act, ensure_ascii=False)}.\n"
        "For 'left' / 'right': describe what we see at the end of the camera arc toward that side of the frame "
        "(e.g. 'a three-quarter view of his face, the round glasses in front'). For 'close' / 'wide': the end of a "
        "dolly in / dolly out.\n"
        + (f"Also write an 'audio' caption for an ambient sound loop in the style '{audio_preset}': one English "
           "sentence about mood and instruments.\n" if audio_preset else "")
        + (f"Author's note: {note}\n" if note else "")
        + 'Answer: {"camera": {...}, "action": {...}, "audio": "...", "rigid": true|false, "explain_fr": "une phrase en '
          'français : ce que tu as vu et pourquoi ces choix"}. "rigid" = the subject is a solid object that could '
          "wrongly spin on itself (mask, statue, vehicle).")
    return _json(chat(prompt, image=image, system=SYSTEM))


def translate(text, purpose="video"):
    what = "a camera/action prompt for an image-to-video model" if purpose == "video" else "a music caption"
    out = chat(f"Rewrite this as {what}, in clear concise English, keeping every idea. Text only, no quotes:\n\n{text}",
               max_tokens=600)
    return out.strip().strip('"')
