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


def _img(data):
    """(base64, mime) d'un chemin ou d'octets."""
    raw = Path(data).read_bytes() if not isinstance(data, (bytes, bytearray)) else bytes(data)
    return base64.b64encode(raw).decode(), ("image/png" if raw[:4] == b"\x89PNG" else "image/jpeg")


def chat(prompt, image=None, system="", provider=None, max_tokens=1200, images=None, timeout=120):
    """image : un chemin d'image ; images : [(etiquette, chemin ou octets), ...] (plusieurs images). Renvoie le texte."""
    cfg = settings.load()["llm"]
    provider = provider or cfg.get("provider") or "anthropic"
    pc = cfg.get(provider) or {}
    if not pc.get("key"):
        others = [p for p, ok in available().items() if ok]
        if not others:
            raise LLMError("aucune clé d'IA : en ajouter une dans Réglages › Intelligence")
        provider, pc = others[0], cfg[others[0]]
    imgs = [(label, *_img(data)) for label, data in (images or [])]
    if image:
        imgs.append(("", *_img(image)))
    if provider == "anthropic":
        content = []
        for label, b64, mime in imgs:
            if label:
                content.append({"type": "text", "text": label})
            content.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}})
        content.append({"type": "text", "text": prompt})
        body = {"model": pc["model"], "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}]}
        if system:
            body["system"] = system
        res = _post("https://api.anthropic.com/v1/messages",
                    {"x-api-key": pc["key"], "anthropic-version": "2023-06-01"}, body, timeout=timeout)
        return "".join(b.get("text", "") for b in res.get("content", []))
    if provider in ("openai", "deepseek"):
        url = "https://api.openai.com/v1/chat/completions" if provider == "openai" else "https://api.deepseek.com/chat/completions"
        if imgs and provider == "openai":
            content = []
            for label, b64, mime in imgs:
                if label:
                    content.append({"type": "text", "text": label})
                content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
            content.append({"type": "text", "text": prompt})
        else:
            content = prompt + ("\n\n(Images non transmises : ce modèle ne lit que du texte.)" if imgs else "")
        msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": content}]
        body = {"model": pc["model"], "messages": msgs}
        res = _post(url, {"Authorization": "Bearer " + pc["key"]}, body, timeout=timeout)
        return res["choices"][0]["message"]["content"]
    if provider == "google":
        parts = []
        for label, b64, mime in imgs:
            if label:
                parts.append({"text": label})
            parts.append({"inline_data": {"mime_type": mime, "data": b64}})
        parts.append({"text": prompt})
        body = {"contents": [{"role": "user", "parts": parts}]}
        if system:
            body["system_instruction"] = {"parts": [{"text": system}]}
        res = _post(f"https://generativelanguage.googleapis.com/v1beta/models/{pc['model']}:generateContent",
                    {"x-goog-api-key": pc["key"]}, body, timeout=timeout)
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
    want = {f: presets.FIELDS[f][0] for f in cam.get("fields", [])}
    want_act = {f: presets.FIELDS[f][0] for f in act.get("fields", [])} if action_id != "fige" else {}
    if "text" in want:
        want["text"] = "the whole camera move, one or two English sentences"
    if "text" in want_act:
        want_act["text"] = "the whole action, one or two English sentences, strong and clearly visible motion"
    prompt = (
        f"This image is one panel of a comic page. Camera move chosen: '{cam['label']}' ({cam['hint']}). "
        f"Action chosen: '{act['label']}' ({act['hint']}).\n"
        f"Fill these camera fields: {json.dumps(want, ensure_ascii=False)}.\n"
        f"Fill these action fields: {json.dumps(want_act, ensure_ascii=False)}.\n"
        "Field values are inserted into sentences such as 'The camera moves ... around {subject} ..., ending on {left}'. "
        "So 'subject' is a short noun phrase (e.g. 'the golden mask'); 'left', 'right', 'ending', 'close', 'wide' are "
        "noun phrases describing the FINAL view, starting with 'a' or 'the' (e.g. 'a three-quarter view of his face, "
        "the round glasses in front'), never a sentence and never the word 'camera'. 'toward' is a noun phrase too.\n"
        + (f"Also write 'audio': one English sentence for an ambient sound loop in the style '{audio_preset}' (mood, "
           "instruments, textures).\n" if audio_preset else "")
        + (f"Author's note: {note}\n" if note else "")
        + 'Answer: {"camera": {...}, "action": {...}, "audio": "...", "rigid": true|false, "explain_fr": "une phrase en '
          'français : ce que tu as vu et pourquoi ces choix"}. "rigid" = the subject is a solid object that could '
          "wrongly spin on itself (mask, statue, vehicle).")
    loop = action_id != "fige"                    # plan anime : la competence boucles s'applique
    return _json(chat(prompt, image=image, system=SYSTEM + ("\n\n" + _loop_skill() if loop else "")))


def voice_line(image, note="", language="French"):
    """Une courte voix off pour la case (une ou deux phrases), dans la langue demandee."""
    lang = {"French": "français", "English": "anglais", "Spanish": "espagnol", "Italian": "italien",
            "German": "allemand", "Portuguese": "portugais", "Japanese": "japonais"}.get(language, "français")
    out = chat(f"Cette image est une case de bande dessinée. Écris une voix off de narrateur, en {lang}, pour cette case : "
               "une ou deux phrases courtes, évocatrices, au présent, sans guillemets ni didascalies."
               + (f" Indication de l'auteur : {note}" if note else ""), image=image, max_tokens=300)
    return out.strip().strip('"«» ')


def list_models(provider):
    """Modeles disponibles chez un fournisseur (avec la cle enregistree)."""
    import urllib.request
    cfg = settings.load()["llm"]
    key = (cfg.get(provider) or {}).get("key")
    if not key:
        raise LLMError("pas de clé pour " + provider)

    def get(url, headers):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise LLMError(f"{e.code} : {e.read().decode('utf-8', 'replace')[:300]}")

    if provider == "anthropic":
        res = get("https://api.anthropic.com/v1/models?limit=100", {"x-api-key": key, "anthropic-version": "2023-06-01"})
        return [{"id": m["id"], "label": m.get("display_name") or m["id"]} for m in res.get("data", [])]
    if provider == "openai":
        res = get("https://api.openai.com/v1/models", {"Authorization": "Bearer " + key})
        skip = re.compile(r"audio|realtime|tts|transcribe|whisper|embedding|image|dall|moderation|search|davinci|babbage", re.I)
        ids = sorted((m["id"] for m in res.get("data", []) if re.match(r"(gpt|o\d|chatgpt)", m["id"]) and not skip.search(m["id"])),
                     reverse=True)
        return [{"id": i, "label": i} for i in ids]
    if provider == "google":
        res = get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {"x-goog-api-key": key})
        out = []
        for m in res.get("models", []):
            if "generateContent" in (m.get("supportedGenerationMethods") or []) and "gemini" in m["name"]:
                out.append({"id": m["name"].split("/", 1)[1], "label": m.get("displayName") or m["name"]})
        return out
    if provider == "deepseek":
        res = get("https://api.deepseek.com/models", {"Authorization": "Bearer " + key})
        return [{"id": m["id"], "label": m["id"]} for m in res.get("data", [])]
    raise LLMError("fournisseur inconnu : " + provider)


EDIT_SYSTEM = SYSTEM.replace(" Answer with JSON only.", "")


def _loop_skill():
    """Competence « boucles parfaites » (app/skills/boucles.md), pour tout texte de plan anime en boucle."""
    try:
        return (Path(__file__).resolve().parent / "skills" / "boucles.md").read_text(encoding="utf-8")
    except OSError:
        return ""


def rewrite_prompt(prompt, instruction, image=None):
    """Mode edition : integre une consigne de l'auteur (souvent en francais) au prompt qui a produit la video."""
    ask = ("This prompt produced the current video of a comic panel (its start image is attached):\n\n"
           f"{prompt}\n\nThe author wants this change: {instruction}\n\n"
           "Rewrite the prompt to include the change and keep everything else that is not contradicted (subject, camera, "
           "ending, loop or stillness instructions, final 'No cuts.'). English, about the same length. "
           "Answer with the prompt text only, no quotes, no comment.")
    out = chat(ask, image=image, system=EDIT_SYSTEM + "\n\n" + _loop_skill(), max_tokens=700)
    return out.strip().strip('"').strip()


def translate(text, purpose="video"):
    what = {"video": "a camera/action prompt for an image-to-video model",
            "foley": "a short description of sound effects for a video-to-audio model"}.get(purpose, "a music caption")
    out = chat(f"Rewrite this as {what}, in clear concise English, keeping every idea. Text only, no quotes:\n\n{text}",
               max_tokens=600)
    return out.strip().strip('"')
