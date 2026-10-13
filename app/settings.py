"""Reglages propres au poste : local_settings.json a la racine du depot (jamais versionne).

Les cles API ne repartent jamais vers l'interface en clair : public() les masque.
"""

import copy
import json
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILE = ROOT / "local_settings.json"
_lock = threading.Lock()

DEFAULTS = {
    "server": {"host": "127.0.0.1", "port": 8790},
    "llm": {
        "provider": "anthropic",
        "anthropic": {"key": "", "model": "claude-sonnet-5-5"},
        "openai": {"key": "", "model": "gpt-5"},
        "google": {"key": "", "model": "gemini-2.5-flash"},
        "deepseek": {"key": "", "model": "deepseek-chat"},
    },
    "fal": {"key": "", "concurrency": 4, "resolution": "768P", "price_per_second": 0.08},
    "workers": [
        {"name": "HITCHCOCK", "url": "http://192.168.1.60:8188", "enabled": True},
        {"name": "CASSAVETES", "url": "http://192.168.1.89:8188", "enabled": True},
        {"name": "FORD", "url": "http://192.168.1.92:8188", "enabled": True},
    ],
    "render": {"seed": 904231, "megapixels": 0.8, "long_side_max": 1344, "steps": 28},
    "deploy": {"host": "", "port": 65002, "user": "", "key": "~/.ssh/alive_comics_hostinger", "root": "", "url": ""},
}
SECRET_PATHS = [("llm", "anthropic", "key"), ("llm", "openai", "key"), ("llm", "google", "key"),
                ("llm", "deepseek", "key"), ("fal", "key")]


def _merge(base, extra):
    out = copy.deepcopy(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load():
    with _lock:
        data = json.loads(FILE.read_text(encoding="utf-8")) if FILE.exists() else {}
    return _merge(DEFAULTS, data)


def save(data):
    with _lock:
        FILE.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")


def _get(d, path):
    for k in path:
        d = d.get(k, {}) if isinstance(d, dict) else {}
    return d if isinstance(d, str) else ""


def _set(d, path, value):
    for k in path[:-1]:
        d = d.setdefault(k, {})
    d[path[-1]] = value


def mask(key):
    return ("••••" + key[-4:]) if key else ""


def public():
    data = load()
    for path in SECRET_PATHS:
        _set(data, path, mask(_get(data, path)))
    return data


def update(patch):
    """Applique un patch venant de l'interface. Une cle masquee (••••) ou absente garde l'ancienne valeur."""
    data = load()
    new = _merge(data, patch)
    for path in SECRET_PATHS:
        v = _get(new, path)
        if v.startswith("••••"):
            _set(new, path, _get(data, path))
    save(new)
    return public()
