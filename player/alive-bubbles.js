/* Bulles de BD d'une case : dessin (SVG) + texte (HTML), apparition (toujours / au survol / a t secondes) et animations.
 *
 * Utilise par le lecteur (alive-player.js : cases video, relief, fixes) et par l'editeur de bulles de l'application.
 *   const c = AliveBubbles.mount(hote, bulles, { edit: false });
 *   c.update({ hover, t });         // t : secondes de lecture de la case (null si la case n'a pas de video)
 *   c.layout();                     // apres un changement de taille ou de donnees
 *   c.destroy();
 * Une bulle : { id, type, text, x, y, tx, ty, size, color, show, at, anim }
 *   type  oval | thought | shout | whisper | box ; x, y : centre (0-1 de la case) ; tx, ty : pointe de la queue (null = sans queue)
 *   size  S | M | L ; color white | black | yellow ; show always | hover | time (+ at) ; anim pop | fade | rise | shake | type
 */
(() => {
  "use strict";
  const SIZES = { S: 4.2, M: 5.6, L: 7.6 };
  // couleurs : [fond, trait, texte] ; b.fill / b.ink (hex) remplacent le fond et le texte (le trait suit le texte)
  const COLORS = { white: ["#ffffff", "#141414", "#141414"], black: ["#161616", "#ffffff", "#ffffff"], yellow: ["#ffe784", "#141414", "#141414"],
                   pink: ["#ffc4dd", "#141414", "#141414"], blue: ["#bfe3ff", "#141414", "#141414"], red: ["#e5383b", "#141414", "#ffffff"],
                   green: ["#c5ecb8", "#141414", "#141414"] };
  const COLOR_NAMES = { white: "Blanc", black: "Noir", yellow: "Jaune", pink: "Rose", blue: "Bleu", red: "Rouge", green: "Vert" };
  // typographies : polices du systeme seulement (rien a telecharger, la page exportee marche partout), de la machine a ecrire a la BD
  const FONTS = {
    bd: ["BD", '"Comic Neue", "Comic Sans MS", "Chalkboard SE", "Comic Sans", sans-serif', 700, ""],
    hand: ["Manuscrite", '"Segoe Print", "Bradley Hand", "Marker Felt", "Noteworthy", "Comic Sans MS", cursive', 600, ""],
    type: ["Machine à écrire", '"Courier New", Courier, "Liberation Mono", monospace', 700, ""],
    serif: ["Classique", 'Georgia, "Times New Roman", Times, serif', 600, ""],
    sans: ["Moderne", '"Trebuchet MS", "Segoe UI", Arial, Helvetica, sans-serif', 700, ""],
    impact: ["Cri", 'Impact, "Haettenschweiler", "Arial Black", "Arial Narrow Bold", sans-serif', 400, "uppercase"],
  };
  const colorOf = (b) => { const c = COLORS[b.color] || COLORS.white; const ink = b.ink || c[2]; return [b.fill || c[0], b.ink || c[1], ink]; };
  const TYPES = { oval: "Parole", thought: "Pensée", shout: "Cri", whisper: "Chuchotement", box: "Narration" };
  const ANIMS = { pop: "Pop", fade: "Fondu", rise: "Montée", shake: "Secousse", type: "Machine à écrire" };
  const NS = "http://www.w3.org/2000/svg";

  const css = `
.ac-bubs { position: absolute; inset: 0; z-index: 6; pointer-events: none; container-type: size; overflow: visible; }
.ac-bub { position: absolute; transform: translate(-50%, -50%); opacity: 0; visibility: hidden; transition: opacity .2s, visibility 0s .2s;
  line-height: 1.16; }
.ac-bub.on { opacity: 1; visibility: visible; transition: opacity .12s, visibility 0s; }
.ac-bin { position: relative; }
.ac-bin svg { position: absolute; left: 50%; top: 50%; width: 1px; height: 1px; overflow: visible; pointer-events: none; }
.ac-btxt { position: relative; font-family: var(--bf); font-weight: var(--bw8, 700); text-transform: var(--bt, none); text-align: center; white-space: pre-wrap; overflow-wrap: normal; word-break: normal; hyphens: none; max-width: calc(var(--mw, 34) * var(--cq, 1cqw));
  min-width: min-content; padding: .55em .8em; width: max-content; font-size: calc(var(--fs, 5.6) * var(--cq, 1cqw)); }
.ac-btxt .h { visibility: hidden; }
.ac-bub.ed { pointer-events: auto; cursor: grab; }
.ac-bub.ed.sel .ac-btxt { outline: 2px dashed rgba(179, 107, 255, .9); outline-offset: 4px; border-radius: 6px; }
.ac-btip { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; background: #b36bff; border: 2px solid #fff; transform: rotate(45deg);
  pointer-events: auto; cursor: grab; z-index: 2; border-radius: 2px; }
.ac-btip.base { width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px; background: #d9b8ff; }
.ac-bin.a-pop { animation: acb-pop .38s cubic-bezier(.2, 1.5, .4, 1); }
.ac-bin.a-fade { animation: acb-fade .5s ease-out; }
.ac-bin.a-rise { animation: acb-rise .42s cubic-bezier(.2, .9, .3, 1); }
.ac-bin.a-shake { animation: acb-shake .5s ease-out; }
@keyframes acb-pop { 0% { transform: scale(.15); opacity: 0; } 60% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); } }
@keyframes acb-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes acb-rise { from { transform: translateY(35%); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes acb-shake { 0% { transform: scale(1.25); } 15% { transform: translateX(-4%) rotate(-3deg) scale(1.1); } 30% { transform: translateX(4%) rotate(3deg) scale(1.1); }
  45% { transform: translateX(-3%) rotate(-2deg); } 60% { transform: translateX(3%) rotate(2deg); } 80% { transform: translateX(-1%); } 100% { transform: none; } }
@media (prefers-reduced-motion: reduce) { .ac-bin[class*="a-"] { animation: none; } }
`;
  let styled = false;
  function addStyle() {
    if (styled) return;
    styled = true;
    const s = document.createElement("style");
    s.textContent = css;
    document.head.append(s);
  }

  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const el = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    return e;
  };
  function hash(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
  const f2 = (v) => (Math.round(v * 100) / 100);

  // ------------------------------------------------------------------ formes (coordonnees relatives au centre du texte)
  function ellipse(rx, ry) { return `M ${f2(-rx)} 0 A ${f2(rx)} ${f2(ry)} 0 1 0 ${f2(rx)} 0 A ${f2(rx)} ${f2(ry)} 0 1 0 ${f2(-rx)} 0 Z`; }
  // flancs de la queue : droits, ou courbes (curve -1..1 : la pointe se recourbe d'un cote)
  function flanks(b1, b2, tx, ty, curve) {
    if (!curve) return `L ${tx} ${ty} L ${b2}`;
    const mx = (b1[0] + b2[0]) / 2, my = (b1[1] + b2[1]) / 2, dx = tx - mx, dy = ty - my, L = Math.hypot(dx, dy) || 1;
    const off = curve * L * 0.3, nx = -dy / L * off, ny = dx / L * off;
    const c = (p) => [(p[0] + tx) / 2 + nx, (p[1] + ty) / 2 + ny];
    return `Q ${c(b1)} ${tx} ${ty} Q ${c(b2)} ${b2}`;
  }
  function tailShapes(b1, b2, i1, i2, ux, uy, curve) {
    const mx = (b1[0] + b2[0]) / 2, my = (b1[1] + b2[1]) / 2;
    const cx = mx + (ux - mx) * 0.97, cy = my + (uy - my) * 0.97;       // pointe un peu en retrait pour que le trait ne depasse pas
    return { tail: `M ${b1} ${flanks(b1, b2, ux, uy, curve)} Z`, cover: `M ${i1} L ${b1} ${flanks(b1, b2, cx, cy, curve)} L ${i2} Z` };
  }
  // vx, vy : direction de la base de la queue (losange du bas) ; absent = vers la pointe
  function ellipseTail(rx, ry, ux, uy, spread, curve, vx, vy) {
    const d = Math.hypot(ux / rx, uy / ry);
    if (d < 1.06) return null;
    const phi = vx != null ? Math.atan2(vy / ry, vx / rx) : Math.atan2(uy / ry, ux / rx);
    const pt = (a, k) => [rx * k * Math.cos(a), ry * k * Math.sin(a)];
    return tailShapes(pt(phi - spread, 1), pt(phi + spread, 1), pt(phi - spread, 0.82), pt(phi + spread, 0.82), ux, uy, curve);
  }
  function boxTail(hw, hh, ux, uy, spread, curve, vx, vy) {
    if (Math.abs(ux) < hw && Math.abs(uy) < hh) return null;
    const ex = vx != null ? vx : ux, ey = vy != null ? vy : uy, k = vx != null ? 1 : 0.5;
    let b1, b2, i1, i2;
    if (Math.abs(ey) * hw >= Math.abs(ex) * hh) {                 // bord haut ou bas
      const sy = ey > 0 ? 1 : -1, cx = Math.max(-hw * 0.7, Math.min(hw * 0.7, ex * k));
      b1 = [cx - spread, sy * hh]; b2 = [cx + spread, sy * hh]; i1 = [cx - spread, sy * hh * 0.7]; i2 = [cx + spread, sy * hh * 0.7];
    } else {
      const sx = ex > 0 ? 1 : -1, cy = Math.max(-hh * 0.7, Math.min(hh * 0.7, ey * k));
      b1 = [sx * hw, cy - spread]; b2 = [sx * hw, cy + spread]; i1 = [sx * hw * 0.8, cy - spread]; i2 = [sx * hw * 0.8, cy + spread];
    }
    return tailShapes(b1, b2, i1, i2, ux, uy, curve);
  }
  function roundRect(hw, hh, r) {
    return `M ${-hw + r} ${-hh} H ${hw - r} Q ${hw} ${-hh} ${hw} ${-hh + r} V ${hh - r} Q ${hw} ${hh} ${hw - r} ${hh} H ${-hw + r} ` +
           `Q ${-hw} ${hh} ${-hw} ${hh - r} V ${-hh + r} Q ${-hw} ${-hh} ${-hw + r} ${-hh} Z`;
  }
  // n pointes, len : longueur des pointes (0,32 par defaut), irr : irregularite (0,35 par defaut)
  function star(rx, ry, n, seed, len, irr) {
    const pts = [], ko = 1 + len * 0.375, ki = 1 - len * 0.625, jo = irr * 0.285, ji = irr * 0.17;
    for (let i = 0; i < n * 2; i++) {
      const a = (i * Math.PI) / n + 0.2, out = i % 2 === 0;
      const k = out ? ko + jo * (hash(seed + "o" + i) - 0.5) : ki + ji * (hash(seed + "i" + i) - 0.5);
      pts.push([rx * k * Math.cos(a), ry * k * Math.sin(a)]);
    }
    return "M " + pts.map((p) => p.map(f2).join(" ")).join(" L ") + " Z";
  }

  // ellipse a contour irregulier (dessine a la main) : amp 0..1
  function wobbly(rx, ry, amp, seed) {
    const n = 56, ph = [1, 2, 3].map((i) => hash(seed + "w" + i) * 6.283), pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283, k = 1 + amp * 0.1 * (Math.sin(a * 3 + ph[0]) * 0.6 + Math.sin(a * 5 + ph[1]) * 0.3 + Math.sin(a * 8 + ph[2]) * 0.2);
      pts.push([rx * k * Math.cos(a), ry * k * Math.sin(a)]);
    }
    return "M " + pts.map((p) => p.map(f2).join(" ")).join(" L ") + " Z";
  }

  function draw(svg, b, bw, bh, ux, uy, hasTail, sw, vx, vy) {
    svg.textContent = "";
    const g = b.geo || {}, [fill, stroke] = colorOf(b);
    sw *= g.line || 1;
    const ls = g.ls || (b.type === "whisper" ? "dashed" : "solid");
    const base = { fill, stroke, "stroke-width": sw, "stroke-linejoin": "round", "stroke-linecap": "round" };
    const add = (d, extra) => { const p = el("path", Object.assign({ d }, base, extra)); svg.append(p); return p; };
    const pad = g.pad || 1, curve = g.curve || 0;
    const rx = bw * 0.66 * pad, ry = bh * 0.68 * pad;
    const dash = ls === "dashed" ? { "stroke-dasharray": `${sw * 2.2} ${sw * 1.9}` } : ls === "dotted" ? { "stroke-dasharray": `0.01 ${sw * 2.4}` } : {};
    const body = (d, extra) => {                                         // contour : plein, pointille, ou double trait
      if (ls === "double") { add(d, Object.assign({ "stroke-width": sw * 3.4 }, extra)); return add(d, Object.assign({ stroke: fill, "stroke-width": sw * 1.2 }, extra)); }
      return add(d, Object.assign({}, dash, extra));
    };
    // largeur de la queue : b.tw (0,2 a 3, defaut 1) ; le defaut est fin
    const tw = Math.max(0.2, Math.min(3, b.tw || 1));
    const spread = Math.max(0.07, Math.min(0.9, tw * Math.max(0.1, Math.min(0.2, 13 / Math.max(30, Math.min(rx, ry))))));
    if (b.type === "box") {
      const hw = bw / 2 * 1.04 * pad, hh = bh / 2 * 1.02 * pad, t = hasTail ? boxTail(hw, hh, ux, uy, Math.max(sw * 2, Math.min(hw, hh) * 0.17 * tw), curve, vx, vy) : null;
      if (t) add(t.tail, dash);
      body(roundRect(hw, hh, Math.min(hw, hh) * (g.round ?? 0.16)));
      if (t) add(t.cover, { stroke: "none" });
      return;
    }
    if (b.type === "thought") {
      const n = g.bumps || 11, r = Math.min(rx, ry) * 0.36 * Math.min(1.5, 11 / n);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        add(`M ${f2(rx * 0.86 * Math.cos(a) - r)} ${f2(ry * 0.86 * Math.sin(a))} a ${f2(r)} ${f2(r)} 0 1 0 ${f2(2 * r)} 0 a ${f2(r)} ${f2(r)} 0 1 0 ${f2(-2 * r)} 0 Z`);
      }
      add(ellipse(rx * 0.86, ry * 0.86), { stroke: "none" });
      if (hasTail) {
        const d = Math.hypot(ux / rx, uy / ry);
        if (d > 1.1) {
          const phi = vx != null ? Math.atan2(vy / ry, vx / rx) : Math.atan2(uy / ry, ux / rx), sx = rx * 1.08 * Math.cos(phi), sy = ry * 1.08 * Math.sin(phi);
          [[0.3, 0.17], [0.62, 0.12], [0.92, 0.085]].forEach(([k, s]) => {
            const cx = sx + (ux - sx) * k, cy = sy + (uy - sy) * k, rr = Math.max(sw * 1.4, Math.min(rx, ry) * s);
            add(`M ${f2(cx - rr)} ${f2(cy)} a ${f2(rr)} ${f2(rr)} 0 1 0 ${f2(2 * rr)} 0 a ${f2(rr)} ${f2(rr)} 0 1 0 ${f2(-2 * rr)} 0 Z`);
          });
        }
      }
      return;
    }
    if (b.type === "shout") {
      const R = [rx * 1.05, ry * 1.1], t = hasTail ? ellipseTail(rx * 0.95, ry * 0.95, ux, uy, spread, curve, vx, vy) : null;
      if (t) add(t.tail, dash);
      body(star(R[0], R[1], g.n || 13, b.id || "x", g.len ?? 0.32, g.irr ?? 0.35));
      if (t) add(t.cover, { stroke: "none" });
      return;
    }
    const t = hasTail ? ellipseTail(rx, ry, ux, uy, spread, curve, vx, vy) : null;       // oval, chuchotement
    if (t) add(t.tail, dash);
    body(g.wob ? wobbly(rx, ry, g.wob, b.id || "x") : ellipse(rx, ry));
    if (t) add(t.cover, { stroke: "none" });
  }

  // ------------------------------------------------------------------ montage
  // opts.rect = [gauche, haut, largeur, hauteur] en % de l'hote : le calque suit une case (le lecteur le met sur la page,
  // pas dans la case : les bulles peuvent depasser un peu du cadre)
  function mount(host, list, opts) {
    addStyle();
    opts = opts || {};
    const root = document.createElement("div");
    root.className = "ac-bubs";
    if (opts.rect) {
      const [l, t, w, h] = opts.rect;
      Object.assign(root.style, { inset: "auto", left: l + "%", top: t + "%", width: w + "%", height: h + "%" });
    }
    host.append(root);
    const items = [];
    const ctl = { root, items, selected: null, edit: !!opts.edit };

    function build() {
      for (const it of items) { it.node.remove(); it.tip && it.tip.remove(); it.base && it.base.remove(); clearInterval(it.timer); }
      items.length = 0;
      for (const b of list || []) {
        const node = document.createElement("div");
        node.className = "ac-bub" + (ctl.edit ? " ed on" : "");
        node.dataset.id = b.id || "";
        const bin = document.createElement("div"); bin.className = "ac-bin";
        const svg = document.createElementNS(NS, "svg");
        const txt = document.createElement("div"); txt.className = "ac-btxt";
        bin.append(svg, txt); node.append(bin);
        root.append(node);
        const it = { b, node, bin, svg, txt, on: ctl.edit, timer: null, tip: null };
        if (ctl.edit) {
          it.tip = document.createElement("div"); it.tip.className = "ac-btip"; it.tip.dataset.id = b.id || ""; root.append(it.tip);
          it.base = document.createElement("div"); it.base.className = "ac-btip base"; it.base.dataset.id = b.id || ""; it.base.title = "Base de la queue"; root.append(it.base);
        }
        items.push(it);
      }
      layout();
    }

    function layout() {
      const W = root.clientWidth || 1, H = root.clientHeight || 1;
      for (const it of items) {
        const b = it.b, text = colorOf(b)[2], F = FONTS[b.font] || FONTS.bd;
        it.node.style.left = (b.x ?? 0.5) * 100 + "%"; it.node.style.top = (b.y ?? 0.5) * 100 + "%";
        it.txt.style.setProperty("--fs", b.fs || SIZES[b.size] || SIZES.M);        // b.fs : taille libre (en % de la largeur de la case)
        it.txt.style.setProperty("--mw", (b.geo && b.geo.mw) || (b.type === "box" ? 62 : b.type === "shout" ? 36 : 32));
        it.txt.style.color = text;
        it.txt.style.setProperty("--bf", F[1]); it.txt.style.setProperty("--bw8", F[2]); it.txt.style.setProperty("--bt", F[3] || "none");
        if (!it.timer) it.txt.textContent = b.text || (ctl.edit ? "…" : "");
        const bw = it.txt.offsetWidth, bh = it.txt.offsetHeight;
        const hasTail = b.tx != null && b.ty != null;
        const ux = hasTail ? (b.tx - (b.x ?? 0.5)) * W : 0, uy = hasTail ? (b.ty - (b.y ?? 0.5)) * H : 0;
        const hasBase = hasTail && b.bx != null && b.by != null;
        const vx = hasBase ? (b.bx - (b.x ?? 0.5)) * W : null, vy = hasBase ? (b.by - (b.y ?? 0.5)) * H : null;
        draw(it.svg, b, bw, bh, ux, uy, hasTail, Math.max(1.4, W * 0.0042), vx, vy);
        if (it.base) {                                                // le losange de la base se pose sur le contour de la bulle
          it.base.style.display = hasTail && ctl.selected === b.id ? "" : "none";
          if (hasTail) {
            const dx = hasBase ? vx : ux, dy = hasBase ? vy : uy, pad = (b.geo && b.geo.pad) || 1;
            let px = 0, py = bh * 0.68 * pad;
            if (dx || dy) {
              if (b.type === "box") { const hw = bw / 2 * 1.04 * pad, hh = bh / 2 * 1.02 * pad, s = Math.min(dx ? hw / Math.abs(dx) : 1e9, dy ? hh / Math.abs(dy) : 1e9); px = dx * s; py = dy * s; }
              else { const rx = bw * 0.66 * pad, ry = bh * 0.68 * pad, phi = Math.atan2(dy / ry, dx / rx); px = rx * Math.cos(phi); py = ry * Math.sin(phi); }
            }
            it.base.style.left = ((b.x ?? 0.5) + px / W) * 100 + "%"; it.base.style.top = ((b.y ?? 0.5) + py / H) * 100 + "%";
          }
        }
        if (it.tip) {
          it.tip.style.display = hasTail && ctl.selected === b.id ? "" : "none";
          if (hasTail) { it.tip.style.left = b.tx * 100 + "%"; it.tip.style.top = b.ty * 100 + "%"; }
        }
        it.node.classList.toggle("sel", ctl.selected === b.id);
      }
    }

    function show(it, on) {
      if (on === it.on) return;
      it.on = on;
      it.node.classList.toggle("on", on);
      if (!on) { clearInterval(it.timer); it.timer = null; it.bin.className = "ac-bin"; it.txt.textContent = it.b.text || ""; return; }
      const a = it.b.anim || "pop";
      it.bin.className = "ac-bin";
      void it.bin.offsetWidth;                                        // relance l'animation
      if (a === "type") {
        const full = String(it.b.text || ""); let n = 0;
        it.txt.innerHTML = `<span></span><span class="h">${esc(full)}</span>`;
        clearInterval(it.timer);
        it.timer = setInterval(() => {
          n++;
          it.txt.innerHTML = `<span>${esc(full.slice(0, n))}</span><span class="h">${esc(full.slice(n))}</span>`;
          if (n >= full.length) { clearInterval(it.timer); it.timer = null; it.txt.textContent = full; }
        }, 32);
      } else it.bin.classList.add("a-" + a);
    }

    // etat : { hover, t } ; en edition tout est visible
    function update(state) {
      if (ctl.edit) return;
      const st = state || {};
      for (const it of items) {
        const m = it.b.show || "always";
        let on = true;
        if (m === "hover") on = !!st.hover;
        else if (m === "time") on = st.t == null ? !!st.hover : st.t >= (it.b.at || 0);   // case fixe : au survol
        show(it, on);
      }
    }

    // apercu d'une apparition (editeur) : rejoue l'animation de la bulle choisie
    function replay(id) {
      const it = items.find((x) => x.b.id === id);
      if (!it) return;
      it.on = false; show(it, true);
    }

    const ro = new ResizeObserver(() => layout());
    ro.observe(root);
    // case qui bouge (cadrage anime) : le calque suit la case ; le texte garde sa taille (unite fixee par --cq, en px)
    ctl.place = (rect, unitPx) => {
      const [l, t, w, h] = rect;
      Object.assign(root.style, { inset: "auto", left: l + "%", top: t + "%", width: w + "%", height: h + "%" });
      if (unitPx) root.style.setProperty("--cq", unitPx + "px");
      layout();
    };
    ctl.layout = layout; ctl.update = update; ctl.replay = replay;
    ctl.setList = (l) => { list = l; build(); };
    ctl.select = (id) => { ctl.selected = id; layout(); };
    ctl.destroy = () => { ro.disconnect(); for (const it of items) clearInterval(it.timer); root.remove(); };
    build();
    // texte masque a la fin : relayout une fois les polices chargees
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
    update({ hover: false, t: null });
    return ctl;
  }

  window.AliveBubbles = { mount, SIZES, COLORS, COLOR_NAMES, FONTS, TYPES, ANIMS };
})();
