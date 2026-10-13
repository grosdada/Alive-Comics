"""File de rendus : repartit les videos et les sons sur les ComfyUI du reseau et/ou sur fal.

- Un fil par worker ComfyUI : il prend la prochaine tache compatible quand il est libre. Si sa file
  ComfyUI est deja occupee par d'autres (Q-Builder…) et qu'un autre worker est libre, il laisse passer ;
  sinon la tache attend dans SA file ComfyUI (« en queue de job »).
- Un groupe de fils pour fal (concurrence reglable).
- Cible par tache : "local", "fal" ou "auto" (local d'abord, fal si personne ne l'a prise apres 2 min).
- Les taches sont gardees dans data/jobs.json : apres un redemarrage, celles qui tournaient sont
  reprises la ou elles en etaient (prompt_id ComfyUI ou requete fal).
"""

import json
import secrets
import struct
import threading
import time
import traceback
from pathlib import Path

from . import comfy, falapi, presets, settings, store

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
JOBS_FILE = DATA / "jobs.json"
AUTO_FAL_AFTER = 120          # s d'attente avant qu'une tache « auto » parte sur fal
POLL_COMFY = 4
POLL_FAL = 5


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("image de depart : PNG attendu")
    return struct.unpack(">II", head[16:24])


def full_prompt(mode, text):
    if mode == "orbit":
        return " ".join(t for t in (presets.ORBIT_PROMPT, text) if t)
    if mode == "path":
        return " ".join(t for t in (presets.FROZEN_PROMPT, text) if t)
    return text


class Scheduler:
    def __init__(self):
        self.lock = threading.RLock()
        self.save_lock = threading.Lock()
        self.jobs = {}
        self.workers = {}            # nom -> {"name", "url", "enabled", "pf": preflight, "job": id, "last_kind"}
        self.cancel_flags = set()
        self.running = True
        self._dirty = False
        self._fal_threads = []
        self._load()

    # ------------------------------------------------------------ etat
    def _load(self):
        if JOBS_FILE.exists():
            try:
                for j in json.loads(JOBS_FILE.read_text(encoding="utf-8")):
                    self.jobs[j["id"]] = j
            except (OSError, ValueError):
                pass

    def _save(self):
        DATA.mkdir(exist_ok=True)
        with self.lock:
            data = json.dumps(list(self.jobs.values())[-500:], ensure_ascii=False)
        with self.save_lock:                      # un seul ecrivain a la fois (Windows refuse les remplacements croises)
            tmp = JOBS_FILE.with_suffix(".tmp")
            for attempt in range(5):
                try:
                    tmp.write_text(data, encoding="utf-8")
                    tmp.replace(JOBS_FILE)
                    return
                except PermissionError:          # fichier lu au meme instant (antivirus, sauvegarde…)
                    time.sleep(0.1 * (attempt + 1))

    def _set(self, job, **kw):
        with self.lock:
            job.update(kw)
        self._save()

    def list(self, project=None):
        with self.lock:
            out = [dict(j) for j in self.jobs.values() if not project or j["project"] == project]
        for j in out:
            j.pop("spec_private", None)
        return out

    def workers_status(self):
        with self.lock:
            return [{k: w[k] for k in ("name", "url", "enabled", "pf", "job")} for w in self.workers.values()]

    # ------------------------------------------------------------ demarrage
    def start(self):
        threading.Thread(target=self._preflight_loop, daemon=True).start()
        self.refresh_workers()
        cfg = settings.load()
        for i in range(max(1, int(cfg["fal"].get("concurrency", 4)))):
            t = threading.Thread(target=self._fal_loop, daemon=True, name=f"fal-{i}")
            t.start()
            self._fal_threads.append(t)
        # reprise des taches interrompues par un redemarrage
        with self.lock:
            for j in self.jobs.values():
                if j["status"] == "running":
                    if j.get("handle"):
                        w = self.workers.get(j.get("worker") or "")
                        if w:
                            w["job"], w["last_kind"] = j["id"], j["kind"]
                        threading.Thread(target=self._resume, args=(j,), daemon=True).start()
                    else:
                        j.update(status="queued", worker=None)

    def refresh_workers(self):
        cfg = settings.load()
        with self.lock:
            for w in cfg["workers"]:
                if not w.get("url"):
                    continue
                cur = self.workers.get(w["name"])
                if cur:
                    cur.update(url=w["url"], enabled=bool(w.get("enabled", True)))
                    continue
                self.workers[w["name"]] = {"name": w["name"], "url": w["url"], "enabled": bool(w.get("enabled", True)),
                                           "pf": {"online": False, "missing": ["vérification…"]}, "job": None,
                                           "last_kind": None}
                threading.Thread(target=self._worker_loop, args=(w["name"],), daemon=True,
                                 name="worker-" + w["name"]).start()
            names = {w["name"] for w in cfg["workers"]}
            for name, w in self.workers.items():
                if name not in names:
                    w["enabled"] = False

    def _preflight_loop(self):
        while self.running:
            with self.lock:
                ws = list(self.workers.values())
            for w in ws:
                if w["enabled"]:
                    pf = comfy.preflight(w["url"])
                    with self.lock:
                        w["pf"] = pf
            time.sleep(30)

    # ------------------------------------------------------------ mise en file
    def enqueue_panel(self, project_id, panel_id, target="local", machines=None, seed=None):
        p = store.get(project_id)
        panel = p["panels"].get(panel_id)
        if not panel:
            raise KeyError(panel_id)
        start = store.path(project_id, f"start/{panel_id}.png")
        if not start.exists():
            raise FileNotFoundError("image de depart manquante pour " + panel_id)
        w, h = png_size(start)
        plan = presets.plan_panel(panel, p.get("style", ""))
        base_seed = int(seed if seed is not None else panel.get("seed") or settings.load()["render"]["seed"])
        created = []
        for spec in plan["jobs"]:
            spec = dict(spec, seed=base_seed, megapixels=w * h / 1048576, start=f"start/{panel_id}.png",
                        width=w, height=h)
            spec["full_prompt"] = full_prompt(spec["mode"], spec["prompt"])
            created.append(self._add(project_id, panel_id, spec["side"], "video", target, machines, spec))
        aud = panel.get("audio") or {}
        if aud.get("mode") == "generate" and not aud.get("file") and aud.get("auto", True):
            created += self.enqueue_audio(project_id, panel_id, machines)
        return created

    def enqueue_audio(self, project_id, panel_id, machines=None, seed=None):
        p = store.get(project_id)
        aud = (p["panels"].get(panel_id) or {}).get("audio") or {}
        caption = aud.get("caption") or presets.audio_caption(aud.get("preset") or "drone_inquietant", aud.get("extra", ""))
        spec = {"side": "A", "caption": caption, "lyrics": presets.INSTRUMENTAL_LYRICS,
                "seconds": int(aud.get("seconds") or 30),
                "seed": int(seed if seed is not None else aud.get("seed") or 20261013)}
        return [self._add(project_id, panel_id, "A", "audio", "local", machines, spec)]

    def _add(self, project_id, panel_id, side, kind, target, machines, spec):
        job = {"id": secrets.token_hex(5), "project": project_id, "panel": panel_id, "side": side, "kind": kind,
               "target": target if kind == "video" else "local", "machines": machines or None, "status": "queued",
               "worker": None, "created": time.time(), "started": None, "finished": None, "error": "",
               "output": None, "spec": spec, "handle": None, "progress": ""}
        with self.lock:
            self.jobs[job["id"]] = job
        self._save()
        return dict(job)

    def cancel(self, job_id):
        with self.lock:
            j = self.jobs.get(job_id)
            if not j:
                return False
            if j["status"] == "queued":
                j.update(status="cancelled", finished=time.time())
            elif j["status"] == "running":
                self.cancel_flags.add(job_id)
        self._save()
        return True

    def clear_finished(self, project=None):
        with self.lock:
            for jid in [k for k, j in self.jobs.items() if j["status"] in ("done", "cancelled", "error")
                        and (not project or j["project"] == project)]:
                del self.jobs[jid]
        self._save()

    def estimate(self, project_id, panel_ids):
        """Secondes de video a calculer et cout fal estime."""
        p = store.get(project_id)
        secs_local, secs_fal = 0.0, 0
        for pid in panel_ids:
            plan = presets.plan_panel(p["panels"].get(pid) or {}, p.get("style", ""))
            for spec in plan["jobs"]:
                secs_local += spec["length"] / 24
                secs_fal += falapi.seconds_for(spec["length"])
        price = float(settings.load()["fal"].get("price_per_second", 0.08))
        return {"videos": sum(len(presets.plan_panel(p["panels"].get(x) or {}, "")["jobs"]) for x in panel_ids),
                "seconds_local": round(secs_local, 1), "seconds_fal": secs_fal,
                "fal_cost": round(secs_fal * price, 2), "price_per_second": price}

    # ------------------------------------------------------------ choix d'une tache
    def _pick_local(self, w):
        with self.lock:
            pf = w["pf"] or {}
            if not w["enabled"] or not pf.get("online") or w["job"]:
                return None                       # w["job"] : une tache reprise apres redemarrage tourne deja
            others_free = [o for o in self.workers.values() if o is not w and o["enabled"] and not o["job"]
                           and (o["pf"] or {}).get("online") and (o["pf"] or {}).get("load", 0) == 0]
            cands = []
            for j in self.jobs.values():
                if j["status"] != "queued" or j["target"] not in ("local", "auto"):
                    continue
                if j["machines"] and w["name"] not in j["machines"]:
                    continue
                if (j["kind"] == "video" and not pf.get("video")) or (j["kind"] == "audio" and not pf.get("music")):
                    continue
                if pf.get("load", 0) > 0 and any(
                        (not j["machines"] or o["name"] in j["machines"])
                        and (o["pf"].get("video") if j["kind"] == "video" else o["pf"].get("music"))
                        for o in others_free):
                    continue          # un autre worker est libre : lui laisser
                cands.append(j)
            if not cands:
                return None
            # meme type de modele que le precedent d'abord (evite de recharger H3 / Music 3)
            cands.sort(key=lambda j: (j["kind"] != (w["last_kind"] or "video"), j["created"]))
            j = cands[0]
            j.update(status="running", worker=w["name"], started=time.time(), progress="envoi")
            w["job"], w["last_kind"] = j["id"], j["kind"]
        self._save()
        return j

    def _pick_fal(self):
        cfg = settings.load()
        if not cfg["fal"].get("key"):
            return None
        now = time.time()
        with self.lock:
            for j in self.jobs.values():
                if j["status"] != "queued" or j["kind"] != "video":
                    continue
                if j["target"] == "fal" or (j["target"] == "auto" and now - j["created"] > AUTO_FAL_AFTER):
                    j.update(status="running", worker="fal", started=now, progress="envoi")
                    self._save()
                    return j
        return None

    # ------------------------------------------------------------ boucles
    def _worker_loop(self, name):
        while self.running:                   # le fil ne doit jamais mourir : tout est rattrape
            job = None
            try:
                w = self.workers.get(name)
                if not w:
                    return
                job = self._pick_local(w)
                if not job:
                    time.sleep(2)
                    continue
                self._run_comfy(w, job)
            except Exception as exc:          # noqa: BLE001 - toute erreur doit finir dans la tache
                traceback.print_exc()
                if job:
                    self._fail(job, exc)
                else:
                    time.sleep(5)
            finally:
                if job:
                    with self.lock:
                        if self.workers.get(name):
                            self.workers[name]["job"] = None
                        self.cancel_flags.discard(job["id"])

    def _fal_loop(self):
        while self.running:
            job = None
            try:
                job = self._pick_fal()
                if not job:
                    time.sleep(3)
                    continue
                self._run_fal(job)
            except Exception as exc:          # noqa: BLE001
                traceback.print_exc()
                if job:
                    self._fail(job, exc)
                else:
                    time.sleep(5)
            finally:
                if job:
                    self.cancel_flags.discard(job["id"])

    def _fail(self, job, exc):
        try:
            self._set(job, status="error", error=str(exc)[:1500], finished=time.time())
        except Exception:                     # noqa: BLE001
            traceback.print_exc()

    # ------------------------------------------------------------ execution ComfyUI
    def _run_comfy(self, w, job):
        spec, pid = job["spec"], job["project"]
        sub = f"alivecomics/{pid}"
        prefix = f"AliveComics/{pid}/{job['panel']}_{job['side']}"
        if job["kind"] == "video":
            names = {"start": comfy.upload(w["url"], store.path(pid, spec["start"]), sub)}
            for kind in ("character", "set"):
                names[kind] = [comfy.upload(w["url"], store.path(pid, r), sub) for r in (spec.get("refs") or {}).get(kind, [])]
            steps = settings.load()["render"].get("steps", 28)
            graph = comfy.h3_graph(spec, names, prefix, steps)
        else:
            graph = comfy.music_graph(spec["caption"], spec["lyrics"], spec["seed"], spec["seconds"], prefix)
        prompt_id = comfy.submit(w["url"], graph)
        self._set(job, handle={"type": "comfy", "server": w["url"], "prompt_id": prompt_id}, progress="calcul")
        self._wait_comfy(job)

    def _wait_comfy(self, job):
        h = job["handle"]
        t0 = time.time()
        while True:
            if job["id"] in self.cancel_flags:
                comfy.cancel(h["server"], h["prompt_id"])
                self._set(job, status="cancelled", finished=time.time())
                return
            entry = comfy.poll(h["server"], h["prompt_id"])
            if entry:
                break
            self._set(job, progress="calcul %d s" % (time.time() - t0)) if int(time.time() - t0) % 20 < POLL_COMFY else None
            time.sleep(POLL_COMFY)
        exts = (".mp4", ".webm", ".mov") if job["kind"] == "video" else (".mp3", ".flac", ".wav", ".ogg")
        items = list(comfy.outputs(entry, exts))
        if not items:
            raise comfy.ComfyError("aucune sortie trouvee dans l'historique")
        dest = self._dest(job, Path(items[0]["filename"]).suffix)
        comfy.download(h["server"], items[0], dest)
        self._finish(job, dest)

    # ------------------------------------------------------------ execution fal
    def _run_fal(self, job):
        cfg = settings.load()["fal"]
        spec = job["spec"]
        endpoint, body = falapi.payload(spec, store.path(job["project"], spec["start"]), cfg.get("resolution", "768P"))
        handle = falapi.submit(cfg["key"], endpoint, body)
        self._set(job, handle=dict(handle, type="fal"), progress="file fal")
        self._wait_fal(job)

    def _wait_fal(self, job):
        key = settings.load()["fal"]["key"]
        t0 = time.time()
        while True:
            if job["id"] in self.cancel_flags:
                falapi.cancel(key, job["handle"])
                self._set(job, status="cancelled", finished=time.time())
                return
            res = falapi.poll(key, job["handle"])
            if res:
                break
            self._set(job, progress="fal %d s" % (time.time() - t0)) if int(time.time() - t0) % 20 < POLL_FAL else None
            time.sleep(POLL_FAL)
        dest = self._dest(job, ".mp4")
        falapi.download(res["video"]["url"], dest)
        self._finish(job, dest)

    def _resume(self, job):
        try:
            if job["handle"].get("type") == "fal":
                self._wait_fal(job)
            else:
                self._wait_comfy(job)
        except Exception as exc:              # noqa: BLE001
            self._fail(job, RuntimeError("reprise : " + str(exc)[:1400]))
        finally:
            with self.lock:
                w = self.workers.get(job.get("worker") or "")
                if w and w["job"] == job["id"]:
                    w["job"] = None

    # ------------------------------------------------------------ resultat
    def _dest(self, job, ext):
        spec = job["spec"]
        name = f"{job['side']}_s{spec['seed']}_{job['id']}{ext}"
        return store.path(job["project"], f"renders/{job['panel']}/{name}")

    def _finish(self, job, dest):
        rel = dest.relative_to(store.pdir(job["project"])).as_posix()
        secs = round(time.time() - (job["started"] or time.time()), 1)

        def record(p):
            panel = p["panels"].setdefault(job["panel"], {})
            if job["kind"] == "audio":
                aud = panel.setdefault("audio", {})
                aud.setdefault("generated", []).append({"file": rel, "seed": job["spec"]["seed"], "job": job["id"]})
                aud["file"] = rel
                return
            entry = {"file": rel, "side": job["side"], "seed": job["spec"]["seed"], "job": job["id"],
                     "worker": job["worker"], "seconds": secs, "prompt": job["spec"]["prompt"],
                     "camera": (panel.get("camera") or {}).get("id"), "action": (panel.get("action") or {}).get("id"),
                     "created": time.time()}
            panel.setdefault("renders", []).append(entry)
            panel.setdefault("chosen", {})[job["side"]] = rel

        store.mutate(job["project"], record)
        self._set(job, status="done", output=rel, finished=time.time(), progress="")


SCHEDULER = Scheduler()
