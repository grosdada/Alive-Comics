// Formulaires d'une case (inspecteur et menus des icones) et reglages de page.
import { h, post, toast } from "./api.js";
import { FORMATS, pageSize } from "./geometry.js";
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

function check(label, value, onChange) {
  const cb = h("input", { type: "checkbox" });
  cb.checked = !!value;
  cb.addEventListener("change", () => onChange(cb.checked));
  return h("label.check", cb, " " + label);
}

function volume(obj, def, app) {
  const el = h("input", { type: "range", min: 0, max: 100, value: Math.round((obj.volume ?? def) * 100) });
  const out = h("output", Math.round((obj.volume ?? def) * 100) + " %");
  el.addEventListener("input", () => { obj.volume = el.value / 100; out.textContent = el.value + " %"; app.commitSoon("panel"); });
  return field("Volume", h("div.range", el, out));
}

// ------------------------------------------------------------------ camera
// traitement d'une case : video MiniMax H3 (quelques minutes sur les machines) ou photo en relief (instantane)
export function treatmentForm(app, pid) {
  const panel = app.panel(pid);
  const relief = panel.treatment === "relief";
  const box = h("div.form");
  box.append(seg([["h3", "Vidéo H3"], ["relief", "Relief (instantané)"]], relief ? "relief" : "h3", (m) => {
    panel.treatment = m; app.commitSoon("panel"); app.refreshInspector(); app.editor.renderOverlay?.();
  }));
  if (!relief) {
    box.append(h("p.muted", "La case devient une courte vidéo MiniMax H3 (quelques minutes de calcul sur les machines)."));
    return box;
  }
  const r = panel.relief = panel.relief || {};
  box.append(h("p.muted", "Photo en relief : une carte de profondeur calculée en une seconde sur ce PC (Depth Anything V2 Small, " +
                         "licence Apache 2.0). Le lecteur bouge la caméra de quelques pour cent au survol, au clic ou au glisser. Aucune vidéo."));
  box.append(field("Mouvement", select(app.presets.relief || [], r.preset || "respire", (v) => { r.preset = v; app.commitSoon("panel"); }),
                   (app.presets.relief || []).find(x => x.id === (r.preset || "respire"))?.hint));
  box.append(field("Déclenchement", select([{ id: "hover", label: "Au survol (boucle douce)" }, { id: "click", label: "Au clic (un tour)" }],
                                            r.trigger || "hover", (v) => { r.trigger = v; app.commitSoon("panel"); })));
  const go = h("button.primary", "Calculer la carte de profondeur");
  go.addEventListener("click", async () => {
    go.disabled = true; go.textContent = "Calcul…";
    try {
      await app.ensureStart?.(pid);
      const res = await post(`projects/${app.project.id}/depth/${pid}`, { force: true });
      toast(`Carte prête en ${res.seconds} s. Aperçu pour voir le relief.`, "ok");
    } catch (e) { toast(e.message, "error"); }
    go.disabled = false; go.textContent = "Calculer la carte de profondeur";
  });
  box.append(h("div.row", go), h("small.muted", "Amplitude, plan net et durée se règlent dans l'aperçu, mode édition."));
  return box;
}

export function cameraForm(app, pid, compact) {
  const panel = app.panel(pid);
  const cam = panel.camera = panel.camera || { id: "arc", fields: {} };
  cam.fields = cam.fields || {};
  const def = app.presets.cameras.find(c => c.id === cam.id) || app.presets.cameras[0];
  const box = h("div.form");
  const redraw = () => { box.replaceWith(cameraForm(app, pid, compact)); };
  box.append(field("Mouvement de caméra", select(app.presets.cameras, cam.id, (v) => {
    cam.id = v; app.commitSoon("panel"); redraw(); app.refreshInspector();
  }), def.hint));
  const animated = (panel.action?.id || "fige") !== "fige";
  if (def.kind === "frozen" && animated) {
    box.append(h("p.note", "Avec l'action choisie, ce mouvement est joué en un seul plan pendant l'action (lecture automatique)."));
  }
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
    box.append(check("Objet rigide (masque, statue, véhicule) : évite qu'il pivote sur lui-même", cam.rigid,
                     (v) => { cam.rigid = v; app.commitSoon("panel"); }));
  }
  // tremble ajoute au montage : pour les plans qui jouent tout seuls
  if (def.kind !== "frozen" || animated) {
    const dflt = (app.presets.shake_default || {})[cam.id] || "aucun";
    const labels = { aucun: "aucun", leger: "léger", moyen: "moyen", fort: "fort" };
    box.append(field("Tremblé caméra ajouté au montage",
      select(app.presets.shakes.map(k => ({ id: k, label: labels[k] + (k === dflt ? " (par défaut)" : "") })), cam.shake || dflt,
             (v) => { cam.shake = v; app.commitSoon("panel"); }),
      "Ajouté à l'assemblage (pas de nouveau rendu) ; la boucle reste parfaite."));
  }
  box.append(extraField(app, cam, redraw));
  box.append(aiBlock(app, pid, redraw));
  return box;
}

// ------------------------------------------------------------------ action
export function actionForm(app, pid, compact) {
  const panel = app.panel(pid);
  const act = panel.action = panel.action || { id: "fige", fields: {} };
  act.fields = act.fields || {};
  const box = h("div.form");
  const redraw = () => { box.replaceWith(actionForm(app, pid, compact)); };
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
  if (act.id !== "fige") {
    box.append(check("Animation en boucle (la fin rejoint le début)", act.loop !== false,
                     (v) => { act.loop = v; app.commitSoon("panel"); }));
    box.append(extraField(app, act, redraw));
    box.append(aiBlock(app, pid, redraw));
  }
  if ((panel.camera?.id || "fixe") === "fixe" && act.id === "fige" && !(panel.camera?.extra || "").trim()) {
    box.append(h("p.note", "Caméra fixe + temps figé : la case reste une image, sauf si tu écris des précisions dans la caméra."));
  }
  return box;
}

// precisions libres ajoutees au prompt, quel que soit le preset
function extraField(app, obj, redraw) {
  return field("Précisions (ajoutées au prompt, anglais)",
               textInput(obj.extra, "e.g. soft morning light, dust in the air", (v) => { obj.extra = v; app.commitSoon("panel"); }, true),
               h("button.mini", { on: { click: () => app.translateField(obj, "extra", redraw) } }, "✨ en anglais"));
}

// l'IA regarde la case et ecrit directement dans les champs ; son explication reste affichee sous le bouton
function aiBlock(app, pid, redraw) {
  const panel = app.panel(pid);
  const b = h("button.ai", { on: { click: async () => {
    b.disabled = true; b.textContent = "L'IA regarde la case…";
    try {
      await app.ensureStart(pid);
      const res = await post("llm/suggest", { project: app.project.id, panel: pid, camera: panel.camera?.id || "arc",
                                              action: panel.action?.id || "fige",
                                              audio: panel.audio?.mode === "generate" ? (panel.audio.preset || "drone_inquietant") : null });
      panel.camera.fields = Object.assign(panel.camera.fields || {}, clean(res.camera));
      panel.action = panel.action || { id: "fige", fields: {} };
      panel.action.fields = Object.assign(panel.action.fields || {}, clean(res.action));
      if (typeof res.rigid === "boolean" && ["arc", "demi_arc"].includes(panel.camera.id)) panel.camera.rigid = res.rigid;
      if (res.audio && panel.audio?.mode === "generate") panel.audio.extra = res.audio;
      panel.ai_note = res.explain_fr || "";
      app.commit("panel");
      app.refreshInspector();
      redraw();
    } catch (e) { toast(e.message, "error", 8000); b.disabled = false; b.textContent = "✨ Écrire les textes avec l'IA"; }
  } } }, "✨ Écrire les textes avec l'IA");
  return h("div.ai-row", b, panel.ai_note ? h("p.ai-explain", panel.ai_note) : null);
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (typeof v === "string" && v.trim()) out[k] = v.trim();
  return out;
}

// ------------------------------------------------------------------ sons : 3 couches
export function audioForm(app, pid) {
  const box = h("div.form");
  box.append(h("h5", "Son 1 · ambiance / musique (en boucle)"), layerOne(app, pid),
             h("h5", "Son 2 · voix off / second son"), layerTwo(app, pid),
             h("h5", "Bruitages (foley)"), foleyForm(app, pid));
  return box;
}

function seg(modes, cur, onPick) {
  return h("div.seg", modes.map(([m, l]) => h("button" + (cur === m ? ".on" : ""), { on: { click: () => onPick(m) } }, l)));
}

function generatedList(app, pid, layer, side) {
  const g = (app.panel(pid)[layer] || {}).generated || [];
  if (g.length < 2) return null;
  const cur = app.panel(pid)[layer].file;
  return h("div.variants", g.map(x => h("label.variant",
    h("input", { type: "radio", name: `${layer}-${pid}`, checked: cur === x.file, on: { change: () => app.choose(pid, side, x.file) } }),
    " " + (x.seed != null ? "graine " + x.seed : x.engine || ""),
    h("audio", { controls: true, src: `/projects/${app.project.id}/${x.file}`, preload: "none" }))));
}

function player(app, file) {
  return file ? h("audio", { controls: true, src: `/projects/${app.project.id}/${file}`, preload: "none" }) : null;
}

function layerOne(app, pid) {
  const panel = app.panel(pid);
  const aud = panel.audio = panel.audio || { mode: "none" };
  const box = h("div.form.layer");
  const redraw = () => box.replaceWith(layerOne(app, pid));
  box.append(seg([["none", "Aucun"], ["file", "Fichier"], ["generate", "Générer (MiniMax Music)"]], aud.mode, (m) => {
    aud.mode = m; app.commitSoon("panel"); redraw(); app.editor.renderOverlay();
  }));
  if (aud.mode === "file") box.append(h("button", { on: { click: () => app.pickAudio(pid, "audio") } }, icon("audio"), aud.file ? " Remplacer…" : " Importer un son…"));
  if (aud.mode === "generate") {
    const def = app.presets.audio.find(a => a.id === (aud.preset || "drone_inquietant"));
    box.append(field("Ambiance", select(app.presets.audio, aud.preset || "drone_inquietant", (v) => { aud.preset = v; app.commitSoon("panel"); redraw(); })));
    box.append(field("Précisions (anglais)", textInput(aud.extra, def?.extra_hint || "e.g. like a cursed golden mask in a dark vault",
                                                        (v) => { aud.extra = v; app.commitSoon("panel"); }, true),
                     h("button.mini", { on: { click: () => app.translateField(aud, "extra", redraw, "music") } }, "✨ en anglais")));
    const secs = h("input", { type: "number", min: 10, max: 60, step: 5, value: aud.seconds || 30 });
    secs.addEventListener("change", () => { aud.seconds = +secs.value; app.commitSoon("panel"); });
    box.append(h("div.row", field("Durée (s)", secs), h("button.primary", { on: { click: () => app.generateLayer(pid, "audio") } }, "Générer")));
  }
  if (aud.mode !== "none") box.append(player(app, aud.file), generatedList(app, pid, "audio", "A"), volume(aud, 0.8, app));
  return box;
}

function layerTwo(app, pid) {
  const panel = app.panel(pid);
  const v = panel.voice = panel.voice || { mode: "none" };
  const box = h("div.form.layer");
  const redraw = () => box.replaceWith(layerTwo(app, pid));
  box.append(seg([["none", "Aucun"], ["file", "Voix off (MP3)"], ["tts", "Voix IA (fal)"], ["music", "Musique"]], v.mode, (m) => {
    v.mode = m;
    if (m === "music" && v.loop === undefined) v.loop = true;
    app.commitSoon("panel"); redraw(); app.editor.renderOverlay();
  }));
  if (v.mode === "file") box.append(h("button", { on: { click: () => app.pickAudio(pid, "voice") } }, icon("audio"),
                                      v.file ? " Charger une autre voix off…" : " Charger la voix off (MP3)…"));
  if (v.mode === "tts") {
    const txt = textInput(v.text, "Le texte dit par la voix off…", (x) => { v.text = x; app.commitSoon("panel"); }, true);
    box.append(field("Texte", txt, h("button.mini", { on: { click: async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = "L'IA écrit…";
      try {
        await app.ensureStart(pid);
        v.text = (await post("llm/voice", { project: app.project.id, panel: pid, language: v.language || "French", note: v.note || "" })).text;
        app.commit("panel"); redraw();
      } catch (err) { toast(err.message, "error"); btn.disabled = false; btn.textContent = "✨ Proposer un texte"; }
    } } }, "✨ Proposer un texte")));
    box.append(h("div.row",
      field("Voix", select(app.presets.voices, v.voice_id || "Deep_Voice_Man", (x) => { v.voice_id = x; app.commitSoon("panel"); })),
      field("Langue", select(app.presets.languages.map(l => ({ id: l, label: l })), v.language || "French", (x) => { v.language = x; app.commitSoon("panel"); }))));
    const sp = h("input", { type: "range", min: 50, max: 200, value: Math.round((v.speed || 1) * 100) });
    const so = h("output", (v.speed || 1).toFixed(2));
    sp.addEventListener("input", () => { v.speed = sp.value / 100; so.textContent = v.speed.toFixed(2); app.commitSoon("panel"); });
    box.append(h("div.row",
      field("Émotion", select(app.presets.emotions.map(x => ({ id: x, label: x })), v.emotion || "neutral", (x) => { v.emotion = x; app.commitSoon("panel"); })),
      field("Vitesse", h("div.range", sp, so))));
    box.append(h("div.row", h("button.primary", { on: { click: () => app.generateLayer(pid, "voice") } }, "Générer la voix"),
                 h("small.muted", "MiniMax Speech sur fal (payant, quelques centimes).")));
  }
  if (v.mode === "music") {
    box.append(field("Ambiance", select(app.presets.audio, v.preset || "suspense", (x) => { v.preset = x; app.commitSoon("panel"); redraw(); })));
    box.append(field("Précisions (anglais)", textInput(v.extra, "e.g. a lonely cello motif", (x) => { v.extra = x; app.commitSoon("panel"); }, true)));
    box.append(h("button.primary", { on: { click: () => app.generateLayer(pid, "voice") } }, "Générer"));
  }
  if (v.mode !== "none") {
    box.append(player(app, v.file), generatedList(app, pid, "voice", "B"),
               check("En boucle (sinon : reprend au début à chaque survol)", v.loop ?? (v.mode === "music"), (x) => { v.loop = x; app.commitSoon("panel"); }),
               volume(v, 1.0, app));
  }
  return box;
}

function foleyForm(app, pid) {
  const panel = app.panel(pid);
  const f = panel.foley = panel.foley || { on: false, engine: "h3" };
  const box = h("div.form.layer");
  const redraw = () => box.replaceWith(foleyForm(app, pid));
  box.append(check("Ajouter des bruitages sur la vidéo de la case", f.on, (x) => { f.on = x; app.commitSoon("panel"); redraw(); app.editor.renderOverlay(); }));
  if (!f.on) return box;
  const def = app.presets.foley.find(x => x.id === (f.engine || "h3"));
  box.append(field("Moteur", select(app.presets.foley, f.engine || "h3", (x) => { f.engine = x; app.commitSoon("panel"); redraw(); }), def?.hint));
  if ((f.engine || "h3") !== "h3") {
    box.append(field("Décrire les sons (anglais, facultatif)", textInput(f.prompt, "e.g. fingers tapping on skin, wet creaks",
                                                                       (x) => { f.prompt = x; app.commitSoon("panel"); }, true)));
    box.append(h("button.primary", { on: { click: () => app.generateLayer(pid, "foley") } }, "Générer les bruitages"));
    box.append(player(app, f.file), generatedList(app, pid, "foley", "F"));
  } else {
    box.append(h("p.muted", "Extraits automatiquement du rendu choisi à l'aperçu et à la publication."));
  }
  box.append(volume(f, 0.9, app));
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
      pp.append(h("p", h("b", `${sideName(j.side)} · ${j.mode} · LoRA ${j.lora} · ${j.length} images${j.last_is_first ? " · boucle" : ""}`)),
                h("pre", j.full_prompt));
    }
  });
  box.append(prev);
  // prompt reecrit dans l'apercu (mode edition, bouton « Regenerer ») : il remplace celui des menus
  const over = Object.entries(panel.prompt_override || {}).filter(([, t]) => t);
  if (over.length) {
    box.append(h("div.form",
      h("p.note", "✏️ Prompt réécrit depuis l'aperçu (mode édition) : il remplace celui des menus pour les prochains rendus."),
      over.map(([s, t]) => h("details.prompt-preview", h("summary", sideName(s)), h("pre", t))),
      h("button.mini", { on: { click: () => { panel.prompt_override = null; app.commitSoon("panel"); app.refreshInspector(); } } },
        "Revenir au prompt des menus")));
  }
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
               h("div.vmeta", `graine ${r.seed} · ${r.worker || ""} · ${Math.round(r.seconds || 0)} s${r.audio ? " · son" : ""}`
                 + (r.motion != null ? ` · mouvement ${r.motion}` : "")),
               r.motion != null && r.motion < 0.3 ? h("div.vwarn", "⚠ presque immobile : action plus forte ou autre graine") : null,
               h("button.mini" + (chosen ? ".on" : ""), { on: { click: () => app.choose(pid, side, r.file) } }, chosen ? "Utilisée" : "Utiliser"));
    })));
  }
  return box;
}

export function sideName(s) { return { L: "Côté gauche", R: "Côté droit", V: "Vidéo", A: "Son 1", B: "Son 2", F: "Bruitages", P: "Son global", C: "Couches relief" }[s] || s; }

export function statusText(j) {
  if (j.status === "queued") return j.after?.length ? "attend la vidéo" : "en attente";
  if (j.status === "running") return `${j.worker} · ${j.progress || "calcul"}`;
  if (j.status === "done") return "terminé";
  if (j.status === "error") return "erreur";
  return j.status;
}

// ------------------------------------------------------------------ reglages de page
export function pageForm(app) {
  const P = app.project, pg = P.page;
  const box = h("div.form");
  const resize = () => {
    const [w, hh] = pageSize(pg.format, pg.orientation);
    pg.width = w; pg.height = hh;
    app.commit("page"); app.editor.render(); app.renderLeft();
  };
  box.append(h("div.row",
    field("Format", select(FORMATS, pg.format, (v) => { pg.format = v; resize(); })),
    field("Sens", h("div.seg", [["portrait", "Vertical"], ["paysage", "Horizontal"]].map(([k, l]) =>
      h("button" + ((pg.orientation || "portrait") === k ? ".on" : ""), { on: { click: () => { pg.orientation = k; resize(); app.refreshInspector(); } } }, l))))));
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
  box.append(h("h5", "Son global de la page"), pageSoundForm(app));
  return box;
}

// son global : joue en continu sur la page, quelle que soit la case survolee
function pageSoundForm(app) {
  const P = app.project;
  const ps = P.pageSound = P.pageSound || { mode: "none" };
  const box = h("div.form.layer");
  const redraw = () => box.replaceWith(pageSoundForm(app));
  box.append(seg([["none", "Aucun"], ["file", "Fichier"], ["generate", "Générer (MiniMax Music)"]], ps.mode || "none", (m) => {
    ps.mode = m; ps.rev = Date.now() / 1000; app.commit("page"); redraw();
  }));
  if (ps.mode === "file") box.append(h("button", { on: { click: () => app.pickPageSound() } }, icon("audio"), ps.file ? " Remplacer…" : " Importer un son…"));
  if (ps.mode === "generate") {
    const def = app.presets.audio.find(a => a.id === (ps.preset || "suspense"));
    box.append(field("Ambiance", select(app.presets.audio, ps.preset || "suspense", (v) => { ps.preset = v; app.commitSoon("page"); redraw(); })));
    box.append(field("Précisions (anglais)", textInput(ps.extra, def?.extra_hint || "e.g. a slow, warm 1970s soundtrack",
                                                        (v) => { ps.extra = v; app.commitSoon("page"); }, true),
                     h("button.mini", { on: { click: () => app.translateField(ps, "extra", redraw, "music") } }, "✨ en anglais")));
    const secs = h("input", { type: "number", min: 10, max: 120, step: 5, value: ps.seconds || 60 });
    secs.addEventListener("change", () => { ps.seconds = +secs.value; app.commitSoon("page"); });
    box.append(h("div.row", field("Durée (s)", secs), h("button.primary", { on: { click: () => app.generatePageSound() } }, "Générer")));
  }
  if (ps.mode && ps.mode !== "none") {
    box.append(player(app, ps.file));
    const g = ps.generated || [];
    if (ps.mode === "generate" && g.length > 1) {
      box.append(h("div.variants", g.map(x => h("label.variant",
        h("input", { type: "radio", name: "pagesound", checked: ps.file === x.file, on: { change: () => app.choose("_page", "P", x.file) } }),
        " graine " + x.seed, h("audio", { controls: true, src: `/projects/${P.id}/${x.file}`, preload: "none" })))));
    }
    box.append(volume(ps, 0.7, app),
               h("p.muted", "Joue en continu sur la page et baisse quand une case joue ses sons. Les navigateurs le lancent au premier clic dans la page."));
  }
  return box;
}
