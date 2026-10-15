"""Mode edition de l'apercu : retouches d'une case sans tout refaire.

Ce qui est applique par le lecteur, en direct et sans re-encoder (panel["edit"]) :
  shake  {size % de la case, freq Hz, rot degres, seed}   tremble camera
  grade  {sat, bright, contrast, temp -1..1, hue degres}  couleurs
  frame  {zoom >= 1, x, y -1..1}                           cadrage dans la case
  range  [debut, fin] (images)                             points de boucle
  xfade  images de fondu au point de boucle
  speed  vitesse de lecture ; bounce : aller-retour (True) / boucle (False) ; start : image de depart
  ease   {head, tail, gain} : les ralentis du debut et de la fin de boucle (H3 freine pour boucler) joues plus vite
Plus : volumes des sons, sons ajoutes (extraSounds), regeneration de la video ou d'un son avec une consigne.
"""

import json
import secrets
import time
from pathlib import Path

from . import jobs, llm, presets, settings, store

GRADE = {"sat": (0, 3, 1), "bright": (0.3, 2, 1), "contrast": (0.3, 2, 1), "temp": (-1, 1, 0), "hue": (-180, 180, 0)}
USER_PRESETS = Path(__file__).resolve().parent.parent / "data" / "user_presets.json"


def user_presets():
    """Prereglages enregistres par l'utilisateur (pour toutes les planches) : {"shake": [{name, size, freq, rot}]}."""
    try:
        return json.loads(USER_PRESETS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"shake": []}


def save_user_preset(b):
    """b : {kind: "shake", name, value: {size, freq, rot}} ; ou {kind, name, delete: true}. -> tous les prereglages.
    La graine n'est pas gardee : chaque case garde la sienne (sinon toutes les cases trembleraient ensemble)."""
    kind, name = b.get("kind"), (b.get("name") or "").strip()[:40]
    if kind != "shake" or not name:
        raise ValueError("préréglage : kind « shake » et un nom")
    allp = user_presets()
    lst = [x for x in allp.get(kind, []) if x.get("name") != name]
    if not b.get("delete"):
        sh = clean({"shake": b.get("value") or {}}).get("shake") or {}
        lst.append({"name": name, "size": sh.get("size", 0), "freq": sh.get("freq", 0.2), "rot": sh.get("rot", 0)})
    allp[kind] = lst
    USER_PRESETS.parent.mkdir(exist_ok=True)
    USER_PRESETS.write_text(json.dumps(allp, indent=1, ensure_ascii=False), encoding="utf-8")
    return allp


def _num(v, lo, hi, default):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


def clean(e):
    """Retouches recues de l'apercu -> valeurs bornees, sans les reglages neutres."""
    if not isinstance(e, dict):
        return {}
    out = {}
    sh = e.get("shake")
    if isinstance(sh, dict):                       # {} ou taille 0 = « aucun tremble » (remplace celui du preset)
        out["shake"] = {"size": round(_num(sh.get("size"), 0, 6, 0), 3), "freq": round(_num(sh.get("freq"), 0.02, 8, 0.2), 3),
                        "rot": round(_num(sh.get("rot"), 0, 5, 0), 3), "seed": int(_num(sh.get("seed"), 0, 99999, 0))}
    g = e.get("grade")
    if isinstance(g, dict):
        gg = {}
        for k, (lo, hi, neutral) in GRADE.items():
            if k in g:
                v = round(_num(g[k], lo, hi, neutral), 3)
                if v != neutral:
                    gg[k] = v
        if gg:
            out["grade"] = gg
    fr = e.get("frame")
    if isinstance(fr, dict):
        z, x, y = _num(fr.get("zoom"), 1, 3, 1), _num(fr.get("x"), -1, 1, 0), _num(fr.get("y"), -1, 1, 0)
        if z > 1.001:
            out["frame"] = {"zoom": round(z, 3), "x": round(x, 3), "y": round(y, 3)}
    r = e.get("range")
    if isinstance(r, (list, tuple)) and len(r) == 2:
        a, b = int(_num(r[0], 0, 100000, 0)), int(_num(r[1], 0, 100000, 0))
        if b > a + 1:
            out["range"] = [a, b]
    ez = e.get("ease")                           # ralentis du debut / de la fin de boucle joues plus vite
    if isinstance(ez, dict):
        head, tail, gain = int(_num(ez.get("head"), 0, 60, 0)), int(_num(ez.get("tail"), 0, 60, 0)), _num(ez.get("gain"), 1, 5, 1)
        if gain > 1.01 and (head or tail):
            out["ease"] = {"head": head, "tail": tail, "gain": round(gain, 2)}
    xf = int(_num(e.get("xfade"), 0, 48, 0))
    if xf:
        out["xfade"] = xf
    sp = round(_num(e.get("speed"), 0.1, 4, 1), 3)
    if sp != 1:
        out["speed"] = sp
    if isinstance(e.get("bounce"), bool):
        out["bounce"] = e["bounce"]
    if e.get("start") is not None:
        out["start"] = int(_num(e.get("start"), 0, 100000, 0))
    return out


def clean_relief(r):
    out = {}
    if r.get("preset") in presets.RELIEF_IDS:
        out["preset"] = r["preset"]
    for k, lo, hi in (("amount", 0.002, 0.08), ("duration", 0.6, 8)):
        if r.get(k) is not None:
            out[k] = round(_num(r[k], lo, hi, lo), 4)
    if r.get("focus") is not None:
        out["focus"] = round(_num(r["focus"], 0, 1, 0.7), 3)
    if r.get("trigger") in presets.RELIEF_TRIGGERS:
        out["trigger"] = r["trigger"]
    return out


def apply(pid, panel_id, b):
    """Enregistre retouches, volumes, sons ajoutes ; panel_id « _ » = seulement la page (volume du son global)."""
    def upd(p):
        if panel_id != "_":
            panel = p["panels"].get(panel_id)
            if panel is None:
                raise KeyError(panel_id)
            if "edit" in b:
                panel["edit"] = clean(b["edit"])
            if isinstance(b.get("relief"), dict):     # reglages du relief (preset, amplitude, plan net, duree, declenchement)
                panel["relief"] = clean_relief(b["relief"])
            if b.get("treatment") in ("relief", "h3"):
                panel["treatment"] = b["treatment"]
            if b.get("couches") in (True, False):     # relief : utiliser les couches calculees (defaut) ou la nappe seule
                panel["couches"] = b["couches"]
            if "review" in b:                        # suivi : a voir (defaut) / ok / a retoucher
                panel["review"] = b["review"] if b["review"] in ("ok", "redo") else None
            for layer, v in (b.get("volumes") or {}).items():
                if layer in ("audio", "voice", "foley") and isinstance(panel.get(layer), dict):
                    panel[layer]["volume"] = round(_num(v, 0, 1, 0.8), 3)
            if isinstance(b.get("extra"), list):          # volumes / boucle / retrait des sons ajoutes
                have = {x.get("file"): x for x in panel.get("extraSounds") or []}
                panel["extraSounds"] = [dict(have[x["file"]], volume=round(_num(x.get("volume"), 0, 1, 0.8), 3),
                                             loop=bool(x.get("loop", True)))
                                        for x in b["extra"] if isinstance(x, dict) and x.get("file") in have]
        if b.get("pageVolume") is not None and p.get("pageSound"):
            p["pageSound"]["volume"] = round(_num(b["pageVolume"], 0, 1, 0.7), 3)
            p["pageSound"]["rev"] = time.time()
    if any(k in b for k in ("edit", "volumes", "extra", "pageVolume", "review", "relief", "treatment", "couches")):
        store.mutate(pid, upd)


def add_extra_sound(p, panel_id, rel, name):
    panel = p["panels"].get(panel_id)
    if panel is None:
        raise KeyError(panel_id)
    panel.setdefault("extraSounds", []).append({"file": rel, "name": name, "volume": 0.8, "loop": True})


def _english(text, purpose):
    """Consigne en francais -> anglais pour les modeles (si une IA est configuree ; sinon le texte tel quel)."""
    if not any(llm.available().values()):
        return text
    try:
        return llm.translate(text, purpose)
    except llm.LLMError:
        return text


def regen(pid, panel_id, b):
    """Regenere la video d'une case. b : {instruction (francais), prompts {side: anglais}, sameSeed, target, machines}."""
    p = store.get(pid)
    panel = p["panels"].get(panel_id)
    if panel is None:
        raise KeyError(panel_id)
    style = p.get("style", "")
    plan = presets.plan_panel(panel, style)
    if not plan["jobs"]:
        raise ValueError("cette case est une image fixe : rien à régénérer (choisir une action dans l'application)")
    prompts = {j["side"]: j["prompt"] for j in plan["jobs"]}
    for side, txt in (b.get("prompts") or {}).items():
        if side in prompts and (txt or "").strip():
            prompts[side] = txt.strip()
    instr = (b.get("instruction") or "").strip()
    if instr:
        img = store.path(pid, f"start/{panel_id}.png")
        prompts = {s: llm.rewrite_prompt(t, instr, img if img.exists() else None) for s, t in prompts.items()}
    auto = {j["side"]: j["prompt"] for j in presets.plan_panel(dict(panel, prompt_override=None), style)["jobs"]}
    override = {s: t for s, t in prompts.items() if t != auto.get(s)}
    if b.get("sameSeed"):
        side0 = plan["jobs"][0]["side"]
        cur = next((r for r in panel.get("renders") or [] if r["file"] == (panel.get("chosen") or {}).get(side0)), None)
        seed = int(cur["seed"]) if cur else int(panel.get("seed") or settings.load()["render"]["seed"])
    else:
        seed = 100000 + secrets.randbelow(900000)

    def setp(pp):
        pp["panels"][panel_id]["prompt_override"] = override or None
    store.mutate(pid, setp)
    created = jobs.SCHEDULER.enqueue_panel(pid, panel_id, b.get("target") or "local", b.get("machines"), seed)
    return {"jobs": created, "prompts": prompts, "seed": seed}


def regen_sound(pid, panel_id, b):
    """Regenere un son. b : {layer: audio|voice|foley|page, text, sameSeed, machines}."""
    S = jobs.SCHEDULER
    layer, text = b.get("layer"), (b.get("text") or "").strip()
    p = store.get(pid)
    if layer == "page":
        cur = p.get("pageSound") or {}
    else:
        panel = p["panels"].get(panel_id)
        if panel is None:
            raise KeyError(panel_id)
        cur = panel.get(layer) or {}
    if layer == "foley" and cur.get("engine", "h3") == "h3":
        raise ValueError("ces bruitages sortent de la vidéo H3 : régénère la séquence, ou passe aux bruitages "
                         "cloud dans l'application")
    last = (cur.get("generated") or [{}])[-1].get("seed")
    seed = (cur.get("seed") or last or 20261013) if b.get("sameSeed") else 100000 + secrets.randbelow(900000)
    tts = layer == "voice" and cur.get("mode") == "tts"
    if text:
        text = text if tts else _english(text, "foley" if layer == "foley" else "music")

    def upd(pp):
        tgt = pp.setdefault("pageSound", {}) if layer == "page" else pp["panels"][panel_id].setdefault(layer, {})
        if layer == "foley":
            if text:
                tgt["prompt"] = text
            return
        if tts:
            if text:
                tgt["text"] = text
        else:
            if text:
                tgt["caption"] = text
            if layer == "voice":
                tgt["mode"] = "music"
            elif tgt.get("mode") != "generate":
                tgt["mode"] = "generate"
        tgt["seed"] = seed
        if layer == "page":
            tgt["rev"] = time.time()
    store.mutate(pid, upd)
    machines = b.get("machines")
    if layer == "page":
        return {"jobs": S.enqueue_audio(pid, "_page", machines, seed)}
    if layer == "audio":
        return {"jobs": S.enqueue_audio(pid, panel_id, machines, seed)}
    if layer == "voice":
        return {"jobs": S.enqueue_voice(pid, panel_id, machines, seed)}
    if layer == "foley":
        return {"jobs": S.enqueue_foley(pid, panel_id, seed=seed)}
    raise ValueError("couche de son inconnue : " + str(layer))
