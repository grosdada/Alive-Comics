// Editeur de bulles d'une case : on place les bulles sur la case, on glisse la bulle et sa queue, on regle quelques options.
// Le dessin et l'apparition sont ceux du lecteur (player/alive-bubbles.js, window.AliveBubbles).
import { h, modal } from "./api.js";

const uid = () => Math.random().toString(36).slice(2, 8);
const TAIL = { oval: true, thought: true, shout: true, whisper: true, box: false };
const LABEL = { oval: "Parole", thought: "Pensée", shout: "Cri", whisper: "Chuchote", box: "Narration" };
const DEFAULT_TEXT = { oval: "Bonjour !", thought: "Hmm…", shout: "ATTENTION !", whisper: "chut…", box: "Le lendemain…" };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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
  const save = () => { app.commit("panel"); app.editor?.renderOverlay(); };

  // ---- scene : la case (image de depart) au milieu d'une marge ou les bulles peuvent deborder
  const caseEl = h("div.bub-case", { style: { aspectRatio: String(ratio) } });
  const img = h("img", { src: `/projects/${P.id}/start/${caseId}.png?t=${Date.now()}`, alt: "" });
  img.onerror = () => { if (panel.image?.url) img.src = panel.image.url; else img.remove(); };
  caseEl.append(img);
  const stage = h("div.bub-stage", caseEl);
  let ctl = AB.mount(caseEl, list, { edit: true });
  const rebuild = () => { ctl.setList(list); ctl.select(sel); };

  // ---- glisser une bulle ou sa queue
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

  // ---- panneau de reglages
  const side = h("div.bub-side");
  const addBar = h("div.bub-add", h("span.muted", "Ajouter :"),
    ...Object.keys(LABEL).map((t) => h("button.mini", { title: "Ajouter une bulle « " + LABEL[t] + " »", on: { click: () => add(t) } }, LABEL[t])));
  function add(type) {
    const n = list.length;
    const b = { id: uid(), type, text: DEFAULT_TEXT[type], x: clamp(0.5 + (n % 3 - 1) * 0.16, 0.12, 0.88), y: clamp(0.28 + n * 0.12, 0.12, 0.88),
                size: "M", color: "white", font: "bd", show: "always", at: 0, anim: "pop" };
    if (TAIL[type]) { b.tx = clamp(b.x + 0.08, 0, 1); b.ty = clamp(b.y + 0.22, 0, 1.1); }
    list.push(b); sel = b.id; rebuild(); syncPanel(); save();
  }
  const seg = (items, cur, set) => {
    const box = h("div.seg", items.map(([k, label]) => {
      const bt = h("button" + (k === cur ? ".on" : ""), { on: { click: () => { set(k); box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === bt)); } } }, label);
      return bt;
    }));
    return box;
  };
  function syncPanel() {
    side.textContent = "";
    side.append(addBar);
    side.append(h("div.bub-list", list.map((b, i) => h("button.mini" + (b.id === sel ? ".on" : ""), { title: b.text, on: { click: () => { sel = b.id; ctl.select(sel); syncPanel(); } } },
      `${i + 1} · ${(b.text || "…").slice(0, 14)}`))));
    const b = list.find((x) => x.id === sel);
    if (!b) { side.append(h("p.muted", list.length ? "Clique une bulle pour la régler." : "Aucune bulle : ajoute-en une ci-dessus, puis glisse-la sur la case.")); return; }
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
    side.append(h("div.row", h("label", tail, " Queue (glisse le losange violet)"),
      h("span.sp"), h("button.mini.danger", { on: { click: () => { list.splice(list.indexOf(b), 1); sel = list[0]?.id || null; rebuild(); syncPanel(); save(); } } }, "Supprimer")));
  }
  syncPanel();
  ctl.select(sel);

  const body = h("div.bub-edit", stage, side);
  const m = modal("Bulles de la case " + (g ? g.order : caseId), body, [{ label: "Fermer", primary: true }]);
  m.box.classList.add("bub-modal");
  const cleanup = new MutationObserver(() => { if (!document.body.contains(m.box)) { ctl.destroy(); cleanup.disconnect(); } });
  cleanup.observe(document.body, { childList: true });
}
