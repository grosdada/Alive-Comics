// « Animate framing » : timeline du cadrage anime, sous la planche.
// Une ligne par point d'attache (chaque trait a deux bouts : a et b) ; les losanges sont les images cles. Toucher une
// attache dans la planche selectionne sa ligne (le trait entier : ses deux lignes). Glisser l'attache pose une cle a
// l'instant de la tete de lecture.
// Les cles : clic = une cle, Maj / Ctrl + clic = en ajouter ou en retirer, glisser dans le vide d'une ligne = rectangle
// de selection (sur plusieurs lignes) ; glisser une cle choisie deplace toute la selection ; Suppr les efface ;
// clic droit = dupliquer, copier / coller, courbe (ease in / out...), supprimer (Ctrl+D, Ctrl+C, Ctrl+V, Ctrl+A).
// Les lignes : Maj / Ctrl + clic sur leur nom = plusieurs lignes ; « Toutes les lignes », « Clé partout », « Tout effacer ».
// Module « Style de page » (bouton 🎨, allume ou eteint) : fond, couleur des cases, couleur et epaisseur des traits,
// gouttiere, marge ; chaque ligne a son reglage, qui pose une cle a la tete de lecture.
import { h } from "./api.js";
import { EASES, PAGE_TRACKS, colorValue, cutIdsOf, nodeAt, rgbHex, trackValue } from "./geometry.js";

const pageOn = () => { try { return localStorage.getItem("ac-tl-page") === "1"; } catch (_) { return false; } };
const setPageOn = (v) => { try { localStorage.setItem("ac-tl-page", v ? "1" : "0"); } catch (_) { /* stockage indisponible */ } };

const fmt = (s) => (Math.round(s * 100) / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2 }) + " s";
const AFTER = 0.5;                  // « dupliquer juste apres » : la copie commence 0,5 s apres la selection
const macContextClick = e => e.ctrlKey && /Mac/.test(navigator.platform);

export class Timeline {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.selSet = new Set();         // cles choisies (les objets {t, v, e} des pistes)
    this.keyEls = new Map();         // cle -> son losange
    this.clip = null;                // cles copiees : [{track, dt, v, e}]
    const keep = app._tlKeep;        // planche rechargee : on reprend la selection et la copie
    app._tlKeep = null;
    if (keep) { this.clip = keep.clip; this.remap(keep); }
    this.el = h("div.tl");
    host.append(this.el);
    this.render();
  }

  // ce qu'on garde si la planche est rechargee ou si on annule : les cles choisies par leur ligne et leur instant
  state() {
    return { clip: this.clip, rows: this.selRows, sel: this.selList().map(g => g.track + "@" + g.k.t) };
  }
  remap(keep) {
    this.selRows = keep.rows;
    const want = new Set(keep.sel);
    this.selSet = new Set();
    for (const [track, keys] of Object.entries(this.tracks)) for (const k of keys || []) if (want.has(track + "@" + k.t)) this.selSet.add(k);
  }

  get P() { return this.app.project; }
  get tracks() { return (this.P.anim = this.P.anim || { tracks: {} }).tracks || (this.P.anim.tracks = {}); }

  // les traits dans l'ordre de l'arbre (stable) : [{id, n, dir, path}]
  cuts() {
    const out = [];
    (function walk(x, path) {
      if (!x || x.t !== "split") return;
      out.push({ id: x.id, dir: x.dir, path });
      walk(x.c[0], path.concat(0)); walk(x.c[1], path.concat(1));
    })(this.P.layout, []);
    return out.map((c, i) => Object.assign(c, { n: i + 1 }));
  }

  destroy() { this.closeMenu(); this.el.remove(); }

  render() {
    const app = this.app, dur = app.timelineLength();
    this.el.textContent = "";
    this.keyEls = new Map();
    this.selSet = new Set(this.selList().map(g => g.k));   // une annulation remplace les cles : oublier les anciennes
    const play = h("button.tl-btn", { title: "Lecture / pause (barre espace)", on: { click: () => app.animToggle() } }, app.animPlaying ? "⏸" : "▶");
    this.playBtn = play;
    this.timeEl = h("span.tl-time");
    const ease = h("select.tl-ease", { title: "Courbe entre la clé et la suivante (toutes les clés choisies)" }, EASES.map(([v, l]) => h("option", { value: v }, l)));
    ease.onchange = () => this.setEase(ease.value);
    this.easeEl = ease;
    const bar = h("div.tl-bar",
      h("b.tl-title", "🎞 Animate framing"),
      h("button.tl-btn", { title: "Début", on: { click: () => app.animSeek(0) } }, "⏮"), play, this.timeEl,
      h("span.tl-sep"),
      h("button.tl-btn", { title: "Poser une clé à la tête de lecture sur les lignes choisies (Maj + clic sur un nom de ligne : plusieurs)",
                           on: { click: () => this.addKeyHere() } }, "◆ Clé ici"),
      h("button.tl-btn", { title: "Poser une clé à la tête de lecture sur toutes les lignes d'un coup", on: { click: () => this.addKeyHere(Object.keys(this.rows)) } }, "◆ Clé partout"),
      h("button.tl-btn", { title: "Choisir toutes les lignes (puis « ◆ Clé ici »)", on: { click: () => this.selectAllRows() } }, "☰ Toutes les lignes"),
      h("label.tl-lab", "Courbe ", ease),
      h("button.tl-btn", { title: "Supprimer les clés choisies (Suppr)", on: { click: () => this.deleteKey() } }, "✕ Clé"),
      h("button.tl-btn", { title: "Retirer toute l'animation des lignes choisies (trait : ses deux bouts)", on: { click: () => this.clearCut() } }, "Effacer la ligne"),
      h("button.tl-btn", { title: "Retirer toutes les clés de toutes les lignes (chaque ligne garde sa valeur du moment ; Ctrl+Z pour revenir)",
                           on: { click: () => this.clearAll() } }, "Tout effacer"),
      h("span.tl-sep"),
      h("button.tl-btn" + (pageOn() ? ".on" : ""), { title: "Style de page : fond, couleur des cases, traits, gouttière, marge (animables)",
                                                     on: { click: () => { setPageOn(!pageOn()); this.render(); } } }, "🎨 Style de page"),
      h("span.sp"),
      h("small.muted", { title: "Glisser dans le vide d'une ligne : rectangle de sélection. Maj ou Ctrl + clic : ajouter une clé (ou une ligne). " +
                                "Clic droit sur une clé : dupliquer, copier, courbe (ease in / out). Suppr : effacer." }, `durée de la page ${fmt(dur)}`),
      h("button.tl-btn", { title: "Fermer la timeline (l'animation reste)", on: { click: () => app.setAnimMode(false) } }, "✕"));
    const grid = h("div.tl-grid");
    this.grid = grid;
    // regle
    const ruler = h("div.tl-row.tl-ruler", h("div.tl-label", ""), h("div.tl-lane"));
    const lane0 = ruler.lastChild;
    const step = dur > 30 ? 5 : dur > 12 ? 2 : dur > 4 ? 1 : 0.5;
    for (let t = 0; t <= dur + 1e-6; t += step) {
      lane0.append(h("span.tl-tick", { style: { left: (t / dur * 100) + "%" } }, String(Math.round(t * 10) / 10).replace(".", ",")));
    }
    this.bindLane(lane0, null);
    grid.append(ruler);
    this.rows = {};
    if (pageOn()) {                                  // module « Style de page »
      grid.append(h("div.tl-row.tl-section", h("div.tl-label", "Style de page"), h("div")));
      for (const d of PAGE_TRACKS) {
        const key = "page." + d.k;
        const ctl = this.pageControl(d, key);
        const label = h("div.tl-label", { title: "Choisir cette ligne (Maj ou Ctrl + clic : plusieurs)",
                                           on: { click: (e) => { if (!e.target.closest("input")) this.pickRow(key, e); } } },
          h("span", d.label), ctl.el);
        const lane = h("div.tl-lane");
        const row = h("div.tl-row", { "data-track": key, "data-cut": "page" }, label, lane);
        (this.tracks[key] || []).forEach((k, i) => lane.append(this.diamond(key, i, k, dur)));
        this.bindLane(lane, key);
        this.rows[key] = { row, val: null, lane, ctl };
        grid.append(row);
      }
      grid.append(h("div.tl-row.tl-section", h("div.tl-label", "Traits"), h("div")));
    }
    const cuts = this.cuts();
    if (!cuts.length) grid.append(h("p.muted.tl-empty", "Aucun trait : coupe d'abord des cases."));
    for (const c of cuts) {
      for (const end of ["a", "b"]) {
        const key = `${c.id}.${end}`;
        const side = c.dir === "h" ? (end === "a" ? "bout gauche" : "bout droit") : (end === "a" ? "bout haut" : "bout bas");
        const val = h("small.tl-val");
        const label = h("div.tl-label", { title: "Choisir cette attache (Maj ou Ctrl + clic : plusieurs lignes)",
                                           on: { click: (e) => e.shiftKey || e.ctrlKey || e.metaKey ? this.pickRow(key, e) : this.selectCut(c.id, end === "a" ? "end0" : "end1") } },
          h("span", `Trait ${c.n} · ${side}`, h("small.muted", c.dir === "h" ? " (horizontal)" : " (vertical)")), val);
        const lane = h("div.tl-lane");
        const row = h("div.tl-row", { "data-track": key, "data-cut": c.id }, label, lane);
        (this.tracks[key] || []).forEach((k, i) => lane.append(this.diamond(key, i, k, dur)));
        this.bindLane(lane, key);
        this.rows[key] = { row, val, lane };
        grid.append(row);
      }
    }
    this.head = h("div.tl-head");
    grid.append(this.head);
    this.el.append(bar, grid);
    this.paintSel();
    this.update();
  }

  diamond(key, i, k, dur) {
    const shown = typeof k.v === "string" ? k.v : key.startsWith("page.") ? String(Math.round(k.v * 10) / 10) : Math.round(k.v * 100) + " %";
    const d = h("span.tl-key", { title: `${fmt(k.t)} · ${shown}`, style: { left: (k.t / dur * 100) + "%" },
                                 "data-track": key, "data-i": String(i) });
    this.keyEls.set(k, d);
    d.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!this.selSet.has(k)) this.selSet = new Set([k]);
      this.selectRow(key);
      this.keyMenu(e.clientX, e.clientY);
    });
    d.addEventListener("pointerdown", (e) => {
      // Sur Mac, Ctrl + clic produit un menu contextuel après pointerdown.
      // Laisser contextmenu conserver le groupe au lieu de retirer cette clé ici.
      if (e.button !== 0 || macContextClick(e)) return;
      e.stopPropagation();
      this.closeMenu();
      const add = e.shiftKey || e.ctrlKey || e.metaKey;
      if (add && this.selSet.has(k)) { this.selSet.delete(k); this.paintSel(); return; }   // Maj + clic : la retirer
      if (add) this.selSet.add(k);
      else if (!this.selSet.has(k)) this.selSet = new Set([k]);
      this.selectRow(key);
      // glisser : toute la selection se decale d'autant (dans les limites de la timeline)
      const r = d.parentNode.getBoundingClientRect(), dur2 = this.app.timelineLength();
      const group = this.selList(), t0 = new Map(group.map(g => [g.k, g.k.t])), k0 = k.t;
      const lo = -Math.min(...group.map(g => g.k.t)), hi = dur2 - Math.max(...group.map(g => g.k.t));
      const x0 = e.clientX;
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        const dt = Math.max(lo, Math.min(hi, this.app.snap(k0 + (ev.clientX - x0) / r.width * dur2) - k0));
        moved = true;
        for (const g of group) {
          g.k.t = t0.get(g.k) + dt;
          const el = this.keyEls.get(g.k);
          if (el) el.style.left = (g.k.t / dur2 * 100) + "%";
        }
        this.app.animSeek(k0 + dt, true);
      };
      const up = () => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", up);
        if (moved) {
          this.tidy(new Set(group.map(g => g.track)));
          this.app.animChanged();
        } else {
          if (!add) this.selSet = new Set([k]);     // simple clic sur une cle deja choisie : elle seule
          this.app.animSeek(k.t);
          this.paintSel();
        }
      };
      addEventListener("pointermove", move); addEventListener("pointerup", up);   // toute la fenetre
    });
    d.addEventListener("dblclick", (e) => e.stopPropagation());
    return d;
  }

  // une ligne : clic = choisir la ligne et placer la tete de lecture ; glisser = rectangle de selection des cles ;
  // double-clic = une cle a cet instant ; clic droit = coller, cle ici. La regle : clic ou glisser = tete de lecture.
  bindLane(lane, key) {
    const at = (ev) => {
      const r = lane.getBoundingClientRect(), dur = this.app.timelineLength();
      return this.app.snap(Math.max(0, Math.min(dur, (ev.clientX - r.left) / r.width * dur)));
    };
    lane.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.closeMenu();
      if (!key) {                                    // regle : tete de lecture
        this.app.animSeek(at(e));
        const move = (ev) => this.app.animSeek(at(ev), true);
        const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
        addEventListener("pointermove", move); addEventListener("pointerup", up);
        return;
      }
      const x0 = e.clientX, y0 = e.clientY, add = e.shiftKey || e.ctrlKey || e.metaKey;
      const base = add ? new Set(this.selSet) : new Set();
      let box = null;
      const move = (ev) => {
        if (!box && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        if (!box) { box = h("div.tl-marquee"); this.grid.append(box); }
        const g = this.grid.getBoundingClientRect();
        const L = Math.min(x0, ev.clientX), R = Math.max(x0, ev.clientX), T = Math.min(y0, ev.clientY), B = Math.max(y0, ev.clientY);
        Object.assign(box.style, { left: (L - g.left + this.grid.scrollLeft) + "px", top: (T - g.top + this.grid.scrollTop) + "px",
                                   width: (R - L) + "px", height: (B - T) + "px" });
        const sel = new Set(base);
        for (const [k, el] of this.keyEls) {
          const b = el.getBoundingClientRect(), cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
          if (cx >= L - 4 && cx <= R + 4 && cy >= T - 4 && cy <= B + 4) sel.add(k);
        }
        this.selSet = sel;
        this.paintKeys();
      };
      const up = (ev) => {
        removeEventListener("pointermove", move); removeEventListener("pointerup", up);
        if (box) { box.remove(); this.paintSel(); return; }
        if (!add) this.selSet = new Set();
        this.selectRow(key);
        this.app.animSeek(at(ev));
      };
      addEventListener("pointermove", move); addEventListener("pointerup", up);   // toute la fenetre
    });
    if (key) {
      lane.addEventListener("dblclick", () => { this.selectRow(key); this.addKeyHere([key]); });
      lane.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.selectRow(key);
        this.app.animSeek(at(e));
        this.laneMenu(e.clientX, e.clientY, key);
      });
    }
  }

  // les cles choisies encore presentes, dans l'ordre des pistes : [{track, k}]
  selList() {
    const out = [];
    for (const [track, keys] of Object.entries(this.tracks)) for (const k of keys || []) if (this.selSet.has(k)) out.push({ track, k });
    return out;
  }
  selKey() { return this.selList()[0]?.k || null; }

  // une cle par image et par piste, dans l'ordre ; en cas de collision, la cle choisie (deplacee, collee) gagne
  tidy(tracks) {
    const eps = 0.5 / ((this.P.export || {}).fps || 30);
    for (const track of tracks) {
      const keys = this.tracks[track];
      if (!keys) continue;
      keys.sort((x, y) => x.t - y.t);
      for (let j = keys.length - 1; j > 0; j--) {
        if (Math.abs(keys[j].t - keys[j - 1].t) < eps) keys.splice(this.selSet.has(keys[j]) ? j - 1 : j, 1);
      }
    }
  }

  // l'attache touchee dans la planche : sa ligne (ou les deux lignes du trait pour la poignee du milieu)
  selectCut(id, mode) {
    this.app.selectedCut = id;
    this.selRows = mode === "end0" ? [`${id}.a`] : mode === "end1" ? [`${id}.b`] : [`${id}.a`, `${id}.b`];
    this.selSet = new Set();
    this.paintSel();
    const r = this.rows && this.rows[this.selRows[0]];
    if (r) r.row.scrollIntoView({ block: "nearest" });
    this.app.editor?.render();
  }
  selectRow(key) {
    this.app.selectedCut = key.split(".")[0];
    this.selRows = [key];
    this.paintSel();
    this.app.editor?.render();
  }
  // clic sur un nom de ligne : Maj / Ctrl = l'ajouter ou la retirer
  pickRow(key, e) {
    if (!(e.shiftKey || e.ctrlKey || e.metaKey)) { this.selectRow(key); return; }
    const rows = new Set(this.selRows || []);
    if (rows.has(key)) rows.delete(key); else rows.add(key);
    this.selRows = [...rows];
    this.app.selectedCut = rows.has(key) ? key.split(".")[0] : this.app.selectedCut;
    this.paintSel();
    this.app.editor?.render();
  }
  selectAllRows() {
    this.selRows = Object.keys(this.rows || {});
    this.paintSel();
  }

  paintKeys() {
    for (const [k, el] of this.keyEls) el.classList.toggle("on", this.selSet.has(k));
  }

  paintSel() {
    const history = this.app._timelineStates;
    if (history) {
      history.set(this.app.snapshot(), this.state());
      if (history.size > 160) history.delete(history.keys().next().value);
    }
    for (const [key, r] of Object.entries(this.rows || {})) {
      r.row.classList.toggle("sel", !!this.selRows && this.selRows.includes(key));
      r.row.classList.toggle("cut", r.row.dataset.cut === this.app.selectedCut);
    }
    this.paintKeys();
    const k = this.selKey();
    this.easeEl.disabled = !k;
    if (k) this.easeEl.value = k.e || "ease";
  }

  // ------------------------------------------------------------------ actions sur les cles choisies
  setEase(e) {
    const list = this.selList();
    if (!list.length) return;
    for (const g of list) g.k.e = e;
    this.app.animChanged();
  }

  selectAll() {
    this.selSet = new Set(Object.values(this.tracks).flat());
    this.paintSel();
  }

  copy() {
    const list = this.selList();
    if (!list.length) return false;
    const t0 = Math.min(...list.map(g => g.k.t));
    this.clip = list.map(g => ({ track: g.track, dt: g.k.t - t0, v: g.k.v, e: g.k.e || "ease" }));
    this.app.toast(list.length > 1 ? `${list.length} clés copiées.` : "Clé copiée.");
    return true;
  }

  // pose des cles a partir de l'instant t (les cles deja la, au meme instant, sont remplacees) ; elles deviennent la
  // selection, pretes a etre glissees
  place(items, t) {
    const fresh = new Set();
    for (const it of items) {
      const keys = this.tracks[it.track] = this.tracks[it.track] || [];
      const k = { t: this.app.snap(t + it.dt), v: it.v, e: it.e || "ease" };
      keys.push(k);
      fresh.add(k);
    }
    this.selSet = fresh;
    this.tidy(new Set(items.map(it => it.track)));
    this.app.animChanged();
  }

  paste(t) {
    if (!this.clip || !this.clip.length) return false;
    const live = new Set([...cutIdsOf(this.P.layout), "page"]);
    const items = this.clip.filter(c => live.has(c.track.split(".")[0]));
    if (!items.length) { this.app.toast("Les lignes copiées n'existent plus."); return true; }
    this.place(items, t ?? this.app.snap(this.app.animT));
    return true;
  }

  // dupliquer la selection : a la tete de lecture, ou juste apres elle (« after »)
  duplicate(where) {
    const list = this.selList();
    if (!list.length) { this.app.toast("Choisis d'abord une ou plusieurs clés."); return; }
    const t0 = Math.min(...list.map(g => g.k.t)), t1 = Math.max(...list.map(g => g.k.t));
    let t = this.app.snap(this.app.animT);
    if (where === "after" || Math.abs(t - t0) < 1e-6) t = this.app.snap(t1 + AFTER);
    this.place(list.map(g => ({ track: g.track, dt: g.k.t - t0, v: g.k.v, e: g.k.e })), t);
  }

  // ------------------------------------------------------------------ menus du clic droit
  closeMenu() { this.menu?.remove(); this.menu = null; }

  popMenu(x, y, items) {
    this.closeMenu();
    const menu = h("div.popmenu.tl-menu", items.map(it => it === "-" ? h("hr") : it.head ? h("div.tl-menu-head", it.head) :
      h("button", { disabled: !!it.off, on: { click: () => { this.closeMenu(); it.do(); } } },
        h("span", it.label), it.kbd ? h("kbd", it.kbd) : null)));
    document.body.append(menu);
    this.menu = menu;
    menu.style.left = Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, x)) + "px";
    menu.style.top = Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, y)) + "px";
    const away = (e) => {
      if (this.menu === menu && menu.contains(e.target)) return;
      if (this.menu === menu) this.closeMenu();
      document.removeEventListener("pointerdown", away, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  }

  keyMenu(x, y) {
    const list = this.selList(), n = list.length, cur = list[0]?.k.e || "ease";
    const many = n > 1 ? ` (${n} clés)` : "";
    this.popMenu(x, y, [
      { label: "⧉ Dupliquer à la tête de lecture" + many, kbd: "Ctrl+D", do: () => this.duplicate("head") },
      { label: "⧉ Dupliquer juste après", do: () => this.duplicate("after") },
      "-",
      { label: "Copier" + many, kbd: "Ctrl+C", do: () => this.copy() },
      { label: "Coller à la tête de lecture", kbd: "Ctrl+V", off: !this.clip, do: () => this.paste() },
      "-",
      { head: "Courbe jusqu'à la clé suivante" + many },
      ...EASES.map(([v, , long]) => ({ label: (v === cur ? "✓ " : "  ") + long, do: () => this.setEase(v) })),
      "-",
      { label: "✕ Supprimer" + many, kbd: "Suppr", do: () => this.deleteKey() },
    ]);
  }

  laneMenu(x, y, key) {
    this.popMenu(x, y, [
      { label: "◆ Clé ici", do: () => this.addKeyHere([key]) },
      { label: "Coller ici", kbd: "Ctrl+V", off: !this.clip, do: () => this.paste() },
      { label: "Tout sélectionner", kbd: "Ctrl+A", do: () => this.selectAll() },
      "-",
      { label: "◆ Clé partout (toutes les lignes)", do: () => this.addKeyHere(Object.keys(this.rows)) },
    ]);
  }

  // reglage d'une ligne du style de page : couleur ou curseur ; il pose une cle a la tete de lecture
  pageControl(d, key) {
    const app = this.app, t0 = () => app.snap(app.animT);
    const put = (v, done) => {
      const keys = this.tracks[key] || [];
      if (!keys.length && t0() > 1e-6) app.setKey(key, 0, this.valueOf(key, 0));   // part de la valeur d'avant
      app.setKey(key, t0(), v);
      this.selectRow(key);
      if (done) app.animChanged(); else { app.editor.render(true); this.update(); }
    };
    if (d.color) {
      const inp = h("input", { type: "color", title: "Couleur à cet instant (pose une clé)" });
      inp.addEventListener("input", () => put(inp.value, false));
      inp.addEventListener("change", () => put(inp.value, true));
      return { el: h("span.tl-ctl", inp), set: (v) => { if (document.activeElement !== inp) inp.value = v; } };
    }
    const inp = h("input", { type: "range", min: d.min, max: d.max, step: d.step, title: "Valeur à cet instant (pose une clé)" });
    const out = h("output");
    inp.addEventListener("input", () => { out.textContent = inp.value; put(+inp.value, false); });
    inp.addEventListener("change", () => put(+inp.value, true));
    return { el: h("span.tl-ctl", inp, out), set: (v) => { if (document.activeElement !== inp) inp.value = v; out.textContent = Math.round(v * 10) / 10; } };
  }

  // valeur actuelle d'une ligne : attache (dans l'arbre et ses cles) ou style de page
  valueOf(track, t) {
    if (track.startsWith("page.")) {
      const k = track.slice(5), d = PAGE_TRACKS.find(x => x.k === k), pg = this.P.page;
      if (d && d.color) return rgbHex(colorValue(this.tracks[track], t, pg[k] || (k === "stroke" ? "#111111" : "#ffffff")));
      return trackValue(this.tracks[track], t, +pg[k] || 0);
    }
    const [id, end] = track.split(".");
    const c = this.cuts().find(x => x.id === id);
    if (!c) return 0;
    const node = nodeAt(this.P.layout, c.path);
    return trackValue(this.tracks[track], t, node[end]);
  }

  addKeyHere(list) {
    const rows = list || this.selRows;
    if (!rows || !rows.length) { this.app.toast("Choisis d'abord une ligne (ou touche une attache dans la planche)."); return; }
    const t = this.app.snap(this.app.animT);
    for (const track of rows) this.app.setKey(track, t, this.valueOf(track, t));
    this.app.animChanged();
  }

  // efface les cles choisies
  deleteKey() {
    const list = this.selList();
    if (!list.length) { this.app.toast("Choisis d'abord une ou plusieurs clés (losanges)."); return; }
    for (const { track, k } of list) {
      const keys = this.tracks[track];
      keys.splice(keys.indexOf(k), 1);
      if (!keys.length) delete this.tracks[track];
    }
    this.selSet = new Set();
    this.app.animChanged();
  }

  // toutes les cles de toutes les lignes : chaque ligne garde sa valeur a la tete de lecture
  clearAll() {
    const tracks = Object.keys(this.tracks).filter(k => (this.tracks[k] || []).length);
    if (!tracks.length) { this.app.toast("Aucune clé."); return; }
    if (!confirm(`Effacer toutes les clés (${tracks.length} lignes animées) ?\nChaque ligne garde sa valeur à la tête de lecture. Ctrl+Z pour revenir.`)) return;
    const t = this.app.animT, cuts = this.cuts();
    for (const track of tracks) {
      const v = this.valueOf(track, t);
      if (track.startsWith("page.")) this.P.page[track.slice(5)] = v;
      else {
        const [id, end] = track.split("."), c = cuts.find(x => x.id === id);
        if (c) nodeAt(this.P.layout, c.path)[end] = v;
      }
      delete this.tracks[track];
    }
    this.selSet = new Set();
    this.app.animChanged();
    this.app.refreshInspector();
  }

  clearCut() {
    const id = this.app.selectedCut;
    if (!id) { this.app.toast("Choisis d'abord une ligne."); return; }
    const t = this.app.animT;
    if (id === "page") {                           // style de page : la ligne garde sa valeur du moment
      for (const track of this.selRows || []) {
        if (!track.startsWith("page.")) continue;
        this.P.page[track.slice(5)] = this.valueOf(track, t);
        delete this.tracks[track];
      }
      this.selSet = new Set();
      this.app.animChanged();
      this.app.refreshInspector();
      return;
    }
    for (const end of ["a", "b"]) {                // le trait garde la position qu'il a a cet instant
      const track = `${id}.${end}`;
      if (!this.tracks[track]) continue;
      const c = this.cuts().find(x => x.id === id);
      if (c) nodeAt(this.P.layout, c.path)[end] = this.valueOf(track, t);
      delete this.tracks[track];
    }
    this.selSet = new Set();
    this.app.animChanged();
  }

  // tete de lecture, temps, valeurs (sans tout redessiner)
  update() {
    const dur = this.app.timelineLength(), t = this.app.animT;
    if (this.head) this.head.style.left = `calc(var(--tl-label) + var(--tl-pad) + (100% - var(--tl-label) - 2 * var(--tl-pad)) * ${Math.min(1, t / dur)})`;
    if (this.head && this.grid) this.head.style.height = this.grid.scrollHeight + "px";
    if (this.timeEl) this.timeEl.textContent = `${fmt(t)} / ${fmt(dur)}`;
    if (this.playBtn) this.playBtn.textContent = this.app.animPlaying ? "⏸" : "▶";
    for (const [key, r] of Object.entries(this.rows || {})) {
      if (r.ctl) { r.ctl.set(this.valueOf(key, t)); continue; }
      r.val.textContent = Math.round(this.valueOf(key, t) * 100) + " %" + ((this.tracks[key] || []).length ? "" : " · fixe");
    }
  }

  ids() { return cutIdsOf(this.P.layout); }
}
