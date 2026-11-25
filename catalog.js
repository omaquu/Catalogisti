(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const catalog = window.MINDFLOWER_CATALOG;
  if (!catalog) {
    byId("message").textContent = "Katalogia ei löydy. Aja tools/asset_catalog/build.py.";
    return;
  }

  const locale = new Intl.NumberFormat("fi-FI");
  const labels = {
    unreviewed: "Arvioimatta", approved: "Hyväksytty", regenerate: "Generoi uudelleen", remove: "Poistoehdotus",
    source: "Lähdemalli", baked: "Bake", "modly-prepared": "Modly Prepare for Game",
    "prepared-unverified": "Prepare-johdannainen", optimized: "Optimoitu", staging: "Työversio",
    "modly-local": "Modly · Gameready-jono", "modly-weapon": "Modly · TripoSG & TRELLIS.2",
    "local-import": "Tuotu kansio",
  };
  const categoryNames = {
    "Weapon parts": "Aseen osat", Armor: "Armorit", Accessories: "Asusteet", Enemies: "Viholliset",
    Characters: "Hahmot", Buildings: "Rakennukset", Props: "Esineet", Railway: "Rautatie", Vehicles: "Ajoneuvot",
  };
  const categoryColors = {
    "Weapon parts": "#e4b663", Armor: "#60a5fa", Accessories: "#c084fc", Enemies: "#f87171",
    Characters: "#34d399", Buildings: "#fbbf24", Props: "#94a3b8", Railway: "#fb923c", Vehicles: "#38bdf8",
  };
  const projectColors = ["#4c8dff", "#57c485", "#e4b663", "#c084fc", "#fb923c", "#38bdf8", "#f472b6", "#94a3b8"];
  const localMaterials = {
    Bronze: "pronssi", Brass: "messinki", Copper: "kupari", Iron: "rauta",
    Steel: "teräs", Leather: "nahka", Wood: "puu", Glass: "lasi", Enamel: "emali",
    Marble: "marmori", Stone: "kivi", Nickel: "nikkeli", Gunmetal: "asepronssi", Ceramic: "keramiikka",
  };
  const stageNames = {
    modly: "Modly-käsitelty", baked: "Bake olemassa", optimized: "Optimoitu", "needs-prep": "GLB odottaa käsittelyä",
    gltf: "glTF", splat: "Gaussian splat", textures: "Tekstuuri ilman GLB:tä", source: "Lähdeaineisto",
    "modly-local": "Modly · Gameready-jono", "modly-weapon": "Modly · Aseenosat", native: "Godot-moduuli",
    "local-import": "Tuotu oma malli",
  };
  const reviewFlagLabels = {
    reduce_tris: "Pienennettävä kolmioita",
    duplicate_exists: "Samanlainen jo olemassa",
  };
  const searchAliases = {
    Pommel: "pommeli pommel", Helmet: "kypärä", "Armor component": "haarniska",
    "Grip / handle": "kahva", "Guard / handguard": "ristisuoja crossguard crossroad suojus",
    "Nozzle / front": "suutin kärki nozzle tip", "Head / blade": "terä lyöntipää", Barrel: "piippu",
    "Building part": "rakennus osa", Enemy: "vihollinen boss monster",
  };

  const PAGE_SIZE = 60;
  const STORE = "mindflower.catalog.reviews.v1";
  const ZOOM_STORE = "mindflower.catalog.zoom.v1";
  const EXPANDED_STORE = "catalogisti.expandedProjects.v1";
  const HANDLE_DB = "mindflower.catalog.handles.v1";
  const LOCAL_SERVER = "http://127.0.0.1:8768";
  const filters = ["query", "project-select", "folder-select", "category", "part", "material", "tag-filter", "stage", "depth", "review-filter", "sort"];
  const decisions = new Set(["unreviewed", "approved", "regenerate", "remove"]);
  const dialog = byId("detail");
  const inspectorHost = byId("inspector-host");
  const inspectorContent = byId("inspector-content");
  const detailMount = byId("detail-mount");
  const localFiles = new Map();
  const localByName = new Map();
  const importedProjects = new Map(); // projectName -> { name, handle, urls: [] }
  const pendingHandles = new Map(); // projectName -> FileSystemDirectoryHandle
  let expandedProjects = new Set(["Mindflower"]);
  let reviews = { ...(window.MINDFLOWER_REVIEWS?.reviews ?? {}) };
  let page = 0;
  let active;
  let variants = [];
  let objectURL;
  let viewerLoad;
  let serverCheck;
  let previewRevision = 0;

  try {
    const local = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    for (const [key, review] of Object.entries(local)) {
      if (!reviews[key] || Date.parse(reviews[key].updated) <= Date.parse(review.updated)) reviews[key] = review;
    }
    const savedZoom = Number(localStorage.getItem(ZOOM_STORE));
    if (savedZoom >= 135 && savedZoom <= 300) {
      byId("zoom").value = String(savedZoom);
      document.documentElement.style.setProperty("--card-size", savedZoom + "px");
    }
    const savedExp = JSON.parse(localStorage.getItem(EXPANDED_STORE) ?? "null");
    if (Array.isArray(savedExp)) expandedProjects = new Set(savedExp);
  } catch { /* Storage is optional. */ }

  function saveExpanded() {
    try { localStorage.setItem(EXPANDED_STORE, JSON.stringify([...expandedProjects])); } catch { /* ignore */ }
  }

  function element(tag, value, className) {
    const item = document.createElement(tag);
    if (value !== undefined) item.textContent = value;
    if (className) item.className = className;
    return item;
  }

  function fillSelect(id, values, display, defaultLabel) {
    const select = byId(id);
    const current = select.value;
    select.replaceChildren(new Option(defaultLabel, ""));
    for (const value of [...new Set(values.filter(Boolean))].sort((a, b) => display(a).localeCompare(display(b), "fi"))) {
      select.append(new Option(display(value), value));
    }
    select.value = [...select.options].some((o) => o.value === current) ? current : "";
  }

  function hasGlb(asset) {
    return asset.models.some((model) => model.format === "glb" && model.triangles > 0);
  }

  function primaryModel(asset) {
    return asset.models.find((model) => model.triangles > 0);
  }

  function budgetCap(asset, model = primaryModel(asset)) {
    let cap = catalog.budgets[asset.part]?.triangles[1] ?? 0;
    if (model?.stage === "modly-weapon" && asset.generation?.max_faces) {
      cap = cap ? Math.min(cap, asset.generation.max_faces) : asset.generation.max_faces;
    }
    return cap;
  }

  function overBudget(asset) {
    const model = primaryModel(asset);
    const cap = budgetCap(asset, model);
    return cap && model ? Math.max(0, model.triangles - cap) : 0;
  }

  function isStrictlyGameready(entry) {
    const model = primaryModel(entry.asset);
    if (!model || model.format !== "glb" || !(model.triangles > 0)) return false;
    const cap = budgetCap(entry.asset, model);
    if (cap && model.triangles > cap) return false;
    if (!model.maps?.Albedo) return false;
    return entry.tags.includes("gameready") || ["modly-weapon", "modly-local", "modly-prepared", "baked", "optimized", "local-import"].includes(model.stage);
  }

  function stage(asset) {
    if (asset.models.some((model) => model.stage === "local-import")) return "local-import";
    if (asset.models.some((model) => model.stage === "modly-weapon")) return "modly-weapon";
    if (asset.models.some((model) => model.stage === "modly-local")) return "modly-local";
    if (asset.models.some((model) => model.stage === "modly-prepared")) return "modly";
    if (asset.models.some((model) => model.stage === "baked")) return "baked";
    if (asset.models.some((model) => model.stage === "optimized")) return "optimized";
    if (hasGlb(asset)) return "needs-prep";
    if (asset.models.length) return "gltf";
    if (asset.splat) return "splat";
    if (asset.native) return "native";
    return asset.textures.length ? "textures" : "source";
  }

  function assetVariants(asset) {
    return [
      ...asset.models.map((item) => ({ kind: "model", item, key: item.sha256 ? "model:" + item.sha256 : "model:" + item.origin + ":" + item.path })),
      ...asset.textures.map((item) => ({ kind: "texture", item, key: item.id })),
      { kind: "asset", item: asset, key: "asset:" + asset.id },
    ];
  }

  function isDepth(channel) {
    return /^(?:height|depth|displacement|disp)$/i.test(channel);
  }

  function matchesStage(entry, selected) {
    if (!selected) return true;
    if (selected === "glb") return entry.glb;
    if (selected === "gameready") return isStrictlyGameready(entry);
    if (selected === "over-budget" || selected === "over-budget-tris") return overBudget(entry.asset) > 0;
    if (selected === "modly") return entry.asset.models.some((model) => model.stage === "modly-prepared");
    if (selected === "textures") return !entry.glb && entry.asset.textures.length > 0;
    return entry.stage === selected;
  }

  function buildEntry(asset) {
    const project = asset.project || "Mindflower";
    const folder = asset.folder || "Yleinen";
    const tags = asset.tags ?? [];
    return {
      asset,
      project,
      folder,
      stage: stage(asset),
      tags,
      glb: hasGlb(asset),
      depth: asset.textures.some((texture) => Object.keys(texture.maps ?? {}).some(isDepth)),
      search: [
        asset.id, asset.name.replace(/ · /g, " "), project, folder, asset.category, categoryNames[asset.category],
        asset.part, searchAliases[asset.part], ...tags,
        ...asset.materials, ...asset.materials.map((name) => localMaterials[name]),
        ...asset.models.map((model) => model.path), ...asset.textures.map((texture) => texture.path),
        asset.native?.kit, asset.splat?.collection,
      ].filter(Boolean).join(" ").toLowerCase().replaceAll("_", " "),
    };
  }

  const baseEntries = catalog.assets.map(buildEntry);
  let entries = [...baseEntries];

  function assetFlags(asset) {
    const flags = new Set();
    for (const v of assetVariants(asset)) {
      for (const f of reviews[v.key]?.flags ?? []) flags.add(f);
    }
    return flags;
  }

  function byDecision(asset, filter) {
    if (!filter) return true;
    if (filter.startsWith("flag:")) {
      return assetFlags(asset).has(filter.slice(5));
    }
    const status = assetVariants(asset).map((variant) => reviews[variant.key]?.decision);
    return filter === "unreviewed" ? !status.some((value) => value && value !== "unreviewed") : status.includes(filter);
  }

  function assetReviewState(asset) {
    const status = assetVariants(asset).map((variant) => reviews[variant.key]?.decision).filter(Boolean);
    for (const d of ["approved", "regenerate", "remove"]) {
      if (status.includes(d)) return d;
    }
    return "unreviewed";
  }

  function currentResults() {
    const query = byId("query").value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const project = byId("project-select").value;
    const folder = byId("folder-select").value;
    const category = byId("category").value;
    const part = byId("part").value;
    const material = byId("material").value;
    const tag = byId("tag-filter").value;
    const selectedStage = byId("stage").value;
    const onlyDepth = byId("depth").checked;
    const review = byId("review-filter").value;
    const results = entries.filter((entry) => {
      const { asset, search, depth } = entry;
      return query.every((word) => search.includes(word)) &&
        (!project || entry.project === project) &&
        (!folder || entry.folder === folder) &&
        (!category || asset.category === category) &&
        (!part || asset.part === part) &&
        (!material || asset.materials.includes(material)) &&
        (!tag || entry.tags.includes(tag)) &&
        matchesStage(entry, selectedStage) &&
        (!onlyDepth || depth) &&
        byDecision(asset, review);
    });
    const sort = byId("sort").value;
    if (sort === "triangles") {
      results.sort((a, b) => (primaryModel(b.asset)?.triangles ?? -1) - (primaryModel(a.asset)?.triangles ?? -1));
    } else if (sort === "budget") {
      results.sort((a, b) => overBudget(b.asset) - overBudget(a.asset));
    } else if (sort === "project") {
      results.sort((a, b) => a.project.localeCompare(b.project, "fi") || a.folder.localeCompare(b.folder, "fi") || a.asset.name.localeCompare(b.asset.name, "fi"));
    }
    return results;
  }

  function updateSidebarState() {
    const project = byId("project-select").value;
    const folder = byId("folder-select").value;
    const category = byId("category").value;
    const part = byId("part").value;
    const material = byId("material").value;
    const selectedStage = byId("stage").value;
    const review = byId("review-filter").value;
    const tag = byId("tag-filter").value;

    for (const btn of byId("smart-views").children) {
      const kind = btn.dataset.smart;
      const pressed =
        (kind === "all" && !project && !folder && !category && !selectedStage && !review && !tag) ||
        (kind === "stage:" + selectedStage && !project && !folder && !category && !review) ||
        (kind === "review:" + review && !project && !folder && !category && !selectedStage);
      btn.setAttribute("aria-pressed", String(pressed));
    }

    for (const group of byId("project-tree").querySelectorAll(".project-main")) {
      group.setAttribute("aria-pressed", String(group.dataset.project === project && !folder));
    }
    for (const sub of byId("project-tree").querySelectorAll(".subfolder-item")) {
      sub.setAttribute("aria-pressed", String(sub.dataset.project === project && sub.dataset.folder === folder));
    }
    for (const btn of byId("category-tree").children) {
      btn.setAttribute("aria-pressed", String(btn.dataset.category === category));
    }

    const crumbs = [];
    if (project) crumbs.push(project);
    if (folder) crumbs.push(folder);
    if (category) crumbs.push(categoryNames[category] ?? category);
    if (selectedStage) crumbs.push(selectedStage === "over-budget-tris" ? "Yli kolmiobudjetin" : (stageNames[selectedStage] ?? selectedStage));
    if (tag) crumbs.push("#" + tag);
    if (review) crumbs.push(review.startsWith("flag:") ? reviewFlagLabels[review.slice(5)] : (labels[review] ?? review));
    byId("breadcrumb").textContent = crumbs.length ? crumbs.join(" / ") : "Kaikki assetit";

    const chipBar = byId("active-filters");
    chipBar.replaceChildren();
    const activePairs = [
      project && ["Projekti: " + project, () => { byId("project-select").value = ""; byId("folder-select").value = ""; }],
      folder && ["Kansio: " + folder, () => { byId("folder-select").value = ""; }],
      category && ["Kategoria: " + (categoryNames[category] ?? category), () => { byId("category").value = ""; }],
      part && ["Osa: " + part, () => { byId("part").value = ""; }],
      material && ["Materiaali: " + (localMaterials[material] ?? material), () => { byId("material").value = ""; }],
      tag && ["#" + tag, () => { byId("tag-filter").value = ""; }],
      selectedStage && ["Vaihe: " + (selectedStage === "over-budget-tris" ? "Yli budjetin" : (stageNames[selectedStage] ?? selectedStage)), () => { byId("stage").value = ""; }],
      review && ["Arvio: " + (review.startsWith("flag:") ? reviewFlagLabels[review.slice(5)] : (labels[review] ?? review)), () => { byId("review-filter").value = ""; }],
      byId("depth").checked && ["Syvyys/korkeus", () => { byId("depth").checked = false; }],
    ].filter(Boolean);
    chipBar.hidden = activePairs.length === 0;
    for (const [label, clear] of activePairs) {
      const chip = element("button", label + " ×", "filter-chip");
      chip.type = "button";
      chip.addEventListener("click", () => { clear(); page = 0; render(); });
      chipBar.append(chip);
    }
  }

  function refreshDropdowns() {
    fillSelect("project-select", entries.map((e) => e.project), (k) => k, "Kaikki projektit");
    fillSelect("folder-select", entries.map((e) => e.folder), (k) => k, "Kaikki kansiot");
    fillSelect("category", entries.map(({ asset }) => asset.category), (key) => categoryNames[key] ?? key, "Kaikki kategoriat");
    fillSelect("part", entries.map(({ asset }) => asset.part), (key) => key, "Kaikki osat");
    fillSelect("material", entries.flatMap(({ asset }) => asset.materials), (key) => localMaterials[key] ?? key, "Kaikki materiaalit");
    fillSelect("tag-filter", entries.flatMap((e) => e.tags), (key) => "#" + key, "Kaikki tagit");
  }

  function buildSidebar() {
    const smartList = byId("smart-views");
    smartList.replaceChildren();
    const smartSpecs = [
      ["all", "Kaikki", "#4c8dff", entries.length, () => resetFilters()],
      ["stage:glb", "3D-mallit (GLB)", "#38bdf8", entries.filter((e) => e.glb).length, () => { resetFilters(); byId("stage").value = "glb"; }],
      ["stage:gameready", "Gameready", "#57c485", entries.filter((e) => matchesStage(e, "gameready")).length, () => { resetFilters(); byId("stage").value = "gameready"; }],
      ["stage:over-budget-tris", "Yli budjetin", "#f0a17d", entries.filter((e) => overBudget(e.asset) > 0).length, () => { resetFilters(); byId("stage").value = "over-budget-tris"; }],
      ["stage:textures", "Tekstuuri ilman GLB:tä", "#e4b663", entries.filter((e) => matchesStage(e, "textures")).length, () => { resetFilters(); byId("stage").value = "textures"; }],
      ["review:flag:reduce_tris", "Pienennettävä kolmioita", "#e4b663", entries.filter((e) => byDecision(e.asset, "flag:reduce_tris")).length, () => { resetFilters(); byId("review-filter").value = "flag:reduce_tris"; }],
      ["review:flag:duplicate_exists", "Samanlainen jo olemassa", "#c084fc", entries.filter((e) => byDecision(e.asset, "flag:duplicate_exists")).length, () => { resetFilters(); byId("review-filter").value = "flag:duplicate_exists"; }],
      ["review:approved", "Hyväksytty", "#57c485", entries.filter((e) => byDecision(e.asset, "approved")).length, () => { resetFilters(); byId("review-filter").value = "approved"; }],
    ];
    for (const [key, title, color, count, apply] of smartSpecs) {
      const btn = element("button", undefined, "nav-item");
      btn.type = "button";
      btn.dataset.smart = key;
      const dot = element("span", undefined, "nav-dot");
      dot.style.background = color;
      btn.append(dot, element("span", title, "nav-label"), element("span", locale.format(count), "nav-count"));
      btn.addEventListener("click", () => { apply(); page = 0; render(); });
      smartList.append(btn);
    }

    // Build collapsible Project -> Subfolders tree
    const projMap = new Map();
    for (const e of entries) {
      if (!projMap.has(e.project)) projMap.set(e.project, { count: 0, folders: new Map() });
      const pNode = projMap.get(e.project);
      pNode.count += 1;
      pNode.folders.set(e.folder, (pNode.folders.get(e.folder) ?? 0) + 1);
    }
    byId("project-count-pill").textContent = projMap.size === 1 ? "1 projekti" : projMap.size + " projektia";

    const projectList = byId("project-tree");
    projectList.replaceChildren();
    [...projMap.entries()].sort((a, b) => (a[0] === "Mindflower" ? -1 : b[0] === "Mindflower" ? 1 : a[0].localeCompare(b[0], "fi"))).forEach(([proj, info], pIdx) => {
      const group = element("div", undefined, "project-group");
      const isExpanded = expandedProjects.has(proj);
      const row = element("div", undefined, "project-row");

      const toggle = element("button", isExpanded ? "▾" : "▸", "tree-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(isExpanded));
      toggle.title = isExpanded ? "Piilota kansiot" : "Avaa kansiot";

      const mainBtn = element("button", undefined, "nav-item project-main");
      mainBtn.type = "button";
      mainBtn.dataset.project = proj;
      const dot = element("span", undefined, "nav-dot");
      dot.style.background = projectColors[pIdx % projectColors.length];
      mainBtn.append(dot, element("span", proj, "nav-label"), element("span", locale.format(info.count), "nav-count"));
      mainBtn.addEventListener("click", () => {
        const sameProj = byId("project-select").value === proj && !byId("folder-select").value;
        byId("project-select").value = sameProj ? "" : proj;
        byId("folder-select").value = "";
        if (!sameProj) {
          expandedProjects.add(proj);
          saveExpanded();
          childrenBox.hidden = false;
          toggle.textContent = "▾";
          toggle.setAttribute("aria-expanded", "true");
        }
        page = 0;
        render();
      });

      row.append(toggle, mainBtn);
      if (importedProjects.has(proj)) {
        const rm = element("button", "×", "project-remove");
        rm.type = "button";
        rm.title = "Poista tuotu projektikansio näkymästä";
        rm.addEventListener("click", () => removeImportedProject(proj));
        row.append(rm);
      }

      const childrenBox = element("div", undefined, "project-children");
      childrenBox.hidden = !isExpanded;
      toggle.addEventListener("click", () => {
        if (expandedProjects.has(proj)) expandedProjects.delete(proj);
        else expandedProjects.add(proj);
        saveExpanded();
        const open = expandedProjects.has(proj);
        childrenBox.hidden = !open;
        toggle.textContent = open ? "▾" : "▸";
        toggle.setAttribute("aria-expanded", String(open));
      });

      [...info.folders.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fi")).forEach(([folderName, fCount], fIdx) => {
        const fBtn = element("button", undefined, "nav-item subfolder-item");
        fBtn.type = "button";
        fBtn.dataset.project = proj;
        fBtn.dataset.folder = folderName;
        const fDot = element("span", undefined, "folder-dot");
        fDot.style.background = projectColors[(pIdx + fIdx + 1) % projectColors.length];
        fBtn.append(fDot, element("span", folderName, "nav-label"), element("span", locale.format(fCount), "nav-count"));
        fBtn.addEventListener("click", () => {
          const same = byId("project-select").value === proj && byId("folder-select").value === folderName;
          if (same) {
            byId("folder-select").value = "";
          } else {
            byId("project-select").value = proj;
            byId("folder-select").value = folderName;
          }
          page = 0;
          render();
        });
        childrenBox.append(fBtn);
      });

      group.append(row, childrenBox);
      projectList.append(group);
    });

    const catCounts = new Map();
    for (const e of entries) catCounts.set(e.asset.category, (catCounts.get(e.asset.category) ?? 0) + 1);
    const catList = byId("category-tree");
    catList.replaceChildren();
    [...catCounts.entries()].sort((a, b) => (categoryNames[a[0]] ?? a[0]).localeCompare(categoryNames[b[0]] ?? b[0], "fi")).forEach(([cat, count]) => {
      const btn = element("button", undefined, "nav-item");
      btn.type = "button";
      btn.dataset.category = cat;
      const dot = element("span", undefined, "nav-dot");
      dot.style.background = categoryColors[cat] ?? "#94a3b8";
      btn.append(dot, element("span", categoryNames[cat] ?? cat, "nav-label"), element("span", locale.format(count), "nav-count"));
      btn.addEventListener("click", () => {
        byId("category").value = byId("category").value === cat ? "" : cat;
        page = 0;
        render();
      });
      catList.append(btn);
    });
  }

  function render() {
    updateSidebarState();
    const results = currentResults();
    const last = Math.max(0, Math.ceil(results.length / PAGE_SIZE) - 1);
    page = Math.min(page, last);
    byId("result-count").textContent = locale.format(results.length) + " assettia";
    byId("page").textContent = (page + 1) + " / " + (last + 1);
    byId("previous").disabled = page === 0;
    byId("next").disabled = page === last;

    const container = byId("results");
    container.replaceChildren();
    const slice = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    for (const entry of slice) {
      const { asset } = entry;
      const card = element("button", undefined, "asset-card" + (active?.id === asset.id ? " selected" : ""));
      card.type = "button";
      card.dataset.id = asset.id;

      const thumb = element("div", undefined, "card-thumb");
      const thumbPath = asset.thumbnail || asset.references?.[0]?.preview || asset.textures?.[0]?.preview;
      if (thumbPath) {
        const img = element("img");
        img.src = asset._localThumbUrl || modelURL(thumbPath);
        img.alt = asset.name;
        img.loading = "lazy";
        thumb.append(img);
      } else {
        const ph = element("div", undefined, "thumb-placeholder");
        ph.append(element("strong", entry.glb ? "GLB" : asset.splat ? "SPLAT" : asset.native ? "GODOT" : "ASSET"),
          element("span", asset.part));
        thumb.append(ph);
      }

      const gr = isStrictlyGameready(entry);
      const isOver = overBudget(asset) > 0;
      const badgeText = gr ? "Gameready" : isOver ? "Yli budjetin" : (stageNames[entry.stage] ?? entry.stage);
      thumb.append(element("span", badgeText, "card-badge" + (gr ? " good" : isOver ? " warn" : "")));

      const model = primaryModel(asset);
      if (model) {
        const triText = model.triangles >= 1000 ? (model.triangles / 1000).toFixed(model.triangles >= 10000 ? 0 : 1).replace(".", ",") + "k" : String(model.triangles);
        thumb.append(element("span", triText + " tri", "card-tris"));
      }
      const reviewState = assetReviewState(asset);
      if (reviewState !== "unreviewed") {
        thumb.append(element("span", undefined, "card-review-dot " + reviewState));
      }
      const flags = assetFlags(asset);
      if (flags.size) {
        const flagRow = element("div", undefined, "card-flag-row");
        if (flags.has("reduce_tris")) flagRow.append(element("span", "−kolmioita", "card-flag-pill reduce"));
        if (flags.has("duplicate_exists")) flagRow.append(element("span", "duplikaatti", "card-flag-pill dup"));
        thumb.append(flagRow);
      }

      const body = element("div", undefined, "card-body");
      body.append(element("strong", asset.name, "card-title"));
      body.append(element("span", entry.folder + " · " + asset.part, "card-sub"));
      const tagRow = element("div", undefined, "card-tags");
      const visibleTags = entry.tags.filter((t) => t !== "3d-glb").slice(0, 3);
      for (const t of visibleTags) {
        tagRow.append(element("span", t, "mini-tag"));
      }
      if (visibleTags.length) body.append(tagRow);

      card.append(thumb, body);
      card.addEventListener("click", () => selectAsset(asset));
      card.addEventListener("dblclick", () => { selectAsset(asset); openExpanded(); });
      container.append(card);
    }

    if (!results.length) {
      container.append(element("p", "Näillä suodattimilla ei löytynyt assetteja.", "empty"));
    } else if (!active && slice.length) {
      selectAsset(slice[0].asset);
    }
  }

  function clearPreview() {
    previewRevision += 1;
    byId("preview").replaceChildren();
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = undefined;
    byId("preview-tip").textContent = "";
  }

  function loadViewer() {
    if (customElements.get("model-viewer")) return Promise.resolve();
    if (!viewerLoad) {
      viewerLoad = Promise.race([
        customElements.whenDefined("model-viewer"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
      ]).catch(() =>
        import("https://cdnjs.cloudflare.com/ajax/libs/model-viewer/4.1.0/model-viewer.min.js")
          .then(() => customElements.whenDefined("model-viewer"))
      ).catch((error) => { viewerLoad = undefined; throw error; });
    }
    return viewerLoad;
  }

  function localServerBase() {
    if (globalThis.location?.protocol !== "file:") return Promise.resolve(null);
    if (!serverCheck) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      serverCheck = fetch(LOCAL_SERVER + "/asset_catalog/budgets.json", { mode: "cors", signal: controller.signal })
        .then((res) => (res.ok ? LOCAL_SERVER : null))
        .catch(() => null)
        .finally(() => clearTimeout(timer));
    }
    return serverCheck;
  }

  function indexLocalFile(relativePath, file) {
    const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
    const segments = normalized.split("/").filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      localFiles.set(segments.slice(index).join("/"), file);
    }
    const base = segments.at(-1);
    if (base) {
      const list = localByName.get(base) ?? [];
      list.push(file);
      localByName.set(base, list);
    }
  }

  function connectedFile(model) {
    if (model._localFile) return model._localFile;
    for (const candidate of [model, ...(model.aliases ?? [])]) {
      const exact = localFiles.get(candidate.path.toLowerCase());
      if (exact && exact.size === model.bytes) return exact;
    }
    for (const candidate of [model, ...(model.aliases ?? [])]) {
      const byPath = localFiles.get(candidate.path.toLowerCase());
      if (byPath) return byPath;
    }
    const base = model.path.split("/").at(-1)?.toLowerCase();
    const candidates = base ? (localByName.get(base) ?? []) : [];
    return candidates.find((file) => file.size === model.bytes) ?? (candidates.length === 1 ? candidates[0] : undefined);
  }

  function modelURL(path) {
    if (/^(blob:|data:|https?:)/.test(path)) return path;
    return path.split("/").map((component) => encodeURIComponent(component)).join("/");
  }

  function showPreviewFallback(area, text, allowPick = true) {
    const box = element("div", undefined, "preview-fallback");
    box.append(element("p", text));
    if (allowPick) {
      const row = element("div", undefined, "preview-actions");
      const folderButton = element("button", "Tuo projektikansio");
      folderButton.type = "button";
      folderButton.addEventListener("click", () => byId("folder").click());
      const fileButton = element("button", "Avaa paikallinen GLB");
      fileButton.type = "button";
      fileButton.addEventListener("click", () => byId("model-input").click());
      row.append(folderButton, fileButton);
      box.append(row, element("p", "Voit myös vetää .glb-tiedoston tai kokonaisen kansion suoraan tähän."));
    }
    area.replaceChildren(box);
  }

  async function previewModel(model, file = connectedFile(model)) {
    const version = previewRevision;
    const area = byId("preview");
    if (file && model.sha256 && globalThis.crypto?.subtle) {
      const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const signature = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (version !== previewRevision) return;
      if (signature !== model.sha256 && !file._manualDrop) {
        showPreviewFallback(area, "Valittu tiedosto ei vastaa tämän version tarkistussummaa.");
        return;
      }
    }
    if (version !== previewRevision) return;
    const serverBase = !file && model.preview ? await localServerBase() : null;
    if (version !== previewRevision) return;
    if (!file && !model.preview) {
      showPreviewFallback(area, model.format === "glb"
        ? "Yhdistä paikallinen mallikansio (+ Tuo kansio) tai avaa .glb nähdäksesi tämän korkeapolygonisen tai paikallisen mallin."
        : "Tämän glTF-version tiedot ovat alla.", model.format === "glb");
      return;
    }
    if (file) objectURL = URL.createObjectURL(file);
    let url = objectURL;
    if (!url) {
      if (serverBase && model.preview.startsWith("../")) {
        url = serverBase + "/" + modelURL(model.preview.slice(3));
      } else if (serverBase) {
        url = serverBase + "/asset_catalog/" + modelURL(model.preview);
      } else {
        url = modelURL(model.preview);
      }
    }
    const openHint = !file && globalThis.location?.protocol === "file:"
      ? "Selain estää suoran file://-latauksen ilman paikallista palvelinta (Open_Asset_Browser.cmd) tai kansion tuontia."
      : "Kokeile Avaa GLB - tai Tuo kansio -painiketta.";
    area.replaceChildren(element("p", "Ladataan 3D-esikatselua…"));
    try {
      await loadViewer();
      if (version !== previewRevision) return;
      const viewer = element("model-viewer");
      viewer.setAttribute("camera-controls", "");
      viewer.setAttribute("touch-action", "pan-y");
      viewer.setAttribute("shadow-intensity", "0.65");
      viewer.setAttribute("environment-image", "neutral");
      viewer.setAttribute("exposure", "1");
      viewer.setAttribute("alt", active.name);
      viewer.addEventListener("error", () => {
        if (version === previewRevision) showPreviewFallback(area, "Mallia ei saatu avattua. " + openHint);
      });
      viewer.setAttribute("src", url);
      area.replaceChildren(viewer);
      byId("preview-tip").textContent = "Pyöritä vetämällä · Zoomaa rullalla";
    } catch {
      if (version === previewRevision) showPreviewFallback(area, "3D-katselinta ei saatu ladattua.");
    }
  }

  function loadReviewControls(key) {
    const rec = reviews[key];
    byId("decision").value = rec?.decision ?? "unreviewed";
    const flags = new Set(rec?.flags ?? []);
    byId("flag-reduce-tris").checked = flags.has("reduce_tris");
    byId("flag-duplicate").checked = flags.has("duplicate_exists");
    byId("notes").value = rec?.notes ?? "";
    byId("saved").textContent = "";
  }

  function updateDetails() {
    if (!active) return;
    clearPreview();
    const { kind, item, key } = variants[Number(byId("variant").value)];
    const data = element("dl");
    function field(label, value, className) {
      if (value === undefined || value === null || value === "") return;
      data.append(element("dt", label), element("dd", value, className));
    }
    const area = byId("preview");
    const budget = catalog.budgets[active.part];
    byId("choose-model").hidden = kind !== "model" || item.format !== "glb";
    const materials = active.materials.map((name) => localMaterials[name] ?? name);
    field("Materiaali", materials.join(", ") || "Tunnistamatta");
    if (budget) {
      field("LOD0-budjetti", budget.triangles.map((n) => locale.format(n)).join("–") + " kolmiota");
      if (budget.metres) field("Pelin tavoitekoko", budget.metres.map((n) => locale.format(n)).join("–") + " m");
      field("Kiinnitys", budget.anchor);
    }
    if (active.generation) {
      field("Modly-työnkulku", "TripoSG → TRELLIS.2 GGUF Texture Mesh");
      field("TripoSG Max Faces", locale.format(active.generation.max_faces));
      field("Syötekuvan kulma", active.generation.view);
      if (active.generation.download) {
        const workflow = element("a", "Lataa työnkulku");
        workflow.href = modelURL(active.generation.download);
        workflow.download = "";
        const cell = element("dd");
        cell.append(workflow);
        data.append(element("dt", "Modly"), cell);
      }
    }
    const preparation = active.preparation;
    if (preparation?.result === "over-budget") {
      const last = preparation.attempts.at(-1);
      field("Valmistelutulos", locale.format(last.triangles) + " / " +
        locale.format(preparation.target.target_faces) + " kolmiota", "over");
    } else if (preparation?.result === "material-or-structure-review") {
      field("Valmistelutulos", "Materiaali tai rakenne vaatii tarkistuksen", "over");
    }
    if (kind === "model") {
      field("Tiedosto", item.path);
      field("Sijainti", item.origin === "modly" ? "Modlyn työtila" : item.origin === "local-folder" ? "Oma projektikansio" : (active.project || "Kirjasto"));
      field("Vaihe", labels[item.stage] ?? item.stage);
      field("Verkot / instanssit", item.meshes === undefined ? undefined : item.meshes + " / " + item.mesh_instances);
      const cap = budgetCap(active, item);
      field("Kolmiot", item.triangles === undefined ? "Ei mitattu" : locale.format(item.triangles) + (cap && item.triangles > cap ? " (yli " + locale.format(cap) + ")" : ""),
        cap && item.triangles > cap ? "over" : undefined);
      field(item.stage === "modly-weapon" ? "GLB:n raakakoko" : "Koko X × Y × Z",
        item.bounds_m ? item.bounds_m.map((n) => locale.format(n)).join(" × ") + " m" : "Ei mitattu");
      field("Materiaalit", item.materials);
      field("Luustot / animaatiot", item.skins === undefined ? undefined : item.skins + " / " + item.animations);
      field("Kiinnityspisteet", item.sockets?.join(", ") || "Ei nimettyjä");
      for (const [channel, sizes] of Object.entries(item.maps ?? {})) {
        field(channel, sizes.length ? sizes.map((size) => size.join(" × ")).join(", ") : "Kartta käytössä");
      }
      field("Syvyys / korkeus", active.textures.some((tex) => Object.keys(tex.maps ?? {}).some(isDepth)) ?
        "Erillinen projektikartta" : "Karttaa ei todettu");
      if (item.modly_job) {
        field("Modlyn ajotunnus", item.modly_job.id);
        const job = item.modly_job;
        field("Ajon tavoite", [job.target_faces && job.target_faces + " kolmiota",
          job.size_m && job.size_m + " m", job.dimension].filter(Boolean).join(" · "));
      }
      if (item.preparation) {
        field("Modly-lähde", locale.format(item.preparation.source_triangles) + " kolmiota");
        field("Tämän version budjetti", locale.format(item.preparation.target.target_faces) + " kolmiota");
      }
      field("Samat tiedostot", item.aliases?.map((alias) => alias.origin + "/" + alias.path).join(", "));
      field("Mittaus", item.error);
      void previewModel(item);
    } else if (kind === "texture") {
      field("Tiedosto", item.path);
      field("Koko", item.size?.join(" × "));
      field("Käyttö", item.role === "registered views" ? "Rekisteröity kuvapinta" : "Projektitekstuuri");
      field("GLB", hasGlb(active) ? "Assetilla on GLB" : "Odottaa GLB:tä");
      for (const [channel, map] of Object.entries(item.maps ?? {})) field(channel, map.path + " · " + map.provenance);
      const texImg = item.preview || active.thumbnail;
      if (texImg) {
        const image = element("img");
        image.alt = active.name;
        image.src = active._localThumbUrl || modelURL(texImg);
        image.addEventListener("error", () => {
          if (image.isConnected) area.replaceChildren(element("p", "Tekstuuriesikatselua ei saatu avattua."));
        });
        area.replaceChildren(image);
      } else {
        area.replaceChildren(element("p", "Kuvan tiedot ovat alla."));
      }
    } else {
      field("GLB-versiot", active.models.filter((model) => model.format === "glb").length);
      field("Tekstuurit", active.textures.length);
      field("Lähdeaineisto", active.source_designs.join(", "));
      if (active.splat) {
        field("Gaussian-pisteet", active.splat.points ? locale.format(active.splat.points) : "Ei mitattu");
        field("Modlyn ajotunnus", active.splat.job);
        field("Kokoelma", active.splat.collection);
      }
      if (active.native) {
        field("Godot-osa", active.native.path);
        field("Rakennekokoelma", active.native.kit);
      }
      if (active.thumbnail) {
        const image = element("img");
        image.alt = active.name;
        image.src = active._localThumbUrl || modelURL(active.thumbnail);
        area.replaceChildren(image);
      } else {
        area.replaceChildren(element("p", active.splat ? "Gaussian splat" : active.native ? "Godot-moduuli" : "Koko assetin arvio"));
      }
    }
    byId("metadata").replaceChildren(data);
    loadReviewControls(key);
  }

  function selectAsset(asset) {
    active = asset;
    variants = assetVariants(asset);
    byId("inspector-empty").hidden = true;
    inspectorContent.hidden = false;
    byId("detail-title").textContent = asset.name;
    byId("detail-kind").textContent = (categoryNames[asset.category] ?? asset.category) + " / " + asset.part;
    byId("detail-modal-title").textContent = asset.name;
    byId("detail-modal-sub").textContent = (asset.project || "Mindflower") + " / " + (asset.folder || "Yleinen") + " · " + (categoryNames[asset.category] ?? asset.category);

    byId("insp-project").textContent = asset.project || "Mindflower";
    byId("insp-folder").textContent = asset.folder || "Yleinen";

    const tagBox = byId("insp-tags");
    tagBox.replaceChildren();
    for (const tag of asset.tags ?? []) {
      const chip = element("button", "#" + tag, "tag-chip");
      chip.type = "button";
      chip.addEventListener("click", () => {
        byId("tag-filter").value = byId("tag-filter").value === tag ? "" : tag;
        page = 0;
        render();
      });
      tagBox.append(chip);
    }

    const selection = byId("variant");
    selection.replaceChildren();
    for (const [index, variant] of variants.entries()) {
      const { kind, item } = variant;
      const name = kind === "model" ? (labels[item.stage] ?? item.stage) + " · " + item.path.split("/").at(-1) :
        kind === "texture" ? "Kuva · " + item.path.split("/").at(-1) : "Koko assetti";
      selection.append(new Option(name, String(index)));
    }
    const previewable = variants.findIndex(({ kind, item }) => kind === "model" && (item.preview || connectedFile(item)));
    selection.value = String(previewable >= 0 ? previewable : 0);

    const references = byId("references");
    const pictures = (asset.references ?? []).filter((picture) => picture.preview);
    references.hidden = !pictures.length;
    references.replaceChildren();
    if (pictures.length) {
      const gallery = element("div", undefined, "reference-grid");
      for (const picture of pictures) {
        const link = element("a", undefined, "reference-image");
        link.href = modelURL(picture.preview);
        link.target = "_blank";
        link.rel = "noopener";
        const img = element("img");
        img.src = link.href;
        img.alt = asset.name + " · " + picture.label;
        img.loading = "lazy";
        link.append(img, element("span", picture.label));
        gallery.append(link);
      }
      references.append(element("h3", "Referenssikuvat"), gallery);
    }

    for (const card of byId("results").children) {
      card.classList.toggle("selected", card.dataset.id === asset.id);
    }
    updateDetails();
  }

  function openExpanded() {
    if (!active) return;
    detailMount.append(inspectorContent);
    dialog.showModal();
  }

  dialog.addEventListener("close", () => {
    inspectorHost.append(inspectorContent);
  });
  byId("expand-detail").addEventListener("click", openExpanded);
  byId("insp-project").addEventListener("click", () => {
    if (!active) return;
    const p = active.project || "";
    const same = byId("project-select").value === p && !byId("folder-select").value;
    byId("project-select").value = same ? "" : p;
    byId("folder-select").value = "";
    page = 0;
    render();
  });
  byId("insp-folder").addEventListener("click", () => {
    if (!active) return;
    const p = active.project || "";
    const f = active.folder || "";
    const same = byId("project-select").value === p && byId("folder-select").value === f;
    byId("project-select").value = same ? "" : p;
    byId("folder-select").value = same ? "" : f;
    page = 0;
    render();
  });

  function persist() {
    try {
      localStorage.setItem(STORE, JSON.stringify(reviews));
      return true;
    } catch { return false; }
  }

  function saveCurrentReview(feedbackText) {
    if (!active || !variants.length) return;
    const { key } = variants[Number(byId("variant").value)];
    const flags = [];
    if (byId("flag-reduce-tris").checked) flags.push("reduce_tris");
    if (byId("flag-duplicate").checked) flags.push("duplicate_exists");
    reviews[key] = {
      asset: active.id,
      decision: byId("decision").value,
      flags,
      notes: byId("notes").value.trim(),
      updated: new Date().toISOString(),
    };
    const ok = persist();
    byId("saved").textContent = feedbackText ?? (ok ? "Tallennettu selaimeen." : "Tallennettu istuntoon. Vie arviot JSON-tiedostoon.");
    buildSidebar();
    render();
  }

  function resetFilters() {
    for (const id of filters) {
      const control = byId(id);
      if (control.type === "checkbox") control.checked = false;
      else control.value = id === "sort" ? "name" : "";
    }
    page = 0;
  }

  byId("review-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveCurrentReview();
  });
  for (const id of ["flag-reduce-tris", "flag-duplicate", "decision"]) {
    byId(id).addEventListener("change", () => saveCurrentReview("Päivitetty."));
  }

  byId("export").addEventListener("click", () => {
    const file = new Blob([JSON.stringify({ schema: 1, reviews }, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const anchor = element("a");
    anchor.href = url;
    anchor.download = "catalogisti-reviews.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  byId("import").addEventListener("click", () => byId("import-input").click());
  byId("import-input").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 10_000_000) throw new Error("size");
      const data = JSON.parse(await file.text());
      if (data.schema !== 1 || !data.reviews || typeof data.reviews !== "object" || Array.isArray(data.reviews)) throw new Error("schema");
      const imported = Object.entries(data.reviews);
      for (const [key, review] of imported) {
        if (!/^(model|texture|asset):/.test(key) || !decisions.has(review?.decision) ||
            typeof review.notes !== "string" || review.notes.length > 4000 ||
            (review.flags !== undefined && !Array.isArray(review.flags)) ||
            typeof review.asset !== "string" || typeof review.updated !== "string" ||
            !Number.isFinite(Date.parse(review.updated))) throw new Error("decision");
      }
      for (const [key, review] of imported) {
        if (!reviews[key] || Date.parse(reviews[key].updated) <= Date.parse(review.updated)) reviews[key] = review;
      }
      const stored = persist();
      byId("message").textContent = imported.length + " arviota luettu." + (stored ? "" : " Vie arviot ennen tämän sivun sulkemista.");
      buildSidebar();
      render();
    } catch {
      byId("message").textContent = "Valitse katalogista viety arvioiden JSON-tiedosto.";
    }
    event.target.value = "";
  });

  /* === In-browser GLB Binary Inspector + Bring-Your-Own-Folder Importer === */
  const SKIP_DIRS = new Set([".git", ".godot", "node_modules", "__pycache__", "export_templates", "backups"]);
  const IMG_EXT = /\.(png|jpe?g|webp)$/i;

  function guessCategoryPart(name, folderPath) {
    const s = (name + " " + folderPath).toLowerCase();
    if (/pommel|blade|sword|barrel|receiver|grip|handle|crossguard|handguard|weapon/.test(s)) return ["Weapon parts", "Fitting / attachment"];
    if (/helmet/.test(s)) return ["Armor", "Helmet"];
    if (/cuirass|corset|pauldron|bracer|gauntlet|shin|thigh|armor|armour/.test(s)) return ["Armor", "Armor component"];
    if (/boss|giant|enemy|monster|robot|boar|bear|spider|shark|raider/.test(s)) return ["Enemies", "Enemy"];
    if (/character|npc|hero|player|avatar/.test(s)) return ["Characters", "Character"];
    if (/locomotive|wagon|car|vehicle|airship|ship|train/.test(s)) return ["Vehicles", "Rail vehicle"];
    if (/rail|station|semaphore|turnout|buffer|signal/.test(s)) return ["Railway", "Prop"];
    if (/building|house|wall|window|door|column|arch|roof|tower|kiosk|pipe|valve/.test(s)) return ["Buildings", "Building part"];
    if (/ring|amulet|shield|bag|backpack|lantern|glasses|goggles|accessory/.test(s)) return ["Accessories", "Accessory"];
    return ["Props", "Prop"];
  }

  function guessMaterials(text) {
    const found = new Set();
    const re = /\b(bronze|brass|copper|iron|steel|leather|wood(?:en)?|glass|enamel|marble|stone|nickel|gunmetal|ceramic)\b/gi;
    let m;
    while ((m = re.exec(text.replace(/_/g, " ")))) {
      const k = m[1].toLowerCase() === "wooden" ? "Wood" : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      found.add(k);
    }
    return [...found].sort();
  }

  async function inspectGlbMetadata(file) {
    try {
      if (file.size < 20) return {};
      const hdr = new DataView(await file.slice(0, 20).arrayBuffer());
      if (hdr.getUint32(0, true) !== 0x46546c67 || hdr.getUint32(4, true) !== 2) return {};
      const jsonLen = hdr.getUint32(12, true);
      if (hdr.getUint32(16, true) !== 0x4e4f534a || jsonLen > 16_000_000) return {};
      const gltf = JSON.parse(new TextDecoder().decode(await file.slice(20, 20 + jsonLen).arrayBuffer()));
      const accessors = gltf.accessors ?? [];
      let triangles = 0;
      let meshInstances = 0;
      const minB = [Infinity, Infinity, Infinity];
      const maxB = [-Infinity, -Infinity, -Infinity];
      for (const node of gltf.nodes ?? []) {
        if (node.mesh !== undefined) meshInstances += 1;
      }
      for (const mesh of gltf.meshes ?? []) {
        for (const prim of mesh.primitives ?? []) {
          const mode = prim.mode ?? 4;
          const idxAcc = prim.indices !== undefined ? accessors[prim.indices] : undefined;
          const posAcc = prim.attributes?.POSITION !== undefined ? accessors[prim.attributes.POSITION] : undefined;
          const count = idxAcc?.count ?? posAcc?.count ?? 0;
          if (mode === 4) triangles += Math.floor(count / 3);
          else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
          if (posAcc?.min && posAcc?.max) {
            for (let i = 0; i < 3; i += 1) {
              minB[i] = Math.min(minB[i], posAcc.min[i]);
              maxB[i] = Math.max(maxB[i], posAcc.max[i]);
            }
          }
        }
      }
      const maps = {};
      const texList = gltf.textures ?? [];
      const addMap = (label) => { if (!maps[label]) maps[label] = []; };
      for (const mat of gltf.materials ?? []) {
        const pbr = mat.pbrMetallicRoughness ?? {};
        if (pbr.baseColorTexture && texList[pbr.baseColorTexture.index]) addMap("Albedo");
        if (pbr.metallicRoughnessTexture && texList[pbr.metallicRoughnessTexture.index]) addMap("Metallic / roughness");
        if (mat.normalTexture && texList[mat.normalTexture.index]) addMap("Normal");
        if (mat.occlusionTexture && texList[mat.occlusionTexture.index]) addMap("AO");
      }
      const bounds_m = Number.isFinite(minB[0])
        ? [0, 1, 2].map((i) => Math.round((maxB[i] - minB[i]) * 1000) / 1000)
        : undefined;
      return {
        triangles: Math.round(triangles),
        meshes: (gltf.meshes ?? []).length,
        mesh_instances: meshInstances || (gltf.meshes ?? []).length,
        materials: (gltf.materials ?? []).length,
        material_names: (gltf.materials ?? []).map((m) => m.name).filter(Boolean),
        skins: (gltf.skins ?? []).length,
        animations: (gltf.animations ?? []).length,
        bounds_m,
        maps,
      };
    } catch {
      return {};
    }
  }

  function removeImportedProject(projectName) {
    const info = importedProjects.get(projectName);
    if (info) {
      for (const url of info.urls) URL.revokeObjectURL(url);
      importedProjects.delete(projectName);
    }
    pendingHandles.delete(projectName);
    rebuildEntriesFromImports();
    renderReconnectBar();
    refreshDropdowns();
    buildSidebar();
    if (byId("project-select").value === projectName) {
      byId("project-select").value = "";
      byId("folder-select").value = "";
    }
    page = 0;
    render();
  }

  function rebuildEntriesFromImports() {
    const extra = [];
    for (const info of importedProjects.values()) {
      for (const asset of info.assets) extra.push(buildEntry(asset));
    }
    entries = [...baseEntries, ...extra];
  }

  async function ingestProjectFiles(rootName, collectedFiles, handle = null) {
    // collectedFiles: Array<{ relPath, file }>
    let matchedExisting = 0;
    const unmatchedGlbs = [];
    const imageMap = new Map(); // normalized path without ext -> File

    for (const { relPath, file } of collectedFiles) {
      const lower = relPath.toLowerCase();
      indexLocalFile(rootName + "/" + relPath, file);
      if (lower.endsWith(".glb")) {
        // Check if this matches any built-in catalog asset by path suffix or name+size
        let matched = false;
        for (const base of baseEntries) {
          for (const m of base.asset.models) {
            const mp = m.path.toLowerCase();
            if (lower === mp || mp.endsWith("/" + lower) || (m.path.split("/").at(-1).toLowerCase() === file.name.toLowerCase() && m.bytes === file.size)) {
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
        if (matched) matchedExisting += 1;
        else unmatchedGlbs.push({ relPath, file });
      } else if (IMG_EXT.test(lower)) {
        const stemKey = lower.replace(IMG_EXT, "").replace(/_(front|thumb|thumbnail|preview|albedo|color)$/, "");
        if (!imageMap.has(stemKey)) imageMap.set(stemKey, file);
      }
    }

    // Group unmatched GLBs into project = rootName (or "Mindflower" if matching built-in Mindflower files)
    const isMindflowerRoot = matchedExisting >= 3 || rootName.toLowerCase() === "mindflower";
    const targetProject = isMindflowerRoot ? "Mindflower" : rootName;
    if (importedProjects.has(targetProject)) {
      for (const u of importedProjects.get(targetProject).urls) URL.revokeObjectURL(u);
    }

    const newAssets = [];
    const urls = [];
    for (const { relPath, file } of unmatchedGlbs) {
      const parts = relPath.split("/").filter(Boolean);
      const subFolder = parts.length > 1 ? parts.slice(0, -1).join("/") : "(Juuri)";
      const displayFolder = isMindflowerRoot ? ("Paikalliset / " + subFolder) : subFolder;
      const stem = file.name.replace(/\.glb$/i, "");
      const meta = await inspectGlbMetadata(file);
      const [category, part] = guessCategoryPart(stem, subFolder);
      const mats = guessMaterials(stem + " " + (meta.material_names ?? []).join(" "));
      const stemKey = relPath.toLowerCase().replace(/\.glb$/i, "");
      const imgFile = imageMap.get(stemKey) ?? imageMap.get(stem.toLowerCase());
      let thumbUrl;
      if (imgFile) {
        thumbUrl = URL.createObjectURL(imgFile);
        urls.push(thumbUrl);
      }

      const cap = catalog.budgets[part]?.triangles[1] ?? 0;
      const tags = [category.toLowerCase().replace(/\s+/g, "-"), "3d-glb", "tuotu-kansio"];
      if (meta.maps?.Albedo) {
        tags.push("textured");
        if (!cap || (meta.triangles && meta.triangles <= cap)) tags.push("gameready");
      } else {
        tags.push("untextured");
      }
      if (cap && meta.triangles > cap) tags.push("over-budget");
      else if (cap && meta.triangles > 0) tags.push("within-budget");

      newAssets.push({
        id: "local:" + targetProject + "/" + relPath,
        name: stem.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        project: targetProject,
        folder: displayFolder,
        category,
        part,
        materials: mats,
        tags,
        thumbnail: thumbUrl,
        _localThumbUrl: thumbUrl,
        source_designs: ["Paikallinen projektikansio"],
        textures: [],
        models: [{
          path: rootName + "/" + relPath,
          origin: "local-folder",
          stage: "local-import",
          format: "glb",
          bytes: file.size,
          self_contained: true,
          preview: "local",
          _localFile: file,
          ...meta,
        }],
      });
    }

    if (newAssets.length) {
      importedProjects.set(targetProject, { name: targetProject, handle, assets: newAssets, urls });
      expandedProjects.add(targetProject);
      saveExpanded();
    }
    rebuildEntriesFromImports();
    refreshDropdowns();
    buildSidebar();
    if (!isMindflowerRoot && newAssets.length) {
      byId("project-select").value = targetProject;
      byId("folder-select").value = "";
      page = 0;
    }
    render();
    if (active) updateDetails();

    const partsMsg = [];
    if (matchedExisting) partsMsg.push(locale.format(matchedExisting) + " mallia yhdistetty " + targetProject + "-kirjastoon");
    if (newAssets.length) partsMsg.push(locale.format(newAssets.length) + " uutta GLB-mallia tuotu projektiin \"" + targetProject + "\"");
    if (!partsMsg.length) partsMsg.push("Kansiosta \"" + rootName + "\" ei löytynyt .glb-tiedostoja.");
    byId("message").textContent = partsMsg.join(" · ") + " (ladataan suoraan koneeltasi).";
  }

  async function scanDirectoryHandle(handle, prefix = "", acc = []) {
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === "directory") {
        if (SKIP_DIRS.has(name)) continue;
        await scanDirectoryHandle(entry, prefix ? prefix + "/" + name : name, acc);
      } else if (entry.kind === "file" && (name.toLowerCase().endsWith(".glb") || IMG_EXT.test(name))) {
        const file = await entry.getFile();
        acc.push({ relPath: prefix ? prefix + "/" + name : name, file });
      }
    }
    return acc;
  }

  async function scanDataTransferEntry(entry, prefix = "", acc = []) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      if (file.name.toLowerCase().endsWith(".glb") || IMG_EXT.test(file.name)) {
        acc.push({ relPath: prefix ? prefix + "/" + file.name : file.name, file });
      }
    } else if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of batch) {
          await scanDataTransferEntry(child, prefix ? prefix + "/" + child.name : child.name, acc);
        }
      } while (batch.length > 0);
    }
    return acc;
  }

  function openHandleDb() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error("no idb")); return; }
      const req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("handles");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function loadSavedHandles() {
    try {
      const db = await openHandleDb();
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get("dirs");
      return await new Promise((resolve) => {
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => resolve([]);
      });
    } catch { return []; }
  }

  async function saveHandle(handle) {
    try {
      const existing = await loadSavedHandles();
      const next = [handle];
      for (const item of existing) {
        if (!(await item.isSameEntry?.(handle))) next.push(item);
      }
      const db = await openHandleDb();
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(next.slice(0, 6), "dirs");
    } catch { /* Handle persistence is optional. */ }
  }

  function renderReconnectBar() {
    const bar = byId("reconnect-bar");
    bar.replaceChildren();
    bar.hidden = pendingHandles.size === 0;
    for (const [name, handle] of pendingHandles) {
      const btn = element("button", undefined, "reconnect-btn");
      btn.type = "button";
      btn.append(element("span", "Yhdistä uudelleen: " + name), element("span", "↻"));
      btn.addEventListener("click", async () => {
        try {
          if ((await handle.requestPermission({ mode: "read" })) === "granted") {
            pendingHandles.delete(name);
            renderReconnectBar();
            byId("message").textContent = "Luetaan kansiota \"" + name + "\"…";
            const acc = await scanDirectoryHandle(handle);
            await ingestProjectFiles(handle.name, acc, handle);
          }
        } catch { /* user cancelled */ }
      });
      bar.append(btn);
    }
  }

  void (async () => {
    const saved = await loadSavedHandles();
    for (const handle of saved) {
      try {
        const perm = await handle.queryPermission({ mode: "read" });
        if (perm === "granted") {
          const acc = await scanDirectoryHandle(handle);
          await ingestProjectFiles(handle.name, acc, handle);
        } else {
          pendingHandles.set(handle.name, handle);
        }
      } catch { /* Skip stale handles. */ }
    }
    renderReconnectBar();
  })();

  async function openFolderImportPicker() {
    if (typeof globalThis.showDirectoryPicker === "function") {
      try {
        const handle = await globalThis.showDirectoryPicker({ id: "catalogisti-project-folder", mode: "read" });
        byId("message").textContent = "Luetaan projektikansiota \"" + handle.name + "\"…";
        const acc = await scanDirectoryHandle(handle);
        await saveHandle(handle);
        pendingHandles.delete(handle.name);
        renderReconnectBar();
        await ingestProjectFiles(handle.name, acc, handle);
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    byId("folder-input").click();
  }

  byId("folder").addEventListener("click", openFolderImportPicker);
  byId("add-project-inline").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openFolderImportPicker();
  });

  byId("folder-input").addEventListener("change", async (event) => {
    const files = [...event.target.files];
    if (!files.length) return;
    const firstRel = files[0].webkitRelativePath || files[0].name;
    const rootName = firstRel.includes("/") ? firstRel.split("/")[0] : "Tuotu projekti";
    const acc = [];
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".glb") && !IMG_EXT.test(file.name)) continue;
      const rel = (file.webkitRelativePath || file.name).replace(new RegExp("^" + rootName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?"), "");
      acc.push({ relPath: rel || file.name, file });
    }
    byId("message").textContent = "Käsitellään kansiota \"" + rootName + "\"…";
    await ingestProjectFiles(rootName, acc);
    event.target.value = "";
  });

  byId("choose-model").addEventListener("click", () => byId("model-input").click());
  byId("model-input").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) {
      file._manualDrop = true;
      clearPreview();
      void previewModel(variants[Number(byId("variant").value)].item, file);
    }
    event.target.value = "";
  });

  // Drop folder onto main grid
  const dropZone = byId("drop-zone");
  dropZone.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
      dropZone.classList.add("folder-drop-active");
    }
  });
  dropZone.addEventListener("dragleave", (event) => {
    if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("folder-drop-active");
  });
  dropZone.addEventListener("drop", async (event) => {
    dropZone.classList.remove("folder-drop-active");
    if (!event.dataTransfer?.items?.length) return;
    event.preventDefault();
    const items = [...event.dataTransfer.items];
    const entriesDt = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
    if (entriesDt.some((e) => e.isDirectory)) {
      for (const dir of entriesDt.filter((e) => e.isDirectory)) {
        byId("message").textContent = "Luetaan pudotettua kansiota \"" + dir.name + "\"…";
        const acc = [];
        const reader = dir.createReader();
        let batch;
        do {
          batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          for (const child of batch) await scanDataTransferEntry(child, child.name, acc);
        } while (batch.length > 0);
        await ingestProjectFiles(dir.name, acc);
      }
    } else {
      const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.name.toLowerCase().endsWith(".glb") || IMG_EXT.test(f.name));
      if (files.length) {
        await ingestProjectFiles("Pudotetut mallit", files.map((f) => ({ relPath: f.name, file: f })));
      }
    }
  });

  // Drop single GLB directly on 3D preview box
  const previewArea = byId("preview");
  previewArea.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    previewArea.classList.add("drag-over");
  });
  previewArea.addEventListener("dragleave", () => previewArea.classList.remove("drag-over"));
  previewArea.addEventListener("drop", (event) => {
    const file = [...(event.dataTransfer?.files ?? [])].find((item) => item.name.toLowerCase().endsWith(".glb"));
    if (file && active && variants.length) {
      event.preventDefault();
      event.stopPropagation();
      previewArea.classList.remove("drag-over");
      const current = variants[Number(byId("variant").value)];
      const model = current.kind === "model" ? current.item : { format: "glb", path: file.name };
      file._manualDrop = true;
      clearPreview();
      void previewModel(model, file);
    }
  });

  byId("zoom").addEventListener("input", (event) => {
    const val = Number(event.target.value);
    document.documentElement.style.setProperty("--card-size", val + "px");
    try { localStorage.setItem(ZOOM_STORE, String(val)); } catch { /* ignore */ }
  });

  refreshDropdowns();

  for (const id of filters) {
    byId(id).addEventListener(id === "query" ? "input" : "change", () => { page = 0; render(); });
  }
  byId("reset").addEventListener("click", () => { resetFilters(); render(); });

  for (const [part, budget] of Object.entries(catalog.budgets)) {
    const row = element("tr");
    row.append(element("th", part));
    for (const text of [
      budget.metres?.map((n) => locale.format(n)).join("–") ?? "Sovitetaan",
      budget.triangles.map((n) => locale.format(n)).join("–"),
      budget.lod.map((n) => Math.round(n * 100) + " %").join(" / "),
      budget.anchor,
    ]) row.append(element("td", text));
    byId("budget-rows").append(row);
  }

  byId("budget-open").addEventListener("click", () => byId("budget-dialog").showModal());
  byId("previous").addEventListener("click", () => { page -= 1; render(); });
  byId("next").addEventListener("click", () => { page += 1; render(); });
  byId("variant").addEventListener("change", updateDetails);

  buildSidebar();
  render();
  byId("message").textContent = "";
})();
