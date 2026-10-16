// Alive-Comics : application (etat, projets, edition, rendus, export, publication, reglages, livres).
import { api, get, post, put, upload, uploadSound, h, toast, debounce, modal, loadImage } from "./api.js";
import { compute, PRESETS, PAGE_DEFAULTS, FORMATS, pageSize, transpose, randomLayout, removeLeaf, splitLeaf, leaves, clone } from "./geometry.js";
import { Editor, icon } from "./editor.js";
import { startImage, pageImages } from "./exporter.js";
import { cameraForm, actionForm, audioForm, renderSection, pageForm, statusText, sideName, treatmentForm } from "./forms.js";

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
    const [projects, books, jobs, fdata] = await Promise.all([get("projects"), get("books"), get("jobs?active=1").catch(() => []),
                                                    get("folders").catch(() => ({ folders: [], assign: {} }))]);
    const folders = fdata.folders, assign = fdata.assign;            // projets de rangement : une planche dans un seul projet
    const saveFolders = () => put("folders", { folders, assign });
    let cur = pref("ac-folder", "all");                               // all | none | <id d'un projet>
    if (cur !== "all" && cur !== "none" && !folders.some(f => f.id === cur)) cur = "all";
    const selected = new Set();                                       // planches cochees (ctrl / cmd + clic) pour un deplacement groupe
    this.homeJobs = jobs.filter(j => j.status === "running" || j.status === "queued");
    this.root.textContent = "";
    this.root.append(this.topbar(true));
    let view = pref("ac-home-view", "grid"), sort = pref("ac-home-sort", "updated"), q = "";
    const inBooks = (pid) => books.filter(b => b.pages.includes(pid)).map(b => b.title);
    const CMP = {
      updated: (a, b) => b.updated - a.updated,
      created: (a, b) => (b.created || 0) - (a.created || 0),
      created_asc: (a, b) => (a.created || 0) - (b.created || 0),
      alpha: (a, b) => a.name.localeCompare(b.name, "fr", { numeric: true, sensitivity: "base" }),
      best: (a, b) => (score(b.review) ?? 0) - (score(a.review) ?? 0) || b.updated - a.updated,
      worst: (a, b) => (score(a.review) ?? 9) - (score(b.review) ?? 9) || b.updated - a.updated,
    };
    const holder = h("div");
    const draw = () => {
      const inCur = (p) => cur === "all" || (cur === "none" ? !assign[p.id] : assign[p.id] === cur);
      const pool = projects.filter(inCur);
      const list = pool.filter(p => !q || p.name.toLowerCase().includes(q)).sort(CMP[sort] || CMP.updated);
      holder.textContent = "";
      holder.append(view === "list" ? this.projectList(list, inBooks) : this.projectGrid(list));
      count.textContent = q ? `${list.length} / ${pool.length}` : String(pool.length);
      this.paintCalc();
      this.dragSetup(holder, selected, async (pids, fid) => {       // glisse-depose : vers un projet, ou « sans projet »
        for (const pid of pids) { if (fid) assign[pid] = fid; else delete assign[pid]; }
        selected.clear(); await saveFolders(); drawBar(); draw();
        const n = pids.length, s = n > 1 ? "s" : "";
        toast(fid ? `${n} planche${s} rangée${s} dans « ${folders.find(f => f.id === fid).name} »` : `${n} planche${s} sortie${s} de leur projet`);
      });
    };
    const count = h("span.muted");
    // barre des projets : Toutes / Sans projet / un bouton par projet (cible de glisse-depose) / + Nouveau projet
    const bar = h("div.fbar");
    const nOf = (k) => k === "all" ? projects.length : k === "none" ? projects.filter(p => !assign[p.id]).length
                                                     : projects.filter(p => assign[p.id] === k).length;
    const drawBar = () => {
      bar.textContent = "";
      const chip = (key, label, color, fid) => {
        const b = h("button.fchip" + (cur === key ? ".on" : ""), { "data-folder": fid === undefined ? null : fid,
          title: fid ? "Clic : afficher · double-clic : renommer / supprimer · glisse des planches dessus pour les ranger"
                     : key === "none" ? "Glisse des planches ici pour les sortir de leur projet" : "",
          on: { click: () => { cur = key; setPref("ac-folder", key); drawBar(); draw(); },
                dblclick: fid ? () => this.folderMenu(fid, folders, assign, saveFolders, () => { drawBar(); draw(); }) : null } },
          color ? h("i.fdot", { style: "background:" + color }) : null, h("span", label), h("small", String(nOf(key))));
        return b;
      };
      bar.append(chip("all", "Toutes", null), chip("none", "Sans projet", null, ""));
      for (const f of folders) bar.append(chip(f.id, f.name, f.color, f.id));
      if (folders.some(f => f.id === cur)) bar.append(h("button.fchip.fedit", { title: "Renommer, changer la couleur ou supprimer ce projet",
        on: { click: () => this.folderMenu(cur, folders, assign, saveFolders, () => { drawBar(); draw(); }) } }, "✎ Modifier ce projet"));
      bar.append(h("button.fchip.fnew", { on: { click: () => this.folderMenu(null, folders, assign, saveFolders, () => { drawBar(); draw(); },
        (id) => { cur = id; setPref("ac-folder", id); }) } }, "+ Nouveau projet"));
    };
    const search = h("input.search", { type: "search", placeholder: "Rechercher une planche…" });
    search.addEventListener("input", () => { q = search.value.trim().toLowerCase(); draw(); });
    const sortSel = h("select", { title: "Ordre des planches" },
      [["updated", "Modifiées récemment"], ["created", "Créées récemment"], ["created_asc", "Plus anciennes d'abord"],
       ["alpha", "Ordre alphabétique"], ["best", "Mieux notées"], ["worst", "À retoucher d'abord"]].map(([v, l]) => h("option", { value: v }, l)));
    sortSel.value = sort;
    sortSel.addEventListener("change", () => { sort = sortSel.value; setPref("ac-home-sort", sort); draw(); });
    const seg = h("div.seg", [["grid", "Vignettes"], ["list", "Liste"]].map(([k, l]) => {
      const b = h("button" + (k === view ? ".on" : ""), { on: { click: () => {
        view = k; setPref("ac-home-view", k);
        seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); draw();
      } } }, l);
      return b;
    }));
    // livres : replies (titre seulement) ou deplies (pages, ajout, apercu, publication)
    const open = new Set(JSON.parse(pref("ac-books-open", "[]")));
    this.bookOpen = (id, on) => { if (on) open.add(id); else open.delete(id); setPref("ac-books-open", JSON.stringify([...open])); };
    const bookList = h("div.books", books.length ? books.map(b => this.bookRow(b, books, projects, open.has(b.id)))
                                                 : h("p.muted", "Aucun livre pour l'instant."));
    const allBooks = (on) => { for (const b of books) this.bookOpen(b.id, on); this.home(); };
    // onglets Planches | Livres : on passe de l'un a l'autre sans faire defiler la page ; l'onglet est retenu
    const newPlanche = h("button.primary", { on: { click: () => this.newProjectDialog(cur !== "all" && cur !== "none" ? cur : null) } }, "+ Nouvelle planche");
    const newBook = h("button.primary", { on: { click: async () => {
      const id = Math.random().toString(36).slice(2, 8);
      books.push({ id, title: "Nouveau livre", pages: [] });
      this.bookOpen(id, true);
      setPref("ac-tab", "livres");
      await put("books", books); this.home();
    } } }, "+ Nouveau livre");
    const bookTools = [h("button.mini", { on: { click: () => allBooks(true) } }, "Tout déplier"),
                       h("button.mini", { on: { click: () => allBooks(false) } }, "Tout replier")];
    drawBar();
    let tab = pref("ac-tab", "planches");
    const planchesPane = h("div", h("div.home-tools", count, h("span.sp"), search, sortSel, seg, newPlanche), bar, holder);
    const livresPane = h("div", h("div.home-tools", h("span.sp"), ...bookTools, newBook), bookList);
    const tabsEl = h("div.tabs");
    const syncTabs = () => {
      tabsEl.textContent = "";
      for (const [k, label, n] of [["planches", "Planches", h("small", String(projects.length))], ["livres", "Livres", h("small", String(books.length))]]) {
        const t = h("button.tab" + (tab === k ? ".on" : ""), { on: { click: () => { tab = k; setPref("ac-tab", k); syncTabs(); } } }, label, " ", n);
        tabsEl.append(t);
      }
      planchesPane.hidden = tab !== "planches"; livresPane.hidden = tab !== "livres";
    };
    syncTabs();
    this.root.append(h("main.home", tabsEl, planchesPane, livresPane));
    draw();
  }

  projectGrid(list) {
    return h("div.cards",
      list.map(p => h("a.card", { href: "#p=" + p.id, "data-pid": p.id },
        h("div.thumb", p.thumb ? h("img", { src: p.thumb + "?t=" + Math.round(p.updated), loading: "lazy" })
                               : h("div.noimg", { style: ratio(p) }), h("span.calc")),
        h("div", h("b", p.name), stars(p.review), h("small", `${p.panels} cases · ${fmtDate(p.updated)}`)))));
  }

  projectList(list, inBooks) {
    return h("div.plist",
      h("div.prow.head", h("span"), h("span", "Planche"), h("span", "Note"), h("span", "Cases"), h("span", "Créée"), h("span", "Modifiée"),
        h("span", "Livres")),
      list.map(p => h("a.prow", { href: "#p=" + p.id, "data-pid": p.id },
        h("span.lthumb", p.thumb ? h("img", { src: p.thumb + "?t=" + Math.round(p.updated), loading: "lazy" }) : h("i")),
        h("span.lname", h("b", p.name), h("span.calc")),
        stars(p.review),
        h("span", String(p.panels)),
        h("span.muted", p.created ? fmtDate(p.created) : "—"),
        h("span.muted", fmtDate(p.updated)),
        h("span.muted.lbooks", inBooks(p.id).join(", ") || "—"))),
      list.length ? null : h("p.muted", "Aucune planche."));
  }

  // pastilles « en calcul » (clignote) / « en file » sur les planches et les livres de l'accueil
  paintCalc() {
    if (!this.root) return;
    const by = {};
    for (const j of this.homeJobs || []) {
      const o = by[j.project] = by[j.project] || { run: 0, wait: 0 };
      if (j.status === "running") o.run++; else o.wait++;
    }
    const paint = (badge, c) => {
      if (!badge) return;
      if (!c || (!c.run && !c.wait)) { badge.className = "calc"; badge.textContent = ""; badge.title = ""; return; }
      badge.className = "calc " + (c.run ? "run" : "wait");
      badge.textContent = c.run ? `● calcul${c.wait ? ` · ${c.wait} en file` : ""}` : `${c.wait} en file`;
      badge.title = `${c.run} rendu(s) en cours, ${c.wait} en file d'attente`;
    };
    for (const el of this.root.querySelectorAll("[data-pid]")) paint(el.querySelector(".calc"), by[el.dataset.pid]);
    for (const el of this.root.querySelectorAll("[data-book]")) {
      const c = { run: 0, wait: 0 };
      for (const pid of (el.dataset.pages || "").split(",")) if (by[pid]) { c.run += by[pid].run; c.wait += by[pid].wait; }
      paint(el.querySelector(".bhead .calc"), c);
    }
  }

  bookRow(b, books, projects, open) {
    const save = async () => { await put("books", books); };
    let el = null;
    const redraw = (o = open) => { const n = this.bookRow(b, books, projects, o); el.replaceWith(n); this.paintCalc(); };
    const toggle = () => { this.bookOpen(b.id, !open); redraw(!open); };
    const n = b.pages.length;
    const head = h("div.bhead",
      h("button.icon.chev", { title: open ? "Replier" : "Déplier", on: { click: toggle } }, open ? "▾" : "▸"));
    if (open) {
      const title = h("input.btitle", { value: b.title });
      title.addEventListener("change", () => { b.title = title.value; save(); });
      head.append(title);
    } else {
      head.append(h("b.btitle-ro", { on: { click: toggle } }, b.title));
    }
    const tot = { ok: 0, todo: 0, redo: 0 };
    for (const pid of b.pages) { const r = projects.find(x => x.id === pid)?.review; if (r) for (const k in tot) tot[k] += r[k] || 0; }
    head.append(h("span.muted", `${n} page${n > 1 ? "s" : ""}`), n ? stars(tot) : h("span"), h("span.calc"));
    el = h("div.book" + (open ? ".open" : ""), { "data-book": b.id, "data-pages": b.pages.join(",") }, head);
    if (!open) return el;
    // les pages du livre, en vignettes numerotees (ordre de lecture) ; clic = ouvrir / apercu / edition
    const move = (i, d) => { [b.pages[i + d], b.pages[i]] = [b.pages[i], b.pages[i + d]]; save().then(() => redraw()); };
    const pages = h("div.bpages", n ? b.pages.map((pid, i) => {
      const p = projects.find(x => x.id === pid);
      return h("div.bpage", { "data-pid": pid },
        h("span.bnum", String(i + 1)),
        h("button.bthumb", { title: "Ouvrir la planche, aperçu, édition…", on: { click: (e) => this.pageMenu(e.currentTarget, b, i, pid) } },
          p?.thumb ? h("img", { src: p.thumb + "?t=" + Math.round(p.updated), loading: "lazy" }) : h("div.noimg", { style: ratio(p) }),
          h("span.calc")),
        h("small", { title: p ? p.name : pid }, p ? p.name : pid + " (supprimée)"),
        p ? stars(p.review) : null,
        h("div.row",
          h("button.mini", { title: "Avancer d'une place", disabled: i === 0, on: { click: () => move(i, -1) } }, "◀"),
          h("button.mini", { title: "Reculer d'une place", disabled: i === n - 1, on: { click: () => move(i, 1) } }, "▶"),
          h("button.mini", { title: "Retirer du livre", on: { click: () => { b.pages.splice(i, 1); save().then(() => redraw()); } } }, "✕")));
    }) : h("p.muted", "Aucune page : ajoute des planches ci-dessous."));
    const add = h("select", projects.slice().sort((x, y) => x.name.localeCompare(y.name, "fr", { numeric: true }))
                                    .map(p => h("option", { value: p.id }, p.name)));
    const addBtn = h("button", { on: { click: async () => {
      if (!add.value) return;
      b.pages.push(add.value); await save();
      toast(`« ${add.selectedOptions[0].textContent} » ajoutée : le livre a ${b.pages.length} page${b.pages.length > 1 ? "s" : ""}.`, "ok");
      redraw();
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
    el.append(pages, h("div.row", add, addBtn),
      h("div.row",
        h("button", { on: { click: () => act("export") } }, "Aperçu"),
        h("button.primary", { on: { click: () => act("publish") } }, "Publier le livre"),
        h("button.mini", { on: { click: async () => {
          if (!confirm("Supprimer ce livre (les planches restent) ?")) return;
          books.splice(books.indexOf(b), 1); await save(); el.remove();
        } } }, "Supprimer le livre")));
    return el;
  }

  // clic sur une page d'un livre : l'ouvrir dans l'application, son apercu, ou l'apercu en mode edition
  pageMenu(anchor, b, i, pid) {
    document.querySelector(".popmenu")?.remove();
    const go = async (what) => {
      menu.remove();
      if (what === "open") { location.hash = "#p=" + pid; return; }
      const tab = openPending(what.startsWith("book") ? "Assemblage du livre…" : "Assemblage de la page…");
      try {
        if (what.startsWith("book")) {
          const res = await post(`books/${b.id}/export`);
          showIn(tab, res.url + (what === "book-edit" ? "?edit=1" : "") + "#" + (i + 1));
        } else {
          const res = await post(`projects/${pid}/export`);
          showIn(tab, res.url + "?t=" + Date.now() + (what === "edit" ? "&edit=1" : ""));
        }
      } catch (e) { if (tab) tab.close(); toast(e.message, "error", 9000); }
    };
    const menu = h("div.popmenu",
      h("button", { on: { click: () => go("open") } }, "✎ Ouvrir la planche"),
      h("button", { on: { click: () => go("preview") } }, "▶ Aperçu de la page"),
      h("button", { on: { click: () => go("edit") } }, "✏️ Éditer la page (aperçu)"),
      h("button", { on: { click: () => go("book") } }, `📖 Voir dans le livre (page ${i + 1})`),
      h("button", { on: { click: () => go("book-edit") } }, "✏️ Éditer dans le livre"));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.left)) + "px";
    menu.style.top = Math.min(innerHeight - menu.offsetHeight - 8, r.bottom + 4) + "px";
    const away = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("pointerdown", away, true); } };
    setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  }

  newProjectDialog(folderId) {
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
        if (folderId) {                                              // planche creee depuis un projet : rangee dedans
          const fd = await get("folders").catch(() => ({ folders: [], assign: {} }));
          fd.assign[p.id] = folderId; await put("folders", fd);
        }
        location.hash = "#p=" + p.id;
      } }]);
  }

  // dialogue d'un projet : creer (fid null) / renommer / couleur / supprimer (les planches restent, « sans projet »)
  folderMenu(fid, folders, assign, save, redraw, onCreated) {
    const f = fid ? folders.find(x => x.id === fid) : { id: Math.random().toString(36).slice(2, 8), name: "", color: "#f2b45c" };
    const name = h("input", { value: f.name, placeholder: "Nom du projet (ex. Mariage Provence)" });
    const color = h("input", { type: "color", value: f.color });
    modal(fid ? "Projet" : "Nouveau projet", h("div.form", h("label.field", h("span.lab", "Nom"), name), h("label.field", h("span.lab", "Couleur"), color)), [
      { label: "Annuler" },
      fid ? { label: "Supprimer le projet", click: async () => {
        if (!confirm(`Supprimer le projet « ${f.name} » ? Les planches ne sont pas supprimées : elles passent « sans projet ».`)) return false;
        folders.splice(folders.indexOf(f), 1);
        for (const k of Object.keys(assign)) if (assign[k] === fid) delete assign[k];
        await save(); this.home();
      } } : null,
      { label: fid ? "Enregistrer" : "Créer", primary: true, click: async () => {
        f.name = name.value.trim() || "Projet"; f.color = color.value;
        if (!fid) { folders.push(f); onCreated?.(f.id); }
        await save(); redraw();
      } }].filter(Boolean));
    setTimeout(() => name.focus(), 50);
  }

  // glisse-depose des planches (cartes ou lignes de liste) vers les boutons de projet ; ctrl / cmd + clic = selection multiple
  dragSetup(holder, selected, onDrop) {
    for (const el of holder.querySelectorAll("[data-pid]")) {
      el.draggable = true;
      el.classList.toggle("sel", selected.has(el.dataset.pid));
      el.addEventListener("click", (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const pid = el.dataset.pid;
        if (selected.has(pid)) selected.delete(pid); else selected.add(pid);
        el.classList.toggle("sel", selected.has(pid));
      });
      el.addEventListener("dragstart", (e) => {
        const pid = el.dataset.pid;
        e.dataTransfer.setData("text/ac-planches", JSON.stringify(selected.has(pid) ? [...selected] : [pid]));
        e.dataTransfer.effectAllowed = "move";
        el.classList.add("dragging");
        document.body.classList.add("dragging-planche");
      });
      el.addEventListener("dragend", () => { el.classList.remove("dragging"); document.body.classList.remove("dragging-planche"); });
    }
    for (const chip of this.root.querySelectorAll(".fchip[data-folder]")) {
      chip.ondragover = (e) => { if ([...e.dataTransfer.types].includes("text/ac-planches")) { e.preventDefault(); chip.classList.add("over"); } };
      chip.ondragleave = () => chip.classList.remove("over");
      chip.ondrop = (e) => {
        e.preventDefault(); chip.classList.remove("over");
        const pids = JSON.parse(e.dataTransfer.getData("text/ac-planches") || "[]");
        if (pids.length) onDrop(pids, chip.dataset.folder || null);
      };
    }
  }

  // ================================================================ espace de travail
  async open(pid) {
    try { this.project = await get("projects/" + pid); this._rev = this.project.rev; this._savedSig = null; }
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
    this.director = h("div.director");
    this.root.append(this.director);
    this.renderDirector();
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
    const relief = panel.treatment === "relief";        // relief : ni camera, ni action, ni rendu video
    this.right.append(...[
      h("h3", `Case ${g ? g.order : ""}`),
      section("Image", "image", imgBox),
      section("Traitement", null, treatmentForm(this, id)),
      relief ? null : section("Caméra", "camera", cameraForm(this, id)),
      relief ? null : section("Action", "action", actionForm(this, id)),
      section("Sons", "audio", audioForm(this, id)),
      relief ? null : section("Rendus", null, renderSection(this, id))].filter(Boolean));
  }

  label(kind, id) {
    const list = kind === "camera" ? this.presets.cameras : this.presets.actions;
    return (list.find(x => x.id === id) || list[0]).label;
  }

  audioLabel(panel) {
    const a = panel.audio || {}, v = panel.voice || {}, parts = [];
    if (a.mode === "file") parts.push(a.name || "fichier");
    if (a.mode === "generate") parts.push((this.presets.audio.find(x => x.id === a.preset) || this.presets.audio[0]).label);
    if (v.mode && v.mode !== "none") parts.push(v.mode === "tts" ? "voix IA" : v.mode === "music" ? "2e musique" : "voix off " + (v.name || ""));
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
      const res = await uploadSound(`projects/${this.project.id}/upload?kind=${layer}&panel=${id}&name=${encodeURIComponent(file.name)}`, file);
      const panel = this.panel(id);
      Object.assign(panel[layer] = panel[layer] || {}, { mode: "file", file: res.file, name: file.name });
      this.refreshInspector(); this.editor.renderOverlay(); this.save();
      toast(res.reused ? "Son déjà importé : le fichier existant est réutilisé." : "Son importé dans la case.", "ok");
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
      this._rev = saved.rev;
      const untouched = this.snapshot() === sig;          // rien modifie pendant l'envoi
      this.absorb(saved);
      this._savedSig = untouched ? this.snapshot() : sig;   // apres absorb : copie locale = copie du serveur
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

  // ---------------------------------------------------------------- realisateur IA
  renderDirector() {
    const P = this.project, el = this.director;
    if (!el) return;
    let open = false;
    try { open = localStorage.getItem("ac-director") === "1"; } catch (_) { /* */ }
    el.textContent = "";
    el.classList.toggle("open", open);
    const toggle = (v) => { try { localStorage.setItem("ac-director", v ? "1" : "0"); } catch (_) { /* */ } this.renderDirector(); };
    if (!open) {
      el.append(h("button.director-pill", { on: { click: () => toggle(true) } }, "🎬 Réalisateur IA"));
      return;
    }
    const dir = P.direction || {};
    const opts = Object.assign({ audio: true, pageSound: true, voice: false, foley: true, render: false, treatment: "h3", treats: 1 },
                               dir.options || {});
    const ta = h("textarea", { rows: 4, placeholder: "Ex. : une ambiance de film noir des années 70, la caméra tourne lentement autour des personnages, "
                                              + "sons inquiétants, une voix off raconte une enquête…" });
    ta.value = dir.instruction || "";
    const cb = (k, label) => {
      const c = h("input", { type: "checkbox" }); c.checked = !!opts[k];
      c.addEventListener("change", () => { opts[k] = c.checked; });
      return h("label.check", c, " " + label);
    };
    // traitement : video H3 partout, relief + quelques « biscuits » H3, ou l'IA choisit case par case
    const tr = h("select", {}, h("option", { value: "h3" }, "Vidéo H3 partout"),
                 h("option", { value: "relief" }, "Relief partout + biscuits H3"), h("option", { value: "mixed" }, "L'IA choisit case par case"));
    tr.value = opts.treatment || "h3";
    const nb = h("input", { type: "number", min: 0, max: 4, value: opts.treats ?? 1, style: { width: "56px" } });
    const nbBox = h("label.check", "biscuits par page ", nb);
    const syncTr = () => { opts.treatment = tr.value; nbBox.hidden = tr.value !== "relief"; };
    tr.addEventListener("change", syncTr);
    nb.addEventListener("change", () => { opts.treats = Math.max(0, Math.min(4, +nb.value | 0)); });
    syncTr();
    const go = h("button.primary", { on: { click: () => this.runDirector(ta.value, opts) } }, "✨ L'IA décide tout");
    el.append(
      h("div.pop-head", h("b", "🎬 Réalisateur IA"), h("button.icon", { title: "Réduire", on: { click: () => toggle(false) } }, "–")),
      h("p.muted", "Tes images restent. L'IA regarde toute la page et règle le reste : caméras, actions, textes, sons."),
      ta,
      h("div.checks2", cb("audio", "Ambiance par case (tes fichiers gardés)"),
        P.pageSound?.mode === "file" ? h("label.check.muted", "Son global : ton fichier est gardé") : cb("pageSound", "Son global de la page"),
        cb("foley", "Bruitages (H3)"),
        cb("voice", "Voix off qui raconte (fal)"), cb("render", "Lancer les rendus ensuite")),
      h("div.row", h("span.muted", "Traitement :"), tr, nbBox),
      h("p.muted", "Les plans animés suivent la compétence « boucles parfaites ». Les cases validées en vert ne sont pas touchées."),
      go,
      dir.summary ? h("p.ai-explain", dir.summary) : null);
  }

  async runDirector(instruction, opts) {
    const P = this.project;
    const geo = compute(P.page, P.layout).panels.filter(g => P.panels[g.id]?.image);
    if (!geo.length) return toast("Pose d'abord des images dans les cases.", "error");
    const veil = h("div.veil", h("div", h("b", "🎬 L'IA regarde les " + geo.length + " cases…"),
                                 h("p.muted", "Elle règle caméras, actions, textes et sons (30 s à 2 min).")));
    document.body.append(veil);
    try {
      for (const g of geo) await this.ensureStart(g.id);
      await this.flushAll();
      const res = await post(`projects/${P.id}/direct`, { instruction, options: opts });
      await this.open(P.id);                     // recharge la planche avec les decisions de l'IA
      this.selected = null; this.refreshInspector();
      toast(`L'IA a réglé ${res.panels.length} cases en ${res.seconds} s.` + (res.locked?.length ? ` Cases vertes gardées : ${res.locked.join(", ")}.` : "")
            + ` ${res.summary || ""}`, "ok", 12000);
      if (opts.render) {
        const ready = this.workers.filter(w => w.enabled && w.pf?.video).map(w => w.name);
        const r = await post(`projects/${P.id}/render`, { panels: res.panels, target: "local", machines: ready });
        for (const e of r.errors) toast(e, "error", 8000);
        toast(`${r.jobs.length} rendu(s) lancés sur tes machines.`, "ok");
        this.drawerOpen = true; this.pollJobs();
      }
    } catch (e) { toast("Réalisateur IA : " + e.message, "error", 10000); }
    finally { veil.remove(); }
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
        const res = await uploadSound(`projects/${this.project.id}/upload?kind=page&name=${encodeURIComponent(file.name)}`, file);
        Object.assign(this.project.pageSound = this.project.pageSound || {}, { mode: "file", file: res.file, name: file.name, rev: Date.now() / 1000 });
        this.refreshInspector(); this.save();
        toast(res.reused ? "Son global déjà importé : le fichier existant est réutilisé." : "Son global importé.", "ok");
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

  // planche modifiee par un autre (pilotage par API, autre onglet) : on recharge si rien n'est en cours ici
  async watchRev() {
    if (!this.project || this._reloading) return;
    try {
      const r = await get(`projects/${this.project.id}/rev`);
      if (this._rev == null) { this._rev = r.rev; return; }
      if (r.rev > this._rev && this.snapshot() === this._savedSig && !document.querySelector(".popover, .modal-back, .veil")) {
        this._reloading = true;
        const keep = this.selected;
        await this.open(this.project.id);
        if (keep && this.project.panels[keep]) this.select(keep);
        this._reloading = false;
      }
      this._rev = Math.max(this._rev, r.rev);
    } catch (e) { this._reloading = false; }
  }

  async pollJobs() {
    if (!this.project) {                       // accueil : pastilles « en calcul » toutes les 4 s
      if (!this.root?.querySelector("main.home") || (this._homeTick = (this._homeTick || 0) + 1) % 2) return;
      try {
        this.homeJobs = (await get("jobs?active=1")).filter(j => j.status === "running" || j.status === "queued");
        this.paintCalc();
      } catch (e) { /* serveur en redemarrage */ }
      return;
    }
    this.watchRev();
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
function pref(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
function setPref(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
function fmtDate(t) {
  return new Date(t * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
// note d'une planche d'apres ses pastilles : vert 1, orange 0,4, rouge 0 -> de 1 a 5 etoiles, par demi-etoile
// (toutes vertes = 5 ; jamais revue, tout orange = 2,5 ; beaucoup de rouges -> 1)
function score(r) {
  const n = r ? (r.ok || 0) + (r.todo || 0) + (r.redo || 0) : 0;
  if (!n) return null;
  return Math.round((1 + 4 * ((r.ok || 0) + 0.4 * (r.todo || 0)) / n) * 2) / 2;
}
function stars(r) {
  const sc = score(r);
  if (sc == null) return h("span.stars.none", "");
  const el = h("span.stars", { title: `${String(sc).replace(".", ",")} / 5 · ${r.ok || 0} OK, ${r.todo || 0} à voir, ${r.redo || 0} à retoucher` });
  for (let i = 1; i <= 5; i++) el.append(h("i" + (sc >= i ? ".full" : sc >= i - 0.5 ? ".half" : ""), "★"));
  return el;
}
function ratio(p) { return { aspectRatio: p && p.w && p.h ? `${p.w} / ${p.h}` : "16 / 9" }; }

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
