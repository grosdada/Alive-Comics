# Alive-Comics

Créer des planches de BD animées : chaque case devient une courte vidéo (MiniMax H3 sur ComfyUI ou sur fal),
pilotée par le lecteur (glisser = bouger la caméra, lecture automatique, boucles, son au survol), puis publiée
en HTML (page seule ou livre à feuilleter) sur un hébergement web.

## Lancer

```
Lancer_Alive_Comics.bat        (ou : python run.py)
```

L'interface s'ouvre sur http://127.0.0.1:8790/. Il faut Python 3.10+ et ffmpeg dans le PATH. Aucune bibliothèque
à installer.

## Mode d'emploi (mode manuel)

1. **Nouvelle planche** : un nom, un format (page BD, manga, 4:5, carré, écran), le sens (vertical / horizontal)
   et un découpage de départ.
2. **Cadres** : glisse un trait pour le déplacer (les deux cases voisines suivent), glisse un de ses bouts pour
   l'incliner (Maj : trait droit). Colonne de gauche : autres découpages, variante au hasard, « Pivoter le
   découpage » (les bandes deviennent des colonnes), couper ou supprimer la case sélectionnée. Colonne de droite (rien de sélectionné) : couleur du fond autour des cases, traits,
   gouttière, marge, ambiance commune. Ctrl+Z / Ctrl+Y.
3. **Images** : glisse une image sur une case (ou clique dedans). Molette pour zoomer, glisser pour recadrer.
4. **Dans chaque case**, quatre icônes :
   - **Image** : importer ou remplacer.
   - **Caméra** : orbite 360° en boucle, arc gauche ↔ droite, demi-arc, plongée ↕ contre-plongée,
     travelling avant ↔ arrière (la case se pilote au glisser, scène figée), ou caméra fixe, grue, lente avancée,
     épaule, texte libre (la scène bouge, lecture automatique).
   - **Action** : temps figé, vie subtile, mouvement nerveux, danse, marche, parole, éléments, texte libre.
     « Animation en boucle » (cochée par défaut) : la fin rejoint le début. Une action fonctionne aussi avec un
     mouvement de caméra (arc, orbite, travelling…) : la case joue alors le mouvement pendant l'action.
   - **Sons**, trois couches :
     1. ambiance / musique en boucle (fichier ou MiniMax Music 3, local) ;
     2. voix off ou second son : fichier, voix off IA (MiniMax Speech sur fal, texte proposé par l'IA) ou
        deuxième musique ; jouée depuis le début à chaque survol, ou en boucle ;
     3. bruitages (foley) : « H3 natif » (la piste son calculée avec la vidéo, locale et synchronisée) ou
        HunyuanVideo-Foley / MMAudio sur fal (calculés sur la vidéo finie).
     Un volume par couche.
   « ✨ Écrire les textes avec l'IA » regarde l'image et remplit les champs de la case ; son explication reste
   affichée sous le bouton. Chaque caméra et action a aussi des « Précisions » libres.
5. **Générer les cases** : choisir les cases, puis où calculer : tes machines ComfyUI, le cloud fal, ou mixte
   (fal prend ce que tes machines n'ont pas pris après 2 min). Les rendus se répartissent seuls ; une machine
   occupée garde la tâche dans sa file. Suivi dans « Rendus » en bas.
6. **Variantes** : chaque case garde tous ses rendus. « Autre variante » relance avec une autre graine,
   « Utiliser » choisit la vidéo de la page.
7. **Aperçu** : assemble la page jouable et l'ouvre. **Publier** : la met en ligne (lien à partager).
8. **Livres** (page d'accueil) : enchaîner plusieurs planches, aperçu, publication.

## Réglages (⚙)

- **Machines** : les ComfyUI du réseau (ComfyUI ≥ 0.33, MiniMax H3, nœud `comfyui-h3-orbital`, LoRA 360 Orbit ;
  MiniMax Music 3 pour le son). Pastille verte = prête, bleue = occupée, orange = il manque quelque chose.
- **Intelligence** : clés Anthropic (par défaut), OpenAI, Google, DeepSeek ; le modèle se choisit dans une liste
  lue chez le fournisseur (↻ pour la recharger).
- **fal** : clé, rendus simultanés, résolution, prix estimé.
- **Publication** : hôte SSH, utilisateur, dossier du site. « Créer / afficher la clé de ce poste » donne la ligne
  à coller dans hPanel › Avancé › Accès SSH (une clé par poste).

Tous ces réglages restent dans `local_settings.json` (jamais dans le dépôt).

## Dossiers

- `app/` : serveur (`server.py`, `jobs.py` file de rendus, `comfy.py`, `falapi.py`, `assemble.py`,
  `publish.py`, `llm.py`, `presets.py` vocabulaire caméra/action/son) et interface (`app/web/`).
- `player/` : le lecteur (page et livre), utilisé pour l'aperçu et l'export.
- `projects/<id>/` : une planche (project.json, images, rendus, export). Pas dans le dépôt.
- `tools/` : `build_book.py`, `build_shelf.py`, `deploy.py`, `serve_range.py` (en ligne de commande).
- `ALIVE-COMICS-CONNAISSANCES.html` : tout ce qui a été appris avec H3-Orbital (à lire avant de toucher aux prompts).
