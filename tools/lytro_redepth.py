"""Profondeur des vues Lytro refaite avec Depth Pro (GPU des que la file H3 est vide) : bords plus justes pour le flou.
python tools/lytro_redepth.py <projet> [case ...]"""
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, r"E:\Codex projects\Alive-Comics")
from app import depth, store  # noqa: E402

pid = sys.argv[1]
d0 = store.pdir(pid) / "lytro"
pans = sys.argv[2:] or sorted(p.name for p in d0.iterdir() if (p / "meta.json").exists())
for pan in pans:
    d = d0 / pan
    m = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    t0 = time.time()
    for j in range(m["n"]):
        v = np.asarray(Image.open(d / f"v{j:02d}.jpg").convert("RGB"), np.float32) / 255
        r = depth.raw_best(v)
        n = depth.normalize(r)
        Image.fromarray((n * 255 + 0.5).astype(np.uint8)).resize((m["w"] // 2, m["h"] // 2), Image.BILINEAR).save(d / f"d{j:02d}.png")
    m["depth"] = depth.best_name()
    (d / "meta.json").write_text(json.dumps(m, indent=1), encoding="utf-8")
    print(pid, pan, m["depth"], round(time.time() - t0, 1), "s", flush=True)
