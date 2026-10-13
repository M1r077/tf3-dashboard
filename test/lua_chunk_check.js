// Compile AND run the main chunk of the mod script with a real Lua (wasmoon, Lua 5.4) under a permissive stub of the
// game's globals. Catches what a parser cannot: the 200-locals limit of the main function (revision 18 did not load),
// and a table used before its "local T = {}" (the first revision 19 candidate). The chunk only defines functions and
// constants; game calls happen later, in data().update etc., which are not run here. The game's globals (api, app)
// are permissive stubs: any index or call returns the stub, so "api.type.Vec2f.new" at chunk level does not fail.
//
// Needs: npm install wasmoon (looked up next to this file, then in the user's temp tool folder).
const fs = require("fs");
const path = require("path");

function loadWasmoon() {
  for (const base of [path.join(__dirname, "..", "node_modules"), path.join(process.env.TEMP || "/tmp", "mammouth", "node_modules")]) {
    try { return require(path.join(base, "wasmoon")); } catch (e) { /* next */ }
  }
  return null;
}

const SCRIPT = path.join(__dirname, "..", "mod", "tf3_dashboard_export", "content", "dashboard_export", "dashboard_export.script.lua");
const wasmoon = loadWasmoon();
if (!wasmoon) { console.log("[lua] wasmoon not installed: chunk check skipped"); process.exit(0); }

(async () => {
  const lua = await new wasmoon.LuaFactory().createEngine();
  lua.global.set("SRC", fs.readFileSync(SCRIPT, "utf8"));
  const r = await lua.doString(`
    local stub
    stub = setmetatable({}, { __index = function() return stub end, __call = function() return stub end })
    -- only the game's globals resolve to the stub; anything else stays nil, so a table used before its
    -- "local T = {}" fails here as it does in the game
    api, app = stub, stub
    local f, err = load(SRC, "=dashboard_export.script.lua")
    if not f then return "compile: " .. err end
    local ok, e = pcall(f)
    if not ok then return "run: " .. tostring(e) end
    if type(data) ~= "function" then return "run: no data() defined" end
    return "ok"
  `);
  console.log("[lua] chunk check: " + r);
  process.exit(r === "ok" ? 0 : 1);
})();
