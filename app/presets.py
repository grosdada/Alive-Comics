"""Vocabulaire d'Alive-Comics : mouvements de camera, actions, ambiances sonores.

Source unique : l'interface recoit ces listes par /api/presets, le moteur s'en sert pour ecrire
les prompts et choisir le graphe. Les textes viennent des essais H3-Orbital (planches 1 a 3,
octobre 2026) : destinations decrites plutot que gauche/droite, angles majores (H3 en fait ~60 %),
« Then the camera stops. No zoom, no dolly. », dolly « and not a zoom », LoRA 0,5 pour un objet
rigide, mouvement fort et constant pour une boucle animee.
"""

# Prompt de l'auteur du LoRA 360 Orbit (Pablo Dawson), mot pour mot.
ORBIT_PROMPT = (
    "One frozen instant. Only the camera moves. In a continuous 360 orbit. Preserve every person and "
    "object in exactly the same world position, orientation, shape and pose throughout the shot. Airborne "
    "objects remain suspended at the captured height and angle: no wobbling, shaking, spinning, drifting, "
    "falling or continued action. Keep faces, hands, clothing, liquids and the background motionless while "
    "retaining their natural appearance. Camera parallax is the only source of apparent movement. No cuts, "
    "zoom, morphing or added objects."
)
FROZEN_PROMPT = ORBIT_PROMPT.replace(" In a continuous 360 orbit.", "")
TAIL = " Then the camera stops. No zoom, no dolly."

AMPLITUDES = {"lytro": 16, "petit": 40, "moyen": 55, "grand": 70}   # angle ECRIT dans le prompt (H3 en fait moins)
# « lytro » (16/10) : tout petit arc de part et d'autre de la photo, le lecteur n'en montre qu'une partie au survol
# (emulation de la Lytro : perspective qui suit la souris, mise au point au clic)

# Tremble « camera a l'epaule » ajoute au montage (ffmpeg), car H3 ne fait qu'un tremble mou et imprevisible.
# (deplacement en fraction de l'image, rotation en radians) ; periodique : la boucle reste parfaite.
# v2 (14/10, retour de David) : la v1 (3,6 % + saccades rapides) faisait « faux tremble 2D ». Derive lente et douce,
# a peine de rotation : on doit sentir l'operateur, pas voir l'image bouger. v3 (autre session, 80553bd) : recadrage
# a position fractionnaire (filtre perspective) et derive plus lente, voir assemble.shake_filter.
SHAKES = {"aucun": (0, 0), "leger": (0.004, 0.0008), "moyen": (0.008, 0.0016), "fort": (0.013, 0.0025)}
SHAKE_VERSION = 4                              # 4 : applique par le lecteur (voir shake_params)
SHAKE_DEFAULT = {"epaule": "moyen"}            # sinon : aucun


def shake_level(panel):
    cam = (panel or {}).get("camera") or {}
    return cam.get("shake") or SHAKE_DEFAULT.get(cam.get("id"), "aucun")


# v4 (15/10, mode edition) : le tremble n'est plus integre a la video, c'est le lecteur qui l'applique en direct
# (transformation CSS a position fractionnaire, comme la v3) : reglable dans l'apercu sans re-encoder.
# Parametres du lecteur : size = amplitude en % de la case, freq = frequence principale en Hz (la v3 faisait
# 1 a 3 cycles par boucle de 5 s, soit ~0,2 Hz), rot = rotation en degres, seed = phases.
SHAKE_FREQ = 0.2


def shake_params(panel, pid=""):
    """Tremble du lecteur pour une case : celui regle a la main (edit.shake), sinon le niveau du preset."""
    own = ((panel or {}).get("edit") or {}).get("shake")
    if isinstance(own, dict):
        return own if float(own.get("size") or 0) > 0 or float(own.get("rot") or 0) > 0 else None
    amp, rot = SHAKES.get(shake_level(panel), (0, 0))
    if not amp:
        return None
    seed = sum(ord(c) * (i + 1) for i, c in enumerate(pid)) % 997
    return {"size": round(amp * 100, 3), "freq": SHAKE_FREQ, "rot": round(rot * 57.29578, 3), "seed": seed}

# ------------------------------------------------------------------ cameras
# kind : "frozen" = temps fige, la case se pilote au glisser ; "animated" = la scene bouge, lecture auto.
# fields : champs a remplir (anglais de preference ; l'IA peut les proposer).
CAMERAS = [
    {"id": "fixe", "label": "Caméra fixe", "kind": "animated", "fields": [],
     "hint": "La caméra ne bouge pas. Choisis une action pour animer la case (sinon elle reste une image)."},
    {"id": "orbit360", "label": "Orbite 360° en boucle", "kind": "frozen", "fields": ["subject"],
     "hint": "Tour complet autour du sujet, scène figée. Au glisser, la case tourne sans fin."},
    {"id": "arc", "label": "Arc gauche ↔ droite", "kind": "frozen", "fields": ["subject", "left", "right"],
     "options": ["amplitude", "rigid"],
     "hint": "Deux demi-arcs, la case au milieu. Décris ce qu'on voit à la fin de chaque côté."},
    {"id": "demi_arc", "label": "Demi-arc d'un seul côté", "kind": "frozen", "fields": ["subject", "toward", "ending"],
     "options": ["amplitude", "rigid"],
     "hint": "Un seul arc, plus large. Utile quand H3 tourne toujours du même côté."},
    {"id": "vertical", "label": "Plongée ↕ contre-plongée", "kind": "frozen", "fields": ["subject"],
     "options": ["amplitude"],
     "hint": "Arc vertical : vue rasante d'un côté, vue plongeante de l'autre. Idéal pour les textures."},
    {"id": "travelling", "label": "Travelling avant ↔ arrière", "kind": "frozen", "fields": ["subject", "close", "wide"],
     "hint": "La caméra avance vers le sujet d'un côté et recule de l'autre (un vrai travelling, pas un zoom)."},
    {"id": "grue", "label": "Grue qui monte", "kind": "animated", "fields": ["subject"],
     "hint": "La caméra monte et finit en plongée. Se combine avec une action."},
    {"id": "avancee", "label": "Lente avancée", "kind": "animated", "fields": ["subject"],
     "hint": "La caméra s'approche doucement du sujet. Se combine avec une action."},
    {"id": "epaule", "label": "Caméra à l'épaule", "kind": "animated", "fields": [],
     "hint": "Caméra tenue à la main : balancement et tremblé visibles, sans déplacement. Se combine avec une action."},
    {"id": "custom", "label": "Texte libre…", "kind": "animated", "fields": ["text"],
     "hint": "Décris toi-même le mouvement de caméra (en anglais de préférence)."},
]

# ------------------------------------------------------------------ actions
# loop : la video se referme (1re image = derniere) et tourne vers l'avant ; sinon aller-retour.
ACTIONS = [
    {"id": "fige", "label": "Temps figé", "loop": False, "fields": [],
     "hint": "Rien ne bouge dans la scène, seule la caméra se déplace."},
    {"id": "vie", "label": "Vie en boucle", "loop": True, "fields": ["subject"],
     "hint": "Les personnages vivent sur place : respiration, regards, mains, poids du corps, cheveux. Naturel mais visible."},
    {"id": "nerveux", "label": "Mouvement nerveux en boucle", "loop": True, "fields": ["subject", "detail"],
     "hint": "Un détail qui gigote sans arrêt (doigts, tentacules…). Précise lequel dans « détail »."},
    {"id": "danse", "label": "Danse / mouvement rythmé", "loop": False, "fields": ["subject", "detail"],
     "hint": "Les personnages dansent en rythme, sur place."},
    {"id": "marche", "label": "Marche", "loop": False, "fields": ["subject"],
     "hint": "Le personnage avance en marchant."},
    {"id": "parole", "label": "Parle / expression", "loop": False, "fields": ["subject"],
     "hint": "Le personnage parle avec expression, petits gestes."},
    {"id": "elements", "label": "Éléments en boucle", "loop": True, "fields": ["detail"],
     "hint": "Vent, fumée, eau, feu, lumière qui bougent en continu ; les personnages restent presque immobiles."},
    {"id": "custom", "label": "Texte libre…", "loop": False, "fields": ["text"],
     "hint": "Décris toi-même l'action (en anglais de préférence). Coche « en boucle » si elle doit se refermer."},
]

# ------------------------------------------------------------------ sons
AUDIO = [
    {"id": "drone_inquietant", "label": "Drone inquiétant",
     "caption": "Global Metadata: Unsettling dark ambient drone, horror atmosphere. Free tempo, atonal, low register. "
                "{drone} {extra}\n\nVocal Details: No vocals at all, fully instrumental.\n\nArrangement: deep sustained "
                "bowed bass drone, slow detuned beating between two low tones, distant creaking and faint scraping, a "
                "thin high whistling harmonic that comes and goes. Constant uneasy tension, no resolution."},
    {"id": "drone_cosmique", "label": "Drone cosmique",
     "caption": "Global Metadata: Unsettling cosmic dark ambient drone, deep space. Free tempo, atonal, extremely low "
                "register. {drone} {extra}\n\nVocal Details: No vocals at all, fully instrumental.\n\nArrangement: an "
                "immense infrasonic rumble, slow metallic groans, distant radio static, long dissonant synth swells, "
                "deep reverberant emptiness. Constant dread, no resolution."},
    {"id": "drone_rituel", "label": "Drone rituel",
     "caption": "Global Metadata: Unsettling ritual dark ambient drone, ancient tomb atmosphere. Free tempo, atonal. "
                "{drone} {extra}\n\nVocal Details: No vocals at all, fully instrumental. Only a very distant low "
                "throat-singing drone buried in the mix.\n\nArrangement: long resonating bronze and gong overtones, "
                "bowed metal shimmering, slow ominous swells, a struck bell decaying forever. Constant dread."},
    {"id": "drone_organique", "label": "Drone organique",
     "caption": "Global Metadata: Unsettling organic horror drone, very low register. {drone} {extra}\n\nVocal Details: "
                "No vocals at all, fully instrumental. Only faint wet breathing textures.\n\nArrangement: sub-bass drone "
                "that throbs slowly like a heartbeat, dissonant low string clusters, wet squelching textures, faint "
                "insect-like clicking, an eerie high hiss. Constant creeping tension."},
    {"id": "ambiance_nature", "label": "Ambiance nature",
     "caption": "Global Metadata: Calm natural field-recording ambience, no music. {extra} Made to loop seamlessly.\n\n"
                "Vocal Details: No vocals at all.\n\nArrangement: soft wind in the leaves, distant birds, light insects, "
                "a gentle stream. No melody, no beat."},
    {"id": "ambiance_ville", "label": "Ambiance ville la nuit",
     "caption": "Global Metadata: Night city ambience, cinematic, no melody. {extra} Made to loop seamlessly.\n\n"
                "Vocal Details: No vocals at all.\n\nArrangement: distant traffic hum, far sirens, rain on the pavement, "
                "a low synth pad very far in the background."},
    {"id": "musique_trad", "label": "Musique traditionnelle",
     "caption": "Global Metadata: Traditional acoustic music, {extra}. Warm traditional recording, made to loop, no "
                "modern production.\n\nVocal Details: No vocals at all, fully instrumental.\n\nArrangement: traditional "
                "instruments only. No drum kit, no bass guitar, no synthesizer, no funk, no electronic sound, nothing modern.",
     "extra_hint": "Précise le style (ex. Hindustani classical, raga Yaman, tabla et sitar)."},
    {"id": "suspense", "label": "Suspense orchestral",
     "caption": "Global Metadata: Cinematic orchestral suspense underscore, slow, tense. {extra}\n\nVocal Details: No "
                "vocals at all, fully instrumental.\n\nArrangement: low tremolo strings, sparse piano notes, soft timpani "
                "rolls, rising swells without resolution."},
    {"id": "custom", "label": "Texte libre…", "caption": "{extra}",
     "extra_hint": "Décris la musique en anglais : style, instruments, ambiance. L'IA peut l'écrire pour toi."},
]
DRONE = ("Dark ambient drone, no melody, no beat, no drums, made to loop seamlessly: a slowly evolving texture "
         "with no clear beginning or end.")

# ------------------------------------------------------------------ deuxieme son : voix off (MiniMax Speech sur fal)
VOICES = [
    {"id": "Deep_Voice_Man", "label": "Homme, voix grave"},
    {"id": "Imposing_Manner", "label": "Homme, solennel"},
    {"id": "Elegant_Man", "label": "Homme, élégant"},
    {"id": "Patient_Man", "label": "Homme, posé"},
    {"id": "Casual_Guy", "label": "Homme, décontracté"},
    {"id": "Determined_Man", "label": "Homme, déterminé"},
    {"id": "Young_Knight", "label": "Jeune homme"},
    {"id": "Decent_Boy", "label": "Garçon"},
    {"id": "Wise_Woman", "label": "Femme, sage"},
    {"id": "Calm_Woman", "label": "Femme, calme"},
    {"id": "Abbess", "label": "Femme, mystérieuse"},
    {"id": "Inspirational_girl", "label": "Jeune femme, inspirée"},
    {"id": "Lively_Girl", "label": "Jeune femme, vive"},
    {"id": "Lovely_Girl", "label": "Jeune fille, douce"},
    {"id": "Exuberant_Girl", "label": "Jeune fille, exubérante"},
    {"id": "Friendly_Person", "label": "Voix neutre, amicale"},
]
EMOTIONS = ["neutral", "sad", "fearful", "surprised", "happy", "angry", "disgusted"]
LANGUAGES = ["French", "English", "Spanish", "Italian", "German", "Portuguese", "Japanese", "auto"]

# ------------------------------------------------------------------ bruitages (foley)
FOLEY = [
    {"id": "h3", "label": "H3 natif (local, synchronisé, gratuit)",
     "hint": "La piste son que H3 calcule avec la vidéo. Pour les vidéos rendues après le 13/10/2026."},
    {"id": "hunyuan", "label": "HunyuanVideo-Foley (cloud fal)",
     "hint": "Bruitages calculés à partir de la vidéo finie de la case. Payant (fal)."},
    {"id": "mmaudio", "label": "MMAudio (cloud fal)",
     "hint": "Bruitages calculés à partir de la vidéo finie, plus rapide. Payant (fal)."},
]
INSTRUMENTAL_LYRICS = "[Intro]\n\n[Instrumental]\n\n[Outro]"

LENGTH_ARC = 73       # 3 s par demi-arc
LENGTH_LONG = 124     # 5,2 s : orbite, plans animes


def _get(lst, pid):
    for x in lst:
        if x["id"] == pid:
            return x
    raise KeyError(pid)


def camera(cid):
    return _get(CAMERAS, cid)


def action(aid):
    return _get(ACTIONS, aid)


def compatible(cam_id, act_id):
    """(ok, message). Toute combinaison est permise ; on explique seulement ce qui va se passer."""
    cam = camera(cam_id)
    if cam["kind"] == "frozen" and act_id != "fige":
        msg = ("Avec une action, la case se joue toute seule : la caméra fait son mouvement pendant l'action "
               "(un seul plan, plus de pilotage au glisser).")
        if cam_id == "orbit360":
            msg += " Orbite + action : expérimental (LoRA 360 à 0,6)."
        return True, msg
    return True, ""


def _f(fields, key, default):
    v = (fields or {}).get(key) or ""
    return v.strip() or default


def _arc(subject, short, toward, ending, angle, rigid):
    body = (f"moves smoothly along an arc of about {angle} degrees around {subject} toward {toward}, always aimed at "
            f"{short} and keeping the same distance, ending on {ending}.")
    if rigid:
        return (f"{subject[0].upper() + subject[1:]} is a fixed object that never moves, turns or tilts. Only the camera "
                f"{body.replace('moves smoothly', 'travels smoothly')} Camera parallax is the only movement.{TAIL}")
    return f"The camera {body}{TAIL}"


# ------------------------------------------------------------------ relief (carte de profondeur, sans video)
# Chaque case choisit son traitement : « h3 » (video MiniMax H3, defaut) ou « relief » (photo en relief : une carte de
# profondeur calculee en ~1 s, le lecteur bouge la camera de quelques pour cent). Voir app/depth.py et docs/PARALLAXE-RELIEF.html.
RELIEF_PRESETS = [
    {"id": "respire", "label": "Respire", "hint": "petite avancée vers le sujet puis retour : portraits, couples, détails",
     "amount": 0.025, "duration": 2.0},
    {"id": "glisse", "label": "Glisse", "hint": "travelling latéral aller-retour : groupes, paysages, tables",
     "amount": 0.025, "duration": 2.4},
    {"id": "tourne", "label": "Tourne", "hint": "petit cercle de caméra autour du sujet : sujet central bien détaché",
     "amount": 0.02, "duration": 2.6},
    {"id": "vertigo", "label": "Vertigo", "hint": "le sujet garde sa taille, le fond s'éloigne : moments forts",
     "amount": 0.03, "duration": 2.2},
]
RELIEF_IDS = {r["id"] for r in RELIEF_PRESETS}
RELIEF_TRIGGERS = ("hover", "click")


def treatment(panel):
    return "relief" if (panel or {}).get("treatment") == "relief" else "h3"


def relief_cfg(panel):
    """Reglages du relief d'une case (completes par les valeurs du preset)."""
    r = (panel or {}).get("relief") or {}
    pre = next((x for x in RELIEF_PRESETS if x["id"] == r.get("preset")), RELIEF_PRESETS[0])
    out = {"preset": pre["id"], "amount": float(r.get("amount") or pre["amount"]),
           "duration": float(r.get("duration") or pre["duration"]),
           "trigger": r.get("trigger") if r.get("trigger") in RELIEF_TRIGGERS else "hover"}
    if r.get("focus") is not None:
        out["focus"] = float(r["focus"])
    return out


def plan_panel(panel, project_style=""):
    """Comme _plan_panel, plus les « precisions » libres de la camera et de l'action, ajoutees au prompt.
    Case en relief : aucune video (player « depth »), seulement une carte de profondeur."""
    if treatment(panel) == "relief":
        return {"player": "depth", "autoplay": False, "loop": False, "jobs": []}
    res = _plan_panel(panel, project_style)
    cam, act = panel.get("camera") or {}, panel.get("action") or {}
    extra = [(cam.get("extra") or "").strip()]
    if res["autoplay"]:
        extra.append((act.get("extra") or "").strip())
    extra = " ".join(e for e in extra if e)
    if extra:
        for j in res["jobs"]:
            base = j["prompt"]
            if base.endswith("No cuts."):        # les precisions avant la consigne finale
                j["prompt"] = (base[:-len("No cuts.")].strip() + " " + extra + " No cuts.").strip()
            else:
                j["prompt"] = (base + " " + extra).strip()
    # prompt reecrit depuis l'apercu (bouton « Regenerer » du mode edition) : remplace celui des menus
    over = (panel or {}).get("prompt_override") or {}
    for j in res["jobs"]:
        if (over.get(j["side"]) or "").strip():
            j["prompt"] = over[j["side"]].strip()
    return res


def _plan_panel(panel, project_style=""):
    """Decrit les rendus d'une case : [{side, engine, mode, prompt, lora, length, loop_keyframe}], type lecteur.

    panel : {"camera": {"id", "fields", "amplitude", "rigid"}, "action": {"id", "fields", "loop"}}
    Retour : {"player": "arc"|"loop"|"seul"|"static", "autoplay": bool, "loop": bool, "jobs": [...]} .
    Les prompts « frozen » ne contiennent PAS le preambule temps fige : le noeud H3 Orbital l'ajoute
    (et h3.full_prompt() l'ajoute pour fal).
    """
    cam = panel.get("camera") or {"id": "fixe"}
    act = panel.get("action") or {"id": "fige"}
    cf, af = cam.get("fields") or {}, act.get("fields") or {}
    cid, aid = cam.get("id", "fixe"), act.get("id", "fige")
    subject = _f(cf, "subject", _f(af, "subject", "the main subject"))
    short = subject
    angle = AMPLITUDES.get(cam.get("amplitude") or "moyen", 55)
    rigid = bool(cam.get("rigid"))
    lora = 0.5 if rigid else 0.0
    kind = camera(cid)["kind"]

    if kind == "frozen" and aid == "fige":
        if cid == "orbit360":
            extra = f"The camera orbits around {subject}." if cf.get("subject") else ""
            return {"player": "loop", "autoplay": False, "loop": True,
                    "jobs": [{"side": "V", "mode": "orbit", "prompt": extra, "lora": 1.0, "length": LENGTH_LONG,
                              "last_is_first": True}]}
        if cid == "arc":
            left = _f(cf, "left", "a three-quarter view of the subject seen from the left side of the frame")
            right = _f(cf, "right", "a three-quarter view of the subject seen from the right side of the frame")
            return {"player": "arc", "autoplay": False, "loop": False, "jobs": [
                {"side": "L", "mode": "path", "lora": lora, "length": LENGTH_ARC,
                 "prompt": _arc(subject, short, "the left of the frame", left, angle, rigid)},
                {"side": "R", "mode": "path", "lora": lora, "length": LENGTH_ARC,
                 "prompt": _arc(subject, short, "the right of the frame", right, angle, rigid)}]}
        if cid == "demi_arc":
            toward = _f(cf, "toward", "one side of the frame")
            ending = _f(cf, "ending", "a three-quarter view of the subject from that side")
            wide = AMPLITUDES.get(cam.get("amplitude") or "grand", 70)
            return {"player": "seul", "autoplay": False, "loop": False, "jobs": [
                {"side": "V", "mode": "path", "lora": lora, "length": LENGTH_ARC,
                 "prompt": _arc(subject, short, toward, ending, wide, rigid).replace("an arc of", "a wide arc of")}]}
        if cid == "vertical":
            up = (f"The camera moves smoothly along an arc of about {angle} degrees, rising above {subject}, always aimed "
                  f"at its center and keeping the same distance, ending on a high view looking down on it.{TAIL}")
            down = (f"The camera moves smoothly along an arc of about {angle} degrees, lowering toward the base of "
                    f"{subject}, always aimed at its center and keeping the same distance, ending on a low grazing view "
                    f"across it.{TAIL}")
            return {"player": "arc", "autoplay": False, "loop": False, "jobs": [
                {"side": "L", "mode": "path", "lora": 0.0, "length": LENGTH_ARC, "prompt": down},
                {"side": "R", "mode": "path", "lora": 0.0, "length": LENGTH_ARC, "prompt": up}]}
        if cid == "travelling":
            close = _f(cf, "close", f"a close-up of {subject} filling most of the frame")
            wide = _f(cf, "wide", f"a wider view revealing more of the surroundings of {subject}")
            fwd = (f"The camera physically travels forward, a dolly in and not a zoom, toward {subject}, keeping it "
                   f"centered, ending on {close}. Then the camera stops.")
            back = (f"The camera physically travels backward, a dolly out and not a zoom, away from {subject}, keeping "
                    f"it centered, ending on {wide}. Then the camera stops.")
            return {"player": "arc", "autoplay": False, "loop": False, "jobs": [
                {"side": "L", "mode": "path", "lora": 0.0, "length": LENGTH_ARC, "prompt": back},
                {"side": "R", "mode": "path", "lora": 0.0, "length": LENGTH_ARC, "prompt": fwd}]}

    # ---- plans animes : la scene bouge, lecture automatique (camera libre, ou mouvement + action)
    loop = bool(act.get("loop", True))          # « animation en boucle » : cochee par defaut
    asub = _f(af, "subject", subject)
    detail = _f(af, "detail", "")
    action_text = {
        "fige": "",
        # mesure du 14/10 : « stays in place / slow / tiny » donnait des videos quasi figees (indice 0,05 a 0,2)
        "vie": (f"{asub} come alive and keep moving naturally for the whole shot: visible breathing, blinking, small head "
                f"turns and glances, hands and fingers moving, shifting weight, hair and clothes reacting. Natural but "
                f"clearly visible, continuous motion, never frozen."),
        "nerveux": (f"There is constant, nervous movement of {detail or 'part of ' + asub}: crawling, wriggling and "
                    f"twitching in a fast rippling motion, never stopping and clearly visible for the whole shot, while "
                    f"the rest of {asub} stays in place."),
        "danse": (f"A playful rhythmic dance in place by {asub}{', ' + detail if detail else ''}, in sync and in rhythm "
                  f"for the whole shot."),
        "marche": f"{asub} walks forward naturally, with natural arm swing and weight shifts.",
        "parole": f"{asub} talks expressively, mouth moving, with small natural head and hand gestures.",
        "elements": (f"{detail or 'The wind, smoke, water and light'} in the scene keep moving gently and continuously "
                     f"for the whole shot, while the characters stay almost still."),
        "custom": _f(af, "text", ""),
    }[aid]
    if action_text:
        action_text = action_text[0].upper() + action_text[1:]
    # des « precisions » ecrites a la main valent consigne : elles suffisent a faire une video
    has_extra = bool((cam.get("extra") or "").strip() or (act.get("extra") or "").strip())
    cam_text = {
        "fixe": "" if (cid == "fixe" and has_extra and not action_text) else "Static camera, locked off, no camera movement.",
        "grue": (f"Cinematic crane shot. The camera rises smoothly upward from eye level to a high angle looking down "
                 f"on {subject}."),
        "avancee": f"The camera slowly and physically travels forward toward {subject}, a dolly in and not a zoom.",
        "epaule": ("Handheld camera held by an operator: it gently sways and drifts with a noticeable, organic shake "
                   "for the whole shot; no orbit, no pan, no zoom."),
        "custom": _f(cf, "text", ""),
        # mouvements « pilotes au glisser » joues en un seul plan avec une action
        "orbit360": f"The camera orbits smoothly all the way around {subject} in a continuous circle, always aimed at the subject.",
        "arc": (f"The camera moves smoothly along an arc of about {angle} degrees around {subject}, always aimed at the subject, "
                f"revealing {_f(cf, 'right', _f(cf, 'left', 'its side'))}."),
        "demi_arc": (f"The camera moves smoothly along a wide arc around {subject} toward "
                     f"{_f(cf, 'toward', 'one side of the frame')}, always aimed at the subject, revealing "
                     f"{_f(cf, 'ending', 'a three-quarter view of it')}."),
        "vertical": f"The camera slowly rises above {subject}, always aimed at the subject, ending on a high view looking down on it.",
        "travelling": (f"The camera physically travels forward toward {subject}, a dolly in and not a zoom, ending on "
                       f"{_f(cf, 'close', 'a closer view of it')}."),
    }.get(cid, "")
    mlora = 0.6 if cid == "orbit360" else (0.5 if rigid and kind == "frozen" else 0.0)
    if cid == "fixe" and not action_text and not has_extra:
        return {"player": "static", "autoplay": False, "loop": False, "jobs": []}
    text = " ".join(t for t in (cam_text, action_text, project_style.strip(), "No cuts.") if t)
    return {"player": "seul", "autoplay": True, "loop": loop, "jobs": [
        {"side": "V", "mode": "animated", "lora": mlora, "length": LENGTH_LONG, "prompt": text, "last_is_first": loop}]}


def audio_caption(preset_id, extra=""):
    a = _get(AUDIO, preset_id)
    return a["caption"].replace("{drone}", DRONE).replace("{extra}", (extra or "").strip()).replace("  ", " ").strip()


FIELDS = {
    "subject": ("Sujet", "the golden mask / the three men in red suits"),
    "left": ("Arrivée côté gauche", "a three-quarter view of his face, the glasses in front"),
    "right": ("Arrivée côté droit", "a three-quarter view from the side of his large ear"),
    "toward": ("Vers", "its front end with the glowing mandala"),
    "ending": ("Vue d'arrivée", "a three-quarter front view where the mandala faces the camera"),
    "close": ("Plan serré (avance)", "a close-up of the skull's face filling the frame"),
    "wide": ("Plan large (recul)", "a wider view revealing the whole room"),
    "detail": ("Détail", "his ten long wrinkled fingers on the skull"),
    "text": ("Texte", "Describe it in English…"),
}


def public():
    """Ce que l'interface recoit."""
    return {"cameras": CAMERAS, "actions": ACTIONS, "audio": [{k: v for k, v in a.items() if k != "caption"} for a in AUDIO],
            "amplitudes": AMPLITUDES, "fields": {k: {"label": a, "placeholder": b} for k, (a, b) in FIELDS.items()},
            "voices": VOICES, "emotions": EMOTIONS, "languages": LANGUAGES, "foley": FOLEY,
            "shakes": list(SHAKES), "shake_default": SHAKE_DEFAULT, "relief": RELIEF_PRESETS}
