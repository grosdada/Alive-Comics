// Formulaires d'une case (utilises dans l'inspecteur et dans les menus des icones) et reglages de page.
import { h, post, toast } from "./api.js";
import { FORMATS } from "./geometry.js";
import { icon } from "./editor.js";

const field = (label, input, hint) => h("label.field", h("span.lab", label), input, hint ? h("small.hint", hint) : null);

function textInput(value, placeholder, onInput, multiline) {
  const el = multiline ? h("textarea", { rows: 3, placeholder }) : h("input", { type: "text", placeholder });
  el.value = value || "";
  el.addEventListener("input", () => onInput(el.value));
  return el;
}

function select(options, value, onChange) {
  const el = h("select", options.map(o => h("option", { value: o.id }, o.label)));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

// ------------------------------------------------------------------ camera
export function cameraForm(app, pid, compact) {
  const panel = app.panel(pid);
  const cam = panel.camera = panel.camera || { id: "arc", fields: {} };
  cam.fields = cam.fields || {};
  const def = app.presets.cameras.find(c => c.id === cam.id) || app.presets.cameras[0];
  const box = h("div.form");
  const redraw = () => { box.replaceWith(cameraForm(app, pid, compact)); };
  box.append(field("Mouvement de caméra", select(app.presets.cameras, cam.id, (v) => {
    cam.id = v;
    const nd = app.presets.cameras.find(c => c.id === v);
    if (nd.kind === "frozen") panel.action = { id: "fige", fields: {} };
    else if ((panel.action?.id || "fige") === "fige" && v !== "fixe") panel.action = { id: "vie", fields: {} };
    app.commitSoon("panel"); redraw(); app.refreshInspector();
  }), def.hint));
  for (const f of def.fields || []) {
    const meta = app.presets.fields[f];
    box.append(field(meta.label, textInput(cam.fields[f], meta.placeholder, (v) => { cam.fields[f] = v; app.commitSoon("panel"); },
                                           f === "text"),
                     f === "text" ? h("button.mini", { on: { click: () => app.translateField(cam.fields, f, redraw) } }, "✨ en anglais") : null));
  }
  if ((def.options || []).includes("amplitude")) {
    box.append(field("Amplitude", select(Object.keys(app.presets.amplitudes).map(k => ({ id: k, label: k + " (" + app.presets.amplitudes[k] + "° demandés)" })),
                                         cam.amplitude || (cam.id === "demi_arc" ? "grand" : "moyen"),
                                         (v) => { cam.amplitude = v; app.commitSoon("panel"); }),
                     "H3 fait environ 60 % de l'angle demandé."));
  }
  if ((def.options || []).includes("rigid")) {
    const cb = h("input", { type: "checkbox" }); cb.checked = !!cam.rigid;
    cb.addEventListener("change", () => { cam.rigid = cb.checked; app.commitSoon("panel"); });
    box.append(h("label.check", cb, " Objet rigide (masque, statue, véhicule) : évite qu'il pivote sur lui-même"));
  }
  if (!compact) box.append(aiButton(app, pid, redraw));
  return box;
}

// ------------------------------------------------------------------ action
export function actionForm(app, pid, compact) {
  const panel = app.panel(pid);
  const act = panel.action = panel.action || { id: "fige", fields: {} };
  act.fields = act.fields || {};
  const camDef = app.presets.cameras.find(c => c.id === (panel.camera?.id || "fixe"));
  const box = h("div.form");
  const redraw = () => { box.replaceWith(actionForm(app, pid, compact)); };
  if (camDef?.kind === "frozen") {
    box.append(h("p.note", "Avec « " + camDef.label + " », la scène est figée : seule la caméra bouge, pilotée au glisser. "
                 + "Pour animer la scène, choisis une caméra fixe, grue, avancée, épaule ou libre."));
    return box;
  }
  const def = app.presets.actions.find(a => a.id === act.id) || app.presets.actions[0];
  box.append(field("Action dans la case", select(app.presets.actions, act.id, (v) => {
    act.id = v; app.commitSoon("panel"); redraw(); app.refreshInspector();
  }), def.hint));
  for (const f of def.fields || []) {
    const meta = app.presets.fields[f];
    box.append(field(meta.label, textInput(act.fields[f], meta.placeholder, (v) => { act.fields[f] = v; app.commitSoon("panel"); },
                                           f === "text"),
                     f === "text" ? h("button.mini", { on: { click: () => app.translateField(act.fields, f, redraw) } }, "✨ en anglais") : null));
  }
  if ((def.options || []).includes("loop")) {
    const cb = h("input", { type: "checkbox" }); cb.checked = !!act.loop;
    cb.addEventListener("change", () => { act.loop = cb.checked; app.commitSoon("panel"); });
    box.append(h("label.check", cb, " En boucle (la dernière image rejoint la première)"));
  }
  if ((panel.camera?.id || "fixe") === "fixe" && act.id === "fige") box.append(h("p.note", "Caméra fixe + temps figé : la case reste une image (pas de vidéo)."));
  return box;
}

function aiButton(app, pid, redraw) {
  const out = h("p.ai-explain");
  const b = h("button.ai", { on: { click: async () => {
    b.disabled = true; b.textContent = "L'IA regarde la case…";
    try {
      const panel = app.panel(pid);
      await app.ensureStart(pid);
      const res = await post("llm/suggest", { project: app.project.id, panel: pid, camera: panel.camera?.id || "arc",
                                              action: panel.action?.id || "fige",
                                              audio: panel.audio?.mode === "generate" ? (panel.audio.preset || "drone_inquietant") : null });
      Object.assign(panel.camera.fields, res.camera || {});
      panel.action = panel.action || { id: "fige", fields: {} };
      Object.assign(panel.action.fields = panel.action.fields || {}, res.action || {});
      if (typeof res.rigid === "boolean" && ["arc", "demi_arc"].includes(panel.camera.id)) panel.camera.rigid = res.rigid;
      if (res.audio && panel.audio?.mode === "generate") panel.audio.extra = res.audio;
      app.commitSoon("panel");
      app.refreshInspector();
      toast(res.explain_fr || "Champs remplis par l'IA.", "ok", 7000);
    } catch (e) { toast(e.message, "error", 8000); }
    finally { b.disabled = false; b.textContent = "✨ Proposer les textes avec l'IA"; }
  } } }, "✨ Proposer les textes avec l'IA");
  return h("div.ai-row", b, out);
}

// ------------------------------------------------------------------ son
export function audioForm(app, pid) {
  const panel = app.panel(pid);
  const aud = panel.audio = panel.audio || { mode: "none" };
  const box = h("div.form");
  const redraw = () => box.replaceWith(audioForm(app, pid));
  const modes = [["none", "Aucun"], ["file", "Importer un fichier"], ["generate", "Générer (MiniMax Music)"]];
  box.append(h("div.seg", modes.map(([m, l]) => h("button" + (aud.mode === m ? ".on" : ""), { on: { click: () => {
    aud.mode = m; app.commitSoon("panel"); redraw(); app.editor.renderOverlay();
  } } }, l))));
  if (aud.mode === "file") {
    box.append(h("button", { on: { click: () => app.pickAudio(pid) } }, icon("audio"), aud.file ? " Remplacer le son…" : " Importer un son…"));
  }
  if (aud.mode === "generate") {
    const def = app.presets.audio.find(a => a.id === (aud.preset || "drone_inquietant"));
    box.append(field("Ambiance", select(app.presets.audio, aud.preset || "drone_inquietant", (v) => { aud.preset = v; app.commitSoon("panel"); redraw(); })));
    box.append(field("Précisions (anglais)", textInput(aud.extra, def?.extra_hint || "e.g. like a cursed golden mask in a dark vault",
                                                        (v) => { aud.extra = v; app.commitSoon("panel"); }, true),
                     h("button.mini", { on: { click: () => app.translateField(aud, "extra", redraw, "music") } }, "✨ en anglais")));
    const secs = h("input", { type: "number", min: 10, max: 60, step: 5, value: aud.seconds || 30 });
    secs.addEventListener("change", () => { aud.seconds = +secs.value; app.commitSoon("panel"); });
    box.append(field("Durée (s)", secs));
    box.append(h("button.primary", { on: { click: () => app.generateAudio(pid) } }, "Générer le son"));
  }
  if (aud.file && aud.mode !== "none") {
    box.append(h("audio", { controls: true, src: `/projects/${app.project.id}/${aud.file}`, preload: "none" }));
  }
  const gen = (aud.generated || []);
  if (aud.mode === "generate" && gen.length > 1) {
    box.append(h("div.variants", gen.map(g => h("label.variant",
      h("input", { type: "radio", name: "aud-" + pid, checked: aud.file === g.file,
                   on: { change: () => app.choose(pid, "A", g.file) } }),
      " graine " + g.seed, h("audio", { controls: true, src: `/projects/${app.project.id}/${g.file}`, preload: "none" })))));
  }
  return box;
}

// ------------------------------------------------------------------ rendus de la case
export function renderSection(app, pid) {
  const panel = app.panel(pid);
  const box = h("div.form");
  const seed = h("input", { type: "number", value: panel.seed || app.settings?.render?.seed || 904231 });
  seed.addEventListener("change", () => { panel.seed = +seed.value; app.commitSoon("panel"); });
  box.append(h("div.row", field("Graine", seed),
    h("button.primary", { on: { click: () => app.renderDialog([pid]) } }, "Générer cette case"),
    h("button", { title: "Même réglages, autre graine", on: { click: () => {
      panel.seed = (+seed.value || 904231) + 1; app.commitSoon("panel"); app.renderDialog([pid]);
    } } }, "Autre variante")));
  const prev = h("details.prompt-preview", h("summary", "Voir le prompt envoyé à H3"), h("div.pp", "…"));
  prev.addEventListener("toggle", async () => {
    if (!prev.open) return;
    const res = await post("plan", { panel, style: app.project.style || "" });
    const pp = prev.querySelector(".pp");
    pp.textContent = "";
    if (res.warning) pp.append(h("p.note", res.warning));
    if (!res.jobs.length) pp.append(h("p", "Pas de vidéo pour cette case."));
    for (const j of res.jobs) {
      pp.append(h("p", h("b", `${j.side === "V" ? "Vidéo" : j.side === "L" ? "Côté gauche" : "Côté droit"} · ${j.mode} · LoRA ${j.lora} · ${j.length} images`)),
                h("pre", j.full_prompt));
    }
  });
  box.append(prev);
  const jobs = app.jobs.filter(j => j.project === app.project.id && j.panel === pid && ["queued", "running", "error"].includes(j.status));
  for (const j of jobs) {
    box.append(h("div.jobline." + j.status, `${sideName(j.side)} : ${statusText(j)}`,
                 j.status !== "error" ? h("button.mini", { on: { click: () => app.cancelJob(j.id) } }, "Annuler") : null,
                 j.status === "error" ? h("small.err", j.error) : null));
  }
  const renders = panel.renders || [];
  for (const side of ["L", "V", "R"]) {
    const list = renders.filter(r => r.side === side).slice().reverse();
    if (!list.length) continue;
    box.append(h("h4", sideName(side) + " — variantes"));
    box.append(h("div.variants", list.map(r => {
      const v = h("video", { src: `/projects/${app.project.id}/${r.file}`, muted: true, loop: true, preload: "metadata", playsInline: true });
      v.muted = true;
      v.addEventListener("mouseenter", () => v.play().catch(() => {}));
      v.addEventListener("mouseleave", () => v.pause());
      const chosen = (panel.chosen || {})[side] === r.file;
      return h("div.variant" + (chosen ? ".chosen" : ""), v,
               h("div.vmeta", `graine ${r.seed} · ${r.worker || ""} · ${Math.round(r.seconds || 0)} s`),
               h("button.mini" + (chosen ? ".on" : ""), { on: { click: () => app.choose(pid, side, r.file) } }, chosen ? "Utilisée" : "Utiliser"));
    })));
  }
  return box;
}

export function sideName(s) { return { L: "Côté gauche", R: "Côté droit", V: "Vidéo", A: "Son" }[s] || s; }

export function statusText(j) {
  if (j.status === "queued") return "en attente";
  if (j.status === "running") return `${j.worker} · ${j.progress || "calcul"}`;
  if (j.status === "done") return "terminé";
  if (j.status === "error") return "erreur";
  return j.status;
}

// ------------------------------------------------------------------ reglages de page
export function pageForm(app) {
  const P = app.project, pg = P.page;
  const box = h("div.form");
  const set = (k, v, relayout) => { pg[k] = v; app.commit("page"); if (relayout) app.editor.render(); };
  box.append(field("Format", select(FORMATS, pg.format, (v) => {
    const f = FORMATS.find(x => x.id === v); pg.format = v; pg.width = f.w; pg.height = f.h; app.commit("page"); app.editor.render();
  })));
  const color = (k, label) => {
    const el = h("input", { type: "color", value: pg[k] });
    el.addEventListener("input", () => { pg[k] = el.value; app.editor.render(); app.commitSoon("page"); });
    return field(label, el);
  };
  box.append(h("div.row", color("bg", "Fond (autour des cases)"), color("stroke", "Traits")));
  const num = (k, label, min, max) => {
    const el = h("input", { type: "range", min, max, value: pg[k] });
    const out = h("output", String(pg[k]));
    el.addEventListener("input", () => { pg[k] = +el.value; out.textContent = el.value; app.editor.render(); app.commitSoon("page"); });
    return field(label, h("div.range", el, out));
  };
  box.append(num("strokeWidth", "Épaisseur des traits", 0, 16), num("gutter", "Gouttière", 0, 80), num("margin", "Marge", 0, 200));
  box.append(field("Ambiance commune (anglais, ajoutée aux plans animés)",
                   textInput(P.style, "e.g. Warm 1970s film look, natural colors", (v) => { P.style = v; app.commitSoon("page"); }, true)));
  return box;
}
