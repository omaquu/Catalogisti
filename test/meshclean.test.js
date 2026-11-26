"use strict";
// Synthetic GLB: an open box (one face missing = a hole) plus a tiny floating triangle far away.
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const mc = require("../mcp/meshclean");

const P = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const box = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6]; // left face (x=0) missing
const pos = [...P.flat(), 3,3,3, 3.01,3,3, 3,3.01,3];
const idx = [...box, 8, 9, 10];
// Many small boxes would be needed to exceed 2 %: use a 1 % threshold-friendly ratio by repeating the box
const posBuf = Buffer.from(Float32Array.from(pos).buffer), idxBuf = Buffer.from(Uint16Array.from(idx).buffer);
const bin = Buffer.concat([posBuf, idxBuf, Buffer.alloc((4 - (idxBuf.length % 4)) % 4)]);
const gltf = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBuf.length }, { buffer: 0, byteOffset: posBuf.length, byteLength: idxBuf.length }],
  accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min: [0,0,0], max: [3.01,3.01,3] },
    { bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" }] };
let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + json.length + bin.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogisti-mesh-"));
const file = path.join(dir, "box.glb");
fs.writeFileSync(file, Buffer.concat([h, jh, json, bh, bin]));

const opts = { maxPercent: 10, holePercent: 50 };
const report = mc.analyzeGlb(file, opts);
assert.strictEqual(report.triangles, 11);
assert.strictEqual(report.pieces, 2);
assert.strictEqual(report.loose, 1, "floating triangle is loose");
assert.strictEqual(report.smallHoles, 1, "missing box face is a small hole");

const out = path.join(dir, "box_clean.glb");
const r = mc.cleanGlb(file, out, opts);
assert.deepStrictEqual([r.removedPieces, r.removedTriangles, r.filledHoles, r.addedTriangles], [1, 1, 1, 2]);
const after = mc.analyzeGlb(out, opts);
assert.strictEqual(after.triangles, 12, "closed box");
assert.strictEqual(after.pieces, 1);
assert.strictEqual(after.holes, 0, "no open edges left, and the fill is wound the right way");

// Nothing to do → no file written
const none = mc.cleanGlb(out, path.join(dir, "again.glb"), opts);
assert.strictEqual(none.changed, false);
assert.ok(!fs.existsSync(path.join(dir, "again.glb")));
fs.rmSync(dir, { recursive: true, force: true });
console.log("meshclean tests passed");
