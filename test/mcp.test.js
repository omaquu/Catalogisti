"use strict";
// MCP protocol test over real stdio: node test/mcp.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogisti-mcp-"));
const child = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "server.js"), "--data-dir", dir], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    pending.get(msg.id)?.(msg); pending.delete(msg.id);
  }
});
let next = 1;
const rpc = (method, params) => new Promise((resolve) => {
  const id = next++; pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const tool = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { error: !!r.result.isError, value: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) };
};

(async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } });
  assert.strictEqual(init.result.serverInfo.name, "catalogisti");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  for (const n of ["search_assets", "get_asset", "find_or_request", "list_tags", "set_review", "edit_tags", "add_asset", "delete_asset", "request_asset", "catalog_summary"]) assert.ok(names.includes(n), n);
  assert.ok(names.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)), "tool names are valid for all clients");

  const img = path.join(dir, "rusty_metal_plate.png");
  fs.writeFileSync(img, "x");
  const empty = await tool("find_or_request", { kind: "texture", tags: ["rust", "metal"], category: "Metal", name: "Rusty plate" });
  assert.ok(empty.value.request && empty.value.next_steps.length > 0, "nothing found → request opened");
  const added = await tool("add_asset", { file: img, kind: "texture", tags: ["rust"], request_id: empty.value.request.id });
  assert.strictEqual(added.value.category, "Metal");
  const found = await tool("find_or_request", { kind: "texture", tags: ["rust"] });
  assert.strictEqual(found.value.matches[0].id, added.value.id);
  assert.strictEqual(found.value.request, null);
  await tool("set_review", { id: added.value.id, decision: "needs_fix", append_note: "Visible seam" });
  const full = await tool("get_asset", { id: added.value.id });
  assert.match(full.value.review.notes, /Visible seam/);
  const bad = await tool("get_asset", { id: "nope" });
  assert.ok(bad.error);
  const summary = await tool("catalog_summary", {});
  assert.strictEqual(summary.value.needs_fix.length, 1);
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("mcp tests passed");
})().catch((e) => { console.error(e); child.kill(); process.exit(1); });
