# lytro-viewer : lecteur autonome de photos vivantes « temps arrêté »

Étape 1 de `docs/ROADMAP-LYTRO-CLOUD.md`. Un dossier indépendant de l'application : `index.html` + `lytro-viewer.js`
+ `zip.js`, sans dépendance ni compilation.

## Ouvrir

- **Démo** : servir la racine du dépôt (`python -m http.server 8799`), puis ouvrir `http://localhost:8799/lytro-viewer/`.
  Les 5 piles de `lytro-testdata/` et deux piles synthétiques (`demo/`) s'affichent (liste dans `demo.json`).
- **Autres piles** : `index.html?piles=chemin1,chemin2` (chemins relatifs à la page), ou **glisser-déposer** un dossier
  (une ou plusieurs piles, sous-dossiers compris) ou un **zip** n'importe où dans la page. Boutons « Ouvrir un
  dossier… » / « Ouvrir un zip… » sinon. Toute pile = un dossier qui contient `meta.json`.
- Paramètres d'adresse utiles : `webgl1=1` (forcer le repli WebGL1), `relief=1.5`, `minGap=2.5`, `blur=0.7`,
  `hint=0` (sans balancement d'accueil).

## Gestes

| Geste | Effet |
|---|---|
| Souris sur la case | la caméra suit (vraies vues voisines) ; zone morte au centre = la photo exacte |
| Souris immobile 150 ms | on se pose sur la vue réelle la plus proche (réglable) |
| Clic | mise au point à cette profondeur, glissé du plan actuel vers le nouveau |
| Double-clic | tout net (comme au repos) |
| Téléphone : glisser | perspective (`touch-action: pan-y` : le défilement vertical reste au navigateur ; `none` pour une pile verticale ou en grille) |
| Téléphone : toucher | mise au point |
| Gyroscope (option) | l'inclinaison pilote la perspective (±15° = toute la course ; iOS demande l'autorisation) |

Réglages exposés : relief (% de la largeur), force du flou, bande nette, durée du glissé de mise au point, pas des vues
(mémoire), fondu guidé, se poser sur une vue, net partout, voir la profondeur, oscillation au repos, gyroscope.

## Comment ça marche

1. **Treillis de vues.** Axe x (une ligne), axe y (une colonne) ou grille 2D (`meta.grid`). Les vues en double
   (même `s`, images identiques : 1 à 21 par pile du jeu de test) sont écartées. Seules les vues utiles au relief
   courant sont chargées, en gardant un écart d'au moins `minGap` px entre voisines (1,5 px ; 2,5 px sur téléphone),
   la photo d'abord puis du centre vers les bouts. La course de la souris s'arrête aux vues déjà chargées.
2. **Synthèse de la vue demandée** (WebGL2 : `TEXTURE_2D_ARRAY` couleur RGBA8 + disparité R8 ; WebGL1 : une
   texture par vue). Fondu des 2 vues voisines (4 pour une grille, poids bilinéaires). Chaque vue est **recalée
   vers la position voulue selon sa profondeur** : décalage = écart de parallaxe × (k·g + c), avec g = 0 sur le sujet
   (épinglé par `lytro_build.py`) et 1 sur le fond. Le recalage ne dépasse jamais la moitié de l'écart entre deux vues
   réelles (≤ 3 px sur le jeu de test) : rien n'est étiré, mais le fondu ne dédouble plus les contours. k et c sont
   mesurés au chargement (flot global de Lucas-Kanade sur des paires de vues voisines, ~0,3 à 3 s en tâche de fond) ;
   `meta.warp = {kx, cx, ky, cy}` les impose. La case « Fondu guidé » revient au fondu simple.
3. **Mise au point** : flou de profondeur « scatter as gather » en disque de Vogel, borné par des tuiles de 16 px
   (min / max de disparité de chaque vue, calculés au chargement) : rayon adapté, aucun calcul hors des zones floues.
   Un échantillon plus loin que le pixel ne s'étale pas plus que le pixel lui-même : l'arrière-plan ne bave pas sur un
   sujet net ; un premier plan flou déborde sur ce qui est derrière. Bande nette réglable. Au repos, 4 images
   accumulées (disque tourné) : flou sans grain d'échantillonnage. Moitié moins d'échantillons pendant un mouvement.
4. Copie à l'écran. Rendu seulement quand quelque chose change.

## Format de pile (rappel, contrat avec le générateur)

`v00.jpg … vNN.jpg`, `d00.png … dNN.png` (disparité 8 bits, 255 = proche, demi-résolution), `meta.json` :
`n`, `center`, `w`, `h`, `axis` (`x`/`y`), `s` (parallaxe de chaque vue, px à la largeur `w`, croissante).
Ajouts lus par ce lecteur, tous facultatifs :

- `grid: [colonnes, lignes]` : grille 2D ; index d'une vue = ligne × colonnes + colonne, colonnes de gauche à
  droite, lignes **de bas en haut** (même sens que l'axe y : s croissante = caméra qui monte). `sx` (une valeur par
  colonne) et `sy` (une par ligne) donnent les parallaxes ; à défaut 1,5 px par pas.
- `warp: {kx, cx, ky, cy}` : recalage imposé (sinon mesuré par le lecteur).

`tools/lytro_synth.py` fabrique deux piles synthétiques exactes (grille 9 × 5 et axe y) dans `demo/`.

## Mesures

`node lytro-viewer/tests/mesures.js` (Playwright, avec le dépôt servi sur le port 8799) : voir
`tests/RESULTATS.md` pour les chiffres et ce qu'ils valent.

## Limites connues

- Un contexte WebGL par case : très bien pour une page de démo, mais les navigateurs en limitent le nombre (~16).
  L'intégration dans les planches (étape 5) devra partager un contexte.
- Le recalage suppose une parallaxe proportionnelle à la disparité (vraie pour une caméra qui tourne autour du
  sujet) ; il ne corrige pas ce qui **bouge** dans les vues H3 (grain qui « bout », gestes) : c'est le rôle du
  contrôle qualité (étape 2) et des générateurs sans animation (étape 3).
- Agrandir beaucoup la fenêtre après chargement garde la définition de départ (un message invite à recharger).
