# Feuille de route — « Lytro » : photos vivantes en temps arrêté

À l'attention de la session Claude Code dans le cloud (dépôt grosdada/Alive-Comics). Rédigée le 16/10/2026 par la
session locale, qui a fait le premier prototype. Lis ce document en entier avant de coder.

## 1. Le but, dit par David

Émuler la Lytro (appareil plénoptique, « living pictures ») sur nos images :

- **Quand on bouge la souris, l'image oscille légèrement en vraie perspective 3D.** Peu de relief suffit. Ce qu'il faut,
  c'est de vraies vues sous des angles voisins, jamais une photo déformée.
- **Un clic n'importe où refait la mise au point** à cette profondeur, en glissant doucement du premier plan au fond.
- **Le temps est ARRÊTÉ.** L'image ne doit jamais être animée : personne ne bouge, ne cligne, ne respire, rien ne flotte.
  Seule la caméra change de point de vue, comme si plusieurs petites caméras filmaient une scène figée. C'est la règle
  numéro 1 ; une vue où quelque chose bouge est une vue ratée.

Ce qui a été refusé avant (à ne pas refaire) : déformer la photo avec une carte de profondeur (étirements), découper les
personnages en cartes (halos, contours qui bougent, fantômes). Tout ce qui « étire » ou « dédouble » est refusé.

## 2. Ce qui existe déjà (dans ce dépôt)

| Fichier | Rôle |
|---|---|
| `player/lytro.html` | Lecteur prototype (WebGL1). `?p=<projet>[,<projet>]` charge `/projects/<p>/lytro/<case>/`. |
| `tools/lytro_build.py` | Deux rendus vidéo (demi-arc gauche, demi-arc droit, partant de la photo) → pile de vues. |
| `tools/lytro_redepth.py` | Profondeur de chaque vue avec Depth Pro. |
| `app/presets.py` | Amplitude « lytro » de la caméra « arc » (prompt H3 « about 16 degrees »). |

### Format d'une pile (contrat entre générateur et lecteur)

Dossier `<case>/` :
- `v00.jpg … vNN.jpg` : vues de gauche à droite (ou de bas en haut si `axis` = `y`), 1024 px de large ; la photo
  d'origine est la vue `center`.
- `d00.png … dNN.png` : disparité 8 bits (255 = proche), demi-résolution, une par vue.
- `meta.json` : `n`, `center`, `w`, `h`, `axis` (`x`/`y`), `s` (parallaxe mesurée de chaque vue, en px à la largeur `w`,
  croissante ; c'est elle que la souris pilote), `pin` (recalage appliqué pour garder le sujet fixe), `crop`, `sides`
  (`deux` ou `un`), `depth` (modèle de profondeur).

### Comment le prototype appelle les vues
- Position de la souris dans la case → parallaxe voulue `±relief` (1 % de la largeur par défaut, comme la vraie Lytro)
  → vue fractionnaire par interpolation dans `meta.s` → fondu entre les 2 vues voisines (écart ≤ ~1,5 px entre voisines,
  au-delà le fondu montre des doubles contours).
- Ressort amorti, zone morte au centre (= la photo exacte), retour au centre à la sortie, on se pose sur une vue pure
  après 150 ms d'immobilité, petit balancement d'accueil.
- Clic = mise au point : disparité lue (médiane 5×5) dans la vue courante, flou de profondeur en une passe (« scatter as
  gather », Gustafsson 2018), montée 0,5 s. Double-clic = tout net. Au repos : la photo nette.

### Ce que les tests ont montré
- Bon : vraie parallaxe, aucun étirement, mise au point très convaincante avec Depth Pro.
- Mauvais : le modèle vidéo (MiniMax H3) n'arrête PAS vraiment le temps (bouches, gestes, grain qui « bout » toutes les
  4 images), la 1re image diffère de la photo, parfois un seul côté tourne. Seulement l'axe horizontal.
- Licence H3 : exclut l'Union européenne, affichage des sorties compris. Il faut une autre source de vues pour publier.

## 3. Données de test

Le dossier `lytro-testdata/` (voir son `LISEZMOI.md`) contient 5 images carrées (1:1) tirées des livres « 1987 » de
l'app, avec pour chacune les rendus bruts de points de vue (temps arrêté) et la pile de vues déjà construite au format
ci-dessus. Les gros fichiers bruts peuvent être absents du dépôt : dans ce cas utilise les piles construites.

## 4. Étapes (une par session ou par PR ; chaque étape se termine par une démo et des chiffres)

### Étape 1 — Lecteur autonome « lytro-viewer » (priorité)
Un dossier `lytro-viewer/` indépendant de l'app : `index.html` + JS sans dépendance, qui lit une ou plusieurs piles
(chemin relatif ou glisser-déposer d'un dossier / d'un zip).
- WebGL2 avec repli WebGL1 ; `TEXTURE_2D_ARRAY` pour les vues ; chargement progressif (la photo d'abord).
- Souris, tactile (`touch-action: pan-y`, glisser = perspective, toucher = mise au point), gyroscope en option.
- Axe x, axe y, et grille 2D si la pile en fournit une (`meta.grid = [colonnes, lignes]`, fondu bilinéaire des 4 vues).
- Mise au point de meilleure qualité : séparation avant / arrière par tuiles (min/max de disparité par 16 px), bande
  nette réglable, pas de bavure de l'arrière-plan sur un sujet net, accumulation de 4 images au repos.
- Réglages exposés : relief (%), force du flou, durée du glissé de mise au point.
- Mesures à fournir : images par seconde sur ordinateur et sur téléphone moyen, mémoire GPU par case.
- Critère d'acceptation : sur les 5 images de test, aucun double contour visible au repos ni en mouvement lent, aucun
  saut à la sortie de la zone morte.

### Étape 2 — Contrôle qualité automatique des piles (« temps arrêté »)
Un script `tools/lytro_check.py` qui note chaque pile et refuse les vues qui bougent :
- flot optique entre vues voisines → résidu après la parallaxe attendue (un modèle « plan + profondeur ») ; un visage,
  une main ou un tissu qui bouge plus que le seuil = vue rejetée, la pile est coupée avant ;
- « bouillonnement » de texture (écart haute fréquence périodique) ; saut de couleur ou de netteté avec la photo ;
- sortie : un rapport HTML par pile (vues extrêmes, carte du résidu, note) et un `meta.json` enrichi (`qc`).

### Étape 3 — Générateurs de vues sans animation (recherche + banc d'essai)
Comparer, sur les 5 images de test, des sources de vues qui respectent le temps arrêté par construction :
- reconstruction 3D d'une seule photo (gaussiennes 3D, ex. Apple SHARP — licence non commerciale ; NVIDIA Lyra-1 /
  GEN3C — licence commerciale permise, sans exclusion UE ; ViewCrafter — Apache 2.0 ; MoGe-2 + remplissage) puis rendu
  d'une grille exacte de caméras (2D, par ex. 9×5 dans ±1,5°) ;
- comparer à la pile H3 : cohérence (aucun mouvement), netteté, trous / flottants, temps de calcul, VRAM (cible : une
  RTX 5090 de 32 Go), licence (usage commercial ? UE ?).
- Livrable : un rapport chiffré et une recommandation. Le code doit produire des piles au format de la section 2
  (ajouter `grid` pour la 2D).

### Étape 4 — Le générateur retenu, en outil
`tools/lytro_generate.py <image> <sortie>` : image → pile complète (vues, profondeurs, `meta.json`, contrôle qualité
de l'étape 2). Pensé pour tourner sur un PC Windows avec GPU (les rendus se font chez David, pas dans le cloud).

### Étape 5 — Intégration dans l'app principale (ne la fais qu'après validation de David)
Nouveau traitement de case « lytro » à côté de « h3 » et « relief » : tâche dans la file de rendus, export des piles
avec les pages, le lecteur des planches (`player/alive-player.js`) reprend le lecteur de l'étape 1 pour ces cases.

## 5. Règles de travail

- **Besoin d'un rendu ou de nouvelles données ?** Écris ta demande dans `lytro-testdata/DEMANDES.md` (format dans
  le fichier), pousse, et préviens David. La session locale fait les rendus et répond dans le même fichier.

- Écris en français dans les docs et l'interface ; code et commentaires dans le style du dépôt (français, sans accents
  dans le code Python).
- Ne versionne jamais `local_settings.json`, `projects/`, `data/` (déjà dans `.gitignore`).
- Une branche et une PR par étape ; commits clairs ; pas de dépendance lourde côté lecteur.
- Pas de rendu payant (fal…) sans accord. Pas d'avis juridique : signale les licences, c'est tout.
- Chaque étape se termine par une démo visible (page HTML) et des chiffres, pas par « ça devrait marcher ».
