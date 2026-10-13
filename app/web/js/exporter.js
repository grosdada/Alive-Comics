// Rendus canvas cote navigateur : image de depart de chaque case (taille H3), page.jpg, frames.png, vignette.
import { genSize } from "./geometry.js";
import { loadImage, upload } from "./api.js";

// placement de l'image dans la boite de la case : couverture * zoom, decalage (ox, oy) en fraction de la boite
export function placement(bb, iw, ih, view) {
  const v = view || {};
  const zoom = Math.max(1, v.zoom || 1);
  const s = Math.max(bb.w / iw, bb.h / ih) * zoom;
  const dw = iw * s, dh = ih * s;
  const mx = (dw - bb.w) / (2 * bb.w), my = (dh - bb.h) / (2 * bb.h);
  const ox = Math.max(-mx, Math.min(mx, v.ox || 0)), oy = Math.max(-my, Math.min(my, v.oy || 0));
  return { x: bb.x0 + bb.w / 2 - dw / 2 + ox * bb.w, y: bb.y0 + bb.h / 2 - dh / 2 + oy * bb.h, w: dw, h: dh, ox, oy, mx, my };
}

const cache = new Map();
async function img(url) {
  if (!cache.has(url)) cache.set(url, loadImage(url));
  return cache.get(url);
}

const toBlob = (cv, type, q) => new Promise((ok) => cv.toBlob(ok, type, q));

// image de depart d'une case a la taille de generation ; renvoie la signature (pour ne pas renvoyer deux fois)
export async function startImage(project, geo) {
  const panel = project.panels[geo.id];
  if (!panel?.image) return null;
  const [gw, gh] = genSize(geo.bbox.w, geo.bbox.h);
  const sig = JSON.stringify([panel.image.file, panel.view || {}, Math.round(geo.bbox.w), Math.round(geo.bbox.h), gw, gh]);
  if (panel.startSig === sig) return { sig, changed: false, size: [gw, gh] };
  const im = await img(panel.image.url);
  const pl = placement(geo.bbox, im.naturalWidth, im.naturalHeight, panel.view);
  const k = gw / geo.bbox.w;
  const cv = Object.assign(document.createElement("canvas"), { width: gw, height: gh });
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(im, (pl.x - geo.bbox.x0) * k, (pl.y - geo.bbox.y0) * k, pl.w * k, pl.h * k);
  await upload(`projects/${project.id}/start/${geo.id}`, await toBlob(cv, "image/png"));
  panel.startSig = sig;
  return { sig, changed: true, size: [gw, gh] };
}

function polyPath(ctx, poly) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

// page.jpg (fond, images, traits), frames.png (traits seuls), thumb.jpg
export async function pageImages(project, geom) {
  const pg = project.page;
  const cv = Object.assign(document.createElement("canvas"), { width: pg.width, height: pg.height });
  const ctx = cv.getContext("2d");
  ctx.fillStyle = pg.bg; ctx.fillRect(0, 0, pg.width, pg.height);
  for (const g of geom.panels) {
    const panel = project.panels[g.id];
    ctx.save(); polyPath(ctx, g.poly); ctx.clip();
    ctx.fillStyle = "#ffffff"; ctx.fill();
    if (panel?.image) {
      const im = await img(panel.image.url);
      const pl = placement(g.bbox, im.naturalWidth, im.naturalHeight, panel.view);
      ctx.drawImage(im, pl.x, pl.y, pl.w, pl.h);
    }
    ctx.restore();
  }
  const strokes = (c) => {
    c.lineJoin = "miter"; c.strokeStyle = pg.stroke; c.lineWidth = pg.strokeWidth;
    for (const g of geom.panels) { polyPath(c, g.poly); c.stroke(); }
  };
  strokes(ctx);
  const fr = Object.assign(document.createElement("canvas"), { width: pg.width, height: pg.height });
  strokes(fr.getContext("2d"));
  const th = Object.assign(document.createElement("canvas"), { width: 360, height: Math.round(360 * pg.height / pg.width) });
  th.getContext("2d").drawImage(cv, 0, 0, th.width, th.height);
  const base = `projects/${project.id}/page?name=`;
  await upload(base + "page.jpg", await toBlob(cv, "image/jpeg", 0.92));
  await upload(base + "frames.png", await toBlob(fr, "image/png"));
  await upload(base + "thumb.jpg", await toBlob(th, "image/jpeg", 0.8));
}
