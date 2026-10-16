/* lytro-viewer : photo vivante en temps arrete (vues voisines + profondeur), sans dependance.
   Format d'une pile : docs/ROADMAP-LYTRO-CLOUD.md, section 2 (plus meta.grid pour une grille 2D).

   Rendu en trois passes WebGL :
   1. synthese de la vue demandee (resolution du canevas) : fondu des 2 (axe) ou 4 (grille) vues reelles voisines,
      chacune recalee vers la position voulue selon sa profondeur (au plus la moitie de l'ecart entre voisines,
      quelques px : pas d'etirement visible, mais plus de double contour) ; couleur en RGB, disparite en alpha ;
   2. mise au point : flou de profondeur « scatter as gather » borne par des tuiles (min / max de disparite par
      16 px), l'arriere ne bave pas sur un sujet net, bande nette reglable ; 4 images accumulees au repos ;
   3. copie a l'ecran.
   WebGL2 (TEXTURE_2D_ARRAY) avec repli WebGL1 (une texture par vue). */
(function () {
  "use strict";

  const TILE = 16;                          // tuiles de mise au point, en px de la pile
  const MAX_SAMPLES = 128;                  // echantillons du flou (au repos ; moitie en mouvement)

  // Reglages partages par toutes les cases d'une page (modifiables a chaud)
  const defaults = {
    relief: 1.0,          // parallaxe maximale, % de la largeur (la vraie Lytro : ~1 %)
    blur: 0.5,            // force du flou 0-1
    band: 0.03,           // demi-largeur de la bande nette (disparite 0-1)
    focusTime: 0.5,       // duree du glisse de mise au point (s)
    minGap: 1.5,          // pas minimal entre vues chargees (px) : moins de vues = moins de memoire
    snap: true,           // souris immobile : on se pose sur une vue reelle
    warp: true,           // fondu guide par la profondeur (sinon fondu simple)
    allSharp: false, showDepth: false, idle: false, gyro: false,
  };

  // ------------------------------------------------------------------------------------------------ sources
  class UrlSource {
    constructor(base) { this.base = base.endsWith("/") ? base : base + "/"; this.label = decodeURIComponent(this.base.replace(/\/$/, "").split("/").slice(-2).join("/")); }
    async blob(name) { const r = await fetch(this.base + name); if (!r.ok) throw new Error(name + " : " + r.status); return r.blob(); }
  }
  class MapSource {                          // dossier depose / zip : nom relatif -> File | () => Promise<Blob>
    constructor(map, label) { this.map = map; this.label = label; }
    async blob(name) { const f = this.map.get(name); if (!f) throw new Error(name + " absent"); return typeof f === "function" ? f() : f; }
  }
  // Toutes les piles d'un ensemble de fichiers (chemin -> fichier) : chaque dossier qui contient meta.json
  function stacksFromFiles(files, prefix) {
    const out = [];
    for (const path of [...files.keys()].sort()) {
      if (!/(^|\/)meta\.json$/.test(path)) continue;
      const dir = path.slice(0, -"meta.json".length), m = new Map();
      for (const [p, f] of files) if (p.startsWith(dir) && !p.slice(dir.length).includes("/")) m.set(p.slice(dir.length), f);
      out.push(new MapSource(m, (prefix ? prefix + "/" : "") + (dir.replace(/\/$/, "") || "(racine)")));
    }
    return out;
  }
  async function stacksFromDrop(dataTransfer) {
    const files = new Map(), zips = [];
    const walk = async (entry, path) => {
      if (entry.isFile) {
        const f = await new Promise((ok, ko) => entry.file(ok, ko));
        if (/\.zip$/i.test(f.name)) zips.push(f); else files.set(path + f.name, f);
      } else if (entry.isDirectory) {
        const rd = entry.createReader();
        for (;;) {
          const batch = await new Promise((ok, ko) => rd.readEntries(ok, ko));
          if (!batch.length) break;
          for (const e of batch) await walk(e, path + entry.name + "/");
        }
      }
    };
    const entries = [...dataTransfer.items].map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) for (const e of entries) await walk(e, "");
    else for (const f of dataTransfer.files) { if (/\.zip$/i.test(f.name)) zips.push(f); else files.set(f.name, f); }
    return [...stacksFromFiles(files), ...(await stacksFromZips(zips))];
  }
  async function stacksFromFileList(list) {          // <input type=file webkitdirectory> ou fichiers .zip
    const files = new Map(), zips = [];
    for (const f of list) {
      if (/\.zip$/i.test(f.name)) zips.push(f); else files.set(f.webkitRelativePath || f.name, f);
    }
    return [...stacksFromFiles(files), ...(await stacksFromZips(zips))];
  }
  async function stacksFromZips(zips) {
    const out = [];
    for (const z of zips) out.push(...stacksFromFiles(await window.LytroZip.readZip(z), z.name.replace(/\.zip$/i, "")));
    return out;
  }

  // ------------------------------------------------------------------------------------------------ meta
  // Pile -> treillis : positions de parallaxe par colonne (sx) et par ligne (sy), et le fichier de chaque noeud.
  // Axe x : une ligne ; axe y : une colonne ; grille : colonnes x lignes. Les vues en double (meme s, images
  // identiques chez lytro_build) sont ecartees.
  function lattice(meta) {
    const n = meta.n, pad = (i) => String(i).padStart(2, "0");
    const lin = (k, c) => Array.from({ length: k }, (_, i) => (i - c) * 1.5);
    let cols, rows, sx, sy, file, cc, cr;
    if (meta.grid) {
      [cols, rows] = meta.grid;
      cc = meta.center % cols; cr = Math.floor(meta.center / cols);
      sx = meta.sx || (meta.s && meta.s.length === cols ? meta.s : lin(cols, cc));
      sy = meta.sy || lin(rows, cr);
      file = (i, j) => j * cols + i;
    } else {
      const s = meta.s && meta.s.length === n ? meta.s : lin(n, meta.center);
      const keep = [];
      for (let i = 0; i < n; i++) {
        const prev = keep[keep.length - 1];
        if (prev != null && !(s[i] > s[prev])) { if (i === meta.center) keep[keep.length - 1] = i; continue; }
        keep.push(i);
      }
      const pos = keep.map(i => s[i]), ci = keep.indexOf(meta.center) >= 0 ? keep.indexOf(meta.center) : Math.floor(keep.length / 2);
      if (meta.axis === "y") { cols = 1; rows = keep.length; sx = [0]; sy = pos; cc = 0; cr = ci; file = (i, j) => keep[j]; }
      else { cols = keep.length; rows = 1; sx = pos; sy = [0]; cc = ci; cr = 0; file = (i) => keep[i]; }
    }
    return { cols, rows, sx, sy, cc, cr, file, name: (k, kind) => (kind === "d" ? "d" : "v") + pad(k) + (kind === "d" ? ".png" : ".jpg"),
             dups: meta.grid ? 0 : n - cols * rows };
  }

  // Indices retenus sur un axe : depuis le centre vers chaque bout, une vue des que l'ecart depasse minGap, jusqu'a la
  // premiere vue au-dela de la portee (la course de la souris s'arrete entre deux vues chargees)
  function pickAxis(s, c, reach, minGap) {
    const out = [c];
    for (const dir of [-1, 1]) {
      let last = s[c];
      for (let i = c + dir; i >= 0 && i < s.length; i += dir) {
        const far = Math.abs(s[i] - s[c]) >= reach;
        const next = i + dir >= 0 && i + dir < s.length ? s[i + dir] : null;
        // garde la vue si l'ecart est atteint, ou si la suivante le depasserait de trop (pas de trou > 2 minGap)
        if (Math.abs(s[i] - last) >= minGap || far || next == null || Math.abs(next - last) > 2 * minGap) { out.push(i); last = s[i]; }
        if (far) break;
      }
    }
    return out.sort((a, b) => a - b);
  }

  // ------------------------------------------------------------------------------------------------ shaders
  const VS1 = "attribute vec2 p; varying vec2 v; void main(){ v = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }";
  // passes qui lisent une cible de rendu : convention GL (ligne 0 en bas), la synthese ecrit l'image a l'endroit
  const VSGL = "attribute vec2 p; varying vec2 v; void main(){ v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }";
  const VS2 = "#version 300 es\nin vec2 p; out vec2 v; void main(){ v = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }";

  // Synthese : 4 vues (i0j0, i1j0, i0j1, i1j1), poids bilineaires uW, decalage de chaque vue vers la position voulue
  // uOff[k] (px de parallaxe, x et y), recalage du contenu = off * (k * g + c), g = (dN - d) / (dN - dF) : 0 sur le
  // sujet (epingle), 1 sur le fond
  function synthFS(gl2) {
    const head = gl2
      ? "#version 300 es\nprecision highp float; precision highp sampler2DArray; in vec2 v; out vec4 o;\n" +
        "uniform sampler2DArray uC, uD; uniform vec4 uL;\n" +
        "vec3 C(int k, vec2 p){ return texture(uC, vec3(p, k == 0 ? uL.x : k == 1 ? uL.y : k == 2 ? uL.z : uL.w)).rgb; }\n" +
        "float D(int k, vec2 p){ return texture(uD, vec3(p, k == 0 ? uL.x : k == 1 ? uL.y : k == 2 ? uL.z : uL.w)).r; }\n"
      : "precision highp float; varying vec2 v;\nuniform sampler2D uC0, uC1, uC2, uC3, uD0, uD1, uD2, uD3;\n" +
        "vec3 C(int k, vec2 p){ return k == 0 ? texture2D(uC0, p).rgb : k == 1 ? texture2D(uC1, p).rgb : k == 2 ? texture2D(uC2, p).rgb : texture2D(uC3, p).rgb; }\n" +
        "float D(int k, vec2 p){ return k == 0 ? texture2D(uD0, p).r : k == 1 ? texture2D(uD1, p).r : k == 2 ? texture2D(uD2, p).r : texture2D(uD3, p).r; }\n";
    return head + `
      uniform vec4 uW; uniform vec2 uOff[4]; uniform vec2 uInvW; uniform vec4 uK; uniform vec2 uNF; uniform float uWarp;
      void main(){
        vec3 c = vec3(0.0); float d = 0.0;
        for (int k = 0; k < 4; k++) {
          float w = k == 0 ? uW.x : k == 1 ? uW.y : k == 2 ? uW.z : uW.w;
          if (w <= 0.0) continue;
          vec2 p = v;
          if (uWarp > 0.5) {
            // profondeur de la vue au point (le recalage ne fait que quelques px : l'erreur est negligeable)
            float g = clamp((uNF.x - D(k, v)) / (uNF.x - uNF.y), -1.5, 1.5);
            vec2 sh = uOff[k] * vec2(uK.x * g + uK.y, uK.z * g + uK.w);
            p = clamp(v - sh * uInvW, 0.0, 1.0);
          }
          c += w * C(k, p); d += w * D(k, p);
        }
        ${gl2 ? "o" : "gl_FragColor"} = vec4(c, d);
      }`;
  }

  // Mise au point. Echantillons en disque de Vogel (nombre selon le rayon), tuiles 3x3 autour du pixel pour borner
  // le rayon. Un echantillon plus loin que le pixel ne s'etale pas plus que le pixel lui-meme (pas de bavure du fond
  // sur un sujet net) ; un premier plan flou deborde sur ce qui est derriere.
  const BLUR_FS = `precision highp float; varying vec2 v;
    uniform sampler2D uS, uT; uniform vec2 uPx, uTiles; uniform float uFocus, uBand, uAp, uMaxR, uRot, uN;
    float coc(float d){ return clamp((abs(d - uFocus) - uBand) * uAp, 0.0, uMaxR); }
    void main(){
      vec4 s0 = texture2D(uS, v);
      float cs = coc(s0.a);
      // rayon utile : la plus grande tache des tuiles voisines (min / max de disparite)
      float mr = 0.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 t = texture2D(uT, vec2(v.x, 1.0 - v.y) + vec2(float(x), float(y)) / uTiles).rg;   // tuiles : ligne 0 en haut
        mr = max(mr, max(coc(t.r), coc(t.g)));
      }
      mr = max(mr, cs);
      if (mr < 0.5) { gl_FragColor = vec4(s0.rgb, 1.0); return; }
      float n = clamp(floor(mr * mr * 0.9), 6.0, uN);
      vec3 acc = s0.rgb; float wsum = 1.0;
      for (int i = 0; i < ${MAX_SAMPLES}; i++) {
        if (float(i) >= n) break;
        float r = mr * sqrt((float(i) + 0.5) / n), a = float(i) * 2.39996323 + uRot;
        vec4 sp = texture2D(uS, v + vec2(cos(a), sin(a)) * r * uPx);
        float ss = coc(sp.a);
        if (sp.a < s0.a) ss = min(ss, cs);
        float w = clamp(ss - r + 0.5, 0.0, 1.0);
        acc += sp.rgb * w; wsum += w;
      }
      gl_FragColor = vec4(acc / wsum, 1.0);
    }`;

  // Copie a l'ecran (ou visualisation de la profondeur, bande nette en orange)
  const COPY_FS = `precision highp float; varying vec2 v;
    uniform sampler2D uS; uniform float uMode, uFocus, uBand;
    void main(){
      vec4 s = texture2D(uS, v);
      if (uMode > 0.5) { float inb = step(abs(s.a - uFocus), uBand); gl_FragColor = vec4(mix(vec3(s.a), vec3(1.0, 0.55, 0.1), 0.6 * inb), 1.0); return; }
      gl_FragColor = vec4(s.rgb, 1.0);
    }`;

  // ------------------------------------------------------------------------------------------------ viewer
  class LytroViewer {
    constructor(container, source, settings, opts = {}) {
      this.src = source; this.set = settings; this.opts = opts;
      this.el = document.createElement("div"); this.el.className = "lv-cell";
      this.cv = document.createElement("canvas"); this.el.appendChild(this.cv);
      this.lab = document.createElement("div"); this.lab.className = "lv-lab"; this.lab.textContent = source.label; this.el.appendChild(this.lab);
      this.wait = document.createElement("div"); this.wait.className = "lv-wait"; this.wait.textContent = "chargement…"; this.el.appendChild(this.wait);
      this.ring = document.createElement("div"); this.ring.className = "lv-ring"; this.el.appendChild(this.ring);
      container.appendChild(this.el);
      this.px = 0; this.py = 0; this.vx = 0; this.vy = 0; this.tx = 0; this.ty = 0;   // parallaxe (px de pile), vitesse, cible
      this.focus = 0.7; this.fFrom = 0.7; this.fTo = 0.7; this.fT = 1; this.ap = 0; this.apTo = 0;
      this.active = false; this.dirty = true; this.accum = 0; this.stats = { frames: 0, gpuMs: [] };
      this.K = [1, 0, 1, 0];                 // gain / decalage du recalage, x puis y (mesures au chargement)
      this.ready = this.init().catch(e => { this.wait.textContent = "erreur : " + e.message; console.error(e); throw e; });
    }

    async init() {
      const meta = JSON.parse(await (await this.src.blob("meta.json")).text());
      this.meta = meta; this.L = lattice(meta);
      const L = this.L;
      this.px = this.tx = L.sx[L.cc]; this.py = this.ty = L.sy[L.cr];
      this.cv.width = meta.w; this.cv.height = meta.h;
      this.el.style.aspectRatio = meta.w + " / " + meta.h;
      this.el.style.touchAction = L.rows > 1 ? "none" : "pan-y";     // glisser vertical = perspective si la pile en a
      this.blobs = new Map(); this.depthCpu = new Map(); this.tiles = new Map();
      this.sizeCanvas();
      this.initGL();
      this.bind();
      this.slots = new Map();                // fichier -> couche de texture
      this.loaded = new Set();
      await this.loadView(L.file(L.cc, L.cr), true);                // la photo d'abord
      this.wait.remove();
      this.initialFocus();
      this.dirty = true;
      this.opts.onReady && this.opts.onReady(this);
      this.extend();                          // puis les vues voisines, du centre vers les bouts
    }

    sizeCanvas() {
      const r = this.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      const w = Math.max(64, Math.min(this.meta.w, Math.round((r.width || this.meta.w) * dpr)));
      const h = Math.round(w * this.meta.h / this.meta.w);
      if (w !== this.cv.width || h !== this.cv.height || !this.cw) { this.cv.width = w; this.cv.height = h; this.cw = w; this.ch = h; return true; }
      return false;
    }

    // ------------------------------------------------------------------ GL
    initGL() {
      const attrs = { antialias: false, premultipliedAlpha: false, alpha: false, preserveDrawingBuffer: !!this.opts.preserve };
      let gl = this.opts.forceWebGL1 ? null : this.cv.getContext("webgl2", attrs);
      this.gl2 = !!gl;
      if (!gl) gl = this.cv.getContext("webgl", attrs) || this.cv.getContext("experimental-webgl", attrs);
      if (!gl) throw new Error("WebGL indisponible");
      this.gl = gl;
      this.cv.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; this.lab.textContent = this.src.label + " · contexte WebGL perdu (recharger)"; });
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
        if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const prog = (vs, fs, names) => {
        const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
        gl.bindAttribLocation(p, 0, "p"); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const U = {}; for (const n of names) U[n] = gl.getUniformLocation(p, n);
        return { p, U };
      };
      this.pSynth = prog(this.gl2 ? VS2 : VS1, synthFS(this.gl2),
        ["uC", "uD", "uL", "uC0", "uC1", "uC2", "uC3", "uD0", "uD1", "uD2", "uD3", "uW", "uOff", "uInvW", "uK", "uNF", "uWarp"]);
      this.pBlur = prog(VSGL, BLUR_FS, ["uS", "uT", "uPx", "uTiles", "uFocus", "uBand", "uAp", "uMaxR", "uRot", "uN"]);
      this.pCopy = prog(VSGL, COPY_FS, ["uS", "uMode", "uFocus", "uBand"]);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      // taille des textures de vues : celle du canevas (pas plus que la pile) : au repos, un texel par pixel
      this.tw = Math.min(this.meta.w, this.cw); this.th = Math.round(this.tw * this.meta.h / this.meta.w);
      this.dw = Math.max(1, Math.round(this.tw / 2)); this.dh = Math.max(1, Math.round(this.th / 2));
      this.ntx = Math.ceil(this.meta.w / TILE); this.nty = Math.ceil(this.meta.h / TILE);
      this.tileTex = this.mkTex(this.ntx, this.nty, gl.NEAREST);
      this.tileBuf = new Uint8Array(this.ntx * this.nty * 4);
      this.makeTargets();
      this.timer = this.gl2 && gl.getExtension("EXT_disjoint_timer_query_webgl2");
      this.queries = [];
    }

    mkTex(w, h, filt) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return t;
    }

    makeTargets() {                          // vue synthetisee + accumulation, a la taille du canevas
      const gl = this.gl;
      for (const t of this.targets || []) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      this.targets = [0, 1].map(() => {
        const tex = this.mkTex(this.cw, this.ch, gl.LINEAR), fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return { tex, fb };
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // couches de texture : WebGL2 = deux TEXTURE_2D_ARRAY (couleur RGBA8, disparite R8) agrandis a la demande ;
    // WebGL1 = deux textures par vue
    ensureCapacity(n) {
      const gl = this.gl;
      if (!this.gl2 || (this.cap && this.cap >= n)) return;
      const cap = Math.max(n, Math.ceil((this.cap || 0) * 1.5));
      const mk = (fmt, w, h) => {
        const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, fmt, w, h, cap); return t;
      };
      const nc = mk(gl.RGBA8, this.tw, this.th), nd = mk(gl.R8, this.dw, this.dh);
      if (this.cap) {                         // recopie des couches deja chargees (sans redecoder les images)
        const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
        for (let k = 0; k < this.used; k++) {
          for (const [src, dst, w, h] of [[this.arrC, nc, this.tw, this.th], [this.arrD, nd, this.dw, this.dh]]) {
            gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, src, 0, k);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, dst); gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, 0, 0, w, h);
          }
        }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
        gl.deleteTexture(this.arrC); gl.deleteTexture(this.arrD);
      }
      this.arrC = nc; this.arrD = nd; this.cap = cap; this.used = this.used || 0;
    }

    async loadView(k, first) {
      if (this.loaded.has(k) || this.loading?.has(k)) return;
      (this.loading = this.loading || new Set()).add(k);
      const L = this.L;
      const [bc, bd] = await Promise.all([this.src.blob(L.name(k, "v")), this.src.blob(L.name(k, "d"))]);
      const [ic, id] = await Promise.all([
        createImageBitmap(bc, { resizeWidth: this.tw, resizeHeight: this.th, resizeQuality: "high" }),
        createImageBitmap(bd, { resizeWidth: this.dw, resizeHeight: this.dh, resizeQuality: "medium" })]);
      // disparite cote processeur (mise au point au clic, tuiles, mesure du recalage), a la resolution du fichier
      const idf = await createImageBitmap(bd);
      const c = document.createElement("canvas"); c.width = idf.width; c.height = idf.height;
      const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(idf, 0, 0); idf.close();
      const px = x.getImageData(0, 0, c.width, c.height).data, g = new Uint8Array(c.width * c.height);
      for (let i = 0; i < g.length; i++) g[i] = px[4 * i];
      this.depthCpu.set(k, { data: g, w: c.width, h: c.height });
      this.tiles.set(k, this.tileMinMax(g, c.width, c.height));
      if (this.lost) return;
      const gl = this.gl;
      if (this.gl2) {
        this.ensureCapacity((this.used || 0) + 1);
        const layer = this.used++;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.arrC); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, this.tw, this.th, 1, gl.RGBA, gl.UNSIGNED_BYTE, ic);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.arrD); gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, this.dw, this.dh, 1, gl.RED, gl.UNSIGNED_BYTE, id);
        this.slots.set(k, layer);
      } else {
        const up = (img, fmt) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D, 0, fmt, fmt, gl.UNSIGNED_BYTE, img); return t; };
        this.slots.set(k, { c: up(ic, gl.RGBA), d: up(id, gl.LUMINANCE) });
      }
      ic.close(); id.close();
      this.loading.delete(k); this.loaded.add(k);
      this.updateBounds(); this.dirty = true;
    }

    tileMinMax(g, w, h) {                     // min / max de disparite par tuile de TILE px de la pile
      const out = new Uint8Array(this.ntx * this.nty * 2), f = w / this.meta.w;
      for (let ty = 0; ty < this.nty; ty++) for (let tx = 0; tx < this.ntx; tx++) {
        const x0 = Math.floor(tx * TILE * f), x1 = Math.min(w, Math.ceil((tx + 1) * TILE * f));
        const y0 = Math.floor(ty * TILE * f), y1 = Math.min(h, Math.ceil((ty + 1) * TILE * f));
        let lo = 255, hi = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const d = g[y * w + x]; if (d < lo) lo = d; if (d > hi) hi = d; }
        const o = 2 * (ty * this.ntx + tx); out[o] = lo; out[o + 1] = hi;
      }
      return out;
    }

    // vues a charger pour le relief courant (rangees du centre vers les bouts), puis chargement 4 par 4
    wanted() {
      const L = this.L, reach = this.set.relief / 100 * this.meta.w + 0.01;
      const ci = pickAxis(L.sx, L.cc, reach, this.set.minGap), cj = pickAxis(L.sy, L.cr, reach, this.set.minGap);
      this.pickI = ci; this.pickJ = cj;
      const list = [];
      for (const j of cj) for (const i of ci) list.push({ k: L.file(i, j), d: Math.hypot(L.sx[i] - L.sx[L.cc], L.sy[j] - L.sy[L.cr]) });
      return list.sort((a, b) => a.d - b.d).map(o => o.k);
    }
    async extend() {
      const todo = this.wanted().filter(k => !this.loaded.has(k));
      this.updateBounds();
      const run = async () => { while (todo.length) { await this.loadView(todo.shift()); } };
      await Promise.all([run(), run(), run(), run()]);
      this.updateBounds(); this.dirty = true;
      if (!this.calibrated) { this.calibrated = true; setTimeout(() => this.calibrate(), 30); }
      this.opts.onLoaded && this.opts.onLoaded(this);
    }
    // course autorisee : le plus grand rectangle de vues retenues entierement charge autour du centre
    updateBounds() {
      const L = this.L, ci = this.pickI || [L.cc], cj = this.pickJ || [L.cr];
      const has = (i, j) => this.loaded.has(L.file(i, j));
      let a = ci.indexOf(L.cc), b = a, c = cj.indexOf(L.cr), d = c;
      for (let grown = true; grown;) {
        grown = false;
        const rows = cj.slice(c, d + 1), cols = () => ci.slice(a, b + 1);
        if (a > 0 && rows.every(j => has(ci[a - 1], j))) { a--; grown = true; }
        if (b < ci.length - 1 && rows.every(j => has(ci[b + 1], j))) { b++; grown = true; }
        if (c > 0 && cols().every(i => has(i, cj[c - 1]))) { c--; grown = true; }
        if (d < cj.length - 1 && cols().every(i => has(i, cj[d + 1]))) { d++; grown = true; }
      }
      this.useI = ci.slice(a, b + 1); this.useJ = cj.slice(c, d + 1);
    }

    initialFocus() {                          // le sujet : les 20 % les plus proches de la photo
      const d = this.depthCpu.get(this.L.file(this.L.cc, this.L.cr)), arr = Array.from(d.data).sort((a, b) => a - b);
      this.focus = this.fFrom = this.fTo = arr[Math.floor(arr.length * 0.8)] / 255;
      this.nearFar = [arr[Math.floor(arr.length * 0.85)] / 255, arr[Math.floor(arr.length * 0.15)] / 255];
      if (this.nearFar[0] - this.nearFar[1] < 0.05) this.nearFar = [this.nearFar[1] + 0.05, this.nearFar[1]];
    }

    // Mesure du recalage (gain k et decalage c, par axe) : flot global de Lucas-Kanade entre vues voisines reelles,
    // modele « decalage = ecart de parallaxe * (k g + c) », 3 iterations, mediane sur quelques paires pres du centre.
    // meta.warp {kx, cx, ky, cy} prend le pas s'il est fourni.
    async calibrate() {
      const m = this.meta.warp;
      if (m) { this.K = [m.kx ?? 1, m.cx ?? 0, m.ky ?? 1, m.cy ?? 0]; this.dirty = true; return; }
      const L = this.L, t0 = performance.now(), res = { x: [], y: [] };
      const lumCache = new Map();
      const lum = async (k) => {
        if (lumCache.has(k)) return lumCache.get(k);
        const W = 256, H = Math.round(W * this.meta.h / this.meta.w);
        const bm = await createImageBitmap(await this.src.blob(L.name(k, "v")), { resizeWidth: W, resizeHeight: H, resizeQuality: "medium" });
        const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d", { willReadFrequently: true });
        x.filter = "blur(1px)"; x.drawImage(bm, 0, 0); bm.close();
        const p = x.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
        for (let i = 0; i < g.length; i++) g[i] = 0.299 * p[4 * i] + 0.587 * p[4 * i + 1] + 0.114 * p[4 * i + 2];
        const o = { g, W, H }; lumCache.set(k, o); return o;
      };
      const pairs = [];
      const along = (arr, c, mk) => { for (const dir of [-1, 1]) { let n = 0;
        for (let a = arr.indexOf(c); n < 3 && a + dir >= 0 && a + dir < arr.length; a += dir, n++) pairs.push(mk(arr[a], arr[a + dir])); } };
      if (this.useI.length > 1) along(this.useI, L.cc, (a, b) => ({ ax: "x", ka: L.file(a, L.cr), kb: L.file(b, L.cr), dl: L.sx[b] - L.sx[a] }));
      if (this.useJ.length > 1) along(this.useJ, L.cr, (a, b) => ({ ax: "y", ka: L.file(L.cc, a), kb: L.file(L.cc, b), dl: L.sy[b] - L.sy[a] }));
      const [dN, dF] = this.nearFar;
      for (const p of pairs) {
        const A = await lum(p.ka), B = await lum(p.kb), W = A.W, H = A.H, f = W / this.meta.w, dl = p.dl * f;
        if (Math.abs(dl) < 0.15) continue;
        const da = this.depthCpu.get(p.ka), db = this.depthCpu.get(p.kb);
        const G = new Float32Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const sx = Math.min(da.w - 1, Math.floor(x * da.w / W)), sy = Math.min(da.h - 1, Math.floor(y * da.h / H));
          G[y * W + x] = ((dN - (da.data[sy * da.w + sx] + db.data[sy * db.w + sx]) / 510) / (dN - dF));
        }
        let k = 0, c = 0;
        for (let it = 0; it < 3; it++) {
          let s11 = 0, s12 = 0, s22 = 0, b1 = 0, b2 = 0;
          for (let y = 8; y < H - 8; y++) for (let x = 8; x < W - 8; x++) {
            const i = y * W + x, sh = dl * (k * G[i] + c);
            // A recale : A(x - sh) (bilineaire sur l'axe)
            const fx = p.ax === "x" ? x - sh : x, fy = p.ax === "y" ? y - sh : y;
            const x0 = Math.floor(fx), y0 = Math.floor(fy), ux = fx - x0, uy = fy - y0;
            if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) continue;
            const j = y0 * W + x0;
            const aw = (A.g[j] * (1 - ux) + A.g[j + 1] * ux) * (1 - uy) + (A.g[j + W] * (1 - ux) + A.g[j + W + 1] * ux) * uy;
            const gr = p.ax === "x" ? (B.g[i + 1] - B.g[i - 1]) * 0.5 : (B.g[i + W] - B.g[i - W]) * 0.5;
            const it_ = B.g[i] - aw, x1 = -gr * dl * G[i], x2 = -gr * dl;
            s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2; b1 += x1 * it_; b2 += x2 * it_;
          }
          const det = s11 * s22 - s12 * s12;
          if (Math.abs(det) < 1e-9) break;
          k += (s22 * b1 - s12 * b2) / det; c += (s11 * b2 - s12 * b1) / det;
        }
        if (isFinite(k) && isFinite(c)) res[p.ax].push([k, c]);
        await new Promise(r => setTimeout(r, 0));          // laisse respirer l'animation
      }
      const med = (a, i, dflt) => { if (!a.length) return dflt; const v = a.map(x => x[i]).sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
      const clampK = (v) => Math.max(0, Math.min(4, v));
      this.K = [clampK(med(res.x, 0, 1)), Math.max(-1, Math.min(1, med(res.x, 1, 0))), clampK(med(res.y, 0, 1)), Math.max(-1, Math.min(1, med(res.y, 1, 0)))];
      this.calibMs = Math.round(performance.now() - t0);
      this.dirty = true;
      this.opts.onCalibrated && this.opts.onCalibrated(this);
    }

    // ------------------------------------------------------------------ position -> vues
    // cellule du treillis (parmi les vues chargees) qui contient la parallaxe p, et fraction
    locate(arr, s, p) {
      if (arr.length === 1) return [arr[0], arr[0], 0];
      if (p <= s[arr[0]]) return [arr[0], arr[1], 0];
      for (let n = 0; n < arr.length - 1; n++) {
        const a = arr[n], b = arr[n + 1];
        if (p <= s[b]) return [a, b, (p - s[a]) / (s[b] - s[a])];
      }
      const z = arr.length - 1; return [arr[z - 1], arr[z], 1];
    }
    // souris (-1..1 par axe) -> parallaxe voulue, bornee par les vues chargees et le relief
    target(nx, ny) {
      const L = this.L, A = this.set.relief / 100 * this.meta.w;
      const ax = (arr, s, c, n) => {
        if (arr.length < 2) return s[c];
        const lo = Math.min(A, s[c] - s[arr[0]]), hi = Math.min(A, s[arr[arr.length - 1]] - s[c]);
        return s[c] + (n < 0 ? n * lo : n * hi);
      };
      return [ax(this.useI, L.sx, L.cc, nx), ax(this.useJ, L.sy, L.cr, ny)];
    }
    nearestPure() {                           // la vue reelle chargee la plus proche (pour s'y poser)
      const L = this.L, best = (arr, s, p) => arr.reduce((b, i) => Math.abs(s[i] - p) < Math.abs(s[b] - p) ? i : b, arr[0]);
      return [L.sx[best(this.useI, L.sx, this.tx)], L.sy[best(this.useJ, L.sy, this.ty)]];
    }

    // ------------------------------------------------------------------ dessin
    draw() {
      if (!this.meta || this.lost || !this.loaded.size) return;
      const gl = this.gl, L = this.L, S = this.set;
      if (this.timer && !this.qActive) { const q = gl.createQuery(); gl.beginQuery(this.timer.TIME_ELAPSED_EXT, q); this.qActive = q; }
      const [i0, i1, tx] = this.locate(this.useI, L.sx, this.px), [j0, j1, ty] = this.locate(this.useJ, L.sy, this.py);
      const views = [[i0, j0], [i1, j0], [i0, j1], [i1, j1]];
      const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
      const ks = views.map(([i, j]) => L.file(i, j));
      // pass 1 : synthese -> cible 0
      const P = this.pSynth; gl.useProgram(P.p);
      if (this.gl2) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.arrC); gl.uniform1i(P.U.uC, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.arrD); gl.uniform1i(P.U.uD, 1);
        gl.uniform4f(P.U.uL, ...ks.map(k => this.slots.get(k)));
      } else {
        ks.forEach((k, n) => {
          const sl = this.slots.get(k);
          gl.activeTexture(gl.TEXTURE0 + n); gl.bindTexture(gl.TEXTURE_2D, sl.c); gl.uniform1i(P.U["uC" + n], n);
          gl.activeTexture(gl.TEXTURE4 + n); gl.bindTexture(gl.TEXTURE_2D, sl.d); gl.uniform1i(P.U["uD" + n], 4 + n);
        });
      }
      gl.uniform4f(P.U.uW, ...w);
      const off = []; for (const [i, j] of views) off.push(this.px - L.sx[i], this.py - L.sy[j]);
      gl.uniform2fv(P.U.uOff, new Float32Array(off));
      gl.uniform2f(P.U.uInvW, 1 / this.meta.w, 1 / this.meta.h);
      gl.uniform4f(P.U.uK, ...this.K); gl.uniform2f(P.U.uNF, this.nearFar[0], this.nearFar[1]);
      gl.uniform1f(P.U.uWarp, S.warp ? 1 : 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0].fb); gl.viewport(0, 0, this.cw, this.ch);
      gl.disable(gl.BLEND); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // pass 2 : mise au point -> cible 1 (accumulee au repos)
      const scale = this.cw / this.meta.w;
      const maxR = S.allSharp || S.showDepth ? 0 : 18 * S.blur * this.ap * scale;
      let shown = this.targets[0];
      if (maxR >= 0.5) {
        this.uploadTiles(ks, w);
        const B = this.pBlur; gl.useProgram(B.p);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.targets[0].tex); gl.uniform1i(B.U.uS, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tileTex); gl.uniform1i(B.U.uT, 1);
        gl.uniform2f(B.U.uPx, 1 / this.cw, 1 / this.ch); gl.uniform2f(B.U.uTiles, this.ntx, this.nty);
        gl.uniform1f(B.U.uFocus, this.focus); gl.uniform1f(B.U.uBand, S.band);
        gl.uniform1f(B.U.uAp, maxR * 3); gl.uniform1f(B.U.uMaxR, maxR);
        const k = this.accum;
        gl.uniform1f(B.U.uRot, k * 0.61803 * 2.39996323 + (k ? 0.37 : 0));
        gl.uniform1f(B.U.uN, this.moving ? MAX_SAMPLES / 2 : MAX_SAMPLES);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[1].fb);
        if (k > 0) { gl.enable(gl.BLEND); gl.blendColor(0, 0, 0, 1 / (k + 1)); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA); }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.disable(gl.BLEND);
        shown = this.targets[1];
      }
      // pass 3 : a l'ecran
      const C = this.pCopy; gl.useProgram(C.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shown.tex); gl.uniform1i(C.U.uS, 0);
      gl.uniform1f(C.U.uMode, S.showDepth ? 1 : 0); gl.uniform1f(C.U.uFocus, this.focus); gl.uniform1f(C.U.uBand, S.band);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.cw, this.ch);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (this.qActive) { gl.endQuery(this.timer.TIME_ELAPSED_EXT); this.queries.push(this.qActive); this.qActive = null; }
      this.pollQueries();
      this.stats.frames++;
      this.lastViews = ks; this.lastW = w;
    }

    uploadTiles(ks, w) {                     // tuiles des vues du fondu reunies (min des min, max des max)
      const key = ks.map((k, n) => w[n] > 0 ? k : -1).join(",");
      if (key === this.tileKey) return;
      this.tileKey = key;
      const b = this.tileBuf, used = ks.filter((k, n) => w[n] > 0).map(k => this.tiles.get(k));
      for (let t = 0; t < this.ntx * this.nty; t++) {
        let lo = 255, hi = 0;
        for (const tl of used) { if (tl[2 * t] < lo) lo = tl[2 * t]; if (tl[2 * t + 1] > hi) hi = tl[2 * t + 1]; }
        b[4 * t] = lo; b[4 * t + 1] = hi; b[4 * t + 2] = 0; b[4 * t + 3] = 255;
      }
      const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.ntx, this.nty, gl.RGBA, gl.UNSIGNED_BYTE, b);
    }

    pollQueries() {
      const gl = this.gl;
      if (!this.timer || !this.queries.length) return;
      if (gl.getParameter(this.timer.GPU_DISJOINT_EXT)) { this.queries.forEach(q => gl.deleteQuery(q)); this.queries = []; return; }
      while (this.queries.length && gl.getQueryParameter(this.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = this.queries.shift();
        this.stats.gpuMs.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q);
        if (this.stats.gpuMs.length > 120) this.stats.gpuMs.shift();
      }
    }

    // memoire GPU de la case (estimee : textures allouees, sans les tampons du navigateur)
    gpuBytes() {
      if (!this.gl) return 0;
      const views = this.gl2 ? (this.cap || 0) : this.loaded.size;
      return views * (this.tw * this.th * 4 + this.dw * this.dh * (this.gl2 ? 1 : 4))
        + 2 * this.cw * this.ch * 4 + this.ntx * this.nty * 4 + this.cw * this.ch * 4;    // cibles + tuiles + ecran
    }

    // ------------------------------------------------------------------ interaction
    bind() {
      const cv = this.cv;
      let down = null;
      const norm = (e) => {
        const r = cv.getBoundingClientRect();
        let nx = ((e.clientX - r.left) / r.width) * 2 - 1, ny = 1 - ((e.clientY - r.top) / r.height) * 2;
        if (e.pointerType === "touch" && down) {               // doigt : une demi-largeur parcourt tout l'arc
          nx = (e.clientX - down.x) / (0.5 * r.width); ny = -(e.clientY - down.y) / (0.5 * r.height);
        }
        return [nx, ny];
      };
      cv.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") { this.active = true; this.aim(...norm(e)); } });
      cv.addEventListener("pointermove", (e) => { if (e.pointerType !== "touch" || down) this.aim(...norm(e)); });
      cv.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") { this.active = false; this.home(); } });
      cv.addEventListener("dblclick", () => { this.apTo = 0; });
      cv.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; if (e.pointerType === "touch") this.active = true; });
      cv.addEventListener("pointercancel", () => { down = null; this.active = false; this.home(); });     // le navigateur fait defiler
      cv.addEventListener("pointerup", (e) => {
        const moved = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8; down = null;
        if (e.pointerType === "touch") { this.active = false; clearTimeout(this.homeT); this.homeT = setTimeout(() => this.home(), 1200); }
        if (!moved && this.meta) {
          const r = cv.getBoundingClientRect();
          this.focusAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
        }
      });
    }
    // (-1..1, -1..1) -> cible, avec zone morte au centre (la photo exacte) sans saut a sa sortie
    aim(nx, ny) {
      if (!this.meta) return;
      const dz = (n) => { n = Math.max(-1, Math.min(1, n / 0.85)); return Math.abs(n) < 0.06 ? 0 : Math.sign(n) * (Math.abs(n) - 0.06) / 0.94; };
      [this.tx, this.ty] = this.target(dz(nx), dz(ny));
      this.movedAt = performance.now(); this.snapped = false;
    }
    home() { if (this.meta) { this.tx = this.L.sx[this.L.cc]; this.ty = this.L.sy[this.L.cr]; this.movedAt = performance.now(); } }

    focusAt(fx, fy) {                         // mise au point : disparite mediane 5x5 sous le doigt, vue courante
      const L = this.L;
      const [i0, i1, tx] = this.locate(this.useI, L.sx, this.px), [j0, j1, ty] = this.locate(this.useJ, L.sy, this.py);
      const d = this.depthCpu.get(L.file(tx < 0.5 ? i0 : i1, ty < 0.5 ? j0 : j1));
      const xs = Math.round(fx * (d.w - 1)), ys = Math.round(fy * (d.h - 1)), vals = [];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = Math.max(0, Math.min(d.w - 1, xs + dx)), y = Math.max(0, Math.min(d.h - 1, ys + dy)); vals.push(d.data[y * d.w + x]);
      }
      vals.sort((a, b) => a - b);
      const f = vals[12] / 255;
      if (this.ap < 0.02) { this.focus = this.fFrom = this.fTo = f; this.fT = 1; }   // premier clic : le flou monte
      else { this.fFrom = this.focus; this.fTo = f; this.fT = 0; }                 // ensuite : la mise au point glisse
      this.apTo = 1;
      this.ring.style.left = (fx * 100) + "%"; this.ring.style.top = (fy * 100) + "%";
      this.ring.classList.remove("on"); void this.ring.offsetWidth; this.ring.classList.add("on");
      clearTimeout(this.ringT); this.ringT = setTimeout(() => this.ring.classList.remove("on"), 450);
    }

    // ------------------------------------------------------------------ animation (appelee a chaque image)
    tick(dt, now) {
      if (!this.meta || !this.loaded.size || this.lost) return;
      const S = this.set;
      let changed = false;
      if (this.hint != null && !this.active) {             // balancement d'accueil : 0 -> +0,7 -> -0,7 -> 0 en 1,8 s
        this.hint += dt; const h = this.hint / 1.8;
        [this.tx, this.ty] = this.target(h >= 1 ? 0 : 0.7 * Math.sin(2 * Math.PI * h), 0);
        if (h >= 1) this.hint = null;
      } else if (!this.active && S.gyro && this.gyroN) {
        [this.tx, this.ty] = this.target(...this.gyroN);
      } else if (!this.active && S.idle) {                 // oscillation lente au repos
        this.idleT = (this.idleT || Math.random() * 10) + dt;
        [this.tx, this.ty] = this.target(0.6 * Math.sin(this.idleT * 0.9), this.L.rows > 1 ? 0.5 * Math.sin(this.idleT * 0.63) : 0);
      }
      // immobile 150 ms : on se pose sur la vue reelle la plus proche
      if (S.snap && this.active && !this.snapped && this.movedAt && now - this.movedAt > 150) {
        [this.tx, this.ty] = this.nearestPure(); this.snapped = true;
      }
      const w = 11, step = (p, v, t) => { const a = w * w * (t - p) - 2 * w * v; v += a * dt; return [p + v * dt, v]; };
      [this.px, this.vx] = step(this.px, this.vx, this.tx); [this.py, this.vy] = step(this.py, this.vy, this.ty);
      const still = Math.abs(this.tx - this.px) < 2e-3 && Math.abs(this.ty - this.py) < 2e-3 && Math.abs(this.vx) + Math.abs(this.vy) < 2e-3;
      if (still) { if (this.px !== this.tx || this.py !== this.ty) changed = true; this.px = this.tx; this.py = this.ty; this.vx = this.vy = 0; }
      else changed = true;
      if (Math.abs(this.apTo - this.ap) > 1e-3) { this.ap += Math.sign(this.apTo - this.ap) * Math.min(Math.abs(this.apTo - this.ap), dt / 0.45); changed = true; }
      else this.ap = this.apTo;
      if (this.fT < 1) { this.fT = Math.min(1, this.fT + dt / Math.max(0.01, S.focusTime)); const k = this.fT * this.fT * (3 - 2 * this.fT);
        this.focus = this.fFrom + (this.fTo - this.fFrom) * k; changed = true; }
      this.moving = changed;
      if (changed || this.dirty) { this.accum = 0; this.draw(); this.dirty = false; }
      else if (this.accum < 3 && this.ap > 0 && !S.allSharp && !S.showDepth) { this.accum++; this.draw(); }   // 4 images accumulees au repos
    }

    resize() {
      if (!this.meta || !this.gl) return;
      if (this.sizeCanvas()) {
        this.makeTargets();
        if (this.cw > this.tw * 1.3 && this.tw < this.meta.w) this.lab.textContent = this.src.label + " · agrandie : recharger pour la pleine définition";
        this.dirty = true;
      }
    }

    // etat impose puis rendu immediat (essais automatiques) : parallaxe en px de pile, mise au point 0-1
    snap(px, py, focus) {
      this.px = this.tx = px; this.py = this.ty = py; this.vx = this.vy = 0; this.hint = null;
      if (focus != null) { this.focus = this.fFrom = this.fTo = focus; this.fT = 1; this.ap = this.apTo = 1; }
      else { this.ap = this.apTo = 0; }
      this.accum = 0; this.draw(); return true;
    }
  }

  // ------------------------------------------------------------------------------------------------ boucle
  const viewers = new Set();
  let last = 0, running = false;
  function loop(now) {
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    for (const v of viewers) v.tick(dt, now);
    requestAnimationFrame(loop);
  }
  function add(container, source, settings, opts) {
    const v = new LytroViewer(container, source, settings, opts);
    viewers.add(v);
    if (!running) { running = true; requestAnimationFrame(loop); }
    // balancement d'accueil la premiere fois que la case est visible
    v.ready.then(() => {
      const io = new IntersectionObserver((ents) => { if (ents.some(x => x.isIntersecting)) { io.disconnect(); if (!opts?.noHint) v.hint = 0; } });
      io.observe(v.el);
    }).catch(() => {});
    return v;
  }
  function remove(v) {
    viewers.delete(v);
    const ext = v.gl && v.gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext();
    v.el.remove();
  }
  window.addEventListener("resize", () => viewers.forEach(v => v.resize()));

  // gyroscope : inclinaison relative a la position au moment de l'activation, +-15 degres = tout l'arc
  let gyroBase = null;
  async function enableGyro(on) {
    if (!on) { window.removeEventListener("deviceorientation", onOrient); gyroBase = null; viewers.forEach(v => { v.gyroN = null; }); return true; }
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      try { if (await DeviceOrientationEvent.requestPermission() !== "granted") return false; } catch (e) { return false; }
    }
    window.addEventListener("deviceorientation", onOrient);
    return true;
  }
  function onOrient(e) {
    if (e.gamma == null) return;
    if (!gyroBase) gyroBase = [e.gamma, e.beta];
    const n = [Math.max(-1, Math.min(1, (e.gamma - gyroBase[0]) / 15)), Math.max(-1, Math.min(1, -(e.beta - gyroBase[1]) / 15))];
    viewers.forEach(v => { v.gyroN = n; });
  }

  window.LytroViewer = { add, remove, viewers, defaults, UrlSource, MapSource, stacksFromDrop, stacksFromFileList, lattice, pickAxis, enableGyro };
})();
