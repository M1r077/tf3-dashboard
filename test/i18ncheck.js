// Translation check: every language must have exactly the keys of English.
// Run from the repository root:  node test\i18ncheck.js
// Checks dashboard/static/i18n.js (companion UI) and mod/tf3_dashboard_export/strings.json (mod settings + status window).
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = path.join(__dirname, "..");
let bad = 0;
function compare(label, dicts, ref) {
  const en = new Set(Object.keys(dicts[ref]));
  for (const l of Object.keys(dicts)) {
    if (l === ref) continue;
    const k = new Set(Object.keys(dicts[l]));
    const missing = [...en].filter(x => !k.has(x)), extra = [...k].filter(x => !en.has(x) && !x.startsWith("_"));  // _ymd & co are per-language options
    const empty = [...k].filter(x => typeof dicts[l][x] === "string" && !dicts[l][x].trim());
    console.log(`${label} ${l}: ${k.size} keys` + (missing.length ? `, MISSING ${missing.length}: ${missing.join(", ")}` : "") + (extra.length ? `, EXTRA ${extra.length}: ${extra.join(", ")}` : "") + (empty.length ? `, EMPTY: ${empty.join(", ")}` : ""));
    if (missing.length || extra.length || empty.length) bad++;
  }
  console.log(`${label} ${ref}: ${en.size} keys (reference)`);
}
const sandbox = { window: {} }; vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "dashboard/static/i18n.js"), "utf8"), sandbox);
compare("i18n.js", sandbox.window.I18N, "en");
compare("strings.json", JSON.parse(fs.readFileSync(path.join(root, "mod/tf3_dashboard_export/strings.json"), "utf8")), "en");
const html = fs.readFileSync(path.join(root, "dashboard/static/index.html"), "utf8");
const opts = html.match(/<select id="lang">([\s\S]*?)<\/select>/)[1].match(/value="(\w+)"/g).map(s => s.slice(7, -1)).filter(v => v !== "auto");
const noOpt = Object.keys(sandbox.window.I18N).filter(l => !opts.includes(l));
if (noOpt.length) { console.log(`index.html: no <option> in #lang for: ${noOpt.join(", ")}`); bad++; }
process.exit(bad ? 1 : 0);
