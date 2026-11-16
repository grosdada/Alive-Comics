# Pour Codex : réglage « Déclenchement des vidéos » (à reprendre dans Placenta Studio)

Nouveau dans Alive-Comics (16/11/2026) : choisir **quand les cases jouent**. Trois modes :
`hover` (au survol, **défaut = comportement d'avant**), `always` (en permanence), `scroll` (dès que la case est visible à l'écran).
Réglage **par planche** (défaut) et **par case** (exception, vide = « comme la planche »).

## Données
- `project.page.trigger` : absent = `hover` ; sinon `"always"` ou `"scroll"`.
- `project.panels[<id>].trigger` : absent = suit la planche ; sinon `"hover" | "always" | "scroll"`.
- Rien ne change pour une planche qui n'a pas ces champs (exports identiques).

## Où c'est dans le code
| Fichier | Changement |
|---|---|
| `app/web/js/forms.js` | `TRIGGERS`, `triggerForm()` (section « Déclenchement » d'une case) ; sélecteur « Déclenchement des vidéos (par défaut) » dans `pageForm()` |
| `app/web/js/main.js` | import de `triggerForm` ; section ajoutée dans `refreshInspector()` (pas pour les cases en relief, qui ont leur propre « déclenchement ») |
| `app/assemble.py` | `data["play"]` = déclenchement de la planche si ≠ survol ; `entry["trigger"]` par case ; `page_key` inclut les deux |
| `player/alive-player.js` | `trig(st)`, `auto(st)`, `watchScroll(st)` : les 4 tests `st.inst.play === "always"` deviennent `auto(st)` ; un `IntersectionObserver` (seuil 35 %) pose `st.vis` ; bulles des cases fixes suivent aussi le déclenchement |

## Règles
- Le **son** ne s'auto-déclenche pas (navigateurs) : il reste lié au vrai survol / au premier geste.
- `scroll` sans `IntersectionObserver` : la case joue tout le temps.
- Cases en relief : leur `depth.trigger` (survol / clic) reste ; `always` et `scroll` s'appliquent au survol-auto comme pour les vidéos.

## Recette
1. Planche sans réglage : survol comme avant. 2. `page.trigger = "scroll"` : les cases visibles jouent sans souris, celles hors écran
sont figées. 3. Une case en `hover` dans une planche `scroll` : elle ne joue qu'au survol. 4. Exporter, ouvrir `index.html`.
