"""Telecharge les modeles du relief de precision (detourage + profondeur) dans le ComfyUI de cette machine.

    python tools/install_relief_models.py "<dossier ComfyUI>\\models"            (modeles ComfyUI, ~9 Go)
    python tools/install_relief_models.py "<dossier ComfyUI>\\models" --extra    (+ Depth Pro et BiRefNet HR-matting
                                                                                    pour les essais en Python, ~2,3 Go)

Reprend un telechargement interrompu ; un fichier deja present (meme taille) n'est pas retelecharge. Aucun compte
Hugging Face n'est necessaire (depots publics).
"""
import sys
import time
from pathlib import Path

COMFY = [  # (depot, fichier dans le depot = sous-dossier ComfyUI / nom, taille approximative en Go)
    ("Comfy-Org/sam3.1", "checkpoints/sam3.1_multiplex_fp16.safetensors", 1.75),
    ("Comfy-Org/MoGe", "geometry_estimation/moge_3_vitg_fp16.safetensors", 2.5),
    ("Comfy-Org/MoGe", "geometry_estimation/moge_3_vitl_fp16.safetensors", 0.74),
    ("Comfy-Org/Depth-Anything-3", "geometry_estimation/depth_anything_3_mono_large.safetensors", 1.34),
    ("Comfy-Org/Depth-Anything-3", "geometry_estimation/depth_anything_3_metric_large.safetensors", 1.34),
    ("Comfy-Org/BiRefNet", "background_removal/birefnet.safetensors", 0.44),
    ("Comfy-Org/BiRefNet", "background_removal/lucida.safetensors", 0.88),
]
EXTRA = ["apple/DepthPro-hf", "ZhengPeng7/BiRefNet_HR-matting"]   # data/models/hf, pour les essais en Python


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    models = Path(sys.argv[1])
    if not (models / "checkpoints").is_dir():
        sys.exit(f"{models} ne ressemble pas a un dossier models de ComfyUI (pas de sous-dossier checkpoints)")
    from huggingface_hub import hf_hub_download, snapshot_download
    for repo, path, gb in COMFY:
        dest = models / path
        if dest.exists() and dest.stat().st_size > gb * 0.9e9:
            print(f"deja la : {path}")
            continue
        t0 = time.time()
        print(f"telechargement : {path} (~{gb} Go) depuis {repo}…", flush=True)
        hf_hub_download(repo, path, local_dir=models)
        print(f"   ok en {time.time() - t0:.0f} s", flush=True)
    if "--extra" in sys.argv:
        root = Path(__file__).resolve().parent.parent / "data" / "models" / "hf"
        for repo in EXTRA:                              # dossier simple : Windows refuse les liens du cache Hugging Face
            print(f"telechargement (essais Python) : {repo}…", flush=True)
            snapshot_download(repo, local_dir=root / repo.replace("/", "__"))
            print("   ok", flush=True)
    print("termine")


if __name__ == "__main__":
    main()
