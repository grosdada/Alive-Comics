# Alive-Comics : consignes pour Claude Code

Application locale de David (grosdada) pour fabriquer des **planches de BD animées** : chaque case est une boucle vidéo
MiniMax H3 ou une photo en relief, que le lecteur réveille au survol ; page ou livre publiés par lien.
Documentation complète, à lire en premier : `docs/ALIVE-COMICS-DOC.html`. Concept : `docs/ALIVE-COMICS-TOPO.html`.
Pilotage par API (une autre instance de Claude fabrique les livres) : `docs/PILOTAGE-CLAUDE.html`, généré par
`tools/make_pilot_doc.py` : le régénérer après tout changement de routes, de presets ou de clés.

## Façon de travailler avec David
- Tout en français (interface, messages, docs). David autorise tout : avancer sans bloquer sur des questions.
- **Commit + push après chaque étape** (`origin main`). Ne jamais versionner `local_settings.json`, `projects/`, `data/`.
- Toujours vérifier une modification d'interface dans le navigateur (une accolade manquante a déjà cassé l'appli).
- Tester sur l'instance de développement (`python tools/dev_instance.py`, port 8791, file de tâches séparée) et sur une
  **copie** de planche (`projects/zz-…`, supprimée ensuite par `DELETE /api/projects/<id>`, qui la met à la corbeille).
- Le serveur principal (port 8790) se relance sans risque pendant des rendus : les tâches en cours reprennent.
  Le lancer détaché (`Lancer_Alive_Comics.bat`, ou `Start-Process cmd.exe '/c python -m app --no-browser'`).
- Publication en ligne (alive-comics.placenta.tv) seulement quand David le demande. fal est payant : local par défaut.

## Règles qui ne se discutent pas
- Cases à pastille **verte** (`review: "ok"`) : validées par David, ne jamais les modifier ni les re-rendre.
  Ne jamais passer une case en vert soi-même. Les rouges (`"redo"`) se reprennent en premier.
- Le **tremblé** est appliqué par le lecteur (fx.shake), jamais incrusté dans la vidéo, jamais écrit dans un prompt.
- Boucles H3 : suivre la compétence `app/skills/boucles.md` (aussi en skill Claude : `.claude/skills/boucle-parfaite`).
  Pas d'aller-retour, pas de mots mous (slowly, small…), pas de négation, un idle vivant sur chaque personnage.
- Cartes de profondeur : uniquement des modèles à licence distribuable (Depth Anything V2 **Small**, Apache 2.0).
  Les tailles Base / Large / Giant sont CC-BY-NC : interdites.
- Relief en couches (`app/layers.py`, v2) : détourage **SAM 3.1** (SAM License de Meta) + **BiRefNet** (MIT), décor caché
  **Qwen-Image-Edit 2509** (Apache 2.0), repli **LaMa** (Apache 2.0), profondeur **Depth Pro** (licence de recherche Apple).
  Choix de David le 15/10/2026 : la précision d'abord, les licences plus tard ; Depth Pro et SAM sont à revoir avant
  tout usage commercial (piste : MoGe-3, MIT, quand ComfyUI sera en 0.37+). Toujours jamais FLUX dev, RMBG,
  ObjectClear, MatAnyone, MiniMax-Remover (non commerciaux), ni Lyra-2 / SHARP (recherche) dans l'app.
- Licence MiniMax H3 : elle exclut l'UE, le Royaume-Uni, les USA et la Corée, y compris l'affichage des vidéos produites
  (§ V.4). David publie depuis la France : ne pas présenter H3 comme « sans risque » ; c'est à lui de trancher.
- Sons importés : jamais deux fois le même fichier (app/sounds.py) ; un son déjà utilisé déclenche une alerte.

## Repères techniques
- Serveur Python, bibliothèque standard + `requirements.txt` (pillow, numpy, onnxruntime, opencv-contrib) ; ffmpeg dans le PATH.
- Interface sans compilation : `app/web` (application), `player/` (lecteur, livre, mode édition `alive-edit.js`).
- Rendus : ComfyUI sur HITCHCOCK, CASSAVETES, FORD (réglages dans `local_settings.json`) + fal.
- Écrire les gros correctifs dans un script Python (fichier) plutôt qu'en heredoc bash : les `\n` y sont mangés.
