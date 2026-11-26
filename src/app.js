(() => {
  "use strict";
  const api = window.catalogisti;
  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("en-US");
  const DECISION_LABEL = { unreviewed: "Unreviewed", approved: "Approved", needs_fix: "Needs fix", regenerate: "Regenerate", remove: "Remove" };
  const PAGE = 300;

  let lib = { assets: [], requests: [] };
  let info = null;
  const state = { view: "all", kind: "", category: "", project: "", tag: "", selected: null, limit: PAGE, mapView: "albedo" };
  const thumbFailed = new Set();
  let thumbBusy = false;

  function el(tag, props = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "dataset") Object.assign(n.dataset, v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  }

  /** C:\a\b.glb → asset://local/C/a/b.glb (served by the main process). */
  function toUrl(p) {
    if (!p) return "";
    const parts = String(p).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1").split("/").filter(Boolean);
    return "asset://local/" + parts.map(encodeURIComponent).join("/");
  }
  function thumbUrl(a) {
    return a.thumbnail ? toUrl(info.dataDir + "/" + a.thumbnail) + "?v=" + encodeURIComponent(a.thumb_mtime || "") : "";
  }
  function bytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB"; }
  function decision(a) { return a.review?.decision || "unreviewed"; }
  function needsFix(a) { const d = decision(a); return d === "needs_fix" || d === "regenerate" || (a.review?.flags || []).length > 0; }
  function selectedAsset() { return lib.assets.find((a) => a.id === state.selected) || null; }
  function say(text) { $("message").textContent = text || ""; }

  async function call(fn, ...args) {
    try { return await fn(...args); } catch (error) { say("⚠ " + error.message); throw error; }
  }

  async function reload() {
    lib = await api.getLibrary();
    renderAll();
  }

  // ── Filtering ──
  function queryParts() {
    const words = [], tags = [];
    for (const w of $("query").value.toLowerCase().split(/\s+/).filter(Boolean)) (w.startsWith("#") ? tags : words).push(w.replace(/^#+/, ""));
    return { words, tags };
  }

  function results() {
    const { words, tags } = queryParts();
    let list = lib.assets.filter((a) => {
      if (state.view === "models" && a.kind !== "model") return false;
      if (state.view === "textures" && a.kind !== "texture") return false;
      if (state.view === "needs_fix" && !needsFix(a)) return false;
      if (state.view === "unreviewed" && decision(a) !== "unreviewed") return false;
      if (state.view === "approved" && decision(a) !== "approved") return false;
      if (state.view === "remove" && decision(a) !== "remove") return false;
      if (state.kind && a.kind !== state.kind) return false;
      if (state.category && a.category !== state.category) return false;
      if (state.project && a.project !== state.project) return false;
      if (state.tag && !(a.tags || []).includes(state.tag)) return false;
      if (tags.length && !tags.every((t) => (a.tags || []).some((x) => x.startsWith(t)))) return false;
      if (words.length) {
        const hay = [a.name, a.id, a.category, a.project, a.folder, ...(a.tags || []), a.review?.notes, a.file].join(" ").toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    const sort = $("sort").value;
    const rank = { remove: 0, regenerate: 1, needs_fix: 2, unreviewed: 3, approved: 4 };
    list.sort((x, y) => {
      if (sort === "recent") return String(y.updated).localeCompare(String(x.updated));
      if (sort === "tris") return (y.triangles || 0) - (x.triangles || 0);
      if (sort === "review") return (needsFix(y) - needsFix(x)) || rank[decision(x)] - rank[decision(y)] || x.name.localeCompare(y.name);
      return x.name.localeCompare(y.name);
    });
    return list;
  }

  // ── Sidebar ──
  function navItem(label, count, pressed, onclick, { color, sub, caret } = {}) {
    return el("button", { class: "nav-item" + (sub ? " sub" : ""), type: "button", "aria-pressed": String(!!pressed), onclick },
      caret !== undefined ? el("span", { class: "caret" }, caret) : null,
      color ? el("span", { class: "dot", style: "background:" + color }) : null,
      el("span", {}, label), count !== undefined ? el("span", { class: "count" }, fmt.format(count)) : null);
  }

  function setFilter(patch) {
    Object.assign(state, { view: "all", kind: "", category: "", project: "", tag: "" }, patch, { limit: PAGE });
    renderAll();
  }

  function renderSidebar() {
    const A = lib.assets;
    const openReq = lib.requests.filter((r) => r.status === "open" || r.status === "in_progress").length;
    $("total-pill").textContent = fmt.format(A.length) + " assets";
    const views = [
      ["all", "All assets", A.length, "#4c8dff"],
      ["models", "Models", A.filter((a) => a.kind === "model").length, "#38bdf8"],
      ["textures", "Textures", A.filter((a) => a.kind === "texture").length, "#a78bfa"],
      ["needs_fix", "Needs fixing", A.filter(needsFix).length, "#e4b663"],
      ["unreviewed", "Unreviewed", A.filter((a) => decision(a) === "unreviewed").length, "#6b7280"],
      ["approved", "Approved", A.filter((a) => decision(a) === "approved").length, "#57c485"],
      ["remove", "Marked for removal", A.filter((a) => decision(a) === "remove").length, "#f0786a"],
      ["requests", "Generation requests", openReq, "#f472b6"],
    ];
    const nothingElse = !state.kind && !state.category && !state.project && !state.tag;
    $("views").replaceChildren(...views.map(([v, label, n, color]) =>
      navItem(label, n, state.view === v && nothingElse, () => setFilter({ view: v }), { color })));

    const cats = [];
    for (const [kind, label, list, color] of [["model", "Models", info.categories.model, "#38bdf8"], ["texture", "Textures", info.categories.texture, "#a78bfa"]]) {
      const ofKind = A.filter((a) => a.kind === kind);
      cats.push(navItem(label, ofKind.length, state.kind === kind && !state.category, () => setFilter({ kind }), { color, caret: "▾" }));
      for (const c of list) {
        const n = ofKind.filter((a) => a.category === c).length;
        if (!n) continue;
        cats.push(navItem(c, n, state.kind === kind && state.category === c, () => setFilter({ kind, category: c }), { sub: true }));
      }
    }
    $("categories").replaceChildren(...cats);

    const projects = new Map();
    for (const a of A) projects.set(a.project, (projects.get(a.project) || 0) + 1);
    $("projects").replaceChildren(...[...projects.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([p, n]) =>
      navItem(p, n, state.project === p, () => setFilter({ project: p }), { color: "#57c485" })));

    $("tag-cloud").replaceChildren(...tagCounts("").slice(0, 30).map(({ tag }) =>
      el("button", { type: "button", onclick: () => setFilter({ tag }), title: "Show #" + tag }, "#" + tag)));
  }

  function renderChips() {
    const chips = [];
    if (state.project) chips.push(["Project: " + state.project, { project: "" }]);
    if (state.tag) chips.push(["#" + state.tag, { tag: "" }]);
    if (state.category) chips.push([state.category, { category: "" }]);
    $("chips").hidden = !chips.length;
    $("chips").replaceChildren(...chips.map(([label, patch]) =>
      el("button", { type: "button", onclick: () => { Object.assign(state, patch); renderAll(); } }, label + " ×")));
    const crumb = [state.view === "all" ? (state.kind ? (state.kind === "model" ? "Models" : "Textures") : "All assets") : $("views").querySelector('[aria-pressed="true"] span:not(.dot)')?.textContent || state.view];
    if (state.category) crumb.push(state.category);
    if (state.project) crumb.push(state.project);
    if (state.tag) crumb.push("#" + state.tag);
    $("crumb").textContent = crumb.join(" / ");
  }

  // ── Grid ──
  function card(a) {
    const src = thumbUrl(a);
    const d = decision(a);
    const sub = a.kind === "model" ? (a.triangles ? fmt.format(a.triangles) + " tris · " : "") + a.category : a.category + " · " + Object.keys(a.maps || {}).length + " maps";
    const node = el("button", { class: "card", type: "button", "aria-selected": String(a.id === state.selected), dataset: { id: a.id },
      onclick: () => select(a.id) },
      el("div", { class: "thumb " + a.kind },
        src ? el("img", { src, alt: "", loading: "lazy", decoding: "async" }) : el("span", { class: "ph" }, a.kind === "model" ? "rendering…" : "loading…"),
        d !== "unreviewed" || needsFix(a) ? el("span", { class: "badge " + d }, needsFix(a) && d === "unreviewed" ? "Flagged" : DECISION_LABEL[d]) : null),
      el("div", { class: "card-body" }, el("span", { class: "card-name", title: a.name }, a.name), el("span", { class: "card-sub" }, sub)));
    return node;
  }

  function renderGrid() {
    const showRequests = state.view === "requests";
    $("grid-wrap").hidden = showRequests;
    $("requests-view").hidden = !showRequests;
    if (showRequests) { renderRequests(); $("count").textContent = ""; return; }
    const list = results();
    $("count").textContent = fmt.format(list.length);
    const cards = list.slice(0, state.limit).map(card);
    if (list.length > state.limit) cards.push(el("button", { class: "card", type: "button", onclick: () => { state.limit += PAGE; renderGrid(); } },
      el("div", { class: "thumb" }, el("span", { class: "ph" }, "Show " + Math.min(PAGE, list.length - state.limit) + " more"))));
    $("grid").replaceChildren(...cards);
    if (!lib.assets.length) say("The library is empty. Use + Import to add a folder of models or textures.");
  }

  function renderRequests() {
    const reqs = lib.requests.slice().reverse();
    const head = el("div", { class: "review-foot", style: "margin-bottom:12px" },
      el("button", { class: "primary", type: "button", onclick: () => openRequestDialog(null) }, "+ New request"),
      el("span", { class: "hint" }, "Requests are work for agents: make a missing asset or a fixed version of a broken one."));
    const items = reqs.map((r) => el("div", { class: "req" },
      el("h3", {}, (r.kind === "model" ? "Model" : "Texture") + (r.name ? ": " + r.name : "") + (r.replaces ? " (replaces " + r.replaces + ")" : "")),
      el("span", { class: "status " + r.status }, r.status.replace("_", " ")),
      el("p", {}, r.prompt + (r.max_triangles ? "\nBudget: " + fmt.format(r.max_triangles) + " triangles" : "") + (r.note ? "\nNote: " + r.note : "")),
      el("div", { class: "actions" },
        r.result_asset ? el("button", { type: "button", onclick: () => { setFilter({}); select(r.result_asset); } }, "Open result") : null,
        r.status === "open" || r.status === "in_progress"
          ? el("button", { type: "button", onclick: async () => { await call(api.updateRequest, r.id, { status: "cancelled" }); reload(); } }, "Cancel")
          : el("button", { type: "button", onclick: async () => { await call(api.updateRequest, r.id, { status: "open" }); reload(); } }, "Reopen")),
      el("p", { class: "hint" }, "By " + r.by + " · " + String(r.created).slice(0, 16).replace("T", " "))));
    $("requests-view").replaceChildren(head, ...(items.length ? items : [el("p", { class: "hint" }, "No requests yet.")]));
  }

  // ── Inspector ──
  function select(id) {
    state.selected = id;
    state.mapView = "albedo";
    for (const c of $("grid").querySelectorAll(".card")) c.setAttribute("aria-selected", String(c.dataset.id === id));
    renderInspector(true);
  }

  function renderInspector(resetPreview) {
    const a = selectedAsset();
    $("insp-empty").hidden = !!a;
    $("insp").hidden = !a;
    if (!a) return;
    $("insp-kind").textContent = a.kind;
    $("insp-kind").className = "kind-badge " + a.kind;
    if (document.activeElement !== $("insp-name")) $("insp-name").value = a.name;
    $("insp-category").replaceChildren(...info.categories[a.kind].map((c) => new Option(c, c, false, c === a.category)));
    if (resetPreview) renderPreview(a);
    renderMaps(a);
    renderTags(a);
    renderMeta(a);
    renderReview(a);
    const v = a.versions || [];
    $("versions").hidden = !v.length;
    $("version-list").replaceChildren(...v.map((x) => el("li", {}, String(x.replaced).slice(0, 10) + " · " + x.file.split(/[\\/]/).pop() +
      (x.triangles ? " · " + fmt.format(x.triangles) + " tris" : "") + (x.review?.decision ? " · was " + DECISION_LABEL[x.review.decision] : "") + (x.note ? " — " + x.note : ""))));
  }

  function renderPreview(a) {
    const box = $("preview");
    if (a.kind === "model") {
      const mv = el("model-viewer", { src: toUrl(a.file), "camera-controls": true, "auto-rotate": true, "shadow-intensity": "0.8",
        exposure: "1.05", "environment-image": "neutral", "interaction-prompt": "none", alt: a.name });
      box.replaceChildren(mv);
    } else {
      const file = (a.maps || {})[state.mapView] || a.file;
      box.replaceChildren(el("a", { href: "#", title: "Open in the default viewer", onclick: (e) => { e.preventDefault(); api.openFile(file); } },
        el("img", { src: toUrl(file), alt: a.name })));
    }
  }

  function renderMaps(a) {
    const maps = a.kind === "texture" ? Object.keys(a.maps || {}) : [];
    $("maps").replaceChildren(...maps.map((m) => el("button", { type: "button", "aria-pressed": String(m === state.mapView),
      onclick: () => { state.mapView = m; renderPreview(a); renderMaps(a); } }, m)));
  }

  function renderMeta(a) {
    const rows = [];
    const add = (k, v, cls) => { if (v !== undefined && v !== null && v !== "") rows.push(el("dt", {}, k), el("dd", { class: cls || "" }, v)); };
    if (a.kind === "model") {
      const budget = a.source?.budget;
      add("Triangles", fmt.format(a.triangles || 0) + (budget ? " / budget " + fmt.format(budget) : ""), budget && a.triangles > budget ? "over" : "");
      if (a.bounds) add("Size (m)", a.bounds.map((x) => x.toFixed(2)).join(" × "));
      add("Textures", a.embedded_images ? a.embedded_images + " embedded" : "none embedded", a.embedded_images ? "" : "over");
    } else {
      add("Maps", Object.keys(a.maps || {}).join(", "));
      if (a.pixel_size) add("Pixels", a.pixel_size.join(" × "));
    }
    add("Project", a.project + (a.folder && a.folder !== "." ? " / " + a.folder : ""));
    add("File", el("a", { href: "#", onclick: (e) => { e.preventDefault(); api.showInFolder(a.file); } }, a.file));
    add("File size", a.size ? bytes(a.size) : "");
    if (a.source?.image) add("Source image", el("a", { href: "#", onclick: (e) => { e.preventDefault(); api.openFile(a.source.image); } }, a.source.image.split(/[\\/]/).pop()));
    if (a.source?.prompt) add("Prompt", a.source.prompt);
    if (a.source?.tool) add("Made with", a.source.tool);
    add("Added", String(a.created).slice(0, 10) + (a.added_by ? " by " + a.added_by : ""));
    if (a.review?.updated) add("Reviewed", String(a.review.updated).slice(0, 16).replace("T", " ") + (a.review.by ? " by " + a.review.by : ""));
    $("meta").replaceChildren(...rows);
  }

  // ── Tags with hover delete, + add and autocomplete ──
  function tagCounts(prefix) {
    const counts = new Map();
    for (const a of lib.assets) for (const t of a.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    const p = prefix.toLowerCase().replace(/^#+/, "");
    return [...counts.entries()]
      .filter(([t]) => !p || t.startsWith(p) || (p.length > 1 && t.includes(p)))
      .sort((x, y) => (p ? Number(!x[0].startsWith(p)) - Number(!y[0].startsWith(p)) : 0) || y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([tag, count]) => ({ tag, count }));
  }

  function normTag(t) { return t.trim().replace(/^#+/, "").toLowerCase().replace(/[^a-z0-9_\-& ]+/g, "").replace(/\s+/g, "-").slice(0, 40); }

  async function changeTags(a, add, remove) {
    const updated = await call(api.editTags, a.id, add, remove);
    Object.assign(a, updated);
    renderTags(a, add.length > 0);
    renderSidebar();
  }

  function renderTags(a, keepInputOpen = false) {
    const box = $("tags");
    const chips = (a.tags || []).map((t) => el("span", { class: "tag" }, "#" + t,
      el("button", { class: "x", type: "button", title: "Remove #" + t, "aria-label": "Remove tag " + t, onclick: () => changeTags(a, [], [t]) }, "×")));
    const addBtn = el("button", { class: "tag-add", type: "button", title: "Add a tag", "aria-label": "Add tag" }, "+");
    box.replaceChildren(...chips, addBtn);
    addBtn.addEventListener("click", () => openTagInput(a, addBtn));
    if (keepInputOpen) openTagInput(a, addBtn);
  }

  function openTagInput(a, addBtn) {
    const wrap = el("span", { class: "tag-input-wrap" });
    const input = el("input", { class: "tag-input", placeholder: "new tag…", "aria-label": "New tag", autocomplete: "off" });
    const list = el("div", { class: "suggest", role: "listbox", hidden: true });
    wrap.append(input, list);
    addBtn.replaceWith(wrap);
    input.focus();
    let options = [], active = -1;
    const draw = () => {
      const typed = normTag(input.value);
      options = typed ? tagCounts(typed).filter((o) => !(a.tags || []).includes(o.tag)).slice(0, 12) : [];
      if (typed && !options.some((o) => o.tag === typed)) options.push({ tag: typed, count: 0, isNew: true });
      active = options.length ? 0 : -1;
      list.hidden = !options.length;
      list.replaceChildren(...options.map((o, i) => el("button", { type: "button", role: "option", "aria-selected": String(i === active),
        onmousedown: (e) => { e.preventDefault(); commit(o.tag); } }, "#" + o.tag, el("span", {}, o.isNew ? "new" : String(o.count)))));
    };
    const highlight = () => [...list.children].forEach((b, i) => b.setAttribute("aria-selected", String(i === active)));
    const commit = (tag) => { tag = normTag(tag); if (tag) changeTags(a, [tag], []); else renderTags(a); };
    input.addEventListener("input", draw);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && options.length) { e.preventDefault(); active = (active + 1) % options.length; highlight(); }
      else if (e.key === "ArrowUp" && options.length) { e.preventDefault(); active = (active - 1 + options.length) % options.length; highlight(); }
      else if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
        if (!input.value.trim()) { if (e.key === "Enter") renderTags(a); return; }
        e.preventDefault(); commit(active >= 0 ? options[active].tag : input.value);
      } else if (e.key === "Escape") { e.preventDefault(); renderTags(a); }
    });
    input.addEventListener("blur", () => setTimeout(() => { if (wrap.isConnected) renderTags(a); }, 120));
  }

  // ── Review ──
  function renderReview(a) {
    const r = a.review || {};
    $("decision").replaceChildren(...info.decisions.map((d) => el("button", { type: "button", role: "radio", "aria-checked": String((r.decision || "unreviewed") === d),
      dataset: { d }, onclick: (e) => { for (const b of $("decision").children) b.setAttribute("aria-checked", String(b === e.currentTarget)); } }, DECISION_LABEL[d])));
    $("flags").replaceChildren(...Object.entries(info.flags).map(([k, label]) => el("label", {},
      el("input", { type: "checkbox", value: k, checked: (r.flags || []).includes(k) }), label)));
    $("notes").value = r.notes || "";
    $("saved").textContent = "";
  }

  async function saveReview(e) {
    e.preventDefault();
    const a = selectedAsset();
    if (!a) return;
    const d = $("decision").querySelector('[aria-checked="true"]')?.dataset.d || "unreviewed";
    const flags = [...$("flags").querySelectorAll("input:checked")].map((i) => i.value);
    const updated = await call(api.setReview, a.id, { decision: d, flags, notes: $("notes").value });
    Object.assign(a, updated);
    $("saved").textContent = "Saved";
    renderSidebar(); renderGrid(); renderMeta(a);
  }

  // ── Dialogs and actions ──
  function openRequestDialog(asset) {
    const dlg = $("dlg-request");
    $("req-title").textContent = asset ? "Request a fixed version of " + asset.name : "Request a new asset";
    const notes = asset?.review?.notes ? " Problems: " + asset.review.notes : "";
    $("req-prompt").value = asset ? "Regenerate " + asset.name + " (" + asset.category + ")." + notes : "";
    $("req-tris").value = asset?.source?.budget || asset?.triangles || "";
    dlg.returnValue = "";
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== "ok" || !$("req-prompt").value.trim()) return;
      await call(api.createRequest, { kind: asset?.kind || "model", name: asset?.name || "", prompt: $("req-prompt").value.trim(),
        category: asset?.category, tags: asset?.tags, replaces: asset?.id || null, max_triangles: Number($("req-tris").value) || null });
      say("Request created. Agents see it with list_requests.");
      reload();
    };
  }

  function wire() {
    $("btn-import").addEventListener("click", () => {
      const m = $("import-menu"); m.hidden = !m.hidden; $("btn-import").setAttribute("aria-expanded", String(!m.hidden));
    });
    document.addEventListener("click", (e) => { if (!e.target.closest("#import-menu, #btn-import")) $("import-menu").hidden = true; });
    for (const b of $("import-menu").querySelectorAll("button")) b.addEventListener("click", async () => {
      $("import-menu").hidden = true;
      const k = b.dataset.import;
      say("Importing…");
      let r;
      if (k === "files") r = await call(api.importFiles);
      else if (k === "texlib") r = await call(api.importTextureLibrary, info.textureLibrary || null);
      else r = await call(api.importFolder, k);
      if (r === null) { say(""); return; }
      say(Array.isArray(r) ? "Added " + r.length + " file(s)." : "Added " + r.added + " asset(s)" + (r.skipped ? ", " + r.skipped + " already in the library." : "."));
      await reload();
    });
    $("btn-mcp").addEventListener("click", () => {
      $("mcp-json").textContent = JSON.stringify(info.mcp, null, 2);
      $("mcp-data").textContent = "Library file: " + info.libraryFile + ". Needs Node.js on the PATH.";
      $("dlg-mcp").showModal();
    });
    $("mcp-copy").addEventListener("click", async () => { await api.copy($("mcp-json").textContent); $("mcp-copy").textContent = "Copied"; });
    $("mcp-close").addEventListener("click", () => $("dlg-mcp").close());
    $("btn-export").addEventListener("click", async () => { const p = await call(api.exportLibrary); if (p) say("Exported to " + p); });
    $("query").addEventListener("input", () => { state.limit = PAGE; renderGrid(); });
    $("sort").addEventListener("change", renderGrid);
    $("zoom").addEventListener("input", () => {
      document.documentElement.style.setProperty("--card", $("zoom").value + "px");
      try { localStorage.setItem("catalogisti.zoom", $("zoom").value); } catch { /* optional */ }
    });
    try { const z = localStorage.getItem("catalogisti.zoom"); if (z) { $("zoom").value = z; document.documentElement.style.setProperty("--card", z + "px"); } } catch { /* optional */ }

    $("insp-name").addEventListener("change", async () => {
      const a = selectedAsset(); if (!a || !$("insp-name").value.trim()) return;
      Object.assign(a, await call(api.updateAsset, a.id, { name: $("insp-name").value }));
      renderGrid();
    });
    $("insp-category").addEventListener("change", async () => {
      const a = selectedAsset(); if (!a) return;
      Object.assign(a, await call(api.updateAsset, a.id, { category: $("insp-category").value }));
      renderSidebar(); renderGrid();
    });
    $("review").addEventListener("submit", saveReview);
    $("act-show").addEventListener("click", () => { const a = selectedAsset(); if (a) api.showInFolder(a.file); });
    $("act-replace").addEventListener("click", async () => {
      const a = selectedAsset(); if (!a) return;
      const r = await call(api.replaceFile, a.id);
      if (r) { say("Replaced " + a.name + ". The old file is kept in the version history."); await reload(); renderInspector(true); }
    });
    $("act-request").addEventListener("click", () => { const a = selectedAsset(); if (a) openRequestDialog(a); });
    $("act-delete").addEventListener("click", () => {
      const a = selectedAsset(); if (!a) return;
      $("del-text").textContent = "“" + a.name + "” is removed from the catalog. " + a.file;
      $("del-trash").checked = false;
      const dlg = $("dlg-delete");
      dlg.returnValue = "";
      dlg.showModal();
      dlg.onclose = async () => {
        if (dlg.returnValue !== "ok") return;
        await call(api.deleteAsset, a.id, $("del-trash").checked);
        state.selected = null;
        say("Deleted " + a.name + ($("del-trash").checked ? " (file moved to the Recycle Bin)." : " (file kept on disk)."));
        await reload();
      };
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !e.target.closest("input, textarea")) { e.preventDefault(); $("query").focus(); }
      if (e.key === "Delete" && state.selected && !e.target.closest("input, textarea, select")) $("act-delete").click();
    });
    api.onLibraryChanged(async (by) => {
      await reload();
      renderInspector(false);
      say("Library updated" + (by && by !== "app" ? " by " + by : "") + ".");
    });
  }

  // ── Thumbnails: rendered once per file version, cached in the data folder ──
  async function thumbForModel(a) {
    const stage = $("thumb-stage");
    const mv = el("model-viewer", { src: toUrl(a.file), "environment-image": "neutral", exposure: "1.05", "shadow-intensity": "0", "interaction-prompt": "none", "camera-orbit": "35deg 70deg auto" });
    stage.replaceChildren(mv);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 30000);
      mv.addEventListener("load", () => { clearTimeout(t); resolve(); }, { once: true });
      mv.addEventListener("error", () => { clearTimeout(t); reject(new Error("load error")); }, { once: true });
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));
    const blob = await mv.toBlob({ mimeType: "image/png", idealAspect: false });
    stage.replaceChildren();
    return blob;
  }

  async function thumbForTexture(a) {
    const img = new Image();
    img.src = toUrl(a.maps?.albedo || a.file);
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 256, 256);
    return await new Promise((r) => c.toBlob(r, "image/png"));
  }

  async function pumpThumbnails() {
    if (thumbBusy) return;
    thumbBusy = true;
    try {
      for (;;) {
        const visible = new Set(results().slice(0, state.limit).map((a) => a.id));
        const todo = lib.assets.filter((a) => (!a.thumbnail || a.thumb_mtime !== a.mtime) && !thumbFailed.has(a.id))
          .sort((x, y) => Number(visible.has(y.id)) - Number(visible.has(x.id)));
        const a = todo[0];
        if (!a) break;
        try {
          const blob = a.kind === "model" ? await thumbForModel(a) : await thumbForTexture(a);
          const rel = await api.saveThumbnail(a.id, new Uint8Array(await blob.arrayBuffer()));
          a.thumbnail = rel; a.thumb_mtime = a.mtime;
          const img = $("grid").querySelector('[data-id="' + CSS.escape(a.id) + '"] .thumb');
          if (img) img.replaceChildren(el("img", { src: thumbUrl(a), alt: "" }), ...[...img.querySelectorAll(".badge")]);
        } catch { thumbFailed.add(a.id); }
      }
    } finally { thumbBusy = false; }
  }

  function renderAll() {
    renderSidebar();
    renderChips();
    renderGrid();
    if (state.selected && !selectedAsset()) state.selected = null;
    renderInspector(false);
    pumpThumbnails();
  }

  (async () => {
    info = await api.info();
    $("data-path").textContent = info.dataDir;
    wire();
    await customElements.whenDefined("model-viewer").catch(() => {});
    await reload();
  })();
})();
