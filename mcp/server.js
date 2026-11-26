#!/usr/bin/env node
"use strict";
/**
 * Catalogisti MCP server (stdio, JSON-RPC 2.0, one message per line).
 *
 * Lets AI agents search the 3D model and texture library by tags, read quality
 * reviews and notes, record their own findings, register newly generated assets
 * and file generation requests (models are generated through the Modly MCP).
 *
 *   node mcp/server.js [--data-dir <folder>]
 *
 * It reads and writes the same library.json as the Catalogisti desktop app
 * (default %APPDATA%/Catalogisti/library), so the app shows agent changes live.
 */
const store = require("./store");
const readline = require("readline");

const AGENT = process.env.CATALOGISTI_AGENT || "agent";
const VERSION = (() => { try { return require("../package.json").version; } catch { return "2.0.0"; } })();

const str = (description) => ({ type: "string", description });
const arr = (description) => ({ type: "array", items: { type: "string" }, description });

const TOOLS = [
  {
    name: "search_assets",
    description: "Search the model/texture library. Combine free text, required tags (all must match), any_tags, kind, category and review state. Approved assets are listed first. Use this before generating anything new.",
    inputSchema: { type: "object", properties: {
      query: str("Free text matched against name, tags, category, project, folder and review notes"),
      tags: arr("Tags that must ALL be present, e.g. [\"brass\", \"pommel\"]"),
      any_tags: arr("At least one of these tags must be present"),
      kind: { type: "string", enum: ["model", "texture", "all"], description: "model = 3D models, texture = surface textures. Default all" },
      category: str("Exact category, see list_categories"),
      project: str("Project name"),
      review: { type: "string", enum: store.DECISIONS, description: "Only assets with this review decision" },
      needs_fix: { type: "boolean", description: "Only assets marked needs_fix/regenerate or carrying a problem flag" },
      include_hidden: { type: "boolean", description: "Also search sources the owner has unticked (hidden). Default false" },
      limit: { type: "number", description: "Max results (default 25, max 200)" },
    } },
  },
  {
    name: "get_asset",
    description: "Full record of one asset: file path, PBR maps, triangles, bounds, source image/prompt, reference images (the pictures it was made from), linked variants, previous versions and the complete quality review with notes.",
    inputSchema: { type: "object", properties: { id: str("Asset id") }, required: ["id"] },
  },
  {
    name: "find_or_request",
    description: "Find a usable asset for a need. Returns approved/unreviewed matches; when nothing usable exists it opens a generation request and tells you how to create the asset (models via the Modly MCP, textures via image generation), after which you call add_asset with the request_id.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["model", "texture"] }, tags: arr("Tags describing the need"), query: str("Extra free text"),
      category: str("Category for the new asset if one has to be made"), name: str("Name for the new asset"),
      prompt: str("Generation prompt / description to use if a new asset is needed"), max_triangles: { type: "number", description: "Triangle budget for a new model" },
      create_request: { type: "boolean", description: "Open a request when nothing fits (default true)" },
    }, required: ["kind"] },
  },
  {
    name: "list_tags",
    description: "Existing tags with usage counts, optionally filtered by a prefix (\"i\" → iron, item…). Reuse existing tags instead of inventing near-duplicates.",
    inputSchema: { type: "object", properties: { prefix: str("Tag prefix"), kind: { type: "string", enum: ["model", "texture"] } } },
  },
  {
    name: "list_categories",
    description: "Model and texture categories with asset counts, plus review decisions and problem flags you can set.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_review",
    description: "Record a quality review: decision (approved, needs_fix, regenerate, remove, unreviewed), problem flags, and notes. Use append_note to add a dated observation without erasing the owner's notes.",
    inputSchema: { type: "object", properties: {
      id: str("Asset id"), decision: { type: "string", enum: store.DECISIONS },
      flags: { type: "array", items: { type: "string", enum: Object.keys(store.FLAGS) }, description: "Replaces the flag list" },
      notes: str("Replaces the notes"), append_note: str("Appended as a dated line"),
    }, required: ["id"] },
  },
  {
    name: "edit_tags",
    description: "Add and/or remove tags on an asset.",
    inputSchema: { type: "object", properties: { id: str("Asset id"), add: arr("Tags to add"), remove: arr("Tags to remove") }, required: ["id"] },
  },
  {
    name: "update_asset",
    description: "Rename an asset, replace its categories, or change its project or folder.",
    inputSchema: { type: "object", properties: { id: str("Asset id"), name: str("New name"), categories: arr("Replaces all categories"), category: str("Make this the main category"), project: str("Project"), folder: str("Folder") }, required: ["id"] },
  },
  {
    name: "add_asset",
    description: "Register a model (.glb/.gltf) or texture image you created. Triangles and bounds are measured from the GLB. A byte-identical file with the same name is merged into the existing asset; a different file with the same name comes back with possible_duplicate_of — then call resolve_duplicate. Pass request_id to close the request it fulfils, or replaces=<asset id> to swap an existing asset to this fixed file (the old file stays in its version history).",
    inputSchema: { type: "object", properties: {
      file: str("Absolute path of the file"), kind: { type: "string", enum: ["model", "texture"] }, name: str("Display name"),
      category: str("Main category"), categories: arr("All categories (an asset can be in several)"), tags: arr("Tags"), project: str("Project"), folder: str("Folder label"),
      maps: { type: "object", description: "Texture maps by type: {normal, roughness, metallic, ao, height, orm} → absolute paths" },
      source_image: str("Source/reference image used for generation"), prompt: str("Generation prompt"), tool: str("Tool, e.g. Modly TripoSG"),
      run_ids: arr("Generation job ids"), request_id: str("Request this fulfils"), replaces: str("Asset id this file replaces"), group_with: str("Link the new asset as a variant of this asset id"), note: str("Note"),
    }, required: ["file"] },
  },
  {
    name: "delete_asset",
    description: "Remove one model or texture set from the catalog (files on disk are not deleted). whole_group also removes every linked variant. Only do this when the owner asked or the asset is marked remove.",
    inputSchema: { type: "object", properties: { id: str("Asset id"), whole_group: { type: "boolean", description: "Also remove all linked variants" } }, required: ["id"] },
  },
  {
    name: "clean_model",
    description: "Check or fix a .glb model: remove loose floating pieces (junk outside the model) and fill small holes. dry_run (default true) only reports. Applying writes <name>_clean.glb and keeps the original in the version history; vertices, UVs and skin weights are untouched.",
    inputSchema: { type: "object", properties: { id: str("Model asset id"), dry_run: { type: "boolean", description: "Only report (default true)" },
      max_piece_percent: { type: "number", description: "Remove separate pieces smaller than this % of the triangles (default 2, 0 = keep all)" },
      inside: { type: "boolean", description: "Also remove small separate pieces inside the model's outline (default false)" },
      hole_percent: { type: "number", description: "Fill holes up to this % of the model's size (default 0 = off, 5 is a good value)" } }, required: ["id"] },
  },
  {
    name: "edit_categories",
    description: "Add and/or remove categories. An asset can be in several (e.g. Railway and Props). Standard names are in list_categories; new ones are allowed.",
    inputSchema: { type: "object", properties: { id: str("Asset id"), add: arr("Categories to add"), remove: arr("Categories to remove") }, required: ["id"] },
  },
  {
    name: "resolve_duplicate",
    description: "Settle a same-name pair (see possible_duplicate_of on an asset): merge = byte-identical file in another folder, kept as one asset with an extra location; link = different files that are versions of one model; keep = genuinely different assets.",
    inputSchema: { type: "object", properties: { id: str("Asset that duplicates another"), into: str("The existing asset"), action: { type: "string", enum: ["merge", "link", "keep"] } }, required: ["id", "into", "action"] },
  },
  {
    name: "link_variants",
    description: "Link assets that are versions of the same model or texture (e.g. TripoSG and TRELLIS results, raw and reduced, old and fixed).",
    inputSchema: { type: "object", properties: { ids: arr("Asset ids to link (at least two)") }, required: ["ids"] },
  },
  {
    name: "unlink_variant",
    description: "Take an asset out of its variant group.",
    inputSchema: { type: "object", properties: { id: str("Asset id") }, required: ["id"] },
  },
  {
    name: "request_asset",
    description: "Open a generation request for a missing or broken asset (e.g. a fixed version of a model marked needs_fix). Returns step-by-step instructions.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["model", "texture"] }, name: str("Name"), prompt: str("What to generate"), category: str("Category"),
      tags: arr("Tags"), replaces: str("Asset id to replace when done"), max_triangles: { type: "number", description: "Triangle budget" }, note: str("Note"),
    }, required: ["kind", "prompt"] },
  },
  {
    name: "list_requests",
    description: "Generation requests, newest first.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "in_progress", "done", "cancelled"] } } },
  },
  {
    name: "update_request",
    description: "Mark a request in_progress/cancelled, add a note, or complete it with asset_id.",
    inputSchema: { type: "object", properties: { id: str("Request id"), status: { type: "string", enum: ["open", "in_progress", "done", "cancelled"] }, note: str("Note"), asset_id: str("Asset that fulfils it") }, required: ["id"] },
  },
  {
    name: "list_sources",
    description: "The folders the library reads models and textures from, with asset counts and whether each is ticked (enabled). Assets of unticked sources are hidden from searches.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "catalog_summary",
    description: "Counts by kind, category and review decision, open requests and assets needing fixes. Good first call.",
    inputSchema: { type: "object", properties: {} },
  },
];

function howTo(req) {
  if (req.kind === "model") {
    return [
      "1. Make or find a clean reference image (front view, plain background) for: " + (req.prompt || req.name),
      "2. Generate the mesh with the Modly MCP (image-to-3D, e.g. TripoSG/TRELLIS.2, then texture the mesh).",
      "3. Reduce it to " + (req.max_triangles ? req.max_triangles + " triangles or fewer" : "a game budget") + ", metre scale, origin at the base or mount point; export GLB with embedded textures.",
      "4. Call add_asset with file=<glb path>, request_id=" + req.id + (req.replaces ? ", replaces=" + req.replaces : "") + ", plus tags and the source image.",
      "5. Leave the review unreviewed: the owner approves in the Catalogisti app.",
    ];
  }
  return [
    "1. Generate a seamless, tileable, evenly lit texture (no perspective, no baked shadows) for: " + (req.prompt || req.name),
    "2. Optionally derive PBR maps (normal, roughness, height) with the project's PBR tool.",
    "3. Save the files, then call add_asset with kind=texture, maps={...}, request_id=" + req.id + (req.replaces ? ", replaces=" + req.replaces : "") + ".",
  ];
}

/** Fix paths of files whose folder was moved, so agents never get stale paths. */
function healPaths() {
  const lib = store.load();
  if (!store.missingCount(lib)) return;
  const st = store.relinkMoved(lib);
  if (st.files || st.source_images || st.sources) store.save(lib, AGENT);
}

function call(name, a = {}) {
  try { healPaths(); } catch { /* never block a tool call on this */ }
  switch (name) {
    case "search_assets": return store.search(store.load(), a);
    case "get_asset": {
      const lib = store.load();
      const asset = store.findAsset(lib, a.id);
      return { ...asset, reference_images: store.referencesFor(asset),
        variants: store.groupMembers(lib, asset).filter((x) => x.id !== asset.id).map(store.summary) };
    }
    case "edit_categories": return store.summary(store.mutate((lib) => store.editCategories(lib, a.id, a.add || [], a.remove || []), AGENT));
    case "resolve_duplicate": {
      const r = store.mutate((lib) => store.resolveDuplicate(lib, a.id, a.into, a.action), AGENT);
      return Array.isArray(r) ? r.map(store.summary) : store.summary(r);
    }
    case "link_variants": return store.mutate((lib) => store.linkAssets(lib, a.ids || []), AGENT).map(store.summary);
    case "unlink_variant": return store.summary(store.mutate((lib) => store.unlinkAsset(lib, a.id), AGENT));
    case "list_tags": return store.tagCounts(store.load(), a).slice(0, 200);
    case "list_categories": {
      const lib = store.load();
      const count = (kind, c) => lib.assets.filter((x) => x.kind === kind && x.category === c).length;
      return {
        models: store.MODEL_CATEGORIES.map((c) => ({ category: c, count: count("model", c) })),
        textures: store.TEXTURE_CATEGORIES.map((c) => ({ category: c, count: count("texture", c) })),
        decisions: store.DECISIONS, flags: store.FLAGS,
      };
    }
    case "list_sources": return store.listSources(store.load());
    case "catalog_summary": {
      const lib = store.load();
      const shown = store.visibleAssets(lib);
      const by = (f) => shown.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
      return {
        data_folder: store.dataDir(), assets: shown.length, hidden_by_unticked_sources: lib.assets.length - shown.length, by_kind: by((x) => x.kind),
        by_category: by((x) => x.kind + " / " + x.category), by_review: by((x) => x.review?.decision || "unreviewed"),
        needs_fix: shown.filter(store.needsFix).map(store.summary),
        open_requests: lib.requests.filter((r) => r.status === "open" || r.status === "in_progress"),
      };
    }
    case "set_review": return store.summary(store.mutate((lib) => store.setReview(lib, a.id, a, AGENT), AGENT));
    case "edit_tags": return store.summary(store.mutate((lib) => store.editTags(lib, a.id, a.add || [], a.remove || []), AGENT));
    case "update_asset": return store.summary(store.mutate((lib) => store.updateAsset(lib, a.id, a), AGENT));
    case "add_asset": return store.summary(store.mutate((lib) => store.addAsset(lib, a, AGENT), AGENT));
    case "clean_model": {
      const path = require("path"), fs = require("fs"), meshclean = require("./meshclean");
      const asset = store.findAsset(store.load(), a.id);
      if (!/\.glb$/i.test(asset.file)) throw new Error("Only .glb models can be cleaned.");
      const opts = { maxPercent: a.max_piece_percent ?? 2, inside: !!a.inside, holePercent: a.hole_percent ?? 0 };
      const report = meshclean.analyzeGlb(asset.file, opts);
      if (a.dry_run !== false) return { dry_run: true, report };
      const stem = path.basename(asset.file, ".glb").replace(/_clean(_\d+)?$/, "");
      let out = path.join(path.dirname(asset.file), stem + "_clean.glb"), n = 2;
      while (fs.existsSync(out)) out = path.join(path.dirname(asset.file), stem + "_clean_" + n++ + ".glb");
      const r = meshclean.cleanGlb(asset.file, out, opts);
      if (r.changed) store.mutate((lib) => store.replaceFile(lib, a.id, out, "Cleaned up by agent: " + r.removedPieces + " loose piece(s), " + r.filledHoles + " hole(s) filled", AGENT), AGENT);
      return { ...r, file: r.changed ? out : asset.file, report };
    }
    case "delete_asset": {
      const removed = store.mutate((lib) => store.deleteAsset(lib, a.id, { wholeGroup: !!a.whole_group }), AGENT);
      return { deleted: removed.map((r) => r.id), files_kept_on_disk: removed.flatMap(store.ownedFiles) };
    }
    case "request_asset": {
      const req = store.mutate((lib) => store.createRequest(lib, a, AGENT), AGENT);
      return { request: req, next_steps: howTo(req) };
    }
    case "list_requests": {
      const lib = store.load();
      return lib.requests.filter((r) => !a.status || r.status === a.status).slice().reverse();
    }
    case "update_request": return store.mutate((lib) => store.updateRequest(lib, a.id, a, AGENT), AGENT);
    case "find_or_request": {
      const lib = store.load();
      const found = store.search(lib, { kind: a.kind, any_tags: a.tags, query: a.query, category: a.category, limit: 15 });
      const want = (a.tags || []).map(store.normTag);
      const scored = found.results
        .filter((r) => r.review !== "remove")
        .map((r) => ({ ...r, tag_matches: r.tags.filter((t) => want.includes(t)).length }))
        .sort((x, y) => Number(y.review === "approved") - Number(x.review === "approved") || y.tag_matches - x.tag_matches);
      const usable = scored.filter((r) => r.review === "approved" || r.review === "unreviewed");
      if (usable.length || a.create_request === false) return { matches: scored, request: null };
      const req = store.mutate((l) => store.createRequest(l, {
        kind: a.kind, name: a.name, prompt: a.prompt || [a.query, ...(a.tags || [])].filter(Boolean).join(", "),
        category: a.category, tags: a.tags, max_triangles: a.max_triangles,
      }, AGENT), AGENT);
      return { matches: scored, request: req, next_steps: howTo(req) };
    }
    default: throw new Error("Unknown tool " + name);
  }
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "catalogisti", version: VERSION },
      instructions: "Catalogisti is the owner's 3D model and texture library. Search it (search_assets / find_or_request) before generating assets, reuse existing tags (list_tags), and record review findings with set_review append_note. New models are generated through the Modly MCP and registered with add_asset.",
    } });
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try {
      const result = call(params.name, params.arguments || {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] } });
    } catch (error) {
      return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(error.message || error) }] } });
    }
  }
  if (id !== undefined && method) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    try { handle(msg); } catch (error) { if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(error.message || error) } }); }
  });
}

module.exports = { TOOLS, call };
