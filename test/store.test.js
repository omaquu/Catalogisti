"use strict";
// Store tests on a throwaway library: node test/store.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogisti-test-"));
process.env.CATALOGISTI_DATA = path.join(dir, "lib");
const store = require("../mcp/store");

// Minimal valid GLB: one triangle.
function writeGlb(file) {
  const json = Buffer.from(JSON.stringify({
    asset: { version: "2.0" }, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ count: 3, componentType: 5126, type: "VEC3", min: [0, 0, 0], max: [1, 2, 0.5] }],
  }).padEnd(Math.ceil(JSON.stringify({}).length / 4) * 4, " "));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  fs.writeFileSync(file, Buffer.concat([header, padded]));
}

const src = path.join(dir, "src");
fs.mkdirSync(path.join(src, "armor"), { recursive: true });
writeGlb(path.join(src, "armor", "iron_helmet.glb"));
writeGlb(path.join(src, "brass_pommel.glb"));
for (const f of ["mossy_wall_diff.png", "mossy_wall_nor_gl.png", "mossy_wall_rough.png", "dirt_ground.png"]) fs.writeFileSync(path.join(src, f), "x");

let r = store.mutate((lib) => store.importFolder(lib, src, { kind: "model", project: "Test" }));
assert.strictEqual(r.added, 2);
r = store.mutate((lib) => store.importFolder(lib, src, { kind: "model", project: "Test" }));
assert.strictEqual(r.added, 0, "re-import skips known files");
r = store.mutate((lib) => store.importFolder(lib, src, { kind: "texture", project: "Test" }));
assert.strictEqual(r.added, 2, "maps of one texture are grouped");

let lib = store.load();
const helmet = lib.assets.find((a) => a.name === "Iron Helmet");
assert.strictEqual(helmet.triangles, 1);
assert.deepStrictEqual(helmet.bounds, [1, 2, 0.5]);
assert.strictEqual(helmet.category, "Armor");
assert.strictEqual(lib.assets.find((a) => a.name === "Brass Pommel").category, "Weapon parts");
const wall = lib.assets.find((a) => a.kind === "texture" && a.name === "Mossy Wall");
assert.deepStrictEqual(Object.keys(wall.maps).sort(), ["albedo", "normal", "roughness"]);
assert.strictEqual(wall.category, "Walls");
assert.strictEqual(lib.assets.find((a) => a.name === "Dirt Ground").category, "Ground");

store.mutate((l) => store.editTags(l, helmet.id, ["#Item", "steampunk"], ["helmet"]));
lib = store.load();
assert.deepStrictEqual(store.findAsset(lib, helmet.id).tags.sort(), ["iron", "item", "steampunk"]);
assert.deepStrictEqual(store.tagCounts(lib, { prefix: "i" }).map((t) => t.tag), ["iron", "item"]);

store.mutate((l) => store.setReview(l, helmet.id, { decision: "needs_fix", flags: ["bad_scale", "nonsense"], notes: "Too big" }, "owner"));
store.mutate((l) => store.setReview(l, helmet.id, { append_note: "Measured 1.4x" }, "agent"));
lib = store.load();
const rev = store.findAsset(lib, helmet.id).review;
assert.strictEqual(rev.decision, "needs_fix");
assert.deepStrictEqual(rev.flags, ["bad_scale"]);
assert.ok(rev.notes.startsWith("Too big\n[agent "));
assert.strictEqual(store.search(lib, { needs_fix: true }).total, 1);
assert.strictEqual(store.search(lib, { tags: ["iron", "item"], kind: "model" }).total, 1);
assert.strictEqual(store.search(lib, { kind: "textures" }).total, 2);

const fixed = path.join(src, "iron_helmet_v2.glb");
writeGlb(fixed);
store.mutate((l) => store.replaceFile(l, helmet.id, fixed, "fixed scale"));
lib = store.load();
const h2 = store.findAsset(lib, helmet.id);
assert.strictEqual(h2.file, fixed);
assert.strictEqual(h2.versions.length, 1);
assert.strictEqual(h2.versions[0].review.decision, "needs_fix");
assert.strictEqual(h2.review.decision, "unreviewed");

// Categories work like tags: several per asset, custom names allowed, the last one removed leaves "Other".
store.mutate((l) => store.editCategories(l, helmet.id, ["Railway", "Props"], ["Armor"]));
lib = store.load();
assert.deepStrictEqual(store.findAsset(lib, helmet.id).categories, ["Railway", "Props"]);
assert.strictEqual(store.search(lib, { category: "props" }).results.some((r) => r.id === helmet.id), true);
store.mutate((l) => store.editCategories(l, helmet.id, [], ["Railway", "Props"]));
assert.deepStrictEqual(store.findAsset(store.load(), helmet.id).categories, ["Other"]);
assert.throws(() => store.mutate((l) => store.editCategories(l, helmet.id, [""], [])), /1-40/);
assert.deepStrictEqual(store.classifyModels("rail luggage trolley crate"), ["Railway", "Props"]);

// Same name in another folder: identical file is offered as a merge, a different file as a variant.
const copyDir = path.join(dir, "copy");
fs.mkdirSync(copyDir);
fs.copyFileSync(path.join(src, "brass_pommel.glb"), path.join(copyDir, "brass_pommel.glb"));
writeGlb(path.join(copyDir, "iron_helmet_v2.glb"));
fs.appendFileSync(path.join(copyDir, "iron_helmet_v2.glb"), "different");
r = store.mutate((l) => store.importFolder(l, copyDir, { kind: "model", project: "Copy" }));
const pommelDup = r.duplicates.find((d) => d.name === "Brass Pommel");
assert.ok(pommelDup && pommelDup.matches[0].identical, "identical copy detected");
lib = store.load();
assert.ok(store.findAsset(lib, pommelDup.id).possible_duplicate_of.length);
const merged = store.mutate((l) => store.resolveDuplicate(l, pommelDup.id, pommelDup.matches[0].id, "merge"));
assert.deepStrictEqual(merged.locations, [path.join(copyDir, "brass_pommel.glb")]);
assert.strictEqual(store.load().assets.filter((a) => a.name === "Brass Pommel").length, 1);
assert.ok(store.ownedFiles(merged).length === 2, "both locations belong to the merged asset");
const req = store.mutate((l) => store.createRequest(l, { kind: "texture", prompt: "lava ground", category: "Ground" }));
const added = store.mutate((l) => store.addAsset(l, { file: path.join(src, "dirt_ground.png"), name: "Lava", request_id: req.id, tags: ["lava"] }));
lib = store.load();
assert.strictEqual(lib.requests[0].status, "done");
assert.strictEqual(lib.requests[0].result_asset, added.id);

store.mutate((l) => store.deleteAsset(l, helmet.id));
lib = store.load();
assert.ok(!lib.assets.some((a) => a.id === helmet.id));
assert.ok(fs.existsSync(fixed), "deleting from the catalog keeps the file");

// Sources: removing a folder drops its assets, keeps assets that also live elsewhere, and remembers reviews.
lib = store.load();
const srcCount = store.listSources(lib).find((x) => x.path === path.resolve(copyDir)).count;
assert.ok(srcCount >= 1);
const pommelId = store.load().assets.find((a) => a.name === "Brass Pommel").id;
store.mutate((l) => store.setReview(l, pommelId, { decision: "approved", notes: "keep" }));
let rs = store.mutate((l) => store.removeSource(l, { path: src }));
lib = store.load();
const pommel = store.findAsset(lib, pommelId);
assert.strictEqual(pommel.file, path.join(copyDir, "brass_pommel.glb"), "merged asset survives through its other location");
assert.ok(!lib.projects.some((p) => p.path === path.resolve(src)));
assert.ok(rs.removed > 0 && rs.kept_elsewhere === 1);
rs = store.mutate((l) => store.removeSource(l, { path: copyDir }));
assert.ok(!store.load().assets.some((a) => a.id === pommelId));
store.mutate((l) => store.importFolder(l, copyDir, { kind: "model", project: "Copy" }));
const back = store.load().assets.find((a) => a.name === "Brass Pommel");
assert.strictEqual(back.review.decision, "approved", "review comes back when the same file is imported again");
store.mutate((l) => store.clearLibrary(l));
assert.strictEqual(store.load().assets.length, 0);
assert.strictEqual(store.load().projects.length, 0);
console.log("source tests passed");
fs.writeFileSync(store.libraryPath(), "{broken");
assert.throws(() => store.load(), /could not be read/);
assert.strictEqual(fs.readFileSync(store.libraryPath(), "utf-8"), "{broken", "a damaged library is not overwritten");

fs.rmSync(dir, { recursive: true, force: true });
console.log("store tests passed");
