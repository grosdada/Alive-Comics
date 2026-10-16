/* Lecture d'un zip dans le navigateur, sans dependance : repertoire central, puis chaque fichier a la demande
   (stocke, ou « deflate » decompresse par DecompressionStream). Pas de zip64 ni de chiffrement. */
(function () {
  "use strict";

  async function readZip(blob) {
    const tailLen = Math.min(blob.size, 65557);
    const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("zip illisible (fin du repertoire introuvable)");
    const count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
    if (cdOff === 0xffffffff || count === 0xffff) throw new Error("zip64 non pris en charge");
    const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    const files = new Map();
    let p = 0;
    for (let k = 0; k < count; k++) {
      if (cd.getUint32(p, true) !== 0x02014b50) throw new Error("zip abime (repertoire central)");
      const flags = cd.getUint16(p + 8, true), method = cd.getUint16(p + 10, true);
      const csize = cd.getUint32(p + 20, true), nlen = cd.getUint16(p + 28, true);
      const xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true), off = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith("/") || flags & 1) continue;         // dossier, ou fichier chiffre
      files.set(name, () => entry(blob, off, csize, method));
    }
    return files;                                            // nom -> () => Promise<Blob>
  }

  async function entry(blob, off, csize, method) {
    const h = new DataView(await blob.slice(off, off + 30).arrayBuffer());
    const start = off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    const raw = blob.slice(start, start + csize);
    if (method === 0) return raw;
    if (method !== 8) throw new Error("methode de compression " + method + " non prise en charge");
    if (typeof DecompressionStream === "undefined") throw new Error("ce navigateur ne sait pas decompresser (DecompressionStream)");
    return new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
  }

  window.LytroZip = { readZip };
})();
