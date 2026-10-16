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
 *   shake {size % de la case, freq Hz, rot degres, seed} : tremble camera, fonction de la position dans la boucle :
 *         un nombre ENTIER de cycles entre le debut et la fin de boucle (freq arrondie), donc meme tremble au
 *         raccord quels que soient les reglages et les points de boucle ; il se fige avec l'image
 *   grade {sat, bright, contrast, temp -1..1, hue degres} ; frame {zoom, x, y} : cadrage dans la case
 *   range [debut, fin] : points de boucle ; xfade : images de fondu au point de boucle
 *   speed : vitesse ; bounce : aller-retour (true) / boucle (false) ; start : image de depart
 *   ease {head, tail, gain} : H3 freine au debut et a la fin de chaque boucle (pour retomber sur la 1re image) ;
 *         ces images-la sont jouees gain fois plus vite (rampe douce), sans couper : la boucle reste parfaite
 *
 * API : AlivePlayer.mount(conteneur, donnees, { base: "pages/p1/", gauge: false, stamp }) -> { destroy(), reset() }
 *       (gauge : affiche la tete de lecture au survol ; cachee par defaut ; stamp : anti-cache des fichiers)
 *       AlivePlayer.setBW(bool), AlivePlayer.setSound(bool), AlivePlayer.resetAll()
 *       Mode edition (apercu de l'application) : setEditHook(fn), addView, removeView, setFx, updatePanel,
 *       setLayerVolume, setGlobalVolume, seekTo, setPinned, setPanelSound.
 * Les videos doivent etre « tout-intra » (ffmpeg -g 1) pour un saut instantane.
 *
 * Cases en relief (depth: {img, map, preset, amount, focus, duration, trigger, layers?}) : pas de video, une photo et sa
 * carte de profondeur (blanc = proche). Un seul canevas WebGL par page (les navigateurs limitent le nombre de contextes) :
 * chaque case y est dessinee dans son polygone ; la camera bouge de quelques pour cent au survol (ou au clic) et suit
 * le glisser. Au repos, le dessin est identique a l'image de la page. Sans WebGL : l'image fixe, sans erreur.
 * Relief en couches (depth.layers: {bg, fg: [1 ou 2 RGBA, du plus loin au plus proche], ld}) : le fond sans les sujets
 * puis chaque sujet, chacun avec sa propre profondeur (ld : R = fond, G = fg[0], B = fg[1]) : aucun pli, donc aucun
 * bord dedouble ; ce qui etait cache derriere les sujets apparait quand la camera bouge.
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
    if (!p.video && p.depth) { makeRelief(inst, p, el, base); return; }
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
                 resumeAt: 0, src: withStamp(base + p.video, inst.stamp), over: false, speed: 0, shFree: 0, lastPos: 0,
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
    const ez = fx.ease;
    st.ease = ez && ez.gain > 1 && (ez.head > 0 || ez.tail > 0) ? { head: ez.head | 0, tail: ez.tail | 0, gain: +ez.gain } : null;
    const h = fx.start != null ? fx.start : (p.center || 0);
    st.home = st.loopMode ? (h >= st.lo && h < b ? h : st.lo) : Math.max(a, Math.min(b, h));
    if (!st.loopMode) st.pos = Math.max(a, Math.min(b, st.pos));
    // ralentis acceleres : temps joue cumule image par image (le tremble suit le temps, pas les images)
    st.tmap = null;
    if (st.ease) {
      const s0 = st.loopMode ? st.lo : st.a, n0 = st.loopMode ? st.period : Math.max(1, st.b - st.a);
      const t = new Float32Array(n0 + 1);
      for (let i = 0; i < n0; i++) t[i + 1] = t[i] + 1 / easeK(st, s0 + i + 0.5);
      st.tmap = t;
    }
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

  // vitesse de lecture a la position f : x gain dans les ralentis du debut et de la fin (rampe douce)
  function easeK(st, f) {
    const e = st.ease;
    if (!e) return 1;
    const s0 = st.loopMode ? st.lo : st.a, sm = (x) => x * x * (3 - 2 * x);
    let k = 1;
    if (e.head && f - s0 < e.head) k = Math.max(k, e.gain + (1 - e.gain) * sm(Math.max(0, (f - s0) / e.head)));
    if (e.tail && st.b - f < e.tail) k = Math.max(k, e.gain + (1 - e.gain) * sm(Math.max(0, (st.b - f) / e.tail)));
    return k;
  }

  // boucle du tremble : sa duree (secondes jouees) et la phase 0..1 de l'image affichee
  function shakeLoop(st) {
    const n = st.loopMode ? st.period : Math.max(1, st.b - st.a);
    const x = frac(st) - (st.loopMode ? st.lo : st.a);
    if (st.tmap) {
      const t = st.tmap, i = Math.max(0, Math.min(n - 1, Math.floor(x))), w = Math.max(0, Math.min(1, x - i));
      return { sec: t[n] / st.inst.fps, u: (t[i] + (t[i + 1] - t[i]) * w) / t[n] + st.shFree };
    }
    return { sec: n / st.inst.fps, u: x / n + st.shFree };
  }
  // nombres de cycles par boucle : entiers (raccord parfait), croissants, au plus pres de la frequence demandee
  function shakeCycles(sh, sec) {
    const f = sh.freq || 0.2;
    const k = (ratios) => {
      const out = [];
      for (const r of ratios) out.push(Math.max(out.length ? out[out.length - 1] + 1 : 1, Math.round(r * f * sec)));
      return out;
    };
    return { x: k([1, 2.13, 3.71]), y: k([1.07, 1.93, 3.29]), r: k([0.83, 1.71]) };
  }

  function transformOf(st) {
    const fx = st.p.fx || {}, sh = fx.shake, fr = fx.frame;
    let s = 1, dx = 0, dy = 0, rot = 0;
    if (sh && (sh.size > 0 || sh.rot > 0)) {
      const L = shakeLoop(st), K = shakeCycles(sh, L.sec), w = 2 * Math.PI * L.u, ph = st.phases, a = sh.size || 0;
      dx = a * (0.62 * Math.sin(K.x[0] * w + ph[0]) + 0.28 * Math.sin(K.x[1] * w + ph[1]) + 0.10 * Math.sin(K.x[2] * w + ph[2]));
      dy = a * (0.62 * Math.sin(K.y[0] * w + ph[3]) + 0.28 * Math.sin(K.y[1] * w + ph[4]) + 0.10 * Math.sin(K.y[2] * w + ph[5]));
      rot = (sh.rot || 0) * (0.7 * Math.sin(K.r[0] * w + ph[6]) + 0.3 * Math.sin(K.r[1] * w + ph[7]));
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
    for (const R of renderers) if (R.dirty) R.draw();
    if (pages.size) requestAnimationFrame(tick); else ticking = false;
  }

  function step(st, now, dt) {
    if (st.relief) { stepRelief(st, now, dt); return; }
    const fps = st.inst.fps;
    // editeur : le tremble vit meme sur une image fixe (il parcourt sa boucle en temps reel)
    if (st.freeShake) st.shFree += dt / Math.max(0.2, shakeLoop(st).sec); else st.shFree = 0;
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
      const stp = fps * dt * st.speed * st.rate * easeK(st, frac(st));
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
      if (st.relief) { st.rv.once = -1; continue; }
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
    if (inst.rr) inst.rr.destroy();
    for (const st of inst.panels) {
      for (const rv of (st.rviews || []).slice()) rv.remove();
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

  // ---------------------------------------------------------------- relief (carte de profondeur, WebGL)
  const renderers = new Set();          // canevas WebGL actifs (un par page, plus les vues de l'editeur)
  const RELIEF_VS = "attribute vec2 p; attribute vec2 t; varying vec2 v; void main(){ v = t; gl_Position = vec4(p, 0.0, 1.0); }";
  const RELIEF_FS = `precision highp float;
    varying vec2 v; uniform sampler2D uImg, uDep, uBg, uL1, uL2, uLD;
    uniform vec2 uOff; uniform float uDolly, uZoom, uFocus, uOver, uShow, uHue, uN, uMix; uniform vec2 uSize;
    uniform vec3 uFrame; uniform vec4 uGrade;
    // pixel source d'un point de profondeur z (camera : decalage uOff, avancee uDolly linearisee)
    vec2 src(vec2 s, float z){ float zr = z - uFocus; return (s - 0.5) * (1.0 - uDolly * zr) + 0.5 - zr * uOff; }
    // recherche du premier point de la surface touche, du plus proche (z = 1) au plus loin (z = 0), puis affinage :
    // une seule solution, jamais de bord dedouble ; une pente trop forte s'etire au lieu de se replier
    vec2 inv(sampler2D t, vec3 m, vec2 s){
      float a = 1.0, b = 0.0;                                                     // a : devant la surface, b : touche
      for (int i = 0; i <= 20; i++) {
        float z = 1.0 - float(i) / 20.0;
        if (dot(texture2D(t, clamp(src(s, z), 0.0, 1.0)).rgb, m) >= z) { b = z; break; }
        a = z;
      }
      for (int j = 0; j < 5; j++) {
        float mid = 0.5 * (a + b);
        if (dot(texture2D(t, clamp(src(s, mid), 0.0, 1.0)).rgb, m) >= mid) b = mid; else a = mid;
      }
      return src(s, b);
    }
    // sujet detoure : profondeur lisse et prolongee hors de sa silhouette, le point fixe converge (une recherche « premier
    // point touche » y verrait des surfaces fantomes devant le sujet)
    vec2 fp(vec2 s, vec3 m){
      vec2 uv = s;
      for (int i = 0; i < 10; i++) uv = src(s, dot(texture2D(uLD, clamp(uv, 0.0, 1.0)).rgb, m));
      return uv;
    }
    // ecart du moment entre les cartes et le fond au point u du fond, en pixels de l'image (le fond est un plan incline :
    // l'ecart varie dans la case, une moyenne le sous-estimait pres des personnages)
    float gapPx(vec2 u){
      vec3 d = texture2D(uLD, u).rgb;
      float g = abs(d.g - d.r);
      if (uN > 1.5) g = max(g, abs(d.b - d.r));
      return (length(uOff) + 0.5 * abs(uDolly)) * g * uSize.x;
    }
    float inside(vec2 uv){ return step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0); }
    void main(){
      vec2 s = (v - 0.5 + uFrame.yz * (uFrame.x - 1.0) * 0.5) / uFrame.x + 0.5;   // cadrage (fx.frame)
      s = (s - 0.5) / (uOver * uZoom) + 0.5;                                      // sur-cadrage pendant le mouvement
      vec3 c; float dz, k1 = 0.0, k2 = 0.0;
      if (uN > 0.5) {                                                             // couches : fond puis sujets
        vec2 u0 = clamp(inv(uLD, vec3(1.0, 0.0, 0.0), s), 0.0, 1.0);
        // fond : la photo au repos (le decor reconstruit autour des personnages y ferait un halo), le decor reconstruit
        // des 2 pixels d'ecart LOCAL entre carte et fond. Avant : un fondu jusqu'a 6 pixels d'ecart moyen ; entre-temps
        // la photo laissait voir le sujet lui-meme, decale, en transparence (« double nez », profils dedoubles, revue 3),
        // et sur les cases ou les cartes s'ecartent peu, le fondu ne finissait jamais
        c = mix(texture2D(uImg, u0).rgb, texture2D(uBg, u0).rgb, clamp(gapPx(u0) / 2.0, 0.0, 1.0)); dz = texture2D(uLD, u0).r;
        vec2 u1 = fp(s, vec3(0.0, 1.0, 0.0)), q1 = clamp(u1, 0.0, 1.0);
        vec4 a = texture2D(uL1, q1); k1 = a.a * inside(u1);                       // hors de l'image : transparent
        c = mix(c, a.rgb, k1); dz = mix(dz, texture2D(uLD, q1).g, k1);
        if (uN > 1.5) {
          vec2 u2 = fp(s, vec3(0.0, 0.0, 1.0)), q2 = clamp(u2, 0.0, 1.0);
          vec4 b = texture2D(uL2, q2); k2 = b.a * inside(u2);
          c = mix(c, b.rgb, k2); dz = mix(dz, texture2D(uLD, q2).b, k2);
        }
        vec2 r = clamp(s, 0.0, 1.0);
        c = mix(texture2D(uImg, r).rgb, c, uMix);                                 // au repos : la photo exacte
      } else {
        vec2 uv = clamp(inv(uDep, vec3(1.0, 0.0, 0.0), s), 0.0, 1.0);             // nappe seule
        c = texture2D(uImg, uv).rgb; dz = texture2D(uDep, uv).r;
      }
      c *= uGrade.y;                                                              // luminosite
      c = (c - 0.5) * uGrade.z + 0.5;                                             // contraste
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uGrade.x);                                              // saturation
      c += vec3(0.07, 0.0, -0.07) * uGrade.w;                                     // temperature
      if (uHue != 0.0) {                                                          // teinte (rotation autour du gris)
        float a = radians(uHue), co = cos(a), si = sin(a);
        vec3 k = vec3(0.57735);
        c = c * co + cross(k, c) * si + k * dot(k, c) * (1.0 - co);
      }
      c = clamp(c, 0.0, 1.0);
      if (uShow > 1.5) {                                                          // vue des calques (editeur)
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = vec3(0.25 + 0.5 * lum);
        c = mix(c, vec3(0.25, 0.55, 1.0) * (0.45 + 0.6 * lum), 0.8 * k1);
        c = mix(c, vec3(1.0, 0.55, 0.15) * (0.45 + 0.6 * lum), 0.8 * k2);
      } else if (uShow > 0.5) c = vec3(dz);                                       // vue de la profondeur
      gl_FragColor = vec4(c, 1.0);
    }`;
  const RELIEF_MOVES = {
    respire: (ph, a, e) => ({ ox: 0, oy: 0, dolly: 0.3 * e, zoom: 1 + 1.6 * a * e }),
    glisse: (ph, a, e) => ({ ox: a * Math.sin(2 * Math.PI * ph) * e, oy: 0, dolly: 0, zoom: 1 }),
    tourne: (ph, a, e) => ({ ox: a * Math.sin(2 * Math.PI * ph) * e, oy: 0.6 * a * (1 - Math.cos(2 * Math.PI * ph)) * e * 0.5, dolly: 0, zoom: 1 }),
    vertigo: (ph, a, e) => ({ ox: 0, oy: 0, dolly: -Math.min(0.35, 12 * a) * e, zoom: 1 }),
  };
  const CYCLIC = { respire: true, vertigo: true };     // enveloppe qui revient a zero a chaque tour

  function makeGL(canvas) {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: true, alpha: true, preserveDrawingBuffer: false });
    if (!gl) return null;
    const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, RELIEF_VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, RELIEF_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const U = {};
    for (const n of ["uImg", "uDep", "uBg", "uL1", "uL2", "uLD", "uOff", "uDolly", "uZoom", "uFocus", "uOver", "uShow", "uHue",
                     "uN", "uMix", "uSize", "uFrame", "uGrade"]) U[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(U.uImg, 0); gl.uniform1i(U.uDep, 1); gl.uniform1i(U.uBg, 2); gl.uniform1i(U.uL1, 3); gl.uniform1i(U.uL2, 4);
    gl.uniform1i(U.uLD, 5);
    const R = { gl, canvas, prog, U, items: [], dirty: true, aP: gl.getAttribLocation(prog, "p"), aT: gl.getAttribLocation(prog, "t") };
    R.texture = (source, rgba) => {
      const t = gl.createTexture(), f = rgba ? gl.RGBA : gl.RGB;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, f, f, gl.UNSIGNED_BYTE, source);
      return t;
    };
    R.free = (it) => {
      for (const t of [it.tImg, it.tDep, ...(it.tL ? [it.tL.bg, it.tL.ld, ...it.tL.fg] : [])]) if (t) gl.deleteTexture(t);
      it.tImg = it.tDep = it.tL = null;
    };
    // verts : [x, y (espace de decoupe), u, v] en triangles
    R.add = (st, verts) => {
      const it = { st, n: verts.length / 4, buf: gl.createBuffer(), tImg: null, tDep: null, tL: null };
      gl.bindBuffer(gl.ARRAY_BUFFER, it.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
      R.items.push(it);
      R.upload(it);
      return it;
    };
    R.upload = (it) => {
      const st = it.st;
      if (!st.imgOk || !st.depOk) return;
      R.free(it);
      it.tImg = R.texture(st.imgEl); it.tDep = R.texture(st.depEl);
      const L = st.layEls;
      it.tL = L ? { bg: R.texture(L.bg), ld: R.texture(L.ld), fg: L.fg.map(e => R.texture(e, true)) } : null;
      R.dirty = true;
    };
    R.remove = (st) => {
      R.items = R.items.filter(it => {
        if (it.st !== st) return true;
        gl.deleteBuffer(it.buf); R.free(it);
        return false;
      });
      R.dirty = true;
    };
    R.resize = (w, h) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1), k = Math.min(1, 2560 / Math.max(1, w * dpr));
      canvas.width = Math.max(1, Math.round(w * dpr * k)); canvas.height = Math.max(1, Math.round(h * dpr * k));
      R.dirty = true;
    };
    R.draw = () => {
      R.dirty = false;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      for (const it of R.items) {
        if (!it.tImg) continue;
        const st = it.st, m = st.motion || { ox: 0, oy: 0, dolly: 0, zoom: 1, over: 1 }, c = st.p.depth || {};
        const fx = st.p.fx || {}, g = fx.grade || {}, fr = fx.frame || {};
        gl.bindBuffer(gl.ARRAY_BUFFER, it.buf);
        gl.enableVertexAttribArray(R.aP); gl.vertexAttribPointer(R.aP, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(R.aT); gl.vertexAttribPointer(R.aT, 2, gl.FLOAT, false, 16, 8);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, it.tImg);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, it.tDep);
        const L = it.tL;
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, L ? L.bg : null);
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, L ? L.fg[0] : null);
        gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, L && L.fg[1] ? L.fg[1] : null);
        gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, L ? L.ld : null);
        gl.uniform1f(R.U.uN, L ? L.fg.length : 0); gl.uniform1f(R.U.uMix, m.mix || 0); const bgEl = L && st.layEls && st.layEls.bg;
        gl.uniform2f(R.U.uSize, (bgEl && bgEl.naturalWidth) || 1200, (bgEl && bgEl.naturalHeight) || 800);
        gl.uniform2f(R.U.uOff, m.ox, m.oy);
        gl.uniform1f(R.U.uDolly, m.dolly); gl.uniform1f(R.U.uZoom, m.zoom); gl.uniform1f(R.U.uOver, m.over);
        gl.uniform1f(R.U.uFocus, c.focus ?? 0.7); gl.uniform1f(R.U.uShow, st.showMap === "layers" ? 2 : st.showMap ? 1 : 0);
        gl.uniform3f(R.U.uFrame, fr.zoom > 1 ? fr.zoom : 1, fr.zoom > 1 ? (fr.x || 0) : 0, fr.zoom > 1 ? (fr.y || 0) : 0);
        gl.uniform4f(R.U.uGrade, g.sat ?? 1, g.bright ?? 1, g.contrast ?? 1, g.temp || 0);
        gl.uniform1f(R.U.uHue, g.hue || 0);
        gl.drawArrays(gl.TRIANGLES, 0, it.n);
      }
    };
    R.destroy = () => {
      renderers.delete(R);
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      canvas.remove();
    };
    renderers.add(R);
    return R;
  }

  // canevas de la page : sous les cases (qui gardent les gestes), au-dessus de l'image de fond, sous les traits
  function pageRenderer(inst) {
    if (inst.rr !== undefined) return inst.rr;
    const cv = document.createElement("canvas");
    cv.className = "ac-relief";
    inst.pageEl.insertBefore(cv, inst.pageEl.querySelector(".ac-panel"));
    const R = makeGL(cv);
    inst.rr = R;
    if (!R) { cv.remove(); return null; }
    const ro = new ResizeObserver(() => R.resize(inst.pageEl.clientWidth, inst.pageEl.clientHeight));
    ro.observe(inst.pageEl);
    const destroy = R.destroy;
    R.destroy = () => { ro.disconnect(); destroy(); };
    return R;
  }

  function polyVerts(p, PW, PH) {
    const [x0, y0, x1, y1] = p.rect;
    const pts = p.poly || [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const V = pts.map(([x, y]) => [x / PW * 2 - 1, 1 - y / PH * 2, (x - x0) / (x1 - x0), (y - y0) / (y1 - y0)]);
    const out = [];
    for (let i = 1; i < V.length - 1; i++) out.push(...V[0], ...V[i], ...V[i + 1]);    // eventail (cases convexes)
    return out;
  }

  // images d'une case en relief : photo + nappe, et ses couches s'il y en a (une couche absente : la nappe seule)
  function loadRelief(st, stamp) {
    const c = st.p.depth, lay = c.layers, gen = (st.loadGen = (st.loadGen || 0) + 1);
    const want = { img: c.img, dep: c.map };
    const fg = lay && lay.bg && lay.ld && (lay.fg || []).length ? lay.fg.slice(0, 2) : [];
    if (fg.length) { want.bg = lay.bg; want.ld = lay.ld; fg.forEach((f, i) => { want["f" + i] = f; }); }
    const els = {}, state = {};
    const settle = () => {
      if (gen !== st.loadGen || Object.keys(want).some(k => !state[k])) return;       // pas tout arrive, ou remplace
      st.imgEl = els.img; st.depEl = els.dep;
      st.imgOk = state.img === "ok"; st.depOk = state.dep === "ok";
      const keys = fg.map((_, i) => "f" + i);
      st.layEls = fg.length && ["bg", "ld", ...keys].every(k => state[k] === "ok")
        ? { bg: els.bg, ld: els.ld, fg: keys.map(k => els[k]) } : null;
      for (const R of renderers) for (const it of R.items) if (it.st === st) R.upload(it);
      st.depthData = st.layData = null;
    };
    for (const [k, src] of Object.entries(want)) {
      const im = new Image();
      els[k] = im;
      im.onload = () => { state[k] = "ok"; settle(); };
      im.onerror = () => { state[k] = "err"; settle(); };
      im.src = withStamp(st.base + src, stamp);
    }
  }

  function makeRelief(inst, p, el, base) {
    el.classList.add("relief");
    const st = { p, inst, el, base, relief: true, views: [], rviews: [], layers: [], over: false, hover: false, pinned: false,
                 showMap: false, rv: { ph: 0, lvl: 0, once: -1, dx: 0, dy: 0, drag: null }, motion: null };
    loadRelief(st, inst.stamp);
    const R = pageRenderer(inst);
    if (R) R.add(st, polyVerts(p, inst.data.size[0], inst.data.size[1]));
    buildLayers(st);
    el.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") { st.over = true; soundOnPanel(st, true); } });
    el.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") st.over = false; if (!st.pinSound) soundOnPanel(st, false); });
    // glisser : la camera suit le doigt ou la souris ; simple clic : le mouvement joue une fois (ou l'editeur s'ouvre)
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* pointeur deja relache */ }
      const r = el.getBoundingClientRect();
      st.rv.drag = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, t: performance.now(), moved: false };
      if (e.pointerType === "touch") {
        for (const i2 of pages) for (const o of i2.panels) if (o !== st && o.hover) soundOnPanel(o, false);
        if (st.layers.length) soundOnPanel(st, true);
      }
    });
    el.addEventListener("pointermove", (e) => {
      const d = st.rv.drag;
      if (!d) return;
      const dx = (e.clientX - d.x) / d.w, dy = (e.clientY - d.y) / d.h;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) d.moved = true;
      st.rv.dx = Math.max(-1, Math.min(1, dx * 2.5)); st.rv.dy = Math.max(-1, Math.min(1, dy * 2.5));
    });
    const up = (e) => {
      const d = st.rv.drag;
      if (!d) return;
      st.rv.drag = null;
      if (!d.moved && performance.now() - d.t < 600 && e.type === "pointerup") {
        if (editHook) editHook(st); else st.rv.once = performance.now();
      }
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    inst.panels.push(st);
  }

  // mouvement d'une case en relief : boucle douce tant qu'elle est survolee (ou un tour au clic), plus le glisser
  function stepRelief(st, now, dt) {
    const c = st.p.depth || {}, rv = st.rv, a = c.amount || 0.025, dur = Math.max(0.5, c.duration || 2);
    const move = RELIEF_MOVES[c.preset] || RELIEF_MOVES.respire;
    const hoverOn = (c.trigger || "hover") === "hover" && (st.over || st.pinned || st.inst.play === "always");
    rv.lvl += ((hoverOn ? 1 : 0) - rv.lvl) * Math.min(1, dt * (hoverOn ? 2.5 : 2));
    if (rv.lvl < 0.002 && !hoverOn) rv.lvl = 0;
    let m;
    if (rv.once >= 0) {                                  // un tour, au clic
      let t = (now - rv.once) / 1000 / dur;
      if (t >= 1) { t = 1; rv.once = -1; }
      const sm = t * t * (3 - 2 * t), env = Math.sin(Math.PI * sm);
      m = move(sm, a, env);
      m.k = env;
    } else {
      if (rv.lvl > 0) rv.ph = (rv.ph + dt / dur) % 1;
      const e = CYCLIC[c.preset || "respire"] ? (0.5 - 0.5 * Math.cos(2 * Math.PI * rv.ph)) * rv.lvl : rv.lvl;
      m = move(rv.ph, a, e);
      m.k = rv.lvl;
    }
    // glisser : decalage qui suit le pointeur, puis revient en douceur
    if (!rv.drag) { rv.dx *= Math.exp(-6 * dt); rv.dy *= Math.exp(-6 * dt); if (Math.abs(rv.dx) + Math.abs(rv.dy) < 1e-3) rv.dx = rv.dy = 0; }
    m.ox -= rv.dx * a * 1.6; m.oy -= rv.dy * a * 1.0;
    const k = Math.max(m.k, Math.min(1, Math.hypot(rv.dx, rv.dy)));
    m.over = 1 + k * (2.4 * a + 0.02) + 0.35 * Math.abs(m.dolly);   // au repos : 1 = identique a l'image de la page
    const x = Math.min(1, k / 0.25);
    m.mix = x * x * (3 - 2 * x);                        // couches : fondu depuis la photo exacte des que ca bouge
    const old = st.motion;
    if (!old || old.ox !== m.ox || old.oy !== m.oy || old.dolly !== m.dolly || old.zoom !== m.zoom || old.over !== m.over
        || old.mix !== m.mix) {
      st.motion = m;
      for (const R of renderers) if (R.items.some(it => it.st === st)) R.dirty = true;
    }
  }

  // vue supplementaire d'une case en relief (editeur) : son propre canevas, toute la surface
  function addReliefView(st, host) {
    const cv = document.createElement("canvas");
    cv.className = "ac-relief-view";
    host.appendChild(cv);
    const R = makeGL(cv);
    if (!R) { cv.remove(); return { remove() {}, ok: false }; }
    R.add(st, [-1, 1, 0, 0, 1, 1, 1, 0, 1, -1, 1, 1, -1, 1, 0, 0, 1, -1, 1, 1, -1, -1, 0, 1]);
    const ro = new ResizeObserver(() => R.resize(host.clientWidth, host.clientHeight));
    ro.observe(host);
    const vw = { ok: true, canvas: cv, remove() { ro.disconnect(); R.destroy(); st.rviews = st.rviews.filter(x => x !== vw); } };
    st.rviews.push(vw);
    startTick();
    return vw;
  }
  function setRelief(st, cfg) {
    st.p.depth = Object.assign({}, st.p.depth, cfg);
    for (const R of renderers) if (R.items.some(it => it.st === st)) R.dirty = true;
  }
  // vue de controle (editeur) : true = profondeur, "layers" = calques en couleur, false = image
  function reliefShowMap(st, on) { st.showMap = on === "layers" ? "layers" : !!on; for (const R of renderers) R.dirty = true; }
  function reliefLayers(st) { return st.layEls ? st.layEls.fg.length : 0; }
  function reliefPlay(st) { st.rv.once = performance.now(); }
  // profondeur (0..1) sous un point de la case : pour choisir le plan net d'un clic
  function reliefDepthAt(st, u, v) {
    if (!st.depOk) return null;
    if (st.layEls) {                        // couches : la profondeur que le lecteur compose au repos (fond, puis sujets)
      if (!st.layData) {
        const read = (img) => {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const g = c.getContext("2d", { willReadFrequently: true });
          g.drawImage(img, 0, 0);
          return { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data };
        };
        st.layData = { ld: read(st.layEls.ld), fg: st.layEls.fg.map(read) };
      }
      const px = (D, k) => {
        const x = Math.max(0, Math.min(D.w - 1, Math.round(u * (D.w - 1)))), y = Math.max(0, Math.min(D.h - 1, Math.round(v * (D.h - 1))));
        return D.d[(y * D.w + x) * 4 + k] / 255;
      };
      let z = px(st.layData.ld, 0);
      st.layData.fg.forEach((F, i) => { const a = px(F, 3); z = z * (1 - a) + px(st.layData.ld, i + 1) * a; });
      return z;
    }
    if (!st.depthData) {
      const c = document.createElement("canvas");
      c.width = st.depEl.naturalWidth; c.height = st.depEl.naturalHeight;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(st.depEl, 0, 0);
      st.depthData = { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data };
    }
    const D = st.depthData, x = Math.max(0, Math.min(D.w - 1, Math.round(u * (D.w - 1)))), y = Math.max(0, Math.min(D.h - 1, Math.round(v * (D.h - 1))));
    return D.d[(y * D.w + x) * 4] / 255;
  }
  function updateRelief(st, entry, stamp) {
    const reload = !st.p.depth || entry.depth.img !== st.p.depth.img || entry.depth.map !== st.p.depth.map || stamp
      || JSON.stringify(entry.depth.layers || null) !== JSON.stringify(st.p.depth.layers || null);
    st.p = entry;
    if (reload) loadRelief(st, stamp);
    const was = st.hover;
    dropLayers(st);
    const keep = st.inst.stamp;
    st.inst.stamp = stamp || keep;
    buildLayers(st);
    st.inst.stamp = keep;
    if (was) soundOnPanel(st, true);
    for (const R of renderers) R.dirty = true;
  }

  // ---------------------------------------------------------------- mode edition (apercu de l'application)
  function setEditHook(fn) {
    editHook = fn || null;
    for (const inst of pages) inst.pageEl.classList.toggle("ac-editing", !!editHook);
  }
  function setFx(st, fx) {
    st.p.fx = fx || undefined;
    if (st.relief) { for (const R of renderers) R.dirty = true; return; }
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
  // son global remplace (ou retire) : fondu de sortie de l'ancien, le nouveau prend sa place
  function setPageSound(inst, snd, stamp) {
    if (inst.global) {
      const g = inst.global;
      fade(g, 0);
      setTimeout(() => { g.a.pause(); g.a.src = ""; }, 900);
      inst.global = null;
    }
    inst.data.sound = snd || undefined;
    if (!snd) return;
    const a = new Audio(withStamp(inst.base + snd.src, stamp));
    a.loop = true; a.volume = 0; a.preload = "auto";
    inst.global = { a, vol: Math.max(0, Math.min(1, snd.vol ?? 0.7)), timer: null, mode: "loop" };
    if (unlocked && soundOn) startGlobal(inst);
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
                         setPinned, setPanelSound, setPageSound, frameOf: idxOf, _pages: pages,
                         addReliefView, setRelief, reliefShowMap, reliefLayers, reliefPlay, reliefDepthAt, updateRelief,
                         // tremble d'une case : cycles par boucle et frequence reellement jouee
                         shakeInfo(st) {
                           const sh = (st.p.fx || {}).shake;
                           if (!sh) return null;
                           const L = shakeLoop(st), c = shakeCycles(sh, L.sec).x[0];
                           return { cycles: c, sec: L.sec, hz: c / L.sec };
                         },
                         speedAt: (st, f) => easeK(st, f) };
})();
