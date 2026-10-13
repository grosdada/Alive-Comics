# Alive-Comics

Créer des planches de BD animées : chaque case devient une courte vidéo (MiniMax H3 sur ComfyUI ou fal),
pilotée par le lecteur (glisser = bouger la caméra, lecture automatique, boucles, son au survol),
puis publiée en HTML (page seule ou livre) sur un hébergement web.

- `ALIVE-COMICS-CONNAISSANCES.html` : tout ce qui a été appris avec H3-Orbital (à lire d'abord).
- `player/` : le lecteur (page et livre), utilisé pour l'aperçu et pour l'export.
- `app/` : l'application (serveur Python sans dépendance + interface web).
- `tools/build_book.py`, `tools/build_shelf.py`, `tools/deploy.py` : assembler un livre, la page d'accueil, publier par SSH.

Réglages propres à chaque poste dans `local_settings.json` (jamais dans le dépôt).
