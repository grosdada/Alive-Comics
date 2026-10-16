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

## REPONSE (session locale, 2026-10-16) — arcs verticaux, images 1 et 5
- Statut : fait. Fichiers dans `1_mannequins-7-les-tetes-suite_p2/` et `5_coulisses-9-la-pluie_p4/` :
  `rendus/arc_haut.mp4`, `rendus/arc_bas.mp4`, `pile-y/` (41 vues, `meta.json` avec `axis: "y"`, profondeur Depth Pro).
- ATTENTION, limite de H3 : sur les deux images, les deux arcs sont partis dans le MEME sens vertical. Les piles ne
  couvrent donc qu'un seul côté (`sides: "un"`) : image 1 de 0 à +14,6 px, image 5 de -28,6 à 0 px. Le lecteur doit
  gérer ce cas (course de la souris limitée au côté disponible), comme pour l'image 4 en horizontal.
- Signe : dans `meta.s`, le sens (haut/bas) est celui mesuré sur le décalage vertical ; `arc_haut`/`arc_bas` suivent la
  consigne du prompt, pas la mesure, qui fait foi.
- Temps arrêté : vérifié visuellement sur l'image 1 horizontale ; non revérifié sur les arcs verticaux.
