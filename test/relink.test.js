"use strict";
// Files reorganized behind the library's back are found again by name, without mixing up same-name models.
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogisti-relink-"));
process.env.CATALOGISTI_DATA = path.join(dir, "lib");
const store = require("../mcp/store");

const proj = path.join(dir, "Mindflower");
const put = (rel, bytes) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(bytes, 1)); return f; };
const lib = store.load();
lib.projects.push({ name: "Mindflower", path: proj, kind: "model" });
lib.settings = { library_root: dir };
const asset = (id, file, size) => ({ id, kind: "model", name: id, categories: ["Props"], project: "Mindflower", file, size, review: { decision: "approved" } });
// Before: two different kiosks with the same file name in two batch folders, plus a source image.
lib.assets.push(asset("kiosk", path.join(proj, "batch_a", "ticket_kiosk.glb"), 100));
lib.assets.push(asset("kiosk-2", path.join(proj, "batch_b", "ticket_kiosk.glb"), 200));
lib.assets.push(asset("lamp", path.join(proj, "batch_a", "lamp.glb"), 50));
lib.assets[2].source = { image: path.join(proj, "refs", "lamp_front.png") };
// After someone else organized them: new folders, and one kiosk renamed to _2.
put("Models/Props/ticket_kiosk.glb", 200);
put("Models/Buildings/ticket_kiosk_2.glb", 100);
put("Models/Props/lamp.glb", 50);
put("Models/Props/lamp_sources/lamp_front.png", 10);

const stats = store.relinkMoved(lib);
const file = (id) => path.relative(proj, lib.assets.find((a) => a.id === id).file);
assert.strictEqual(file("kiosk"), path.join("Models", "Buildings", "ticket_kiosk_2.glb"), "size decides between same-name files");
assert.strictEqual(file("kiosk-2"), path.join("Models", "Props", "ticket_kiosk.glb"));
assert.strictEqual(file("lamp"), path.join("Models", "Props", "lamp.glb"));
assert.strictEqual(path.relative(proj, lib.assets[2].source.image), path.join("Models", "Props", "lamp_sources", "lamp_front.png"));
assert.strictEqual(stats.still_missing, 0);
assert.strictEqual(lib.assets.find((a) => a.id === "kiosk").review.decision, "approved", "reviews are kept");

// Organize then puts source images next to the model, and Undo puts them back.
fs.mkdirSync(path.join(proj, "refs"), { recursive: true });
const ref = path.join(proj, "refs", "kiosk_front.png"); fs.writeFileSync(ref, "img");
lib.assets[0].source = { image: ref };
const r = store.organizeLibrary(lib, { root: dir });
const k = lib.assets[0];
assert.ok(fs.existsSync(k.source.image) && /ticket_kiosk(_2)?_sources/.test(k.source.image), "source image moved beside the model: " + k.source.image);
assert.ok(r.moved >= 1);
store.undoOrganize(lib);
assert.ok(fs.existsSync(ref), "undo restores the source image");
fs.rmSync(dir, { recursive: true, force: true });
console.log("relink tests passed");
