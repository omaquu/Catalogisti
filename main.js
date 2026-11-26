"use strict";
/**
 * Catalogisti desktop app (Electron main process).
 * The library lives in library.json (see mcp/store.js); the MCP server edits the same
 * file, so this process watches it and tells the window to refresh.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

protocol.registerSchemesAsPrivileged([
  { scheme: "asset", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const MCP_DIR = app.isPackaged ? path.join(process.resourcesPath, "mcp") : path.join(__dirname, "mcp");
const store = require(path.join(MCP_DIR, "store.js"));

let win;
let lastOwnRevision = -1;

function mutate(fn) {
  const result = store.mutate(fn, "app");
  lastOwnRevision = store.load().revision;
  return result;
}

/** asset://local/C/Users/.../file.glb  →  C:/Users/.../file.glb */
function urlToPath(url) {
  const u = new URL(url);
  const parts = decodeURIComponent(u.pathname).split("/").filter(Boolean);
  if (process.platform === "win32") return parts[0] + ":/" + parts.slice(1).join("/");
  return "/" + parts.join("/");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 980, minHeight: 620, title: "Catalogisti", backgroundColor: "#141518",
    icon: path.join(__dirname, "src", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "src", "index.html"));
  // Developer self-test: CATALOGISTI_SELFTEST=<out.png> [CATALOGISTI_SELFTEST_JS=<script>] saves a screenshot and quits.
  if (process.env.CATALOGISTI_SELFTEST) {
    win.webContents.on("console-message", (_e, level, message) => console.log("[renderer]", message));
    win.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.CATALOGISTI_SELFTEST_WAIT || 6000)));
      if (process.env.CATALOGISTI_SELFTEST_JS) {
        try { console.log("[selftest]", JSON.stringify(await win.webContents.executeJavaScript(fs.readFileSync(process.env.CATALOGISTI_SELFTEST_JS, "utf-8")))); }
        catch (error) { console.log("[selftest error]", error.message); }
        await new Promise((r) => setTimeout(r, 2500));
      }
      fs.writeFileSync(process.env.CATALOGISTI_SELFTEST, (await win.webContents.capturePage()).toPNG());
      app.quit();
    });
  }
}

function watchLibrary() {
  let timer;
  fs.mkdirSync(store.dataDir(), { recursive: true });
  fs.watchFile(store.libraryPath(), { interval: 800 }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      let lib;
      try { lib = store.load(); } catch { return; }
      if (lib.revision !== lastOwnRevision && win && !win.isDestroyed()) win.webContents.send("library:changed", lib.updated_by || "");
    }, 150);
  });
}

function mcpConfig() {
  const server = path.join(MCP_DIR, "server.js");
  return {
    mcpServers: {
      catalogisti: { command: "node", args: [server], env: { CATALOGISTI_DATA: store.dataDir() } },
    },
  };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (error) { return { ok: false, error: String(error.message || error) }; }
  });
}

app.whenReady().then(() => {
  protocol.handle("asset", (request) => net.fetch(pathToFileURL(urlToPath(request.url)).toString()));
  fs.mkdirSync(store.thumbsDir(), { recursive: true });

  handle("library:get", () => store.load());
  handle("library:info", () => ({ dataDir: store.dataDir(), libraryFile: store.libraryPath(), mcp: mcpConfig(),
    categories: { model: store.MODEL_CATEGORIES, texture: store.TEXTURE_CATEGORIES }, flags: store.FLAGS, decisions: store.DECISIONS,
    textureLibrary: fs.existsSync("C:/TextureLibrary/catalog.json") ? "C:/TextureLibrary/catalog.json" : null }));

  handle("import:folder", async (kind) => {
    const { filePaths } = await dialog.showOpenDialog(win, {
      title: kind === "texture" ? "Import a folder of textures" : "Import a folder of 3D models", properties: ["openDirectory"],
    });
    if (!filePaths?.length) return null;
    return mutate((lib) => store.importFolder(lib, filePaths[0], { kind }));
  });
  handle("import:textureLibrary", async (file) => {
    let target = file;
    if (!target) {
      const { filePaths } = await dialog.showOpenDialog(win, { title: "Texture library catalog.json", filters: [{ name: "catalog.json", extensions: ["json"] }] });
      if (!filePaths?.length) return null;
      target = filePaths[0];
    }
    return mutate((lib) => store.importTextureLibrary(lib, target));
  });
  handle("import:files", async () => {
    const { filePaths } = await dialog.showOpenDialog(win, { title: "Add model or texture files", properties: ["openFile", "multiSelections"],
      filters: [{ name: "Models and textures", extensions: ["glb", "gltf", "png", "jpg", "jpeg", "webp"] }] });
    if (!filePaths?.length) return null;
    return mutate((lib) => filePaths.map((f) => store.addAsset(lib, { file: f, project: "Unsorted" }, "app").id));
  });

  handle("asset:update", (id, fields) => mutate((lib) => store.updateAsset(lib, id, fields)));
  handle("asset:tags", (id, add, remove) => mutate((lib) => store.editTags(lib, id, add, remove)));
  handle("asset:review", (id, review) => mutate((lib) => store.setReview(lib, id, review, "owner")));
  handle("asset:delete", async (id, trashFile) => {
    const removed = mutate((lib) => store.deleteAsset(lib, id));
    if (trashFile && removed.file && fs.existsSync(removed.file)) await shell.trashItem(removed.file);
    if (removed.thumbnail) fs.rmSync(path.join(store.dataDir(), removed.thumbnail), { force: true });
    return removed.id;
  });
  handle("asset:replace", async (id) => {
    const lib = store.load();
    const a = store.findAsset(lib, id);
    const { filePaths } = await dialog.showOpenDialog(win, { title: "Choose the fixed version of " + a.name, defaultPath: path.dirname(a.file),
      filters: a.kind === "model" ? [{ name: "Model", extensions: ["glb", "gltf"] }] : [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (!filePaths?.length) return null;
    return mutate((l) => store.replaceFile(l, id, filePaths[0], "Replaced in the app", "owner"));
  });
  handle("asset:thumbnail", (id, bytes) => {
    const rel = "thumbs/" + id + ".png";
    fs.writeFileSync(path.join(store.dataDir(), rel), Buffer.from(bytes));
    return mutate((lib) => { const a = store.findAsset(lib, id); a.thumbnail = rel; a.thumb_mtime = a.mtime; return rel; });
  });

  handle("request:create", (r) => mutate((lib) => store.createRequest(lib, r, "owner")));
  handle("request:update", (id, fields) => mutate((lib) => store.updateRequest(lib, id, fields, "owner")));

  handle("shell:show", (file) => shell.showItemInFolder(file));
  handle("shell:open", (file) => shell.openPath(file));
  handle("clipboard:write", (text) => clipboard.writeText(text));
  handle("export:json", async () => {
    const { filePath } = await dialog.showSaveDialog(win, { defaultPath: "catalogisti-library.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!filePath) return null;
    fs.copyFileSync(store.libraryPath(), filePath);
    return filePath;
  });

  createWindow();
  watchLibrary();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
