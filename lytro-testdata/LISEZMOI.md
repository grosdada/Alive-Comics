# Jeu de test « Lytro » — 5 images 1:1, temps arrêté

Images tirées des livres « Mannequins » et « Coulisses » (reportages 1987 générés pour Alive-Comics), recadrées en
carré. Pour chacune, deux rendus MiniMax H3 (demi-arc gauche, demi-arc droit, partant de l'image), avec une consigne
de temps totalement arrêté (voir `prompt_gauche.txt`, ajouté au préambule « One frozen instant. Only the camera
moves… » du nœud H3 Orbital).

Par dossier :
- `source.png` : l'image d'origine, 928×928 ;
- `rendus/arc_gauche.mp4`, `rendus/arc_droite.mp4` : les rendus bruts (73 images chacun) ;
- `pile/` : la pile de vues construite par `tools/lytro_build.py` puis `tools/lytro_redepth.py` (format décrit dans
  `docs/ROADMAP-LYTRO-CLOUD.md`, section 2) ;
- `apercu.jpg` : vue la plus à gauche, photo, vue la plus à droite.

Licence : MiniMax H3 exclut l'Union européenne (affichage des sorties compris) ; ces fichiers servent au développement
seulement.

| Dossier | Projet d'origine | Pile | Vues | Côtés | Parallaxe (px) |
|---|---|---|---|---|---|
| 1_mannequins-7-les-tetes-suite_p2 | `zz-lytro-tele-1-1d7b` | oui | 41 | deux | -28.73 .. 30.62 |
| 2_mannequins-6-les-tetes_p5 | `zz-lytro-tele-2-0182` | oui | 41 | deux | -29.9 .. 17.44 |
| 3_mannequins-7-les-tetes-suite_p6 | `zz-lytro-tele-3-a8a9` | oui | 41 | deux | -29.61 .. 26.88 |
| 4_mannequins-8-la-photo_p3 | `zz-lytro-tele-4-9224` | oui | 41 | un | 0.0 .. 30.24 |
| 5_coulisses-9-la-pluie_p4 | `zz-lytro-tele-5-b1c9` | oui | 41 | deux | -8.27 .. 30.24 |
