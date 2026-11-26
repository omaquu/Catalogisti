"use strict";
/**
 * Catalogisti library store — shared by the desktop app (main.js) and the MCP server.
 *
 * Everything lives in one JSON file, library.json, inside the data folder:
 *   CATALOGISTI_DATA env var, or --data-dir <path>, or %APPDATA%/Catalogisti/library.
 * Every change is a read-modify-write of that file with an atomic rename, so the app
 * and any number of agents can work on the same library without a database.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const SCHEMA = 2;

const MODEL_CATEGORIES = [
  "Weapon parts", "Armor", "Accessories", "Characters", "Enemies", "Creatures", "Buildings",
  "Building parts", "Props", "Furniture", "Vehicles", "Railway", "Nature", "Other",
];
const TEXTURE_CATEGORIES = [
  "Walls", "Ground", "Floors", "Roofs", "Stone", "Brick", "Wood", "Metal", "Fabric & leather",
  "Nature", "Decals", "Other",
];
const DECISIONS = ["unreviewed", "approved", "needs_fix", "regenerate", "remove"];
const FLAGS = {
  reduce_tris: "Could try reducing triangles further",
  duplicate_exists: "Another similar asset already exists",
  bad_texture: "Texture problems (seams, blur, wrong colours)",
  bad_scale: "Wrong scale or pivot",
  broken_mesh: "Holes, torn or inverted surfaces",
};
const MODEL_EXT = new Set([".glb", ".gltf"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".tga", ".bmp"]);
const SKIP_DIRS = new Set([".git", ".godot", "node_modules", "__pycache__", ".import", "Archives", "backups"]);

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function defaultDataDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), ".config");
  return path.join(base, "Catalogisti", "library");
}

let DATA_DIR = process.env.CATALOGISTI_DATA || argValue("--data-dir") || defaultDataDir();

function setDataDir(dir) { DATA_DIR = dir; }
function dataDir() { return DATA_DIR; }
function libraryPath() { return path.join(DATA_DIR, "library.json"); }
function thumbsDir() { return path.join(DATA_DIR, "thumbs"); }

function emptyLibrary() {
  return { schema: SCHEMA, revision: 0, updated: new Date().toISOString(), assets: [], requests: [], projects: [] };
}

function load() {
  try {
    const lib = JSON.parse(fs.readFileSync(libraryPath(), "utf-8"));
    lib.assets ??= []; lib.requests ??= []; lib.projects ??= [];
    return lib;
  } catch (error) {
    if (error.code === "ENOENT") return emptyLibrary();
    // A damaged library is never silently replaced: keep a copy and refuse to continue.
    throw new Error("library.json could not be read (" + error.message + "). Fix or restore it; it was not overwritten.");
  }
}

function save(lib, by = "app") {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  lib.schema = SCHEMA;
  lib.revision = (lib.revision || 0) + 1;
  lib.updated = new Date().toISOString();
  lib.updated_by = by;
  const tmp = libraryPath() + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(lib, null, 1) + "\n", "utf-8");
  // Keep one previous copy for recovery.
  if (fs.existsSync(libraryPath())) {
    try { fs.copyFileSync(libraryPath(), libraryPath() + ".bak"); } catch { /* best effort */ }
  }
  fs.renameSync(tmp, libraryPath());
  return lib;
}

/** Read the newest library, apply fn, write it back. Returns fn's result. */
function mutate(fn, by = "app") {
  const lib = load();
  const result = fn(lib);
  save(lib, by);
  return result;
}

// ── Helpers ──

const STOP = new Set(["the", "and", "of", "a", "an", "with", "for", "gr", "lod", "lod0", "final", "new", "copy", "textured",
  "model", "mesh", "glb", "png", "jpg", "webp", "diff", "albedo", "basecolor", "color", "col", "rgba", "2k", "1k", "4k", "8k",
  "front", "views", "view", "moni", "mindflower", "disp", "height16bit", "height", "normal", "orm", "nor", "rough", "ao", "gl"]);

function slugify(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "asset";
}

function normTag(tag) {
  return String(tag).trim().replace(/^#+/, "").toLowerCase().replace(/[^a-z0-9_\-& ]+/g, "").replace(/\s+/g, "-").slice(0, 40);
}

function prettyName(file) {
  const stem = path.basename(file, path.extname(file));
  return stem.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

function tokens(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/)
    .map((t) => (/^[a-z]{3,}\d+$/.test(t) ? t.replace(/\d+$/, "") : t))
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t) && !/^v\d+$/.test(t));
}

const MATERIAL_WORDS = ["brass", "bronze", "copper", "iron", "steel", "gold", "silver", "leather", "wood", "wooden", "stone",
  "marble", "brick", "glass", "fabric", "cloth", "fur", "bone", "crystal", "enamel", "rust", "rusty", "moss", "slate",
  "cobblestone", "granite", "plaster", "gravel", "sand", "mud", "dirt", "grass", "concrete", "tile", "copper"];

function autoTags(name, extra = []) {
  const out = new Set();
  for (const t of tokens(name)) out.add(t === "wooden" ? "wood" : t === "rusty" ? "rust" : t);
  for (const e of extra) if (e) for (const t of tokens(e)) if (MATERIAL_WORDS.includes(t)) out.add(t);
  return [...out].slice(0, 8).map(normTag).filter(Boolean);
}

const MODEL_RULES = [
  ["Weapon parts", /pommel|grip|handle|guard|crossguard|nozzle|barrel|blade|hammer.?head|axe.?head|cartridge|regulator|bellows|scope|trigger|muzzle|weapon|sword|gun|rifle|pistol/],
  ["Armor", /armou?r|helmet|helm|cuirass|chest|bracer|gauntlet|glove|boot|greave|pauldron|shoulder|corset|vambrace|shin|thigh/],
  ["Accessories", /backpack|pack|belt|ring|amulet|goggles|hat|cape|cloak|wings|satchel|pouch/],
  ["Enemies", /enemy|robot|automaton|boss|golem|knight/],
  ["Creatures", /bear|wolf|deer|stag|bird|insect|beetle|spider|horse|lion|boar|creature|animal/],
  ["Railway", /rail|train|locomotive|wagon|hopper|brake.?van|carriage|signal|turntable|platform/],
  ["Vehicles", /airship|cart|vehicle|boat|ship|dirigible|balloon/],
  ["Furniture", /chair|table|bed|sofa|cabinet|bookcase|shelf|desk|commode|stool|bench|nightstand|wardrobe/],
  ["Building parts", /wall|roof|door|window|stair|column|pillar|arch|balcony|chimney|gutter|pipe|fence|gate|sign|lamp|lantern/],
  ["Buildings", /house|building|tower|hall|station|shop|tavern|inn|factory|church/],
  ["Nature", /tree|bush|shrub|rock|stone|fern|flower|plant|grass|log|stump|mushroom/],
  ["Characters", /character|npc|human|woman|man|girl|boy|villager|merchant/],
  ["Props", /crate|barrel|box|chest|trunk|bucket|sack|tool|gear|valve|gauge|bottle|book|clock|statue|bust|mirror|frame|lamp/],
];

function classifyModel(text) {
  const t = String(text).toLowerCase().replace(/_/g, " ");
  for (const [cat, re] of MODEL_RULES) if (re.test(t)) return cat;
  return "Props";
}

const TEXTURE_RULES = [
  ["Roofs", /roof|slate|shingle|tile.?roof/],
  ["Ground", /ground|dirt|\bmud|grass|gravel|\bsand|ballast|meadow|soil|\bpath\b|\broad|cobble|paving|forest.?floor|\bsnow|\bash\b/],
  ["Floors", /floor|plank|parquet|deck|carpet/],
  ["Brick", /brick/],
  ["Walls", /wall|facade|plaster|stucco|wallpaper|panel/],
  ["Stone", /stone|marble|ashlar|granite|rock|cliff|concrete/],
  ["Wood", /wood|bark|timber|log/],
  ["Metal", /metal|iron|steel|copper|brass|bronze|rust|rivet|plate/],
  ["Fabric & leather", /fabric|cloth|leather|hide|fur|canvas|rope/],
  ["Nature", /leaf|leaves|moss|foliage|ivy|hedge/],
  ["Decals", /decal|stain|crack|puddle|leak|graffiti|track/],
];

function classifyTexture(text) {
  const t = String(text).toLowerCase().replace(/_/g, " ");
  for (const [cat, re] of TEXTURE_RULES) if (re.test(t)) return cat;
  return "Other";
}

/** Triangle count, embedded image count and local-space bounds from a .glb (reads only the JSON chunk). */
function measureGlb(file) {
  const out = { triangles: 0, images: 0, bounds: null, meshes: 0 };
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(20);
    fs.readSync(fd, head, 0, 20, 0);
    if (head.readUInt32LE(0) !== 0x46546c67) return out; // "glTF"
    const jsonLen = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 20);
    const gltf = JSON.parse(jsonBuf.toString("utf-8"));
    const acc = gltf.accessors || [];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const mesh of gltf.meshes || []) {
      out.meshes += 1;
      for (const prim of mesh.primitives || []) {
        const mode = prim.mode ?? 4;
        const pos = acc[prim.attributes?.POSITION];
        const count = prim.indices !== undefined ? acc[prim.indices]?.count ?? 0 : pos?.count ?? 0;
        if (mode === 4) out.triangles += Math.floor(count / 3);
        else if (mode === 5 || mode === 6) out.triangles += Math.max(0, count - 2);
        if (pos?.min && pos?.max) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], pos.min[i]); max[i] = Math.max(max[i], pos.max[i]); }
      }
    }
    out.images = (gltf.images || []).length;
    if (min[0] !== Infinity) out.bounds = max.map((v, i) => Math.round((v - min[i]) * 1000) / 1000);
  } catch { /* unreadable GLB: leave zeros */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return out;
}

function fileInfo(file) {
  const st = fs.statSync(file);
  return { size: st.size, mtime: st.mtime.toISOString() };
}

function uniqueId(lib, base) {
  const ids = new Set(lib.assets.map((a) => a.id));
  let id = slugify(base), n = 2;
  while (ids.has(id)) id = slugify(base) + "-" + n++;
  return id;
}

function findAsset(lib, id) {
  const a = lib.assets.find((x) => x.id === id);
  if (!a) throw new Error("No asset with id '" + id + "'.");
  return a;
}

// ── Texture map grouping ──
const MAP_SUFFIX = [
  ["normal", /[_\-. ](normal|nrm|nor|norm|n|normalgl|normaldx|nor_gl)$/],
  ["roughness", /[_\-. ](rough|roughness|rgh)$/],
  ["metallic", /[_\-. ](metal|metallic|metalness|mtl)$/],
  ["ao", /[_\-. ](ao|occlusion|ambientocclusion)$/],
  ["height", /[_\-. ](height|disp|displacement|depth|bump|height16bit)$/],
  ["orm", /[_\-. ](orm|arm|mask)$/],
  ["albedo", /[_\-. ](albedo|diff|diffuse|basecolor|base_color|color|col|rgba|d)$/],
];

function splitMap(stem) {
  const s = stem.toLowerCase().replace(/[_\-. ](\d+k|\d{3,4}px)$/, "");
  for (const [kind, re] of MAP_SUFFIX) {
    const m = s.match(re);
    if (m) return { base: s.slice(0, m.index), map: kind };
  }
  return { base: s, map: "albedo" };
}

// ── Import ──

function readSidecars(dir) {
  const meta = new Map();
  for (const name of ["results.json", "manifest.json", "generated.json", "catalog.json"]) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      const list = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : Array.isArray(data.assets) ? data.assets
        : Array.isArray(data.results) ? data.results : Object.entries(data).map(([k, v]) => (typeof v === "object" && v ? { slug: k, ...v } : null)).filter(Boolean);
      for (const e of list) {
        const keys = [e.slug, e.file_id, e.id, e.name, e.output && path.basename(e.output, path.extname(e.output))].filter(Boolean);
        for (const k of keys) meta.set(String(k).toLowerCase(), e);
      }
    } catch { /* ignore malformed sidecar */ }
  }
  return meta;
}

function walk(root, exts, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p, exts, out); }
    else if (exts.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

/**
 * Import every model (.glb/.gltf) or texture (images, grouped into PBR sets) under a folder.
 * Files already in the library (same path) are skipped. Returns {added, skipped, ids}.
 */
function importFolder(lib, root, { kind = "model", project, by = "app" } = {}) {
  root = path.resolve(root);
  project = project || path.basename(root);
  const added = [], skipped = [];
  const known = new Set(lib.assets.flatMap((a) => [a.file, ...Object.values(a.maps || {})]).filter(Boolean).map((f) => path.resolve(f).toLowerCase()));
  const now = new Date().toISOString();
  if (kind === "model") {
    const sidecars = new Map();
    for (const file of walk(root, MODEL_EXT)) {
      if (known.has(file.toLowerCase())) { skipped.push(file); continue; }
      const dir = path.dirname(file);
      if (!sidecars.has(dir)) sidecars.set(dir, readSidecars(dir));
      const stem = path.basename(file, path.extname(file));
      const meta = sidecars.get(dir).get(stem.toLowerCase()) || {};
      const folder = path.relative(root, dir).replace(/\\/g, "/") || ".";
      const m = path.extname(file).toLowerCase() === ".glb" ? measureGlb(file) : { triangles: 0, images: 0, bounds: null };
      const name = meta.name && typeof meta.name === "string" && !/^[a-z0-9_]+$/.test(meta.name) ? meta.name : prettyName(file);
      const category = MODEL_CATEGORIES.includes(meta.category) ? meta.category : classifyModel(stem + " " + (meta.role || "") + " " + folder);
      const asset = {
        id: uniqueId(lib, stem), kind: "model", name, category,
        tags: autoTags(stem, [meta.role, folder]), project, folder, file,
        triangles: m.triangles, embedded_images: m.images, bounds: m.bounds || meta.bounds_m || null,
        ...fileInfo(file),
        source: cleanSource({ image: meta.image, prompt: meta.prompt, tool: meta.geom_run_id ? "Modly" : meta.tool, run_ids: [meta.geom_run_id, meta.tex_run_id].filter(Boolean), budget: meta.faces || meta.max_faces }),
        versions: [], review: { decision: "unreviewed", flags: [], notes: "", updated: null, by: null },
        created: now, updated: now, added_by: by,
      };
      lib.assets.push(asset); added.push(asset.id); known.add(file.toLowerCase());
    }
  } else {
    const groups = new Map();
    for (const file of walk(root, IMAGE_EXT)) {
      if (known.has(file.toLowerCase())) { skipped.push(file); continue; }
      const { base, map } = splitMap(path.basename(file, path.extname(file)));
      const key = path.join(path.dirname(file), base).toLowerCase();
      if (!groups.has(key)) groups.set(key, { dir: path.dirname(file), base, maps: {} });
      const g = groups.get(key);
      if (!g.maps[map]) g.maps[map] = file;
    }
    for (const g of groups.values()) {
      const main = g.maps.albedo || Object.values(g.maps)[0];
      const folder = path.relative(root, g.dir).replace(/\\/g, "/") || ".";
      const asset = {
        id: uniqueId(lib, "tex-" + g.base), kind: "texture", name: prettyName(g.base), category: classifyTexture(g.base + " " + folder),
        tags: autoTags(g.base, [folder]), project, folder, file: main, maps: g.maps, ...fileInfo(main),
        tiling: true, versions: [], review: { decision: "unreviewed", flags: [], notes: "", updated: null, by: null },
        created: now, updated: now, added_by: by,
      };
      lib.assets.push(asset); added.push(asset.id);
    }
  }
  if (!lib.projects.some((p) => p.path.toLowerCase() === root.toLowerCase())) lib.projects.push({ name: project, path: root, kind, imported: now });
  return { added: added.length, skipped: skipped.length, ids: added };
}

/** Import tiling surface textures (walls, ground…) from a shared texture library catalog.json. */
function importTextureLibrary(lib, catalogFile, { by = "app" } = {}) {
  const cat = JSON.parse(fs.readFileSync(catalogFile, "utf-8"));
  const root = cat.library || path.dirname(catalogFile);
  const known = new Set(lib.assets.map((a) => (a.file || "").toLowerCase()));
  const now = new Date().toISOString();
  // Group separate map files (x_diff_2k, x_nor_gl_1k, x_ao_1k…) into one texture set.
  const groups = new Map();
  for (const [key, t] of Object.entries(cat.textures || {})) {
    if (!t.tiling || t.class === "skip") continue;
    const rel = t.file || key;
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const stem = path.basename(file, path.extname(file)).replace(/[_\-](\d+k)$/i, "").replace(/[_\-](gl|dx)$/i, "");
    const { base, map } = splitMap(stem);
    const gkey = path.join(path.dirname(file), base).toLowerCase();
    if (!groups.has(gkey)) groups.set(gkey, { base, rel, maps: {}, tags: new Set(), size: null });
    const g = groups.get(gkey);
    if (!g.maps[map] || map === "albedo") g.maps[map] = file;
    for (const [k, v] of Object.entries(t.maps || {})) if (!g.maps[k]) g.maps[k] = path.join(root, v);
    for (const tag of t.tags || []) g.tags.add(tag);
    if (map === "albedo") { g.size = t.size || g.size; g.rel = rel; }
  }
  let added = 0;
  for (const g of groups.values()) {
    const file = g.maps.albedo || Object.values(g.maps)[0];
    if (known.has(file.toLowerCase())) continue;
    lib.assets.push({
      id: uniqueId(lib, "tex-" + g.base), kind: "texture", name: prettyName(g.base.replace(/[_\-]rgba$/i, "")),
      category: classifyTexture(g.base + " " + [...g.tags].join(" ") + " " + path.dirname(g.rel)),
      tags: [...new Set([...[...g.tags].flatMap(tokens), ...autoTags(g.base)])].map(normTag).filter(Boolean).slice(0, 10),
      project: "Texture Library", folder: path.dirname(g.rel).replace(/\\/g, "/"), file, maps: g.maps, ...fileInfo(file),
      tiling: true, pixel_size: g.size, versions: [], review: { decision: "unreviewed", flags: [], notes: "", updated: null, by: null },
      created: now, updated: now, added_by: by,
    });
    known.add(file.toLowerCase());
    added++;
  }
  return { added };
}

function cleanSource(s) {
  const out = {};
  for (const [k, v] of Object.entries(s)) if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/** Register one file (model or texture) — used by agents after generating an asset. */
function addAsset(lib, opts, by = "agent") {
  const file = path.resolve(opts.file);
  if (!fs.existsSync(file)) throw new Error("File not found: " + file);
  const ext = path.extname(file).toLowerCase();
  const kind = opts.kind || (MODEL_EXT.has(ext) ? "model" : "texture");
  if (opts.replaces) return replaceFile(lib, opts.replaces, file, opts.note || "Fixed version", by);
  const stem = path.basename(file, ext);
  const now = new Date().toISOString();
  const m = kind === "model" && ext === ".glb" ? measureGlb(file) : {};
  const asset = {
    id: uniqueId(lib, (kind === "texture" ? "tex-" : "") + (opts.name || stem)), kind,
    name: opts.name || prettyName(stem),
    category: opts.category || (kind === "model" ? classifyModel(stem) : classifyTexture(stem)),
    tags: [...new Set([...(opts.tags || []).map(normTag), ...autoTags(stem)])].filter(Boolean),
    project: opts.project || "Unsorted", folder: opts.folder || path.basename(path.dirname(file)), file,
    ...(kind === "model" ? { triangles: m.triangles || 0, embedded_images: m.images || 0, bounds: m.bounds || null } : { maps: { albedo: file, ...(opts.maps || {}) }, tiling: opts.tiling ?? true }),
    ...fileInfo(file),
    source: cleanSource({ image: opts.source_image, prompt: opts.prompt, tool: opts.tool, run_ids: opts.run_ids }),
    versions: [], review: { decision: "unreviewed", flags: [], notes: opts.note || "", updated: null, by: null },
    created: now, updated: now, added_by: by,
  };
  validateCategory(asset.kind, asset.category);
  lib.assets.push(asset);
  if (opts.request_id) completeRequest(lib, opts.request_id, asset.id, by);
  return asset;
}

/** Swap an asset to a corrected file; the previous file is kept in versions[]. */
function replaceFile(lib, id, file, note, by = "app") {
  const a = findAsset(lib, id);
  file = path.resolve(file);
  if (!fs.existsSync(file)) throw new Error("File not found: " + file);
  a.versions = a.versions || [];
  a.versions.push({ file: a.file, triangles: a.triangles, size: a.size, replaced: new Date().toISOString(), review: a.review, note: note || "" });
  a.file = file;
  Object.assign(a, fileInfo(file));
  if (a.kind === "model" && path.extname(file).toLowerCase() === ".glb") {
    const m = measureGlb(file);
    a.triangles = m.triangles; a.embedded_images = m.images; a.bounds = m.bounds;
  } else if (a.kind === "texture") {
    a.maps = { ...(a.maps || {}), albedo: file };
  }
  a.thumbnail = null;
  a.review = { decision: "unreviewed", flags: [], notes: "Replaced: " + (note || "new version") + ". Previous review kept in versions.", updated: new Date().toISOString(), by };
  a.updated = new Date().toISOString();
  return a;
}

function validateCategory(kind, category) {
  const list = kind === "texture" ? TEXTURE_CATEGORIES : MODEL_CATEGORIES;
  if (!list.includes(category)) throw new Error("Unknown " + kind + " category '" + category + "'. Use one of: " + list.join(", "));
}

function setCategory(lib, id, category) {
  const a = findAsset(lib, id);
  validateCategory(a.kind, category);
  a.category = category; a.updated = new Date().toISOString();
  return a;
}

function editTags(lib, id, add = [], remove = []) {
  const a = findAsset(lib, id);
  const rm = new Set(remove.map(normTag));
  a.tags = [...new Set([...(a.tags || []).filter((t) => !rm.has(t)), ...add.map(normTag).filter(Boolean)])];
  a.updated = new Date().toISOString();
  return a;
}

function setReview(lib, id, { decision, flags, notes, append_note } = {}, by = "app") {
  const a = findAsset(lib, id);
  const r = a.review || { decision: "unreviewed", flags: [], notes: "" };
  if (decision !== undefined) {
    if (!DECISIONS.includes(decision)) throw new Error("decision must be one of " + DECISIONS.join(", "));
    r.decision = decision;
  }
  if (flags !== undefined) r.flags = flags.filter((f) => FLAGS[f]);
  if (notes !== undefined) r.notes = String(notes).slice(0, 8000);
  if (append_note) r.notes = (r.notes ? r.notes + "\n" : "") + "[" + by + " " + new Date().toISOString().slice(0, 10) + "] " + String(append_note).slice(0, 2000);
  r.updated = new Date().toISOString(); r.by = by;
  a.review = r; a.updated = r.updated;
  return a;
}

function updateAsset(lib, id, fields) {
  const a = findAsset(lib, id);
  for (const k of ["name", "project", "folder"]) if (typeof fields[k] === "string" && fields[k].trim()) a[k] = fields[k].trim();
  if (fields.category) { validateCategory(a.kind, fields.category); a.category = fields.category; }
  a.updated = new Date().toISOString();
  return a;
}

function deleteAsset(lib, id) {
  const i = lib.assets.findIndex((a) => a.id === id);
  if (i < 0) throw new Error("No asset with id '" + id + "'.");
  const [removed] = lib.assets.splice(i, 1);
  lib.deleted = (lib.deleted || []).slice(-199);
  lib.deleted.push({ id: removed.id, name: removed.name, file: removed.file, deleted: new Date().toISOString() });
  return removed;
}

function needsFix(a) {
  const d = a.review?.decision;
  return d === "needs_fix" || d === "regenerate" || (a.review?.flags || []).length > 0;
}

function summary(a) {
  return {
    id: a.id, kind: a.kind, name: a.name, category: a.category, tags: a.tags, project: a.project, folder: a.folder,
    file: a.file, triangles: a.kind === "model" ? a.triangles : undefined, maps: a.kind === "texture" ? Object.keys(a.maps || {}) : undefined,
    review: a.review?.decision || "unreviewed", flags: a.review?.flags || [], notes: a.review?.notes || "",
  };
}

function search(lib, q = {}) {
  const words = String(q.query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const want = (q.tags || []).map(normTag).filter(Boolean);
  const anyTags = (q.any_tags || []).map(normTag).filter(Boolean);
  let list = lib.assets.filter((a) => {
    if (q.kind && q.kind !== "all" && a.kind !== q.kind.replace(/s$/, "")) return false;
    if (q.category && a.category.toLowerCase() !== String(q.category).toLowerCase()) return false;
    if (q.project && a.project !== q.project) return false;
    if (q.review && (a.review?.decision || "unreviewed") !== q.review) return false;
    if (q.needs_fix && !needsFix(a)) return false;
    if (want.length && !want.every((t) => a.tags.includes(t))) return false;
    if (anyTags.length && !anyTags.some((t) => a.tags.includes(t))) return false;
    if (words.length) {
      const hay = [a.id, a.name, a.category, a.project, a.folder, ...(a.tags || []), a.review?.notes].join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const rank = (a) => (a.review?.decision === "approved" ? 0 : a.review?.decision === "unreviewed" ? 1 : 2);
  list.sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
  const total = list.length;
  list = list.slice(0, Math.min(Number(q.limit) || 25, 200));
  return { total, results: list.map(summary) };
}

function tagCounts(lib, { kind, prefix } = {}) {
  const counts = new Map();
  for (const a of lib.assets) {
    if (kind && a.kind !== kind) continue;
    for (const t of a.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const p = prefix ? normTag(prefix) : "";
  // One letter: tags that start with it. Longer: starts-with matches first, then tags containing it.
  return [...counts.entries()].filter(([t]) => !p || t.startsWith(p) || (p.length > 1 && t.includes(p)))
    .sort((a, b) => (p ? Number(!a[0].startsWith(p)) - Number(!b[0].startsWith(p)) : 0) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

// ── Generation requests ──

function createRequest(lib, r, by = "agent") {
  const kind = r.kind === "texture" ? "texture" : "model";
  if (r.category) validateCategory(kind, r.category);
  const req = {
    id: "req-" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), kind,
    name: r.name || "", prompt: r.prompt || "", category: r.category || "", tags: (r.tags || []).map(normTag),
    replaces: r.replaces || null, max_triangles: r.max_triangles || null, note: r.note || "",
    status: "open", created: new Date().toISOString(), by, result_asset: null,
  };
  if (req.replaces) findAsset(lib, req.replaces);
  lib.requests.push(req);
  return req;
}

function completeRequest(lib, id, assetId, by) {
  const r = lib.requests.find((x) => x.id === id);
  if (!r) throw new Error("No request '" + id + "'.");
  r.status = "done"; r.result_asset = assetId; r.completed = new Date().toISOString(); r.completed_by = by;
  return r;
}

function updateRequest(lib, id, { status, note, asset_id } = {}, by = "agent") {
  const r = lib.requests.find((x) => x.id === id);
  if (!r) throw new Error("No request '" + id + "'.");
  if (asset_id) return completeRequest(lib, id, asset_id, by);
  if (status) {
    if (!["open", "in_progress", "done", "cancelled"].includes(status)) throw new Error("status must be open, in_progress, done or cancelled");
    r.status = status;
  }
  if (note) r.note = (r.note ? r.note + "\n" : "") + note;
  r.updated = new Date().toISOString();
  return r;
}

module.exports = {
  SCHEMA, MODEL_CATEGORIES, TEXTURE_CATEGORIES, DECISIONS, FLAGS, MODEL_EXT, IMAGE_EXT,
  setDataDir, dataDir, libraryPath, thumbsDir, load, save, mutate, emptyLibrary,
  slugify, normTag, autoTags, classifyModel, classifyTexture, measureGlb, splitMap,
  importFolder, importTextureLibrary, addAsset, replaceFile, setCategory, editTags, setReview, updateAsset,
  deleteAsset, findAsset, search, summary, needsFix, tagCounts, createRequest, updateRequest, completeRequest,
};
