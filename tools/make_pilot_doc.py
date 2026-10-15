"""Genere docs/PILOTAGE-CLAUDE.html : le guide pour qu'une instance de Claude pilote Alive-Comics par API.

    python tools/make_pilot_doc.py

Les tableaux (cameras, actions, sons, voix, decoupages) sont lus dans le code : relancer apres chaque
changement de app/presets.py ou app/geometry.py.
"""

import html
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app import geometry, presets  # noqa: E402

E = html.escape


def table(head, rows):
    out = ["<div class='tbl'><table><tr>" + "".join(f"<th>{E(h)}</th>" for h in head) + "</tr>"]
    for r in rows:
        out.append("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>")
    return "\n".join(out) + "</table></div>"


def code(x):
    return f"<code>{E(str(x))}</code>"


PLAYER = {"orbit360": "loop (glisser = tourner sans fin)", "arc": "arc (deux demi-arcs L/R, glisser)",
          "demi_arc": "seul (un demi-arc, glisser)", "vertical": "arc (L = vers le bas, R = vers le haut)",
          "travelling": "arc (L = recul, R = avance)"}

cams = table(["id", "nom", "type", "champs", "options", "rendu sans action (« fige »)", "avec une action"], [
    [code(c["id"]), E(c["label"]), "pilotée au glisser" if c["kind"] == "frozen" else "plan animé",
     ", ".join(code(f) for f in c.get("fields", [])) or "—", ", ".join(code(o) for o in c.get("options", [])) or "—",
     E(PLAYER.get(c["id"], "image fixe (sauf précisions)" if c["id"] == "fixe" else "plan animé, lecture auto")),
     "un seul plan animé (I2V natif), lecture auto" + (" — LoRA 360 à 0,6 (expérimental)" if c["id"] == "orbit360" else "")]
    for c in presets.CAMERAS])
acts = table(["id", "nom", "champs", "à quoi ça sert"], [
    [code(a["id"]), E(a["label"]), ", ".join(code(f) for f in a.get("fields", [])) or "—", E(a["hint"])] for a in presets.ACTIONS])
fields = table(["champ", "sens", "exemple (anglais)"], [[code(k), E(v[0]), E(v[1])] for k, v in presets.FIELDS.items()])
audios = table(["preset", "nom", "ce que « extra » doit contenir"], [
    [code(a["id"]), E(a["label"]), E(a.get("extra_hint") or ("la légende COMPLÈTE en 3 blocs (Global Metadata / Vocal Details / Arrangement)"
                                                           if a["id"] == "custom" else "une phrase anglaise : ambiance, instruments, textures"))]
    for a in presets.AUDIO])
voices = table(["voice_id", "voix"], [[code(v["id"]), E(v["label"])] for v in presets.VOICES])
foleys = table(["engine", "moteur", "remarque"], [[code(f["id"]), E(f["label"]), E(f["hint"])] for f in presets.FOLEY])
layouts = table(["preset", "découpage"], [[code(k), E(v[0])] for k, v in geometry.PRESETS.items()]
                + [[code("random:N"), "N cases au hasard (ex. random:6), avec « tilt » (0 à 0,12) et « seed »"]])
formats = table(["format", "nom", "vertical (l × h)", "horizontal"], [
    [code(k), E(v[2]), f"{v[0]} × {v[1]}", f"{v[1]} × {v[0]}"] for k, v in geometry.FORMATS.items()])

retouches = table(["Clé de edit", "Valeur", "Effet"], [
    ["shake", "{size: % de la case, freq: Hz, rot: degrés, seed}", "tremblé caméra (sans lui : celui du preset, epaule = moyen). size 0 = aucun"],
    ["grade", "{sat, bright, contrast (1 = neutre), temp -1..1, hue degrés}", "couleurs de la case"],
    ["frame", "{zoom ≥ 1, x, y de -1 à 1}", "recadrage dans la case (cacher un bord, un défaut)"],
    ["range", "[début, fin] en images", "points de boucle : couper un temps mort au début ou à la fin"],
    ["xfade", "nombre d'images (0 à 24)", "fondu au point de boucle (raccord invisible après une coupe)"],
    ["speed", "0,25 à 2", "vitesse de lecture"],
    ["bounce", "true / false", "aller-retour ou boucle vers l'avant"],
    ["start", "image", "image de départ et de « Vue initiale »"],
    ["ease", "{head, tail : images, gain : 1,5 à 3}", "H3 freine au début et à la fin de chaque boucle (pour retomber sur la 1re image) : ces images sont jouées plus vite, sans couper"],
])

PAGE = f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Piloter Alive-Comics</title>
<style>
  :root {{ --bg:#f7f5f0; --panel:#fff; --ink:#1d1b18; --muted:#6b655c; --line:#e2dccf; --accent:#b5561c; --code:#f0ece4; --warn:#a3471a; --note:#eef3f8; }}
  @media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#141312; --panel:#1c1b19; --ink:#ece8e1; --muted:#9a948a; --line:#34312c; --accent:#f2b45c; --code:#24221f; --warn:#f08a5d; --note:#1b2430; }} }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 system-ui,"Segoe UI",Roboto,sans-serif; }}
  header {{ padding:26px 16px 16px; background:var(--panel); border-bottom:1px solid var(--line); }}
  header h1 {{ margin:0 0 6px; font-size:clamp(24px,4vw,34px); }}
  header p {{ margin:0; color:var(--muted); max-width:960px; }}
  .wrap {{ max-width:1100px; margin:0 auto; padding:20px 16px 80px; }}
  nav ol {{ columns:2; padding-left:20px; }} nav a {{ color:var(--ink); text-decoration:none; }} nav a:hover {{ color:var(--accent); }}
  section {{ background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:4px 22px 16px; margin:0 0 20px; }}
  h2 {{ font-size:22px; margin:18px 0 8px; }} h2 .n {{ color:var(--accent); margin-right:8px; }}
  h3 {{ font-size:17px; margin:18px 0 6px; }}
  code {{ font:13.5px/1.5 ui-monospace,"Cascadia Code",Consolas,monospace; background:var(--code); padding:1px 5px; border-radius:4px; overflow-wrap:anywhere; }}
  pre {{ background:var(--code); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow-x:auto; font:13px/1.5 ui-monospace,Consolas,monospace; }}
  pre code {{ background:none; padding:0; }}
  .tbl {{ overflow-x:auto; margin:10px 0 14px; }} table {{ border-collapse:collapse; width:100%; font-size:14px; }}
  th, td {{ border:1px solid var(--line); padding:6px 9px; text-align:left; vertical-align:top; }} th {{ background:var(--code); }}
  .warn, .note {{ border-left:4px solid var(--warn); background:var(--code); padding:10px 14px; border-radius:6px; margin:12px 0; }}
  .note {{ border-color:#7fa3c8; background:var(--note); }}
  li {{ margin:3px 0; }}
  @media (max-width:760px) {{ nav ol {{ columns:1; }} section {{ padding:4px 14px 14px; }} }}
</style>
</head>
<body>
<header><div class="wrap" style="padding:0">
<h1>Piloter Alive-Comics (pour une instance de Claude)</h1>
<p>Ce guide te permet de construire seul une planche de BD animée complète avec l'application Alive-Comics, uniquement par
HTTP : découpage, images, mouvements de caméra, actions, sons, voix off, rendus sur les machines de David, vérification,
export et publication. <b>Tu es le cerveau</b> : n'utilise pas l'IA intégrée de l'application. David te donnera un thème
et des chemins de fichiers (images, sons).</p>
</div></header>
<div class="wrap">
<nav><ol>
<li><a href="#role">Ton rôle et les règles</a></li>
<li><a href="#demarrer">Démarrer et vérifier</a></li>
<li><a href="#modele">Le modèle de données</a></li>
<li><a href="#catalogue">Catalogue : caméras, actions</a></li>
<li><a href="#ecrire">Écrire pour MiniMax H3</a></li>
<li><a href="#sons">Les sons</a></li>
<li><a href="#api">Référence de l'API</a></li>
<li><a href="#recette">La recette, du thème à la page</a></li>
<li><a href="#enchainer">Plusieurs pages à la suite</a></li>
<li><a href="#verifier">Vérifier et corriger les rendus</a></li>
<li><a href="#retouches">Retouches sans régénérer</a></li>
<li><a href="#relief">Relief (photo en relief)</a></li>
<li><a href="#publier">Exporter, publier, livres</a></li>
<li><a href="#pieges">Pièges connus</a></li>
<li><a href="#exemple">Script complet d'exemple</a></li>
</ol></nav>

<section id="role"><h2><span class="n">1</span>Ton rôle et les règles</h2>
<ul>
<li><b>Tu décides de tout</b> : découpage, ordre de lecture, mouvements, actions, textes (en anglais pour H3), sons, voix off
(en français). <b>N'appelle jamais</b> {code("/api/projects/<id>/direct")} (le réalisateur IA intégré) ni {code("/api/llm/*")} :
c'est toi l'intelligence.</li>
<li><b>Tu ne modifies jamais les fichiers du projet à la main</b> ({code("projects/<id>/project.json")} etc.) pendant que le serveur
tourne : passe toujours par l'API (elle gère les verrous, les versions et la fusion avec l'interface).</li>
<li>David peut avoir l'interface ouverte sur la même planche : elle se <b>recharge seule</b> quand tu modifies la planche
(numéro de version {code("rev")}). Évite seulement de modifier une planche pendant qu'il la modifie lui-même.</li>
<li><b>Ce qui coûte de l'argent</b> (fal.ai) : la voix off ({code("voice.mode = tts")}), les bruitages cloud
({code("foley.engine = hunyuan | mmaudio")}) et les rendus avec {code('target: "fal"')} ou {code('"auto"')}. Tout le reste
tourne gratuitement sur les machines de David (ComfyUI). Par défaut, reste en local ; n'utilise fal que si David le demande.</li>
<li><b>Publier met la page en ligne</b> (lien public, non indexé) : ne publie que si David te l'a demandé.</li>
<li>Réponds et rends compte à David <b>en français</b>.</li>
</ul></section>

<section id="demarrer"><h2><span class="n">2</span>Démarrer et vérifier</h2>
<ul>
<li>Dossier : {code(str(ROOT))}. Serveur : <b>{code("http://127.0.0.1:8790")}</b> (local uniquement). API JSON sous {code("/api/")}.</li>
<li>S'il ne répond pas, le lancer <b>détaché</b> (pour qu'il survive à ta session) :
{code('explorer.exe "' + str(ROOT / "Lancer_Alive_Comics.bat") + '"')}. Un seul serveur à la fois : un second lancement ouvre
simplement l'application déjà lancée. Journal : {code("data/server.log")}.</li>
<li>Python 3.10+, ffmpeg dans le PATH. Pour tes appels, la bibliothèque standard suffit (voir le client ci-dessous).</li>
</ul>
<pre><code>GET /api/info      -> {{"version", "llm": {{...}}, "fal": true|false}}
GET /api/workers   -> [{{"name", "url", "enabled", "job", "pf": {{"online", "video", "music", "h3audio", "gpu", "load", "missing"}}}}]
                      pf.video = la machine peut rendre H3 ; pf.music = MiniMax Music 3 ; pf.load = file ComfyUI
GET /api/presets   -> le catalogue officiel (cameras, actions, audio, voices, emotions, languages, foley, fields, amplitudes)
GET /api/layouts   -> les decoupages prets</code></pre>
<p>Machines habituelles : HITCHCOCK (192.168.1.60), CASSAVETES (.89), FORD (.92), RTX 5090 32 Go, ComfyUI 0.33 avec MiniMax H3,
le LoRA 360 Orbit et MiniMax Music 3. Si une machine n'est pas {code("online")}, les rendus vont sur les autres.</p>
<h3>Client minimal (bibliothèque standard)</h3>
<pre><code>import json, urllib.request
BASE = "http://127.0.0.1:8790/api"

def api(method, path, body=None, raw=None, timeout=600):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    ctype = "application/octet-stream" if raw is not None else "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={{"Content-Type": ctype}})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{{method}} {{path}} -> {{e.code}} {{e.read().decode()[:500]}}")</code></pre>
</section>

<section id="modele"><h2><span class="n">3</span>Le modèle de données</h2>
<h3>Une planche (projet)</h3>
<pre><code>{{
 "id": "ma-planche-1a2b", "name": "…", "rev": 12,          // rev : augmente a chaque enregistrement
 "page": {{"format": "bd", "orientation": "portrait", "width": 1600, "height": 2400,
          "bg": "#ffffff", "stroke": "#111111", "strokeWidth": 5, "gutter": 22, "margin": 60}},
 "layout": {{ arbre de decoupes, voir ci-dessous }},
 "panels": {{ "p1": {{ case }}, "p2": {{…}} }},
 "geometry": {{"size": [W, H], "panels": [{{"id": "p3", "order": 1, "rect": [x0,y0,x1,y1], "poly": [[x,y],…]}}]}},
 "style": "ambiance commune en anglais, ajoutee aux plans animes",
 "pageSound": {{"mode": "none|file|generate", "preset", "extra", "seconds", "volume", "file"}}
}}</code></pre>
<div class="warn"><b>Les identifiants des cases ({code("p1")}, {code("p2")}…) ne sont pas l'ordre de lecture.</b> L'ordre de lecture est
{code("geometry.panels[].order")} (rangées de haut en bas, puis de gauche à droite). Lis toujours la géométrie pour savoir
quelle case est où ({code("rect")} en pixels de page, donc forme large / haute).</div>
<h3>Le découpage ({code("layout")})</h3>
<pre><code>feuille : {{"t": "leaf", "id": "p3"}}
decoupe : {{"t": "split", "dir": "h"|"v", "a": 0..1, "b": 0..1, "c": [enfant1, enfant2]}}
  "h" = trait plutot horizontal (enfant1 au-dessus) ; "v" = trait plutot vertical (enfant1 a gauche)
  a, b = position du trait a ses deux bouts dans la boite du parent ; a != b -> trait penche (ex. 0.34 / 0.27)</code></pre>
<p>Le plus simple : créer la planche avec un découpage prêt. Tu peux aussi envoyer ton propre arbre via {code("/update")}.</p>
{layouts}
{formats}
<h3>Une case</h3>
<pre><code>{{
 "image":  {{"file": "assets/…", "w": 1344, "h": 768, "name": "…"}},     // pose par /panels/&lt;id&gt;/image
 "view":   {{"zoom": 1.0, "ox": 0, "oy": 0}},     // recadrage : zoom >= 1 ; ox/oy = decalage en fraction de la case
 "camera": {{"id": "arc", "fields": {{…}}, "amplitude": "moyen", "rigid": false, "extra": "precisions (anglais)"}},
 "action": {{"id": "fige", "fields": {{…}}, "loop": true, "extra": "precisions (anglais)"}},
 "audio":  {{"mode": "none|file|generate", "preset", "extra", "seconds": 30, "volume": 0.8, "file"}},      // son 1
 "voice":  {{"mode": "none|file|tts|music", "text", "voice_id", "emotion", "language", "speed", "loop", "volume", "file"}},  // son 2
 "foley":  {{"on": false, "engine": "h3|hunyuan|mmaudio", "prompt", "volume": 0.9, "file"}},             // bruitages
 "seed": 904231,
 "renders": [ {{"file", "side": "L|R|V", "seed", "worker", "seconds", "prompt", "audio"}} ],   // ecrit par le moteur
 "chosen":  {{"L": "renders/…", "R": "…"}} ou {{"V": "…"}}                                   // la video utilisee
}}</code></pre>
</section>

<section id="catalogue"><h2><span class="n">4</span>Catalogue : caméras et actions</h2>
<p>Deux familles de cases :</p>
<ul>
<li><b>Temps figé, caméra pilotée au glisser</b> : caméra {code("orbit360")}, {code("arc")}, {code("demi_arc")}, {code("vertical")},
{code("travelling")} <b>avec l'action</b> {code("fige")}. La scène est immobile, le lecteur fait bouger la caméra en glissant.
Parfait pour les compositions fortes, les objets, les tableaux.</li>
<li><b>Plan animé, lecture automatique</b> : n'importe quelle caméra avec une action autre que {code("fige")} (ou les caméras
{code("fixe")}, {code("grue")}, {code("avancee")}, {code("epaule")}, {code("custom")}). La case joue seule, en boucle si
{code("action.loop")} est vrai (valeur par défaut : la dernière image rejoint la première).</li>
<li>{code("fixe")} + {code("fige")} sans précisions = <b>image fixe</b> (pas de vidéo). Des {code("camera.extra")} suffisent à en faire une vidéo.</li>
<li>Dans le lecteur, les plans animés <b>ne bougent qu'au survol</b> (démarrage et arrêt en douceur) ; au doigt, la dernière case touchée joue.</li>
<li><b>Tremblé caméra ajouté au montage</b> ({code("camera.shake")} : {code("aucun")}, {code("leger")}, {code("moyen")}, {code("fort")} ;
{code("moyen")} par défaut pour {code("epaule")}) : dérive lente et discrète ajoutée à l'export, sans nouveau rendu, boucle intacte.</li>
</ul>
{cams}
{acts}
<h3>Les champs</h3>
{fields}
<p>{code("amplitude")} : {code("petit")} (40° écrits), {code("moyen")} (55°), {code("grand")} (70°) — H3 en fait environ 60 %.
{code("rigid: true")} pour un objet solide qui risquerait de pivoter sur lui-même au lieu que la caméra tourne
(masque, statue, véhicule, robot) : met le LoRA 360 à 0,5. Les {code("extra")} sont ajoutés tels quels au prompt.</p>
<p>Vérifier le prompt exact avant de rendre : {code('POST /api/plan {"panel": <case>, "style": "…"}')} renvoie le type de lecteur,
les vidéos à calculer (côté, LoRA, longueur, boucle) et le prompt complet envoyé à H3.</p>
</section>

<section id="ecrire"><h2><span class="n">5</span>Écrire pour MiniMax H3 (leçons mesurées)</h2>
<ol>
<li><b>Anglais</b> pour tous les champs, précisions et ambiances. Français seulement pour la voix off.</li>
<li>Les champs sont <b>insérés dans des phrases</b> : {code("subject")} est un groupe nominal court (« the golden mask ») ;
{code("left")}, {code("right")}, {code("ending")}, {code("close")}, {code("wide")}, {code("toward")} sont des <b>groupes nominaux
décrivant la vue d'arrivée</b> (« a three-quarter view of his face, the round glasses in front »), jamais une phrase, jamais le mot « camera ».</li>
<li><b>Décris où la caméra arrive</b>, pas seulement « gauche / droite » (H3 ignore gauche/droite, il suit une destination décrite).</li>
<li>Nomme le sujet précisément ; pour un arc, décris deux arrivées vraiment opposées.</li>
<li><b>Mouvement fort, constant, visible</b> pour les actions (« never stop moving », « clearly visible for the whole shot ») et dis ce qui reste immobile.</li>
<li>Textures sans « côté » (tentacules, amas) : caméra {code("vertical")}. Vers un détail : {code("travelling")} (un vrai travelling, pas un zoom).</li>
<li>Varie les plans sur la page ; adapte le mouvement à la forme de la case (large : arc, travelling ; haute : vertical, grue).</li>
<li>Une case = une vidéo de 3 s par demi-arc (73 images) ou 5,2 s (124 images) : ne décris pas une histoire longue dans une case.</li>
<li>Durées et tailles sont automatiques (≈ 0,8 Mpx au format de la case, côté long ≤ 1344). Limite H3 : 15 s par rendu.</li>
<li>« style » (ambiance commune, anglais) s'ajoute aux plans animés : époque, lumière, grain (« Warm 1970s film look »).</li>
</ol>
</section>

<section id="sons"><h2><span class="n">6</span>Les sons</h2>
<p>Jusqu'à trois couches par case + un son global de page. Tous les sons sont égalisés à l'export
(ambiance -24, bruitages -21, voix -17, page -23 LUFS) ; les volumes (0 à 1) règlent ensuite le mélange.</p>
<h3>Son 1 : ambiance de la case ({code("audio")}), en boucle au survol</h3>
<ul><li>{code('{"mode": "file"}')} : envoie le fichier par {code("/panels/<id>/sound?layer=audio")}.</li>
<li>{code('{"mode": "generate", "preset": "…", "extra": "…", "seconds": 30}')} : MiniMax Music 3 sur les machines (2 à 6 min),
lancé automatiquement avec les rendus de la case, ou à la demande ({code("POST /projects/<id>/audio/<case>")}).</li></ul>
{audios}
<p>Une légende Music 3 a trois blocs : {code("Global Metadata: …")} / {code("Vocal Details: …")} / {code("Arrangement: …")}.
Pour un instrumental, les paroles sont fixées à {code("[Intro] [Instrumental] [Outro]")}. Exclure explicitement ce qu'on ne veut pas
(« no drum kit, no synthesizer, nothing modern »).</p>
<h3>Son 2 : voix off ou second son ({code("voice")})</h3>
<ul><li>{code('{"mode": "tts", "text": "…en français…", "voice_id": "Deep_Voice_Man", "emotion": "neutral", "language": "French", "speed": 1.0, "loop": false}')}
— MiniMax Speech sur fal (payant, quelques secondes). Rejouée depuis le début à chaque survol ({code("loop: false")}).</li>
<li>{code('{"mode": "music", "preset", "extra"}')} : deuxième musique (Music 3, local). {code('{"mode": "file"}')} : ton fichier.</li></ul>
{voices}
<p>Émotions : {", ".join(code(x) for x in presets.EMOTIONS)}. Langues : {", ".join(code(x) for x in presets.LANGUAGES)}.</p>
<h3>Bruitages ({code("foley")})</h3>
{foleys}
<p>{code('{"on": true, "engine": "h3"}')} est gratuit : la piste son que H3 calcule avec chaque vidéo, extraite à l'export
(il faut une vidéo rendue après le 13/10/2026). Les moteurs cloud refusent les descriptions jugées sensibles
(filtre de contenu de fal) : reste factuel, ou laisse {code("prompt")} vide.</p>
<h3>Son global de la page ({code("pageSound")})</h3>
<p>Joue en continu, baisse de moitié quand une case joue ses sons, fondu entre les pages d'un livre. Régler par
{code('POST /projects/<id>/update {"pageSound": {"mode": "generate", "preset": "suspense", "extra": "…", "seconds": 60, "volume": 0.6}}')}
puis {code("POST /projects/<id>/pagesound")} pour le générer, ou envoyer un fichier par
{code("POST /projects/<id>/upload?kind=page&name=x.mp3")} (corps = octets du fichier).</p>
</section>

<section id="api"><h2><span class="n">7</span>Référence de l'API</h2>
<p>Corps et réponses en JSON, sauf les envois de fichiers (corps = octets bruts). Erreur : statut 4xx/5xx et {code('{"error": "…"}')}.</p>
<h3>Planches</h3>
<pre><code>GET    /api/projects                              liste [{{id, name, updated, panels, thumb}}]
POST   /api/projects {{"name", "format": "bd", "orientation": "portrait|paysage", "preset": "hmb"}}
                                                  cree la planche + compose ; renvoie le projet (avec geometry)
       (option : "preset": "random:6", "tilt": 0.06, "seed": 42 ; ou "page" + "layout" complets)
GET    /api/projects/&lt;id&gt;                         le projet complet
GET    /api/projects/&lt;id&gt;/rev                     {{"rev", "updated"}}
POST   /api/projects/&lt;id&gt;/update {{"name", "style", "page": {{…}}, "pageSound": {{…}}, "layout": {{…}}}}
                                                  regle la planche (cles fournies seulement) ; "page" fusionne,
                                                  "format"/"orientation" recalculent la taille ; "layout" remplace
DELETE /api/projects/&lt;id&gt;                         vers la corbeille (projects/_corbeille)</code></pre>
<h3>Cases</h3>
<pre><code>POST /api/projects/&lt;id&gt;/panels/&lt;case&gt;/image?name=photo.png    corps = octets de l'image
        -> {{"file", "w", "h"}} ; la case recoit l'image, recadrage remis a zero
POST /api/projects/&lt;id&gt;/panels/&lt;case&gt;/sound?layer=audio|voice&name=x.mp3   corps = octets du son
POST /api/projects/&lt;id&gt;/panels/&lt;case&gt; {{"camera": {{…}}, "action": {{…}}, "audio": {{…}}, "voice": {{…}},
                                          "foley": {{…}}, "seed": 123, "view": {{"zoom", "ox", "oy"}}}}
        chaque cle fournie REMPLACE l'objet entier (envoie camera et action complets) ;
        pour audio/voice/foley, le fichier deja genere est garde si le mode ne change pas</code></pre>
<h3>Composer, vérifier, rendre</h3>
<pre><code>POST /api/projects/&lt;id&gt;/compose {{"panels": ["p2"]?}}   images de depart (taille H3) + page.jpg + frames.png + vignette
        -> {{"panels": [{{"id","order","has_image","rect"}}], "start_images": [{{"id","order","size"}}]}}
        A refaire apres chaque changement d'image, de recadrage ou de decoupage (render le fait si une image manque).
POST /api/plan {{"panel": {{case}}, "style": "…"}}    -> {{"player", "autoplay", "loop", "jobs": [{{side, mode, lora, length, full_prompt}}], "warning"}}
POST /api/projects/&lt;id&gt;/estimate {{"panels": [...]}}  -> nombre de videos, secondes, cout fal estime
POST /api/projects/&lt;id&gt;/render {{"panels": ["p1","p3"], "target": "local", "machines": ["HITCHCOCK","FORD"]|null,
                                 "seeds": {{"p1": 904232}}}}
        -> {{"jobs": [...], "errors": [...]}} ; cree aussi les sons a generer (audio, voice, foley cloud) de ces cases
POST /api/projects/&lt;id&gt;/audio/&lt;case&gt;  | /voice/&lt;case&gt; | /foley/&lt;case&gt; | /pagesound   (un son seul, {{"seed": n}} optionnel)
GET  /api/jobs?project=&lt;id&gt;              [{{id, panel, side, kind, status: queued|running|done|error|cancelled, worker, progress, output, error}}]
POST /api/jobs/&lt;job&gt;/cancel            annuler
POST /api/projects/&lt;id&gt;/choose {{"panel": "p3", "side": "V|L|R", "file": "renders/p3/…mp4"}}   choisir une variante
        (sons : side "A" son 1, "B" son 2, "F" bruitages ; son global : panel "_page", side "P")</code></pre>
<h3>Retouches (mode édition, voir 9 bis)</h3>
<pre><code>POST /api/projects/&lt;id&gt;/edit/&lt;case&gt; {{"edit": {{…}}, "volumes": {{"audio": 0.6, "voice": 1, "foley": 0.8}},
                                    "extra": [{{"file", "volume", "loop"}}], "pageVolume": 0.5}}
        enregistre (cles fournies seulement ; "edit" remplace l'objet entier) puis remet l'export a jour (rapide)
        -> {{"page": donnees de la page exportee, "encoded": [cases re-encodees], "project": {{…}}}}
        case "_" : seulement la page (pageVolume) ou juste remettre l'export a jour
POST /api/projects/&lt;id&gt;/panels/&lt;case&gt;/sound?layer=extra&name=x.mp3    son AJOUTE (par-dessus les autres)
POST /api/projects/&lt;id&gt;/regen/&lt;case&gt; {{"instruction": "en francais", "prompts": {{"V": "anglais"}}?, "sameSeed": true,
                                     "target": "local"}}   regenerer la video (l'IA integree reecrit le prompt si
        "instruction" ; sinon "prompts" tel quel) -> {{"jobs", "prompts", "seed"}} ; le prompt est garde
        dans panel.prompt_override (il remplace celui des menus pour cette case)
POST /api/projects/&lt;id&gt;/regensound/&lt;case&gt; {{"layer": "audio|voice|foley|page", "text": "…", "sameSeed": false}}</code></pre>
<h3>Relief (voir 9 ter)</h3>
<pre><code>POST /api/projects/&lt;id&gt;/edit/&lt;case&gt; {{"treatment": "relief"|"h3"}}      changer le traitement d'une case
POST /api/projects/&lt;id&gt;/edit/&lt;case&gt; {{"relief": {{"preset", "amount", "focus", "duration", "trigger"}}}}
POST /api/projects/&lt;id&gt;/depth/&lt;case&gt; {{"force": true}}   carte de profondeur (~1 s, sur ce PC) -> {{"file", "seconds"}}
POST /api/projects/&lt;id&gt;/render  sur une case en relief : calcule la carte (reponse "relief": [cases]) et les sons, aucune video ;
        met aussi en file ses COUCHES (sauf case verte, couches deja calculees, ou aucune machine avec Qwen-Image-Edit)
GET  /api/projects/&lt;id&gt;/layers/&lt;case&gt;          etat des couches -> {{"meta": {{"n", "z", "focus", "reason"…}}, "job", "possible"}}
POST /api/projects/&lt;id&gt;/layers/&lt;case&gt; {{}}       (re)calculer les couches (autre graine a chaque relance), ~45 s a chaud
POST /api/projects/&lt;id&gt;/edit/&lt;case&gt; {{"couches": false}}   garder la nappe simple (true : utiliser les couches)</code></pre>
<h3>Exporter, publier</h3>
<pre><code>POST /api/projects/&lt;id&gt;/export     -> {{"url": "/projects/&lt;id&gt;/export/index.html", "report": [...], "cached": bool}}
        page jouable dans projects/&lt;id&gt;/export/ (index.html, videos/, sons/) ; instantane si rien n'a change
POST /api/projects/&lt;id&gt;/publish {{"name": "mon-titre"}}  -> {{"url": "https://alive-comics.placenta.tv/mon-titre/"}}
GET  /api/books ; PUT /api/books [{{"id", "title", "pages": ["&lt;planche&gt;", …]}}]
POST /api/books/&lt;livre&gt;/export | /publish        livre de plusieurs planches (feuilletage page a page)
POST /api/projects/&lt;id&gt;/reveal                   ouvre le dossier de la page dans l'Explorateur (sur le PC de David)</code></pre>
</section>

<section id="recette"><h2><span class="n">8</span>La recette, du thème à la page</h2>
<ol>
<li><b>Lire le thème et regarder les images</b> fournies (tu peux les ouvrir : formats, sujets, cadrages). Imaginer l'histoire en
N cases, l'ordre de lecture, la case forte (la plus grande), le ton sonore.</li>
<li><b>Vérifier les machines</b> : {code("GET /api/workers")} (au moins une avec {code("pf.video")}).</li>
<li><b>Créer la planche</b> : {code("POST /api/projects")} avec format, sens et un découpage dont le nombre de cases correspond aux images.
Lire {code("geometry.panels")} : trier par {code("order")}, noter la forme de chaque case ({code("rect")}).</li>
<li><b>Placer les images</b> : chaque image dans la case dont la forme lui convient (paysage dans une case large…), par
{code("/panels/<case>/image")}. Ajuster {code("view")} si le sujet est coupé (zoom 1–1,4, ox/oy ±0,2).</li>
<li><b>Régler chaque case</b> ({code("/panels/<case>")}) : caméra + action + champs (anglais), loop, rigid, extra ; sons.</li>
<li><b>Régler la page</b> ({code("/update")}) : {code("style")}, {code("pageSound")}, couleurs si besoin.</li>
<li><b>Composer</b> ({code("/compose")}) et <b>regarder</b> {code("projects/<id>/page/page.jpg")} et les {code("start/<case>.png")} (ce que H3 verra).</li>
<li><b>Relire les prompts</b> avec {code("/api/plan")} pour chaque case.</li>
<li><b>Lancer les rendus</b> ({code("/render")}, {code('target: "local"')}) : 3 à 11 min par vidéo, réparties sur les machines
(une machine occupée garde la tâche dans sa file). Un arc = 2 vidéos (L et R).</li>
<li><b>Suivre</b> {code("GET /api/jobs?project=<id>")} toutes les 30–60 s jusqu'à ce que tout soit {code("done")} ou {code("error")}.</li>
<li><b>Vérifier</b> chaque vidéo (section 9), relancer ce qui est raté avec une autre graine ou un autre réglage.</li>
<li><b>Exporter</b> ({code("/export")}) et donner à David le chemin {code("projects/<id>/export/index.html")} (ou l'URL locale
{code("http://127.0.0.1:8790/projects/<id>/export/index.html")}). Publier seulement s'il le demande.</li>
</ol>
</section>

<section id="enchainer"><h2><span class="n">8 bis</span>Plusieurs pages à la suite</h2>
<ul>
<li><b>Pas besoin d'attendre qu'une page soit finie</b> pour lancer la suivante : la file de rendus est commune à toutes les
planches. Prépare une page (création, images, réglages, {code("/compose")}, contrôle des prompts), lance son {code("/render")},
passe à la suivante. Les tâches s'empilent et se répartissent sur toutes les machines libres, dans l'ordre d'envoi.</li>
<li>Chaque machine enchaîne d'abord les <b>vidéos</b>, puis les <b>sons</b> (MiniMax Music 3) quand il n'y a plus de vidéo pour
elle : ça évite de recharger les modèles. Les ambiances arrivent donc plutôt en fin de file.</li>
<li>Suivi global : {code("GET /api/jobs")} (sans {code("project")}) ; par page : {code("GET /api/jobs?project=<id>")}.
Quand toutes les tâches d'une page sont {code("done")}, vérifie-la et exporte-la, même si les suivantes calculent encore.</li>
<li>N'exporte une page qu'après ses rendus : avant, ses cases resteraient des images fixes (l'export le signale dans
{code("report")} : « rendu manquant »).</li>
<li>Ordre de grandeur, 3 machines : une vidéo prend 4 à 11 min, un arc en compte deux. Une page de 6 cases ≈ 8 à 10 vidéos
≈ 20 à 30 min ; 10 pages ≈ 3 à 5 h de calcul, plus les sons. Pour aller plus vite, préfère les caméras à une seule vidéo
(plans animés, {code("demi_arc")}, {code("orbit360")}) aux {code("arc")}, {code("vertical")} et {code("travelling")} (deux vidéos).</li>
<li>La file survit à un redémarrage du serveur (les rendus en cours sont repris). Une erreur passagère de mémoire vidéo est
relancée une fois automatiquement, sur une autre machine si possible ; regarde quand même {code("errors")} à la fin.</li>
<li>Pour faire de la place dans la liste des tâches : {code('POST /api/jobs/clear {"project": "<id>"}')} (efface les terminées).</li>
</ul></section>

<section id="verifier"><h2><span class="n">9</span>Vérifier et corriger les rendus</h2>
<ul>
<li>Après chaque rendu, {code("GET /api/projects/<id>")} : {code("panels[case].renders")} liste toutes les variantes,
{code("chosen")} la vidéo utilisée (la plus récente par défaut).</li>
<li><b>Indice de mouvement</b> : chaque variante a un champ {code("motion")} (écart moyen entre images successives).
Repères mesurés : <b>moins de 0,3 = presque immobile</b> (à refaire si la case devait vivre : action plus forte, précisions
plus explicites, autre graine) ; 1,5 à 4,5 = une case qui bouge bien. Les cases « temps figé » pilotées au glisser
bougent par la caméra : leur indice est normalement entre 1 et 4.</li>
<li><b>Regarde les images</b> : extrais la première, celle du milieu et la dernière image avec ffmpeg et ouvre-les :
<pre><code>ffmpeg -v error -y -i projects/&lt;id&gt;/renders/p3/V_s904231_xxxx.mp4 \\
  -vf "select='eq(n\\,0)+eq(n\\,60)+eq(n\\,123)',scale=-1:240,tile=3x1" -frames:v 1 controle_p3.jpg</code></pre>
Pour un arc, contrôle L et R : leurs dernières images doivent montrer des côtés opposés. Le flux optique ne juge pas bien le
sens : fie-toi à ce que tu vois.</li>
<li>Défauts connus et remèdes :
<ul>
<li>les deux côtés d'un arc partent du même côté : décrire des arrivées plus différentes, ou passer en {code("demi_arc")} ;</li>
<li>l'objet pivote sur lui-même : {code("camera.rigid = true")} ;</li>
<li>quasiment rien ne bouge : angle plus grand ({code("amplitude: grand")}), action plus forte, ou autre graine ;</li>
<li>une vingtaine d'images presque noires (« volet noir ») : autre graine ;</li>
<li>plan animé presque figé ({code("motion")} &lt; 0,3) : les mots « slow », « tiny », « stays in place » freinent H3 ; écrire un
mouvement continu et visible (le preset {code("vie")} le fait depuis le 14/10/2026), ou passer en {code("nerveux")} ;</li>
<li>zoom au lieu d'un déplacement : {code("travelling")} écrit « a dolly in and not a zoom » (déjà dans le gabarit).</li>
</ul></li>
<li><b>Relancer</b> : {code('POST /panels/<case> {"seed": <graine+1>}')} puis {code("/render")} sur cette case ; ou
{code('"seeds": {"p3": 12345}')} dans {code("/render")}. Choisir ensuite la meilleure variante avec {code("/choose")}.</li>
</ul></section>

<section id="retouches"><h2><span class="n">9 bis</span>Retouches sans régénérer (mode édition)</h2>
<p>David retouche les cases dans l'aperçu (bouton « ✏️ Éditer » de la page exportée, servie par l'application). Tout ce qui
suit est appliqué <b>par le lecteur, en direct</b> : aucun ré-encodage, réversible. Tu peux le régler aussi par
{code("POST /api/projects/<id>/edit/<case>")} avec {code('{"edit": {...}}')} (l'objet remplace l'ancien : relis
{code("panels[case].edit")} d'abord et renvoie-le complété).</p>
{retouches}
<ul>
<li>Repères du tremblé : léger {{size 0.4, freq 0.2, rot 0.046}}, moyen {{0.8, 0.2, 0.092}}, fort {{1.3, 0.2, 0.143}},
nerveux {{0.9, 1.1, 0.2}}. Le tremblé suit l'image (il se fige quand la case se fige).</li>
<li><b>Raccord garanti</b> : le tremblé est calculé sur la position dans la boucle, avec un nombre <b>entier</b> de cycles
entre le début et la fin ({code("freq")} est arrondie à la boucle). Il est donc identique au in et au out, quels que soient
les réglages et les points de boucle. Le bouton « Adaptive loop » de l'éditeur cale {code("freq")} sur la valeur jouée.</li>
<li>Préréglages de tremblé de David (toutes planches) : {code("GET /api/userpresets")} ->
{code('{"shake": [{"name", "size", "freq", "rot"}]}')} ; {code('POST /api/userpresets {"kind": "shake", "name", "value"}')}
(ou {code('"delete": true')}). Un préréglage ne garde pas la graine : chaque case garde la sienne.</li>
<li><b>Suivi des cases</b> : en mode édition, une pastille en haut à droite de chaque case dit où en est David :
orange = à voir (défaut), vert = OK, rouge = à retoucher. C'est {code("panels[case].review")} ({code("null")}, {code('"ok"')}
ou {code('"redo"')}), réglable par {code('POST /edit/<case> {"review": "redo"}')}. Si David te demande de reprendre
un livre, commence par les cases {code('"redo"')} et ne touche pas aux {code('"ok"')}.</li>
<li>Depuis le 15/10/2026, le tremblé n'est plus incrusté dans la vidéo à l'export : les vidéos sont ré-encodées une fois sans
lui, puis le lecteur l'applique.</li>
<li>Le « fixe » qui casse une boucle est un <b>ralenti</b> : H3 freine sur les 10 à 20 dernières images (et les premières) pour
retomber sur l'image de départ. {code('"ease": {"head": 8, "tail": 16, "gain": 2}')} les joue plus vite, sans couper : la boucle reste
parfaite. (Couper avec {code("range")} + {code("xfade")} reste possible, mais le raccord se voit davantage.)</li>
<li>Sons : {code("volumes")} règle les couches existantes, {code("/sound?layer=extra")} ajoute un son par-dessus, {code("pageVolume")}
règle la musique de la page.</li>
<li><b>Pas de son en double</b> : tout import de son ({code("/upload?kind=audio|voice|page")}, {code("/panels/<case>/sound")}) est
reconnu par son contenu. S'il sert déjà dans une planche, la réponse est {code("409")} avec {code('{"duplicate": true, "used": [{"where": …}]}')} :
ne force ({code("&force=1")}) que si la réutilisation est voulue (ex. même musique sur tout un livre). S'il a déjà été importé sans
servir, le fichier existant est repris ({code('"reused": true')}).</li>
</ul></section>

<section id="relief"><h2><span class="n">9 ter</span>Relief : une photo en relief au lieu d'une vidéo</h2>
<p>Chaque case a un <b>traitement</b> : {code('"treatment": "h3"')} (défaut, vidéo MiniMax H3, ~7 min de GPU) ou
{code('"treatment": "relief"')} (photo en relief : une carte de profondeur calculée en ~1 s sur le processeur de ce PC par
Depth Anything V2 Small, licence Apache 2.0 ; aucune vidéo). Le lecteur bouge la caméra de quelques pour cent au survol ou
au clic, et suit le glisser. Une case H3 dont le rendu n'est pas encore là s'affiche en relief en attendant.</p>
<p><b>Relief en couches</b> (sans bords dédoublés) : « Calculer » découpe chaque case en relief en un fond reconstruit
(sans les personnages) et 1 ou 2 calques de personnages détourés, chacun avec sa profondeur, comme un livre pop-up.
Qwen-Image-Edit 2509 (Apache 2.0) sur une machine, ~45 s par case à chaud ; tâche « Couches relief » dans la file.
{code("meta.n")} = nombre de calques ; {code("n = 0")} avec {code("reason")} : la case ne se découpe pas (paysage, foule…),
elle garde la nappe simple. Marche le mieux avec 1 à 3 sujets bien séparés ; foules et gros plans (sujets sur environ la
moitié de la case ou plus) gardent la nappe simple : préférer une vidéo H3 pour ces cases. À contrôler dans l'aperçu (mode édition,
onglet Relief, vue « Calques »).</p>
<ul>
<li>Réglages : {code('panels[case].relief = {"preset": "respire|glisse|tourne|vertigo", "amount": 0.025, "focus": 0..1, "duration": 2, "trigger": "hover|click"}')}.
<code>focus</code> = plan net (profondeur qui ne bouge pas : la mettre sur les visages) ; sans elle, médiane du centre de la case.</li>
<li>Presets : respire (portraits, couples, détails), glisse (groupes, paysages), tourne (sujet central détaché), vertigo
(moments forts). Cheveux, voiles, vitres : rester sous 3 % d'amplitude.</li>
<li>Formule conseillée : relief partout, et un « biscuit » H3 (orbite 360 ou plan vivant en boucle) par page, dans la
grande case qui le mérite. Le réalisateur IA sait le faire (option « Relief partout + biscuits H3 »).</li>
<li>Couleurs ({code("edit.grade")}) et cadrage ({code("edit.frame")}) s'appliquent aussi au relief ; pas de tremblé.</li>
</ul>
<p>Le réalisateur IA lit à chaque demande la compétence <code>app/skills/boucles.md</code> (écrire des boucles parfaites,
tirée de <code>docs/BOUCLES-IA.html</code>) et ne touche jamais aux cases vertes.</p>
</section>

<section id="publier"><h2><span class="n">10</span>Exporter, publier, livres</h2>
<ul>
<li>{code("/export")} assemble la page jouable (vidéos tout-intra, sons égalisés, lecteur). Les cases sans vidéo restent des images.</li>
<li>{code("/publish")} l'envoie sur {code("https://alive-comics.placenta.tv/<nom>/")} (SSH, clé de ce poste déjà réglée) et
met à jour la page d'accueil. Nom : minuscules, chiffres, tirets.</li>
<li>Un <b>livre</b> enchaîne plusieurs planches : {code("PUT /api/books")} (lire d'abord {code("GET /api/books")} et ajouter ton
livre à la liste, sans effacer ceux de David), puis {code("/api/books/<id>/publish")}. Un livre d'une seule page n'a pas de flèches.</li>
</ul></section>

<section id="pieges"><h2><span class="n">11</span>Pièges connus</h2>
<ul>
<li>Les rendus sont longs : ne lance pas plus de cases que nécessaire, regroupe-les en un seul {code("/render")}.</li>
<li>Une case {code("fixe")} + {code("fige")} sans précisions ne produit aucune vidéo ({code("/render")} le signale dans {code("errors")}).</li>
<li>Après un changement d'image ou de découpage, recompose ({code("/compose")}) avant de rendre.</li>
<li>fal refuse parfois une description (filtre de contenu) : l'erreur l'explique, reformule plus factuellement.</li>
<li>Si une tâche est en {code("error")} avec « injoignable » : la machine est éteinte ; relance sans la préciser dans {code("machines")}.</li>
<li>Ne redémarre pas le serveur pendant des rendus sans nécessité (ils sont repris, mais l'interface de David perd la connexion un instant).</li>
</ul></section>

<section id="exemple"><h2><span class="n">12</span>Script complet d'exemple</h2>
<p>Thème « Le cirque englouti », quatre images fournies par David. À adapter : c'est toi qui écris les textes.</p>
<pre><code>import json, time, urllib.request
BASE = "http://127.0.0.1:8790/api"
def api(method, path, body=None, raw=None, timeout=600):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method,
        headers={{"Content-Type": "application/octet-stream" if raw is not None else "application/json"}})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")

assert any(w["pf"].get("video") for w in api("GET", "/workers")), "aucune machine prete"
p = api("POST", "/projects", {{"name": "Le cirque englouti", "format": "bd", "orientation": "portrait", "preset": "hmb"}})
pid = p["id"]
cases = [g["id"] for g in sorted(p["geometry"]["panels"], key=lambda g: g["order"])]   # ordre de lecture

images = [r"D:\\theme\\chapiteau.png", r"D:\\theme\\clown.png", r"D:\\theme\\acrobate.png", r"D:\\theme\\poissons.png"]
for case, path in zip(cases, images):
    api("POST", f"/projects/{{pid}}/panels/{{case}}/image?name=" + path.split("\\\\")[-1], raw=open(path, "rb").read())

api("POST", f"/projects/{{pid}}/panels/{{cases[0]}}", {{
    "camera": {{"id": "travelling", "fields": {{"subject": "the sunken circus tent",
               "close": "a close view of the torn striped canvas swaying in the current",
               "wide": "the whole tent half buried in the sand of the sea floor"}}}},
    "action": {{"id": "fige", "fields": {{}}}},
    "audio": {{"mode": "generate", "preset": "drone_inquietant", "extra": "underwater hum, distant fairground organ", "seconds": 30}}}})
api("POST", f"/projects/{{pid}}/panels/{{cases[1]}}", {{
    "camera": {{"id": "epaule", "fields": {{}}}},
    "action": {{"id": "vie", "fields": {{"subject": "the drowned clown"}}, "loop": True,
               "extra": "his hair and ruffled collar float slowly in the water, tiny bubbles rise from his smile"}},
    "voice": {{"mode": "tts", "text": "Depuis cent ans, le clown attend que le spectacle reprenne.",
              "voice_id": "Deep_Voice_Man", "emotion": "sad", "language": "French"}},
    "foley": {{"on": True, "engine": "h3"}}}})
# … cases[2], cases[3] de la meme facon …
api("POST", f"/projects/{{pid}}/update", {{"style": "Murky green underwater light, 1970s film grain.",
    "pageSound": {{"mode": "generate", "preset": "suspense", "extra": "slow waltz on a detuned music box", "seconds": 60, "volume": 0.6}}}})

api("POST", f"/projects/{{pid}}/compose", {{}})
for case in cases:
    plan = api("POST", "/plan", {{"panel": api("GET", f"/projects/{{pid}}")["panels"][case], "style": ""}})
    print(case, plan["player"], [j["full_prompt"][:100] for j in plan["jobs"]])

r = api("POST", f"/projects/{{pid}}/render", {{"panels": cases, "target": "local"}})
print(len(r["jobs"]), "taches", r["errors"])
api("POST", f"/projects/{{pid}}/pagesound", {{}})
while True:
    jobs = api("GET", f"/jobs?project={{pid}}")
    left = [j for j in jobs if j["status"] in ("queued", "running")]
    if not left: break
    time.sleep(45)
print([ (j["panel"], j["side"], j["status"], j["error"][:80]) for j in jobs if j["status"] != "done"])
# … regarder les videos (section 9), relancer si besoin …
print(api("POST", f"/projects/{{pid}}/export"))</code></pre>
</section>
<p style="color:var(--muted)">Généré par {code("tools/make_pilot_doc.py")} à partir du code d'Alive-Comics (catalogue à jour). Base de
connaissances complète sur MiniMax H3 : {code("ALIVE-COMICS-CONNAISSANCES.html")}.</p>
</div>
</body>
</html>
"""


def main():
    out = ROOT / "docs" / "PILOTAGE-CLAUDE.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(PAGE, encoding="utf-8")
    print("ecrit :", out)


if __name__ == "__main__":
    main()
