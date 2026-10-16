# Demandes de rendus (session cloud -> session locale)

La session cloud ne peut pas faire de rendus (ComfyUI et les GPU sont sur les PC de David). Pour en demander :

1. Ajoute une entrée ci-dessous (sur ta branche), puis pousse et dis à David : « demande de rendu dans DEMANDES.md ».
2. La session locale lit le fichier sur ta branche, fait les rendus, ajoute les résultats dans `lytro-testdata/`
   et répond sous ton entrée (statut « fait » + chemins).

Format d'une entrée :

```
## AAAA-MM-JJ — titre court
- Images : lesquelles (dossier de lytro-testdata ou description)
- Ce qu'il faut : vues gauche/droite, haut/bas, grille, autre modèle, profondeur...
- Réglages : amplitude, nombre de vues, résolution...
- Pourquoi : ce que ça doit permettre de tester
- Statut : demandé
```

---

## 2026-10-16 — arcs verticaux (haut / bas) sur deux images du jeu de test
- Images : `1_mannequins-7-les-tetes-suite_p2` et `5_coulisses-9-la-pluie_p4`
- Ce qu'il faut : deux demi-arcs **verticaux** H3 « temps figé » (caméra qui monte, caméra qui descend, partant de
  l'image), puis la pile construite par `tools/lytro_build.py` (caméra « vertical », donc `axis: "y"`) et
  `tools/lytro_redepth.py` (Depth Pro). À ranger dans `<dossier>/pile-y/` (et `rendus/arc_haut.mp4`, `arc_bas.mp4`).
- Réglages : les mêmes que les arcs horizontaux du jeu de test (amplitude « lytro », 73 images, 41 vues, 1024 px).
- Pourquoi : tester l'axe y du lecteur `lytro-viewer/` (étape 1) sur de vraies vues ; aujourd'hui il n'est testé que
  sur une scène synthétique (`tools/lytro_synth.py`). Pas bloquant : le lecteur avance sans.
- Statut : demandé
