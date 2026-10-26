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
.ac-btxt { position: relative; font-family: var(--bf); font-weight: var(--bw8, 700); text-transform: var(--bt, none); text-align: center; white-space: pre-wrap; overflow-wrap: anywhere; max-width: calc(var(--mw, 34) * 1cqw);
  padding: .55em .8em; width: max-content; font-size: calc(var(--fs, 5.6) * 1cqw); }
.ac-btxt .h { visibility: hidden; }
.ac-bub.ed { pointer-events: auto; cursor: grab; }
.ac-bub.ed.sel .ac-btxt { outline: 2px dashed rgba(179, 107, 255, .9); outline-offset: 4px; border-radius: 6px; }
.ac-btip { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; background: #b36bff; border: 2px solid #fff; transform: rotate(45deg);
  pointer-events: auto; cursor: grab; z-index: 2; border-radius: 2px; }
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
  function ellipseTail(rx, ry, ux, uy, spread) {
    const d = Math.hypot(ux / rx, uy / ry);
    if (d < 1.06) return null;
    const phi = Math.atan2(uy / ry, ux / rx);
    const pt = (a, k) => [rx * k * Math.cos(a), ry * k * Math.sin(a)];
    const b1 = pt(phi - spread, 1), b2 = pt(phi + spread, 1);
    const i1 = pt(phi - spread, 0.82), i2 = pt(phi + spread, 0.82);
    // pointe : un peu en retrait pour que le trait ne depasse pas
    return { tail: `M ${b1} L ${ux} ${uy} L ${b2} Z`, cover: `M ${b1} L ${ux * 0.97 + (b1[0] + b2[0]) * 0.015} ${uy * 0.97 + (b1[1] + b2[1]) * 0.015} L ${b2} L ${i2} L ${i1} Z` };
  }
  function boxTail(hw, hh, ux, uy, spread) {
    if (Math.abs(ux) < hw && Math.abs(uy) < hh) return null;
    let b1, b2, i1, i2;
    if (Math.abs(uy) * hw >= Math.abs(ux) * hh) {                 // bord haut ou bas
      const sy = uy > 0 ? 1 : -1, cx = Math.max(-hw * 0.7, Math.min(hw * 0.7, ux * 0.5));
      b1 = [cx - spread, sy * hh]; b2 = [cx + spread, sy * hh]; i1 = [cx - spread, sy * hh * 0.7]; i2 = [cx + spread, sy * hh * 0.7];
    } else {
      const sx = ux > 0 ? 1 : -1, cy = Math.max(-hh * 0.7, Math.min(hh * 0.7, uy * 0.5));
      b1 = [sx * hw, cy - spread]; b2 = [sx * hw, cy + spread]; i1 = [sx * hw * 0.8, cy - spread]; i2 = [sx * hw * 0.8, cy + spread];
    }
    return { tail: `M ${b1} L ${ux} ${uy} L ${b2} Z`, cover: `M ${b1} L ${ux * 0.97} ${uy * 0.97} L ${b2} L ${i2} L ${i1} Z` };
  }
  function roundRect(hw, hh, r) {
    return `M ${-hw + r} ${-hh} H ${hw - r} Q ${hw} ${-hh} ${hw} ${-hh + r} V ${hh - r} Q ${hw} ${hh} ${hw - r} ${hh} H ${-hw + r} ` +
           `Q ${-hw} ${hh} ${-hw} ${hh - r} V ${-hh + r} Q ${-hw} ${-hh} ${-hw + r} ${-hh} Z`;
  }
  function star(rx, ry, n, seed) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const a = (i * Math.PI) / n + 0.2, out = i % 2 === 0;
      const k = out ? 1.12 + 0.1 * (hash(seed + "o" + i) - 0.5) : 0.8 + 0.06 * (hash(seed + "i" + i) - 0.5);
      pts.push([rx * k * Math.cos(a), ry * k * Math.sin(a)]);
    }
    return "M " + pts.map((p) => p.map(f2).join(" ")).join(" L ") + " Z";
  }

  function draw(svg, b, bw, bh, ux, uy, hasTail, sw) {
    svg.textContent = "";
    const [fill, stroke] = colorOf(b);
    const base = { fill, stroke, "stroke-width": sw, "stroke-linejoin": "round", "stroke-linecap": "round" };
    const add = (d, extra) => { const p = el("path", Object.assign({ d }, base, extra)); svg.append(p); return p; };
    const rx = bw * 0.66, ry = bh * 0.68, dash = b.type === "whisper" ? { "stroke-dasharray": `${sw * 2.2} ${sw * 1.9}` } : {};
    const spread = Math.max(0.2, Math.min(0.42, 26 / Math.max(30, Math.min(rx, ry)))) ;
    if (b.type === "box") {
      const hw = bw / 2 * 1.04, hh = bh / 2 * 1.02, t = hasTail ? boxTail(hw, hh, ux, uy, Math.max(sw * 3, Math.min(hw, hh) * 0.3)) : null;
      if (t) add(t.tail);
      add(roundRect(hw, hh, Math.min(hw, hh) * 0.16));
      if (t) add(t.cover, { stroke: "none" });
      return;
    }
    if (b.type === "thought") {
      const n = 11, r = Math.min(rx, ry) * 0.36;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        add(`M ${f2(rx * 0.86 * Math.cos(a) - r)} ${f2(ry * 0.86 * Math.sin(a))} a ${f2(r)} ${f2(r)} 0 1 0 ${f2(2 * r)} 0 a ${f2(r)} ${f2(r)} 0 1 0 ${f2(-2 * r)} 0 Z`);
      }
      add(ellipse(rx * 0.86, ry * 0.86), { stroke: "none" });
      if (hasTail) {
        const d = Math.hypot(ux / rx, uy / ry);
        if (d > 1.1) {
          const phi = Math.atan2(uy / ry, ux / rx), sx = rx * 1.08 * Math.cos(phi), sy = ry * 1.08 * Math.sin(phi);
          [[0.3, 0.17], [0.62, 0.12], [0.92, 0.085]].forEach(([k, s]) => {
            const cx = sx + (ux - sx) * k, cy = sy + (uy - sy) * k, rr = Math.max(sw * 1.4, Math.min(rx, ry) * s);
            add(`M ${f2(cx - rr)} ${f2(cy)} a ${f2(rr)} ${f2(rr)} 0 1 0 ${f2(2 * rr)} 0 a ${f2(rr)} ${f2(rr)} 0 1 0 ${f2(-2 * rr)} 0 Z`);
          });
        }
      }
      return;
    }
    if (b.type === "shout") {
      const R = [rx * 1.05, ry * 1.1], t = hasTail ? ellipseTail(rx * 0.95, ry * 0.95, ux, uy, spread) : null;
      if (t) add(t.tail);
      add(star(R[0], R[1], 13, b.id || "x"));
      if (t) add(t.cover, { stroke: "none" });
      return;
    }
    const t = hasTail ? ellipseTail(rx, ry, ux, uy, spread) : null;       // oval, chuchotement
    if (t) add(t.tail, dash);
    add(ellipse(rx, ry), dash);
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
      for (const it of items) { it.node.remove(); it.tip && it.tip.remove(); clearInterval(it.timer); }
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
        if (ctl.edit) { it.tip = document.createElement("div"); it.tip.className = "ac-btip"; it.tip.dataset.id = b.id || ""; root.append(it.tip); }
        items.push(it);
      }
      layout();
    }

    function layout() {
      const W = root.clientWidth || 1, H = root.clientHeight || 1;
      for (const it of items) {
        const b = it.b, text = colorOf(b)[2], F = FONTS[b.font] || FONTS.bd;
        it.node.style.left = (b.x ?? 0.5) * 100 + "%"; it.node.style.top = (b.y ?? 0.5) * 100 + "%";
        it.txt.style.setProperty("--fs", SIZES[b.size] || SIZES.M);
        it.txt.style.setProperty("--mw", b.type === "box" ? 62 : b.type === "shout" ? 36 : 32);
        it.txt.style.color = text;
        it.txt.style.setProperty("--bf", F[1]); it.txt.style.setProperty("--bw8", F[2]); it.txt.style.setProperty("--bt", F[3] || "none");
        if (!it.timer) it.txt.textContent = b.text || (ctl.edit ? "…" : "");
        const bw = it.txt.offsetWidth, bh = it.txt.offsetHeight;
        const hasTail = b.tx != null && b.ty != null;
        const ux = hasTail ? (b.tx - (b.x ?? 0.5)) * W : 0, uy = hasTail ? (b.ty - (b.y ?? 0.5)) * H : 0;
        draw(it.svg, b, bw, bh, ux, uy, hasTail, Math.max(1.4, W * 0.0042));
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
