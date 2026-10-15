---
name: boucle-parfaite
description: Concevoir, ecrire, controler et reparer des boucles video parfaites (premiere image = derniere) avec MiniMax H3 en image-to-video, notamment pour Alive-Comics (planches BD animees, livres de David). Declencher des que David parle de loop, boucle, boucle parfaite, effet aller-retour, video qui repart a l'envers, case qui se fige au raccord, idle, perso qui doit sortir du champ et etre remplace, orbite 360 en boucle, ou demande un nouveau livre / une nouvelle planche Alive-Comics. Aussi pour auditer ou reparer les boucles d'un livre deja rendu.
---

# Boucle parfaite (H3, Alive-Comics)

## Le probleme, en une phrase

Pour boucler, H3 recoit la meme image en premiere ET en derniere image (`last_frame = first_frame`, cases
« en boucle » d'Alive-Comics). Tout ce qui bouge doit donc **revenir a sa place**. Si le prompt decrit un geste qui
« va quelque part » (lever le bras, marcher vers, se tourner, poser, entrer), H3 le fait puis le **defait** : la
deuxieme moitie rejoue la premiere a l'envers. C'est l'effet « video lue a l'envers » que David deteste.
H3 freine aussi sur les 10 a 20 premieres et dernieres images pour retomber pile sur l'image de depart : la case
« marque un temps » a chaque tour.

La parade n'est pas d'ecrire « loop » ou « seamless » : c'est de **ne decrire que des mouvements dont l'etat final
est identique a l'etat initial sans retour en arriere**.

## Les quatre moteurs de boucle (a combiner)

Chaque case = un sujet en **idle vivant** + au moins un **moteur** :

| Moteur | Principe | Exemples qui marchent |
|---|---|---|
| **flux** | un flot continu, sans debut ni fin | fumee / vapeur qui monte, pluie, eau du robinet, flamme, ecran TV qui scintille, ampoules en chenillard, voilage qui ondule, poussiere dans un rayon, confettis qui tombent, paysage qui defile derriere une vitre |
| **releve** | des gens traversent **dans un seul sens** ; chacun sort du champ (ou passe derriere un objet) et est remplace par un identique | figurants qui traversent un couloir au fond, voitures qui passent de gauche a droite, technicien qui s'eloigne dans le noir pendant qu'un autre en meme bleu entre a gauche (la scene des sechoirs, Heures creuses p9 : la coiffeuse passe derriere les clientes et revient par l'autre cote) |
| **cycle** | un geste qui **tourne** toujours dans le meme sens | touiller un cafe, essuyer en petits cercles, polir une chaussure, serpillere en huit, cable passe d'une main a l'autre, poisson qui tourne dans son sac, tambour de machine a laver, horloge |
| **rythme** | un geste **court**, repete vite et souvent (beaucoup de periodes dans 5 s) | macher, tapoter, poudrer a petits coups, coudre, peigner d'avant en arriere, hocher la tete au rythme, tambouriner des doigts, respirer profondement en dormant |

**Idle vivant** (sur chaque personnage, meme le plus discret) : respire visiblement, cligne, le regard derive, le
tissu et les cheveux fremissent, le poids glisse a peine d'un pied a l'autre. C'est ce qui evite la case figee.

### A eviter (aller-retour garanti)

- un geste ample unique : lever / baisser les bras, se lever / se rasseoir, se tourner puis revenir ;
- un deplacement qui ne sort pas du champ : marcher vers, s'approcher, entrer puis ressortir par le meme cote ;
- un changement d'etat : remplir, vider, empiler, ouvrir une boite, signer, poser un objet, s'habiller ;
- « walk in place » / marcher sur place : H3 fait avancer puis reculer le sujet ;
- un **arc de camera de 90 °** en boucle : la camera va puis **revient** (aller-retour par construction). Pour un arc,
  utiliser la case pilotee au glisser (`demi_arc` / `arc` + `fige`, sans boucle) ou l'**orbite 360** complete.

### L'orbite 360 (une par page, dans la plus grande case)

La camera tourne toujours dans le meme sens et revient naturellement au depart : c'est la boucle la plus pure.
Avec un idle tres leger du sujet (respiration, clignement, tissu qui fremit), elle reste parfaite.
Choisir des images : **un seul sujet, bien detache du fond, en pied ou en buste, decor simple** (podium, studio,
salle vide). Eviter les foules, les sujets coupes au bord du cadre, les decors tres charges (H3 les invente en
tournant). L'orbite avec action est marquee experimentale dans l'app (LoRA 360 a 0,6) mais tient tres bien.

## Ecrire le prompt (anglais, sans negation)

H3 est distille, sans prompt negatif : « never », « not », « without », « no one » ajoutent ce qu'ils nient.
Bannir aussi les mots qui figent : « slowly », « slow », « tiny », « small », « calm », « stays in place » ; et ceux du
projet : costume, dolly, zoom, cinematic, operator, cameraman.

Gabarit d'un plan anime (camera `fixe`, tremble ajoute au lecteur) :

```
<Lieu>, <sujet precis> keeps <geste de rythme/cycle> ; <idle vivant du sujet>. <Moteur flux / releve
decrit avec une direction unique : "one after another", "always the same way", "leaving on the right as the next
arrives from the left">. Everything is already in motion at the very first image and still in motion at the very
last image. The shot is one seamless forward cycle: each motion keeps flowing in the same direction or repeats at
a steady beat, and the last image is the first image again. The only sound is the natural sound of the place: ...
```

Gabarit d'une orbite (camera `orbit360` + action `custom`, `loop: true`) :

```
<Sujet> keeps a living idle at the centre of the orbit: breathing visibly, blinking, the fabric and the hair
trembling. The orbit is already turning at the first image and still turning at the last image, at one even
speed all the way round.
```

Verbes : « keeps ... », « again and again », « one after another », « round and round in the same direction »,
« at a steady beat ». Dire **ou va le flux** (vers la droite, vers le haut, vers le fond), jamais un aller-retour.

## Choisir les images

- Repérer le moteur possible **dans l'image** : vapeur, ecran, ampoules, fenetre sous la pluie, couloir avec du
  passage, mains occupees a un geste repetitif, objet qui tourne.
- Personnages assis, appuyes, occupes : bons. Personnages en plein elan, a mi-geste : mauvais (H3 veut finir le geste).
- Gros plans de visage : idle seul + un flux de lumiere (flamme, TV) suffisent.

## Controler et reparer apres rendu

Outils dans `scripts/` (copies de travail dans `Y:\project\Projet-2026\Mode-Cringe-Telenovela\alive-comics-les-fideles`) :

- `loopcheck.py fichier.mp4` ou `loopcheck.py --etat etatN.json` : pour chaque case,
  `motion` (comme l'app), `miroir` (ressemblance de la video avec sa propre lecture a l'envers : < 0,55 avec une
  seule bosse = **ALLER-RETOUR**), `frein` (vitesse des bords / milieu), `raccord` (saut derniere -> premiere image),
  `bosses` / `plateau` (une excursion unique, un rythme, ou un flux stationnaire). Verdicts : ok, rythme, suspect,
  ALLER-RETOUR, FIGE.
- `loopfix.py etatN.json [--dry] [--pages ...]` : sans re-rendu et sans toucher aux cases validees (`review: "ok"`),
  choisit la meilleure variante (`/choose`), coupe l'**arret** au raccord (`edit.range`, tant que le saut reste
  inferieur a une demi-image de mouvement normal) puis accelere le reste du freinage (`edit.ease`).
  Liste les cases a re-rendre.
- Re-rendre (autre graine) les ALLER-RETOUR / FIGE / raccord > 3 ; si une case echoue deux fois, **changer de moteur**
  (passer en flux ou en orbite, ou changer d'image) plutot que d'insister.

Reperes mesures (livres 3 et 4, octobre 2026) : sur 60 cases, environ 4 a 6 ALLER-RETOUR (gestes amples, marcher
sur place, porte qu'on franchit) et une dizaine de FIGE (plans de foule sans moteur) ; les orbites 360 sont
toutes « ok » (miroir ~1) mais freinent fort aux bords (frein ~0,02) : `loopfix` le corrige.

## Procedure Alive-Comics (livre de 10 pages)

1. Lire `E:\Codex projects\Alive-Comics\docs\PILOTAGE-CLAUDE.html` (API, mode edition, pastilles).
2. Planches-contact des images non encore utilisees, choisir 60 images selon les criteres ci-dessus.
3. Ecrire le plan (`plan_livreN.py`) : par case, l'image, le texte, le **moteur** annote, les bruitages ; une
   orbite par page ; une maxime (`Voix off\maximes`) pour chaque bouche qui parle, une a deux par page.
4. `build_livreN.py check` (mots bannis, images, sons, aperçus des pages), regarder les aperçus.
5. `build_livreN.py test` : 6 cases temoins (une par moteur), audit, ajuster le gabarit si besoin.
6. `prepare` (toutes les pages), attendre, `audit`, `fix`, `retry`, re-`fix`, `export`, `book --publish`.
7. Imports de sons : `&force=1` quand la reutilisation est voulue (meme musique ou meme maxime ailleurs).
8. Ne jamais mettre une case en `review: "ok"` soi-meme ; reprendre d'abord les `"redo"` quand David le demande.
