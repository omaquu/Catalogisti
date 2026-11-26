"use strict";
const { contextBridge, ipcRenderer } = require("electron");

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld("catalogisti", {
  getLibrary: () => call("library:get"),
  info: () => call("library:info"),
  listSources: () => call("sources:list"),
  locateSource: (oldPath) => call("sources:locate", oldPath),
  relinkNote: () => call("relink:note"),
  setSourceEnabled: (source, enabled) => call("sources:enable", source, enabled),
  removeSource: (source) => call("sources:remove", source),
  clearLibrary: () => call("library:clear"),
  importFolder: (kind) => call("import:folder", kind),
  importTextureLibrary: (file) => call("import:textureLibrary", file),
  importFiles: () => call("import:files"),
  updateAsset: (id, fields) => call("asset:update", id, fields),
  editTags: (id, add, remove) => call("asset:tags", id, add, remove),
  editCategories: (id, add, remove) => call("asset:categories", id, add, remove),
  resolveDuplicate: (id, into, action) => call("asset:resolveDuplicate", id, into, action),
  setReview: (id, review) => call("asset:review", id, review),
  deleteAsset: (id, options) => call("asset:delete", id, options),
  linkAssets: (ids) => call("asset:link", ids),
  unlinkAsset: (id) => call("asset:unlink", id),
  references: (id) => call("asset:references", id),
  restoreVersion: (id, index) => call("asset:restoreVersion", id, index),
  replaceFile: (id) => call("asset:replace", id),
  saveThumbnail: (id, bytes) => call("asset:thumbnail", id, bytes),
  createRequest: (r) => call("request:create", r),
  updateRequest: (id, fields) => call("request:update", id, fields),
  showInFolder: (file) => call("shell:show", file),
  openFile: (file) => call("shell:open", file),
  copy: (text) => call("clipboard:write", text),
  exportLibrary: () => call("export:json"),
  onLibraryChanged: (fn) => ipcRenderer.on("library:changed", (_e, by) => fn(by)),
});
