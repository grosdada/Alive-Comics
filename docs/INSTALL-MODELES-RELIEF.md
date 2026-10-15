# Consigne : installer les modèles du relief de précision (CASSAVETES, FORD)

À transmettre tel quel au Claude de la machine. Objectif : ajouter au ComfyUI local les modèles de détourage et de
profondeur utilisés par Alive-Comics (app de David, pilotée depuis HITCHCOCK par le réseau). Environ 9 Go.

## Règles
- Ne pas arrêter ni redémarrer ComfyUI pendant un calcul : vérifier d'abord que la file est vide
  (`http://localhost:8188/queue` : `queue_running` et `queue_pending` vides).
- Ne rien changer d'autre (pas de mise à jour de ComfyUI, pas de nouveau nœud) : les nœuds nécessaires sont déjà
  là (natifs de ComfyUI 0.33+ : SAM3_Detect, LoadMoGeModel, LoadDA3Model, LoadBackgroundRemovalModel).
- Dépôts Hugging Face publics : aucun compte ni jeton.

## 1. Trouver le dossier `models` de ComfyUI
C'est le dossier `ComfyUI\models` de l'installation qui tourne (processus `python … main.py --listen`), celui qui
contient `checkpoints`, `geometry_estimation` et `background_removal`. Exemple sur HITCHCOCK :
`E:\Comfy-UI\new_ComfyUI_windows_portable_nvidia_cu121_or_cpu\ComfyUI_windows_portable\ComfyUI\models`.

## 2. Télécharger ces 7 fichiers, chacun dans le sous-dossier indiqué

| Sous-dossier de `models` | Fichier | Taille | Adresse |
|---|---|---|---|
| `checkpoints` | `sam3.1_multiplex_fp16.safetensors` | 1,75 Go | https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors |
| `geometry_estimation` | `moge_3_vitg_fp16.safetensors` | 2,5 Go | https://huggingface.co/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_3_vitg_fp16.safetensors |
| `geometry_estimation` | `moge_3_vitl_fp16.safetensors` | 0,74 Go | https://huggingface.co/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_3_vitl_fp16.safetensors |
| `geometry_estimation` | `depth_anything_3_mono_large.safetensors` | 1,34 Go | https://huggingface.co/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/depth_anything_3_mono_large.safetensors |
| `geometry_estimation` | `depth_anything_3_metric_large.safetensors` | 1,34 Go | https://huggingface.co/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/depth_anything_3_metric_large.safetensors |
| `background_removal` | `birefnet.safetensors` | 0,44 Go | https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors |
| `background_removal` | `lucida.safetensors` | 0,88 Go | https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/lucida.safetensors |

Méthode conseillée (reprend si ça coupe), avec le Python embarqué de ComfyUI ou n'importe quel Python qui a
`huggingface_hub` (`pip install huggingface_hub` sinon) :

```
python -c "from huggingface_hub import hf_hub_download as d; M=r'<DOSSIER models>'; [d(r, f, local_dir=M) for r, f in [('Comfy-Org/sam3.1','checkpoints/sam3.1_multiplex_fp16.safetensors'),('Comfy-Org/MoGe','geometry_estimation/moge_3_vitg_fp16.safetensors'),('Comfy-Org/MoGe','geometry_estimation/moge_3_vitl_fp16.safetensors'),('Comfy-Org/Depth-Anything-3','geometry_estimation/depth_anything_3_mono_large.safetensors'),('Comfy-Org/Depth-Anything-3','geometry_estimation/depth_anything_3_metric_large.safetensors'),('Comfy-Org/BiRefNet','background_removal/birefnet.safetensors'),('Comfy-Org/BiRefNet','background_removal/lucida.safetensors')]]"
```

(`local_dir` = le dossier `models` : les chemins du dépôt correspondent déjà aux sous-dossiers de ComfyUI. Un dossier
`models\.cache` peut apparaître : c'est le suivi de téléchargement de Hugging Face, sans danger.) À défaut, télécharger
chaque adresse du tableau avec `curl -L -o <chemin complet> <adresse>`.

## 3. Vérifier
Ouvrir (ou `curl`) sur la machine :
- `http://localhost:8188/object_info/LoadMoGeModel` : les options de `model_name` listent les deux `moge_3_…`
- `http://localhost:8188/object_info/LoadDA3Model` : les deux `depth_anything_3_…`
- `http://localhost:8188/object_info/LoadBackgroundRemovalModel` : `birefnet.safetensors` et `lucida.safetensors`
- `http://localhost:8188/object_info/CheckpointLoaderSimple` : `sam3.1_multiplex_fp16.safetensors` dans `ckpt_name`

Si un fichier présent sur le disque n'apparaît pas dans ces listes, redémarrer ComfyUI **seulement quand la file est
vide**.

## Ce que l'app utilise vraiment (octobre 2026)
- Couches v2 : `SAM3_Detect` (sam3.1), `RemoveBackground` (birefnet), Qwen-Image-Edit 2509 (déjà là pour la v1) et, en
  repli, LaMa (`LaMaInpaint` / `LoadLaMaModel` de comfyui-art-venture, `big-lama.pt`).
- **MoGe-3** ne se charge pas sur ComfyUI 0.33 (il faut 0.37 ou plus ; Marigold V2 : 0.36) : fichiers gardés pour plus
  tard. DA3 mono-large est installé en réserve.
- **Depth Pro** (profondeur des couches) tourne sur le PC de l'app (HITCHCOCK), pas dans ComfyUI :
  `python tools/install_relief_models.py "<models>" --extra` (dans `data/models/hf/`) + `pip install torch transformers`.
  Sans lui, l'app prend Depth Anything V2 Small.

## 4. Compte rendu à renvoyer à David
La liste des 7 fichiers avec leur taille sur le disque, et le résultat des 4 vérifications (présents / absents).
