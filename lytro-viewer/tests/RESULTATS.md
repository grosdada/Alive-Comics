# Mesures du lecteur lytro-viewer — étape 1 (16/10/2026)

Mesuré dans le cloud par `tests/mesures.js` (Chromium sans écran, Playwright). **Pas de carte graphique là-bas :**
WebGL y tourne en logiciel (SwiftShader, sur le processeur). Les chiffres de qualité sont exacts ; les images par
seconde ne disent rien d'un vrai GPU (voir « À mesurer chez David »).

## 1. Repos : la photo exacte

Au centre, la vue affichée est la photo **au pixel près** (PSNR infini contre `v<center>.jpg` ramenée à la taille du
canevas, sur les 7 piles) : pas de retournement, pas de décalage, pas de rééchantillonnage (une texture = un pixel).

## 2. Doubles contours en mouvement lent

Test : le lecteur charge une vue sur deux ou trois (`minGap=3`, ou `4` pour la synthèse), puis on lui demande la
position exacte d'une vue réelle **qu'il n'a pas chargée** : il la reconstruit avec ses deux voisines. On mesure l'erreur sur
les bords (15 % des pixels au plus fort gradient, en niveaux 0-255), là où un double contour se verrait.

| Pile | Vues distinctes / doublons écartés | Trous testés | Écart moyen entre voisines | Fondu simple | Fondu guidé (k mesuré) | Gain | k mesuré |
|---|---|---|---|---|---|---|---|
| Synthèse grille (vérité exacte) | 45 / 0 | 2 | 7,5 px | 16,73 | **7,36** | **−56 %** | 0,76 (vrai : 1) |
| 1 mannequins-7 p2 | 32 / 9 | 6 | 3,8 px | 5,35 | 4,66 | −13 % | 1,28 |
| 2 mannequins-6 p5 | 37 / 4 | 12 | 3,6 px | 11,31 | 10,88 | −4 % | 1,22 |
| 3 mannequins-7 p6 | 20 / 21 | 3 | 5,1 px | 4,13 | 4,09 | −1 % | 0,99 |
| 4 mannequins-8 p3 | 23 / 18 | 9 | 3,8 px | 3,99 | 3,53 | −12 % | 1,12 |
| 5 coulisses-9 p4 | 40 / 1 | 21 | 3,4 px | 25,39 | 24,96 | −2 % | 1,22 |

Lecture :
- Sur la scène synthétique (temps vraiment arrêté), le fondu guidé supprime l'essentiel du double contour : un écart de
  7,5 px entre vues, 5 fois la limite de 1,5 px du prototype, passe sans dédoublement visible.
- Sur les piles H3, le gain est faible parce que **ce qui reste n'est pas de la parallaxe** : ce sont les changements
  entre vues (grain qui « bout », plis, gestes ; la pile 5 est la pire). Aucun lecteur ne peut corriger ça ; c'est le
  rôle de l'étape 2 (refuser ces vues) et de l'étape 3 (des vues sans animation).
- La mesure automatique de k est meilleure que k = 1 sur 3 piles H3, égale sur une, un peu moins bonne sur la
  synthèse (7,36 contre 7,06 avec k = 1) : elle sous-estime légèrement quand il y a de grandes occlusions.
- Le pas par défaut (`minGap` 1,5 px) garde des écarts de 1,5 à 3 px : bien en dessous des écarts testés ici.

## 3. Sortie de la zone morte

La souris traverse lentement la case (de 35 % à 65 % de la course, 120 pas, deux images par pas, sans se poser).
Plus grand pas de parallaxe d'une image à l'autre contre le pas médian, et écart moyen d'image entre deux images
successives :

| Pile | Pas max / médian (px) | Écart d'image max / médian (0-255) |
|---|---|---|
| 1 | 0,075 / 0,064 | 0,28 / 0,12 |
| 2 | 0,075 / 0,064 | 0,33 / 0,18 |
| 3 | 0,075 / 0,064 | 0,28 / 0,06 |
| 4 | 0,075 / 0,064 | 0,23 / 0,10 |
| 5 | 0,064 / 0,052 | 0,49 / 0,18 |
| synthèse grille | 0,057 / 0,048 | 0,16 / 0,12 |
| synthèse axe y | 0,051 / 0,048 | 0,17 / 0,12 |

Aucun saut : le pas maximal reste dans 1,2 fois le pas médian.

## 4. Mémoire GPU par case (estimée : textures allouées)

| Situation | Taille des vues | Vues chargées (relief 1 %) | Mémoire |
|---|---|---|---|
| Ordinateur, case de ~680 px, pas 1,5 px | 680 × 680 | 9 à 12 | 28 Mo |
| Ordinateur, pas 3 px | 680 × 680 | 7 | 20 Mo |
| Téléphone (Pixel 7 émulé, 412 px × 2,6), pas 2,5 px | 998 × 998 | 8 | 44 Mo |
| WebGL1 (repli), case de 478 px | 478 × 478 | 9 à 11 | 12 à 15 Mo |
| Grille 9 × 5 synthétique, ordinateur | 680 × 680 | 35 | 82 Mo |

Les vues sont chargées à la taille d'affichage (jamais plus que la pile), seulement celles qu'exige le relief
courant ; monter le relief en charge d'autres sans redécoder les premières (copie de couches sur le GPU).

## 5. Images par seconde

| Machine | Résultat |
|---|---|
| Cloud, rendu logiciel SwiftShader, 7 cases animées avec flou | 2 images/s, ~210 ms de « GPU » par case : **non représentatif** |
| PC de David (HITCHCOCK), Chrome 128, Windows, 7 cases animées avec flou, cases de 496 px | **60,1 images/s** (plafond de l'écran), pire intervalle 17 ms, **GPU 0,11 ms par case et par image** ; 203 Mo GPU pour les 7 cases (relief monté : 17 à 25 vues par pile H3, 45 pour la grille) |
| Téléphone moyen | à mesurer |

**À mesurer chez David** : ouvrir la démo sur le PC puis sur un téléphone, cliquer « Mesurer (6 s) ». Les 7 cases
oscillent avec le flou actif ; la page affiche les images par seconde, le pire intervalle et, si le navigateur le
permet (Chrome ou Edge sur ordinateur), le temps GPU par case et par image. Coller la ligne affichée dans ce fichier.

## 6. Vérifié aussi

- Ouverture d'un zip (compressé ou non, piles en sous-dossiers), d'un dossier (bouton ou glisser-déposer), adresse `?piles=`.
- Repli WebGL1 (`?webgl1=1`) : même rendu, une texture par vue.
- Téléphone (émulé) : toucher = mise au point, glisser = perspective, `touch-action` `pan-y` (axe x) / `none` (y, grille).
- Mise au point (scène synthétique, flou maximal) : sujet net sans bavure du fond ; fond net avec le disque flou qui
  déborde dessus ; premier plan net sans bavure.
- Console sans erreur dans tous ces essais.
