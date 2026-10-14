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
4 bis. **Réalisateur IA** (fenêtre « 🎬 Réalisateur IA » en bas à droite) : pose tes images, écris une instruction
   globale (ambiance, histoire, style de caméra, sons…), et l'IA regarde toute la page pour régler le reste de chaque
   case : caméra, action, textes, ambiance sonore, voix off qui raconte (option, fal), bruitages, son global et
   ambiance commune. Les images ne sont pas touchées ; tout reste modifiable ensuite. Option « Lancer les rendus
   ensuite » pour enchaîner sur tes machines.
5. **Générer les cases** : choisir les cases, puis où calculer : tes machines ComfyUI, le cloud fal, ou mixte
   (fal prend ce que tes machines n'ont pas pris après 2 min). Les rendus se répartissent seuls ; une machine
   occupée garde la tâche dans sa file. Suivi dans « Rendus » en bas.
6. **Variantes** : chaque case garde tous ses rendus. « Autre variante » relance avec une autre graine,
   « Utiliser » choisit la vidéo de la page.
7. **Son global de la page** (réglages de la page, rien de sélectionné) : un son qui joue en continu, quelle que soit
   la case survolée (fichier ou MiniMax Music). Il baisse quand une case joue ses sons ; les navigateurs le lancent
   au premier clic dans la page.
8. **Aperçu** : assemble la page jouable et l'ouvre. Si rien n'a changé depuis le dernier assemblage, la page déjà
   prête s'ouvre immédiatement ; sinon seul ce qui a changé est refait. **📁 Dossier** ouvre le dossier de la page
   (index.html, vidéos, sons). **Publier** : la met en ligne (lien à partager).
8 bis. **✏️ Éditer** (dans l'aperçu d'une page ou d'un livre, seulement depuis l'application) : clic sur une case,
   un popup de retouche s'ouvre avec la case en grand. Tout se voit en direct et s'enregistre tout seul, sans
   recalculer la vidéo :
   - **Boucle** : timeline avec la courbe de mouvement (rouge = temps mort), poignées de début et de fin,
     « ✂ Couper les temps morts », fondu au raccord, image de départ, sens (boucle / aller-retour), vitesse ;
   - **Tremblé** : taille, fréquence, rotation, graine (« ⏸ Figer l'image » : le tremblé continue sur l'image fixe) ;
   - **Couleur** (saturation, luminosité, contraste, température, teinte ; « Appliquer à toute la page ») et **Cadrage** ;
   - **Son** : volume de chaque couche, régénérer avec une consigne, **ajouter un son** par-dessus, volume (ou
     import) de la musique de la page ;
   - **Régénérer** : consigne en français (l'IA réécrit le prompt H3), « même graine » pour ne changer qu'un détail,
     versions déjà calculées.
   Le tremblé caméra est appliqué par le lecteur (plus incrusté dans la vidéo). Pour mettre les retouches en ligne :
   republier la page ou le livre.
9. **Livres** (page d'accueil) : enchaîner plusieurs planches, aperçu, publication.

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
- `docs/PILOTAGE-CLAUDE.html` : piloter l'application par API (pour une instance de Claude qui construit une planche
  à partir d'un thème, sans l'IA intégrée). Regénéré par `python tools/make_pilot_doc.py`.
