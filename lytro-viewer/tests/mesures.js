// Mesures du lecteur lytro-viewer dans Chromium (Playwright), sur les piles de demo.json.
//   node lytro-viewer/tests/mesures.js [url]        (defaut : http://localhost:8799/lytro-viewer/ ; servir la racine du depot)
// 1. repos : la vue affichee au centre contre la photo (PSNR) — l'image n'est ni retournee ni decalee ;
// 2. doubles contours : une vue reelle NON chargee (pas des vues 3 px) reconstruite a partir de ses voisines, erreur
//    sur les bords (15 % des pixels au plus fort gradient), fondu simple contre fondu guide par la profondeur ;
// 3. sortie de zone morte : la souris traverse le centre lentement, plus grand ecart image a image (et parallaxe) ;
// 4. images par seconde (rendu logiciel ici : indicatif) et memoire GPU par case.
const { chromium } = require(process.env.PW || "playwright");

(async () => {
  const base = process.argv[2] || "http://localhost:8799/lytro-viewer/", extra = process.argv[3] || "";
  const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await b.newPage({ viewport: { width: 1400, height: 6000 } });   // toutes les cases a l ecran (sinon elles ne chargent pas)
  const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  const q = new URLSearchParams("preserve=1&hint=0&minGap=3");
  for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);          // les parametres passes l'emportent
  await p.goto(base + "?" + q.toString().replace(/%2F/g, "/").replace(/%2C/g, ","));
  await p.waitForFunction(() => window.__lv && [...__lv.LV.viewers].every(v => v.calibMs != null), null, { timeout: 180000 });

  const out = await p.evaluate(async () => {
    const { LV, set } = window.__lv, vs = [...LV.viewers];
    const grab = (v) => { const c = document.createElement("canvas"); c.width = v.cw; c.height = v.ch;
      const x = c.getContext("2d"); x.drawImage(v.cv, 0, 0); return x.getImageData(0, 0, v.cw, v.ch).data; };
    const truth = async (v, k) => { const bm = await createImageBitmap(await v.src.blob(v.L.name(k, "v")), { resizeWidth: v.cw, resizeHeight: v.ch, resizeQuality: "high" });
      const c = document.createElement("canvas"); c.width = v.cw; c.height = v.ch; const x = c.getContext("2d"); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, v.cw, v.ch).data; };
    const lum = (d) => { const g = new Float32Array(d.length / 4); for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]; return g; };
    const edgeMask = (d, w, h) => {
      const g = lum(d), m = new Float32Array(w * h);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; m[i] = Math.hypot(g[i + 1] - g[i - 1], g[i + w] - g[i - w]); }
      const bx = Math.round(w * 0.06), by = Math.round(h * 0.06);
      const vals = []; for (let y = by; y < h - by; y++) for (let x = bx; x < w - bx; x++) vals.push(m[y * w + x]);
      vals.sort((a, b) => a - b); const th = vals[Math.floor(vals.length * 0.85)];
      const idx = []; for (let y = by; y < h - by; y++) for (let x = bx; x < w - bx; x++) if (m[y * w + x] >= th) idx.push(y * w + x);
      return idx;
    };
    const mae = (a, b, idx) => { let s = 0; for (const i of idx) s += (Math.abs(a[4 * i] - b[4 * i]) + Math.abs(a[4 * i + 1] - b[4 * i + 1]) + Math.abs(a[4 * i + 2] - b[4 * i + 2])) / 3; return s / idx.length; };
    const psnr = (a, b) => { let s = 0, n = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; s += d * d; n++; } return 10 * Math.log10(255 * 255 / (s / n)); };
    const res = [];
    for (const v of vs) {
      const L = v.L, r = { pile: v.src.label, vues: `${v.loaded.size}/${L.cols * L.rows}`, mo: +(v.gpuBytes() / 1048576).toFixed(1), k: v.K.map(x => +x.toFixed(2)) };
      set.warp = true; set.allSharp = true;
      v.snap(L.sx[L.cc], L.sy[L.cr]);
      r.reposPsnr = +psnr(grab(v), await truth(v, L.file(L.cc, L.cr))).toFixed(1);
      // vues reelles non chargees, a l'interieur de la course chargee
      const tests = [];
      const lo = L.sx[v.useI[0]], hi = L.sx[v.useI[v.useI.length - 1]];
      for (let i = 0; i < L.cols; i++) if (!v.useI.includes(i) && L.sx[i] > lo && L.sx[i] < hi) tests.push([i, L.cr]);
      const loy = L.sy[v.useJ[0]], hiy = L.sy[v.useJ[v.useJ.length - 1]];
      for (let j = 0; j < L.rows; j++) if (!v.useJ.includes(j) && L.sy[j] > loy && L.sy[j] < hiy) tests.push([L.cc, j]);
      let e0 = 0, e1 = 0, e2 = 0, gap = 0;
      for (const [i, j] of tests) {
        const T = await truth(v, L.file(i, j)), idx = edgeMask(T, v.cw, v.ch);
        set.warp = false; v.snap(L.sx[i], L.sy[j]); e0 += mae(grab(v), T, idx);
        set.warp = true; v.snap(L.sx[i], L.sy[j]); e1 += mae(grab(v), T, idx);
        const K = v.K; v.K = [1, 0, 1, 0]; v.snap(L.sx[i], L.sy[j]); e2 += mae(grab(v), T, idx); v.K = K;
        const [a, bb] = v.locate(j === L.cr ? v.useI : v.useJ, j === L.cr ? L.sx : L.sy, j === L.cr ? L.sx[i] : L.sy[j]);
        gap += j === L.cr ? L.sx[bb] - L.sx[a] : L.sy[bb] - L.sy[a];
      }
      r.trous = tests.length;
      if (tests.length) { r.ecartMoyen = +(gap / tests.length).toFixed(2); r.bordFondu = +(e0 / tests.length).toFixed(2); r.bordGuide = +(e1 / tests.length).toFixed(2);
        r.gain = +(100 * (1 - e1 / e0)).toFixed(1); r.bordGuideK1 = +(e2 / tests.length).toFixed(2); }
      set.allSharp = false;
      res.push(r);
    }
    return res;
  });

  // sortie de zone morte : souris qui traverse lentement la 1re case (120 pas d'une image), ecarts image a image
  const dz = await p.evaluate(async () => {
    const { LV, set } = window.__lv, out = [];
    set.snap = false;                                          // on mesure la course elle-meme, sans se poser
    for (const v of [...LV.viewers]) {
      const L = v.L;
      v.snap(L.sx[L.cc], L.sy[L.cr]);
      const frames = [], pxs = [];
      const c = document.createElement("canvas"); c.width = v.cw; c.height = v.ch; const x = c.getContext("2d");
      let prev = null;
      v.active = true;
      const vert = L.cols === 1, go = (f) => vert ? v.aim(0, f * 2 - 1) : v.aim(f * 2 - 1, 0);
      go(0.35);                                                   // depart pose (30 images) avant d'enregistrer
      for (let k = 0; k < 30; k++) await new Promise(ok => requestAnimationFrame(ok));
      for (let k = 0; k <= 120; k++) {
        const fx = 0.35 + 0.3 * k / 120;                         // de 35 % a 65 % de la course : la zone morte au milieu
        go(fx);
        await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
        x.drawImage(v.cv, 0, 0); const d = x.getImageData(0, 0, v.cw, v.ch).data;
        if (prev) { let s = 0; for (let i = 0; i < d.length; i += 16) s += Math.abs(d[i] - prev[i]) + Math.abs(d[i + 1] - prev[i + 1]) + Math.abs(d[i + 2] - prev[i + 2]); frames.push(s / (d.length / 16) / 3); }
        pxs.push(vert ? v.py : v.px); prev = d;
      }
      v.active = false; v.home();
      const dp = pxs.slice(1).map((q, i) => Math.abs(q - pxs[i]));
      const med = (a) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
      out.push({ pile: v.src.label, ecartImageMax: +Math.max(...frames).toFixed(2), ecartImageMedian: +med(frames).toFixed(2),
                 pasParallaxeMax: +Math.max(...dp).toFixed(3), pasParallaxeMedian: +med(dp).toFixed(3) });
    }
    set.snap = true;
    return out;
  });

  // images par seconde : bouton « Mesurer »
  await p.click("#bench");
  await p.waitForFunction(() => window.__lvBench, null, { timeout: 30000 });
  const bench = await p.evaluate(() => window.__lvBench);
  const gl = await p.evaluate(() => { const v = [...window.__lv.LV.viewers][0]; const e = v.gl.getExtension("WEBGL_debug_renderer_info");
    return (v.gl2 ? "WebGL2 " : "WebGL1 ") + (e ? v.gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : ""); });
  console.log(JSON.stringify({ rendu: gl, piles: out, zoneMorte: dz, bench, erreurs: errs }, null, 1));
  await b.close();
})();
