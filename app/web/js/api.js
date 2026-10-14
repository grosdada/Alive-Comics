// Appels au serveur local + petit utilitaire DOM.

export async function api(method, path, body, raw) {
  const opt = { method, headers: {} };
  if (raw !== undefined) { opt.body = raw; opt.headers["Content-Type"] = "application/octet-stream"; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch("/api/" + path, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(data.error || ("erreur " + r.status)); err.status = r.status; err.data = data; throw err; }
  return data;
}
export const get = (p) => api("GET", p);
export const post = (p, b) => api("POST", p, b ?? {});
export const put = (p, b) => api("PUT", p, b);
export const upload = (p, blob) => api("POST", p, undefined, blob);

// import d'un son : s'il sert deja dans une planche, on previent (avec les references) avant de le reutiliser ;
// s'il a deja ete importe sans servir, le serveur reprend le fichier existant (pas de doublon)
export async function uploadSound(p, blob) {
  try {
    return await upload(p, blob);
  } catch (e) {
    if (e.status !== 409 || !e.data?.used) throw e;
    const ok = await new Promise((done) => {
      modal("Son déjà utilisé", h("div",
        h("p", "Ce son (même contenu, quel que soit son nom) est déjà utilisé ici :"),
        h("ul", e.data.used.map(u => h("li", u.where))),
        h("p.muted", "Si tu l'utilises quand même, le fichier déjà importé est repris : il n'est pas copié une deuxième fois.")),
        [{ label: "Annuler", click: () => done(false) }, { label: "Utiliser quand même", primary: true, click: () => done(true) }]);
    });
    if (!ok) throw new Error("import annulé");
    return upload(p + (p.includes("?") ? "&" : "?") + "force=1", blob);
  }
}

// h("div.cls#id", {attr, on: {click}}, enfants...)
export function h(sel, props, ...kids) {
  const m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || "div");
  for (const part of (m[2] || "").match(/[.#][\w-]+/g) || []) {
    if (part[0] === ".") el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "class") el.className = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

export function toast(msg, kind = "info", ms = 4500) {
  let box = document.getElementById("toasts");
  if (!box) { box = h("div#toasts"); document.body.append(box); }
  const t = h("div.toast." + kind, msg);
  box.append(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 600);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function modal(title, body, buttons) {
  const back = h("div.modal-back");
  const close = () => back.remove();
  const box = h("div.modal", h("header", h("h2", title), h("button.icon", { title: "Fermer", on: { click: close } }, "✕")),
                h("div.modal-body", body),
                h("footer", (buttons || []).map(b => h("button" + (b.primary ? ".primary" : ""),
                  { on: { click: async () => { if ((await b.click?.(close)) !== false) close(); } } }, b.label))));
  back.append(box);
  back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return { close, box };
}

export function loadImage(url) {
  return new Promise((ok, ko) => {
    const im = new Image();
    im.onload = () => ok(im); im.onerror = () => ko(new Error("image illisible : " + url));
    im.src = url;
  });
}
