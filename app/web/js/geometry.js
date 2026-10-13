// Geometrie des planches : un arbre de decoupes, chaque decoupe est un trait (eventuellement penche).
//
// feuille : { t: "leaf", id: "p3" }
// decoupe : { t: "split", dir: "h" | "v", a, b, c: [enfant1, enfant2] }
//   dir "h" = trait plutot horizontal (enfant1 au-dessus) ; "v" = trait plutot vertical (enfant1 a gauche).
//   a, b = position du trait (0..1) a ses deux bouts, dans la boite englobante du parent :
//   pour "h", a = hauteur au bord gauche, b = hauteur au bord droit (a != b : trait penche).
// Les cases sont des polygones convexes : le parent decoupe par deux demi-plans, ecartes de la gouttiere.

// formats donnes en vertical ; « Horizontal » echange largeur et hauteur
export const FORMATS = [
  { id: "bd", label: "Page BD (2:3)", w: 1600, h: 2400 },
  { id: "manga", label: "Manga B5", w: 1500, h: 2120 },
  { id: "portrait45", label: "4:5", w: 1600, h: 2000 },
  { id: "carre", label: "Carré", w: 2000, h: 2000 },
  { id: "ecran", label: "Écran 9:16", w: 1350, h: 2400 },
];

export function pageSize(format, orientation) {
  const f = FORMATS.find(x => x.id === format) || FORMATS[0];
  return orientation === "paysage" ? [f.h, f.w] : [f.w, f.h];
}

// pivote un decoupage : les bandes deviennent des colonnes et inversement
export function transpose(node) {
  if (!node || node.t === "leaf") return node;
  return { ...node, dir: node.dir === "h" ? "v" : "h", c: [transpose(node.c[0]), transpose(node.c[1])] };
}

export const PAGE_DEFAULTS = { format: "bd", orientation: "portrait", width: 1600, height: 2400, bg: "#ffffff", stroke: "#111111",
                               strokeWidth: 5, gutter: 22, margin: 60 };

// ------------------------------------------------------------------ outils
export function bbox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function centroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

// garde les points ou f(p) <= 0 (Sutherland-Hodgman sur un demi-plan)
function clipHalf(poly, f) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i], Q = poly[(i + 1) % poly.length];
    const fp = f(P), fq = f(Q);
    if (fp <= 0) out.push(P);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
    }
  }
  return out;
}

// trait d'une decoupe dans la boite du parent : P, Q, normale unitaire n (vers l'enfant 2)
export function cutLine(node, bb) {
  let P, Q;
  if (node.dir === "h") { P = [bb.x0, bb.y0 + node.a * bb.h]; Q = [bb.x1, bb.y0 + node.b * bb.h]; }
  else { P = [bb.x0 + node.a * bb.w, bb.y0]; Q = [bb.x0 + node.b * bb.w, bb.y1]; }
  const dx = Q[0] - P[0], dy = Q[1] - P[1], L = Math.hypot(dx, dy) || 1;
  let n = [-dy / L, dx / L];
  if (node.dir === "h" && n[1] < 0) n = [-n[0], -n[1]];
  if (node.dir === "v" && n[0] < 0) n = [-n[0], -n[1]];
  return { P, Q, n };
}

// segment visible du trait : intersection de la droite avec le polygone parent
function segmentInPoly(P, Q, poly) {
  const d = [Q[0] - P[0], Q[1] - P[1]];
  let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length];
    const e = [B[0] - A[0], B[1] - A[1]];
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-9) continue;
    const w = [A[0] - P[0], A[1] - P[1]];
    const t = (w[0] * e[1] - w[1] * e[0]) / den;
    const u = (w[0] * d[1] - w[1] * d[0]) / den;
    if (u >= -1e-6 && u <= 1 + 1e-6) { tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
  }
  if (!isFinite(tmin)) return null;
  return [[P[0] + d[0] * tmin, P[1] + d[1] * tmin], [P[0] + d[0] * tmax, P[1] + d[1] * tmax]];
}

// ------------------------------------------------------------------ calcul de la planche
export function compute(page, layout) {
  const m = page.margin, W = page.width, H = page.height, g = page.gutter;
  const panels = [], cuts = [];
  const root = [[m, m], [W - m, m], [W - m, H - m], [m, H - m]];
  (function walk(node, poly, path) {
    if (!node) return;
    if (node.t === "leaf") { panels.push({ id: node.id, poly, bbox: bbox(poly), path }); return; }
    const bb = bbox(poly);
    const { P, Q, n } = cutLine(node, bb);
    const f = (X) => n[0] * (X[0] - P[0]) + n[1] * (X[1] - P[1]);
    const A = clipHalf(poly, (X) => f(X) + g / 2);
    const B = clipHalf(poly, (X) => -f(X) + g / 2);
    const seg = segmentInPoly(P, Q, poly);
    cuts.push({ node, path, bb, seg, P, Q });
    walk(node.c[0], A.length >= 3 ? A : [], path.concat(0));
    walk(node.c[1], B.length >= 3 ? B : [], path.concat(1));
  })(layout, root, []);
  // ordre de lecture : par rangees (haut -> bas), puis gauche -> droite
  const rowH = H * 0.06;
  const live = panels.filter(p => p.poly.length >= 3);
  live.sort((p, q) => {
    const [px, py] = centroid(p.poly), [qx, qy] = centroid(q.poly);
    const overlap = Math.min(p.bbox.y1, q.bbox.y1) - Math.max(p.bbox.y0, q.bbox.y0);
    if (overlap > Math.min(p.bbox.h, q.bbox.h) * 0.5) return px - qx;
    return Math.abs(py - qy) < rowH ? px - qx : py - qy;
  });
  live.forEach((p, i) => { p.order = i + 1; });
  return { panels: live, cuts };
}

// taille de generation H3 : ~0,8 Mpx au ratio de la case, cote long <= 1344, multiples de 32
export function genSize(w, h, mp = 0.8, longMax = 1344) {
  const ratio = w / h, area = mp * 1024 * 1024;
  let gw = Math.sqrt(area * ratio), gh = gw / ratio;
  if (Math.max(gw, gh) > longMax) { const s = longMax / Math.max(gw, gh); gw *= s; gh *= s; }
  return [Math.max(32, Math.round(gw / 32) * 32), Math.max(32, Math.round(gh / 32) * 32)];
}

// ------------------------------------------------------------------ edition de l'arbre
export function nodeAt(layout, path) {
  let n = layout;
  for (const i of path) n = n.c[i];
  return n;
}

export function leaves(layout, out = []) {
  if (!layout) return out;
  if (layout.t === "leaf") out.push(layout.id); else { leaves(layout.c[0], out); leaves(layout.c[1], out); }
  return out;
}

// supprime une case : sa voisine prend la place de la decoupe
export function removeLeaf(layout, id) {
  if (layout.t === "leaf") return layout.id === id ? null : layout;
  const [a, b] = layout.c;
  if (a.t === "leaf" && a.id === id) return b;
  if (b.t === "leaf" && b.id === id) return a;
  return { ...layout, c: [removeLeaf(a, id), removeLeaf(b, id)] };
}

// coupe une case en deux ; la nouvelle case recoit newId
export function splitLeaf(layout, id, dir, newId) {
  if (layout.t === "leaf") {
    return layout.id === id ? { t: "split", dir, a: 0.5, b: 0.5, c: [layout, { t: "leaf", id: newId }] } : layout;
  }
  return { ...layout, c: [splitLeaf(layout.c[0], id, dir, newId), splitLeaf(layout.c[1], id, dir, newId)] };
}

export function clone(x) { return JSON.parse(JSON.stringify(x)); }

// ------------------------------------------------------------------ presets
const L = (id) => ({ t: "leaf", id });
const S = (dir, a, b, c0, c1) => ({ t: "split", dir, a, b, c: [c0, c1] });

function rows(n, mk) {           // n bandes egales
  if (n === 1) return mk();
  return S("h", 1 / n, 1 / n, mk(), rows(n - 1, mk));
}
function cols(n, mk) {
  if (n === 1) return mk();
  return S("v", 1 / n, 1 / n, mk(), cols(n - 1, mk));
}

export const PRESETS = [
  { id: "plein", label: "Pleine page", make: (L) => L() },
  { id: "2b", label: "2 bandes", make: (L) => rows(2, L) },
  { id: "3b", label: "3 bandes", make: (L) => rows(3, L) },
  { id: "2x2", label: "4 cases", make: (L) => rows(2, () => cols(2, L)) },
  { id: "3x2", label: "6 cases", make: (L) => rows(3, () => cols(2, L)) },
  { id: "3x3", label: "9 cases", make: (L) => rows(3, () => cols(3, L)) },
  { id: "g3", label: "Grande + 3", make: (L) => S("h", 0.56, 0.56, L(), cols(3, L)) },
  { id: "col2", label: "Colonne + 2", make: (L) => S("v", 0.58, 0.58, L(), S("h", 0.5, 0.5, L(), L())) },
  { id: "hmb", label: "Haut, 2, bas", make: (L) => S("h", 0.3, 0.3, L(), S("h", 0.58, 0.58, S("v", 0.5, 0.5, L(), L()), L())) },
  { id: "action", label: "Action penchée", make: (L) =>
      S("h", 0.34, 0.27, L(), S("h", 0.55, 0.64, S("v", 0.56, 0.44, L(), L()), L())) },
  { id: "david", label: "Cadres penchés (planche 3)", make: (L) =>
      S("h", 0.31, 0.285, L(), S("h", 0.74, 0.70, S("v", 0.475, 0.47, S("h", 0.53, 0.49, L(), L()), L()), L())) },
  { id: "manga", label: "Manga dynamique", make: (L) =>
      S("h", 0.24, 0.24, cols(2, L), S("h", 0.5, 0.42, S("v", 0.64, 0.4, L(), L()), S("v", 0.33, 0.37, L(), S("h", 0.5, 0.55, L(), L())))) },
];

// variante au hasard (graine reproductible)
export function randomLayout(seed, count, tilt, newId) {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const tilted = (x) => Math.max(0.2, Math.min(0.8, x + (rnd() - 0.5) * 2 * tilt));
  function build(n, w, h) {
    if (n <= 1) return L(newId());
    const dir = w / h > 1.25 ? "v" : (h / w > 1.25 ? "h" : (rnd() < 0.5 ? "h" : "v"));
    const n1 = Math.max(1, Math.min(n - 1, Math.round(n * (0.3 + rnd() * 0.4))));
    const pos = n1 / n * 0.6 + 0.2 + (rnd() - 0.5) * 0.1;
    const a = tilted(pos), b = tilted(pos);
    const [w1, h1, w2, h2] = dir === "h" ? [w, h * pos, w, h * (1 - pos)] : [w * pos, h, w * (1 - pos), h];
    return S(dir, a, b, build(n1, w1, h1), build(n - n1, w2, h2));
  }
  return build(count, 2, 3);
}
