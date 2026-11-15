# Pour Codex : intégrer Alive-Comics dans Placenta Studio

David (grosdada) veut **Alive-Comics à l'intérieur de Placenta Studio** (son application, le wrapper de Dia).
Ce dépôt contient uniquement le code de l'application (pas de projets, pas de rendus, pas de réglages ni de clés :
`projects/`, `data/`, `local_settings.json` sont ignorés). C'est la **dernière version** (novembre 2026).

Je ne connais pas l'architecture de Placenta Studio : ce qui suit décrit Alive-Comics et propose un plan, à toi de
l'adapter à la structure de Placenta Studio.

## Ce qu'est Alive-Comics
Un outil pour fabriquer des **planches de BD animées**. Une planche = un découpage en cases ; chaque case est une boucle vidéo
(MiniMax H3 via ComfyUI), une photo en relief (WebGL) ou une image fixe, avec bulles, sons, filtres. Le résultat est une page
HTML autonome (ou un livre de plusieurs pages) qui se réveille au survol de la souris.

- Serveur : Python, bibliothèque standard + `requirements.txt` (pillow, numpy, onnxruntime, opencv). `ffmpeg` dans le PATH.
  Lancement : `python -m app --no-browser` (port 8790) ; `run.py` / `Lancer_Alive_Comics.bat`.
- Interface : `app/web/` (JavaScript sans compilation, modules ES). Lecteur : `player/` (JS vanilla, aucun build).
- Données : un dossier par planche dans `projects/<id>/` (`project.json`, images, rendus, `export/`). Livres : `data/books.json`.
- Rendus vidéo : ComfyUI (workers dans les réglages) ; fal.ai en option (payant, désactivé par défaut).
- Documentation complète à lire d'abord : **`docs/ALIVE-COMICS-DOC.html`** (architecture, modèle de données, API, leçons).
  Consignes de travail et règles : `CLAUDE.md`. Pilotage par API : `docs/PILOTAGE-CLAUDE.html`.

## Ce qui est à garder : produire des HTML qui marchent
La chaîne « planche → HTML jouable » est dans **`app/assemble.py`** (`build`, `build_book`) :
- `POST /api/projects/<id>/export` assemble la planche dans `projects/<id>/export/` : `index.html` + `alive-player.js/.css`,
  `alive-bubbles.js`, `page.jpg`, `frames.png`, `manga_data.js`, `book.js`, vidéos, sons, images. Ouvrable tel quel
  (`file://` ou n'importe quel serveur statique avec requêtes `Range` pour les vidéos).
- `POST /api/books/<id>/export` fait pareil pour un livre (plusieurs planches, tourner les pages).
- Le dossier produit est **autonome** : c'est lui que Placenta Studio doit pouvoir copier, afficher dans un iframe, ou zipper.

## Ce qui peut être retiré (publication en ligne)
Aucune de ces pièces n'est nécessaire pour fabriquer les HTML :
- `app/publish.py` (envoi SFTP/SSH vers Hostinger) et `tools/deploy.py`.
- Routes `publish` dans `app/server.py` (`/api/publish/*`, `/api/projects/<id>/publish`, `/api/books/<id>/publish`).
- Réglages `deploy` dans `app/settings.py`, onglet de publication des réglages, clé SSH.
- Interface : `publishDialog()`, `publishedDialog()`, boutons « Publier » dans `app/web/js/main.js`, bouton `#pub` dans
  `player/book.html`.
- Les planches gardent un champ `published` : à ignorer.
Retire-les proprement (ou masque-les derrière un réglage) plutôt que de laisser des boutons qui échouent.

## Dernières fonctions (toutes présentes dans ce dépôt)
- **Animate framing** (cadrage animé) : le découpage de la page s'anime par images clés (traits, gouttière, marge, couleurs) ;
  timeline dans l'éditeur, horloge de page dans le lecteur. **Règle d'or** : le calcul existe en trois copies identiques
  (`app/web/js/geometry.js`, `player/alive-player.js`, `app/geometry.py`) : n'en modifier aucune sans les deux autres.
  Non fait : vidéos calées sur la tête de lecture dans l'éditeur ; cases en relief d'une page animée = image fixe.
- **Bulles de BD** (`player/alive-bubbles.js`, `app/web/js/bubbles.js`) : 5 types, queue avec pointe et base réglables, mots
  jamais coupés, taille libre, double-clic = panneau « Forme » (marge, pointes, main levée, trait…), Suppr, presets
  personnels (`data/bubble_presets.json`), apparition (toujours / survol / à t secondes), animations.
- Cases en relief (carte de profondeur, couches), filtres de case, sons (voix off, ambiance, bruitages, musique de page à
  volume constant), dossiers de planches, livres, fenêtres déplaçables par leur en-tête, annuler / refaire corrigés.

## Plan d'intégration proposé
1. Lire `docs/ALIVE-COMICS-DOC.html` (sections 3, 4, 10, 11 bis, 14), lancer l'appli seule (`python -m app`) et faire une planche.
2. Choisir le mode d'intégration selon Placenta Studio : (a) **processus compagnon** lancé par Placenta Studio, interface
   ouverte dans un volet / iframe (le plus simple et le moins risqué) ; ou (b) code monté dans l'application hôte
   (préfixe de routes, dossier de données à fournir par l'hôte). Dans les deux cas, rendre configurables : le port, le
   dossier de données (`ROOT` dans `app/server.py` et `app/store.py`), et l'adresse du ComfyUI.
3. Retirer la publication (section ci-dessus), garder l'export HTML.
4. Brancher les entrées de Placenta Studio utiles (images de Dia comme images de cases, par exemple) sur
   `POST /api/projects/<id>/upload?kind=image&name=…` et sur la création de planche (`POST /api/projects`).
5. Vérifier : une planche sans animation s'exporte et se lit comme avant ; une planche animée se rejoue ; les bulles suivent.

## Règles à respecter
- Tout en français (interface, messages).
- Cases à pastille verte (`review: "ok"`) : validées par David, ne jamais les modifier ni les re-rendre.
- Le tremblé est appliqué par le lecteur, jamais incrusté dans la vidéo.
- Licences : modèles de profondeur à licence distribuable uniquement (voir `CLAUDE.md`) ; la licence MiniMax H3 exclut l'UE
  (affichage des vidéos compris) : à signaler à David, à lui de trancher.
- Tester sur des copies de planches (`projects/zz-…`), jamais sur les vraies.
