/* Alive-Comics : lecteur de pages animees.
 *
 * Une page = une image de fond (page.jpg) + des cases. Chaque case porte une video que le lecteur
 * ne « lit » pas : il saute a l'image voulue (video.currentTime). La position est pilotee par :
 *   - le glisser (toute la largeur de la case = toute la video), avec inertie ;
 *   - la lecture automatique (aller-retour, ou vers l'avant si la video boucle) ;
 *   - une boucle au repos optionnelle (seconde video jouee normalement) ;
 * plus un son au survol, en fondu.
 *
 * Donnees d'une page (format produit par Alive-Comics et par les scripts H3-Orbital) :
 *   { page: "page.jpg", frames: "frames.png"?, size: [W, H], fps: 24,
 *     panels: [{ id, rect: [x0,y0,x1,y1], poly?: [[x,y]...], video?, frames, center,
 *                loop?, autoplay?, idle?, audio?, audioVol?,
 *                voice?: {src, vol, loop}, foley?: {src, vol, sync} }] }
 * sound?: {src, vol} = son global de la page : joue en continu (apres le premier geste, regle des
 * navigateurs), baisse de moitie pendant qu'un son de case joue, fondu en sortie de page.
 * Sons au survol : audio = ambiance en boucle ; voice = voix off (reprise du debut a chaque survol, ou
 * boucle) ; foley = bruitages, cales sur l'image affichee quand la case joue toute seule.
 *
 * API : AlivePlayer.mount(conteneur, donnees, { base: "pages/p1/", gauge: false }) -> { destroy(), reset() }
 *       (gauge : affiche la tete de lecture au survol ; cachee par defaut)
 *       AlivePlayer.setBW(bool), AlivePlayer.setSound(bool), AlivePlayer.resetAll()
 * Les videos doivent etre « tout-intra » (ffmpeg -g 1) pour un saut instantane.
 */
(function () {
  "use strict";
  const DECAY = 3.2;            // inertie : vitesse * exp(-3.2 t)
  const RESUME_MS = 4000;       // la lecture auto / la boucle au repos reprend 4 s apres le dernier geste
  const pages = new Set();      // pages montees
  let bwOn = false, soundOn = true, unlocked = false, lastTick = performance.now(), ticking = false;

  function node(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  // ---------------------------------------------------------------- une page
  function mount(container, M, opts) {
    opts = opts || {};
    const base = opts.base || "";
    const [PW, PH] = M.size;
    const fps = M.fps || 24;
    const pageEl = node("div", "ac-page", container);
    pageEl.classList.toggle("bw", bwOn);
    pageEl.classList.toggle("ac-show-gauge", !!opts.gauge);   // tete de lecture : seulement si demandee
    pageEl.style.aspectRatio = PW + " / " + PH;
    pageEl.style.setProperty("--ac-ratio", String(PW / PH));
    const bg = node("img", "ac-bg", pageEl);
    bg.src = base + M.page; bg.alt = opts.alt || ""; bg.draggable = false;
    const inst = { pageEl, panels: [], fps };

    for (const p of M.panels) makePanel(inst, p, base, PW, PH);
    if (M.frames) {
      const fr = node("img", "ac-frames", pageEl);
      fr.src = base + M.frames; fr.alt = ""; fr.draggable = false;
    }
    if (M.sound) {
      const a = new Audio(base + M.sound.src);
      a.loop = true; a.volume = 0; a.preload = "auto";
      inst.global = { a, vol: Math.max(0, Math.min(1, M.sound.vol ?? 0.7)), timer: null, mode: "loop" };
      if (unlocked && soundOn) startGlobal(inst);
    }
    inst.reset = () => resetPage(inst);
    inst.destroy = () => destroyPage(inst);
    pages.add(inst);
    startTick();
    if (unlocked) unlockPage(inst);
    return inst;
  }

  function makePanel(inst, p, base, PW, PH) {
    const el = node("div", "ac-panel", inst.pageEl);
    const [x0, y0, x1, y1] = p.rect;
    Object.assign(el.style, { left: x0 / PW * 100 + "%", top: y0 / PH * 100 + "%",
                              width: (x1 - x0) / PW * 100 + "%", height: (y1 - y0) / PH * 100 + "%" });
    if (p.poly) {             // case penchee : la video prend la forme du cadre
      const pts = p.poly.map(([x, y]) => `${(x - x0) / (x1 - x0) * 100}% ${(y - y0) / (y1 - y0) * 100}%`);
      el.style.clipPath = `polygon(${pts.join(", ")})`;
    }
    if (!p.video) { el.classList.add("static"); return; }
    const gauge = node("div", "ac-gauge", el);
    const dot = node("i", "", gauge);
    const wait = node("span", "ac-wait", el);
    wait.textContent = "chargement…";
    const st = { p, inst, el, dot, wait, pos: p.center || 0, vel: 0, drag: null, anim: null, videos: [], dir: 1,
                 resumeAt: 0, period: Math.max(1, p.frames - 1), src: base + p.video };
    st.addVideo = (v) => addVideo(st, v);
    st.addVideo(node("video", "", el));
    if (p.idle) {             // boucle au repos, camera fixe, par-dessus
      const iv = document.createElement("video");
      iv.className = "idle on"; iv.muted = true; iv.loop = true; iv.playsInline = true; iv.autoplay = true;
      iv.preload = "auto"; iv.src = base + p.idle;
      iv.addEventListener("playing", () => iv.classList.add("ready"));
      el.insertBefore(iv, gauge);
      st.idle = iv; st.idleOn = true;
    }
    // sons au survol, en fondu : jusqu'a trois couches
    st.layers = [];
    const layer = (src, vol, mode) => {
      const a = new Audio(base + src);
      a.loop = mode !== "once"; a.volume = 0; a.preload = "auto";
      st.layers.push({ a, vol: Math.max(0, Math.min(1, vol ?? 1)), mode, timer: null });
    };
    if (p.audio) layer(p.audio, p.audioVol ?? 1, "loop");
    if (p.voice) layer(p.voice.src, p.voice.vol, p.voice.loop ? "loop" : "once");
    if (p.foley) layer(p.foley.src, p.foley.vol, p.foley.sync ? "sync" : "loop");
    if (st.layers.length) {
      el.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") soundOnPanel(st, true); });
      el.addEventListener("pointerleave", () => soundOnPanel(st, false));
      el.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") toggleTouchAudio(st); });
    }
    bindDrag(el, () => st);
    el.addEventListener("dblclick", () => openLightbox(st));
    inst.panels.push(st);
  }

  function addVideo(st, v) {
    const rec = { v, fps: st.inst.fps, shown: -1, want: -1, busy: false };
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.setAttribute("playsinline", ""); v.src = st.src;
    v.addEventListener("seeked", () => {
      rec.busy = false; rec.shown = rec.want; v.classList.add("ready");
      if (rec === st.videos[0] && st.wait) { st.wait.remove(); st.wait = null; }
      seek(rec, wrap(Math.round(st.pos), st));     // rattrape la position si elle a bouge pendant le saut
    });
    v.addEventListener("loadedmetadata", () => { rec.shown = -1; rec.busy = false; seek(rec, wrap(Math.round(st.pos), st)); });
    st.videos.push(rec);
    return rec;
  }

  function seek(rec, idx) {
    if (rec.busy || idx === rec.shown || rec.v.readyState < 1) return;
    rec.want = idx; rec.busy = true;
    rec.v.currentTime = (idx + 0.5) / rec.fps;
  }

  // ---------------------------------------------------------------- gestes
  function bindDrag(target, getSt) {
    target.addEventListener("pointerdown", (e) => {
      const st = getSt();
      if (e.button !== 0 || !st) return;
      try { target.setPointerCapture(e.pointerId); } catch (_) { /* pointeur deja relache */ }
      st.anim = null; st.vel = 0;
      if (st.idle && st.idleOn) { st.idleOn = false; st.idle.classList.remove("on"); st.idle.pause(); }
      st.drag = { x: e.clientX, pos: st.pos, w: target.getBoundingClientRect().width, hist: [[performance.now(), st.pos]] };
      st.el.classList.add("active");
    });
    target.addEventListener("pointermove", (e) => {
      const st = getSt();
      if (!st || !st.drag) return;
      const d = st.drag;
      st.pos = clamp(d.pos + (e.clientX - d.x) / d.w * (st.p.frames - 1), st);
      d.hist.push([performance.now(), st.pos]);
      if (d.hist.length > 6) d.hist.shift();
      render(st);
    });
    const end = () => {
      const st = getSt();
      if (!st || !st.drag) return;
      const h = st.drag.hist, a = h[0], b = h[h.length - 1];
      const dt = (b[0] - a[0]) / 1000;
      const max = (st.p.frames - 1) / 1.1;
      st.vel = dt > 0.01 ? Math.max(-max, Math.min(max, (b[1] - a[1]) / dt)) : 0;
      st.drag = null;
      st.resumeAt = performance.now() + RESUME_MS;
      st.el.classList.remove("active");
    };
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  function clamp(pos, st) { return st.p.loop ? pos : Math.max(0, Math.min(st.p.frames - 1, pos)); }
  function wrap(idx, st) { return st.p.loop ? ((idx % st.period) + st.period) % st.period : idx; }

  // ---------------------------------------------------------------- animation
  function startTick() {
    if (ticking) return;
    ticking = true; lastTick = performance.now();
    requestAnimationFrame(tick);
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - lastTick) / 1000); lastTick = now;
    for (const inst of pages) for (const st of inst.panels) step(st, now, dt);
    if (pages.size) requestAnimationFrame(tick); else ticking = false;
  }

  function step(st, now, dt) {
    const fps = st.inst.fps;
    if (st.anim) {
      const t = Math.min(1, (now - st.anim.t0) / 600), k = 1 - Math.pow(1 - t, 3);
      st.pos = st.anim.from + ((st.p.center || 0) - st.anim.from) * k;
      if (t >= 1) st.anim = null;
    } else if (!st.drag && st.vel) {
      st.pos = clamp(st.pos + st.vel * dt, st);
      st.vel *= Math.exp(-DECAY * dt);
      if (Math.abs(st.vel) < 0.5 || (!st.p.loop && (st.pos <= 0 || st.pos >= st.p.frames - 1))) st.vel = 0;
    } else if (st.idle && !st.idleOn && !st.drag && now > st.resumeAt) {
      if (Math.round(st.pos) !== (st.p.center || 0)) st.anim = { from: st.pos, t0: now };
      else { st.idleOn = true; st.idle.classList.add("on"); st.idle.play().catch(() => {}); }
    } else if (st.p.autoplay && !st.drag && now > st.resumeAt) {
      if (st.p.loop) st.pos += fps * dt;
      else {
        st.pos += st.dir * fps * dt;
        if (st.pos >= st.p.frames - 1) { st.pos = st.p.frames - 1; st.dir = -1; }
        if (st.pos <= 0) { st.pos = 0; st.dir = 1; }
      }
    }
    render(st);
  }

  function render(st) {
    const idx = wrap(Math.round(st.pos), st);
    if (st.hover) for (const L of st.layers || []) if (L.mode === "sync") syncLayer(st, L, false);
    st.dot.style.left = idx / (st.p.frames - 1) * 100 + "%";
    for (const rec of st.videos) seek(rec, idx);
  }

  function resetPage(inst) {
    const t0 = performance.now();
    for (const st of inst.panels) {
      st.vel = 0;
      let from = st.pos;
      if (st.p.loop) {                    // par le chemin le plus court
        from = ((from % st.period) + st.period) % st.period;
        if (from > st.period / 2) from -= st.period;
      }
      st.anim = { from, t0 };
    }
  }

  function destroyPage(inst) {
    if (lb.st && lb.st.inst === inst) closeLightbox();
    for (const st of inst.panels) {
      for (const rec of st.videos) { rec.v.removeAttribute("src"); rec.v.load(); }
      if (st.idle) { st.idle.pause(); st.idle.removeAttribute("src"); st.idle.load(); }
      for (const L of st.layers || []) { clearInterval(L.timer); L.a.pause(); L.a.src = ""; }
    }
    if (inst.global) {                         // fondu de sortie, sans retenir la page
      const g = inst.global;
      fade(g, 0);
      setTimeout(() => { g.a.pause(); g.a.src = ""; }, 900);
    }
    inst.pageEl.remove();
    pages.delete(inst);
  }

  // ---------------------------------------------------------------- son
  function fade(L, target) {
    clearInterval(L.timer);
    L.timer = setInterval(() => {
      const v = L.a.volume + (target > L.a.volume ? 0.06 : -0.06);
      L.a.volume = Math.max(0, Math.min(1, v));
      if (Math.abs(L.a.volume - target) < 0.06) {
        L.a.volume = target; clearInterval(L.timer);
        if (target === 0) L.a.pause();
      }
    }, 30);
  }

  function startGlobal(inst) {
    const g = inst.global;
    if (!g || !soundOn) return;
    g.a.play().catch(() => {});
    fade(g, duckedVolume(g));
  }

  // le son global se fait discret pendant qu'une case joue ses sons
  function duckedVolume(g) {
    let busy = false;
    for (const inst of pages) for (const st of inst.panels) if (st.hover && (st.layers || []).length) busy = true;
    return busy ? g.vol * 0.45 : g.vol;
  }

  function reduckAll() {
    for (const inst of pages) if (inst.global && !inst.global.a.paused) fade(inst.global, duckedVolume(inst.global));
  }

  // allume / eteint les sons d'une case
  function soundOnPanel(st, on) {
    st.hover = on;
    setTimeout(reduckAll, 0);
    for (const L of st.layers || []) {
      if (on && soundOn) {
        if (L.mode === "once" && (L.a.paused || L.a.ended)) L.a.currentTime = 0;
        if (L.mode === "sync") syncLayer(st, L, true);
        L.a.play().catch(() => {});
        fade(L, L.vol);
      } else {
        fade(L, 0);
      }
    }
  }

  // bruitages : suivent l'image affichee (lecture auto vers l'avant) ; coupes pendant un retour en arriere
  function syncLayer(st, L, force) {
    const d = L.a.duration;
    if (!d || !isFinite(d)) return;
    const back = st.p.autoplay && !st.p.loop && st.dir < 0;
    if (back || st.drag) { if (!L.a.paused) L.a.pause(); return; }
    const t = (wrap(Math.round(st.pos), st) / st.inst.fps) % d;
    if (L.a.paused && st.hover && soundOn) L.a.play().catch(() => {});
    if (force || Math.abs(L.a.currentTime - t) > 0.25) L.a.currentTime = t;
  }

  // tactile : pas de survol, le son suit la derniere case touchee
  function toggleTouchAudio(st) {
    for (const inst of pages) for (const o of inst.panels) if (o !== st && o.hover) soundOnPanel(o, false);
    soundOnPanel(st, true);
  }

  // iOS / Android : les videos ne chargent qu'apres un premier geste
  function unlockPage(inst) {
    for (const st of inst.panels) for (const rec of st.videos) {
      if (rec.v.readyState < 1) {
        const pr = rec.v.play();
        if (pr) pr.then(() => rec.v.pause()).catch(() => {});
      }
    }
  }
  document.addEventListener("pointerdown", () => {
    if (unlocked) return;
    unlocked = true;
    for (const inst of pages) { unlockPage(inst); startGlobal(inst); }
  }, { capture: true });

  // ---------------------------------------------------------------- agrandissement
  const lb = { el: null, stage: null, rec: null, st: null };
  function ensureLightbox() {
    if (lb.el) return;
    lb.el = node("div", "ac-lightbox", document.body);
    lb.el.setAttribute("aria-hidden", "true");
    lb.stage = node("div", "ac-stage", lb.el);
    const hint = node("p", "", lb.el);
    hint.textContent = "Glisser pour bouger la caméra · Échap ou clic à côté pour fermer";
    bindDrag(lb.stage, () => lb.st);
    lb.el.addEventListener("click", (e) => { if (e.target === lb.el) closeLightbox(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });
  }
  function openLightbox(st) {
    ensureLightbox();
    closeLightbox();
    const v = document.createElement("video");
    lb.stage.innerHTML = ""; lb.stage.appendChild(v);
    lb.stage.classList.toggle("bw", bwOn);
    lb.st = st; lb.rec = st.addVideo(v);
    v.classList.add("ready");
    lb.el.classList.add("open"); lb.el.setAttribute("aria-hidden", "false");
  }
  function closeLightbox() {
    if (!lb.st) return;
    lb.st.videos = lb.st.videos.filter(r => r !== lb.rec);
    lb.rec.v.removeAttribute("src"); lb.rec.v.load();
    lb.stage.innerHTML = ""; lb.st = lb.rec = null;
    lb.el.classList.remove("open"); lb.el.setAttribute("aria-hidden", "true");
  }

  // ---------------------------------------------------------------- reglages globaux
  function setBW(on) {
    bwOn = !!on;
    for (const inst of pages) inst.pageEl.classList.toggle("bw", bwOn);
    if (lb.stage) lb.stage.classList.toggle("bw", bwOn);
  }
  function setSound(on) {
    soundOn = !!on;
    if (!soundOn) for (const inst of pages) for (const st of inst.panels) if (st.hover) soundOnPanel(st, false);
    for (const inst of pages) if (inst.global) { if (soundOn) startGlobal(inst); else fade(inst.global, 0); }
  }
  function resetAll() { for (const inst of pages) resetPage(inst); }
  function hasAudio(M) { return !!M.sound || M.panels.some(p => p.audio || p.voice || p.foley); }

  window.AlivePlayer = { mount, setBW, setSound, resetAll, hasAudio, isLightboxOpen: () => !!lb.st,
                         _pages: pages };
})();
