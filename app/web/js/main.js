// Alive-Comics : application (etat, projets, edition, rendus, export, publication, reglages, livres).
import { api, get, post, put, upload, h, toast, debounce, modal, loadImage } from "./api.js";
import { compute, PRESETS, PAGE_DEFAULTS, FORMATS, pageSize, transpose, randomLayout, removeLeaf, splitLeaf, leaves, clone } from "./geometry.js";
import { Editor, icon } from "./editor.js";
import { startImage, pageImages } from "./exporter.js";
import { cameraForm, actionForm, audioForm, renderSection, pageForm, statusText, sideName } from "./forms.js";

const NEW_PANEL = () => ({ camera: { id: "arc", fields: {} }, action: { id: "fige", fields: {} }, audio: { mode: "none" } });

class App {
  constructor() {
    this.project = null;
    this.selected = null;
    this.jobs = [];
    this.workers = [];
    this.undo = [];
    this.redo = [];
    this.saveSoon = debounce(() => this.save(), 700);
    this.pageSoon = debounce(() => this.uploadPage(), 2500);
    this.commitSoon = debounce((k) => this.commit(k), 350);
  }

  async init() {
    [this.presets, this.settings, this.info] = await Promise.all([get("presets"), get("settings"), get("info")]);
    this.root = document.getElementById("app");
    window.addEventListener("hashchange", () => this.route());
    document.addEventListener("keydown", (e) => this.keys(e));
    setInterval(() => this.pollJobs(), 2000);
    setInterval(() => this.pollWorkers(), 5000);
    this.pollWorkers();
    this.route();
  }

  route() {
    const m = location.hash.match(/^#p=([a-z0-9-]+)/);
    if (m) this.open(m[1]); else this.home();
  }

  // ================================================================ accueil : projets et livres
  async home() {
    this.project = null; this.selected = null;
    const [projects, books] = await Promise.all([get("projects"), get("books")]);
    this.root.textContent = "";
    this.root.append(this.topbar(true));
    const grid = h("div.cards",
      h("button.card.new", { on: { click: () => this.newProjectDialog() } }, h("span.plus", "+"), h("b", "Nouvelle planche")),
      projects.map(p => h("a.card", { href: "#p=" + p.id },
        p.thumb ? h("img", { src: p.thumb + "?t=" + Math.round(p.updated) }) : h("div.noimg"),
        h("div", h("b", p.name), h("small", `${p.panels} cases · ${new Date(p.updated * 1000).toLocaleString("fr-FR")}`)))));
    const bookList = h("div.books", books.length ? books.map(b => this.bookRow(b, books, projects)) : h("p.muted", "Aucun livre pour l'instant."),
      h("button", { on: { click: async () => {
        books.push({ id: Math.random().toString(36).slice(2, 8), title: "Nouveau livre", pages: [] });
        await put("books", books); this.home();
      } } }, "+ Nouveau livre"));
    this.root.append(h("main.home", h("h2", "Planches"), grid, h("h2", "Livres (plusieurs planches à feuilleter)"), bookList));
  }

  bookRow(b, books, projects) {
    const save = async () => { await put("books", books); };
    const title = h("input.btitle", { value: b.title });
    title.addEventListener("change", () => { b.title = title.value; save(); });
    // les pages du livre, en vignettes numerotees (ordre de lecture)
    const pages = h("div.bpages", b.pages.length ? b.pages.map((pid, i) => {
      const p = projects.find(x => x.id === pid);
      return h("div.bpage",
        h("span.bnum", String(i + 1)),
        p?.thumb ? h("img", { src: p.thumb + "?t=" + Math.round(p.updated) }) : h("div.noimg"),
        h("small", p ? p.name : pid + " (supprimée)"),
        h("div.row",
          h("button.mini", { title: "Avancer", disabled: i === 0, on: { click: () => { [b.pages[i - 1], b.pages[i]] = [b.pages[i], b.pages[i - 1]]; save().then(() => this.home()); } } }, "◀"),
          h("button.mini", { title: "Reculer", disabled: i === b.pages.length - 1, on: { click: () => { [b.pages[i + 1], b.pages[i]] = [b.pages[i], b.pages[i + 1]]; save().then(() => this.home()); } } }, "▶"),
          h("button.mini", { title: "Retirer du livre", on: { click: () => { b.pages.splice(i, 1); save().then(() => this.home()); } } }, "✕")));
    }) : h("p.muted", "Aucune page : ajoute des planches ci-dessous."));
    const add = h("select", projects.map(p => h("option", { value: p.id }, p.name)));
    const addBtn = h("button", { on: { click: async () => {
      if (!add.value) return;
      b.pages.push(add.value); await save();
      toast(`« ${add.selectedOptions[0].textContent} » ajoutée : le livre a ${b.pages.length} page${b.pages.length > 1 ? "s" : ""}.`, "ok");
      this.home();
    } } }, "+ Ajouter cette planche");
    const act = async (what) => {
      if (what === "publish" && b.pages.length < 2 && !confirm(`Ce livre n'a que ${b.pages.length} page : on ne pourra pas tourner les pages. Publier quand même ?`)) return;
      const tab = what === "export" ? openPending("Assemblage du livre…") : null;
      if (what === "publish") toast("Publication du livre…");
      try {
        const res = await post(`books/${b.id}/${what}`);
        if (what === "export") showIn(tab, res.url);
        else this.publishedDialog(res.url);
      } catch (e) { if (tab) tab.close(); toast(e.message, "error", 9000); }
    };
    return h("div.book", h("div.row", title, h("span.muted", `${b.pages.length} page${b.pages.length > 1 ? "s" : ""}`)), pages,
      h("div.row", add, addBtn),
      h("div.row",
        h("button", { on: { click: () => act("export") } }, "Aperçu"),
        h("button.primary", { on: { click: () => act("publish") } }, "Publier le livre"),
        h("button.mini", { on: { click: async () => { if (confirm("Supprimer ce livre (les planches restent) ?")) { books.splice(books.indexOf(b), 1); await save(); this.home(); } } } }, "Supprimer le livre")));
  }

  newProjectDialog() {
    const name = h("input", { value: "Planche " + new Date().toLocaleDateString("fr-FR") });
    const fmt = h("select", FORMATS.map(f => h("option", { value: f.id }, f.label)));
    let preset = "david", orient = "portrait";
    const thumbs = h("div.preset-grid", PRESETS.map(p => {
      const b = h("button.preset" + (p.id === preset ? ".on" : ""), { title: p.label, on: { click: () => {
        preset = p.id; thumbs.querySelectorAll(".preset").forEach(x => x.classList.toggle("on", x === b));
      } } }, presetThumb(p, FORMATS[0]), h("span", p.label));
      return b;
    }));
    const redrawThumbs = () => {
      const [w, hh] = pageSize(fmt.value, orient);
      thumbs.querySelectorAll(".preset").forEach((b, i) => b.firstChild.replaceWith(presetThumb(PRESETS[i], { w, h: hh })));
    };
    fmt.addEventListener("change", redrawThumbs);
    const sens = h("div.seg", [["portrait", "Vertical"], ["paysage", "Horizontal"]].map(([k, l]) => {
      const b = h("button" + (k === orient ? ".on" : ""), { on: { click: () => {
        orient = k; sens.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); redrawThumbs();
      } } }, l);
      return b;
    }));
    modal("Nouvelle planche", h("div.form", h("label.field", h("span.lab", "Nom"), name), h("div.row", h("label.field", h("span.lab", "Format"), fmt), h("label.field", h("span.lab", "Sens"), sens)),
                                h("span.lab", "Découpage de départ (modifiable ensuite)"), thumbs), [
      { label: "Annuler" },
      { label: "Créer", primary: true, click: async () => {
        const [w, hh] = pageSize(fmt.value, orient);
        const page = Object.assign({}, PAGE_DEFAULTS, { format: fmt.value, orientation: orient, width: w, height: hh });
        let n = 0;
        const layout = PRESETS.find(p => p.id === preset).make(() => ({ t: "leaf", id: "p" + (++n) }));
        const p = await post("projects", { name: name.value, page, layout });
        p.nextId = n + 1;
        for (const id of leaves(layout)) p.panels[id] = NEW_PANEL();
        await put("projects/" + p.id, p);
        location.hash = "#p=" + p.id;
      } }]);
  }

  // ================================================================ espace de travail
  async open(pid) {
    try { this.project = await get("projects/" + pid); }
    catch (e) { toast(e.message, "error"); location.hash = ""; return; }
    const P = this.project;
    P.page = Object.assign({}, PAGE_DEFAULTS, P.page);
    if (P.page.format === "paysage") Object.assign(P.page, { format: "ecran", orientation: "paysage" });
    P.nextId = P.nextId || (Math.max(0, ...leaves(P.layout).map(id => +id.slice(1) || 0)) + 1);
    for (const id of leaves(P.layout)) P.panels[id] = Object.assign(NEW_PANEL(), P.panels[id] || {});
    this.selected = null; this.undo = []; this.redo = [];
    this.root.textContent = "";
    this.root.append(this.topbar(false));
    this.left = h("aside.left");
    this.center = h("section.center");
    this.right = h("aside.right");
    this.drawer = h("div.drawer");
    this.root.append(h("div.work", this.left, this.center, this.right), this.drawer);
    this.editor = new Editor(this.center, this);
    this.editor.render();
    this.renderLeft();
    this.refreshInspector();
    this.renderDrawer();
    this.pollJobs();
    this.save(true);
  }

  topbar(home) {
    const P = this.project;
    const bar = h("header.top",
      h("a.logo", { href: "#" }, "ALIVE ", h("b", "COMICS")),
      home ? h("span.muted", "Planches de BD animées") : null);
    if (!home) {
      const name = h("input.pname", { value: P.name, title: "Nom de la planche" });
      name.addEventListener("change", () => { P.name = name.value; this.save(); });
      bar.append(name,
        h("button.icon", { title: "Annuler (Ctrl+Z)", on: { click: () => this.doUndo() } }, "↶"),
        h("button.icon", { title: "Rétablir (Ctrl+Y)", on: { click: () => this.doRedo() } }, "↷"));
    }
    this.workerChips = h("div.workers");
    bar.append(h("span.sp"), this.workerChips);
    if (!home) {
      bar.append(
        h("button.primary", { on: { click: () => this.renderDialog(null) } }, "Générer les cases"),
        h("button", { on: { click: () => this.preview() } }, "Aperçu"),
        h("button", { title: "Ouvrir le dossier de la page (index.html, vidéos, sons)", on: { click: () => this.revealFolder() } }, "📁 Dossier"),
        h("button", { on: { click: () => this.publishDialog() } }, "Publier"));
    }
    bar.append(h("button.icon", { title: "Réglages", on: { click: () => this.settingsDialog() } }, "⚙"));
    this.paintWorkers();
    return bar;
  }

  // ---------------------------------------------------------------- colonne gauche : decoupage
  renderLeft() {
    const P = this.project;
    const f = { w: P.page.width, h: P.page.height };
    const grid = h("div.preset-grid.small", PRESETS.map(p =>
      h("button.preset", { title: p.label, on: { click: () => this.applyPreset(p.make) } }, presetThumb(p, f), h("span", p.label))));
    const count = h("input", { type: "range", min: 2, max: 9, value: 5 });
    const tilt = h("input", { type: "range", min: 0, max: 12, value: 5 });
    const rnd = h("button", { on: { click: () => {
      this.applyPreset((L) => randomLayout(Math.random() * 1e9 | 0, +count.value, tilt.value / 100, () => L().id));
    } } }, "🎲 Variante au hasard");
    const sel = this.selected;
    this.left.textContent = "";
    this.left.append(
      h("h3", "Découpage"), grid,
      h("div.form", h("label.field", h("span.lab", "Cases (hasard)"), count), h("label.field", h("span.lab", "Inclinaison"), tilt), rnd,
        h("button", { title: "Les bandes deviennent des colonnes et inversement", on: { click: () => {
          const before = this.snapshot(); P.layout = transpose(P.layout); this.pushUndo(before);
          this.editor.render(); this.save(); this.pageSoon();
        } } }, "↻ Pivoter le découpage")),
      h("h3", "Case sélectionnée"),
      sel ? h("div.form",
        h("button", { on: { click: () => this.splitSelected("h") } }, "Couper en deux ━"),
        h("button", { on: { click: () => this.splitSelected("v") } }, "Couper en deux ┃"),
        h("button.danger", { on: { click: () => this.deleteSelected() } }, "Supprimer la case"))
        : h("p.muted", "Clique une case. Glisse un trait pour le déplacer, ses bouts pour l'incliner (Maj : trait droit)."));
  }

  applyPreset(make) {
    const P = this.project;
    const before = this.snapshot();
    const order = compute(P.page, P.layout).panels.map(g => g.id);
    const layout = make(() => ({ t: "leaf", id: "p" + (P.nextId++) }));
    const fresh = compute(P.page, layout).panels.map(g => g.id);
    const panels = {};
    fresh.forEach((id, i) => {        // les images suivent l'ordre de lecture
      const old = order[i] ? P.panels[order[i]] : null;
      panels[id] = old ? Object.assign({}, old, { startSig: null }) : NEW_PANEL();
    });
    P.layout = layout; P.panels = panels;
    this.selected = null;
    this.pushUndo(before);
    this.editor.render(); this.renderLeft(); this.refreshInspector();
    this.save(); this.pageSoon();
  }

  splitSelected(dir) {
    const P = this.project, id = this.selected;
    const before = this.snapshot();
    const nid = "p" + (P.nextId++);
    P.layout = splitLeaf(P.layout, id, dir, nid);
    P.panels[nid] = NEW_PANEL();
    if (P.panels[id]) P.panels[id].startSig = null;
    this.pushUndo(before);
    this.editor.render(); this.renderLeft(); this.save(); this.pageSoon();
  }

  deleteSelected() {
    const P = this.project, id = this.selected;
    if (leaves(P.layout).length < 2) return toast("Il faut garder au moins une case.");
    const before = this.snapshot();
    P.layout = removeLeaf(P.layout, id);
    delete P.panels[id];
    this.selected = null;
    this.pushUndo(before);
    this.editor.render(); this.renderLeft(); this.refreshInspector(); this.save(); this.pageSoon();
    toast("Case supprimée (Ctrl+Z pour annuler).");
  }

  // ---------------------------------------------------------------- inspecteur
  select(id) {
    this.selected = id;
    this.editor.render();
    this.renderLeft();
    this.refreshInspector();
  }

  panel(id) { return this.project.panels[id] = this.project.panels[id] || NEW_PANEL(); }

  refreshInspector() {
    if (!this.right) return;
    const id = this.selected;
    this.right.textContent = "";
    if (!id) {
      this.right.append(h("h3", "Page"), pageForm(this),
        h("p.muted", "Astuce : glisse une image directement sur une case. Chaque case a ses icônes caméra, action et son."));
      return;
    }
    const g = this.editor.geom.panels.find(x => x.id === id);
    const panel = this.panel(id);
    const imgBox = h("div.form");
    if (panel.image) {
      const z = h("input", { type: "range", min: 100, max: 600, value: Math.round((panel.view?.zoom || 1) * 100) });
      z.addEventListener("input", () => { panel.view = Object.assign({}, panel.view, { zoom: z.value / 100 }); this.editor.render(); this.commitSoon("image"); });
      imgBox.append(h("div.row",
        h("button", { on: { click: () => this.pickImage(id) } }, icon("image"), " Remplacer"),
        h("button", { on: { click: () => { panel.view = { zoom: 1, ox: 0, oy: 0 }; this.editor.render(); this.commit("image"); this.refreshInspector(); } } }, "Recentrer"),
        h("button.danger", { on: { click: () => { delete panel.image; panel.startSig = null; this.editor.render(); this.commit("image"); this.refreshInspector(); } } }, "Retirer")),
        h("label.field", h("span.lab", "Zoom (molette sur la case, glisser pour recadrer)"), z));
    } else {
      imgBox.append(h("button.primary", { on: { click: () => this.pickImage(id) } }, icon("image"), " Importer une image"));
    }
    this.right.append(
      h("h3", `Case ${g ? g.order : ""}`),
      section("Image", "image", imgBox),
      section("Caméra", "camera", cameraForm(this, id)),
      section("Action", "action", actionForm(this, id)),
      section("Sons", "audio", audioForm(this, id)),
      section("Rendus", null, renderSection(this, id)));
  }

  label(kind, id) {
    const list = kind === "camera" ? this.presets.cameras : this.presets.actions;
    return (list.find(x => x.id === id) || list[0]).label;
  }

  audioLabel(panel) {
    const a = panel.audio || {}, v = panel.voice || {}, parts = [];
    if (a.mode === "file") parts.push(a.name || "fichier");
    if (a.mode === "generate") parts.push((this.presets.audio.find(x => x.id === a.preset) || this.presets.audio[0]).label);
    if (v.mode && v.mode !== "none") parts.push(v.mode === "tts" ? "voix off" : v.mode === "music" ? "2e musique" : (v.name || "2e son"));
    if (panel.foley?.on) parts.push("bruitages");
    return parts.join(" + ") || "aucun";
  }

  hasSound(panel) {
    return (panel.audio?.mode && panel.audio.mode !== "none") || (panel.voice?.mode && panel.voice.mode !== "none") || !!panel.foley?.on;
  }

  panelStatus(id) {
    const js = this.jobs.filter(j => this.project && j.project === this.project.id && j.panel === id);
    if (js.some(j => j.status === "running")) return { kind: "running", text: "calcul en cours" };
    if (js.some(j => j.status === "queued")) return { kind: "queued", text: "en attente" };
    const last = js.filter(j => j.kind === "video").sort((a, b) => b.created - a.created)[0];
    if (last?.status === "error") return { kind: "error", text: "erreur : " + last.error };
    const p = this.project.panels[id] || {};
    if ((p.renders || []).length) return { kind: "done", text: "rendu prêt" };
    return null;
  }

  // menu d'une icone dans la case
  panelMenu(id, kind, anchor) {
    document.querySelectorAll(".popover").forEach(p => p.remove());
    const r = anchor.getBoundingClientRect();            // avant select() : il redessine les icones
    if (this.selected !== id) this.select(id);
    if (kind === "image") return this.pickImage(id);
    const form = kind === "camera" ? cameraForm(this, id, true) : kind === "action" ? actionForm(this, id, true) : audioForm(this, id);
    const pop = h("div.popover", h("div.pop-head", icon(kind), h("b", { camera: "Prompt caméra", action: "Prompt action", audio: "Sons de la case" }[kind]),
                                   h("button.icon", { on: { click: () => pop.remove() } }, "✕")), form);
    document.body.append(pop);
    pop.style.left = Math.min(window.innerWidth - 340, Math.max(8, r.left)) + "px";
    pop.style.top = Math.min(window.innerHeight - 80, r.bottom + 6) + "px";
    const close = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener("pointerdown", close, true); } };
    setTimeout(() => document.addEventListener("pointerdown", close, true));
  }

  // ---------------------------------------------------------------- import
  pickImage(id) { pickFile("image/*", (f) => this.importImage(id, f)); }
  pickAudio(id, layer = "audio") { pickFile("audio/*", (f) => this.importAudio(id, f, layer)); }

  async importImage(id, file) {
    try {
      const res = await upload(`projects/${this.project.id}/upload?kind=image&name=${encodeURIComponent(file.name)}`, file);
      const im = await loadImage(res.url);
      const before = this.snapshot();
      const panel = this.panel(id);
      panel.image = { file: res.file, url: res.url, w: im.naturalWidth, h: im.naturalHeight, name: file.name };
      panel.view = { zoom: 1, ox: 0, oy: 0 };
      panel.startSig = null;
      this.pushUndo(before);
      this.select(id);
      this.save(); this.pageSoon();
    } catch (e) { toast(e.message, "error"); }
  }

  async importAudio(id, file, layer = "audio") {
    try {
      const res = await upload(`projects/${this.project.id}/upload?kind=${layer}&panel=${id}&name=${encodeURIComponent(file.name)}`, file);
      const panel = this.panel(id);
      Object.assign(panel[layer] = panel[layer] || {}, { mode: "file", file: res.file, name: file.name });
      this.refreshInspector(); this.editor.renderOverlay(); this.save();
      toast("Son importé dans la case.", "ok");
    } catch (e) { toast(e.message, "error"); }
  }

  async translateField(obj, key, redraw, purpose = "video") {
    if (!obj[key]) return;
    try { obj[key] = (await post("llm/translate", { text: obj[key], purpose })).text; this.commitSoon("panel"); redraw(); }
    catch (e) { toast(e.message, "error"); }
  }

  // ---------------------------------------------------------------- historique et enregistrement
  snapshot() {
    const P = this.project;
    return JSON.stringify({ page: P.page, layout: P.layout, panels: P.panels, style: P.style, nextId: P.nextId });
  }
  pushUndo(snap) { this.undo.push(snap); if (this.undo.length > 80) this.undo.shift(); this.redo = []; }
  restore(snap) {
    Object.assign(this.project, JSON.parse(snap));
    if (this.selected && !this.project.panels[this.selected]) this.selected = null;
    this.editor.render(); this.renderLeft(); this.refreshInspector(); this.save(); this.pageSoon();
  }
  doUndo() { if (this.undo.length) { this.redo.push(this.snapshot()); this.restore(this.undo.pop()); } }
  doRedo() { if (this.redo.length) { this.undo.push(this.snapshot()); this.restore(this.redo.pop()); } }

  commit(kind) {
    if (this._last && this._lastKind === kind && Date.now() - this._lastT < 1200) { /* meme geste : une seule etape */ }
    else if (this._last) this.pushUndo(this._last);
    this._last = this.snapshot(); this._lastKind = kind; this._lastT = Date.now();
    this.editor?.renderOverlay();
    this.save();
    if (kind !== "panel") this.pageSoon();
  }

  geometryForSave() {
    const g = compute(this.project.page, this.project.layout);
    return { size: [this.project.page.width, this.project.page.height],
             panels: g.panels.map(p => ({ id: p.id, order: p.order, rect: [p.bbox.x0, p.bbox.y0, p.bbox.x1, p.bbox.y1].map(v => Math.round(v * 10) / 10),
                                          poly: p.poly.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) })) };
  }

  async save(first) {
    if (!this.project) return;
    this.project.geometry = this.geometryForSave();
    if (!this._last) this._last = this.snapshot();
    const sig = this.snapshot();
    try {
      const saved = await put("projects/" + this.project.id, this.project);
      this._savedSig = sig;
      this.absorb(saved);
      if (first && !saved.thumb) this.pageSoon();
    } catch (e) {
      // serveur arrete ou en redemarrage : on retente seul, sans perdre ce qui est en memoire
      if (!this._retrySave) toast("Serveur injoignable : l'enregistrement sera retenté automatiquement.", "error", 6000);
      clearTimeout(this._retrySave);
      this._retrySave = setTimeout(() => { this._retrySave = null; this.save(); }, 3000);
      return;
    }
    if (this._retrySave) { clearTimeout(this._retrySave); this._retrySave = null; }
  }

  // reprend ce que le serveur a ecrit (rendus, choix, sons) sans toucher aux reglages en cours
  absorb(server) {
    for (const [id, sp] of Object.entries(server.panels || {})) {
      const lp = this.project.panels[id];
      if (!lp) continue;
      lp.renders = sp.renders || []; lp.chosen = sp.chosen || {};
      for (const layer of ["audio", "voice", "foley"]) {
        if (!sp[layer]) continue;
        lp[layer] = lp[layer] || {};
        lp[layer].generated = sp[layer].generated || [];
        if (sp[layer].file) lp[layer].file = sp[layer].file;
      }
    }
    this.project.published = server.published;
    if (server.pageSound) {
      const ps = this.project.pageSound = this.project.pageSound || {};
      if ((server.pageSound.rev || 0) > (ps.rev || 0)) Object.assign(ps, server.pageSound);   // serveur plus recent
      ps.generated = server.pageSound.generated || [];
    }
  }

  async uploadPage(strict) {
    if (!this.project) return;
    const sig = this.pageSig();
    try { await pageImages(this.project, this.editor.geom); this._pageSig = sig; }
    catch (e) { if (strict) throw e; console.warn(e); }
  }

  async ensureStart(id) {
    const geo = compute(this.project.page, this.project.layout).panels.find(p => p.id === id);
    const res = await startImage(this.project, geo);
    if (res?.changed) await this.save();
    return res;
  }

  // ---------------------------------------------------------------- rendus
  async renderDialog(ids) {
    const P = this.project;
    await this.save();
    const geo = compute(P.page, P.layout).panels;
    const withImg = geo.filter(g => P.panels[g.id]?.image);
    if (!withImg.length) return toast("Importe d'abord des images dans les cases.");
    const chosen = new Set(ids || withImg.map(g => g.id));
    const list = h("div.checks", withImg.map(g => {
      const cb = h("input", { type: "checkbox", checked: chosen.has(g.id) });
      cb.addEventListener("change", () => { cb.checked ? chosen.add(g.id) : chosen.delete(g.id); refresh(); });
      const p = P.panels[g.id];
      return h("label.check", cb, ` Case ${g.order} : ${this.label("camera", p.camera?.id)} · ${this.label("action", p.action?.id)}`);
    }));
    let target = this.info.fal ? "local" : "local";
    const est = h("p.estimate", "…");
    const machines = new Set(this.workers.filter(w => w.enabled && w.pf?.video).map(w => w.name));
    const wl = h("div.checks", this.workers.map(w => {
      const cb = h("input", { type: "checkbox", checked: machines.has(w.name), disabled: !w.pf?.video });
      cb.addEventListener("change", () => { cb.checked ? machines.add(w.name) : machines.delete(w.name); });
      return h("label.check", cb, ` ${w.name} `, h("small.muted", w.pf?.video ? `prêt · ${w.pf.gpu || ""} · file ${w.pf.load || 0}` : (w.pf?.missing || []).join(", ")));
    }));
    const tgt = h("div.seg", [["local", "Mes machines (ComfyUI)"], ["fal", "Cloud fal"], ["auto", "Mixte"]].map(([k, l]) => {
      const b = h("button" + (k === target ? ".on" : ""), { on: { click: () => { target = k; tgt.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); refresh(); } } }, l);
      if (k !== "local" && !this.info.fal) { b.disabled = true; b.title = "Ajouter une clé fal dans Réglages"; }
      return b;
    }));
    const refresh = async () => {
      try {
        const e = await post(`projects/${P.id}/estimate`, { panels: [...chosen] });
        est.textContent = `${e.videos} vidéo(s), ${e.seconds_local} s de vidéo.` +
          (target !== "local" ? ` Sur fal : ${e.seconds_fal} s facturées ≈ ${e.fal_cost} $ (à ${e.price_per_second} $/s, estimation).` : "") +
          (target === "local" ? " Chaque demi-arc prend ~4 à 5 min par machine." : "") +
          (target === "auto" ? " Les tâches non prises par tes machines après 2 min partent sur fal." : "");
      } catch (err) { est.textContent = err.message; }
    };
    refresh();
    const falNote = h("p.note");
    const paints = () => {
      const ids = [...chosen];
      const tts = ids.filter(id => P.panels[id].voice?.mode === "tts" && !P.panels[id].voice.file).length;
      const fol = ids.filter(id => P.panels[id].foley?.on && (P.panels[id].foley.engine || "h3") !== "h3").length;
      falNote.textContent = (tts || fol) ? `À noter : ${tts ? tts + " voix off" : ""}${tts && fol ? " et " : ""}${fol ? fol + " bruitages cloud" : ""} passeront par fal (payant), même en mode « Mes machines ».` : "";
    };
    paints();
    list.addEventListener("change", paints);
    modal("Générer les vidéos", h("div.form", h("span.lab", "Cases"), list, h("span.lab", "Où calculer ?"), tgt,
                                  h("span.lab", "Machines"), wl, est, falNote), [
      { label: "Annuler" },
      { label: "Lancer", primary: true, click: async () => {
        if (!chosen.size) return false;
        toast("Préparation des images de départ…");
        try {
          for (const id of chosen) await this.ensureStart(id);
          await this.save();
          const res = await post(`projects/${P.id}/render`, { panels: [...chosen], target, machines: target === "fal" ? null : [...machines],
                                                              seeds: Object.fromEntries([...chosen].map(id => [id, P.panels[id].seed]).filter(([, s]) => s)) });
          for (const e of res.errors) toast(e, "error", 8000);
          toast(`${res.jobs.length} rendu(s) en file.`, "ok");
          this.drawerOpen = true; this.pollJobs();
        } catch (e) { toast(e.message, "error", 8000); }
      } }]);
  }

  pickPageSound() {
    pickFile("audio/*", async (file) => {
      try {
        const res = await upload(`projects/${this.project.id}/upload?kind=page&name=${encodeURIComponent(file.name)}`, file);
        Object.assign(this.project.pageSound = this.project.pageSound || {}, { mode: "file", file: res.file, name: file.name, rev: Date.now() / 1000 });
        this.refreshInspector(); this.save();
        toast("Son global importé.", "ok");
      } catch (e) { toast(e.message, "error"); }
    });
  }

  async generatePageSound() {
    await this.save();
    try {
      await post(`projects/${this.project.id}/pagesound`, { seed: Math.floor(Math.random() * 1e8) });
      toast("Son global en file (MiniMax Music, sur tes machines).", "ok"); this.drawerOpen = true; this.pollJobs();
    } catch (e) { toast(e.message, "error", 8000); }
  }

  async generateLayer(id, layer) {
    await this.save();
    try {
      if (layer === "foley" && !Object.keys(this.panel(id).chosen || {}).length) throw new Error("rends d'abord la vidéo de la case");
      await post(`projects/${this.project.id}/${layer}/${id}`, { seed: Math.floor(Math.random() * 1e8) });
      toast({ audio: "Son en file (2 à 6 min, sur tes machines).", voice: "Voix en file.", foley: "Bruitages en file (fal)." }[layer], "ok");
      this.drawerOpen = true; this.pollJobs();
    } catch (e) { toast(e.message, "error", 8000); }
  }

  async choose(id, side, file) {
    const saved = await post(`projects/${this.project.id}/choose`, { panel: id, side, file });
    this.absorb(saved);
    this.refreshInspector();
  }

  async cancelJob(jid) { await post(`jobs/${jid}/cancel`); this.pollJobs(); }

  async pollJobs() {
    if (!this.project) return;
    try {
      const jobs = await get("jobs?project=" + this.project.id);
      const finished = jobs.some(j => j.status === "done" && !this.jobs.find(o => o.id === j.id && o.status === "done"));
      this.jobs = jobs;
      if (finished) { this.absorb(await get("projects/" + this.project.id)); this.refreshInspector(); }
      this.editor?.renderOverlay();
      this.renderDrawer();
    } catch (e) { /* serveur en redemarrage */ }
  }

  async pollWorkers() {
    try { this.workers = await get("workers"); this.paintWorkers(); } catch (e) { /* */ }
  }

  paintWorkers() {
    if (!this.workerChips) return;
    this.workerChips.textContent = "";
    for (const w of this.workers) {
      const pf = w.pf || {};
      const kind = !w.enabled ? "off" : !pf.online ? "down" : !pf.video ? "warn" : (w.job || pf.load) ? "busy" : "ok";
      const tip = !w.enabled ? "désactivée" : !pf.online ? "injoignable" : !pf.video ? "manque : " + (pf.missing || []).join(", ")
        : `${pf.gpu || ""} · ComfyUI ${pf.version} · file ${pf.load || 0}${pf.music ? " · Music 3" : ""}`;
      this.workerChips.append(h("span.chip." + kind, { title: `${w.name} : ${tip}` }, h("i"), w.name));
    }
    if (this.info?.fal) this.workerChips.append(h("span.chip.ok", { title: "fal.ai : clé présente" }, h("i"), "fal"));
  }

  renderDrawer() {
    if (!this.drawer) return;
    const active = this.jobs.filter(j => ["queued", "running"].includes(j.status));
    const recent = this.jobs.filter(j => !["queued", "running"].includes(j.status)).sort((a, b) => (b.finished || 0) - (a.finished || 0)).slice(0, 12);
    const order = Object.fromEntries((this.editor?.geom?.panels || []).map(g => [g.id, g.order]));
    const row = (j) => h("tr." + j.status, h("td", j.panel === "_page" ? "Page" : `Case ${order[j.panel] || j.panel}`), h("td", sideName(j.side)),
      h("td", statusText(j)), h("td.muted", j.error ? j.error.slice(0, 140) : (j.finished && j.started ? Math.round(j.finished - j.started) + " s" : "")),
      h("td", ["queued", "running"].includes(j.status) ? h("button.mini", { on: { click: () => this.cancelJob(j.id) } }, "Annuler") : null));
    this.drawer.textContent = "";
    this.drawer.classList.toggle("open", !!this.drawerOpen);
    this.drawer.append(
      h("button.drawer-tab", { on: { click: () => { this.drawerOpen = !this.drawerOpen; this.renderDrawer(); } } },
        `Rendus : ${active.length} en cours`, this.drawerOpen ? " ▾" : " ▴"));
    if (this.drawerOpen) {
      this.drawer.append(h("div.drawer-body", h("table.jobs", active.map(row), recent.map(row)),
        h("button.mini", { on: { click: async () => { await post("jobs/clear", { project: this.project.id }); this.pollJobs(); } } }, "Effacer les terminés")));
    }
  }

  // ---------------------------------------------------------------- apercu et publication
  // ce qui fait l'image de la page : format, decoupage, images et leur cadrage
  pageSig() {
    const P = this.project;
    return JSON.stringify({ page: P.page, layout: P.layout,
                            imgs: Object.fromEntries(Object.entries(P.panels).map(([k, v]) => [k, [v.image?.file, v.view]])) });
  }

  async flushAll() {
    if (this.snapshot() !== this._savedSig) await this.save();          // enregistrer seulement si quelque chose a change
    if (this.pageSig() !== this._pageSig) await this.uploadPage(true);  // image de page renvoyee seulement si elle a change
  }

  async preview() {
    // l'onglet s'ouvre AU CLIC : ouvert apres l'assemblage (plusieurs secondes), le navigateur le bloquerait
    const tab = openPending("Assemblage de la page…");
    try {
      await this.flushAll();
      const res = await post(`projects/${this.project.id}/export`);
      for (const r of res.report.filter(x => x.includes("manquant"))) toast(r, "info", 7000);
      showIn(tab, res.url + "?t=" + Date.now());
    } catch (e) { if (tab) tab.close(); toast(e.message, "error", 9000); }
  }

  async revealFolder() {
    try { await this.flushAll(); await post(`projects/${this.project.id}/reveal`); }
    catch (e) { toast(e.message, "error"); }
  }

  publishDialog() {
    const P = this.project;
    const name = h("input", { value: P.published?.name || slugify(P.name) });
    modal("Publier la planche", h("div.form",
      h("label.field", h("span.lab", "Adresse"), h("div.row", h("span.muted", (this.settings.deploy?.url || "") + "/"), name, h("span.muted", "/"))),
      h("p.muted", "La page est publique pour qui a le lien, non indexée par les moteurs de recherche. Les vidéos manquantes restent des images fixes."),
      P.published ? h("p", "Déjà publiée : ", h("a", { href: P.published.url, target: "_blank" }, P.published.url)) : null), [
      { label: "Annuler" },
      { label: "Publier", primary: true, click: async () => {
        toast("Publication en cours (envoi des vidéos)…", "info", 8000);
        try {
          await this.flushAll();
          const res = await post(`projects/${P.id}/publish`, { name: name.value });
          P.published = { name: name.value, url: res.url };
          this.publishedDialog(res.url);
        } catch (e) { toast(e.message, "error", 10000); }
      } }]);
  }

  publishedDialog(url) {
    modal("C'est en ligne", h("div.form", h("p", h("a", { href: url, target: "_blank" }, url)),
      h("button", { on: { click: () => { navigator.clipboard?.writeText(url); toast("Lien copié.", "ok"); } } }, "Copier le lien")), [{ label: "Fermer", primary: true }]);
  }

  // ---------------------------------------------------------------- reglages
  async settingsDialog() {
    const S = await get("settings");
    const tabs = {
      "Machines": () => {
        const rows = h("div.wlist");
        const draw = () => {
          rows.textContent = "";
          S.workers.forEach((w, i) => {
            const n = h("input", { value: w.name, placeholder: "Nom" }), u = h("input", { value: w.url, placeholder: "http://192.168.1.x:8188" });
            const en = h("input", { type: "checkbox", checked: w.enabled !== false });
            n.addEventListener("input", () => { w.name = n.value; }); u.addEventListener("input", () => { w.url = u.value; });
            en.addEventListener("change", () => { w.enabled = en.checked; });
            rows.append(h("div.row", en, n, u, h("button.mini", { on: { click: () => { S.workers.splice(i, 1); draw(); } } }, "✕")));
          });
          rows.append(h("button", { on: { click: () => { S.workers.push({ name: "PC", url: "http://", enabled: true }); draw(); } } }, "+ Ajouter une machine"));
        };
        draw();
        return h("div.form", h("p.muted", "Chaque machine : ComfyUI ≥ 0.33 avec MiniMax H3, le nœud comfyui-h3-orbital et le LoRA 360 Orbit (et MiniMax Music 3 pour le son)."), rows);
      },
      "Intelligence": () => {
        const prov = h("select", ["anthropic", "openai", "google", "deepseek"].map(p => h("option", { value: p }, { anthropic: "Anthropic (Claude)", openai: "OpenAI", google: "Google (Gemini)", deepseek: "DeepSeek (texte seulement)" }[p])));
        prov.value = S.llm.provider; prov.addEventListener("change", () => { S.llm.provider = prov.value; });
        const block = (p, label) => {
          const k = h("input", { type: "password", value: S.llm[p].key, placeholder: "clé API" });
          const m = h("select.model", h("option", { value: S.llm[p].model }, S.llm[p].model));
          k.addEventListener("input", () => { S.llm[p].key = k.value; }); m.addEventListener("change", () => { S.llm[p].model = m.value; });
          const load = async () => {
            try {
              const models = await get("llm/models?provider=" + p);
              const cur = S.llm[p].model;
              m.replaceChildren(...models.map(x => h("option", { value: x.id }, x.label === x.id ? x.id : `${x.label} (${x.id})`)));
              if (!models.some(x => x.id === cur)) m.prepend(h("option", { value: cur }, cur));
              m.value = cur;
            } catch (e) { /* pas de cle ou fournisseur injoignable : on garde le modele enregistre */ }
          };
          if (S.llm[p].key) load();
          return h("div.row", h("b.w8", label), k, m, h("button.mini", { title: "Recharger la liste des modèles", on: { click: async () => {
            await put("settings", { llm: S.llm }); await load(); } } }, "↻"), h("button.mini", { on: { click: async () => {
            try { await put("settings", { llm: S.llm }); const r = await post("llm/test", { provider: p }); toast(label + " : " + r.text, "ok"); }
            catch (e) { toast(label + " : " + e.message, "error", 8000); }
          } } }, "Tester"));
        };
        return h("div.form", h("label.field", h("span.lab", "Fournisseur utilisé"), prov),
          block("anthropic", "Anthropic"), block("openai", "OpenAI"), block("google", "Google"), block("deepseek", "DeepSeek"),
          h("p.muted", "Les clés restent sur ce poste (local_settings.json), jamais dans le dépôt."));
      },
      "fal": () => {
        const k = h("input", { type: "password", value: S.fal.key, placeholder: "FAL_KEY" });
        k.addEventListener("input", () => { S.fal.key = k.value; });
        const c = h("input", { type: "number", min: 1, max: 16, value: S.fal.concurrency });
        c.addEventListener("input", () => { S.fal.concurrency = +c.value; });
        const r = h("select", ["480P", "768P", "2K"].map(x => h("option", { value: x }, x))); r.value = S.fal.resolution;
        r.addEventListener("change", () => { S.fal.resolution = r.value; });
        const pr = h("input", { type: "number", step: 0.01, value: S.fal.price_per_second });
        pr.addEventListener("input", () => { S.fal.price_per_second = +pr.value; });
        return h("div.form", h("label.field", h("span.lab", "Clé fal"), k), h("label.field", h("span.lab", "Rendus simultanés"), c),
          h("label.field", h("span.lab", "Résolution"), r), h("label.field", h("span.lab", "Prix estimé ($ par seconde de vidéo)"), pr),
          h("button", { on: { click: async () => {
            await put("settings", { fal: S.fal }); const t = await post("fal/test");
            toast(t.ok ? "Clé fal acceptée." : t.message, t.ok ? "ok" : "error");
          } } }, "Tester la clé"),
          h("p.muted", "Sur fal : MiniMax H3 + LoRA 360 Orbit, durée 5 s minimum, sans fiche perso ni vues de décor."));
      },
      "Publication": () => {
        const D = S.deploy;
        const inp = (k, ph) => { const e = h("input", { value: D[k] ?? "", placeholder: ph }); e.addEventListener("input", () => { D[k] = k === "port" ? +e.value : e.value; }); return e; };
        const keyBox = h("pre.key", "…");
        return h("div.form",
          h("label.field", h("span.lab", "Adresse du site"), inp("url", "https://alive-comics.placenta.tv")),
          h("div.row", h("label.field", h("span.lab", "Hôte SSH"), inp("host", "46.202.158.181")), h("label.field", h("span.lab", "Port"), inp("port", "65002")),
            h("label.field", h("span.lab", "Utilisateur"), inp("user", "u335969729"))),
          h("label.field", h("span.lab", "Dossier du site sur le serveur"), inp("root", "domains/alive-comics.placenta.tv/public_html")),
          h("span.lab", "Clé de ce poste (à coller dans hPanel › Avancé › Accès SSH › Ajouter une clé SSH)"), keyBox,
          h("div.row",
            h("button", { on: { click: async () => { keyBox.textContent = (await get("publish/key")).public_key; } } }, "Créer / afficher la clé de ce poste"),
            h("button", { on: { click: () => { navigator.clipboard?.writeText(keyBox.textContent); toast("Clé copiée.", "ok"); } } }, "Copier"),
            h("button", { on: { click: async () => {
              try { await put("settings", { deploy: D }); const t = await post("publish/test"); toast(t.ok ? "Connexion OK." : "Dossier introuvable sur le serveur.", t.ok ? "ok" : "error"); }
              catch (e) { toast(e.message, "error", 9000); }
            } } }, "Tester la connexion")));
      },
      "Rendu": () => {
        const R = S.render;
        const n = (k, label, step) => { const e = h("input", { type: "number", step: step || 1, value: R[k] }); e.addEventListener("input", () => { R[k] = +e.value; }); return h("label.field", h("span.lab", label), e); };
        return h("div.form", n("seed", "Graine par défaut"), n("steps", "Étapes (28 recommandé)"),
          h("p.muted", "Taille de génération : ~0,8 Mpx au format de chaque case, côté long ≤ 1344 px (limite H3)."));
      },
    };
    const body = h("div.tabs");
    const head = h("div.seg");
    const show = (name) => { head.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.textContent === name)); body.replaceChildren(tabs[name]()); };
    Object.keys(tabs).forEach(k => head.append(h("button", { on: { click: () => show(k) } }, k)));
    show("Machines");
    modal("Réglages", h("div", head, body), [
      { label: "Annuler" },
      { label: "Enregistrer", primary: true, click: async () => {
        this.settings = await put("settings", S); this.info = await get("info"); this.pollWorkers(); toast("Réglages enregistrés.", "ok");
      } }]);
  }

  keys(e) {
    if (!this.project || e.target.closest("input, textarea, select")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.doRedo() : this.doUndo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); this.doRedo(); }
    else if (e.key === "Delete" && this.selected) this.deleteSelected();
    else if (e.key === "Escape") { document.querySelectorAll(".popover").forEach(p => p.remove()); this.select(null); }
  }
}

function section(title, ico, body) {
  return h("section.insp", h("h4", ico ? icon(ico) : null, " ", title), body);
}

function pickFile(accept, cb) {
  const inp = h("input", { type: "file", accept, style: { display: "none" } });
  inp.addEventListener("change", () => { if (inp.files[0]) cb(inp.files[0]); inp.remove(); });
  document.body.append(inp);
  inp.click();
}

// onglet ouvert tout de suite (geste de l'utilisateur), rempli quand la page est prete
function openPending(message) {
  const tab = window.open("", "_blank");
  if (tab) {
    tab.document.write(`<!doctype html><meta charset="utf-8"><title>Alive Comics</title>
      <body style="margin:0;background:#141414;color:#ece8e1;font:16px system-ui;display:grid;place-items:center;height:100vh">
      <p>${message}</p></body>`);
    tab.document.close();
  }
  return tab;
}

function showIn(tab, url) {
  if (tab && !tab.closed) { tab.location.href = url; return; }
  // onglet bloque ou ferme : un lien a cliquer
  const a = h("a", { href: url, target: "_blank" }, "Ouvrir l'aperçu");
  toast(h("span", "La page est prête : ", a), "ok", 15000);
}

function slugify(t) {
  return (t || "planche").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "planche";
}

function presetThumb(p, f) {
  let n = 0;
  const layout = p.make(() => ({ t: "leaf", id: "t" + (++n) }));
  const W = f.w || f.width, H = f.h || f.height;
  const geo = compute({ width: W, height: H, margin: W * 0.04, gutter: W * 0.018 }, layout);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.classList.add("thumb");
  for (const g of geo.panels) {
    const poly = document.createElementNS(NS, "polygon");
    poly.setAttribute("points", g.poly.map(q => q.join(",")).join(" "));
    svg.append(poly);
  }
  return svg;
}

const app = new App();
window.__alive = app;          // debogage depuis la console
app.init();
