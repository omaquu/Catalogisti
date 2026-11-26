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
    for (const a of lib.assets) normalizeCategories(a);
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
  ["Weapon parts", /pommel|grip|handle|guard|crossguard|nozzle|barrel|blade|hammer.?head|axe.?head|cartridge|regulator|bellows|scope|trigger|muzzle|weapon|sword|gun|shotgun|rifle|pistol/],
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
  return classifyModels(text)[0];
}

/** Every model category whose keywords match (an asset can be Railway and Props at once), at most three. */
function classifyModels(text, extra) {
  const t = String(text).toLowerCase().replace(/_/g, " ");
  const out = extra && MODEL_CATEGORIES.includes(extra) ? [extra] : [];
  // Whole words only (plural allowed): "gun" must not match "burgundy", "man" not "mansard", "rock" not "rockingchair".
  for (const [cat, re] of MODEL_RULES) if (new RegExp("\\b(?:" + re.source + ")(?:e?s)?\\b").test(t) && !out.includes(cat)) out.push(cat);
  // Shin/thigh guards are armor, not weapon guards.
  if (out.includes("Armor") && out.includes("Weapon parts") && !/pommel|crossguard|handguard|nozzle|blade|cartridge/.test(t)) out.splice(out.indexOf("Weapon parts"), 1);
  return (out.length ? out : ["Props"]).slice(0, 3);
}

/** categories[] is the source of truth; category mirrors its first entry for older readers. */
function normalizeCategories(a) {
  let list = Array.isArray(a.categories) ? a.categories : [];
  if (!Array.isArray(a.categories) && a.category) list = [a.category]; // older records
  list = [...new Set(list.map((c) => String(c).trim()).filter(Boolean))];
  if (!list.length) list = ["Other"];
  a.categories = list;
  a.category = list[0];
  return a;
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
  const relinked = missingCount(lib) ? relinkMoved(lib, [root]) : null;
  project = project || path.basename(root);
  const added = [], skipped = [];
  const known = new Set(lib.assets.flatMap((a) => [a.file, ...(a.locations || []), ...Object.values(a.maps || {})]).filter(Boolean).map((f) => path.resolve(f).toLowerCase()));
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
      const categories = classifyModels(stem + " " + (meta.role || "") + " " + folder, meta.category);
      const asset = {
        id: uniqueId(lib, stem), kind: "model", name, category: categories[0], categories,
        tags: autoTags(stem, [meta.role, folder]), project, folder, file,
        triangles: m.triangles, embedded_images: m.images, bounds: m.bounds || meta.bounds_m || null,
        ...fileInfo(file),
        source: cleanSource({ image: meta.image, prompt: meta.prompt, tool: meta.geom_run_id ? "Modly" : meta.tool, run_ids: [meta.geom_run_id, meta.tex_run_id].filter(Boolean), budget: meta.faces || meta.max_faces }),
        versions: [], review: { decision: "unreviewed", flags: [], notes: "", updated: null, by: null },
        created: now, updated: now, added_by: by,
      };
      normalizeCategories(asset);
      restoreArchived(lib, asset);
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
      normalizeCategories(asset);
      restoreArchived(lib, asset);
      lib.assets.push(asset); added.push(asset.id);
    }
  }
  const existing = lib.projects.find((p) => p.path.toLowerCase() === root.toLowerCase());
  if (existing) delete existing.enabled; // importing a folder again ticks it again
  else lib.projects.push({ name: project, path: root, kind, imported: now });
  const duplicates = findDuplicates(lib, added);
  for (const d of duplicates) lib.assets.find((x) => x.id === d.id).possible_duplicate_of = d.matches.map((m) => m.id);
  return { added: added.length, skipped: skipped.length, ids: added, duplicates, relinked };
}

/** Import tiling surface textures (walls, ground…) from a shared texture library catalog.json. */
function importTextureLibrary(lib, catalogFile, { by = "app" } = {}) {
  const cat = JSON.parse(fs.readFileSync(catalogFile, "utf-8"));
  const root = cat.library || path.dirname(catalogFile);
  const known = new Set(lib.assets.flatMap((a) => [a.file, ...(a.locations || [])]).filter(Boolean).map((f) => f.toLowerCase()));
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
  if (added && !lib.projects.some((p) => p.path.toLowerCase() === String(root).toLowerCase()))
    lib.projects.push({ name: "Texture Library", path: root, kind: "texture-library", imported: now });
  return { added };
}

// ── Import sources (the folders models and textures are read from) ──

function under(file, dir) {
  if (!file || !dir) return false;
  const f = path.resolve(file).toLowerCase(), d = path.resolve(dir).toLowerCase().replace(/[\\/]+$/, "");
  return f === d || f.startsWith(d + path.sep);
}

/** Every folder the library reads from, with how many assets each holds. Assets added one by one are grouped by project. */
function listSources(lib) {
  const out = lib.projects.map((p) => ({ name: p.name, path: p.path, kind: p.kind, imported: p.imported, enabled: p.enabled !== false, missing: !exists(p.path),
    count: lib.assets.filter((a) => [a.file, ...(a.locations || [])].some((f) => under(f, p.path))).length }));
  const loose = new Map();
  for (const a of lib.assets) {
    if (lib.projects.some((p) => under(a.file, p.path))) continue;
    loose.set(a.project || "Unsorted", (loose.get(a.project || "Unsorted") || 0) + 1);
  }
  for (const [name, count] of loose) out.push({ name, path: null, kind: "files", count, enabled: !(lib.hidden_projects || []).includes(name) });
  return out;
}

/** Tick or untick a source. Unticked sources stay in the library (with their reviews) but their assets are hidden. */
function setSourceEnabled(lib, { path: dir, project } = {}, enabled = true) {
  if (dir) {
    const p = lib.projects.find((x) => path.resolve(x.path).toLowerCase() === path.resolve(dir).toLowerCase());
    if (!p) throw new Error("No source " + dir);
    if (enabled) delete p.enabled; else p.enabled = false;
  } else if (project) {
    const hidden = new Set(lib.hidden_projects || []);
    if (enabled) hidden.delete(project); else hidden.add(project);
    lib.hidden_projects = [...hidden];
    if (!lib.hidden_projects.length) delete lib.hidden_projects;
  } else throw new Error("setSourceEnabled needs a path or a project name.");
  return listSources(lib);
}

/**
 * Is the asset in a ticked source? An asset is shown when any of its files lies in a ticked folder source,
 * or when it was added on its own (no folder source) and its project is not hidden.
 */
function isVisible(lib, a) {
  const files = [a.file, ...(a.locations || [])];
  let inSource = false;
  for (const p of lib.projects) {
    if (!files.some((f) => under(f, p.path))) continue;
    if (p.enabled !== false) return true;
    inSource = true;
  }
  return !inSource && !(lib.hidden_projects || []).includes(a.project || "Unsorted");
}

function visibleAssets(lib) {
  return lib.assets.filter((a) => isVisible(lib, a));
}

function archiveAsset(lib, a) {
  lib.archive ??= {};
  const keep = { name: a.name, tags: a.tags, categories: a.categories, review: a.review, versions: a.versions, source: a.source, removed: new Date().toISOString() };
  for (const f of [a.file, ...(a.locations || [])]) if (f) lib.archive[f.toLowerCase()] = keep;
  const keys = Object.keys(lib.archive);
  if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete lib.archive[k];
}

/** A file that comes back after its source was removed gets its old review, tags and categories again. */
function restoreArchived(lib, asset) {
  const old = lib.archive?.[String(asset.file).toLowerCase()];
  if (!old) return asset;
  Object.assign(asset, { name: old.name || asset.name, tags: old.tags || asset.tags, categories: old.categories || asset.categories,
    review: old.review || asset.review, versions: old.versions || asset.versions, source: asset.source || old.source });
  normalizeCategories(asset);
  delete lib.archive[String(asset.file).toLowerCase()];
  return asset;
}

/**
 * Stop reading from a source: removes its folder entry and every asset whose files are all inside it.
 * An asset that also lives elsewhere keeps its other location. Files on disk are never touched; reviews
 * are archived and come back if the same files are imported again.
 * Pass {path} for a folder source, or {project} for assets added one by one.
 */
function removeSource(lib, { path: dir, project } = {}) {
  if (!dir && !project) throw new Error("removeSource needs a path or a project name.");
  const inside = (f) => (dir ? under(f, dir) : false);
  let removed = 0, kept = 0;
  const survivors = [];
  for (const a of lib.assets) {
    const match = dir ? [a.file, ...(a.locations || [])].some(inside)
      : (a.project || "Unsorted") === project && !lib.projects.some((p) => under(a.file, p.path));
    if (!match) { survivors.push(a); continue; }
    const elsewhere = dir ? [a.file, ...(a.locations || [])].filter((f) => !inside(f)) : [];
    if (elsewhere.length) {
      a.file = elsewhere[0];
      a.locations = elsewhere.slice(1);
      if (!a.locations.length) delete a.locations;
      try { Object.assign(a, fileInfo(a.file)); } catch { /* missing */ }
      a.updated = new Date().toISOString();
      survivors.push(a);
      kept++;
    } else {
      archiveAsset(lib, a);
      removed++;
    }
  }
  const gone = new Set(lib.assets.filter((a) => !survivors.includes(a)).map((a) => a.id));
  lib.assets = survivors;
  // Drop references to removed assets: variant groups of one, same-name hints.
  for (const g of new Set(lib.assets.map((a) => a.group).filter(Boolean))) {
    const members = lib.assets.filter((a) => a.group === g);
    if (members.length === 1) delete members[0].group;
  }
  for (const a of lib.assets) if (a.possible_duplicate_of) {
    a.possible_duplicate_of = a.possible_duplicate_of.filter((id) => !gone.has(id));
    if (!a.possible_duplicate_of.length) delete a.possible_duplicate_of;
  }
  if (dir) lib.projects = lib.projects.filter((p) => path.resolve(p.path).toLowerCase() !== path.resolve(dir).toLowerCase());
  return { removed, kept_elsewhere: kept, removed_ids: [...gone] };
}

/** Empty the whole library (every source). Reviews are archived the same way. */
function clearLibrary(lib) {
  for (const a of lib.assets) archiveAsset(lib, a);
  const removed = lib.assets.length;
  lib.assets = [];
  lib.projects = [];
  return { removed };
}

// ── Moved folders: find files again after a folder was moved or renamed ──

function exists(p) { try { return !!p && fs.existsSync(p); } catch { return false; } }

function applyPathMap(lib, p) {
  for (const m of lib.path_map || []) if (under(p, m.from)) return path.join(m.to, path.relative(m.from, p));
  return null;
}

/** Folders worth searching: every source folder that exists, their parents, folders the owner pointed at, and learned targets. */
function searchRoots(lib, extra = []) {
  const roots = new Set();
  const add = (d) => { if (d && exists(d)) roots.add(path.resolve(d)); };
  for (const d of extra) { add(d); add(path.dirname(d)); }
  for (const p of lib.projects) if (exists(p.path)) { add(p.path); add(path.dirname(p.path)); add(path.dirname(path.dirname(p.path))); }
  for (const d of lib.search_roots || []) { add(d); add(path.dirname(d)); }
  for (const m of lib.path_map || []) add(m.to);
  return [...roots];
}

/**
 * Where is this (missing) file now? Tries learned folder moves first, then looks for the same trailing
 * folder structure under the search roots: .../source_art/optimized/chair.glb is found again as
 * <root>/optimized/chair.glb. A match on two or more path parts teaches a folder move, so every other
 * file from the same old folder resolves instantly.
 */
function resolveMoved(lib, p, roots) {
  if (!p || exists(p)) return p;
  const mapped = applyPathMap(lib, p);
  if (mapped && exists(mapped)) return mapped;
  const segs = path.resolve(p).split(/[\\/]+/).filter(Boolean);
  for (let k = Math.min(segs.length - 1, 6); k >= 1; k--) {
    const tail = segs.slice(-k);
    for (const r of roots) {
      const cand = path.join(r, ...tail);
      if (!exists(cand)) continue;
      if (k >= 2) {
        const from = segs.slice(0, segs.length - k).join(path.sep).replace(/^([A-Za-z]:)(?=[^\\/]|$)/, "$1" + path.sep);
        lib.path_map = (lib.path_map || []).filter((m) => path.resolve(m.from).toLowerCase() !== path.resolve(from).toLowerCase());
        lib.path_map.push({ from, to: r, learned: new Date().toISOString() });
      }
      return cand;
    }
  }
  return p;
}

/** Repair every stored path (models, other locations, maps, source images, old versions, source folders). */
function relinkMoved(lib, extraRoots = []) {
  const roots = searchRoots(lib, extraRoots);
  const stats = { files: 0, source_images: 0, sources: 0, still_missing: 0 };
  if (!roots.length) return stats;
  const fix = (p, key) => { const q = resolveMoved(lib, p, roots); if (q !== p) stats[key]++; return q; };
  for (const pr of lib.projects) {
    if (exists(pr.path)) continue;
    const mapped = applyPathMap(lib, pr.path);
    if (mapped && exists(mapped)) { pr.path = mapped; stats.sources++; }
  }
  for (const a of lib.assets) {
    a.file = fix(a.file, "files");
    if (a.locations) a.locations = a.locations.map((f) => fix(f, "files"));
    if (a.maps) for (const k of Object.keys(a.maps)) a.maps[k] = fix(a.maps[k], "files");
    if (a.source?.image) a.source.image = fix(a.source.image, "source_images");
    for (const v of a.versions || []) v.file = fix(v.file, "files");
    if (!exists(a.file)) stats.still_missing++;
  }
  // Sources whose folder moved resolve once a file inside them taught the move.
  for (const pr of lib.projects) {
    if (exists(pr.path)) continue;
    const mapped = applyPathMap(lib, pr.path);
    if (mapped && exists(mapped)) { pr.path = mapped; stats.sources++; }
  }
  // Two entries can now point at the same folder: keep one.
  const seen = new Set();
  lib.projects = lib.projects.filter((pr) => { const k = path.resolve(pr.path).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  return stats;
}

/** The owner points at the new place of a missing source folder. */
function locateSource(lib, oldPath, newPath) {
  if (!exists(newPath)) throw new Error("Folder not found: " + newPath);
  lib.path_map = (lib.path_map || []).filter((m) => path.resolve(m.from).toLowerCase() !== path.resolve(oldPath).toLowerCase());
  lib.path_map.push({ from: path.resolve(oldPath), to: path.resolve(newPath), learned: new Date().toISOString() });
  lib.search_roots = [...new Set([...(lib.search_roots || []), path.resolve(newPath)])];
  return relinkMoved(lib, [newPath]);
}

function missingCount(lib) {
  return lib.assets.filter((a) => !exists(a.file)).length + lib.projects.filter((p) => !exists(p.path)).length;
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
    categories: opts.categories || (opts.category ? [opts.category] : kind === "model" ? classifyModels(stem) : [classifyTexture(stem)]),
    tags: [...new Set([...(opts.tags || []).map(normTag), ...autoTags(stem)])].filter(Boolean),
    project: opts.project || "Unsorted", folder: opts.folder || path.basename(path.dirname(file)), file,
    ...(kind === "model" ? { triangles: m.triangles || 0, embedded_images: m.images || 0, bounds: m.bounds || null } : { maps: { albedo: file, ...(opts.maps || {}) }, tiling: opts.tiling ?? true }),
    ...fileInfo(file),
    source: cleanSource({ image: opts.source_image, prompt: opts.prompt, tool: opts.tool, run_ids: opts.run_ids }),
    versions: [], review: { decision: "unreviewed", flags: [], notes: opts.note || "", updated: null, by: null },
    created: now, updated: now, added_by: by,
  };
  normalizeCategories(asset);
  lib.assets.push(asset);
  if (opts.group_with) linkAssets(lib, [opts.group_with, asset.id]);
  const dup = findDuplicates(lib, [asset.id])[0];
  if (dup) {
    const same = dup.matches.find((m) => m.identical);
    if (same) {
      // Byte-identical file under the same name: one model in two places.
      const kept = resolveDuplicate(lib, asset.id, same.id, "merge");
      if (opts.request_id) completeRequest(lib, opts.request_id, kept.id, by);
      return { ...kept, merged_into_existing: true };
    }
    asset.possible_duplicate_of = dup.matches.map((m) => m.id);
  }
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
  // Categories work like tags: the standard lists are suggestions, owners may add their own.
  if (!category || String(category).trim().length > 40) throw new Error("A category needs a name of 1-40 characters.");
}

/** Add/remove categories like tags. Removing the last one leaves "Other". */
function editCategories(lib, id, add = [], remove = []) {
  const a = findAsset(lib, id);
  for (const c of add) validateCategory(a.kind, c);
  const rm = new Set(remove.map((c) => String(c).toLowerCase()));
  a.categories = [...(a.categories || []).filter((c) => !rm.has(c.toLowerCase())), ...add.map((c) => String(c).trim())];
  normalizeCategories(a);
  a.updated = new Date().toISOString();
  return a;
}

function setCategory(lib, id, category) {
  const a = findAsset(lib, id);
  validateCategory(a.kind, category);
  a.categories = [category]; normalizeCategories(a); a.updated = new Date().toISOString();
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
  if (Array.isArray(fields.categories) && fields.categories.length) { a.categories = fields.categories; normalizeCategories(a); }
  else if (fields.category) { validateCategory(a.kind, fields.category); a.categories = [fields.category, ...(a.categories || []).filter((c) => c !== fields.category)]; normalizeCategories(a); }
  a.updated = new Date().toISOString();
  return a;
}

/** Files that belong to one catalog entry: the model file, or every map of a texture set. Never source images. */
function ownedFiles(a) {
  const files = new Set([a.file, ...(a.locations || []), ...(a.kind === "texture" ? Object.values(a.maps || {}) : [])].filter(Boolean));
  return [...files];
}

/**
 * Remove catalog entries. wholeGroup=false removes just this one model/texture set;
 * wholeGroup=true removes every variant linked to it. Returns the removed records.
 */
function deleteAsset(lib, id, { wholeGroup = false } = {}) {
  const a = findAsset(lib, id);
  const ids = new Set(wholeGroup && a.group ? groupMembers(lib, a).map((x) => x.id) : [id]);
  const removed = lib.assets.filter((x) => ids.has(x.id));
  lib.assets = lib.assets.filter((x) => !ids.has(x.id));
  lib.deleted = (lib.deleted || []).slice(-199);
  for (const r of removed) lib.deleted.push({ id: r.id, name: r.name, file: r.file, deleted: new Date().toISOString() });
  // A group left with a single member is no longer a group.
  if (a.group) {
    const rest = lib.assets.filter((x) => x.group === a.group);
    if (rest.length === 1) delete rest[0].group;
  }
  return removed;
}

// ── Variant groups: the same model in several versions (e.g. TripoSG and TRELLIS, raw and reduced) ──

function groupMembers(lib, a) {
  return a.group ? lib.assets.filter((x) => x.group === a.group) : [a];
}

function linkAssets(lib, ids) {
  const assets = [...new Set(ids)].map((id) => findAsset(lib, id));
  if (assets.length < 2) throw new Error("Link needs at least two assets.");
  const kinds = new Set(assets.map((a) => a.kind));
  if (kinds.size > 1) throw new Error("Only assets of the same kind (model or texture) can be linked.");
  const group = assets.find((a) => a.group)?.group || "grp-" + assets[0].id;
  const oldGroups = new Set(assets.map((a) => a.group).filter(Boolean));
  for (const x of lib.assets) if (assets.includes(x) || (x.group && oldGroups.has(x.group))) { x.group = group; x.updated = new Date().toISOString(); }
  return lib.assets.filter((x) => x.group === group);
}

function unlinkAsset(lib, id) {
  const a = findAsset(lib, id);
  const g = a.group;
  delete a.group;
  if (g) {
    const rest = lib.assets.filter((x) => x.group === g);
    if (rest.length === 1) delete rest[0].group;
  }
  return a;
}

const VARIANT_SUFFIX = /([_\-. ](v\d+|gr|game[_-]?ready|textured|texture|tex|baked|bake|optimized|optimised|opt|reduced|decimated|lod\d|final|fixed|fix|triposg|trellis\d?|hunyuan|raw|high|low|hi|lo|\d{1,2}k|copy|new|old))+$/i;
const VIEW_SUFFIX = /[_\-. ](front|back|left|right|top|bottom|side|front45|rear45|input|source|ref|reference|view|views)\d*$/i;

function variantKey(a) {
  const stem = path.basename(a.file || "", path.extname(a.file || "")).toLowerCase();
  return a.kind + ":" + stem.replace(VARIANT_SUFFIX, "");
}

/** Link assets that are clearly versions of one model: same base name, or made from the same source image. */
function autoGroup(lib, onlyIds) {
  const scope = onlyIds ? new Set(onlyIds) : null;
  const buckets = new Map();
  const add = (k, a) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(a); };
  for (const a of lib.assets) {
    add("name|" + variantKey(a), a);
    if (a.source?.image) add("src|" + a.kind + "|" + a.source.image.toLowerCase(), a);
  }
  let linked = 0;
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 12) continue;
    if (scope && !list.some((a) => scope.has(a.id))) continue;
    const groups = new Set(list.map((a) => a.group || a.id));
    if (groups.size < 2 && list.every((a) => a.group)) continue;
    linkAssets(lib, list.map((a) => a.id));
    linked += list.length;
  }
  return { linked };
}

// ── Same-name check: identical copies are merged, different files may be linked as variants ──

function fileHash(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function identicalFiles(a, b) {
  if (!a.file || !b.file || a.size !== b.size) return false;
  a.sha256 ??= fileHash(a.file);
  b.sha256 ??= fileHash(b.file);
  return !!a.sha256 && a.sha256 === b.sha256;
}

function sameNameKey(a) {
  return a.kind + ":" + String(a.name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** For the given (new) ids: other assets with the same name, and whether the file is byte-identical. */
function findDuplicates(lib, ids) {
  const byKey = new Map();
  for (const a of lib.assets) {
    for (const k of new Set([sameNameKey(a), variantKey(a)])) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(a); }
  }
  const order = new Map(lib.assets.map((a, i) => [a.id, i]));
  const fresh = new Set(ids);
  const out = [];
  for (const id of ids) {
    const a = lib.assets.find((x) => x.id === id);
    if (!a) continue;
    const seen = new Set();
    const matches = [];
    for (const k of new Set([sameNameKey(a), variantKey(a)])) {
      for (const b of byKey.get(k) || []) {
        if (b.id === a.id || seen.has(b.id)) continue;
        // Report each pair once: a new asset against older ones, or against new ones earlier in the batch.
        if (fresh.has(b.id) && order.get(b.id) > order.get(a.id)) continue;
        if ((a.not_duplicate_of || []).includes(b.id) || (b.not_duplicate_of || []).includes(a.id)) continue;
        if (a.group && a.group === b.group) continue;
        seen.add(b.id);
        matches.push({ id: b.id, name: b.name, file: b.file, identical: identicalFiles(a, b) });
      }
    }
    if (matches.length) out.push({ id: a.id, name: a.name, file: a.file, matches });
  }
  return out;
}

/**
 * action "merge": one model in two places — keep `into`, record this file as another location, drop this entry.
 * action "link": keep both as variants of one model. action "keep": separate assets, do not ask again.
 */
function resolveDuplicate(lib, id, into, action) {
  const a = findAsset(lib, id), b = findAsset(lib, into);
  delete a.possible_duplicate_of;
  if (action === "link") return linkAssets(lib, [into, id]).find((x) => x.id === into);
  if (action === "keep") {
    a.not_duplicate_of = [...new Set([...(a.not_duplicate_of || []), into])];
    return a;
  }
  if (action !== "merge") throw new Error("action must be merge, link or keep");
  b.locations = [...new Set([...(b.locations || []), a.file, ...(a.locations || [])])].filter((f) => f !== b.file);
  b.tags = [...new Set([...(b.tags || []), ...(a.tags || [])])];
  b.categories = [...new Set([...(b.categories || []), ...(a.categories || [])])];
  normalizeCategories(b);
  if ((b.review?.decision || "unreviewed") === "unreviewed" && a.review?.decision && a.review.decision !== "unreviewed") b.review = a.review;
  b.updated = new Date().toISOString();
  lib.assets = lib.assets.filter((x) => x.id !== id);
  return b;
}

// ── Source / reference images that a model was made from ──

const dirCache = new Map();
function listImages(dir) {
  if (dirCache.has(dir)) return dirCache.get(dir);
  let out = [];
  try { out = fs.readdirSync(dir).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())).map((f) => path.join(dir, f)); } catch { /* missing */ }
  dirCache.set(dir, out);
  setTimeout(() => dirCache.delete(dir), 30000).unref?.();
  return out;
}

function containsWord(hay, needle) {
  const i = hay.indexOf(needle);
  if (i < 0 || needle.length < 4) return false;
  const before = hay[i - 1], after = hay[i + needle.length];
  return (!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z]/.test(after));
}

/** Reference images for an asset: its recorded source image, the other views of it, and images named after the model. */
function referencesFor(a) {
  if (a.kind !== "model") return [];
  const refs = new Set(a.source?.image && fs.existsSync(a.source.image) ? [a.source.image] : []);
  const keys = new Set();
  const stem = path.basename(a.file, path.extname(a.file)).toLowerCase().replace(VARIANT_SUFFIX, "");
  keys.add(stem);
  if (a.source?.image) keys.add(path.basename(a.source.image, path.extname(a.source.image)).toLowerCase().replace(VIEW_SUFFIX, ""));
  const dir = path.dirname(a.file);
  const dirs = new Set([dir, path.join(dir, "references"), path.join(dir, "refs"), path.join(dir, "..", "references"), path.join(dir, "source")]);
  if (a.source?.image) dirs.add(path.dirname(a.source.image));
  for (const d of dirs) {
    for (const img of listImages(d)) {
      const s = path.basename(img, path.extname(img)).toLowerCase();
      if ([...keys].some((k) => s === k || containsWord(s, k))) refs.add(img);
    }
  }
  return [...refs].slice(0, 24);
}

/** Make an older version current again; the current file goes into the history. */
function restoreVersion(lib, id, index, by = "app") {
  const a = findAsset(lib, id);
  const v = (a.versions || [])[index];
  if (!v) throw new Error("No version " + index + ".");
  if (!fs.existsSync(v.file)) throw new Error("That version's file no longer exists: " + v.file);
  a.versions.splice(index, 1);
  replaceFile(lib, id, v.file, "Restored earlier version", by);
  if (v.review) a.review = { ...v.review, notes: (v.review.notes ? v.review.notes + "\n" : "") + "[restored " + new Date().toISOString().slice(0, 10) + "]" };
  return a;
}

function needsFix(a) {
  const d = a.review?.decision;
  return d === "needs_fix" || d === "regenerate" || (a.review?.flags || []).length > 0;
}

function summary(a) {
  return {
    id: a.id, kind: a.kind, name: a.name, categories: a.categories || [a.category], tags: a.tags, locations: a.locations?.length ? [a.file, ...a.locations] : undefined, project: a.project, folder: a.folder,
    file: a.file, group: a.group || undefined, triangles: a.kind === "model" ? a.triangles : undefined, maps: a.kind === "texture" ? Object.keys(a.maps || {}) : undefined,
    review: a.review?.decision || "unreviewed", flags: a.review?.flags || [], notes: a.review?.notes || "",
  };
}

function search(lib, q = {}) {
  const words = String(q.query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const want = (q.tags || []).map(normTag).filter(Boolean);
  const anyTags = (q.any_tags || []).map(normTag).filter(Boolean);
  let list = lib.assets.filter((a) => {
    if (!q.include_hidden && !isVisible(lib, a)) return false;
    if (q.kind && q.kind !== "all" && a.kind !== q.kind.replace(/s$/, "")) return false;
    if (q.category && !(a.categories || [a.category]).some((c) => c.toLowerCase() === String(q.category).toLowerCase())) return false;
    if (q.project && a.project !== q.project) return false;
    if (q.review && (a.review?.decision || "unreviewed") !== q.review) return false;
    if (q.needs_fix && !needsFix(a)) return false;
    if (want.length && !want.every((t) => a.tags.includes(t))) return false;
    if (anyTags.length && !anyTags.some((t) => a.tags.includes(t))) return false;
    if (words.length) {
      const hay = [a.id, a.name, ...(a.categories || [a.category]), a.project, a.folder, ...(a.tags || []), a.review?.notes].join(" ").toLowerCase();
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
  for (const a of visibleAssets(lib)) {
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
  relinkMoved, locateSource, resolveMoved, missingCount, listSources, setSourceEnabled, isVisible, visibleAssets, removeSource, clearLibrary, classifyModels, normalizeCategories, findDuplicates, resolveDuplicate, identicalFiles, editCategories, deleteAsset, ownedFiles, groupMembers, linkAssets, unlinkAsset, autoGroup, referencesFor, restoreVersion, findAsset, search, summary, needsFix, tagCounts, createRequest, updateRequest, completeRequest,
};
