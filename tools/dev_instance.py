"""Deuxieme instance pour le developpement : port 8791, file de taches separee (data/jobs_dev.json).

    python tools/dev_instance.py

Permet de tester sans toucher a l'instance ouverte par l'utilisateur (port 8790).
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("ALIVE_PORT", "8791")
os.environ.setdefault("ALIVE_JOBS_FILE", str(ROOT / "data" / "jobs_dev.json"))
sys.path.insert(0, str(ROOT))
sys.argv.append("--no-browser")
from app.server import main  # noqa: E402

main()
