/* Alive-Comics : mode edition de l'apercu.
 *
 * Charge par book.html seulement quand la page est servie par l'application (jamais en ligne).
 * « ✏️ Éditer » puis clic sur une case : un popup de retouche, avec un apercu agrandi de la case.
 *   - timeline : points de boucle (debut / fin), image de depart, fondu au point de boucle, vitesse, sens,
 *     courbe de mouvement (les ralentis en rouge) et « lisser la boucle » (ralentis du debut et de la fin acceleres) ;
 *   - tremble (taille, frequence, rotation, graine), couleurs, cadrage : appliques en direct par le lecteur ;
 *   - sons : volumes, remplacer, regenerer, voix off IA, ajouter un son, musique de la page (un son deja utilise
 *     ailleurs declenche une alerte avec les references ; un son deja importe n'est jamais copie deux fois) ;
 *   - regenerer la sequence : consigne en francais (l'IA reecrit le prompt), meme graine ou non, versions.
 * Case en relief (carte de profondeur, sans video) : un popup dedie (mouvement, amplitude, plan net choisi d'un
 * clic dans l'apercu, duree, declenchement, voir / recalculer la carte), couleurs, cadrage, sons, et le passage
 * relief <-> video H3 dans les deux sens.
 * Relief en couches : l'onglet Relief montre l'etat des couches (fond sans les sujets + sujets detoures, calcules par
 * SAM 3.1 + Qwen-Image-Edit sur une machine), les lance ou les relance, et la vue « Calques » les montre en couleur.
 * Tout est enregistre au fil de l'eau dans le projet (panel.edit...) et l'export est remis a jour (rapide).
 */
(function () {
  "use strict";
  const C = window.AliveBookCtl, P = window.AlivePlayer;
  if (!C || !P) return;
  const KEYS = ["shake", "grade", "frame", "range", "xfade", "speed", "bounce", "start", "ease"];
  const SHAKES = {
    aucun: { size: 0, freq: 0.2, rot: 0 }, leger: { size: 0.4, freq: 0.2, rot: 0.046 },
    moyen: { size: 0.8, freq: 0.2, rot: 0.092 }, fort: { size: 1.3, freq: 0.2, rot: 0.143 },
    nerveux: { size: 0.9, freq: 1.1, rot: 0.2 },
  };
  const SHAKE_NAMES = { aucun: "Aucun", leger: "Léger", moyen: "Moyen", fort: "Fort", nerveux: "Nerveux" };
  let on = false, cur = null, pop = null, lastTab = "loop", userPos = null;
  const projects = new Map();          // projet -> json (rendus, sons, retouches enregistrees)
  const analyses = new Map();          // video -> {thumbs, motion}
  const prepared = {};                 // page -> promesse (export remis au format du mode edition)
  const clone = (o) => o == null ? o : JSON.parse(JSON.stringify(o));
  const fmt = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString("fr-FR");

  // ------------------------------------------------------------------ outils
  function h(sel, attrs, ...kids) {
    const m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const el = document.createElement(m[1] || "div");
    for (const part of (m[2] || "").match(/[.#][\w-]+/g) || []) {
      if (part[0] === ".") el.classList.add(part.slice(1)); else el.id = part.slice(1);
    }
    if (attrs != null && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k in el && !["list", "form"].includes(k)) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }
  async function api(url, body) {
    const r = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" },
                                                          body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch (_) { /* reponse vide */ }
    if (!r.ok) throw new Error(j.error || "erreur " + r.status);
    return j;
  }
  function toast(msg, ms) {
    const t = h("div.ae-toast", msg);
    document.body.append(t);
    setTimeout(() => t.classList.add("off"), ms || 3500);
    setTimeout(() => t.remove(), (ms || 3500) + 600);
  }
  let bannerEl = null;
  function banner(msg) {
    if (!msg) { if (bannerEl) bannerEl.remove(); bannerEl = null; return; }
    if (!bannerEl) { bannerEl = h("div.ae-banner"); document.body.append(bannerEl); }
    bannerEl.textContent = msg;
  }
  const once = (el, ev) => new Promise((res, rej) => {
    const ok = () => { el.removeEventListener("error", ko); res(); };
    const ko = () => { el.removeEventListener(ev, ok); rej(new Error("vidéo illisible")); };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener("error", ko, { once: true });
  });

  // ------------------------------------------------------------------ projet de chaque page
  let bookPages = null;
  async function projectOf(i) {
    const pg = C.B.pages[i];
    if (pg.project) return pg.project;
    if (C.kind === "project") return C.id;
    if (!bookPages) bookPages = ((await api("/api/books")).find(b => b.id === C.id) || {}).pages || [];
    return bookPages[i];
  }
  async function project(pid, fresh) {
    if (fresh || !projects.has(pid)) projects.set(pid, await api(`/api/projects/${pid}`));
    return projects.get(pid);
  }

  // enregistre (retouches, volumes...) puis remet l'export a jour ; une requete a la fois, dans l'ordre
  let chain = Promise.resolve();
  function saveEdit(i, panelId, body, opts) {
    opts = opts || {};
    const run = async () => {
      const pid = await projectOf(i);
      const payload = Object.keys(body).length ? body : { refresh: 1 };      // corps vide = remonter l'export
      const res = await api(`/api/projects/${pid}/edit/${panelId}`, Object.assign({}, payload, C.kind === "book" ? { book: C.id } : {}));
      projects.set(pid, res.project);
      const pg = C.B.pages[i], old = pg.data;
      pg.data = res.page;
      const stamp = String(Date.now());
      const encoded = new Set(res.encoded || []);
      if (encoded.size || opts.sounds || opts.video || opts.relief) pg.stamp = stamp;      // fichiers changes : anti-cache
      if (cur && cur.pid === pid) { cur.project = res.project; cur.panel = res.project.panels[cur.id] || {}; }
      if (i !== C.cur() || opts.noApply) {
        return Object.assign(res, { changed: encoded.size > 0 || JSON.stringify(old) !== JSON.stringify(res.page) });
      }
      const inst = C.inst();
      let remount = false;
      for (const e of res.page.panels) {
        const st = inst.panels.find(s => s.p.id === e.id);
        const isRelief = !!e.depth && !e.video;
        if (st && !!st.relief !== isRelief) { remount = true; continue; }    // relief <-> video : on remonte la page
        if (st && st.relief) {
          if (opts.sounds === e.id || opts.relief === e.id) P.updateRelief(st, e, stamp);
          if (cur && cur.st === st && opts.sounds === e.id) renderTab();
          continue;
        }
        const video = encoded.has(e.id) || opts.video === e.id, sounds = opts.sounds === e.id;
        if (!video && !sounds) continue;
        if (!st || !e.video) { remount = remount || !!e.video; continue; }
        P.updatePanel(st, e, stamp, !video);
        if (cur && cur.st === st) {
          if (video) { delete cur.fx.range; delete cur.fx.start; delete cur.fx.xfade; delete cur.fx.ease; }
          P.setFx(st, clone(cur.fx));
          if (video) loadTimeline();
          if (sounds) renderTab();
        }
      }
      if (remount) { close(); C.remount(stamp); }
      return res;
    };
    chain = chain.then(run, run);
    return chain;
  }

  // la premiere fois qu'une page passe en edition : export remis au format du mode edition (tremble dans le lecteur)
  function prepare(i) {
    if (!prepared[i]) {
      prepared[i] = (async () => {
        banner("Préparation de la page pour l'édition…");
        try {
          const res = await saveEdit(i, "_", {}, { noApply: true });
          if (res.changed && i === C.cur()) C.remount(C.B.pages[i].stamp);
        } finally { banner(null); }
      })().catch((e) => { prepared[i] = null; toast("⚠ " + e.message, 6000); throw e; });
    }
    return prepared[i];
  }

  // ------------------------------------------------------------------ mode edition
  function setMode(v) {
    on = !!v;
    C.button.setAttribute("aria-pressed", String(on));
    document.body.classList.toggle("ae-on", on);
    P.setEditHook(on ? pick : null);
    if (!on) { close(); banner(null); removeDots(); return; }
    const hint = document.getElementById("hint");
    if (hint) hint.classList.add("off");
    prepare(C.cur()).then(() => {
      renderDots();
      toast("Cliquez sur une case pour la retoucher. Pastille en haut à droite : à voir / OK / à retoucher.", 5000);
    }).catch(() => {});
  }
  C.button.addEventListener("click", () => setMode(!on));
  if (/[?&]edit=1\b/.test(location.search)) setTimeout(() => setMode(true), 300);     // ouvert depuis l'accueil : « Éditer »
  document.addEventListener("alive-page", (e) => {
    close();
    removeDots();
    if (on) prepare(e.detail.index).then(renderDots).catch(() => {});
  });

  // ------------------------------------------------------------------ pastilles de suivi : a voir / OK / a retoucher
  const REVIEW = { todo: ["#f2a33c", "À voir"], ok: ["#45b56a", "OK"], redo: ["#e0483e", "À retoucher"] };
  let dotsEl = null, menuEl = null, sumEl = null;
  const pidOf = {};                    // page -> projet
  const reviewOf = (pid, id) => (((projects.get(pid) || {}).panels || {})[id] || {}).review || "todo";

  async function renderDots() {
    removeDots();
    const i = C.cur(), inst = C.inst(), pg = C.B.pages[i];
    let pid;
    try { pid = await projectOf(i); await project(pid); } catch (_) { return; }
    if (!on || C.inst() !== inst) return;
    const [PW, PH] = pg.data.size;
    dotsEl = h("div.ae-dots");
    for (const e of pg.data.panels) {
      const pts = e.poly || [[e.rect[0], e.rect[1]], [e.rect[2], e.rect[1]], [e.rect[2], e.rect[3]], [e.rect[0], e.rect[3]]];
      const [x, y] = pts.reduce((m, q) => (q[0] - q[1] > m[0] - m[1] ? q : m));        // coin en haut a droite
      const d = h("button.ae-dot", { type: "button", dataset: { panel: e.id },
                                     style: { left: x / PW * 100 + "%", top: y / PH * 100 + "%" } });
      paintDot(d, reviewOf(pid, e.id));
      d.addEventListener("click", (ev) => { ev.stopPropagation(); reviewMenu(d, i, pid, e.id); });
      dotsEl.append(d);
    }
    inst.pageEl.append(dotsEl);
    summary();
  }
  function removeDots() {
    if (dotsEl) dotsEl.remove();
    dotsEl = null;
    closeMenu();
    if (sumEl) sumEl.hidden = true;
  }
  function paintDot(d, v) {
    d.dataset.v = v;
    d.title = `Case ${d.dataset.panel} : ${REVIEW[v][1]} (cliquer pour changer)`;
  }
  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
  }
  function reviewMenu(anchor, i, pid, id) {
    closeMenu();
    const r = anchor.getBoundingClientRect();
    menuEl = h("div.ae-revmenu", Object.entries(REVIEW).map(([v, [color, label]]) =>
      h("button" + (reviewOf(pid, id) === v ? ".on" : ""), { type: "button", on: { click: () => { closeMenu(); setReview(i, pid, id, v); } } },
        h("i", { style: { background: color } }), label)));
    document.body.append(menuEl);
    menuEl.style.left = Math.max(8, Math.min(innerWidth - menuEl.offsetWidth - 8, r.right - menuEl.offsetWidth)) + "px";
    menuEl.style.top = Math.min(innerHeight - menuEl.offsetHeight - 8, r.bottom + 6) + "px";
    const away = (e) => {
      if (menuEl && !menuEl.contains(e.target) && e.target !== anchor) { closeMenu(); document.removeEventListener("pointerdown", away, true); }
      if (!menuEl) document.removeEventListener("pointerdown", away, true);
    };
    document.addEventListener("pointerdown", away, true);
  }
  function setReview(i, pid, id, v) {
    const pj = projects.get(pid);
    if (pj && pj.panels[id]) pj.panels[id].review = v;
    for (const d of document.querySelectorAll(`.ae-dot[data-panel="${id}"]`)) paintDot(d, v);
    summary();
    saveEdit(i, id, { review: v }, { noApply: true }).catch((e) => toast("⚠ " + e.message));
  }
  // compteur : la page, et tout le livre
  async function summary() {
    if (!sumEl) {                         // a cote du titre
      sumEl = h("span.ae-sum", { title: "Suivi des cases : OK · à voir · à retoucher" });
      (document.getElementById("where") || C.button).after(sumEl);
    }
    const count = (k) => {
      const pid = pidOf[k];
      const n = { ok: 0, todo: 0, redo: 0 };
      const pj = pid ? projects.get(pid) : null;
      for (const e of C.B.pages[k].data.panels) n[pj ? reviewOf(pid, e.id) : "todo"]++;
      return n;
    };
    const chip = (n) => h("span", ["ok", "todo", "redo"].map(v => h("span.ae-n", { title: REVIEW[v][1] },
                                                                  h("i", { style: { background: REVIEW[v][0] } }), n[v])));
    const i = C.cur();
    pidOf[i] = await projectOf(i);
    sumEl.hidden = false;
    sumEl.textContent = "";
    sumEl.append(chip(count(i)));
    if (C.B.pages.length > 1) {
      try {
        await Promise.all(C.B.pages.map((_, k) => projectOf(k).then((pid) => { pidOf[k] = pid; return project(pid); })));
      } catch (_) { return; }
      const tot = { ok: 0, todo: 0, redo: 0 };
      C.B.pages.forEach((_, k) => { const n = count(k); for (const v in tot) tot[v] += n[v]; });
      sumEl.textContent = "";
      sumEl.append(h("small", "page"), chip(count(i)), h("small", "livre"), chip(tot));
    }
  }
  document.addEventListener("keydown", (e) => {
    const t = e.target instanceof Element ? e.target : document.body;
    if (e.key === "Escape" && cur && !t.closest("input, textarea, select")) close();
    // barre espace : lecture / pause de la case ouverte (sauf en tapant du texte)
    if (e.code === "Space" && cur && cur.togglePlay && !t.closest("textarea, select, input:not([type=range]):not([type=checkbox])")) {
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement && document.activeElement.closest(".ae-pop button")) document.activeElement.blur();
      cur.togglePlay();
    }
  }, true);

  // retour a l'accueil de l'application, et la planche affichee dans l'application
  (function nav() {
    const header = document.querySelector("header");
    if (!header) return;
    const home = h("a.ae-nav", { href: "/", title: "Accueil de l'application (planches et livres)" }, "🏠 Accueil");
    const open = h("a.ae-nav", { href: "/", title: "Ouvrir cette planche dans l'application" }, "✎ Planche");
    header.insertBefore(open, header.firstChild);
    header.insertBefore(home, open);
    const upd = () => projectOf(C.cur()).then((pid) => { if (pid) open.href = "/#p=" + pid; }).catch(() => {});
    document.addEventListener("alive-page", upd);
    upd();
  })();

  async function pick(st) {
    if (st.static) { toast("Image fixe : cette case n'a pas de vidéo (lui donner une action dans l'application)."); return; }
    try { await prepare(C.cur()); } catch (_) { return; }
    if (cur && cur.st === st) return;
    close();
    const i = C.cur();
    const pid = await projectOf(i);
    let pj;
    try { pj = await project(pid); } catch (e) { toast("⚠ " + e.message); return; }
    if (!st.el.isConnected) return;                    // la page a change entre-temps
    cur = { st, i, pid, id: st.p.id, project: pj, panel: pj.panels[st.p.id] || {}, fx: clone(st.p.fx || {}),
            fx0: clone(st.p.fx || {}), edit0: clone((pj.panels[st.p.id] || {}).edit || {}), touched: new Set(),
            pending: {}, timer: null, playing: true, sound: false };
    st.el.classList.add("ac-sel");
    P.setPinned(st, true);
    if (st.relief) {
      const d = st.p.depth || {};
      cur.relief = { preset: d.preset, amount: d.amount, focus: d.focus, duration: d.duration, trigger: d.trigger };
      cur.relief0 = clone(cur.relief);
      cur.relief0Saved = clone((pj.panels[st.p.id] || {}).relief || {});
      if (!["relief", "color", "frame", "sound", "treat"].includes(lastTab)) lastTab = "relief";
    } else if (["relief", "treat"].includes(lastTab)) lastTab = "loop";
    build();
  }

  function close() {
    if (!cur) return;
    flush();
    const c = cur;
    cur = null;
    P.setPinned(c.st, false);
    if (c.sound) P.setPanelSound(c.st, false);
    c.st.freeze = false; c.st.freeShake = false;
    if (c.view) P.removeView(c.st, c.view);
    if (c.rview) c.rview.remove();
    clearTimeout(c.layTimer);
    if (c.st.relief) P.reliefShowMap(c.st, false);
    c.st.el.classList.remove("ac-sel");
    cancelAnimationFrame(c.raf);
    if (pop) pop.remove();
    pop = null;
  }

  // ------------------------------------------------------------------ retouches
  function change(key, fn) {
    fn(cur.fx);
    cur.touched.add(key);
    P.setFx(cur.st, clone(cur.fx));
    queue({ edit: true });
    drawTimeline();
    if (cur.shakeInfo) cur.shakeInfo();
  }
  function editPayload(c) {
    const e = {};
    for (const k of KEYS) {
      if ((c.touched.has(k) || k in c.edit0) && c.fx[k] !== undefined) e[k] = c.fx[k];
    }
    return e;
  }
  function queue(part) {
    if (part.volumes) part.volumes = Object.assign({}, cur.pending.volumes, part.volumes);
    Object.assign(cur.pending, part);
    clearTimeout(cur.timer);
    status("…");
    cur.timer = setTimeout(flush, 700);
  }
  function flush() {
    const c = cur;
    if (!c || !Object.keys(c.pending).length) return;
    clearTimeout(c.timer);
    const body = {};
    if (c.pending.edit) body.edit = editPayload(c);
    if (c.pending.volumes) body.volumes = c.pending.volumes;
    if (c.pending.extra) body.extra = c.pending.extra;
    if (c.pending.pageVolume != null) body.pageVolume = c.pending.pageVolume;
    if (c.pending.relief) {                 // seulement les reglages choisis (deja enregistres ou touches ici)
      const keep = new Set([...Object.keys(c.relief0Saved || {}), ...(c.reliefTouched || [])]);
      body.relief = Object.fromEntries(Object.entries(c.relief).filter(([k, v]) => keep.has(k) && v != null));
    }
    const sounds = c.pending.extra ? c.id : null;      // son ajoute retire : reconstruire les couches
    c.pending = {};
    status("enregistrement…");
    saveEdit(c.i, c.id, body, { sounds }).then(() => { if (cur === c) status("✓ enregistré"); })
      .catch((e) => { if (cur === c) status("⚠ " + e.message, true); else toast("⚠ " + e.message); });
  }
  function status(msg, err) {
    if (!pop) return;
    const s = pop.querySelector(".ae-status");
    s.textContent = msg;
    s.classList.toggle("err", !!err);
  }
  function revert() {
    const c = cur;
    c.fx = clone(c.fx0);
    c.touched = new Set();
    P.setFx(c.st, clone(c.fx));
    clearTimeout(c.timer);
    c.pending = {};
    status("enregistrement…");
    const body = { edit: c.edit0 };
    if (c.st.relief) {
      c.relief = clone(c.relief0);
      P.setRelief(c.st, c.relief);
      body.relief = c.relief0Saved;
    }
    saveEdit(c.i, c.id, body).then(() => { if (cur === c) status("✓ retouches annulées"); })
      .catch((e) => status("⚠ " + e.message, true));
    renderTab();
    drawTimeline();
  }

  // ------------------------------------------------------------------ popup
  function build() {
    const st = cur.st, p = st.p, pg = C.B.pages[cur.i];
    const sndBtn = h("button.ae-ib", { title: "Écouter les sons de la case pendant la retouche" }, "🔇");
    sndBtn.onclick = () => {
      cur.sound = !cur.sound;
      P.setPanelSound(st, cur.sound);
      sndBtn.textContent = cur.sound ? "🔊" : "🔇";
      sndBtn.classList.toggle("on", cur.sound);
    };
    const dot = h("button.ae-dot.ae-dot-head", { type: "button", dataset: { panel: p.id } });
    paintDot(dot, reviewOf(cur.pid, p.id));
    dot.addEventListener("click", () => reviewMenu(dot, cur.i, cur.pid, p.id));
    const bigBtn = h("button.ae-ib", { title: "Agrandir / réduire la fenêtre (on peut aussi tirer le coin en bas à droite)" }, "⤢");
    const head = h("div.ae-head", dot, h("b", `Case ${p.id}`), h("span.ae-sub", pg.title || ""), h("span.ae-sp"), bigBtn, sndBtn,
                   h("button.ae-ib", { title: "Fermer (Échap)", on: { click: close } }, "✕"));
    // apercu agrandi : une vue de plus sur la case, avec les memes retouches ; il suit la taille de la fenetre
    const ar = (p.rect[2] - p.rect[0]) / Math.max(1, p.rect[3] - p.rect[1]);
    const stage = h("div.ac-view.ae-stage");
    if (st.relief) {                       // relief : sa propre vue WebGL ; un clic dans l'apercu choisit le plan net
      cur.rview = P.addReliefView(st, stage);
      stage.title = "Clic : choisir le plan net (ce qui ne bouge pas)";
      stage.style.cursor = "crosshair";
      stage.addEventListener("click", (e) => {
        const r = stage.getBoundingClientRect();
        const z = P.reliefDepthAt(st, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
        if (z == null) return;
        changeRelief("focus", Math.round(z * 1000) / 1000);
        if (lastTab === "relief") renderTab();
        toast(`Plan net : ${fmt(z)} (ce point ne bouge plus, le reste tourne autour).`);
      });
    } else {
      cur.view = P.addView(st, stage);
    }
    const playBtn = h("button.ae-btn", { title: "Lecture / pause (barre espace) : en pause, le tremblé continue sur l'image fixe" });
    const syncPlay = () => {
      st.freeze = !cur.playing; st.freeShake = !cur.playing;
      playBtn.textContent = cur.playing ? "⏸ Pause (espace)" : "▶ Lecture (espace)";
    };
    cur.togglePlay = () => { cur.playing = !cur.playing; syncPlay(); };
    playBtn.onclick = cur.togglePlay;
    if (st.relief) {
      cur.togglePlay = () => P.reliefPlay(st);
      playBtn.onclick = cur.togglePlay;
      playBtn.textContent = "▶ Jouer le mouvement (espace)";
      playBtn.title = "Un tour du mouvement, comme au clic du lecteur";
    } else syncPlay();
    const info = h("span.ae-info");
    const canvas = st.relief ? null : h("canvas.ae-tl", { width: 864, height: 150 });
    if (canvas) { canvas.style.width = "100%"; canvas.style.height = "75px"; }
    const tabs = h("div.ae-tabs");
    const tabBody = h("div.ae-tab");
    const NAMES = st.relief ? { relief: "Relief", color: "Couleur", frame: "Cadrage", sound: "Son", treat: "Vidéo H3" }
                            : { loop: "Boucle", shake: "Tremblé", color: "Couleur", frame: "Cadrage", sound: "Son", regen: "Régénérer" };
    for (const [k, label] of Object.entries(NAMES)) {
      tabs.append(h("button", { dataset: { tab: k }, on: { click: () => { lastTab = k; renderTab(); } } }, label));
    }
    const foot = h("div.ae-foot", h("span.ae-status", "retouches enregistrées automatiquement"), h("span.ae-sp"),
                   h("button.ae-btn", { title: "Remettre la case comme à l'ouverture du popup", on: { click: revert } }, "↺ Annuler mes retouches"),
                   h("button.ae-btn.ae-main", { on: { click: close } }, "Fermer"));
    let extraRow = null;
    if (st.relief) {
      const mapBtn = h("button.ae-btn", { title: "Voir la profondeur (blanc = proche)" }, "👁 Profondeur");
      const layBtn = h("button.ae-btn", { title: "Voir les calques : bleu = sujet du fond, orange = sujet de devant" }, "🧩 Calques");
      const view = (v) => {
        cur.showMap = cur.showMap === v ? false : v;
        P.reliefShowMap(st, cur.showMap);
        mapBtn.classList.toggle("ae-main", cur.showMap === true); layBtn.classList.toggle("ae-main", cur.showMap === "layers");
      };
      mapBtn.onclick = () => view(true);
      layBtn.onclick = () => view("layers");
      const redo = h("button.ae-btn", { title: "Recalculer la carte de profondeur (Depth Anything V2 Small, ~1 s)" }, "↻ Recalculer la carte");
      redo.onclick = async () => {
        const c = cur;
        redo.disabled = true; status("carte de profondeur…");
        try {
          const r = await api(`/api/projects/${c.pid}/depth/${c.id}`, { force: true });
          await saveEdit(c.i, c.id, {}, { relief: c.id });
          if (cur === c) status(`✓ carte recalculée en ${fmt(r.seconds, 1)} s`);
        } catch (e) { status("⚠ " + e.message, true); }
        redo.disabled = false;
      };
      extraRow = h("div.ae-row", mapBtn, layBtn, redo, h("span.ae-note", "Clic dans l'image : plan net."));
    }
    pop = h("div.ae-pop", head,
            h("div.ae-body", h("div.ae-stagebox", stage), h("div.ae-row", playBtn, info), extraRow, canvas, tabs, tabBody), foot);
    document.body.append(pop);
    Object.assign(cur, { canvas, info, tabBody, tabs });
    if (st.relief) {                        // le relief n'a ni timeline ni compteur d'images
      cur.canvas = null;
      info.textContent = "photo en relief · aucun calcul vidéo";
    }
    try {                                   // derniere taille choisie
      const sz = JSON.parse(localStorage.getItem("ae-size") || "null");
      if (sz) { pop.style.width = Math.min(sz[0], innerWidth - 16) + "px"; pop.style.height = Math.min(sz[1], innerHeight - 24) + "px"; }
    } catch (_) { /* stockage indisponible */ }
    const fitStage = () => {
      if (!pop) return;
      const body = pop.querySelector(".ae-body");
      const W = Math.max(200, body.clientWidth - 30);
      const H = pop.style.height ? Math.max(160, pop.clientHeight * 0.46) : 250;
      let ph = Math.min(H, W / ar), pw = ph * ar;
      if (pw > W) { pw = W; ph = W / ar; }
      stage.style.width = pw + "px"; stage.style.height = ph + "px";
    };
    fitStage();
    const me = pop;
    let saveT = null;
    new ResizeObserver(() => {
      if (pop !== me) return;
      fitStage();
      clearTimeout(saveT);
      saveT = setTimeout(() => {
        try {
          if (pop && pop.style.width) localStorage.setItem("ae-size", JSON.stringify([pop.offsetWidth, pop.offsetHeight]));
        } catch (_) { /* stockage indisponible */ }
      }, 400);
    }).observe(pop);
    bigBtn.onclick = () => {
      if (pop.style.width && pop.offsetWidth > 700) {
        pop.style.width = pop.style.height = "";
        try { localStorage.removeItem("ae-size"); } catch (_) { /* rien */ }
      } else {
        const w = Math.min(1000, innerWidth - 24);
        pop.style.width = w + "px";
        pop.style.left = Math.max(12, Math.min(pop.offsetLeft, innerWidth - w - 12)) + "px";
        pop.style.top = "56px";
        pop.style.height = (innerHeight - 68) + "px";
        pop.style.maxHeight = "";
      }
      fitStage();
    };
    placePop(head);
    if (!st.relief) { bindTimeline(canvas); loadTimeline(); }
    renderTab();
    const loop = () => {                  // tete de lecture et compteur
      if (!cur || !pop || st.relief) return;
      const f = P.frameOf(st);
      if (f !== cur.lastF) {
        cur.lastF = f;
        info.textContent = `image ${f} · ${fmt(f / st.inst.fps, 2)} s / ${fmt((p.frames - 1) / st.inst.fps, 2)} s`;
        drawTimeline();
      }
      cur.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function placePop(head) {
    const r = cur.st.el.getBoundingClientRect();
    const w = pop.offsetWidth || Math.min(460, innerWidth - 16);
    let x = r.left + r.width / 2 > innerWidth / 2 ? 12 : innerWidth - w - 12;
    let y = 64;
    if (userPos) { x = userPos[0]; y = userPos[1]; }
    pop.style.left = Math.max(0, Math.min(innerWidth - 120, x)) + "px";
    pop.style.top = Math.max(0, Math.min(innerHeight - 80, y)) + "px";
    const me = pop;
    const fit = () => {
      if (pop !== me) { removeEventListener("resize", fit); return; }
      pop.style.maxHeight = Math.max(240, innerHeight - pop.offsetTop - 10) + "px";
    };
    fit();
    addEventListener("resize", fit);
    let d = null;
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      d = { x: e.clientX, y: e.clientY, l: pop.offsetLeft, t: pop.offsetTop };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener("pointermove", (e) => {
      if (!d) return;
      const nx = d.l + e.clientX - d.x, ny = d.t + e.clientY - d.y;
      pop.style.left = Math.max(-300, Math.min(innerWidth - 80, nx)) + "px";
      pop.style.top = Math.max(0, Math.min(innerHeight - 40, ny)) + "px";
      pop.style.maxHeight = Math.max(240, innerHeight - pop.offsetTop - 10) + "px";
      userPos = [pop.offsetLeft, pop.offsetTop];
    });
    head.addEventListener("pointerup", () => { d = null; });
  }

  // ------------------------------------------------------------------ timeline
  async function analyse(st, onProgress) {
    const key = st.src;
    if (analyses.has(key)) return analyses.get(key);
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.src = st.src;
    await once(v, "loadeddata");
    const n = st.p.frames, fps = st.inst.fps;
    const ar = (st.p.rect[2] - st.p.rect[0]) / Math.max(1, st.p.rect[3] - st.p.rect[1]);
    const W = 64, H = Math.max(8, Math.round(64 / ar));
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    const NT = 10, picks = new Set(Array.from({ length: NT }, (_, k) => Math.round(k * (n - 1) / (NT - 1))));
    const thumbs = [], motion = new Float32Array(n);
    let prev = null;
    for (let i = 0; i < n; i++) {
      v.currentTime = (i + 0.5) / fps;
      await once(v, "seeked");
      g.drawImage(v, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data, gray = new Float32Array(W * H);
      for (let j = 0; j < gray.length; j++) gray[j] = 0.299 * d[4 * j] + 0.587 * d[4 * j + 1] + 0.114 * d[4 * j + 2];
      if (prev) {
        let s = 0;
        for (let j = 0; j < gray.length; j++) s += Math.abs(gray[j] - prev[j]);
        motion[i] = s / gray.length;
      }
      prev = gray;
      if (picks.has(i)) {
        const t = document.createElement("canvas");
        t.width = 120; t.height = Math.max(8, Math.round(120 / ar));
        t.getContext("2d").drawImage(v, 0, 0, t.width, t.height);
        thumbs.push({ i, c: t });
      }
      if (onProgress && i % 8 === 0) onProgress(i / n);
    }
    motion[0] = n > 1 ? motion[1] : 0;
    v.removeAttribute("src"); v.load();
    // activite lissee (5 images) : H3 freine au debut et a la fin de chaque boucle pour retomber sur la 1re image
    const act = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0, k = 0;
      for (let j = Math.max(1, i - 2); j <= Math.min(n - 1, i + 2); j++) { sum += motion[j]; k++; }
      act[i] = k ? sum / k : motion[i];
    }
    const sa = Array.from(act).sort((a, b) => a - b), q = (x) => sa[Math.min(sa.length - 1, Math.floor(sa.length * x))] || 0;
    const floor = q(0.1), ref = q(0.5);
    const res = { thumbs, motion, act, n, floor, ref, slow: floor + 0.35 * (ref - floor),
                  max: Array.from(motion).sort((a, b) => a - b)[Math.floor(n * 0.95)] || 1 };
    analyses.set(key, res);
    return res;
  }

  function loadTimeline() {
    const c = cur;
    c.ana = null;
    drawTimeline();
    analyse(c.st, (f) => { if (cur === c) { c.progress = f; drawTimeline(); } })
      .then((a) => { if (cur === c) { c.ana = a; drawTimeline(); } })
      .catch((e) => { if (cur === c) { c.progress = -1; drawTimeline(); status("⚠ timeline : " + e.message, true); } });
  }

  const PAD = 12;
  function xOf(i) { const cv = cur.canvas, n = cur.st.p.frames; return PAD + i / Math.max(1, n - 1) * (cv.width - 2 * PAD); }
  function frameAt(x) {
    const cv = cur.canvas, n = cur.st.p.frames;
    return Math.max(0, Math.min(n - 1, Math.round((x - PAD) / (cv.width - 2 * PAD) * (n - 1))));
  }

  function drawTimeline() {
    if (!cur || !cur.canvas) return;
    const cv = cur.canvas, g = cv.getContext("2d"), st = cur.st, n = st.p.frames, a = cur.ana;
    const Wd = cv.width, Hs = 96, Hm = 40, top = 8;
    g.clearRect(0, 0, Wd, cv.height);
    g.fillStyle = "#0d0d0d"; g.fillRect(0, 0, Wd, cv.height);
    if (a) {
      const cw = (Wd - 2 * PAD) / a.thumbs.length;
      a.thumbs.forEach((t, k) => {             // vignettes, recadrees pour remplir leur place
        const sx = t.c.width, sy = t.c.height, r = cw / Hs;
        let w = sx, hh = sx / r;
        if (hh > sy) { hh = sy; w = sy * r; }
        g.drawImage(t.c, (sx - w) / 2, (sy - hh) / 2, w, hh, PAD + k * cw, top, cw - 2, Hs);
      });
      const y0 = top + Hs + 4;
      for (let i = 0; i < n; i++) {           // courbe de mouvement : rouge = ralenti (presque immobile)
        const v = a.motion[i], hh = Math.max(1.5, Math.min(1, v / a.max) * Hm);
        g.fillStyle = a.act[i] < a.slow ? "#d9534f" : "#6f9b6a";
        const x = xOf(i);
        g.fillRect(x - 1, y0 + Hm - hh, Math.max(2, (Wd - 2 * PAD) / n), hh);
      }
    } else {
      g.fillStyle = "#9a948a"; g.font = "24px system-ui, sans-serif";
      g.fillText(cur.progress === -1 ? "analyse impossible" : `analyse de la vidéo… ${Math.round((cur.progress || 0) * 100)} %`,
                 PAD + 8, 60);
    }
    // hors boucle : assombri ; fondu : hachure ; poignees debut/fin ; image de depart ; tete de lecture
    const xa = xOf(st.a), xb = xOf(st.b);
    g.fillStyle = "rgba(0,0,0,.62)";
    g.fillRect(0, 0, xa, cv.height); g.fillRect(xb, 0, Wd - xb, cv.height);
    if (st.ease) {                           // ralentis acceleres : bleu
      const s0 = st.loopMode ? st.lo : st.a;
      g.fillStyle = "rgba(90,160,255,.30)";
      if (st.ease.head) g.fillRect(xOf(s0), 0, xOf(s0 + st.ease.head) - xOf(s0), cv.height);
      if (st.ease.tail) g.fillRect(xOf(st.b - st.ease.tail), 0, xb - xOf(st.b - st.ease.tail), cv.height);
    }
    if (st.xf) {
      g.fillStyle = "rgba(242,180,92,.28)";
      g.fillRect(xOf(st.b - st.xf), 0, xb - xOf(st.b - st.xf), cv.height);
      g.fillRect(xa, 0, xOf(st.a + st.xf) - xa, cv.height);
    }
    for (const x of [xa, xb]) {
      g.fillStyle = "#f2b45c"; g.fillRect(x - 3, 0, 6, cv.height);
      g.fillRect(x - 9, cv.height / 2 - 16, 18, 32);
    }
    const xh = xOf(st.home);
    g.fillStyle = "#fff";
    g.beginPath(); g.moveTo(xh - 9, 0); g.lineTo(xh + 9, 0); g.lineTo(xh, 14); g.closePath(); g.fill();
    const xp = xOf(P.frameOf(st));
    g.fillStyle = "#fff"; g.fillRect(xp - 1.5, 0, 3, cv.height);
  }

  function bindTimeline(cv) {
    let mode = null;
    const pos = (e) => (e.clientX - cv.getBoundingClientRect().left) * cv.width / cv.getBoundingClientRect().width;
    cv.addEventListener("pointerdown", (e) => {
      const x = pos(e), st = cur.st;
      cv.setPointerCapture(e.pointerId);
      if (Math.abs(x - xOf(st.a)) < 14) mode = "a";
      else if (Math.abs(x - xOf(st.b)) < 14) mode = "b";
      else { mode = "scrub"; st.freeze = true; }
      move(e);
    });
    const move = (e) => {
      if (!mode || !cur) return;
      const f = frameAt(pos(e)), st = cur.st, n = st.p.frames;
      if (mode === "scrub") { P.seekTo(st, f); return; }
      const r = cur.fx.range ? cur.fx.range.slice() : [0, n - 1];
      if (mode === "a") r[0] = Math.min(f, r[1] - 4); else r[1] = Math.max(f, r[0] + 4);
      cur.fx.range = r;
      P.setFx(st, clone(cur.fx));
      if (cur.shakeInfo) cur.shakeInfo();
      P.seekTo(st, mode === "a" ? r[0] : Math.max(r[0], r[1] - 12));
      drawTimeline();
    };
    cv.addEventListener("pointermove", move);
    const up = () => {
      if (!mode || !cur) return;
      if (mode === "a" || mode === "b") {
        const n = cur.st.p.frames, r = cur.fx.range;
        if (r && r[0] <= 0 && r[1] >= n - 1) delete cur.fx.range;
        change("range", () => {});
      }
      cur.st.freeze = !cur.playing;
      mode = null;
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
  }

  // lisser la boucle : les ralentis du debut et de la fin (en rouge) sont joues plus vite, sans rien couper
  function autoEase() {
    const a = cur.ana, st = cur.st;
    if (!a) { toast("Analyse de la vidéo en cours…"); return; }
    const s0 = st.loopMode ? st.lo : st.a, b = st.b;
    let head = 0, tail = 0;
    while (s0 + head < b - 4 && a.act[Math.min(a.n - 1, s0 + head + 1)] < a.slow) head++;
    while (b - tail > s0 + head + 4 && a.act[b - tail] < a.slow) tail++;
    if (head + tail < 3) { toast("Pas de ralenti net au début ni à la fin de cette boucle."); return; }
    let sum = 0, k = 0;
    for (let i = s0 + 1; i <= s0 + head; i++) { sum += a.act[i]; k++; }
    for (let i = b - tail + 1; i <= b; i++) { sum += a.act[Math.min(a.n - 1, i)]; k++; }
    const gain = Math.round(Math.max(1.5, Math.min(3, a.ref / Math.max(0.05, sum / k))) * 10) / 10;
    change("ease", (fx) => { fx.ease = { head, tail, gain }; });
    toast(`Boucle lissée : ${head} images au début et ${tail} à la fin jouées ×${fmt(gain, 1)} (zones bleues).`, 5000);
    renderTab();
  }

  // ------------------------------------------------------------------ onglets
  function slider(label, get, set, o) {
    const val = h("span.ae-val");
    const lg = !!o.log;
    const to = (v) => lg ? Math.log(v / o.min) / Math.log(o.max / o.min) * 1000 : v;
    const from = (t) => lg ? o.min * Math.pow(o.max / o.min, t / 1000) : t;
    const inp = h("input", { type: "range", min: lg ? 0 : o.min, max: lg ? 1000 : o.max, step: lg ? 1 : o.step });
    const show = () => { val.textContent = (o.fmt || ((v) => fmt(v)))(get()); };
    inp.value = to(get());
    show();
    inp.addEventListener("input", () => {
      let v = from(+inp.value);
      if (lg) v = Math.round(v * 100) / 100;
      set(v); show();
    });
    inp.addEventListener("dblclick", () => {
      if (o.neutral == null) return;
      set(o.neutral); inp.value = to(o.neutral); show();
    });
    return h("label.ae-sl", { title: o.neutral != null ? "Double-clic : valeur neutre" : "" }, h("span.ae-lab", label), inp, val);
  }

  function renderTab() {
    if (!cur || !pop) return;
    for (const b of cur.tabs.children) b.classList.toggle("on", b.dataset.tab === lastTab);
    const box = cur.tabBody;
    box.textContent = "";
    cur.shakeInfo = null;
    ({ loop: tabLoop, shake: tabShake, color: tabColor, frame: tabFrame, sound: tabSound, regen: tabRegen,
       relief: tabRelief, treat: tabTreat })[lastTab](box);
  }

  function tabLoop(box) {
    const st = cur.st;
    const here = () => P.frameOf(st);
    box.append(h("p.ae-note", "Barres rouges = ralentis : H3 freine au début et à la fin de chaque boucle pour retomber sur " +
                 "la première image, c'est ce qui fait « un fixe ». « Lisser la boucle » les joue plus vite (zones bleues), sans " +
                 "rien couper : la boucle reste parfaite. Poignées orange : début et fin de boucle."));
    box.append(h("div.ae-row",
      h("button.ae-btn.ae-main", { on: { click: autoEase } }, "⏩ Lisser la boucle"),
      h("button.ae-btn", { on: { click: () => change("range", (fx) => {
        const r = fx.range ? fx.range.slice() : [0, st.p.frames - 1];
        r[0] = Math.min(here(), r[1] - 4); fx.range = r;
      }) } }, "⟦ Début ici"),
      h("button.ae-btn", { on: { click: () => change("range", (fx) => {
        const r = fx.range ? fx.range.slice() : [0, st.p.frames - 1];
        r[1] = Math.max(here(), r[0] + 4); fx.range = r;
      }) } }, "Fin ici ⟧"),
      h("button.ae-btn", { title: "Image montrée au départ et après « Vue initiale »",
                            on: { click: () => change("start", (fx) => { fx.start = here(); }) } }, "▼ Départ ici"),
      h("button.ae-btn", { title: "Toute la vidéo, sans lissage", on: { click: () => {
        change("range", (fx) => { delete fx.range; delete fx.start; delete fx.xfade; delete fx.ease; });
        for (const k of ["start", "xfade", "ease"]) cur.touched.add(k);
        renderTab();
      } } }, "↺")));
    const ez = () => cur.fx.ease || { head: 0, tail: 0, gain: 2 };
    const setE = (k, v) => change("ease", (fx) => {
      const e = Object.assign({}, ez(), { [k]: v });
      if ((e.head || e.tail) && e.gain > 1) fx.ease = e; else delete fx.ease;
    });
    box.append(slider("Ralenti du début", () => ez().head, (v) => setE("head", v),
      { min: 0, max: 40, step: 1, neutral: 0, fmt: (v) => v ? `${v} images` : "—" }));
    box.append(slider("Ralenti de la fin", () => ez().tail, (v) => setE("tail", v),
      { min: 0, max: 40, step: 1, neutral: 0, fmt: (v) => v ? `${v} images` : "—" }));
    box.append(slider("Accélération", () => ez().gain, (v) => setE("gain", v),
      { min: 1, max: 4, step: 0.1, fmt: (v) => "× " + fmt(v, 1) }));
    const sens = h("select", {},
      h("option", { value: "loop" }, "Boucle (vers l'avant)"), h("option", { value: "bounce" }, "Aller-retour"));
    sens.value = st.loopMode ? "loop" : "bounce";
    sens.onchange = () => { change("bounce", (fx) => { fx.bounce = sens.value === "bounce"; }); renderTab(); };
    box.append(h("label.ae-sl", h("span.ae-lab", "Sens"), sens, h("span.ae-val")));
    if (st.loopMode) {
      box.append(slider("Fondu au raccord", () => cur.fx.xfade || 0,
        (v) => change("xfade", (fx) => { if (v) fx.xfade = v; else delete fx.xfade; }),
        { min: 0, max: 24, step: 1, neutral: 0, fmt: (v) => v ? `${v} images` : "aucun" }));
    }
    box.append(slider("Vitesse", () => cur.fx.speed || 1,
      (v) => change("speed", (fx) => { if (v !== 1) fx.speed = v; else delete fx.speed; }),
      { min: 0.25, max: 2, step: 0.05, neutral: 1, fmt: (v) => "× " + fmt(v) }));
  }

  let userShakes = null;              // prereglages de tremble enregistres (pour toutes les planches)
  async function loadUserShakes() {
    if (!userShakes) userShakes = (await api("/api/userpresets")).shake || [];
    return userShakes;
  }

  function tabShake(box) {
    const st = cur.st;
    const sh = () => cur.fx.shake || { size: 0, freq: 0.2, rot: 0, seed: 0 };
    const set = (k, v) => change("shake", (fx) => { fx.shake = Object.assign({}, sh(), { [k]: v }); });
    const use = (p) => {                 // un prereglage garde la graine de la case
      change("shake", (fx) => { fx.shake = { size: p.size, freq: p.freq, rot: p.rot, seed: sh().seed || 0 }; });
      renderTab();
    };
    box.append(h("div.ae-row", Object.entries(SHAKES).map(([k, p]) => h("button.ae-btn", { on: { click: () => use(p) } }, SHAKE_NAMES[k]))));
    const mine = h("div.ae-row");
    const fillMine = () => {
      mine.textContent = "";
      for (const p of userShakes || []) {
        mine.append(h("span.ae-chip",
          h("button.ae-btn", { title: `${fmt(p.size)} % · ${fmt(p.freq)} Hz · ${fmt(p.rot)}°`, on: { click: () => use(p) } }, "★ " + p.name),
          h("button.ae-x", { title: "Supprimer ce préréglage", on: { click: async () => {
            try { userShakes = (await api("/api/userpresets", { kind: "shake", name: p.name, delete: true })).shake; fillMine(); }
            catch (e) { toast("⚠ " + e.message); }
          } } }, "✕")));
      }
    };
    box.append(mine);
    loadUserShakes().then(fillMine).catch(() => {});
    box.append(slider("Taille", () => sh().size, (v) => set("size", v),
      { min: 0, max: 3, step: 0.05, neutral: 0, fmt: (v) => fmt(v) + " %" }));
    box.append(slider("Fréquence", () => sh().freq || 0.2, (v) => set("freq", v),
      { min: 0.05, max: 4, log: true, fmt: (v) => fmt(v, 3) + " Hz" }));
    box.append(slider("Rotation", () => sh().rot, (v) => set("rot", v),
      { min: 0, max: 1.5, step: 0.01, neutral: 0, fmt: (v) => fmt(v) + "°" }));
    const seed = h("input.ae-num", { type: "number", min: 0, max: 99999, value: sh().seed || 0 });
    seed.onchange = () => set("seed", Math.max(0, Math.min(99999, +seed.value | 0)));
    box.append(h("label.ae-sl", h("span.ae-lab", "Graine"), h("span.ae-grow", seed,
      h("button.ae-btn", { title: "Autre graine : autre trajet du tremblé", on: { click: () => {
        seed.value = Math.floor(Math.random() * 10000); seed.onchange();
      } } }, "🎲")), h("span.ae-val")));
    // boucle adaptative : le tremble fait un nombre entier de cycles entre le in et le out (toujours, en lecture) ;
    // le bouton cale la frequence affichee sur celle qui est reellement jouee pour la boucle actuelle
    const info = h("span.ae-note");
    cur.shakeInfo = () => {
      const i = P.shakeInfo(st);
      info.textContent = i && (sh().size > 0 || sh().rot > 0)
        ? `${i.cycles} cycle${i.cycles > 1 ? "s" : ""} sur la boucle de ${fmt(i.sec)} s, soit ${fmt(i.hz, 3)} Hz joués : raccord identique au in et au out`
        : "aucun tremblé";
    };
    cur.shakeInfo();
    box.append(h("div.ae-row",
      h("button.ae-btn.ae-main", { title: "Adapter le tremblé aux points de boucle actuels (in / out) : la fréquence est calée sur " +
                                     "un nombre entier de cycles, le tremblé est le même au début et à la fin de la boucle",
                                   on: { click: () => {
        const i = P.shakeInfo(st);
        if (!i) { toast("Pas de tremblé sur cette case."); return; }
        set("freq", Math.round(i.hz * 1000) / 1000);
        renderTab();
        toast(`Tremblé adapté à la boucle : ${i.cycles} cycle${i.cycles > 1 ? "s" : ""} en ${fmt(i.sec)} s.`);
      } } }, "🔁 Adaptive loop"), info));
    // enregistrer le reglage comme prereglage
    const name = h("input.ae-txt", { placeholder: "nom du préréglage", maxLength: 40 });
    const save = async () => {
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      try {
        userShakes = (await api("/api/userpresets", { kind: "shake", name: n, value: sh() })).shake;
        name.value = "";
        fillMine();
        toast(`Préréglage « ${n} » enregistré : disponible dans toutes les pages.`);
      } catch (e) { toast("⚠ " + e.message); }
    };
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    box.append(h("div.ae-row", name, h("button.ae-btn", { on: { click: save } }, "💾 Enregistrer le préréglage")));
    box.append(h("div.ae-row", h("button.ae-btn", { title: "Même tremblé sur toutes les cases vidéo de la page ; chaque case garde " +
                                                    "sa graine (elles ne tremblent pas ensemble)", on: { click: () => applyAll("shake") } },
                                 "Appliquer à toute la page")));
    box.append(h("p.ae-note", "Le tremblé suit l'image et revient au même point au raccord de la boucle. « ⏸ Figer l'image » : " +
                 "il continue sur l'image fixe, pour le juger."));
  }

  function tabColor(box) {
    const g = () => cur.fx.grade || {};
    const set = (k, v, neutral) => change("grade", (fx) => {
      const gg = Object.assign({}, fx.grade);
      if (v === neutral) delete gg[k]; else gg[k] = v;
      if (Object.keys(gg).length) fx.grade = gg; else delete fx.grade;
    });
    const row = (label, k, min, max, step, neutral, f) =>
      slider(label, () => g()[k] ?? neutral, (v) => set(k, v, neutral), { min, max, step, neutral, fmt: f });
    box.append(row("Saturation", "sat", 0, 2, 0.01, 1, (v) => Math.round(v * 100) + " %"));
    box.append(row("Luminosité", "bright", 0.5, 1.5, 0.01, 1, (v) => Math.round(v * 100) + " %"));
    box.append(row("Contraste", "contrast", 0.5, 1.5, 0.01, 1, (v) => Math.round(v * 100) + " %"));
    box.append(row("Température", "temp", -1, 1, 0.01, 0, (v) => v > 0 ? "chaud " + Math.round(v * 100) : v < 0 ? "froid " + Math.round(-v * 100) : "neutre"));
    box.append(row("Teinte", "hue", -30, 30, 1, 0, (v) => (v > 0 ? "+" : "") + v + "°"));
    box.append(h("div.ae-row",
      h("button.ae-btn", { on: { click: () => { change("grade", (fx) => { delete fx.grade; }); renderTab(); } } }, "↺ Neutre"),
      h("button.ae-btn", { title: "Mêmes couleurs pour toutes les cases vidéo de cette page", on: { click: () => applyAll("grade") } },
        "Appliquer à toute la page")));
  }

  // meme reglage (couleurs, tremble) sur toutes les cases video de la page
  async function applyAll(key) {
    const c = cur, inst = C.inst(), others = inst.panels.filter(x => x !== c.st);
    let val = clone(c.fx[key]);
    if (key === "shake" && !val) val = { size: 0, freq: 0.2, rot: 0, seed: 0 };      // « aucun » explicite
    status(`${key === "shake" ? "tremblé" : "couleurs"} : toute la page…`);
    try {
      for (const st of others) {
        const v = clone(val);
        if (v && key === "shake") v.seed = ((st.p.fx || {}).shake || {}).seed ?? v.seed;   // chaque case sa graine
        const fx = clone(st.p.fx || {});
        if (v) fx[key] = v; else delete fx[key];
        P.setFx(st, fx);
        const edit = clone((c.project.panels[st.p.id] || {}).edit || {});
        if (v) edit[key] = clone(v); else delete edit[key];
        await saveEdit(c.i, st.p.id, { edit });
      }
      if (cur === c) status(`✓ appliqué aux ${others.length + 1} cases de la page`);
    } catch (e) { status("⚠ " + e.message, true); }
  }

  function tabFrame(box) {
    const fr = () => cur.fx.frame || { zoom: 1, x: 0, y: 0 };
    const set = (k, v) => change("frame", (fx) => {
      const f = Object.assign({}, fr(), { [k]: v });
      if (f.zoom <= 1.001 && !f.x && !f.y) delete fx.frame; else fx.frame = f;
    });
    box.append(slider("Zoom", () => fr().zoom, (v) => set("zoom", v), { min: 1, max: 2, step: 0.01, neutral: 1, fmt: (v) => "× " + fmt(v) }));
    box.append(slider("Horizontal", () => fr().x, (v) => set("x", v), { min: -1, max: 1, step: 0.01, neutral: 0, fmt: (v) => fmt(v) }));
    box.append(slider("Vertical", () => fr().y, (v) => set("y", v), { min: -1, max: 1, step: 0.01, neutral: 0, fmt: (v) => fmt(v) }));
    box.append(h("div.ae-row", h("button.ae-btn", { on: { click: () => { change("frame", (fx) => { delete fx.frame; }); renderTab(); } } }, "↺ Cadre d'origine")));
    box.append(h("p.ae-note", "Zoomer pour cacher un bord ou un défaut, puis déplacer le cadre (le zoom ne quitte jamais l'image)."));
  }

  // ------------------------------------------------------------------ sons
  function watchJobs(pid, ids, onTick, onDone) {
    const t = setInterval(async () => {
      let list;
      try { list = await api(`/api/jobs?project=${encodeURIComponent(pid)}`); } catch (_) { return; }
      const mine = list.filter(j => ids.includes(j.id));
      if (onTick) onTick(mine);
      if (!mine.length || mine.every(j => ["done", "error", "cancelled"].includes(j.status))) { clearInterval(t); onDone(mine); }
    }, 2500);
  }
  function jobText(js) {
    return js.map(j => j.status === "running" ? `${j.worker || "?"} ${j.progress || "calcul"}`
                       : j.status === "queued" ? "en file" : j.status === "done" ? "terminé" : j.status).join(" · ");
  }

  function regenSoundForm(layer, label, placeholder, prev) {
    const c = cur;
    const ta = h("textarea", { rows: 2, placeholder });
    const same = h("input", { type: "checkbox" });
    const out = h("div.ae-jobs");
    const go = h("button.ae-btn.ae-main", "Lancer");
    go.onclick = async () => {
      go.disabled = true;
      out.textContent = "envoi…";
      try {
        const res = await api(`/api/projects/${c.pid}/regensound/${layer === "page" ? "_" : c.id}`,
                              { layer, text: ta.value.trim(), sameSeed: same.checked });
        const ids = res.jobs.map(j => j.id);
        watchJobs(c.pid, ids, (js) => { out.textContent = jobText(js); }, async (js) => {
          go.disabled = false;
          const err = js.find(j => j.status === "error");
          if (err) { out.textContent = "⚠ " + (err.error || "erreur"); return; }
          out.textContent = "terminé : mise en place…";
          if (layer === "page") { await refreshPage(c); return; }
          await saveEdit(c.i, c.id, {}, { sounds: c.id });
          out.textContent = "";
          out.append("✓ nouveau son en place ");
          if (prev) out.append(h("button.ae-btn", { on: { click: async () => {
              await api(`/api/projects/${c.pid}/choose`, { panel: c.id, side: { audio: "A", voice: "B", foley: "F" }[layer], file: prev });
              await saveEdit(c.i, c.id, {}, { sounds: c.id });
              toast("Son précédent remis.");
            } } }, "↺ Revenir au précédent"));
        });
        out.textContent = "en file…";
      } catch (e) { go.disabled = false; out.textContent = "⚠ " + e.message; }
    };
    return h("details.ae-regen", h("summary", "↻ " + label),
             ta, h("div.ae-row", h("label.ae-chk", same, "même graine"), go), out);
  }

  // envoi d'un son : s'il sert deja dans une planche, alerte avec les references ; deja importe = reutilise
  function confirmBox(title, lines, okLabel, note) {
    return new Promise((done) => {
      const back = h("div.ae-modal-back");
      const end = (v) => { back.remove(); done(v); };
      back.append(h("div.ae-modal", h("b", title), h("ul", lines.map(l => h("li", l))), note ? h("p.ae-note", note) : null,
        h("div.ae-row", h("span.ae-sp"), h("button.ae-btn", { on: { click: () => end(false) } }, "Annuler"),
          h("button.ae-btn.ae-main", { on: { click: () => end(true) } }, okLabel || "Utiliser quand même"))));
      back.addEventListener("pointerdown", (e) => { if (e.target === back) end(false); });
      document.body.append(back);
    });
  }
  async function sendSound(url, file) {
    const go = async (force) => {
      const r = await fetch(url + (force ? "&force=1" : ""), { method: "POST", body: file });
      let j = {};
      try { j = await r.json(); } catch (_) { /* reponse vide */ }
      if (r.status === 409 && j.used && !force) {
        if (!(await confirmBox("Ce son est déjà utilisé", j.used.map(u => u.where), null,
                               "S'il est utilisé quand même, le fichier déjà importé est repris : il n'est pas copié une deuxième fois."))) {
          throw new Error("import annulé");
        }
        return go(true);
      }
      if (!r.ok) throw new Error(j.error || "envoi refusé");
      if (j.reused) toast("Son déjà importé : le fichier existant est réutilisé (pas de doublon).", 4500);
      return j;
    };
    return go(false);
  }
  function pickAudio(fn) {
    const inp = h("input", { type: "file", accept: "audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac" });
    inp.onchange = () => { if (inp.files[0]) fn(inp.files[0]); };
    inp.click();
  }
  // le son global de la page a change : le lecteur le recharge sans demonter la page
  async function refreshPage(c) {
    const res = await saveEdit(c.i, "_", {}, { noApply: true });
    if (C.cur() === c.i) P.setPageSound(C.inst(), res.page.sound || null, C.B.pages[c.i].stamp || String(Date.now()));
    if (cur === c) renderTab();
  }
  async function setLayer(c, layer, value) {           // remplace l'objet de la couche (mode none = retirer)
    await api(`/api/projects/${c.pid}/panels/${c.id}`, { [layer]: value });
    await saveEdit(c.i, c.id, {}, { sounds: c.id });
  }

  let voicePresets = null;
  async function loadVoicePresets() {
    if (!voicePresets) voicePresets = await api("/api/presets");
    return voicePresets;
  }
  // voix off IA (MiniMax Speech sur fal) : texte, voix, emotion, langue
  function voiceForm(c, v, onBusy) {
    const ta = h("textarea", { rows: 3, placeholder: "Texte de la voix off (dans la langue choisie)" });
    ta.value = v.mode === "tts" ? (v.text || "") : "";
    const voice = h("select"), emo = h("select"), lang = h("select");
    loadVoicePresets().then((pr) => {
      for (const x of pr.voices) voice.append(h("option", { value: x.id }, x.label));
      for (const x of pr.emotions) emo.append(h("option", { value: x }, x));
      for (const x of pr.languages) lang.append(h("option", { value: x }, x));
      voice.value = v.voice_id || "Deep_Voice_Man"; emo.value = v.emotion || "neutral"; lang.value = v.language || "French";
    }).catch(() => {});
    const out = h("div.ae-jobs");
    const go = h("button.ae-btn.ae-main", "🎙 Générer la voix off (fal)");
    go.onclick = async () => {
      if (!ta.value.trim()) { ta.focus(); return; }
      const old = clone(c.panel.voice || {});
      go.disabled = true; out.textContent = "envoi…";
      try {
        await api(`/api/projects/${c.pid}/panels/${c.id}`, { voice: { mode: "tts", text: ta.value.trim(), voice_id: voice.value,
          emotion: emo.value, language: lang.value, volume: old.volume ?? 1, loop: !!old.loop } });
        let res;
        try { res = await api(`/api/projects/${c.pid}/voice/${c.id}`, {}); }
        catch (e) { await api(`/api/projects/${c.pid}/panels/${c.id}`, { voice: old }); throw e; }   // on remet l'ancienne voix
        watchJobs(c.pid, res.jobs.map(j => j.id), (js) => { out.textContent = jobText(js); }, async (js) => {
          go.disabled = false;
          const err = js.find(j => j.status === "error");
          if (err) { out.textContent = "⚠ " + (err.error || "erreur"); return; }
          await saveEdit(c.i, c.id, {}, { sounds: c.id });
          out.textContent = "✓ nouvelle voix off en place";
        });
        out.textContent = "en file…";
      } catch (e) { go.disabled = false; out.textContent = "⚠ " + e.message; }
    };
    return h("div.ae-blk", ta, h("div.ae-row", voice, emo, lang), h("div.ae-row", go), out);
  }

  // nom lisible d'un son importe : « assets/20261014-213603-cd31-maxime-33.mp3 » -> « maxime-33.mp3 »
  const niceName = (o) => (o && (o.name || (o.file || "").split("/").pop().replace(/^\d{8}-\d{6}-[0-9a-f]{4}-/, ""))) || "";

  function tabSound(box) {
    const c = cur, st = c.st, p = st.p, panel = c.panel || {}, pg = C.B.pages[c.i];
    const vol = (key, get, set) => slider("Volume", get, (v) => { set(v); P.setLayerVolume(st, key, v); },
                                          { min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100) + " %" });
    const block = (title, name, ...kids) => h("div.ae-snd", h("div.ae-sndh", h("b", title), h("small", name || "")), ...kids);
    const replaceBtn = (layer, label) => h("button.ae-btn", { title: "Importer un autre fichier à la place", on: { click: () => pickAudio(async (f) => {
      try {
        await sendSound(`/api/projects/${c.pid}/panels/${c.id}/sound?layer=${layer}&name=${encodeURIComponent(f.name)}`, f);
        await saveEdit(c.i, c.id, {}, { sounds: c.id });
        toast(`${label} remplacé.`);
      } catch (e) { toast("⚠ " + e.message); }
    }) } }, "📁 Remplacer");
    const removeBtn = (layer, label) => h("button.ae-btn", { on: { click: async () => {
      if (!(await confirmBox(`Retirer ${label} de la case ?`, ["Le fichier reste dans le projet : tu pourras le remettre."], "Retirer"))) return;
      try { await setLayer(c, layer, { mode: "none" }); toast(`${label} retiré.`); } catch (e) { toast("⚠ " + e.message); }
    } } }, "✕ Retirer");
    if (p.audio) {
      const a = panel.audio || {};
      box.append(block("Son 1 · ambiance / musique", a.name || (a.mode === "generate" ? "généré (MiniMax Music)" : ""),
        vol("audio", () => p.audioVol ?? 1, (v) => { p.audioVol = v; queue({ volumes: { audio: v } }); }),
        h("div.ae-row", replaceBtn("audio", "Son 1"), removeBtn("audio", "le son 1")),
        regenSoundForm("audio", "Régénérer ce son (MiniMax Music)", "Ex. : drone grave et lent, cordes lointaines, vent", a.file)));
    }
    // voix off : le MP3 de David (joue depuis le debut a chaque survol), en premier ; la voix IA reste en option
    const v = panel.voice || {};
    const loadVoice = async (f2, zone) => {
      if (!f2) return;
      if (zone) zone.textContent = "envoi de " + f2.name + "…";
      try {
        await sendSound(`/api/projects/${c.pid}/panels/${c.id}/sound?layer=voice&name=${encodeURIComponent(f2.name)}`, f2);
        await saveEdit(c.i, c.id, {}, { sounds: c.id });
        toast(`Voix off chargée : ${f2.name}. Elle part du début à chaque survol de la case.`, 4500);
      } catch (e) { if (zone) zone.textContent = "⚠ " + e.message; else toast("⚠ " + e.message); }
    };
    const dropTarget = (el, fn) => {
      el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
      el.addEventListener("dragleave", () => el.classList.remove("over"));
      el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("over"); fn(e.dataTransfer.files[0]); });
    };
    const ttsBox = h("details.ae-regen", h("summary", "ou générer une voix off IA (fal)"), voiceForm(c, v));
    if (p.voice) {
      const kind = v.mode === "tts" ? "voix IA" : v.mode === "music" ? "musique générée" : "";
      const once = h("input", { type: "checkbox", checked: !p.voice.loop });
      once.onchange = async () => {
        try { await setLayer(c, "voice", Object.assign({}, v, { loop: !once.checked })); }
        catch (e) { toast("⚠ " + e.message); }
      };
      const vb = block("🎙 Voix off", (v.mode === "tts" ? (v.text || "").slice(0, 50) : niceName(v)) + (kind ? ` (${kind})` : ""),
        vol("voice", () => p.voice.vol ?? 1, (x) => { p.voice.vol = x; queue({ volumes: { voice: x } }); }),
        h("label.ae-chk", once, "une fois à chaque survol, depuis le début (décoché : en boucle)"),
        h("div.ae-row",
          h("button.ae-btn.ae-main", { on: { click: () => pickAudio((f2) => loadVoice(f2)) } }, "📁 Charger une autre voix off"),
          removeBtn("voice", "la voix off")),
        h("p.ae-note", "Ou glisser un MP3 sur ce cadre."),
        v.mode === "music" ? regenSoundForm("voice", "Régénérer cette musique", "Décris la musique voulue", v.file) : null,
        ttsBox);
      vb.classList.add("ae-voice");
      dropTarget(vb, (f2) => loadVoice(f2));
      box.prepend(vb);
    } else {
      const vz = h("div.ae-drop.ae-voice", "🎙 Charger une voix off (MP3) : glisser le fichier ici, ou cliquer");
      vz.onclick = () => pickAudio((f2) => loadVoice(f2, vz));
      dropTarget(vz, (f2) => loadVoice(f2, vz));
      box.prepend(h("div.ae-snd", h("div.ae-sndh", h("b", "🎙 Voix off"), h("small", "aucune")), vz, ttsBox));
    }
    if (p.foley) {
      const fo = panel.foley || {}, h3 = (fo.engine || "h3") === "h3";
      box.append(block("Bruitages", h3 ? "piste son de la vidéo H3" : fo.engine,
        vol("foley", () => p.foley.vol ?? 1, (x) => { p.foley.vol = x; queue({ volumes: { foley: x } }); }),
        h3 ? h("p.ae-note", "Ces bruitages sortent de la vidéo : régénérer la séquence pour les changer.")
           : regenSoundForm("foley", "Régénérer les bruitages (fal)", "Ex. : pas sur le gravier, porte qui grince", fo.file)));
    }
    const extras = panel.extraSounds || [];
    const extraList = (skip) => extras.filter((_, k) => k !== skip).map((e) => ({ file: e.file, volume: e.volume, loop: e.loop }));
    (p.more || []).forEach((x, i) => {
      const ex = extras[i] || {};
      const loop = h("input", { type: "checkbox", checked: x.loop });
      const send = () => queue({ extra: extras.map((e, k) => ({ file: e.file, volume: k === i ? x.vol : (p.more[k] || {}).vol ?? e.volume,
                                                               loop: k === i ? loop.checked : e.loop })) });
      loop.onchange = () => { x.loop = loop.checked; send(); };
      const asVoice = h("button.ae-btn", { title: "Ce son est une voix off : il passe dans la voix off de la case (une fois à chaque survol)",
                                            on: { click: async () => {
        if (p.voice && !(await confirmBox("Remplacer la voix off actuelle ?", [`« ${niceName(v) || "voix off"} » sera remplacée par « ${niceName(ex) || "ce son"} ».`],
                                          "Remplacer"))) return;
        try {
          await api(`/api/projects/${c.pid}/panels/${c.id}`, { voice: { mode: "file", file: ex.file, name: ex.name, volume: 1, loop: false } });
          await saveEdit(c.i, c.id, { extra: extraList(i) }, { sounds: c.id });
          toast("C'est maintenant la voix off de la case.");
        } catch (e) { toast("⚠ " + e.message); }
      } } }, "🎙 En faire la voix off");
      box.append(block(`Son ajouté ${i + 1}`, niceName(ex),
        slider("Volume", () => x.vol, (v2) => { x.vol = v2; P.setLayerVolume(st, "more" + i, v2); send(); },
               { min: 0, max: 1, step: 0.01, fmt: (v2) => Math.round(v2 * 100) + " %" }),
        h("label.ae-chk", loop, "en boucle (sinon : une fois à chaque survol)"),
        h("div.ae-row", asVoice,
          h("button.ae-btn", { on: { click: () => { queue({ extra: extraList(i) }); flush(); } } }, "✕ Retirer"))));
    });
    // ajouter un autre son (ambiance, bruitage...) par-dessus ceux qui existent
    const drop = h("div.ae-drop", "＋ Ajouter un autre son (ambiance, bruitage…), en boucle : glisser un fichier ici, ou cliquer");
    const upload = async (f2) => {
      if (!f2) return;
      drop.textContent = "envoi de " + f2.name + "…";
      try {
        await sendSound(`/api/projects/${c.pid}/panels/${c.id}/sound?layer=extra&name=${encodeURIComponent(f2.name)}`, f2);
        await saveEdit(c.i, c.id, {}, { sounds: c.id });
        toast("Son ajouté : il joue en boucle au survol de la case, avec les autres.");
      } catch (e) { drop.textContent = "⚠ " + e.message; }
    };
    drop.onclick = () => pickAudio(upload);
    dropTarget(drop, upload);
    box.append(drop);
    // musique de la page
    const ps = (c.project && c.project.pageSound) || {}, inst = C.inst();
    const replacePage = h("button.ae-btn", { on: { click: () => pickAudio(async (f) => {
      try {
        await sendSound(`/api/projects/${c.pid}/upload?kind=page&name=${encodeURIComponent(f.name)}`, f);
        await refreshPage(c);
        toast("Musique de la page en place.");
      } catch (e) { toast("⚠ " + e.message); }
    }) } }, pg.data.sound ? "📁 Remplacer la musique" : "📁 Importer une musique");
    const removePage = h("button.ae-btn", { on: { click: async () => {
      if (!(await confirmBox("Retirer la musique de la page ?", ["Le fichier reste dans le projet."], "Retirer"))) return;
      try {
        await api(`/api/projects/${c.pid}/update`, { pageSound: { mode: "none" } });
        await refreshPage(c);
      } catch (e) { toast("⚠ " + e.message); }
    } } }, "✕ Retirer");
    if (pg.data.sound && inst.global) {
      box.append(block("Musique de la page", (ps.name || (ps.mode === "generate" ? "générée (MiniMax Music)" : "")),
        slider("Volume", () => inst.global.vol, (x) => { P.setGlobalVolume(inst, x); pg.data.sound.vol = x; queue({ pageVolume: x }); },
               { min: 0, max: 1, step: 0.01, fmt: (x) => Math.round(x * 100) + " %" }),
        h("div.ae-row", replacePage, removePage),
        regenSoundForm("page", ps.mode === "generate" ? "Régénérer la musique (MiniMax Music)" : "Remplacer par une musique générée (MiniMax Music)",
                       "Décris la musique voulue", ps.file),
        h("p.ae-note", "Elle baisse toute seule quand une case joue ses sons.")));
    } else {
      box.append(block("Musique de la page", "aucune", h("div.ae-row", replacePage),
        regenSoundForm("page", "Générer une musique (MiniMax Music)", "Décris la musique voulue", null)));
    }
  }

  // ------------------------------------------------------------------ regenerer la sequence
  // ------------------------------------------------------------------ relief
  const RELIEF_MOVES = [["respire", "Respire", "petite avancée vers le sujet puis retour"],
                        ["glisse", "Glisse", "travelling latéral aller-retour"],
                        ["tourne", "Tourne", "petit cercle de caméra autour du sujet"],
                        ["vertigo", "Vertigo", "le sujet garde sa taille, le fond s'éloigne"]];
  function changeRelief(k, v) {
    (cur.reliefTouched = cur.reliefTouched || new Set()).add(k);
    cur.relief[k] = v;
    P.setRelief(cur.st, { [k]: v });
    queue({ relief: true });
  }
  function tabRelief(box) {
    const r = cur.relief;
    box.append(h("div.ae-row", RELIEF_MOVES.map(([id, label, hint]) => h("button.ae-btn" + (r.preset === id ? ".ae-main" : ""),
      { title: hint, on: { click: () => { changeRelief("preset", id); P.reliefPlay(cur.st); renderTab(); } } }, label))));
    box.append(slider("Amplitude", () => r.amount ?? 0.025, (v) => changeRelief("amount", v),
      { min: 0.005, max: 0.06, step: 0.001, neutral: 0.025, fmt: (v) => fmt(v * 100, 1) + " %" }));
    box.append(slider("Plan net", () => r.focus ?? 0.7, (v) => changeRelief("focus", v),
      { min: 0, max: 1, step: 0.01, fmt: (v) => v < 0.33 ? `${fmt(v)} (fond)` : v > 0.66 ? `${fmt(v)} (devant)` : fmt(v) }));
    box.append(slider("Durée", () => r.duration ?? 2, (v) => changeRelief("duration", v),
      { min: 1, max: 5, step: 0.1, fmt: (v) => fmt(v, 1) + " s" }));
    const trig = h("select", {}, h("option", { value: "hover" }, "Au survol (en boucle douce)"), h("option", { value: "click" }, "Au clic (un tour)"));
    trig.value = r.trigger || "hover";
    trig.onchange = () => changeRelief("trigger", trig.value);
    box.append(h("label.ae-sl", h("span.ae-lab", "Déclenchement"), trig, h("span.ae-val")));
    box.append(h("p.ae-note", "Le plan net ne bouge pas : le premier plan et le fond partent en sens contraires. Le mettre sur les visages " +
                 "évite toute déformation. Cheveux, voiles, vitres : rester sous 3 % d'amplitude. Glisser dans la case la fait aussi bouger."));
    const lay = h("div.ae-lay");
    box.append(lay);
    paintLayers(cur, lay);
  }

  // relief en couches : etat, calcul / relance, utilisation. Le suivi de la tache vit avec le popup (pas avec l'onglet) :
  // quand elle finit, la case se met a jour meme si un autre onglet est ouvert ; une requete ratee est reessayee.
  const layersUsed = (pn) => pn.couches === true || (pn.couches !== false && pn.review !== "ok");   // comme app/layers.py
  function syncReliefFocus(c) {             // plan net automatique (non choisi) : celui des couches, pour le curseur
    if ((c.reliefTouched && c.reliefTouched.has("focus")) || "focus" in (c.relief0Saved || {})) return;
    const z = (c.st.p.depth || {}).focus;
    if (z == null || z === c.relief.focus) return;
    c.relief.focus = c.relief0.focus = z;
    if (lastTab === "relief" && cur === c) renderTab();
  }
  async function refreshLayers(c) {
    flush();                                // retouches en attente d'abord (sinon l'apercu les perdrait)
    await saveEdit(c.i, c.id, {}, { relief: c.id });
    syncReliefFocus(c);
  }
  async function paintLayers(c, el, quiet) {
    clearTimeout(c.layTimer);
    if (cur !== c) return;
    let r;
    try { r = await api(`/api/projects/${c.pid}/layers/${c.id}`); }
    catch (e) {
      if (cur !== c) return;
      if (el.isConnected) {
        const note = el.querySelector(".ae-note");
        if (note) note.textContent = "⚠ " + e.message + (c.layJob ? " (nouvel essai dans 5 s)" : "");
        else el.textContent = "⚠ " + e.message;
      }
      if (c.layJob) c.layTimer = setTimeout(() => paintLayers(c, el, true), 5000);
      return;
    }
    if (cur !== c) return;
    const job = r.job && ["queued", "running"].includes(r.job.status) ? r.job : null, m = r.meta;
    const finished = !job && c.layJob && r.job && r.job.id === c.layJob;
    const on = layersUsed(c.panel || {}), shown = !!((c.st.p.depth || {}).layers);     // dans l'export de la page
    if (el.isConnected) {
      let line;
      if (job) line = job.status === "queued" ? "⏳ En file d'attente (une machine libre avec les modèles des couches)…"
                                              : `⚙ Calcul sur ${job.worker} : ${job.progress || "en cours"}…`;
      else if (m && m.n > 0) line = `✓ ${m.n} sujet${m.n > 1 ? "s" : ""} détouré${m.n > 1 ? "s" : ""} + le fond reconstruit` +
                                    (m.n > 1 ? (m.groups === "profondeur" ? " (devant / derrière selon la profondeur)"
                                                                          : " (devant / derrière vus par l'IA)") : "")
                                    + (m.crowd ? " · foule : seul le premier plan est détaché" : "")
                                    + (on ? "" : (c.panel || {}).review === "ok" && (c.panel || {}).couches == null
                                         ? " · case validée : cocher pour les utiliser" : " · non utilisées (nappe simple)")
                                    + (m.last_try ? ` · dernier essai raté (${m.last_try.reason}), couches précédentes gardées` : "");
      else if (m) line = "✗ Pas de couches : " + (m.reason || "découpe impossible") + ". La case garde la nappe simple.";
      else line = r.possible ? "Pas encore calculées : la case utilise la nappe simple (elle peut onduler au bord des sujets)."
                             : "Aucune machine n'a les modèles des couches (SAM 3.1, Qwen-Image-Edit) : la case garde la nappe simple.";
      const go = h("button.ae-btn" + (m ? "" : ".ae-main"), { disabled: !!job || !r.possible,
        title: "SAM 3.1 détoure chaque personne, Qwen-Image-Edit reconstruit le décor caché, puis l'app découpe les calques (~1 min)" },
        m ? "↻ Recalculer (autre essai)" : "🧩 Calculer les couches");
      go.onclick = async () => {
        go.disabled = true;
        try {
          const res = await api(`/api/projects/${c.pid}/layers/${c.id}`, {});
          c.layJob = ((res.jobs || [])[0] || {}).id || c.layJob;
          toast("Couches en calcul sur tes machines (environ 1 min).");
        } catch (e) { toast("⚠ " + e.message); }
        paintLayers(c, el, true);
      };
      const use = h("input", { type: "checkbox", checked: on });
      use.onchange = async () => {
        use.disabled = true;
        try {
          flush();
          await saveEdit(c.i, c.id, { couches: use.checked }, { relief: c.id });
          syncReliefFocus(c);
          status(use.checked ? "✓ couches utilisées" : "✓ nappe simple");
        } catch (e) { status("⚠ " + e.message, true); }
        paintLayers(c, el, true);
      };
      el.textContent = "";
      el.append(h("b", "Relief en couches (sans dédoublement)"), h("p.ae-note", line),
                h("div.ae-row", go, m && m.n > 0 ? h("label.ae-check", use, " Utiliser les couches") : null));
    }
    if (job) {
      c.layJob = job.id;
      c.layTimer = setTimeout(() => paintLayers(c, el, true), 3000);
      return;
    }
    if (finished) {                         // la tache vient de finir : la case se met a jour (une seule fois)
      c.layJob = null;
      if (r.job.status === "done" && m && m.n > 0 && on) {
        status("couches prêtes : mise à jour de la case…");
        try { await refreshLayers(c); if (cur === c) status("✓ couches en place"); }
        catch (e) { if (cur === c) status("⚠ " + e.message, true); }
        if (cur === c && el.isConnected) paintLayers(c, el, true);
      } else if (r.job.status === "error") status("⚠ couches : " + (r.job.error || "erreur"), true);
      return;
    }
    if (!quiet && m && m.n > 0 && on && !shown) {      // couches pretes mais pas encore dans l'export de la page
      try { await refreshLayers(c); } catch (_) { /* rien : l'apercu suivant les montrera */ }
    }
  }
  function tabTreat(box) {
    const c = cur, n = ((c.panel || {}).renders || []).length;
    box.append(h("p", "Cette case est une photo en relief : une carte de profondeur, aucun calcul vidéo."));
    box.append(h("p.ae-note", n ? `Elle a déjà ${n} rendu(s) H3 : en repassant en vidéo, le dernier choisi s'affiche tout de suite.`
                                : "En vidéo H3, la case sera calculée sur les machines (quelques minutes) ; elle reste en relief en attendant."));
    const go = h("button.ae-btn.ae-main", "🎬 Passer en vidéo H3");
    go.onclick = async () => {
      go.disabled = true;
      try {
        await saveEdit(c.i, c.id, { treatment: "h3" });
        if (!n) {
          const res = await api(`/api/projects/${c.pid}/render`, { panels: [c.id], target: "local" });
          toast(res.errors && res.errors.length ? "⚠ " + res.errors.join(" ; ")
                                                : "Rendu H3 lancé : la case reste en relief jusqu'à ce qu'il soit prêt.", 6000);
        }
      } catch (e) { go.disabled = false; toast("⚠ " + e.message); }
    };
    box.append(h("div.ae-row", go));
  }

  function tabRegen(box) {
    const c = cur, panel = c.panel || {}, renders = panel.renders || [], chosen = panel.chosen || {};
    // traitement : cette case peut devenir une photo en relief (instantane, sans video)
    const toRelief = h("button.ae-btn", { title: "Carte de profondeur calculée en ~1 s ; la vidéo reste dans le projet" }, "🏔 Passer en relief");
    toRelief.onclick = async () => {
      toRelief.disabled = true;
      try { await saveEdit(c.i, c.id, { treatment: "relief" }); toast("Case en relief : la vidéo H3 reste disponible (onglet « Vidéo H3 »)."); }
      catch (e) { toRelief.disabled = false; toast("⚠ " + e.message); }
    };
    box.append(h("div.ae-row", h("span.ae-note", "Traitement : vidéo H3."), toRelief));
    const sides = [...new Set(renders.map(r => r.side))].filter(s => ["L", "V", "R"].includes(s));
    const SIDE = { V: "Vidéo", L: "Côté gauche", R: "Côté droit" };
    const prompts = {};
    const instr = h("textarea", { rows: 3, placeholder: "Ce que tu veux changer, en français. Ex. : le lecteur jette de petits " +
                                  "coups d'œil au mangeur ; plus de mouvement ; il ne se fige pas à la fin." });
    box.append(h("label.ae-blk", h("span.ae-lab", "Consigne"), instr));
    const pdet = h("details.ae-regen", h("summary", "Prompt exact envoyé à H3 (anglais, modifiable)"));
    for (const s of (sides.length ? sides : ["V"])) {
      const r = renders.find(x => x.file === chosen[s]);
      const ta = h("textarea", { rows: 4 });
      ta.value = ((panel.prompt_override || {})[s]) || (r && r.prompt) || "";
      ta.dataset.orig = ta.value;
      prompts[s] = ta;
      if (sides.length > 1) pdet.append(h("small", SIDE[s]));
      pdet.append(ta);
    }
    box.append(pdet);
    const same = h("input", { type: "checkbox" });
    const target = h("select", {}, h("option", { value: "local" }, "Machines locales"), h("option", { value: "fal" }, "fal (cloud, payant)"));
    const out = h("div.ae-jobs");
    const go = h("button.ae-btn.ae-main", "↻ Régénérer la séquence");
    go.onclick = async () => {
      const edited = {};
      for (const [s, ta] of Object.entries(prompts)) if (ta.value.trim() && ta.value !== ta.dataset.orig) edited[s] = ta.value.trim();
      go.disabled = true;
      out.textContent = instr.value.trim() ? "l'IA réécrit le prompt…" : "envoi…";
      const before = Object.assign({}, chosen);
      try {
        const res = await api(`/api/projects/${c.pid}/regen/${c.id}`,
                              { instruction: instr.value.trim(), prompts: edited, sameSeed: same.checked, target: target.value });
        for (const [s, t] of Object.entries(res.prompts || {})) if (prompts[s]) { prompts[s].value = t; prompts[s].dataset.orig = t; }
        if (instr.value.trim()) pdet.open = true;
        out.textContent = `en file (graine ${res.seed})…`;
        const ids = res.jobs.filter(j => j.kind === "video").map(j => j.id);
        watchJobs(c.pid, ids, (js) => { out.textContent = `graine ${res.seed} : ` + jobText(js); }, async (js) => {
          go.disabled = false;
          const err = js.find(j => j.status === "error");
          if (err) { out.textContent = "⚠ " + (err.error || "erreur de rendu"); return; }
          out.textContent = "rendu terminé : montage…";
          await saveEdit(c.i, c.id, { edit: Object.assign(editPayload(c), { range: undefined, start: undefined, xfade: undefined }) },
                         { video: c.id });
          const pj = await project(c.pid, true);
          const pn = pj.panels[c.id] || {};
          const nr = (pn.renders || []).slice(-1)[0];
          if (cur === c) {
            c.panel = pn;
            out.textContent = "";
            out.append(`✓ nouvelle version en place` + (nr && nr.motion != null ? ` (mouvement ${fmt(nr.motion)})` : "") + " ",
              h("button.ae-btn", { on: { click: () => useVersion(c, before) } }, "↺ Revenir à la précédente"));
          } else toast(`Case ${c.id} : nouvelle version en place.`);
        });
      } catch (e) { go.disabled = false; out.textContent = "⚠ " + e.message; }
    };
    box.append(h("div.ae-row", h("label.ae-chk", { title: "Même base (même graine) : pour ne changer qu'un détail" }, same, "même graine"),
                 target, go), out);
    // versions deja calculees
    if (renders.length) {
      const list = h("div.ae-versions");
      for (const s of sides) {
        for (const r of renders.filter(x => x.side === s).slice().reverse()) {
          const used = chosen[s] === r.file;
          const d = r.created ? new Date(r.created * 1000) : null;
          list.append(h("div.ae-ver" + (used ? ".on" : ""),
            h("span", `${sides.length > 1 ? SIDE[s] + " · " : ""}graine ${r.seed}` + (r.motion != null ? ` · mouvement ${fmt(r.motion)}` : "")
                      + (d ? ` · ${d.toLocaleDateString("fr-FR")} ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "")),
            r.motion != null && r.motion < 0.3 ? h("small.err", " presque immobile") : null,
            used ? h("b", "utilisée") : h("button.ae-btn", { on: { click: () => useVersion(c, { [s]: r.file }) } }, "Utiliser")));
        }
      }
      box.append(h("details.ae-regen", h("summary", `Versions déjà calculées (${renders.length})`), list));
    }
  }

  async function useVersion(c, files) {
    try {
      for (const [side, file] of Object.entries(files)) {
        if (["L", "V", "R"].includes(side)) await api(`/api/projects/${c.pid}/choose`, { panel: c.id, side, file });
      }
      await saveEdit(c.i, c.id, { edit: Object.assign(editPayload(c), { range: undefined, start: undefined, xfade: undefined }) },
                     { video: c.id });
      const pj = await project(c.pid, true);
      if (cur === c) { c.panel = pj.panels[c.id] || {}; renderTab(); status("✓ version changée"); }
    } catch (e) { toast("⚠ " + e.message); }
  }
})();
