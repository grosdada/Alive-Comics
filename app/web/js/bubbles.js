// Editeur de bulles d'une case : on place les bulles sur la case, on glisse la bulle et sa queue, on regle quelques options.
// Double-clic sur une bulle : panneau « Forme de la bulle » (geometrie). Suppr efface la bulle choisie.
// Le dessin et l'apparition sont ceux du lecteur (player/alive-bubbles.js, window.AliveBubbles).
import { h, modal, get, put, toast } from "./api.js";

const uid = () => Math.random().toString(36).slice(2, 8);
const TAIL = { oval: true, thought: true, shout: true, whisper: true, box: false };
const LABEL = { oval: "Parole", thought: "Pensée", shout: "Cri", whisper: "Chuchote", box: "Narration" };
const DEFAULT_TEXT = { oval: "Bonjour !", thought: "Hmm…", shout: "ATTENTION !", whisper: "chut…", box: "Le lendemain…" };
const DEFAULT_MW = { box: 62, shout: 36 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const KEEP = ["type", "size", "color", "fill", "ink", "font", "tw", "show", "anim"];      // ce qu'un preset garde (jamais le texte ni la position)

let loading = null;
function loadLib() {                                   // le dessin des bulles est dans le lecteur : chargement a la demande
  if (window.AliveBubbles) return Promise.resolve();
  if (!loading) loading = new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = "/player/alive-bubbles.js"; s.onload = ok; s.onerror = () => ko(new Error("alive-bubbles.js introuvable"));
    document.head.append(s);
  });
  return loading;
}

export async function openBubbleEditor(app, caseId) {
  await loadLib();
  const AB = window.AliveBubbles, P = app.project, panel = P.panels[caseId];
  const list = panel.bubbles = Array.isArray(panel.bubbles) ? panel.bubbles : [];
  const g = app.editor.geom.panels.find((x) => x.id === caseId);
  const ratio = g ? g.bbox.w / g.bbox.h : 1.5;
  let sel = list[0]?.id || null;
  let presets = [];
  const save = () => { app.commit("panel"); app.editor?.renderOverlay(); };
  const current = () => list.find((x) => x.id === sel);

  // ---- scene : la case (image de depart) au milieu d'une marge ou les bulles peuvent deborder
  const caseEl = h("div.bub-case", { style: { aspectRatio: String(ratio) } });
  const img = h("img", { src: `/projects/${P.id}/start/${caseId}.png?t=${Date.now()}`, alt: "" });
  img.onerror = () => { if (panel.image?.url) img.src = panel.image.url; else img.remove(); };
  caseEl.append(img);
  const stage = h("div.bub-stage", caseEl);
  let ctl = AB.mount(caseEl, list, { edit: true });
  const rebuild = () => { ctl.setList(list); ctl.select(sel); };

  // ---- glisser une bulle ou sa queue ; double-clic = forme
  let drag = null;
  const pt = (e) => { const r = caseEl.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  stage.addEventListener("pointerdown", (e) => {
    const tip = e.target.closest(".ac-btip"), bub = e.target.closest(".ac-bub");
    const id = (tip || bub)?.dataset.id;
    if (!id) return;
    const b = list.find((x) => x.id === id);
    if (!b) return;
    sel = id; ctl.select(id); syncPanel();
    const [px, py] = pt(e);
    drag = { b, tip: !!tip, px, py, x: b.x, y: b.y, tx: b.tx, ty: b.ty };
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [px, py] = pt(e), dx = px - drag.px, dy = py - drag.py, b = drag.b;
    if (drag.tip) { b.tx = clamp(drag.tx + dx, -0.3, 1.3); b.ty = clamp(drag.ty + dy, -0.3, 1.3); }
    else {
      b.x = clamp(drag.x + dx, -0.2, 1.2); b.y = clamp(drag.y + dy, -0.2, 1.2);
      if (drag.tx != null) { b.tx = clamp(drag.tx + (b.x - drag.x), -0.3, 1.3); b.ty = clamp(drag.ty + (b.y - drag.y), -0.3, 1.3); }
    }
    ctl.layout();
  });
  const end = () => { if (drag) { drag = null; save(); } };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("pointerdown", (e) => { if (!e.target.closest(".ac-bub, .ac-btip") && sel) { sel = null; ctl.select(null); syncPanel(); } });
  stage.addEventListener("dblclick", (e) => {
    const id = e.target.closest(".ac-bub")?.dataset.id;
    if (!id) return;
    sel = id; ctl.select(id); syncPanel(); openGeo();
  });

  // ---- suppression au clavier
  const removeSel = () => {
    const b = current();
    if (!b) return;
    list.splice(list.indexOf(b), 1); sel = list[0]?.id || null; rebuild(); syncPanel(); save();
  };
  const onKey = (e) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (!current()) return;
    e.preventDefault(); removeSel();
  };
  document.addEventListener("keydown", onKey);

  // ---- panneau de reglages
  const side = h("div.bub-side");
  const addBar = h("div.bub-add", h("span.muted", "Ajouter :"),
    ...Object.keys(LABEL).map((t) => h("button.mini", { title: "Ajouter une bulle « " + LABEL[t] + " »", on: { click: () => add(t) } }, LABEL[t])));
  function place(b) {
    const n = list.length;
    b.x = clamp(0.5 + (n % 3 - 1) * 0.16, 0.12, 0.88); b.y = clamp(0.28 + n * 0.12, 0.12, 0.88);
    if (b.tail) { b.tx = clamp(b.x + 0.08, 0, 1); b.ty = clamp(b.y + 0.22, 0, 1.1); }
    delete b.tail;
    list.push(b); sel = b.id; rebuild(); syncPanel(); save();
  }
  function add(type) {
    place({ id: uid(), type, text: DEFAULT_TEXT[type], size: "M", color: "white", font: "bd", show: "always", at: 0, anim: "pop", tail: TAIL[type] });
  }
  function fromPreset(p) {
    const b = { id: uid(), text: DEFAULT_TEXT[p.type] || "Texte", at: 0, tail: p.tail };
    for (const k of KEEP) if (p[k] != null) b[k] = p[k];
    if (p.geo) b.geo = { ...p.geo };
    place(b);
  }
  function applyPreset(p, b) {
    for (const k of KEEP) delete b[k];
    delete b.geo;
    for (const k of KEEP) if (p[k] != null) b[k] = p[k];
    if (p.geo) b.geo = { ...p.geo };
    if (p.tail && b.tx == null) { b.tx = clamp(b.x + 0.08, -0.3, 1.3); b.ty = clamp(b.y + 0.22, -0.3, 1.3); }
    if (!p.tail) { delete b.tx; delete b.ty; }
    ctl.layout(); syncPanel(); save();
  }
  const savePresets = async () => {
    try { presets = await put("/bubblepresets", presets); } catch (err) { toast("Presets non enregistrés : " + err.message, "error"); }
    syncPanel();
  };
  function makePreset(name, b) {
    const p = { id: uid(), name, tail: b.tx != null };
    for (const k of KEEP) if (b[k] != null) p[k] = b[k];
    if (b.geo) p.geo = { ...b.geo };
    presets.push(p); savePresets();
  }

  const seg = (items, cur, set) => {
    const box = h("div.seg", items.map(([k, label]) => {
      const bt = h("button" + (k === cur ? ".on" : ""), { on: { click: () => { set(k); box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === bt)); } } }, label);
      return bt;
    }));
    return box;
  };

  function presetBlock(b) {
    const box = h("div.bub-presets");
    box.append(h("div.row", h("span.lab", "Mes presets"),
      ...(presets.length ? [] : [h("span.muted", "aucun pour l'instant")])));
    if (presets.length) box.append(h("div.bub-chips", presets.map((p) => h("span.chip", { title: "Ajouter une bulle « " + p.name + " »" },
      h("button.mini", { on: { click: () => fromPreset(p) } }, "★ " + p.name),
      b ? h("button.mini", { title: "Appliquer à la bulle choisie", on: { click: () => applyPreset(p, b) } }, "↪") : null,
      h("button.mini", { title: "Supprimer ce preset", on: { click: () => { presets = presets.filter((x) => x.id !== p.id); savePresets(); } } }, "✕")))));
    if (b) {
      const name = h("input", { type: "text", placeholder: "nom du preset", maxlength: 40, style: { flex: 1, minWidth: "90px" } });
      const go = () => { const n = name.value.trim(); if (n) makePreset(n, b); else name.focus(); };
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      box.append(h("div.row", name, h("button.mini", { title: "Garde le type, la forme, les couleurs, la typo, la queue et l'animation (pas le texte)", on: { click: go } }, "Enregistrer cette bulle")));
    }
    return box;
  }

  function syncPanel() {
    side.textContent = "";
    side.append(addBar);
    const b = current();
    side.append(presetBlock(b));
    side.append(h("div.bub-list", list.map((x, i) => h("button.mini" + (x.id === sel ? ".on" : ""), { title: x.text, on: { click: () => { sel = x.id; ctl.select(sel); syncPanel(); } } },
      `${i + 1} · ${(x.text || "…").slice(0, 14)}`))));
    if (geoEl) renderGeo();
    if (!b) { side.append(h("p.muted", list.length ? "Clique une bulle pour la régler (double-clic : sa forme)." : "Aucune bulle : ajoute-en une ci-dessus, puis glisse-la sur la case.")); return; }
    const change = (fn) => { fn(b); ctl.layout(); save(); };
    const ta = h("textarea", { rows: 3, value: b.text || "" });
    ta.addEventListener("input", () => { b.text = ta.value; ctl.layout(); });
    ta.addEventListener("change", save);
    side.append(h("label.field", h("span.lab", "Texte"), ta));
    side.append(h("div.row", h("span.lab", "Taille"), seg([["S", "S"], ["M", "M"], ["L", "L"]], b.size || "M", (v) => change(() => { b.size = v; }))));
    side.append(h("div.row", h("span.lab", "Typo"),
      (() => { const s = h("select", Object.entries(AB.FONTS).map(([k, f]) => h("option", { value: k, style: { fontFamily: f[1] } }, f[0]))); s.value = b.font || "bd";
               s.addEventListener("change", () => change(() => { b.font = s.value; })); return s; })()));
    const sw = h("div.bub-sw", Object.entries(AB.COLORS).map(([k, c]) => h("button.sw" + (!b.fill && !b.ink && (b.color || "white") === k ? ".on" : ""), {
      title: AB.COLOR_NAMES[k], style: { background: c[0], color: c[2] },
      on: { click: () => change(() => { b.color = k; delete b.fill; delete b.ink; }) || syncPanel() } }, "A")));
    side.append(h("div.row", h("span.lab", "Couleur"), sw));
    const fillIn = h("input", { type: "color", value: b.fill || AB.COLORS[b.color || "white"][0], title: "Fond" });
    const inkIn = h("input", { type: "color", value: b.ink || AB.COLORS[b.color || "white"][2], title: "Texte et trait" });
    fillIn.addEventListener("input", () => change(() => { b.fill = fillIn.value; }));
    inkIn.addEventListener("input", () => change(() => { b.ink = inkIn.value; }));
    side.append(h("div.row", h("span.lab", "Fond / texte"), fillIn, inkIn));
    side.append(h("div.row", h("span.lab", "Apparition"),
      seg([["always", "Toujours"], ["hover", "Au survol"], ["time", "À …"]], b.show || "always", (v) => { change(() => { b.show = v; }); syncPanel(); })));
    if (b.show === "time") {
      const at = h("input", { type: "number", min: 0, max: 60, step: 0.1, value: b.at || 0, style: { width: "70px" } });
      at.addEventListener("change", () => change(() => { b.at = clamp(parseFloat(at.value) || 0, 0, 60); }));
      side.append(h("div.row", h("span.lab", "À la seconde"), at, h("span.muted", "de la lecture de la case")));
    }
    const an = h("select", Object.entries(AB.ANIMS).map(([k, l]) => h("option", { value: k }, l)));
    an.value = b.anim || "pop";
    an.addEventListener("change", () => { change(() => { b.anim = an.value; }); ctl.replay(b.id); });
    side.append(h("div.row", h("span.lab", "Animation"), an,
      h("button.mini", { title: "Rejouer l'apparition", on: { click: () => { ctl.update({ hover: false, t: -1 }); ctl.replay(b.id); } } }, "▶")));
    const hasTail = b.tx != null;
    const tail = h("input", { type: "checkbox" }); tail.checked = hasTail;
    tail.addEventListener("change", () => { change(() => { if (tail.checked) { b.tx = clamp(b.x + 0.08, -0.3, 1.3); b.ty = clamp(b.y + 0.22, -0.3, 1.3); } else { delete b.tx; delete b.ty; } }); syncPanel(); });
    side.append(h("div.row", h("label", tail, " Queue (glisse le losange violet)")));
    if (hasTail) {
      const tw = h("input", { type: "range", min: 0.3, max: 2.5, step: 0.05, value: b.tw || 1, style: { flex: 1 } });
      tw.addEventListener("input", () => { b.tw = parseFloat(tw.value); ctl.layout(); });
      tw.addEventListener("change", save);
      side.append(h("div.row", h("span.lab", "Largeur de la queue"), tw));
    }
    side.append(h("div.row", h("button.mini", { title: "Forme de la bulle (ou double-clic sur la bulle)", on: { click: openGeo } }, "Forme…"),
      h("span.sp"), h("button.mini.danger", { title: "Suppr", on: { click: removeSel } }, "Supprimer")));
  }

  // ---- panneau flottant « Forme de la bulle » : la case reste visible derriere
  let geoEl = null;
  function slider(b, label, key, min, max, step, def, fmt) {
    const g = () => b.geo || {};
    const val = h("span.val", "");
    const inp = h("input", { type: "range", min, max, step, value: g()[key] ?? def, style: { flex: 1 } });
    const show = () => { val.textContent = fmt ? fmt(parseFloat(inp.value)) : inp.value; };
    show();
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      b.geo = b.geo || {};
      if (Math.abs(v - def) < step / 2) delete b.geo[key]; else b.geo[key] = v;
      if (!Object.keys(b.geo).length) delete b.geo;
      show(); ctl.layout();
    });
    inp.addEventListener("change", save);
    return h("div.row", h("span.lab", label), inp, val);
  }
  function renderGeo() {
    const b = current();
    if (!b) { closeGeo(); return; }
    const body = geoEl.querySelector(".geo-body");
    body.textContent = "";
    const t = b.type, pct = (v) => Math.round(v * 100) + " %";
    body.append(h("div.row", h("span.lab", "Forme"), seg(Object.entries(LABEL), t, (v) => {
      b.type = v;
      if (!TAIL[v] && b.tx != null) { delete b.tx; delete b.ty; }
      ctl.layout(); save(); syncPanel();
    })));
    body.append(slider(b, "Marge autour du texte", "pad", 0.7, 1.8, 0.05, 1, pct));
    body.append(slider(b, "Largeur du texte", "mw", 14, 80, 1, DEFAULT_MW[t] || 32, (v) => v + " %"));
    if (t === "oval" || t === "whisper") body.append(slider(b, "Main levée", "wob", 0, 1, 0.05, 0, pct));
    if (t === "box") body.append(slider(b, "Coins arrondis", "round", 0, 0.5, 0.01, 0.16, pct));
    if (t === "shout") {
      body.append(slider(b, "Pointes", "n", 5, 30, 1, 13));
      body.append(slider(b, "Longueur des pointes", "len", 0.05, 0.7, 0.01, 0.32, pct));
      body.append(slider(b, "Irrégularité", "irr", 0, 1, 0.05, 0.35, pct));
    }
    if (t === "thought") body.append(slider(b, "Bosses", "bumps", 6, 20, 1, 11));
    body.append(slider(b, "Épaisseur du trait", "line", 0.4, 4, 0.1, 1, (v) => "× " + v.toFixed(1)));
    body.append(h("div.row", h("span.lab", "Trait"), seg([["solid", "Plein"], ["dashed", "Tirets"], ["dotted", "Points"], ["double", "Double"]],
      b.geo?.ls || (t === "whisper" ? "dashed" : "solid"), (v) => {
        b.geo = b.geo || {};
        if (v === "solid") b.geo.ls = undefined; else b.geo.ls = v;
        if (v === "solid") { delete b.geo.ls; if (t === "whisper") b.geo.ls = "solid"; }       // chuchote : plein = on neutralise les tirets par defaut
        ctl.layout(); save();
      })));
    if (b.tx != null) {
      body.append(slider(b, "Courbure de la queue", "curve", -1, 1, 0.05, 0, (v) => (v > 0 ? "→ " : v < 0 ? "← " : "") + Math.abs(Math.round(v * 100)) + " %"));
      body.append(h("div.row", h("span.lab", "Largeur de la queue"), (() => {
        const tw = h("input", { type: "range", min: 0.3, max: 2.5, step: 0.05, value: b.tw || 1, style: { flex: 1 } });
        tw.addEventListener("input", () => { b.tw = parseFloat(tw.value); ctl.layout(); });
        tw.addEventListener("change", save);
        return tw;
      })()));
    }
    body.append(h("div.row", h("span.sp"), h("button.mini", { on: { click: () => { delete b.geo; ctl.layout(); save(); renderGeo(); } } }, "Réinitialiser la forme")));
  }
  function openGeo() {
    if (!current()) return;
    if (!geoEl) {
      geoEl = h("div.bub-geo", h("header", h("b", "Forme de la bulle"), h("button.icon", { title: "Fermer", on: { click: closeGeo } }, "✕")), h("div.geo-body"));
      document.body.append(geoEl);
    }
    renderGeo();
  }
  function closeGeo() { geoEl?.remove(); geoEl = null; }

  get("/bubblepresets").then((p) => { presets = Array.isArray(p) ? p : []; syncPanel(); }).catch(() => {});
  syncPanel();
  ctl.select(sel);

  const body = h("div.bub-edit", stage, side);
  const m = modal("Bulles de la case " + (g ? g.order : caseId), body, [{ label: "Fermer", primary: true }]);
  m.box.classList.add("bub-modal");
  const cleanup = new MutationObserver(() => {
    if (!document.body.contains(m.box)) { ctl.destroy(); closeGeo(); document.removeEventListener("keydown", onKey); cleanup.disconnect(); }
  });
  cleanup.observe(document.body, { childList: true });
}
