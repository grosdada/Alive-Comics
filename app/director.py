"""Realisateur IA : a partir des images posees dans la planche et d'une instruction globale, l'IA regle
tout le reste (cameras, actions, textes, sons, voix off, bruitages, son global, ambiance commune).

Une seule demande, toutes les cases en images (ordre de lecture) : l'IA voit la page entiere et peut
raconter une histoire coherente d'une case a l'autre. Les images ne sont jamais touchees.

Competences (skills) lues a chaque demande : app/skills/boucles.md (ecrire des boucles parfaites pour H3, tire de
docs/BOUCLES-IA.html). Traitement par case : video H3, ou relief (photo en relief, carte de profondeur) avec quelques
« biscuits » H3 par page (docs/PARALLAXE-RELIEF.html). Les cases validees par l'auteur (pastille verte) ne sont jamais
modifiees.
"""

import io
import json
import time
from pathlib import Path

from . import llm, presets, store

FIELD_KEYS = set(presets.FIELDS)
CAMERA_IDS = {c["id"] for c in presets.CAMERAS}
ACTION_IDS = {a["id"] for a in presets.ACTIONS}
AUDIO_IDS = {a["id"] for a in presets.AUDIO}
VOICE_IDS = {v["id"] for v in presets.VOICES}
SKILLS = Path(__file__).resolve().parent / "skills"


def skill(name):
    """Texte d'une competence (relu a chaque demande : on peut l'ameliorer sans redemarrer)."""
    try:
        return (SKILLS / f"{name}.md").read_text(encoding="utf-8")
    except OSError:
        return ""


def _small(path, side=1024):
    """Image reduite en JPEG pour l'IA (plus rapide, moins cher) ; l'original si Pillow manque."""
    try:
        from PIL import Image
        im = Image.open(path).convert("RGB")
        im.thumbnail((side, side))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
        return buf.getvalue()
    except ImportError:
        return path


def _catalog():
    cams = [{"id": c["id"], "label": c["label"], "kind": c["kind"], "fields": c.get("fields", []),
             "options": c.get("options", []), "hint": c["hint"]} for c in presets.CAMERAS]
    acts = [{"id": a["id"], "label": a["label"], "fields": a.get("fields", []), "hint": a["hint"]} for a in presets.ACTIONS]
    return {"cameras": cams, "actions": acts,
            "field_meaning": {k: v[0] for k, v in presets.FIELDS.items()},
            "amplitudes": list(presets.AMPLITUDES),
            "audio_presets": [{"id": a["id"], "label": a["label"]} for a in presets.AUDIO],
            "voices": [{"id": v["id"], "label": v["label"]} for v in presets.VOICES],
            "emotions": presets.EMOTIONS}


RULES = """You are the director of an ANIMATED COMIC PAGE. Each panel image becomes a short MiniMax H3 video that the
reader controls or that plays by itself. You see every panel, in reading order. Decide everything for each panel.

How the player works:
- Camera presets of kind "frozen" (orbit360, arc, demi_arc, vertical, travelling) with action "fige" = time is frozen,
  the reader DRAGS the panel to move the camera around the scene. Great for striking compositions, objects, tableaux.
- Any camera with an action other than "fige" = a living shot that plays by itself (loop by default). Use "fixe",
  "grue", "avancee", "epaule" or "custom" for living moments; a frozen-kind camera + action = one animated take.
- Camera "fixe" + action "fige" = a still image (avoid unless it is a deliberate pause).
- LIVING SHOTS MUST LOOP PERFECTLY: follow the attached SKILL "writing perfect loops" for every living panel. Default
  living panel = camera "fixe" + action "custom" with "loop": true and the full English sentence in action.fields.text
  (an engine: flow, relay, cycle or rhythm, a living idle on every character, the closing loop sentence, no banned
  word, no negation). Put at least one orbit360 in the largest panel of the page when its image suits it.
Rules learned by testing MiniMax H3:
- Field values are inserted into English sentences: "subject" is a short noun phrase ("the golden mask");
  "left"/"right"/"ending"/"close"/"wide"/"toward" are NOUN PHRASES describing the final view ("a three-quarter view
  of his face, the round glasses in front"), never a sentence, never the word "camera".
- Describe where the camera ENDS, not just left/right. Name the subject precisely.
- Motion must be strong, constant and clearly visible ("never stop moving"), and say what stays still.
- "rigid": true for solid objects that might wrongly spin on themselves (mask, statue, vehicle, robot).
- Vary the shots across the page (not the same camera everywhere), match each image's composition.
- Prompts, fields, captions: ENGLISH. Voice-off text and explanations: FRENCH.
Sound design:
- "audio" = a looping ambience for the panel (MiniMax Music 3): pick an audio preset id + an English "extra"
  sentence (mood, instruments, textures). Keep the page coherent; not every panel needs its own sound.
- "voice" = a short French narration line (1-2 sentences) told across panels as one story.
- "foley" = true when the living shot makes sounds worth hearing (footsteps, machines, water...).
- "pageSound" = the background sound of the whole page (preset id + English extra).
Answer with JSON only."""

RELIEF_RULES = """TREATMENT OF EACH PANEL ("treatment" field):
- "relief" = DEPTH RELIEF: no video at all, a layered parallax of the photo (faces stay exactly the author's): the
  app cuts the panel into a rebuilt background plus the cut-out people (pop-up book), each with its own depth. The reader
  hovers or clicks and the camera moves a few percent. Works best with 1 to 3 clearly separated subjects; crowds,
  foliage and tangled planes cut badly (prefer a gentle "respire" there). Pick a relief preset matched to the
  composition: "respire" (small push toward the subject: portraits, couples, details), "glisse" (lateral travelling:
  groups, landscapes, tables), "tourne" (small circle around a central subject well detached from the background),
  "vertigo" (subject keeps its size while the background recedes: strong moments).
- "h3" = a real MiniMax H3 shot (a "treat"): about 7 minutes of GPU per panel, so it must be worth it:
  a frozen peak moment (confetti, rice or candy in the air, someone lifted up): frozen-kind camera (orbit360, arc) +
  "fige"; or a gesture worth seeing live (laughter, veil in the wind, candles blown): a looping living shot written
  with the loop skill. Prefer large panels with one clear central subject and large faces; avoid crowds of small faces.
- For relief panels still fill "camera"/"action" with sensible values (kept for a later switch to video), but they
  are not rendered."""



def direct(pid, instruction, options):
    p = store.get(pid)
    locked = {k for k, v in (p.get("panels") or {}).items() if v.get("review") == "ok"}   # pastille verte : intouchable
    geo = {g["id"]: g for g in (p.get("geometry") or {}).get("panels", [])}
    images, order = [], []
    for g in sorted(geo.values(), key=lambda x: x.get("order", 99)):
        panel = p["panels"].get(g["id"]) or {}
        start = store.path(pid, f"start/{g['id']}.png")
        if not panel.get("image") or not start.exists() or g["id"] in locked:
            continue
        w = g["rect"][2] - g["rect"][0]
        h = g["rect"][3] - g["rect"][1]
        shape = "wide" if w > h * 1.3 else ("tall" if h > w * 1.3 else "squarish")
        images.append((f"Panel {g['id']} (reading order {g.get('order')}, {shape} frame):", _small(start)))
        order.append(g["id"])
    if not images:
        raise ValueError("aucune case à régler : poser des images (les cases validées en vert ne sont pas modifiées)")
    mode = options.get("treatment") if options.get("treatment") in ("h3", "relief", "mixed") else "h3"
    treats = max(0, min(4, int(options.get("treats", 1) or 0)))
    want = {"audio": options.get("audio", True), "voice": options.get("voice", False),
            "foley": options.get("foley", True), "pageSound": options.get("pageSound", True)}
    schema = {
        "summary_fr": "2-3 phrases en français : l'idée d'ensemble",
        "style": "one English sentence for the common film look of the page (or empty)",
        "pageSound": {"preset": "audio preset id", "extra": "English sentence"} if want["pageSound"] else None,
        "panels": {pid_: {"treatment": "h3|relief", "relief": {"preset": "respire|glisse|tourne|vertigo"},
                          "camera": {"id": "...", "fields": {}, "amplitude": "petit|moyen|grand", "rigid": False,
                                     "extra": "optional English precision"},
                          "action": {"id": "...", "fields": {}, "loop": True, "extra": "optional English precision"},
                          "audio": {"preset": "...", "extra": "..."} if want["audio"] else None,
                          "voice": {"text": "français", "voice_id": "...", "emotion": "neutral"} if want["voice"] else None,
                          "foley": False if want["foley"] else None,
                          "explain_fr": "une phrase en français"} for pid_ in order[:1]},
    }
    prompt = ("AUTHOR'S GLOBAL INSTRUCTION (follow it, it overrides your own taste):\n" + (instruction.strip() or "(none: use your judgment)")
              + "\n\nCATALOG (use only these ids):\n" + json.dumps(_catalog(), ensure_ascii=False)
              + f"\n\nPanels to direct, in reading order: {', '.join(order)}."
              + "\nWhat to decide: cameras and actions" + (", per-panel ambience" if want["audio"] else "")
              + (", French voice-off narration" if want["voice"] else "") + (", foley" if want["foley"] else "")
              + (", page background sound" if want["pageSound"] else "") + "."
              + {"h3": "\nTreatment: every panel is \"h3\" (a MiniMax H3 video).",
                 "relief": f"\nTreatment: every panel is \"relief\", except at most {treats} \"h3\" treat panel(s) on this page "
                           "(the ones that deserve a real shot; say why in explain_fr).",
                 "mixed": "\nTreatment: choose per panel between \"h3\" and \"relief\" (relief when a video would add little; "
                          "h3 when a real shot is worth 7 minutes of GPU)."}[mode]
              + "\n\nReturn JSON exactly shaped like this (one entry per panel id, here shown for the first):\n"
              + json.dumps(schema, ensure_ascii=False))
    t0 = time.time()
    system = RULES + "\n\n" + RELIEF_RULES + "\n\n" + skill("boucles")
    raw = llm.chat(prompt, images=images, system=system, max_tokens=12000, timeout=300)
    plan = llm._json(raw)
    want["treatment"], want["treats"] = mode, treats
    summary = apply(pid, plan, want, instruction, order)
    summary["locked"] = sorted(locked)
    summary["seconds"] = round(time.time() - t0, 1)
    return summary


def _clean_fields(d):
    return {k: v.strip() for k, v in (d or {}).items() if k in FIELD_KEYS and isinstance(v, str) and v.strip()}


def apply(pid, plan, want, instruction, order):
    decided = []

    def change(p):
        for pid_, d in (plan.get("panels") or {}).items():
            panel = p["panels"].get(pid_)
            if not panel or pid_ not in order or not isinstance(d, dict):
                continue
            cam, act = d.get("camera") or {}, d.get("action") or {}
            panel["camera"] = {"id": cam.get("id") if cam.get("id") in CAMERA_IDS else "fixe",
                               "fields": _clean_fields(cam.get("fields")),
                               "amplitude": cam.get("amplitude") if cam.get("amplitude") in presets.AMPLITUDES else None,
                               "rigid": bool(cam.get("rigid")), "extra": (cam.get("extra") or "").strip()}
            panel["action"] = {"id": act.get("id") if act.get("id") in ACTION_IDS else "fige",
                               "fields": _clean_fields(act.get("fields")),
                               "loop": act.get("loop", True) is not False, "extra": (act.get("extra") or "").strip()}
            # traitement : video H3 ou relief (carte de profondeur), selon le mode choisi par l'auteur
            tr = d.get("treatment") if d.get("treatment") in ("h3", "relief") else "h3"
            if want.get("treatment") == "h3":
                tr = "h3"
            panel["treatment"] = tr
            if tr == "relief":
                pre = (d.get("relief") or {}).get("preset")
                panel["relief"] = dict(panel.get("relief") or {}, preset=pre if pre in presets.RELIEF_IDS else "respire")
            if want["audio"] and (panel.get("audio") or {}).get("mode") != "file":   # un son importe n'est jamais remplace
                a = d.get("audio")
                old = panel.get("audio") or {}
                if isinstance(a, dict) and a.get("preset") in AUDIO_IDS:
                    panel["audio"] = {"mode": "generate", "preset": a["preset"], "extra": (a.get("extra") or "").strip(),
                                      "seconds": 30, "volume": old.get("volume", 0.8), "generated": old.get("generated", []),
                                      "file": None}
                else:
                    panel["audio"] = dict(old, mode="none")
            if want["voice"] and (panel.get("voice") or {}).get("mode") != "file":
                v = d.get("voice")
                old = panel.get("voice") or {}
                if isinstance(v, dict) and (v.get("text") or "").strip():
                    panel["voice"] = {"mode": "tts", "text": v["text"].strip(),
                                      "voice_id": v.get("voice_id") if v.get("voice_id") in VOICE_IDS else "Deep_Voice_Man",
                                      "emotion": v.get("emotion") if v.get("emotion") in presets.EMOTIONS else "neutral",
                                      "language": "French", "speed": 1.0, "loop": False, "volume": old.get("volume", 1.0),
                                      "generated": old.get("generated", []), "file": None}
            if want["foley"]:
                old = panel.get("foley") or {}
                panel["foley"] = dict(old, on=bool(d.get("foley")), engine=old.get("engine", "h3"))
            panel["ai_note"] = (d.get("explain_fr") or "").strip()
            decided.append(pid_)
        if want["pageSound"] and (p.get("pageSound") or {}).get("mode") != "file"                 and isinstance(plan.get("pageSound"), dict) and plan["pageSound"].get("preset") in AUDIO_IDS:
            old = p.get("pageSound") or {}
            p["pageSound"] = {"mode": "generate", "preset": plan["pageSound"]["preset"],
                              "extra": (plan["pageSound"].get("extra") or "").strip(), "seconds": 60,
                              "volume": old.get("volume", 0.6), "generated": old.get("generated", []), "file": None,
                              "rev": time.time()}
        if (plan.get("style") or "").strip():
            p["style"] = plan["style"].strip()
        p["direction"] = {"instruction": instruction, "options": want, "at": time.time(),
                          "summary": (plan.get("summary_fr") or "").strip()}

    store.mutate(pid, change)
    return {"panels": decided, "summary": (plan.get("summary_fr") or "").strip(), "style": plan.get("style", "")}
