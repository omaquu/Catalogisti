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
  function inSource(a) {
    if (!state.sourcePath) return (a.project || "Unsorted") === state.source && !sources.some((s) => s.path && underPath(a.file, s.path));
    return [a.file, ...(a.locations || [])].some((f) => underPath(f, state.sourcePath));
  }
  function underPath(f, dir) {
    const norm = (x) => String(x || "").replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
    const a = norm(f), d = norm(dir);
    return a === d || a.startsWith(d + "\\");
  }
  function cats(a) { return a.categories?.length ? a.categories : [a.category || "Other"]; }
  function groupOf(a) { return a.group ? lib.assets.filter((x) => x.group === a.group) : [a]; }
  function base(p) { return String(p).split(/[\\/]/).pop(); }
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
      if (state.category && !cats(a).includes(state.category)) return false;
      if (state.project && a.project !== state.project) return false;
      if (state.source && !inSource(a)) return false;
      if (state.tag && !(a.tags || []).includes(state.tag)) return false;
      if (tags.length && !tags.every((t) => (a.tags || []).some((x) => x.startsWith(t)))) return false;
      if (words.length) {
        const hay = [a.name, a.id, ...cats(a), a.project, a.folder, ...(a.tags || []), a.review?.notes, a.file].join(" ").toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    if ($("group-toggle").checked) {
      // One card per variant group: the approved member if any, otherwise the first match.
      const best = new Map();
      for (const a of list) {
        if (!a.group) continue;
        const cur = best.get(a.group);
        if (!cur || (decision(a) === "approved" && decision(cur) !== "approved")) best.set(a.group, a);
      }
      list = list.filter((a) => !a.group || best.get(a.group) === a);
    }
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
    Object.assign(state, { view: "all", kind: "", category: "", project: "", tag: "", source: "", sourcePath: null }, patch, { limit: PAGE });
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
    const nothingElse = !state.kind && !state.category && !state.project && !state.tag && !state.source;
    $("views").replaceChildren(...views.map(([v, label, n, color]) =>
      navItem(label, n, state.view === v && nothingElse, () => setFilter({ view: v }), { color })));

    const catItems = [];
    for (const [kind, label, list, color] of [["model", "Models", info.categories.model, "#38bdf8"], ["texture", "Textures", info.categories.texture, "#a78bfa"]]) {
      const ofKind = A.filter((a) => a.kind === kind);
      catItems.push(navItem(label, ofKind.length, state.kind === kind && !state.category, () => setFilter({ kind }), { color, caret: "▾" }));
      const custom = [...new Set(ofKind.flatMap(cats))].filter((c) => !list.includes(c)).sort();
      for (const c of [...list, ...custom]) {
        const n = ofKind.filter((a) => cats(a).includes(c)).length;
        if (!n) continue;
        catItems.push(navItem(c, n, state.kind === kind && state.category === c, () => setFilter({ kind, category: c }), { sub: true }));
      }
    }
    $("categories").replaceChildren(...catItems);

    const projects = new Map();
    for (const a of A) projects.set(a.project, (projects.get(a.project) || 0) + 1);
    $("projects").replaceChildren(...[...projects.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([p, n]) =>
      navItem(p, n, state.project === p, () => setFilter({ project: p }), { color: "#57c485" })));

    renderSources();
    $("tag-cloud").replaceChildren(...tagCounts("").slice(0, 30).map(({ tag }) =>
      el("button", { type: "button", onclick: () => setFilter({ tag }), title: "Show #" + tag }, "#" + tag)));
  }

  // ── Sources: the folders the library reads from; hover × to stop reading one ──
  let sources = [];
  async function renderSources() {
    try { sources = await api.listSources(); } catch { sources = []; }
    $("sources").replaceChildren(...(sources.length ? sources.map((s) => {
      const parts = s.path ? s.path.split(/[\\/]/).filter(Boolean) : [];
      const generic = /^(models?|textures?|assets?|glb|export|exports|output|out|files)$/i.test(parts.at(-1) || "");
      const label = s.path ? parts.slice(generic ? -2 : -1).join("/") : s.name + " (added files)";
      const key = s.path ? { path: s.path } : { project: s.name };
      const row = el("div", { class: "source-row" + (s.enabled ? "" : " off") },
        el("input", { type: "checkbox", class: "src-check", checked: s.enabled, title: s.enabled ? "Untick to hide this folder's models (reviews are kept)" : "Tick to show this folder's models",
          "aria-label": "Show models from " + label, onchange: async (e) => {
            await call(api.setSourceEnabled, key, e.target.checked);
            say(e.target.checked ? "Showing " + label + "." : "Hiding " + label + " — its reviews and notes are kept.");
            await reload();
          } }),
        navItem(label, s.count, state.source === (s.path || s.name), () => setFilter({ source: s.path || s.name, sourcePath: s.path }), { color: s.kind === "texture" || s.kind === "texture-library" ? "#a78bfa" : "#38bdf8" }),
        el("button", { class: "src-x", type: "button", title: "Remove this source", "aria-label": "Remove source " + label, onclick: (e) => { e.stopPropagation(); confirmRemoveSource(s); } }, "×"));
      row.querySelector(".nav-item").title = s.path || s.name;
      return row;
    }) : [el("p", { class: "hint", style: "padding:0 8px" }, "No sources yet. Use + Import.")]));
    const off = sources.filter((s) => !s.enabled);
    $("hidden-note").hidden = !off.length;
    $("hidden-note").textContent = off.length ? (lib.hidden_count || 0) + " assets hidden in " + off.length + " unticked source" + (off.length > 1 ? "s" : "") + "." : "";
  }

  function confirmRemoveSource(s) {
    const dlg = $("dlg-source");
    $("src-title").textContent = "Remove source?";
    $("src-text").textContent = (s.path ? "Stop reading from " + s.path : "Remove the files added one by one to " + s.name) +
      ". " + s.count + " asset(s) leave the catalog (an asset that also exists in another source stays, using that copy).";
    $("src-ok").textContent = "Remove source";
    dlg.returnValue = "";
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== "ok") return;
      const r = await call(api.removeSource, s.path ? { path: s.path } : { project: s.name });
      if (state.source === (s.path || s.name)) setFilter({});
      say("Removed " + r.removed + " asset(s)" + (r.kept_elsewhere ? "; " + r.kept_elsewhere + " kept from their other location" : "") + ". Use + Import to add a new folder.");
      await reload();
    };
  }

  function confirmClearLibrary() {
    const dlg = $("dlg-source");
    $("src-title").textContent = "Clear the whole library?";
    $("src-text").textContent = "All " + lib.assets.length + " assets and every source are removed from the catalog, so you can import new folders from scratch.";
    $("src-ok").textContent = "Clear library";
    dlg.returnValue = "";
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== "ok") return;
      const r = await call(api.clearLibrary);
      setFilter({});
      say("Library cleared (" + r.removed + " assets). Use + Import to choose where models are read from.");
      await reload();
    };
  }

  function renderChips() {
    const chips = [];
    if (state.project) chips.push(["Project: " + state.project, { project: "" }]);
    if (state.source) chips.push(["Source: " + (state.sourcePath ? base(state.sourcePath) : state.source), { source: "", sourcePath: null }]);
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
    const sub = a.kind === "model" ? (a.triangles ? fmt.format(a.triangles) + " tris · " : "") + cats(a).join(", ") : cats(a).join(", ") + " · " + Object.keys(a.maps || {}).length + " maps";
    const node = el("button", { class: "card", type: "button", "aria-selected": String(a.id === state.selected), dataset: { id: a.id },
      onclick: () => select(a.id) },
      el("div", { class: "thumb " + a.kind },
        src ? el("img", { src, alt: "", loading: "lazy", decoding: "async" }) : el("span", { class: "ph" }, a.kind === "model" ? "rendering…" : "loading…"),
        d !== "unreviewed" || needsFix(a) ? el("span", { class: "badge " + d }, needsFix(a) && d === "unreviewed" ? "Flagged" : DECISION_LABEL[d]) : null,
        a.group ? el("span", { class: "badge group", title: "Linked variants" }, "×" + groupOf(a).length) : null),
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
    if (!lib.assets.length) say(lib.hidden_count
      ? "No source is ticked. Tick a folder under Sources to show its models, or use + Import to add a new folder."
      : "The library is empty. Use + Import to add a folder of models or textures.");
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
    if (reviewDirty) flushReview();
    state.selected = id;
    state.mapView = "albedo";
    state.media = null;
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
    renderCategories(a);
    renderDupBanner(a);
    if (resetPreview) renderPreview(a);
    renderMaps(a);
    renderTags(a);
    renderMeta(a);
    if (resetPreview || !reviewDirty) renderReview(a);
    renderVariants(a);
    if (resetPreview) renderMedia(a);
  }

  // ── "Made from & versions": current model, source/reference images, older versions ──
  async function renderMedia(a) {
    const strip = $("media");
    const items = [];
    if (a.kind === "model") {
      items.push({ type: "model", file: a.file, label: "Current" + (a.triangles ? " · " + fmt.format(a.triangles) : ""), thumb: thumbUrl(a) });
      (a.versions || []).forEach((v, i) => items.push({ type: "model", file: v.file, version: i,
        label: "v" + (i + 1) + " · " + String(v.replaced).slice(0, 10), title: "Earlier version, replaced " + String(v.replaced).slice(0, 10) + (v.note ? " — " + v.note : "") + (v.review?.decision ? " · was " + DECISION_LABEL[v.review.decision] : "") }));
      let refs = [];
      try { refs = await api.references(a.id); } catch { /* none */ }
      if (state.selected !== a.id) return;
      for (const r of refs) items.push({ type: "image", file: r, label: base(r).replace(/\.[a-z]+$/i, "").replace(/^.*?_(front|back|left|right|top|bottom|side|input|source|front45|rear45)$/i, "$1") || "source", title: r, thumb: toUrl(r) });
    } else {
      (a.versions || []).forEach((v, i) => items.push({ type: "image", file: v.file, version: i, label: "v" + (i + 1), thumb: toUrl(v.file), title: v.file }));
    }
    $("media-wrap").hidden = items.length < 2;
    strip.replaceChildren(...items.map((it) => {
      const pressed = state.media ? state.media.file === it.file : it.label.startsWith("Current");
      const b = el("button", { type: "button", title: it.title || it.label, "aria-pressed": String(pressed),
        onclick: () => { state.media = it; renderPreview(a); renderMedia(a); } },
        it.thumb ? el("img", { src: it.thumb, alt: "", loading: "lazy" }) : el("span", { class: "ph3d" }, "3D"),
        el("span", {}, it.label));
      return b;
    }));
    const m = state.media;
    if (m && m.version !== undefined) {
      strip.append(el("button", { type: "button", class: "small", style: "width:auto;align-self:center;padding:4px 8px",
        title: "Make this earlier version the current one", onclick: async () => {
          await call(api.restoreVersion, a.id, m.version); state.media = null; say("Restored the earlier version of " + a.name + "."); await reload(); renderInspector(true);
        } }, el("span", {}, "Restore this version")));
    }
  }

  // ── Linked variants ──
  function renderVariants(a) {
    const members = groupOf(a);
    const others = members.filter((x) => x.id !== a.id);
    $("variants-label").textContent = others.length ? "Variants of the same model (" + members.length + ")" : "Variants of the same model";
    $("act-unlink").hidden = !a.group;
    $("variants").replaceChildren(...(others.length ? members.map((x) => el("button", { type: "button", class: "variant" + (x.id === a.id ? " current" : ""),
      onclick: () => { if (x.id !== a.id) select(x.id); } },
      thumbUrl(x) ? el("img", { src: thumbUrl(x), alt: "" }) : el("span", { class: "ph" }),
      el("span", {}, el("span", { class: "v-name" }, x.name + (x.id === a.id ? " (this)" : "")),
        el("span", { class: "v-sub" }, (x.triangles ? fmt.format(x.triangles) + " tris · " : "") + base(x.file) + " · " + x.folder)),
      el("span", { class: "v-dec" }, DECISION_LABEL[decision(x)])))
      : [el("p", { class: "hint" }, "Not linked. Use “+ Link variant” to connect other versions of this " + a.kind + ".")]));
  }

  function openLinkDialog(a) {
    const dlg = $("dlg-link");
    $("link-title").textContent = "Link variants of " + a.name;
    const chosen = new Set();
    const draw = () => {
      const q = $("link-query").value.toLowerCase().split(/\s+/).filter(Boolean);
      const stem = base(a.file).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
      const list = lib.assets.filter((x) => x.kind === a.kind && x.id !== a.id && (!a.group || x.group !== a.group))
        .map((x) => ({ x, score: stem.filter((w) => (x.name + " " + x.tags.join(" ")).toLowerCase().includes(w)).length }))
        .filter(({ x }) => q.every((w) => (x.name + " " + x.tags.join(" ") + " " + x.folder).toLowerCase().includes(w)))
        .sort((p, r) => r.score - p.score || p.x.name.localeCompare(r.x.name)).slice(0, 80);
      $("link-list").replaceChildren(...list.map(({ x }) => el("label", {},
        el("input", { type: "checkbox", checked: chosen.has(x.id), onchange: (e) => e.target.checked ? chosen.add(x.id) : chosen.delete(x.id) }),
        thumbUrl(x) ? el("img", { src: thumbUrl(x), alt: "" }) : el("span", { class: "ph" }),
        el("span", {}, x.name, el("br"), el("small", {}, (x.triangles ? fmt.format(x.triangles) + " tris · " : "") + x.folder + (x.group ? " · already in a group" : ""))))));
    };
    $("link-query").value = "";
    $("link-query").oninput = draw;
    draw();
    dlg.returnValue = "";
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== "ok" || !chosen.size) return;
      await call(api.linkAssets, [a.id, ...chosen]);
      say("Linked " + (chosen.size + 1) + " variants.");
      await reload(); renderInspector(false);
    };
  }

  function renderPreview(a) {
    const box = $("preview");
    const m = state.media;
    $("preview-caption").textContent = m && !(m.label || "").startsWith("Current") ? (m.type === "image" ? "Source image: " : "Earlier version: ") + base(m.file) : "";
    if (m && m.type === "image" && a.kind === "model") {
      box.replaceChildren(el("a", { href: "#", title: "Open in the default viewer", onclick: (e) => { e.preventDefault(); api.openFile(m.file); } },
        el("img", { src: toUrl(m.file), alt: "Source image" })));
    } else if (a.kind === "model") {
      const mv = el("model-viewer", { src: toUrl(m?.file || a.file), "camera-controls": true, "auto-rotate": true, "shadow-intensity": "0.8",
        exposure: "1.05", "environment-image": "neutral", "interaction-prompt": "none", alt: a.name });
      box.replaceChildren(mv);
    } else {
      const file = m?.file || (a.maps || {})[state.mapView] || a.file;
      box.replaceChildren(el("a", { href: "#", title: "Open in the default viewer", onclick: (e) => { e.preventDefault(); api.openFile(file); } },
        el("img", { src: toUrl(file), alt: a.name })));
    }
  }

  function renderMaps(a) {
    const maps = a.kind === "texture" ? Object.keys(a.maps || {}) : [];
    $("maps").replaceChildren(...maps.map((m) => el("button", { type: "button", "aria-pressed": String(m === state.mapView),
      onclick: () => { state.mapView = m; state.media = null; renderPreview(a); renderMaps(a); } }, m)));
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
    if (a.locations?.length) add("Also at", el("span", {}, ...a.locations.map((f) =>
      el("a", { href: "#", style: "display:block", onclick: (e) => { e.preventDefault(); api.showInFolder(f); } }, f))));
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

  /**
   * Chip editor used for tags and categories: hover a chip for ×, "+" opens an input
   * that suggests existing values as you type (i → #iron, #item).
   */
  function chipEditor(box, { values, prefix = "", cls = "", noun, suggest, normalize, onAdd, onRemove }, keepOpen = false) {
    const chips = values.map((v) => el("span", { class: "tag " + cls }, prefix + v,
      el("button", { class: "x", type: "button", title: "Remove " + prefix + v, "aria-label": "Remove " + noun + " " + v, onclick: () => onRemove(v) }, "×")));
    const addBtn = el("button", { class: "tag-add", type: "button", title: "Add a " + noun, "aria-label": "Add " + noun }, "+");
    box.replaceChildren(...chips, addBtn);
    const reset = () => chipEditor(box, { values, prefix, cls, noun, suggest, normalize, onAdd, onRemove });
    const open = () => {
      const wrap = el("span", { class: "tag-input-wrap" });
      const input = el("input", { class: "tag-input", placeholder: "new " + noun + "…", "aria-label": "New " + noun, autocomplete: "off" });
      const list = el("div", { class: "suggest", role: "listbox", hidden: true });
      wrap.append(input, list);
      addBtn.replaceWith(wrap);
      input.focus();
      let options = [], active = -1;
      const draw = () => {
        const typed = normalize(input.value);
        options = suggest(typed).filter((o) => !values.some((v) => v.toLowerCase() === o.value.toLowerCase())).slice(0, 12);
        if (typed && !options.some((o) => o.value.toLowerCase() === typed.toLowerCase())) options.push({ value: typed, count: 0, isNew: true });
        active = options.length ? 0 : -1;
        list.hidden = !options.length;
        list.replaceChildren(...options.map((o, i) => el("button", { type: "button", role: "option", "aria-selected": String(i === active),
          onmousedown: (e) => { e.preventDefault(); commit(o.value); } }, prefix + o.value, el("span", {}, o.isNew ? "new" : String(o.count)))));
      };
      const highlight = () => [...list.children].forEach((b, i) => b.setAttribute("aria-selected", String(i === active)));
      const commit = (v) => { v = normalize(v); if (v) onAdd(v); else reset(); };
      input.addEventListener("input", draw);
      input.addEventListener("focus", draw);
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" && options.length) { e.preventDefault(); active = (active + 1) % options.length; highlight(); }
        else if (e.key === "ArrowUp" && options.length) { e.preventDefault(); active = (active - 1 + options.length) % options.length; highlight(); }
        else if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
          if (!input.value.trim()) { if (e.key === "Enter") reset(); return; }
          e.preventDefault(); commit(active >= 0 ? options[active].value : input.value);
        } else if (e.key === "Escape") { e.preventDefault(); reset(); }
      });
      input.addEventListener("blur", () => setTimeout(() => { if (wrap.isConnected) reset(); }, 120));
      draw();
    };
    addBtn.addEventListener("click", open);
    if (keepOpen) open();
  }

  function renderTags(a, keepOpen = false) {
    chipEditor($("tags"), {
      values: a.tags || [], prefix: "#", noun: "tag", normalize: normTag,
      suggest: (typed) => (typed ? tagCounts(typed) : []).map((o) => ({ value: o.tag, count: o.count })),
      onAdd: async (t) => { Object.assign(a, await call(api.editTags, a.id, [t], [])); renderTags(a, true); renderSidebar(); },
      onRemove: async (t) => { Object.assign(a, await call(api.editTags, a.id, [], [t])); renderTags(a); renderSidebar(); },
    }, keepOpen);
  }

  function categoryCounts(kind) {
    const counts = new Map(info.categories[kind].map((c) => [c, 0]));
    for (const x of lib.assets) if (x.kind === kind) for (const c of cats(x)) counts.set(c, (counts.get(c) || 0) + 1);
    return [...counts.entries()].map(([value, count]) => ({ value, count }));
  }

  function renderCategories(a, keepOpen = false) {
    chipEditor($("cats"), {
      values: cats(a), cls: "cat", noun: "category",
      normalize: (v) => v.trim().replace(/\s+/g, " ").slice(0, 40).replace(/^./, (c) => c.toUpperCase()),
      // Empty input lists every category, so the standard ones are one click away.
      suggest: (typed) => {
        const t = typed.toLowerCase();
        return categoryCounts(a.kind).filter((o) => !t || o.value.toLowerCase().startsWith(t) || (t.length > 1 && o.value.toLowerCase().includes(t)))
          .sort((x, y) => Number(!x.value.toLowerCase().startsWith(t)) - Number(!y.value.toLowerCase().startsWith(t)) || y.count - x.count);
      },
      onAdd: async (c) => { Object.assign(a, await call(api.editCategories, a.id, [c], [])); renderCategories(a); renderSidebar(); renderGrid(); },
      onRemove: async (c) => { Object.assign(a, await call(api.editCategories, a.id, [], [c])); renderCategories(a); renderSidebar(); renderGrid(); },
    }, keepOpen);
  }

  // ── Same name as another asset: merge identical copies, link different versions, or keep apart ──
  function renderDupBanner(a) {
    const box = $("dup-banner");
    const others = (a.possible_duplicate_of || []).map((id) => lib.assets.find((x) => x.id === id)).filter(Boolean);
    box.hidden = !others.length;
    if (!others.length) return;
    box.replaceChildren(el("strong", {}, "Same name already in the library"), ...others.map((o) => {
      const identical = a.size === o.size && (!a.sha256 || !o.sha256 || a.sha256 === o.sha256);
      return el("div", { class: "row" },
        el("span", {}, o.name + " — in " + base((o.file || "").replace(/[\\/][^\\/]*$/, "")) + (identical ? " (same file size, likely identical)" : " (different file)")),
        identical ? el("button", { type: "button", class: "small primary", onclick: () => resolveDup(a, o, "merge") }, "Merge: same model, other location") : null,
        el("button", { type: "button", class: "small", onclick: () => resolveDup(a, o, "link") }, "Link as variants"),
        el("button", { type: "button", class: "small", onclick: () => resolveDup(a, o, "keep") }, "Keep separate"),
        el("button", { type: "button", class: "small", onclick: () => select(o.id) }, "Open"));
    }));
  }

  async function resolveDup(a, o, action) {
    await call(api.resolveDuplicate, a.id, o.id, action);
    say(action === "merge" ? "Merged: " + o.name + " now lists both locations." : action === "link" ? "Linked as variants." : "Kept as separate assets.");
    await reload();
    select(action === "merge" ? o.id : a.id);
  }

  function openDupDialog(dups) {
    const dlg = $("dlg-dups");
    const choice = new Map();
    $("dups-list").replaceChildren(...dups.map((d) => {
      const best = d.matches.find((m) => m.identical) || d.matches[0];
      const action = best.identical ? "merge" : "link";
      choice.set(d.id, { into: best.id, action });
      const sel = el("select", { "aria-label": "What to do with " + d.name, onchange: (e) => { choice.get(d.id).action = e.target.value; } },
        ...(best.identical ? [new Option("Merge (same model, other location)", "merge", true, true)] : []),
        new Option("Link as variants", "link", !best.identical, !best.identical),
        new Option("Keep separate", "keep"), new Option("Decide later", "later"));
      return el("div", { class: "dup-row" },
        el("div", {}, el("strong", {}, d.name), el("small", {}, "New: " + d.file), el("small", {}, "Existing: " + best.file),
          el("small", { class: best.identical ? "same" : "diff" }, best.identical ? "Byte-identical file" : "Different file with the same name")),
        sel);
    }));
    dlg.returnValue = "";
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== "ok") { say("Same-name assets are marked; open one to decide later."); return; }
      let n = 0;
      for (const [id, c] of choice) if (c.action !== "later") { await call(api.resolveDuplicate, id, c.into, c.action); n++; }
      say("Settled " + n + " same-name pair(s).");
      await reload();
    };
  }

  // ── Review ──
  // Review saves itself: decisions and flags at once, notes shortly after typing stops.
  let reviewDirty = false, reviewTimer = null, reviewFor = null;

  function renderReview(a) {
    const r = a.review || {};
    reviewFor = a.id;
    $("decision").replaceChildren(...info.decisions.map((d) => el("button", { type: "button", role: "radio", "aria-checked": String((r.decision || "unreviewed") === d),
      dataset: { d }, onclick: (e) => { for (const b of $("decision").children) b.setAttribute("aria-checked", String(b === e.currentTarget)); saveReviewSoon(0); } }, DECISION_LABEL[d])));
    $("flags").replaceChildren(...Object.entries(info.flags).map(([k, label]) => el("label", {},
      el("input", { type: "checkbox", value: k, checked: (r.flags || []).includes(k), onchange: () => saveReviewSoon(0) }), label)));
    $("notes").value = r.notes || "";
    setSaved(r.updated ? "Saved " + String(r.updated).slice(11, 16) : "Changes save automatically");
  }

  function setSaved(text, cls = "") { $("saved").textContent = text; $("saved").className = cls; }

  function saveReviewSoon(delay) {
    reviewDirty = true;
    setSaved("Saving…", "saving");
    clearTimeout(reviewTimer);
    reviewTimer = setTimeout(flushReview, delay);
  }

  async function flushReview() {
    clearTimeout(reviewTimer);
    if (!reviewDirty || !reviewFor) return;
    const a = lib.assets.find((x) => x.id === reviewFor);
    if (!a) { reviewDirty = false; return; }
    const d = $("decision").querySelector('[aria-checked="true"]')?.dataset.d || "unreviewed";
    const flags = [...$("flags").querySelectorAll("input:checked")].map((i) => i.value);
    reviewDirty = false;
    try {
      Object.assign(a, await api.setReview(a.id, { decision: d, flags, notes: $("notes").value }));
      setSaved("Saved ✓ " + new Date().toTimeString().slice(0, 5));
      renderSidebar(); renderGrid(); renderMeta(a);
    } catch (error) {
      reviewDirty = true;
      setSaved("Not saved: " + error.message, "error");
    }
  }

  // ── Dialogs and actions ──
  function openRequestDialog(asset) {
    const dlg = $("dlg-request");
    $("req-title").textContent = asset ? "Request a fixed version of " + asset.name : "Request a new asset";
    const notes = asset?.review?.notes ? " Problems: " + asset.review.notes : "";
    $("req-prompt").value = asset ? "Regenerate " + asset.name + " (" + cats(asset).join(", ") + ")." + notes : "";
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
      if (r.duplicates?.length) openDupDialog(r.duplicates);
    });
    $("btn-mcp").addEventListener("click", () => {
      $("mcp-json").textContent = JSON.stringify(info.mcp, null, 2);
      $("mcp-data").textContent = "Library file: " + info.libraryFile + ". Needs Node.js on the PATH.";
      $("dlg-mcp").showModal();
    });
    $("mcp-copy").addEventListener("click", async () => { await api.copy($("mcp-json").textContent); $("mcp-copy").textContent = "Copied"; });
    $("mcp-close").addEventListener("click", () => $("dlg-mcp").close());
    $("btn-clear").addEventListener("click", confirmClearLibrary);
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
    $("review").addEventListener("submit", (e) => { e.preventDefault(); flushReview(); });
    $("notes").addEventListener("input", () => saveReviewSoon(700));
    $("notes").addEventListener("blur", () => { if (reviewDirty) flushReview(); });
    window.addEventListener("beforeunload", () => { if (reviewDirty) flushReview(); });
    $("group-toggle").addEventListener("change", () => {
      state.limit = PAGE; renderGrid();
      try { localStorage.setItem("catalogisti.group", $("group-toggle").checked ? "1" : ""); } catch { /* optional */ }
    });
    try { $("group-toggle").checked = localStorage.getItem("catalogisti.group") === "1"; } catch { /* optional */ }
    $("act-link").addEventListener("click", () => { const a = selectedAsset(); if (a) openLinkDialog(a); });
    $("act-unlink").addEventListener("click", async () => {
      const a = selectedAsset(); if (!a) return;
      await call(api.unlinkAsset, a.id); say(a.name + " is no longer linked."); await reload(); renderInspector(false);
    });
    $("act-show").addEventListener("click", () => { const a = selectedAsset(); if (a) api.showInFolder(a.file); });
    $("act-replace").addEventListener("click", async () => {
      const a = selectedAsset(); if (!a) return;
      const r = await call(api.replaceFile, a.id);
      if (r) { say("Replaced " + a.name + ". The old file is kept in the version history."); await reload(); renderInspector(true); }
    });
    $("act-request").addEventListener("click", () => { const a = selectedAsset(); if (a) openRequestDialog(a); });
    $("act-delete").addEventListener("click", () => {
      const a = selectedAsset(); if (!a) return;
      const members = groupOf(a);
      let whole = false;
      const filesOf = (x) => [...new Set([x.file, ...(x.kind === "texture" ? Object.values(x.maps || {}) : [])])];
      const draw = () => {
        const targets = whole ? members : [a];
        $("del-list").replaceChildren(...targets.map((x) => el("li", {}, x.name + " — " + (x.kind === "model" ? "model " + base(x.file) : "texture set, " + Object.keys(x.maps || {}).length + " maps"))));
        $("del-files").replaceChildren(...targets.flatMap(filesOf).map((f) => el("li", {}, f)));
        $("del-files").hidden = !$("del-trash").checked;
      };
      $("del-scope").replaceChildren(...(members.length > 1 ? [
        el("label", {}, el("input", { type: "radio", name: "del-scope", checked: true, onchange: () => { whole = false; draw(); } }), "Only this variant (" + a.name + ")"),
        el("label", {}, el("input", { type: "radio", name: "del-scope", onchange: () => { whole = true; draw(); } }), "All " + members.length + " linked variants of this model"),
      ] : [el("p", { class: "hint" }, "Only this " + (a.kind === "model" ? "model" : "texture set") + " is removed. Nothing else is linked to it.")]));
      $("del-trash").checked = false;
      $("del-trash").onchange = draw;
      draw();
      const dlg = $("dlg-delete");
      dlg.returnValue = "";
      dlg.showModal();
      dlg.onclose = async () => {
        if (dlg.returnValue !== "ok") return;
        const r = await call(api.deleteAsset, a.id, { trashFiles: $("del-trash").checked, wholeGroup: whole });
        state.selected = null;
        say("Removed " + r.removed.length + " catalog entr" + (r.removed.length === 1 ? "y" : "ies") +
          (r.trashed.length ? "; " + r.trashed.length + " file(s) moved to the Recycle Bin." : "; files kept on disk."));
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
