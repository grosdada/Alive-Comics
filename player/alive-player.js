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
 *                voice?: {src, vol, loop}, foley?: {src, vol, sync}, more?: [{src, vol, loop}], fx? }] }
 * play?: "hover" (defaut) | "always" : les cases qui jouent seules ne bougent qu'au survol (demarrage et arret en
 * douceur), ou tout le temps.
 * sound?: {src, vol} = son global de la page : joue en continu (apres le premier geste, regle des
 * navigateurs), baisse de moitie pendant qu'un son de case joue, fondu en sortie de page.
 * Sons au survol : audio = ambiance en boucle ; voice = voix off (reprise du debut a chaque survol, ou
 * boucle) ; foley = bruitages, cales sur l'image affichee quand la case joue toute seule ; more = sons ajoutes.
 * fx (retouches, appliquees en direct, sans re-encoder la video) :
 *   shake {size % de la case, freq Hz, rot degres, seed} : tremble camera, qui avance quand l'image avance
 *   grade {sat, bright, contrast, temp -1..1, hue degres} ; frame {zoom, x, y} : cadrage dans la case
 *   range [debut, fin] : points de boucle ; xfade : images de fondu au point de boucle
 *   speed : vitesse ; bounce : aller-retour (true) / boucle (false) ; start : image de depart
 *
 * API : AlivePlayer.mount(conteneur, donnees, { base: "pages/p1/", gauge: false, stamp }) -> { destroy(), reset() }
 *       (gauge : affiche la tete de lecture au survol ; cachee par defaut ; stamp : anti-cache des fichiers)
 *       AlivePlayer.setBW(bool), AlivePlayer.setSound(bool), AlivePlayer.resetAll()
 *       Mode edition (apercu de l'application) : setEditHook(fn), addView, removeView, setFx, updatePanel,
 *       setLayerVolume, setGlobalVolume, seekTo, setPinned, setPanelSound.
 * Les videos doivent etre « tout-intra » (ffmpeg -g 1) pour un saut instantane.
 */
(function () {
  "use strict";
  const DECAY = 3.2;            // inertie : vitesse * exp(-3.2 t)
  const RESUME_MS = 4000;       // la lecture auto / la boucle au repos reprend 4 s apres le dernier geste
  const pages = new Set();      // pages montees
  let bwOn = false, soundOn = true, unlocked = false, lastTick = performance.now(), ticking = false;
  let editHook = null;          // mode edition : un clic sur une case l'ouvre dans l'editeur

  function node(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  const mod = (a, n) => ((a % n) + n) % n;
  const withStamp = (url, stamp) => stamp ? url + (url.includes("?") ? "&" : "?") + "v=" + stamp : url;

  // ---------------------------------------------------------------- une page
  function mount(container, M, opts) {
    opts = opts || {};
    const base = opts.base || "";
    const [PW, PH] = M.size;
    const fps = M.fps || 24;
    const pageEl = node("div", "ac-page", container);
    pageEl.classList.toggle("bw", bwOn);
    pageEl.classList.toggle("ac-show-gauge", !!opts.gauge);   // tete de lecture : seulement si demandee
    pageEl.classList.toggle("ac-editing", !!editHook);
    pageEl.style.aspectRatio = PW + " / " + PH;
    pageEl.style.setProperty("--ac-ratio", String(PW / PH));
    const bg = node("img", "ac-bg", pageEl);
    bg.src = base + M.page; bg.alt = opts.alt || ""; bg.draggable = false;
    const inst = { pageEl, panels: [], statics: [], fps, play: opts.play || M.play || "hover", data: M, base,
                   stamp: opts.stamp || "" };

    for (const p of M.panels) makePanel(inst, p, base, PW, PH);
    if (M.frames) {
      const fr = node("img", "ac-frames", pageEl);
      fr.src = base + M.frames; fr.alt = ""; fr.draggable = false;
    }
    if (M.sound) {
      const a = new Audio(withStamp(base + M.sound.src, inst.stamp));
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
    if (!p.video) {
      el.classList.add("static");
      const so = { p, inst, el, static: true };
      inst.statics.push(so);
      el.addEventListener("click", () => { if (editHook) editHook(so); });
      return;
    }
    const gauge = node("div", "ac-gauge", el);
    const dot = node("i", "", gauge);
    const wait = node("span", "ac-wait", el);
    wait.textContent = "chargement…";
    const st = { p, inst, el, dot, wait, gauge, pos: 0, vel: 0, drag: null, anim: null, views: [], dir: 1, base,
                 resumeAt: 0, src: withStamp(base + p.video, inst.stamp), over: false, speed: 0, shT: 0, lastPos: 0,
                 pinned: false, freeze: false, freeShake: false, pinSound: false };
    configure(st);
    st.pos = st.lastPos = st.home;
    addView(st, el, gauge);
    if (p.idle) {             // boucle au repos, camera fixe, par-dessus
      const iv = document.createElement("video");
      iv.className = "idle on"; iv.muted = true; iv.loop = true; iv.playsInline = true; iv.autoplay = true;
      iv.preload = "auto"; iv.src = base + p.idle;
      iv.addEventListener("playing", () => iv.classList.add("ready"));
      el.insertBefore(iv, gauge);
      st.idle = iv; st.idleOn = true;
    }
    buildLayers(st);
    // sons au survol, en fondu ; au doigt : la derniere case touchee
    el.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") soundOnPanel(st, true); });
    el.addEventListener("pointerleave", () => { if (!st.pinSound) soundOnPanel(st, false); });
    el.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch" && st.layers.length) toggleTouchAudio(st); });
    // animation au survol (souris) ; au doigt : la derniere case touchee joue
    el.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") st.over = true; });
    el.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") st.over = false; });
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      for (const i2 of pages) for (const o of i2.panels) o.over = false;
      st.over = true;
    });
    bindDrag(el, () => st);
    el.addEventListener("dblclick", () => { if (!editHook) openLightbox(st); });
    inst.panels.push(st);
  }

  // reglages derives des donnees et des retouches (fx) : plage d'images, boucle, vitesse, image de depart
  function configure(st) {
    const p = st.p, fx = p.fx || {}, n = Math.max(2, p.frames || 2);
    st.loopMode = typeof fx.bounce === "boolean" ? !fx.bounce : !!p.loop;
    let a = 0, b = n - 1;
    if (Array.isArray(fx.range)) {
      a = Math.max(0, Math.min(n - 2, fx.range[0] | 0));
      b = Math.max(a + 1, Math.min(n - 1, fx.range[1] | 0));
    }
    st.a = a; st.b = b;
    st.xf = st.loopMode ? Math.max(0, Math.min(fx.xfade | 0, Math.floor((b - a) / 2) - 1)) : 0;
    st.lo = a + st.xf;
    st.period = Math.max(1, b - st.lo);
    st.rate = fx.speed > 0 ? fx.speed : 1;
    const h = fx.start != null ? fx.start : (p.center || 0);
    st.home = st.loopMode ? (h >= st.lo && h < b ? h : st.lo) : Math.max(a, Math.min(b, h));
    if (!st.loopMode) st.pos = Math.max(a, Math.min(b, st.pos));
    // tremble : phases tirees de la graine ; marge de zoom pour ne jamais montrer les bords
    const r = (p.rect[2] - p.rect[0]) / Math.max(1, p.rect[3] - p.rect[1]);
    st.aspect = Math.max(r, 1 / r);
    let s = ((fx.shake && fx.shake.seed) | 0) + 0x9e3779b9;
    const rnd = () => {        // mulberry32
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    st.phases = Array.from({ length: 8 }, () => rnd() * Math.PI * 2);
    const g = fx.grade || {};
    const f = [];
    if (g.sat != null && g.sat !== 1) f.push(`saturate(${g.sat})`);
    if (g.bright != null && g.bright !== 1) f.push(`brightness(${g.bright})`);
    if (g.contrast != null && g.contrast !== 1) f.push(`contrast(${g.contrast})`);
    if (g.hue) f.push(`hue-rotate(${g.hue}deg)`);
    st.filter = f.join(" ");
    const t = +g.temp || 0;
    st.tint = t ? [t > 0 ? "rgb(255,138,40)" : "rgb(40,120,255)", Math.min(1, Math.abs(t) * 0.55)] : ["transparent", 0];
  }

  function transformOf(st) {
    const fx = st.p.fx || {}, sh = fx.shake, fr = fx.frame;
    let s = 1, dx = 0, dy = 0, rot = 0;
    if (sh && (sh.size > 0 || sh.rot > 0)) {
      const w = 2 * Math.PI * (sh.freq || 0.2) * st.shT, ph = st.phases, a = sh.size || 0;
      dx = a * (0.62 * Math.sin(w + ph[0]) + 0.28 * Math.sin(2.13 * w + ph[1]) + 0.10 * Math.sin(3.71 * w + ph[2]));
      dy = a * (0.62 * Math.sin(1.07 * w + ph[3]) + 0.28 * Math.sin(1.93 * w + ph[4]) + 0.10 * Math.sin(3.29 * w + ph[5]));
      rot = (sh.rot || 0) * (0.7 * Math.sin(0.83 * w + ph[6]) + 0.3 * Math.sin(1.71 * w + ph[7]));
      const th = (sh.rot || 0) * Math.PI / 180;
      s = (Math.cos(th) + st.aspect * Math.sin(th)) * (1 + 2 * a / 100);
    }
    let z = 1, tx = 0, ty = 0;
    if (fr && fr.zoom > 1) {
      z = fr.zoom;
      tx = -(fr.x || 0) * (z - 1) / 2 * 100;
      ty = -(fr.y || 0) * (z - 1) / 2 * 100;
    }
    if (s === 1 && z === 1) return "";
    return `translate(${(tx + dx).toFixed(3)}%, ${(ty + dy).toFixed(3)}%) rotate(${rot.toFixed(4)}deg) scale(${(z * s).toFixed(4)})`;
  }

  function applyFx(st, force) {
    const T = transformOf(st);
    if (force || T !== st._T) {
      st._T = T;
      for (const vw of st.views) for (const t of [vw.main, vw.xt]) if (t) t.v.style.transform = T;
    }
    if (force || st.filter !== st._F) {
      st._F = st.filter;
      for (const vw of st.views) for (const t of [vw.main, vw.xt]) if (t) t.v.style.filter = st.filter;
    }
    const tint = st.tint.join("|");
    if (force || tint !== st._tint) {
      st._tint = tint;
      for (const vw of st.views) { vw.tint.style.background = st.tint[0]; vw.tint.style.opacity = st.tint[1]; }
    }
  }

  // ---------------------------------------------------------------- vues d'une case (case, agrandissement, editeur)
  function makeTrack(st, v, vw, main) {
    const t = { v, shown: -1, want: -1, busy: false, target: 0 };
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.setAttribute("playsinline", ""); v.src = st.src;
    v.addEventListener("seeked", () => {
      t.busy = false; t.shown = t.want;
      if (main) v.classList.add("ready");
      if (main && st.wait && vw === st.views[0]) { st.wait.remove(); st.wait = null; }
      seek(st, t, t.target);       // rattrape la position si elle a bouge pendant le saut
    });
    v.addEventListener("loadedmetadata", () => { t.shown = -1; t.busy = false; seek(st, t, t.target); });
    return t;
  }

  function addView(st, host, before) {
    const vw = { host };
    const v = document.createElement("video");
    host.insertBefore(v, before || null);
    vw.main = makeTrack(st, v, vw, true);
    vw.main.target = idxOf(st);
    vw.tint = document.createElement("div");
    vw.tint.className = "ac-tint";
    host.insertBefore(vw.tint, before || null);
    st.views.push(vw);
    v.style.transform = st._T || ""; v.style.filter = st.filter || "";
    vw.tint.style.background = st.tint[0]; vw.tint.style.opacity = st.tint[1];
    if (st.xf) ensureX(st, vw);
    return vw;
  }

  function ensureX(st, vw) {      // seconde video pour le fondu au point de boucle
    if (vw.xt) return vw.xt;
    const x = document.createElement("video");
    x.className = "ac-x";
    x.style.opacity = 0;
    vw.host.insertBefore(x, vw.tint);
    vw.xt = makeTrack(st, x, vw, false);
    x.style.transform = st._T || ""; x.style.filter = st.filter || "";
    return vw.xt;
  }

  function removeView(st, vw) {
    st.views = st.views.filter(o => o !== vw);
    for (const t of [vw.main, vw.xt]) if (t) { t.v.removeAttribute("src"); t.v.load(); t.v.remove(); }
    vw.tint.remove();
  }

  function seek(st, t, idx) {
    t.target = idx;
    if (t.busy || idx === t.shown || t.v.readyState < 1) return;
    t.want = idx; t.busy = true;
    t.v.currentTime = (idx + 0.5) / st.inst.fps;
  }

  // ---------------------------------------------------------------- gestes
  function bindDrag(target, getSt) {
    target.addEventListener("pointerdown", (e) => {
      const st = getSt();
      if (e.button !== 0 || !st) return;
      try { target.setPointerCapture(e.pointerId); } catch (_) { /* pointeur deja relache */ }
      st.anim = null; st.vel = 0;
      if (st.idle && st.idleOn) { st.idleOn = false; st.idle.classList.remove("on"); st.idle.pause(); }
      st.drag = { x: e.clientX, y: e.clientY, t: performance.now(), pos: st.pos, w: target.getBoundingClientRect().width,
                  hist: [[performance.now(), st.pos]], target };
      st.el.classList.add("active");
    });
    target.addEventListener("pointermove", (e) => {
      const st = getSt();
      if (!st || !st.drag) return;
      const d = st.drag;
      st.pos = clampPos(d.pos + (e.clientX - d.x) / d.w * (st.b - st.a), st);
      d.hist.push([performance.now(), st.pos]);
      if (d.hist.length > 6) d.hist.shift();
      render(st);
    });
    const end = (e) => {
      const st = getSt();
      if (!st || !st.drag) return;
      const d = st.drag;
      const h = d.hist, a = h[0], b = h[h.length - 1];
      const dt = (b[0] - a[0]) / 1000;
      const max = (st.b - st.a) / 1.1;
      st.vel = dt > 0.01 ? Math.max(-max, Math.min(max, (b[1] - a[1]) / dt)) : 0;
      st.drag = null;
      st.resumeAt = performance.now() + RESUME_MS;
      st.el.classList.remove("active");
      // mode edition : un simple clic (pas un glisser) ouvre la case dans l'editeur
      if (editHook && e && e.type === "pointerup" && d.target === st.el && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6
          && performance.now() - d.t < 600) {
        st.vel = 0; st.pos = d.pos; st.resumeAt = 0;
        editHook(st);
      }
    };
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  function clampPos(pos, st) { return st.loopMode ? pos : Math.max(st.a, Math.min(st.b, pos)); }
  function frac(st) { return st.loopMode ? st.lo + mod(st.pos - st.lo, st.period) : Math.max(st.a, Math.min(st.b, st.pos)); }
  function idxOf(st) {
    let i = Math.round(frac(st));
    if (st.loopMode && i >= st.b) i = st.lo;
    return i;
  }

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
    if (st.freeShake) st.shT += dt;             // editeur : le tremble vit meme sur une image fixe
    if (st.anim) {
      const t = Math.min(1, (now - st.anim.t0) / 600), k = 1 - Math.pow(1 - t, 3);
      st.pos = st.anim.from + (st.home - st.anim.from) * k;
      if (t >= 1) st.anim = null;
    } else if (!st.drag && st.vel) {
      st.pos = clampPos(st.pos + st.vel * dt, st);
      st.vel *= Math.exp(-DECAY * dt);
      if (Math.abs(st.vel) < 0.5 || (!st.loopMode && (st.pos <= st.a || st.pos >= st.b))) st.vel = 0;
    } else if (st.idle && !st.idleOn && !st.drag && now > st.resumeAt) {
      if (Math.round(st.pos) !== st.home) st.anim = { from: st.pos, t0: now };
      else { st.idleOn = true; st.idle.classList.add("on"); st.idle.play().catch(() => {}); }
    } else if (st.p.autoplay && !st.drag && now > st.resumeAt) {
      // vitesse qui monte et descend en douceur : la case s'anime au survol et se fige quand on la quitte
      const active = !st.freeze && (st.inst.play === "always" || st.over || lb.st === st || st.pinned);
      st.speed += ((active ? 1 : 0) - st.speed) * Math.min(1, dt * (active ? 3 : 2.2));
      if ((st.speed < 0.004 && !active) || st.freeze) st.speed = 0;     // editeur : « figer l'image » = arret net
      const stp = fps * dt * st.speed * st.rate;
      if (st.loopMode) st.pos += stp;
      else {
        st.pos += st.dir * stp;
        if (st.pos >= st.b) { st.pos = st.b; st.dir = -1; }
        if (st.pos <= st.a) { st.pos = st.a; st.dir = 1; }
      }
    }
    render(st);
  }

  function render(st) {
    const f = frac(st), idx = idxOf(st);
    if (!st.anim) {                             // le tremble avance avec l'image (et se fige avec elle)
      const moved = Math.abs(st.pos - st.lastPos);
      if (moved < st.p.frames) st.shT += moved / st.inst.fps;
    }
    st.lastPos = st.pos;
    applyFx(st);
    if (st.hover) for (const L of st.layers || []) if (L.mode === "sync") syncLayer(st, L, false);
    st.dot.style.left = (idx - st.a) / Math.max(1, st.b - st.a) * 100 + "%";
    let xa = 0, xi = -1;
    if (st.xf) {
      const z = f - (st.b - st.xf);
      if (z > 0) { xa = Math.min(1, z / st.xf); xi = Math.min(st.lo, st.a + Math.round(z)); }
    }
    for (const vw of st.views) {
      seek(st, vw.main, idx);
      if (xi >= 0) ensureX(st, vw);
      if (vw.xt) {
        if (xi >= 0) seek(st, vw.xt, xi);
        const o = xi >= 0 && vw.xt.shown >= 0 ? xa.toFixed(3) : "0";
        if (vw.xt.v.style.opacity !== o) vw.xt.v.style.opacity = o;
      }
    }
  }

  function resetPage(inst) {
    const t0 = performance.now();
    for (const st of inst.panels) {
      st.vel = 0;
      let from = st.pos;
      if (st.loopMode) {                  // par le chemin le plus court
        from = st.lo + mod(from - st.lo, st.period);
        if (from - st.home > st.period / 2) from -= st.period;
        if (st.home - from > st.period / 2) from += st.period;
      }
      st.anim = { from, t0 };
    }
  }

  function destroyPage(inst) {
    if (lb.st && lb.st.inst === inst) closeLightbox();
    for (const st of inst.panels) {
      for (const vw of st.views.slice()) removeView(st, vw);
      if (st.idle) { st.idle.pause(); st.idle.removeAttribute("src"); st.idle.load(); }
      dropLayers(st);
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
  function buildLayers(st) {
    st.layers = [];
    const p = st.p, stamp = st.inst.stamp;
    const layer = (key, src, vol, mode) => {
      const a = new Audio(withStamp(st.base + src, stamp));
      a.loop = mode !== "once"; a.volume = 0; a.preload = "auto";
      st.layers.push({ key, a, vol: Math.max(0, Math.min(1, vol ?? 1)), mode, timer: null });
    };
    if (p.audio) layer("audio", p.audio, p.audioVol ?? 1, "loop");
    if (p.voice) layer("voice", p.voice.src, p.voice.vol, p.voice.loop ? "loop" : "once");
    if (p.foley) layer("foley", p.foley.src, p.foley.vol, p.foley.sync ? "sync" : "loop");
    (p.more || []).forEach((x, i) => layer("more" + i, x.src, x.vol, x.loop ? "loop" : "once"));
  }

  function dropLayers(st) {
    for (const L of st.layers || []) { clearInterval(L.timer); L.a.pause(); L.a.src = ""; }
    st.layers = [];
  }

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
    const back = st.p.autoplay && !st.loopMode && st.dir < 0;
    if (back || st.drag) { if (!L.a.paused) L.a.pause(); return; }
    const t = (idxOf(st) / st.inst.fps) % d;
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
    for (const st of inst.panels) for (const vw of st.views) {
      const v = vw.main.v;
      if (v.readyState < 1) {
        const pr = v.play();
        if (pr) pr.then(() => v.pause()).catch(() => {});
      }
    }
  }
  document.addEventListener("pointerdown", () => {
    if (unlocked) return;
    unlocked = true;
    for (const inst of pages) {
      unlockPage(inst); startGlobal(inst);
      for (const st of inst.panels) if (st.hover) setTimeout(() => soundOnPanel(st, true), 0);   // case deja survolee
    }
    document.dispatchEvent(new Event("alive-unlocked"));
  }, { capture: true });

  // ---------------------------------------------------------------- agrandissement
  const lb = { el: null, stage: null, vw: null, st: null };
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
    lb.stage.innerHTML = "";
    lb.stage.classList.toggle("bw", bwOn);
    lb.st = st; lb.vw = addView(st, lb.stage);
    lb.vw.main.v.classList.add("ready");
    lb.el.classList.add("open"); lb.el.setAttribute("aria-hidden", "false");
  }
  function closeLightbox() {
    if (!lb.st) return;
    removeView(lb.st, lb.vw);
    lb.stage.innerHTML = ""; lb.st = lb.vw = null;
    lb.el.classList.remove("open"); lb.el.setAttribute("aria-hidden", "true");
  }

  // ---------------------------------------------------------------- mode edition (apercu de l'application)
  function setEditHook(fn) {
    editHook = fn || null;
    for (const inst of pages) inst.pageEl.classList.toggle("ac-editing", !!editHook);
  }
  function setFx(st, fx) {
    st.p.fx = fx || undefined;
    configure(st);
    applyFx(st, true);
    render(st);
  }
  // nouvelle version de la case (rendu regenere, son remplace...) : sans demonter la page.
  // soundsOnly : la video n'a pas change (on garde sa position et son fichier)
  function updatePanel(st, entry, stamp, soundsOnly) {
    const src = soundsOnly && entry.video === st.p.video ? st.src : withStamp(st.base + entry.video, stamp);
    st.p = entry;
    if (src !== st.src) {
      st.src = src;
      for (const vw of st.views) for (const t of [vw.main, vw.xt]) if (t) { t.shown = -1; t.busy = false; t.v.src = src; }
    }
    configure(st);
    if (!soundsOnly) { st.pos = st.lastPos = st.home; st.vel = 0; st.anim = null; }
    const was = st.hover;
    dropLayers(st);
    const keep = st.inst.stamp;
    st.inst.stamp = stamp || keep;
    buildLayers(st);
    st.inst.stamp = keep;
    if (was) soundOnPanel(st, true);
    applyFx(st, true);
    render(st);
  }
  function setLayerVolume(st, key, vol) {
    const L = (st.layers || []).find(o => o.key === key);
    if (!L) return;
    L.vol = Math.max(0, Math.min(1, vol));
    if (st.hover && soundOn) fade(L, L.vol);
  }
  function setGlobalVolume(inst, vol) {
    if (!inst.global) return;
    inst.global.vol = Math.max(0, Math.min(1, vol));
    if (!inst.global.a.paused) fade(inst.global, duckedVolume(inst.global));
    else if (unlocked) startGlobal(inst);
  }
  function seekTo(st, frame) {
    st.anim = null; st.vel = 0;
    st.pos = clampPos(frame, st);
    st.resumeAt = performance.now() + 600;
    render(st);
  }
  function setPinned(st, on) { st.pinned = !!on; }
  function setPanelSound(st, on) { st.pinSound = !!on; soundOnPanel(st, !!on); }

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
  function hasAudio(M) { return !!M.sound || M.panels.some(p => p.audio || p.voice || p.foley || (p.more || []).length); }

  window.AlivePlayer = { isUnlocked: () => unlocked, mount, setBW, setSound, resetAll, hasAudio, isLightboxOpen: () => !!lb.st,
                         setEditHook, addView, removeView, setFx, updatePanel, setLayerVolume, setGlobalVolume, seekTo,
                         setPinned, setPanelSound, frameOf: idxOf, _pages: pages };
})();
