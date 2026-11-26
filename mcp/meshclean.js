"use strict";
// Simple GLB mesh clean-up: remove loose floating pieces and fill small holes.
// Only index buffers change: vertices, UVs, skin weights and morph targets stay as they are,
// so rigs keep working. New triangles reuse existing vertices around the hole.

const fs = require("fs");

const COMP = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("Not a GLB file");
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.toString("utf-8", 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;
  const binLen = buf.length >= binStart ? buf.readUInt32LE(20 + jsonLen) : 0;
  return { gltf, bin: Buffer.from(buf.subarray(binStart, binStart + binLen)) };
}

function writeGlb(file, gltf, bin) {
  const pad = (4 - (bin.length % 4)) % 4;
  if (pad) bin = Buffer.concat([bin, Buffer.alloc(pad)]);
  if (gltf.buffers?.[0]) gltf.buffers[0].byteLength = bin.length;
  let json = Buffer.from(JSON.stringify(gltf), "utf-8");
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([header, jh, json, bh, bin]));
}

function readAccessor(gltf, bin, index) {
  const acc = gltf.accessors[index];
  const [Type, bytes] = COMP[acc.componentType];
  const n = SIZE[acc.type];
  const out = new (acc.componentType === 5126 ? Float32Array : Uint32Array)(acc.count * n);
  if (acc.bufferView === undefined) return out;
  const bv = gltf.bufferViews[acc.bufferView];
  const stride = bv.byteStride || bytes * n;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const get = { 5120: "getInt8", 5121: "getUint8", 5122: "getInt16", 5123: "getUint16", 5125: "getUint32", 5126: "getFloat32" }[acc.componentType];
  for (let i = 0; i < acc.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = view[get](base + i * stride + c * bytes, true);
  void Type;
  return out;
}

// ── World transforms so pieces from several meshes are measured in one space ──
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function local(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1];
}
function meshMatrices(gltf) {
  const found = new Map();
  const visit = (i, parent) => {
    const node = gltf.nodes[i];
    const m = mul(parent, local(node));
    if (node.mesh !== undefined && !found.has(node.mesh)) found.set(node.mesh, node.skin !== undefined ? null : m);
    for (const c of node.children || []) visit(c, m);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  for (const r of scene?.nodes || (gltf.nodes || []).map((_, i) => i)) visit(r, I);
  return found;
}

/** Every triangle primitive with world positions, welded vertex ids and triangles. */
function collect(gltf, bin) {
  const mats = meshMatrices(gltf);
  const prims = [];
  (gltf.meshes || []).forEach((mesh, mi) => mesh.primitives.forEach((prim, pi) => {
    if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) return;
    const local = readAccessor(gltf, bin, prim.attributes.POSITION);
    const m = mats.get(mi);
    const pos = new Float64Array(local.length);
    for (let i = 0; i < local.length; i += 3) {
      const [x, y, z] = [local[i], local[i + 1], local[i + 2]];
      if (!m) { pos[i] = x; pos[i + 1] = y; pos[i + 2] = z; continue; }
      pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    const idx = prim.indices !== undefined ? readAccessor(gltf, bin, prim.indices) : Uint32Array.from({ length: local.length / 3 }, (_, i) => i);
    prims.push({ mi, pi, prim, pos, idx: Array.from(idx.subarray(0, idx.length - (idx.length % 3))) });
  }));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p.pos[i + k]); max[k] = Math.max(max[k], p.pos[i + k]); }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  // Weld by position: UV seams split vertices but do not split the surface.
  const q = diag * 1e-5;
  for (const p of prims) {
    const keys = new Map();
    p.weld = new Int32Array(p.pos.length / 3);
    for (let v = 0; v < p.weld.length; v++) {
      const k = Math.round(p.pos[v * 3] / q) + "," + Math.round(p.pos[v * 3 + 1] / q) + "," + Math.round(p.pos[v * 3 + 2] / q);
      let w = keys.get(k);
      if (w === undefined) { w = keys.size; keys.set(k, w); }
      p.weld[v] = w;
    }
  }
  return { prims, diag, min, max };
}

function bboxOf(pos, verts) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const v of verts) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], pos[v * 3 + k]); b[k + 3] = Math.max(b[k + 3], pos[v * 3 + k]); }
  return b;
}
const bdiag = (b) => Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
const overlaps = (a, b, m) => a[0] <= b[3] + m && a[3] >= b[0] - m && a[1] <= b[4] + m && a[4] >= b[1] - m && a[2] <= b[5] + m && a[5] >= b[2] - m;

/** Connected pieces of every primitive. */
function pieces(data) {
  const out = [];
  for (const p of data.prims) {
    let top = 0; for (const w of p.weld) if (w > top) top = w;
    const parent = Int32Array.from({ length: top + 1 }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let t = 0; t < p.idx.length; t += 3) {
      const a = find(p.weld[p.idx[t]]), b = find(p.weld[p.idx[t + 1]]), c = find(p.weld[p.idx[t + 2]]);
      parent[b] = a; parent[find(c)] = a;
    }
    const groups = new Map();
    for (let t = 0; t < p.idx.length; t += 3) {
      const r = find(p.weld[p.idx[t]]);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(t);
    }
    p.pieceOf = new Map();
    for (const tris of groups.values()) {
      const verts = new Set(), welds = new Set();
      for (const t of tris) for (let k = 0; k < 3; k++) { verts.add(p.idx[t + k]); welds.add(p.weld[p.idx[t + k]]); }
      const box = bboxOf(p.pos, verts);
      const piece = { prim: p, tris, triangles: tris.length, box, size: bdiag(box), welds: welds.size };
      for (const w of welds) p.pieceOf.set(w, piece);
      out.push(piece);
    }
  }
  return out;
}

/** Decide which pieces are loose junk. */
function classifyPieces(data, list, { maxPercent = 2, inside = false } = {}) {
  const total = list.reduce((n, x) => n + x.triangles, 0) || 1;
  const limit = total * maxPercent / 100;
  const big = list.filter((x) => x.triangles > limit);
  if (!big.length && list.length) big.push(list.reduce((a, b) => (b.triangles > a.triangles ? b : a)));
  const margin = data.diag * 0.002;
  // Pieces whose boxes touch form one object (chair legs + seat). A cluster that holds no big
  // piece and is small in total is floating junk; anything touching a big piece stays.
  const parent = list.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  if (list.length <= 4000) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
      if (overlaps(list[i].box, list[j].box, margin)) parent[find(j)] = find(i);
  }
  const clusterTris = new Map(), clusterBig = new Set();
  list.forEach((x, i) => { const r = find(i); clusterTris.set(r, (clusterTris.get(r) || 0) + x.triangles); if (big.includes(x)) clusterBig.add(r); });
  list.forEach((x, i) => {
    const r = find(i);
    x.small = !big.includes(x);
    x.outside = !clusterBig.has(r) && clusterTris.get(r) <= limit;
    x.remove = x.small && (inside || x.outside);
  });
  // A mesh that falls apart into hundreds of bits is not "a model with some junk": leave it alone.
  const removing = list.reduce((n, x) => n + (x.remove ? x.triangles : 0), 0);
  list.fragmented = removing > total * 0.25;
  if (list.fragmented) list.forEach((x) => (x.remove = false));
  return list;
}

/** Open boundary loops (holes) of every primitive, in fill orientation. */
function holes(data, { maxEdges = 400 } = {}) {
  const out = [];
  for (const p of data.prims) {
    const count = new Map(); // undirected welded edge → uses
    const key = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
    for (let t = 0; t < p.idx.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = p.weld[p.idx[t + e]], b = p.weld[p.idx[t + (e + 1) % 3]];
      if (a === b) continue;
      const k = key(a, b); count.set(k, (count.get(k) || 0) + 1);
    }
    // Directed rim edges in fill orientation (b → a). A vertex may start several edges where two holes
    // touch ("pinched"); walking edge by edge and cutting off every closed cycle splits them into simple rims.
    const outgoing = new Map(), real = new Map();
    for (let t = 0; t < p.idx.length; t += 3) for (let e = 0; e < 3; e++) {
      const ra = p.idx[t + e], rb = p.idx[t + (e + 1) % 3];
      const a = p.weld[ra], b = p.weld[rb];
      if (a === b || count.get(key(a, b)) !== 1) continue;
      if (!outgoing.has(b)) outgoing.set(b, []);
      outgoing.get(b).push(a);
      if (!real.has(a)) real.set(a, ra);
      if (!real.has(b)) real.set(b, rb);
    }
    const emit = (loop) => {
      if (loop.length < 3 || loop.length > maxEdges) return;
      const verts = loop.map((w) => real.get(w));
      out.push({ prim: p, verts, welds: loop, edges: loop.length, size: bdiag(bboxOf(p.pos, verts)) });
    };
    for (const start of outgoing.keys()) {
      while (outgoing.get(start)?.length) {
        const pathV = [start], at = new Map([[start, 0]]);
        let cur = start;
        while (true) {
          const list = outgoing.get(cur);
          if (!list?.length) break; // open chain (should not happen on a valid rim): drop it
          const nxt = list.pop();
          if (at.has(nxt)) {
            const i = at.get(nxt);
            emit(pathV.slice(i));
            for (const w of pathV.slice(i + 1)) at.delete(w);
            pathV.length = i + 1;
            cur = nxt;
            if (pathV.length === 1 && !outgoing.get(cur)?.length) break;
            continue;
          }
          at.set(nxt, pathV.length); pathV.push(nxt); cur = nxt;
        }
      }
    }
  }
  return out;
}

/** Holes worth filling: small, on a piece that stays, and not the whole rim of a flat sheet. */
function fillable(data, loops, o) {
  return loops.filter((h) => {
    if (h.size > data.diag * o.holePercent / 100) return false;
    const piece = h.prim.pieceOf?.get(h.welds[0]);
    if (!piece || piece.remove) return false;
    return piece.welds > h.edges;
  });
}

/** Ear-clip a 3D loop projected on its own plane; falls back to a fan. */
/**
 * Ear-clip a hole rim projected on its own plane. A new diagonal must not already be a mesh edge
 * (that would make an edge with three faces); if no clean triangulation exists, returns null.
 */
function triangulate(pos, verts, welds, edges) {
  const ek = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
  const P = (v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
  const pts = verts.map(P);
  const n = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const ln = Math.hypot(...n) || 1; n.forEach((_, i) => (n[i] /= ln));
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const u = cross(ref, n), w = cross(n, u);
  const uv = pts.map((p) => [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * w[0] + p[1] * w[1] + p[2] * w[2]]);
  const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const idx = verts.map((_, i) => i), tris = [], newEdges = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = uv[ia], b = uv[ib], c = uv[ic];
      if (area2(a, b, c) <= 0) continue;
      const inside = idx.some((j) => j !== ia && j !== ib && j !== ic && area2(a, b, uv[j]) >= 0 && area2(b, c, uv[j]) >= 0 && area2(c, a, uv[j]) >= 0);
      if (inside) continue;
      const diag = ek(welds[ia], welds[ic]);
      if (welds[ia] === welds[ic] || (idx.length > 3 && edges.has(diag))) continue;
      tris.push(verts[ia], verts[ib], verts[ic]); newEdges.push(diag); idx.splice(i, 1); clipped = true; break;
    }
    if (!clipped) return null; // no clean way to close it: leave the hole open
  }
  if (idx.length !== 3) return null;
  tris.push(verts[idx[0]], verts[idx[1]], verts[idx[2]]);
  for (const e of newEdges) edges.add(e);
  return tris;
}

function options(o = {}) {
  return { highlight: !!o.highlight, maxPercent: Number(o.maxPercent ?? 2), inside: !!o.inside, holePercent: Number(o.holePercent ?? 5), maxEdges: Number(o.maxEdges ?? 400) };
}

/** What a clean-up would do, without writing anything. */
function analyzeGlb(file, opts) {
  const o = options(opts);
  const { gltf, bin } = readGlb(file);
  const data = collect(gltf, bin);
  const list = classifyPieces(data, pieces(data), o);
  const loops = holes(data, o);
  const small = fillable(data, loops, o);
  const gone = list.filter((x) => x.remove);
  return {
    triangles: list.reduce((n, x) => n + x.triangles, 0),
    pieces: list.length, fragmented: !!list.fragmented,
    loose: gone.length, looseTriangles: gone.reduce((n, x) => n + x.triangles, 0),
    smallInside: list.filter((x) => x.small && !x.outside).length,
    holes: loops.length, smallHoles: small.length, largestHole: loops.reduce((m, h) => Math.max(m, h.size / data.diag * 100), 0),
    holeSizes: small.map((h) => Math.round(h.size / data.diag * 1000) / 10),
  };
}

/** Write a cleaned copy. Returns counts. */
function cleanGlb(file, outFile, opts) {
  const o = options(opts);
  const { gltf, bin } = readGlb(file);
  const data = collect(gltf, bin);
  const list = classifyPieces(data, pieces(data), o);
  const drop = new Map(); // prim → Set(triangle start)
  for (const x of list) if (x.remove) { if (!drop.has(x.prim)) drop.set(x.prim, new Set()); x.tris.forEach((t) => drop.get(x.prim).add(t)); }
  const fills = new Map();
  let filled = 0, skippedHoles = 0;
  if (o.holePercent > 0) for (const h of fillable(data, holes(data, o), o)) {
    if (!h.prim.edgeSet) {
      h.prim.edgeSet = new Set();
      const w = h.prim.weld, ix = h.prim.idx;
      for (let t = 0; t < ix.length; t += 3) for (let e = 0; e < 3; e++) { const a = w[ix[t + e]], b = w[ix[t + (e + 1) % 3]]; h.prim.edgeSet.add(a < b ? a + "_" + b : b + "_" + a); }
    }
    const tris = triangulate(h.prim.pos, h.verts, h.welds, h.prim.edgeSet);
    if (!tris) { skippedHoles++; continue; }
    if (!fills.has(h.prim)) fills.set(h.prim, []);
    fills.get(h.prim).push(...tris);
    filled++;
  }
  let removedTris = 0, addedTris = 0, extra = [], offset = bin.length;
  const addIndices = (list32) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { extra.push(Buffer.alloc(pad)); offset += pad; }
    const data32 = Buffer.from(Uint32Array.from(list32).buffer);
    gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data32.length, target: 34963 });
    gltf.accessors.push({ bufferView: gltf.bufferViews.length - 1, componentType: 5125, count: list32.length, type: "SCALAR" });
    extra.push(data32); offset += data32.length;
    return gltf.accessors.length - 1;
  };
  // Preview only: show what goes in red and what is added in green, on top of the kept mesh.
  const marker = (color) => {
    gltf.materials = gltf.materials || [];
    gltf.materials.push({ name: "catalogisti_" + color.join("_"), doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 0.6 }, emissiveFactor: color.map((c) => c * 0.6) });
    return gltf.materials.length - 1;
  };
  let red, green;
  for (const p of data.prims) {
    const d = drop.get(p), f = fills.get(p);
    if (!d && !f) continue;
    const keep = [], gone = [];
    for (let t = 0; t < p.idx.length; t += 3) { const tri = [p.idx[t], p.idx[t + 1], p.idx[t + 2]]; if (d?.has(t)) { removedTris++; gone.push(...tri); } else keep.push(...tri); }
    if (f) addedTris += f.length / 3;
    const mesh = gltf.meshes[p.mi];
    if (o.highlight) {
      p.prim.indices = addIndices(keep);
      const extraPrim = (indices, material) => ({ ...p.prim, indices, material }); // same vertices (and morph targets)
      if (gone.length) { red ??= marker([1, 0.1, 0.1]); mesh.primitives.push(extraPrim(addIndices(gone), red)); }
      if (f) { green ??= marker([0.15, 1, 0.3]); mesh.primitives.push(extraPrim(addIndices(f), green)); }
    } else {
      p.prim.indices = addIndices(f ? keep.concat(f) : keep);
    }
  }
  if (!removedTris && !addedTris) return { removedPieces: 0, removedTriangles: 0, filledHoles: 0, skippedHoles: 0, addedTriangles: 0, changed: false };
  if (!gltf.buffers?.length) gltf.buffers = [{ byteLength: 0 }];
  writeGlb(outFile, gltf, Buffer.concat([bin, ...extra]));
  return { removedPieces: list.filter((x) => x.remove).length, removedTriangles: removedTris, filledHoles: filled, skippedHoles, addedTriangles: addedTris, changed: true };
}

/** Diagnostics: open edges, non-manifold edges and faces wound against their neighbours. */
function boundaryStats(file) {
  const { gltf, bin } = readGlb(file);
  const data = collect(gltf, bin);
  const out = { boundaryEdges: 0, nonManifold: 0, flippedPairs: 0, loopsAll: 0, loopsOver64: 0, loopsSmall5: 0,
    doubleSidedMats: (gltf.materials || []).filter((m) => m.doubleSided).length, singleSidedMats: (gltf.materials || []).filter((m) => !m.doubleSided).length };
  for (const p of data.prims) {
    const und = new Map(), dir = new Map();
    for (let t = 0; t < p.idx.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = p.weld[p.idx[t + e]], b = p.weld[p.idx[t + (e + 1) % 3]];
      if (a === b) continue;
      const k = a < b ? a + "_" + b : b + "_" + a;
      und.set(k, (und.get(k) || 0) + 1);
      dir.set(a + ">" + b, (dir.get(a + ">" + b) || 0) + 1);
    }
    for (const [k, n] of und) {
      if (n === 1) out.boundaryEdges++;
      else if (n > 2) out.nonManifold++;
      else { const [a, b] = k.split("_"); if ((dir.get(a + ">" + b) || 0) === 2 || (dir.get(b + ">" + a) || 0) === 2) out.flippedPairs++; }
    }
  }
  const all = holes(data, { maxEdges: 1e9 });
  out.loopsAll = all.length;
  out.loopsOver64 = all.filter((h) => h.edges > 64).length;
  out.loopsSmall5 = all.filter((h) => h.size <= data.diag * 0.05).length;
  out.edgesInLoops = all.reduce((n, h) => n + h.edges, 0);
  return out;
}

module.exports = { analyzeGlb, cleanGlb, boundaryStats };
