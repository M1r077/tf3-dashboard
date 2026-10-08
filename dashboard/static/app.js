/* TF3 Dashboard front-end — operations first (fleet, lines, map), finances last. No framework.
   i18n: strings in i18n.js (window.I18N); icons: static/icons/*.png extracted from the game. */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------ i18n
  const LANGS = Object.keys(window.I18N || {});
  const i18n = { lang: "en", gameLang: null, dict: window.I18N.en };
  const normLang = (code) => { if (!code) return null; const c = String(code).toLowerCase().split(/[_-]/)[0]; return LANGS.includes(c) ? c : null; };
  function pickLang() {
    const url = normLang(new URLSearchParams(location.search).get("lang"));
    const stored = normLang(localStorage.getItem("tf3.lang"));
    return url || stored || normLang(i18n.gameLang) || normLang(navigator.language) || "en";
  }
  function t(key, vars) {
    let v = i18n.dict;
    for (const k of key.split(".")) v = v == null ? undefined : v[k];
    if (v === undefined) { let e = window.I18N.en; for (const k of key.split(".")) e = e == null ? undefined : e[k]; v = e === undefined ? key : e; }
    if (typeof v !== "string") return v;
    return vars ? v.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "") : v;
  }
  function setLang(code, persist) {
    const c = normLang(code) || "en";
    i18n.lang = c; i18n.dict = window.I18N[c];
    if (persist) localStorage.setItem("tf3.lang", c);
    document.documentElement.lang = c;
    $("#lang").value = localStorage.getItem("tf3.lang") ? c : "auto";
    $$("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
    $$("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    $$("[data-i18n-title]").forEach(el => { el.title = t(el.dataset.i18nTitle); });
    applyIcons();
    if (window.Layout) Layout.applyAll();
  }
  window.__t = t; window.__locale = () => i18n.dict._locale || "en";
  $("#lang").addEventListener("change", e => { if (e.target.value === "auto") { localStorage.removeItem("tf3.lang"); setLang(pickLang(), false); } else setLang(e.target.value, true); refresh(true); });

  // ------------------------------------------------------------ settings (browser-local)
  const DEFAULTS = { ico: 28, fs: 14, rowpad: 6, refresh: 3, history: 400, finance: true, keys: true, defaultTab: "overview", range: "1h", notify: 0 };
  const RANGES = ["5m", "10m", "15m", "20m", "30m", "45m", "1h", "all"];
  const settings = Object.assign({}, DEFAULTS, (() => { try { return JSON.parse(localStorage.getItem("tf3.settings") || "{}"); } catch (e) { return {}; } })());
  function applySettings() {
    const root = document.documentElement.style;
    root.setProperty("--isz", settings.ico + "px"); root.setProperty("--fs", settings.fs + "px"); root.setProperty("--rowpad", settings.rowpad + "px");
    document.body.classList.toggle("hide-finance", !settings.finance);
    $$("#settings .seg").forEach(seg => $$("button", seg).forEach(b => b.classList.toggle("active", String(settings[seg.dataset.set]) === b.dataset.v)));
    $("#set-refresh").value = settings.refresh; $("#set-refresh-val").textContent = t("seconds_unit", { n: settings.refresh });
    $("#set-history").value = settings.history; $("#set-history-val").textContent = t("samples_unit", { n: settings.history });
    $("#set-finance").checked = settings.finance; $("#set-keys").checked = settings.keys; $("#set-default-tab").value = settings.defaultTab;
    $$("#set-notify button").forEach(b => b.classList.toggle("active", String(settings.notify || 0) === b.dataset.v));
    if (window.Notify) window.Notify.hint();
    if (!RANGES.includes(settings.range)) settings.range = DEFAULTS.range;
    $("#range-sel").value = settings.range;
    localStorage.setItem("tf3.settings", JSON.stringify(settings));
    if (settings.finance === false && state.tab === "finance") showTab("overview");
    restartTimer();
  }
  $("#gear").addEventListener("click", () => { const o = !$("#settings").classList.contains("open"); $("#settings").classList.toggle("open", o); $("#gear").classList.toggle("open", o); });
  $("#settings-close").addEventListener("click", () => { $("#settings").classList.remove("open"); $("#gear").classList.remove("open"); });
  document.addEventListener("click", e => { if (!e.target.closest("#settings, #gear")) { $("#settings").classList.remove("open"); $("#gear").classList.remove("open"); } });
  $$("#settings .seg[data-set] button").forEach(b => b.addEventListener("click", () => { settings[b.closest(".seg").dataset.set] = +b.dataset.v; applySettings(); }));
  $("#set-refresh").addEventListener("input", e => { settings.refresh = +e.target.value; applySettings(); });
  $("#set-history").addEventListener("input", e => { settings.history = +e.target.value; applySettings(); refresh(true); });
  $("#set-finance").addEventListener("change", e => { settings.finance = e.target.checked; applySettings(); });
  $("#set-keys").addEventListener("change", e => { settings.keys = e.target.checked; applySettings(); });
  $("#set-default-tab").addEventListener("change", e => { settings.defaultTab = e.target.value; applySettings(); });
  $("#set-reset").addEventListener("click", () => { Object.assign(settings, DEFAULTS); localStorage.removeItem("tf3.lang"); setLang(pickLang(), false); applySettings(); refresh(true); });

  // ------------------------------------------------------------ panel layout (layout.js)
  const closeSettings = () => { $("#settings").classList.remove("open"); $("#gear").classList.remove("open"); };
  $("#layout-btn").addEventListener("click", () => { closeSettings(); Layout.toggleEdit(); });
  $("#set-layout-edit").addEventListener("click", () => { closeSettings(); Layout.enterEdit(); });
  $("#set-layout-reset").addEventListener("click", () => { Layout.resetAll(); refresh(true); });
  $("#layout-done").addEventListener("click", () => Layout.exitEdit());
  $("#layout-reset").addEventListener("click", () => { Layout.reset(state.tab); refresh(true); });
  window.addEventListener("keydown", e => { if (e.key === "Escape" && Layout.isEditing()) Layout.exitEdit(); });
  // re-render charts/map after a resize so they fill their new box (debounced; the data is cached server-side)
  let layoutTimer = null;
  Layout.onChange(() => { clearTimeout(layoutTimer); layoutTimer = setTimeout(() => { Charts.resizeAll(); if (state.tab === "map" && map.init) drawMap($("#map")); refresh(true); }, 60); });
  window.addEventListener("resize", () => { clearTimeout(layoutTimer); layoutTimer = setTimeout(() => Charts.resizeAll(), 120); });

  // ------------------------------------------------------------ time range (shared by all time charts)
  const rangeLabel = () => t("range." + settings.range);
  $("#range-sel").addEventListener("change", e => { settings.range = e.target.value; applySettings(); refresh(true); });
  /** uPlot options for a server series: real-time x axis + where the per-minute aggregated part ends */
  function tsOpts(hist, syncKey) {
    if (!hist.length || hist[0].ts == null) return {};
    let aggFrom = 0; while (aggFrom < hist.length && hist[aggFrom].agg) aggFrom++;
    return { ts: hist.map(h => h.ts), aggFrom: aggFrom > 0 ? aggFrom : null, syncKey };
  }

  // ------------------------------------------------------------ icons
  const ICON_URL = (name) => `icons/${name}.png`;
  function applyIcons(root = document) { $$("[data-ico]", root).forEach(el => { if (!el.style.getPropertyValue("--ico")) el.style.setProperty("--ico", `url(${ICON_URL(el.dataset.ico)})`); }); }
  const ico = (name, cls = "", title = "") => `<i class="ico ${cls}" style="--ico:url(${ICON_URL(name)})"${title ? ` title="${esc(title)}"` : ""}></i>`;
  const ICON_BY_TYPE = { Bus: "veh_bus", Truck: "veh_truck", TrainSteam: "veh_train", TrainElectric: "veh_train", TrainDiesel: "veh_train", Tram: "veh_tram", Aircraft: "veh_plane", Helicopter: "veh_heli", Ship: "veh_ship" };
  const ICON_BY_CARRIER = { ROAD: "veh_bus", RAIL: "veh_train", TRAM: "veh_tram", AIR: "veh_plane", WATER: "veh_ship", OTHER: "veh_car" };
  const ENGINE_ICON = { TrainSteam: "engine_steam", TrainElectric: "engine_electric", TrainDiesel: "engine_diesel" };
  const vehIcon = (v, cls = "") => { const name = ICON_BY_TYPE[v.icon_type] || ICON_BY_CARRIER[v.carrier] || "veh_car"; const label = v.icon_type ? t("icon_type." + v.icon_type) : t("carrier." + (v.carrier || "OTHER")); return ico(name, cls, label); };
  const vehTypeCell = (v) => `<span class="vehicon" style="color:${CARRIER_COLOR[v.carrier] || "#888"}">${vehIcon(v)}${ENGINE_ICON[v.icon_type] ? ico(ENGINE_ICON[v.icon_type], "sm", t("icon_type." + v.icon_type)) : ""}</span>`;
  // Real model icons (colored side views extracted from the game, see extract_icons.py): icons/vehicles/<cat>/<stem>.png.
  // The manifest lists what exists; unknown models (mods) fall back to the generic type glyph.
  const VEH_MANIFEST = { map: null, loading: fetch("icons/vehicles/_manifest.json").then(r => r.ok ? r.json() : {}).catch(() => ({})).then(m => { VEH_MANIFEST.map = m; }) };
  const modelFile = (key) => {
    const m = VEH_MANIFEST.map; if (!m || !key) return null; const k = String(key).toLowerCase();
    if (m[k]) return "icons/vehicles/" + m[k];
    // key without a known category (older mod build exported "<folder>/<stem>"): match on the stem alone
    const stem = k.split("/").pop(); if (!VEH_MANIFEST.byStem) { VEH_MANIFEST.byStem = {}; for (const kk in m) VEH_MANIFEST.byStem[kk.split("/").pop()] = m[kk]; }
    return VEH_MANIFEST.byStem[stem] ? "icons/vehicles/" + VEH_MANIFEST.byStem[stem] : null;
  };
  // leading part as a colored image (or the generic glyph when the model is unknown)
  const modelImg = (v, cls = "") => { const f = modelFile(v.model_key); return f ? `<img class="modelimg ${cls}" src="${f}" alt="" title="${esc(v.model || "")}" loading="lazy">` : vehIcon(v, cls); };
  // whole consist in order ("-" prefix = part reversed); each part drawn as a small image
  const consist = (v, cls = "") => {
    const parts = String(v.parts || v.model_key || "").split(",").filter(Boolean); if (!parts.length) return modelImg(v, cls);
    return `<span class="consist ${cls}">${parts.map(p => { const rev = p.startsWith("-"), k = rev ? p.slice(1) : p, f = modelFile(k); return f ? `<img src="${f}" alt="" title="${esc(k)}" class="${rev ? "rev" : ""}" loading="lazy">` : `<i class="ico sm" style="--ico:url(${ICON_URL(ICON_BY_CARRIER[v.carrier] || "veh_car")})"></i>`; }).join("")}</span>`;
  };
  const condIcon = (m) => m == null ? "" : ico("cond_" + Math.min(5, Math.max(1, Math.ceil(m * 5))), "cond " + maintCls(m), Math.round(m * 100) + " %");
  const CARGO_ICON_FILES = new Set(["beverages", "books", "bricks", "cement", "chemicals", "clay", "clothes", "coal", "crude_oil", "dyes", "fabric", "fertilizer", "fish", "fuel", "furniture", "glass", "grain", "iron_ore", "logs", "machines", "meat", "paper", "passengers", "planks", "plastic", "rubber", "sand", "sawdust", "sheet_metal", "steel", "stone", "tinned_food", "tires", "tools", "vegetables", "vehicles", "wool"]);
  // Icons are keyed on the language-neutral cargo key exported by the mod (resource file name, e.g. "grain").
  // Fallback for DBs filled by an older mod: guess from the (English) display name.
  const cargoKey = (c) => { const k = c && typeof c === "object" ? c.cargo_key : null; if (k) return String(k).toLowerCase(); const name = c && typeof c === "object" ? c.cargo : c; return String(name || "").toLowerCase().replace(/^.*\//, "").replace(/\.cargo.*$/, "").replace(/[\s-]+/g, "_").replace("canned_food", "tinned_food").replace("tinplate", "sheet_metal"); };
  const cargoLabel = (c) => c && typeof c === "object" ? c.cargo : c;
  const cargoIcon = (c, cls = "sm") => { const k = cargoKey(c); return `<i class="ico cargo-img ${cls}" style="--ico:url(icons/cargo/${CARGO_ICON_FILES.has(k) ? k : "_mixed"}.png)" title="${esc(cargoName(cargoLabel(c)))}"></i>`; };
  const ALERT_ICON = { line_problem: "line_problem", line_issue: "line_unload", vehicle_problem: "no_path", blocked_train: "stop", no_path_vehicle: "no_path", town_problem: "town", closing_industry: "industry_closed", thrown_away_cargo: "stock_full",
    chain_bottleneck: "line_problem", chain_overcapacity: "vehicles", chain_industry: "industry_down", chain_input_short: "cargo_received", new_vehicle: "star" };

  // ------------------------------------------------------------ formatting
  const loc = () => i18n.dict._locale || "en";
  const money = (n) => n == null ? "–" : (n < 0 ? "−" : "") + Math.abs(Math.round(n)).toLocaleString(loc()) + " $";
  const int = (n) => n == null ? "–" : Math.round(n).toLocaleString(loc());
  // compact figures for the top strip ("25,8 mi", "25.8M"): the full number is in the tooltip
  const intShort = (n) => n == null ? "–" : Math.abs(n) < 100000 ? int(n) : new Intl.NumberFormat(loc(), { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const moneyShort = (n) => n == null ? "–" : (n < 0 ? "−" : "") + intShort(Math.abs(n)) + " $";
  const num = (n, d = 1) => n == null ? "–" : Number(n).toFixed(d);
  const pct = (a, b) => (b ? (100 * a / b) : 0);
  const kmh = (ms) => ms == null ? "–" : Math.round(ms * 3.6) + " km/h";
  const km = (m) => m == null ? "–" : (m / 1000).toFixed(1) + " km";
  const MON = () => i18n.dict._months;
  const date = (s) => s ? `${s.day ?? "?"} ${MON()[s.month] || s.month || ""} ${s.year ?? ""}` : "–";
  const dateLabel = (s) => s && s.month ? `${s.day ? s.day + " " : ""}${MON()[s.month]} ${s.year}` : "";
  const headway = (sec) => sec == null ? "–" : sec >= 3600 ? (sec / 3600).toFixed(1) + " h" : sec >= 60 ? Math.round(sec / 60) + " min" : Math.round(sec) + " s";
  const rgb = (r, g, b) => (r == null) ? "#8b98a8" : `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  const ago = (iso) => { if (!iso) return ""; const d = (Date.now() - new Date(iso).getTime()) / 1000; if (d < 90) return Math.round(d) + " s"; if (d < 5400) return Math.round(d / 60) + " min"; return (d / 3600).toFixed(1) + " h"; };
  const bar = (v, max, cls = "", txt) => { const p = max ? Math.min(100, 100 * v / max) : 0; return `<span class="bar ${cls}"><i style="width:${p}%"></i></span> <span class="mono">${txt != null ? txt : Math.round(p) + "%"}</span>`; };
  const barQuality = (bad, total) => { if (!total) return '<span class="muted">–</span>'; const p = pct(bad, total); const cls = p > 30 ? "bad" : p > 10 ? "warn" : "ok"; return `<span class="bar ${cls}"><i style="width:${p}%"></i></span> <span class="mono">${p.toFixed(0)}% (${bad}/${total})</span>`; };
  const fillCls = (p) => p >= 80 ? "ok" : p < 25 ? "warn" : "";
  const maintCls = (m) => m < 0.3 ? "bad" : m < 0.5 ? "warn" : "ok";

  const STATE_COLOR = { EN_ROUTE: "#3fb950", AT_TERMINAL: "#58a6ff", IN_DEPOT: "#8b98a8", GOING_TO_DEPOT: "#e8b04b" };
  const CARRIER_COLOR = { ROAD: "#e8b04b", RAIL: "#4f8a8a", TRAM: "#bc8cff", AIR: "#58a6ff", WATER: "#3fb950", OTHER: "#8b98a8" };
  const ST = (s) => t("state." + s) === "state." + s ? (s || "?") : t("state." + s);
  const CA = (c) => t("carrier." + c) === "carrier." + c ? (c || "?") : t("carrier." + c);
  const ALERT_SEV = { line_problem: "bad", line_issue: "warn", vehicle_problem: "bad", blocked_train: "bad", no_path_vehicle: "bad", town_problem: "warn", closing_industry: "warn", thrown_away_cargo: "info",
    chain_bottleneck: "bad", chain_industry: "bad", chain_input_short: "warn", chain_overcapacity: "info", new_vehicle: "info" };
  const ALERT_CODE = { line_problem: "line_problem", line_issue: "line_issue", vehicle_problem: "veh_problem", town_problem: "town_problem" };
  const alertLabel = (kind) => { const v = t("alert." + kind); return v === "alert." + kind ? kind : v; };

  async function api(path, params) {
    const u = new URL(path, location.origin);
    if (params) Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u);
    if (!r.ok) throw new Error(path + " " + r.status);
    return r.json();
  }

  // ------------------------------------------------------------ activity hint (dashboard -> mod)
  // Every real interaction with the dashboard (click, key, wheel, tab change) tells the mod "the player is looking at
  // the second screen now": the mod then collects and writes its heavy data immediately with a relaxed per-frame
  // budget, so the unavoidable hitch happens while nobody watches the game, and the data shown is fresh. Throttled;
  // independent from "Permit game control" (it changes timing only, not the game).
  let lastHint = 0;
  function activityHint() {
    const now = Date.now();
    if (now - lastHint < 1500) return;
    lastHint = now;
    fetch("/api/activity", { method: "POST" }).catch(() => {});
    setTimeout(() => refresh(), 1200);  // the mod flushes its slow files within ~1 s of the hint
  }
  ["pointerdown", "keydown", "wheel"].forEach(ev => window.addEventListener(ev, activityHint, { passive: true, capture: true }));

  // ------------------------------------------------------------ modal (replaces the browser's prompt/confirm)
  // modal.confirm(text, {title, ok, danger}) -> Promise<boolean>; modal.prompt(text, {title, value, ok}) -> Promise<string|null>
  const modal = (() => {
    let dlg = null;
    function open(html, setup) {
      if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "modal"; document.body.appendChild(dlg); }
      dlg.innerHTML = html;
      return new Promise(resolve => {
        let done = false;
        const finish = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
        setup(finish);
        $(".md-x", dlg).addEventListener("click", () => finish(null));
        $(".md-cancel", dlg).addEventListener("click", () => finish(null));
        dlg.oncancel = (e) => { e.preventDefault(); finish(null); };          // Escape
        dlg.onclick = (e) => { if (e.target === dlg) finish(null); };         // backdrop
        dlg.showModal();
      });
    }
    const head = (title) => `<div class="md-head"><b>${esc(title)}</b><button class="btn iconbtn md-x" title="${esc(t("cancel"))}">${ico("close", "sm")}</button></div>`;
    return {
      confirm(text, o = {}) {
        return open(`${head(o.title || t("confirm_title"))}<p class="md-text">${esc(text)}</p>
          <div class="md-foot"><button class="btn md-cancel">${t("cancel")}</button><button class="btn primary md-ok ${o.danger ? "danger" : ""}">${o.danger ? "" : ico("check", "sm")}${esc(o.ok || "OK")}</button></div>`,
          (finish) => { const ok = $(".md-ok", dlg); ok.addEventListener("click", () => finish(true)); setTimeout(() => ok.focus(), 0); }).then(v => v === true);
      },
      prompt(text, o = {}) {
        return open(`${head(o.title || text)}${o.title ? `<p class="md-text">${esc(text)}</p>` : ""}
          <input class="md-input" type="text" maxlength="${o.maxlength || 40}" value="${esc(o.value || "")}" spellcheck="false">
          <div class="md-foot"><button class="btn md-cancel">${t("cancel")}</button><button class="btn primary md-ok">${ico("check", "sm")}${esc(o.ok || "OK")}</button></div>`,
          (finish) => {
            const inp = $(".md-input", dlg), ok = $(".md-ok", dlg);
            const submit = () => { const v = inp.value.trim(); if (v) finish(v); else inp.focus(); };
            ok.addEventListener("click", submit);
            inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
            setTimeout(() => { inp.focus(); inp.select(); }, 0);
          });
      },
    };
  })();

  // ------------------------------------------------------------ commands (dashboard -> game)
  const cmd = { enabled: true, accepted: null, lastSent: null, pendingId: null };
  async function sendCmd(name, args, el) {
    const st = $("#cmd-status");
    try {
      if (el) el.classList.add("pending");
      const r = await fetch("/api/cmd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd: name, args: args || {} }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || r.status);
      cmd.lastSent = { id: j.id, cmd: name, at: Date.now(), el };
      cmd.pendingId = j.id;
      st.textContent = `${name} · ${t("act_sent")}`; st.className = "cmdstatus";
      setTimeout(() => refresh(), 700);
      return true;
    } catch (e) {
      st.textContent = t("act_failed", { msg: e.message }); st.className = "cmdstatus bad";
      if (el) el.classList.remove("pending");
      return false;
    }
  }
  function updateCmdUi(o) {
    const c = (o && o.commands) || {};
    cmd.enabled = c.enabled !== false; cmd.accepted = c.accepted;
    const bar = $("#game-speed"); const btns = $$(".sbtn", bar);
    const off = !cmd.enabled || cmd.accepted === 0;
    btns.forEach(b => { b.disabled = off; b.classList.toggle("active", o && o.snapshot && String(o.snapshot.speed) === b.dataset.speed); });
    bar.title = off ? (cmd.enabled ? t("commands_off") : t("commands_na")) : "";
    const mpd = o && o.snapshot ? o.snapshot.millis_per_day : null;
    const calFactor = mpd ? Math.round(4000 / mpd * 100) / 100 : null;
    $$("#cal-speed .cbtn").forEach(b => { b.disabled = off; b.classList.toggle("active", calFactor != null && +b.dataset.cal === calFactor); });
    $("#cal-speed").title = off ? (cmd.enabled ? t("commands_off") : t("commands_na")) : t("calendar_speed") + (calFactor != null ? ` · ${calFactor}x` : "");
    const st = $("#cmd-status");
    if (c.ack && cmd.lastSent && c.ack.id === cmd.lastSent.id) {
      st.textContent = `${c.ack.cmd} · ${c.ack.ok ? t("act_done") : t("act_failed", { msg: c.ack.error || "" })}`; st.className = "cmdstatus " + (c.ack.ok ? "ok" : "bad");
      if (cmd.lastSent.el) cmd.lastSent.el.classList.remove("pending");
      cmd.pendingId = null;
    } else if (cmd.pendingId && !c.pending && cmd.lastSent && Date.now() - cmd.lastSent.at > 8000) {
      // the mod removed the file but no ack came back (older mod?) -> stop blinking
      if (cmd.lastSent.el) cmd.lastSent.el.classList.remove("pending"); cmd.pendingId = null;
    }
    if (off) { st.textContent = ""; }
  }
  // Explains greyed-out command buttons: the mod ships with "Permit game control" = Off (rev 2+).
  const cmdOff = () => !cmd.enabled || cmd.accepted === 0;
  const cmdHint = () => cmdOff() ? `<div class="cmdhint">${ico("alert", "sm")}<span>${t(cmd.enabled ? "commands_off_hint" : "commands_na")}</span></div>` : "";
  $$("#game-speed .sbtn").forEach(b => b.addEventListener("click", () => sendCmd("set_speed", { speed: +b.dataset.speed }, b)));
  // calendar speed (the game's slider, 0.25x..4x): the engine reports it as millis_per_day, 1x = 4000 ms
  $$("#cal-speed .cbtn").forEach(b => b.addEventListener("click", () => sendCmd("set_calendar_speed", { factor: +b.dataset.cal }, b)));
  window.addEventListener("keydown", e => {
    if (!settings.keys || e.target.matches("input,select,textarea") || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === "Space") { e.preventDefault(); sendCmd("toggle_pause", {}); }
    else if (/^Digit[1-9]$/.test(e.code) && e.shiftKey) { const v = camViews.list[+e.code.slice(5) - 1]; if (v) { e.preventDefault(); gotoView(v); } }  // Shift+1..9 = saved camera view
    else if (["Digit1", "Digit2", "Digit3"].includes(e.code)) { sendCmd("set_speed", { speed: { Digit1: 1, Digit2: 2, Digit3: 4 }[e.code] }); }
  });
  const vehActions = (v) => {
    const off = !cmd.enabled || cmd.accepted === 0;
    const b = (name, icon, label, extra = "") => `<button class="btn act ${extra}" data-cmd="${name}" data-veh="${v.vehicle_id}" ${off ? "disabled" : ""}>${ico(icon, "sm")}${esc(label)}</button>`;
    return `${cmdHint()}<div class="actions">${b("focus_entity", "camera", t("act_focus"))}${b("follow_entity", "locate", t("act_follow"))}${b("select_entity", "select", t("act_select"))}${v.user_stopped ? b("vehicle_start", "play_1", t("act_start")) : b("vehicle_stop", "stop", t("act_stop"), "danger")}${b("vehicle_reverse", "reverse", t("act_reverse"))}${b("vehicle_depart", "depart", t("act_depart"))}${b("vehicle_to_depot", "to_depot", t("act_depot"), "danger")}</div>`;
  };
  // compact icon buttons for any entity: camera (focus) + select (opens the game window); lines also get "manage"
  const entBtns = (id, o = {}) => {
    const off = !cmd.enabled || cmd.accepted === 0;
    const b = (name, icon, label) => `<button class="btn iconbtn act" data-cmd="${name}" data-veh="${id}" title="${esc(label)}" ${off ? "disabled" : ""}>${ico(icon, "sm")}</button>`;
    return `<span class="entbtns">${b("focus_entity", "camera", t("act_focus"))}${o.follow ? b("follow_entity", "locate", t("act_follow")) : ""}${b("select_entity", "select", t("act_select"))}${o.line ? b("open_line_manager", "configure_line", t("act_manage_line")) : ""}</span>`;
  };
  function bindActions(root) {
    $$("button.act", root).forEach(b => b.addEventListener("click", async e => {
      e.stopPropagation(); const id = +b.dataset.veh; const n = b.dataset.cmd;
      if (b.dataset.confirm && !(await modal.confirm(b.dataset.confirm, { danger: true, ok: b.textContent.trim() }))) return;
      const args = n.startsWith("vehicle_") ? { vehicle: id } : (n === "open_line_manager" || n.startsWith("line_")) ? { line: id } : { entity: id };
      sendCmd(n, args, b);
    }));
  }

  // ------------------------------------------------------------ tabs
  const state = { tab: "overview", sort: {}, selLine: null, selTown: null, selVeh: null, cache: {} };
  function showTab(name, push = true) {
    const b = $(`#tabs button[data-tab="${name}"]`); if (!b) return;
    $$("#tabs button").forEach(x => x.classList.toggle("active", x === b));
    $$(".tab").forEach(tb => tb.classList.toggle("active", tb.id === "tab-" + name));
    state.tab = name;
    document.body.dataset.tab = name;  // CSS: hide the time range on tabs without time charts
    if (push) { const u = new URL(location.href); u.searchParams.set("tab", name); history.replaceState(null, "", u); }
    refresh(true);
  }
  $$("#tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
  const tabFromUrl = () => new URLSearchParams(location.search).get("tab") || location.hash.slice(1);

  // ------------------------------------------------------------ sortable tables
  function renderTable(table, cols, rows, opts = {}) {
    const key = table.id;
    const sort = state.sort[key] || { col: opts.defaultSort || cols[0].key, asc: opts.defaultAsc ?? true };
    state.sort[key] = sort;
    const col = cols.find(c => c.key === sort.col) || cols[0];
    const sorted = rows.slice().sort((a, b) => {
      const va = col.sortValue ? col.sortValue(a) : a[col.key], vb = col.sortValue ? col.sortValue(b) : b[col.key];
      if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
      const r = (typeof va === "number" && typeof vb === "number") ? va - vb : String(va).localeCompare(String(vb), loc());
      return sort.asc ? r : -r;
    });
    // c.sticky: column pinned to the left while the table scrolls horizontally (the last pinned one gets a shadow)
    const lastStick = cols.map(c => !!c.sticky).lastIndexOf(true);
    const cls = (c, i) => `${c.num ? "num" : ""} ${c.key === "act" ? "act" : ""} ${c.sticky ? "stick" : ""} ${i === lastStick ? "stick-last" : ""}`;
    const thead = `<thead><tr>${cols.map((c, i) => `<th class="${cls(c, i)} ${c.key === sort.col ? "sorted " + (sort.asc ? "asc" : "") : ""}" data-key="${c.key}">${c.icon ? ico(c.icon, "sm") : ""}${esc(c.label)}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${sorted.map(r => `<tr class="${opts.rowClass ? opts.rowClass(r) : ""} ${opts.onRow ? "clickable" : ""}" data-id="${opts.id ? r[opts.id] : ""}">${cols.map((c, i) => `<td class="${cls(c, i)} ${c.wrap ? "wrap" : ""}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join("")}</tr>`).join("")}</tbody>`;
    table.innerHTML = thead + tbody;
    if (!sorted.length) table.innerHTML += `<tbody><tr><td colspan="${cols.length}" class="empty">${t("no_data")}</td></tr></tbody>`;
    if (lastStick >= 0) requestAnimationFrame(() => {
      // left offsets depend on the rendered widths of the previous pinned columns
      let left = 0;
      for (let i = 0; i <= lastStick; i++) {
        if (!cols[i].sticky) continue;
        const th = table.rows[0] && table.rows[0].cells[i]; if (!th) break;
        $$(`tr > :nth-child(${i + 1}).stick`, table).forEach(cell => cell.style.left = left + "px");
        left += th.getBoundingClientRect().width;
      }
    });
    $$("th", table).forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.key; if (sort.col === k) sort.asc = !sort.asc; else { sort.col = k; sort.asc = !(cols.find(c => c.key === k)?.num); }
      renderTable(table, cols, rows, opts);
    }));
    if (opts.onRow) $$("tbody tr", table).forEach(tr => tr.addEventListener("click", () => opts.onRow(tr.dataset.id, tr)));
    bindActions(table);
  }

  // ------------------------------------------------------------ top bar (always)
  let langFromGameApplied = false;
  async function renderTop() {
    const o = await api("/api/overview");
    const dot = $("#st-dot"), txt = $("#st-text");
    if (o.version) $("#brand-ver").textContent = o.version;
    if (o.empty) { dot.className = "dot dead"; txt.textContent = t("empty_db"); updateCmdUi(null); await renderSetup(); return null; }
    $("#setup-card").style.display = "none";
    if (o.lang && o.lang !== i18n.gameLang) {
      i18n.gameLang = o.lang;
      // follow the game language unless the user picked one explicitly
      if (!localStorage.getItem("tf3.lang") && !new URLSearchParams(location.search).get("lang") && normLang(o.lang) && normLang(o.lang) !== i18n.lang) { setLang(o.lang, false); }
      langFromGameApplied = true;
    }
    const s = o.snapshot, f = o.finance || {}, v = o.vehicles || {};
    // age = when the game wrote the export (real_time), not when the collector stored it: a leftover live.lua
    // imported at startup must show as old, not as "42 s ago"
    const written = s.real_time || s.received_at;
    const age = (Date.now() - new Date(written).getTime()) / 1000;
    dot.className = "dot " + (age < 15 ? "live" : age < 120 ? "stale" : "dead");
    txt.textContent = t("snapshot_status", { id: s.snapshot_id, ago: ago(written) }) + (s.n_errors ? " · " + t("errors_n", { n: s.n_errors }) : "");
    $("#k-date").textContent = date(s);
    // two independent speeds: simulation (pause / ×1 / ×2 / ×4) and calendar (the game's slider, 1x = 4000 ms/day)
    const cal = s.millis_per_day ? Math.round(4000 / s.millis_per_day * 100) / 100 : null;
    $("#k-speed").innerHTML = s.speed === 0 ? `${ico("play_pause", "sm")}${t("pause")}` : s.speed == null ? "" :
      `<span title="${esc(t("sim_speed"))}">${ico("play_1", "sm")}${t("speed_x", { n: s.speed })}</span>${cal != null ? ` <span class="muted" title="${esc(t("calendar_speed"))}">${ico("calendar", "sm")}${t("speed_x", { n: cal })}</span>` : ""}`;
    $("#k-veh").textContent = int(v.n);
    $("#k-veh-detail").innerHTML = v.n ? `<span style="color:${STATE_COLOR.EN_ROUTE}">${v.en_route} ${t("en_route")}</span> · ${v.at_terminal} ${t("at_terminal")} · ${v.in_depot} ${t("in_depot")}${v.no_path ? ` · <span class="neg">${v.no_path} ${t("no_path")}</span>` : ""}` : "";
    const fillEl = $("#k-fill");
    if (v.capacity) { fillEl.textContent = Math.round(pct(v.load, v.capacity)) + " %"; $("#k-fill-detail").textContent = t("seats", { a: int(v.load), b: int(v.capacity) }); } else { fillEl.textContent = "–"; $("#k-fill-detail").textContent = ""; }
    const m = $("#k-maint"); m.innerHTML = v.maint != null ? `${condIcon(v.maint)}${Math.round(v.maint * 100)} %` : "–"; m.className = "v " + (v.maint != null ? (v.maint < 0.5 ? "neg" : v.maint < 0.7 ? "" : "pos") : "");
    $("#k-maint-detail").textContent = v.worn != null ? t("worn_count", { n: v.worn }) : "";
    const na = (o.alerts || []).reduce((a, b) => a + b.n, 0);
    const ka = $("#k-alerts"); ka.textContent = na; ka.className = "v " + (na ? "bad" : "ok");
    ka.closest(".kpi").classList.toggle("has", na > 0);
    $("#k-alerts-detail").innerHTML = (o.alerts || []).map(a => `<span title="${esc(alertLabel(a.kind))}">${ico(ALERT_ICON[a.kind] || "alert", "sm")}${a.n}</span>`).join(" ");
    $("#k-pax").textContent = intShort(f.passengers_transported) + " " + t("pax");
    $("#k-cargo").textContent = int(f.cargo_transported) + " " + t("cargo");
    $("#k-balance").textContent = moneyShort(f.balance);
    const bd = $("#k-balance-delta");
    if (o.balance_prev && o.balance_prev.balance != null) { const d = f.balance - o.balance_prev.balance; bd.textContent = (d >= 0 ? "+" : "") + money(d) + " / " + ago(o.balance_prev.real_time); bd.className = "s " + (d >= 0 ? "pos" : "neg"); } else bd.textContent = "";
    const ec = $("#errors-card"); if (o.errors && o.errors.length) { ec.style.display = ""; $("#errors-list").textContent = o.errors.map(x => `${x.section}: ${x.error}`).join("\n"); } else ec.style.display = "none";
    // the strip only shows icon + value: label and details go to the tooltip (full balance there too)
    $$("#vital .kpi").forEach(k => { k.title = [$(".k", k).textContent, $(".s", k).textContent].filter(Boolean).join(" · "); });
    $("#k-balance").closest(".kpi").title += " · " + money(f.balance);
    updateCmdUi(o);
    return o;
  }
  // the alert figure of the strip opens the alert list
  $("#k-alerts").closest(".kpi").addEventListener("click", () => { showTab("overview"); setTimeout(() => { const a = $("#alerts-list"); if (a) a.closest(".card").scrollIntoView({ behavior: "smooth", block: "center" }); }, 300); });

  // ------------------------------------------------------------ empty database: say exactly which link of the chain is missing
  // game (mod enabled in the savegame) -> <userdata>/dashboard_export/live.lua -> collector -> db -> this page
  async function renderSetup() {
    const card = $("#setup-card"); card.style.display = "";
    let d;
    try { d = await api("/api/diag"); } catch (e) { $("#setup-body").innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    const steps = [];
    const step = (ok, label, detail) => steps.push(`<li class="${ok === null ? "" : ok ? "ok" : "bad"}"><span class="mark">${ok === null ? "·" : ok ? "✓" : "✗"}</span><div><div class="n">${label}</div>${detail ? `<div class="d">${detail}</div>` : ""}</div></li>`);
    const mono = s => `<code>${esc(s)}</code>`;
    // 1. the game's userdata folder
    if (!d.export_dir) {
      step(false, t("setup_no_folder"), t("setup_no_folder_help", { cfg: mono("config.json"), ex: mono(`{ "export_dir": "%APPDATA%\\Transport Fever 3\\dashboard_export" }`) }));
    } else {
      const others = (d.candidates || []).filter(c => c.dir.toLowerCase() !== d.export_dir.toLowerCase());
      const where = mono(d.export_dir) + (others.length ? `<br>${t("setup_other_folders")} ${others.map(c => `${esc(c.store)}: ${mono(c.dir)}`).join(", ")}` : "");
      // the game does not always create dashboard_export itself (saveUserdata then fails); the companion creates it
      // at startup, so a missing folder here means it could not
      const storeLabel = esc(d.store || (d.source === "config" ? "config.json" : d.source === "auto" ? "?" : t("setup_source_configured")));
      if (!d.dir_exists) step(false, t("setup_folder_missing", { store: storeLabel }), where + "<br>" + t("setup_folder_missing_help"));
      else step(true, t("setup_folder", { store: storeLabel }), where);
      // 1b. what the game's own log (crash_dump/stdout.txt) says, when it contradicts the above: another userdata
      // folder (other Steam account, moved profile), mod not in the list, mod never ran, writes refused
      const g = d.game_log;
      if (g && !d.live_exists) {
        const logRef = mono(g.log);
        if (g.userdata_matches === false) step(false, t("setup_log_other_folder"), t("setup_log_other_folder_help", { dir: mono(g.userdata), cfg: mono("config.json"), log: logRef }));
        else if (!g.mod_loaded) step(false, t("setup_log_no_mod"), t("setup_log_no_mod_help", { log: logRef }));
        else if (g.save_errors > 0) step(false, t("setup_log_write_error", { n: g.save_errors }), mono(g.last_error) + "<br>" + t("setup_log_write_error_help", { log: logRef }));
        else if (g.mod_lines === 0) step(false, t("setup_log_mod_idle"), t("setup_log_mod_idle_help", { log: logRef }));
        else step(null, t("setup_log_ok", { n: g.written, src: esc(g.mod_source || "?") }), logRef);
      }
      // 2. live.lua written by the mod
      if (!d.live_exists) step(false, t("setup_no_live"), t("setup_no_live_help") + " " + t("setup_no_live_log"));
      else if (d.live_age_s > 120) step(false, t("setup_live_old", { ago: fmtDur(d.live_age_s) }), t("setup_live_old_help"));
      else step(true, t("setup_live_ok", { ago: fmtDur(d.live_age_s) }), null);
    }
    // 3. collector -> database
    if (d.export_dir && d.live_exists) {
      if (!d.db_exists || !d.snapshots) step(false, t("setup_no_db"), t("setup_no_db_help", { db: mono(d.db) }));
      else step(d.last_snapshot_age_s < 120, t("setup_db", { n: d.snapshots, ago: fmtDur(d.last_snapshot_age_s) }), null);
    }
    // the companion itself running from OneDrive/Dropbox: not a step of the chain, but a classic cause of an empty or
    // corrupt SQLite database, so say it here
    const sync = (d.synced_dirs || []).length ? `<p class="setup-warn">${t("setup_sync_warning", { dir: mono(d.synced_dirs[0]) })}</p>` : "";
    $("#setup-body").innerHTML = sync + `<ol class="steps">${steps.join("")}</ol><p class="muted small">${t("setup_footer", { v: esc(d.version || "") })}</p>`;
  }
  function fmtDur(s) { if (s == null) return "–"; if (s < 90) return t("dur_s", { n: Math.round(s) }); if (s < 5400) return t("dur_m", { n: Math.round(s / 60) }); return t("dur_h", { n: Math.round(s / 360) / 10 }); }

  // ------------------------------------------------------------ overview = operations
  const miniRow = (v, right) => `<div class="row" data-veh="${v.vehicle_id}"><div><div class="n">${vehIcon(v, "sm")}${esc(v.name)}</div><div class="d">${CA(v.carrier)} · ${esc(v.line_name || t("no_line"))}</div></div><div class="r">${right}</div></div>`;
  async function renderOverview() {
    const [fleet, al, ld] = await Promise.all([api("/api/fleet", { limit: settings.history, range: settings.range }), api("/api/alerts"), api("/api/lines")]);
    state.cache.fleet = fleet; state.cache.lines = ld.lines || [];
    if (fleet.empty) return;
    const hist = fleet.history || [];
    const labels = hist.map(h => dateLabel(h));
    const tx = tsOpts(hist, "ops");
    $("#fleet-sub").textContent = t("samples_range", { n: hist.length, r: rangeLabel() });
    Charts.lineChart($("#chart-fleet-state"), [
      { name: t("state.EN_ROUTE"), values: hist.map(h => h.en_route), color: STATE_COLOR.EN_ROUTE },
      { name: t("state.AT_TERMINAL"), values: hist.map(h => h.at_terminal), color: STATE_COLOR.AT_TERMINAL },
      { name: t("state.IN_DEPOT"), values: hist.map(h => h.in_depot), color: STATE_COLOR.IN_DEPOT },
    ], labels, { stacked: true, zeroBase: true, ...tx });
    Charts.lineChart($("#chart-fleet-perf"), [
      { name: t("kpi_fill"), values: hist.map(h => pct(h.load, h.capacity || fleet.capacity || 1)), color: "#e8b04b", unit: "%" },
      { name: t("kpi_maint"), values: hist.map(h => h.maint != null ? h.maint * 100 : null), color: "#4f8a8a", unit: "%" },
      { name: t("th_avg_speed"), values: hist.map(h => h.avg_speed != null ? h.avg_speed * 3.6 : null), color: "#58a6ff", axis: "right", unit: "km/h" },
    ], labels, { percent: true, rightAxis: true, rightUnit: "km/h", ...tx });

    const bc = fleet.by_carrier || [];
    $("#fleet-carrier").innerHTML = `<thead><tr><th></th><th class="num">${t("th_veh")}</th><th class="num">${t("th_en_route")}</th><th class="num">${t("th_terminal")}</th><th class="num">${t("th_depot")}</th><th>${t("th_fill")}</th><th>${t("th_cond")}</th><th class="num">${t("th_avg_speed")}</th><th class="num">${t("th_idle")}</th></tr></thead><tbody>` +
      bc.map(c => `<tr><td><span class="vehicon" style="color:${CARRIER_COLOR[c.carrier] || "#888"}">${ico(ICON_BY_CARRIER[c.carrier] || "veh_car")}</span>${CA(c.carrier)}</td><td class="num">${c.n}</td><td class="num">${c.en_route}</td><td class="num">${c.at_terminal}</td><td class="num">${c.in_depot}</td>
        <td>${c.capacity ? bar(c.load, c.capacity, fillCls(pct(c.load, c.capacity))) : "–"}</td><td>${c.maint != null ? condIcon(c.maint) + bar(c.maint, 1, maintCls(c.maint)) : "–"}${c.worn ? ` <span class="chip warn">${c.worn}</span>` : ""}</td>
        <td class="num">${kmh(c.avg_speed)}</td><td class="num">${c.stuck ? `<span class="chip bad">${c.stuck}</span>` : "0"}</td></tr>`).join("") + "</tbody>";

    renderAlerts($("#alerts-list"), al.alerts || []);
    $("#alerts-count").textContent = (al.alerts || []).length ? `${al.alerts.length}` : t("none");

    const idle = fleet.idle || [];
    $("#idle-count").textContent = idle.length ? idle.length : "";
    $("#idle-list").innerHTML = idle.length ? idle.map(v => miniRow(v, `${v.no_path ? `<span class="chip bad">${t("no_path")}</span>` : ""}${v.user_stopped ? `<span class="chip warn">${t("stopped")}</span>` : ""}<span class="chip">${ST(v.state)}</span><br><span class="muted">${t("idle_days", { n: (v.days_in_depot || 0) + (v.days_at_terminal || 0) })}</span>`)).join("") : `<div class="empty">${t("everyone_moving")}</div>`;
    const stuck = fleet.stuck || [];
    $("#stuck-list").innerHTML = stuck.length ? stuck.map(v => miniRow(v, `<span class="chip bad">${t("stuck_n", { n: v.n })}</span>`)).join("") : `<div class="empty">${t("none_stuck")}</div>`;
    $$("#idle-list .row, #stuck-list .row").forEach(r => r.addEventListener("click", () => { state.selVeh = +r.dataset.veh; showTab("vehicles"); }));

    Charts.hbars($("#chart-worn"), (fleet.worn || []).slice(0, 10).map(v => ({ label: v.name, value: 1 - (v.maintenance ?? 1), max: 1, color: maintCls(v.maintenance) === "bad" ? "#f85149" : maintCls(v.maintenance) === "warn" ? "#e8b04b" : "#3fb950", text: t("state_cond", { n: Math.round((v.maintenance ?? 1) * 100) }) })), {});
    const lines = state.cache.lines;
    const bad = lines.map(l => { const tot = (l.pax_total || 0) + (l.cargo_total || 0), b = (l.pax_bad || 0) + (l.cargo_bad || 0); return { l, tot, b, p: tot ? 100 * b / tot : 0 }; }).filter(x => x.tot >= 5).sort((a, b) => b.p - a.p).slice(0, 10);
    Charts.hbars($("#chart-lines-bad"), bad.map(x => ({ label: x.l.name, value: x.p, max: 100, color: x.p > 30 ? "#f85149" : x.p > 10 ? "#e8b04b" : "#3fb950", text: `${Math.round(x.p)} % (${x.b}/${x.tot})` })), {});
    const load = lines.map(l => { const c = l.capacities.reduce((a, x) => ({ u: a.u + (x.used || 0), c: a.c + (x.capacity || 0) }), { u: 0, c: 0 }); return { l, p: c.c ? 100 * c.u / c.c : 0, u: c.u, c: c.c }; }).filter(x => x.c > 0).sort((a, b) => b.p - a.p).slice(0, 10);
    Charts.hbars($("#chart-lines-load"), load.map(x => ({ label: x.l.name, value: x.p, max: 100, color: x.p >= 80 ? "#3fb950" : x.p < 25 ? "#e8b04b" : "#4f8a8a", text: `${Math.round(x.p)} % (${Math.round(x.u)}/${Math.round(x.c)})` })), {});
  }

  // what an alert says (shared by the alert lists and the Windows notifications)
  function alertDesc(a) {
    const codeTable = ALERT_CODE[a.kind] ? t(ALERT_CODE[a.kind]) : null;
    const code = codeTable && a.type_code != null ? (codeTable[a.type_code] ?? ("code " + a.type_code)) : "";
    // chain alerts (chains.py) carry their own wording: amount is a percentage or a quantity per year depending on the code
    const extra = a.catalogue
      ? [CAT_TYPE[a.category] ? t("line_type." + CAT_TYPE[a.category]) : "", a.speed_ms ? kmh(a.speed_ms) : "", a.capacity ? t("cat_capacity", { n: int(a.capacity) }) : "", a.price ? money(a.price) : ""].filter(Boolean).join(" · ")
      : a.chain
      ? [t(`chain_code.${a.kind}.${a.type_code}`, { n: int(a.amount), cargo: cargoName(a.cargo) }), (a.chains || []).length ? t("chain_in", { names: a.chains.join(", ") }) : ""].filter(Boolean).join(" · ")
      : [code, a.stop_index != null ? t("stop_n", { n: a.stop_index }) : "", a.amount != null ? t("units_n", { n: a.amount }) : "", a.related_id != null && a.kind === "blocked_train" ? t("by_id", { id: a.related_id }) : ""].filter(Boolean).join(" · ");
    const who = a.entity_name || (a.entity_id != null ? "#" + a.entity_id : "");
    return { sev: ALERT_SEV[a.kind] || "info", label: alertLabel(a.kind), extra, who };
  }
  function renderAlerts(el, alerts) {
    if (!alerts.length) { el.innerHTML = `<div class="empty">${t("all_good")}</div>`; return; }
    const order = { bad: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => (order[ALERT_SEV[a.kind]] ?? 3) - (order[ALERT_SEV[b.kind]] ?? 3) || b.seen - a.seen);
    el.innerHTML = alerts.map(a => {
      const { sev, extra, who } = alertDesc(a);
      // thrown_away_cargo points at a stock list = an industry (no line is involved): camera / select target the
      // industry and an extra button opens the Industries tab on it
      const focus = a.catalogue ? `<button class="btn iconbtn gotocat" title="${esc(t("tab_catalogue"))}">${ico("calendar", "sm")}</button>`
        : a.kind === "thrown_away_cargo"
        ? (a.industry_id != null ? `<span class="entbtns">${entBtns(a.industry_id)}<button class="btn iconbtn goto" data-ind="${esc(a.entity_name)}" title="${esc(t("tab_industries"))}">${ico("industry", "sm")}</button></span>` : "")
        : a.entity_id != null ? entBtns(a.entity_id, { line: a.kind === "chain_bottleneck" || a.kind === "chain_overcapacity" }) : "";
      return `<div class="alert"><div class="sev ${sev}"></div><div style="color:${sev === "bad" ? "var(--bad)" : sev === "warn" ? "var(--warn)" : "var(--info)"}">${ico(ALERT_ICON[a.kind] || "alert")}</div><div><div class="what">${esc(alertLabel(a.kind))}${extra ? " — " + esc(extra) : ""}</div><div class="who">${esc(who)}</div></div><div class="age">${a.catalogue ? t("cat_new") : a.chain ? (a.since ? t("since", { ago: ago(a.since) }) : "") : `${a.seen > 1 ? t("seen_n", { n: a.seen }) : t("new")}${a.since ? "<br>" + t("since", { ago: ago(a.since) }) : ""}`}</div>${focus}</div>`;
    }).join("");
    bindActions(el);
    $$("button.gotocat", el).forEach(b => b.addEventListener("click", e => { e.stopPropagation(); showTab("catalogue"); }));
    $$("button.goto[data-ind]", el).forEach(b => b.addEventListener("click", e => { e.stopPropagation(); $("#ind-filter").value = b.dataset.ind; showTab("industries"); }));
  }

  // ------------------------------------------------------------ vehicles
  async function renderVehicles() {
    const d = await api("/api/vehicles"); const veh = d.vehicles || []; state.cache.vehicles = veh;
    if (!state.selVeh) { const u = +new URLSearchParams(location.search).get("veh"); if (u && veh.some(v => v.vehicle_id === u)) state.selVeh = u; }  // deep link ?tab=vehicles&veh=<id>
    renderTypeBar($("#veh-types"), veh, vehType, state.vehTypes, renderVehicles);
    const q = $("#veh-filter").value.toLowerCase(), st = $("#veh-state").value, worn = $("#veh-worn").checked, prob = $("#veh-problem").checked;
    const rows = veh.filter(v => (!q || [v.name, v.line_name, v.town_name, v.model].join(" ").toLowerCase().includes(q)) && (!state.vehTypes.size || state.vehTypes.has(vehType(v))) && (!st || v.state === st) && (!worn || (v.maintenance != null && v.maintenance < 0.5)) && (!prob || v.no_path || v.user_stopped || !v.line_id || (v.days_in_depot + v.days_at_terminal) > 2));
    $("#veh-count").textContent = `${rows.length} / ${veh.length}`;
    const cols = [
      { key: "name", label: t("th_vehicle"), render: v => `${esc(v.name)}${v.model ? `<br><small>${esc(v.model)}</small>` : ""}` },
      { key: "carrier", label: t("th_type"), render: v => `<span class="vehicon" style="color:${CARRIER_COLOR[v.carrier] || "#888"}">${modelImg(v)}${ENGINE_ICON[v.icon_type] ? ico(ENGINE_ICON[v.icon_type], "sm", t("icon_type." + v.icon_type)) : ""}</span>`, sortValue: v => (v.carrier || "") + (v.icon_type || "") },
      { key: "line_name", label: t("th_line"), render: v => esc(v.line_name || (v.line_id ? "#" + v.line_id : "–")) },
      { key: "state", label: t("th_state"), render: v => { const cls = v.no_path ? "bad" : v.user_stopped ? "warn" : v.state === "EN_ROUTE" ? "ok" : ""; return `<span class="chip ${cls}">${ST(v.state)}${v.no_path ? " · " + t("no_path") : ""}${v.user_stopped ? " · " + t("stopped") : ""}</span>`; } },
      { key: "speed_ms", label: t("th_speed"), num: true, render: v => kmh(v.speed_ms) },
      { key: "load", label: t("th_load"), num: true, render: v => v.capacity ? bar(v.load || 0, v.capacity, fillCls(pct(v.load || 0, v.capacity)), `${v.load ?? 0}/${v.capacity}`) : int(v.load), sortValue: v => v.capacity ? (v.load || 0) / v.capacity : null },
      { key: "maintenance", label: t("th_cond_short"), num: true, render: v => v.maintenance == null ? "–" : condIcon(v.maintenance) + bar(v.maintenance, 1, maintCls(v.maintenance)) },
      { key: "idle", label: t("th_idle_short"), num: true, render: v => { const d = (v.days_in_depot || 0) + (v.days_at_terminal || 0); return d ? `<span class="${d > 3 ? "neg" : ""}">${d} j</span>` : "–"; }, sortValue: v => (v.days_in_depot || 0) + (v.days_at_terminal || 0) },
      { key: "running_cost", label: t("th_cost_year"), num: true, render: v => money(v.running_cost) },
      { key: "value", label: t("th_value"), num: true, render: v => money(v.value) },
      { key: "town_name", label: t("th_near"), render: v => esc(v.town_name || "–") },
      { key: "act", label: "", render: v => entBtns(v.vehicle_id, { follow: true }) },
    ];
    renderTable($("#veh-table"), cols, rows, { id: "vehicle_id", defaultSort: "name", onRow: (id, tr) => { state.selVeh = +id; $$("tr", tr.parentElement).forEach(x => x.classList.toggle("sel", x === tr)); renderVehicleDetail(+id); }, rowClass: v => (v.vehicle_id === state.selVeh ? "sel" : "") });
    if (state.selVeh) renderVehicleDetail(state.selVeh);
  }

  async function renderVehicleDetail(id) {
    const d = await api("/api/vehicle_history", { id, limit: settings.history, range: settings.range });
    const v = d.vehicle; if (!v) return;
    const hist = d.history || [], labels = hist.map(h => dateLabel(h));
    const last = hist[hist.length - 1] || {};
    const cur = (state.cache.vehicles || []).find(x => x.vehicle_id === id) || {};
    const el = $("#veh-detail");
    el.innerHTML = `<h2>${vehIcon(v, "lg")}${esc(v.name)} <small>#${v.vehicle_id} · ${v.icon_type ? t("icon_type." + v.icon_type) : CA(v.carrier)}${v.model ? " · " + esc(v.model) : ""}</small></h2>
      <div class="consist-row">${consist(v, "lg")}</div>
      ${vehActions({ vehicle_id: v.vehicle_id, user_stopped: cur.user_stopped })}
      <table class="kv">
        <tr><td>${t("th_line")}</td><td>${esc(v.line_name || "–")}</td></tr>
        <tr><td>${t("th_state")}</td><td><span class="chip" style="color:${STATE_COLOR[last.state] || "#fff"}">${ST(last.state)}</span> · ${t("stop")} ${last.stop_index ?? "–"}</td></tr>
        <tr><td>${t("th_load")}</td><td>${v.capacity ? bar(last.load || 0, v.capacity, fillCls(pct(last.load || 0, v.capacity)), `${last.load ?? 0}/${v.capacity}`) : "–"}</td></tr>
        <tr><td>${t("condition")}</td><td>${last.maintenance != null ? condIcon(last.maintenance) + bar(last.maintenance, 1, maintCls(last.maintenance)) : "–"}</td></tr>
        <tr><td>${t("th_speed")}</td><td>${kmh(last.speed_ms)}</td></tr>
      </table>
      <h2 style="margin-top:12px">${ico("speed")}${t("speed_load")}</h2><canvas id="chart-veh-1" data-h="170"></canvas>
      <h2>${ico("wrench")}${t("condition")}</h2><canvas id="chart-veh-2" data-h="120"></canvas>
      <p class="muted" style="font-size:12px">${t("state_split", { n: hist.length })} ${["EN_ROUTE", "AT_TERMINAL", "IN_DEPOT", "GOING_TO_DEPOT"].map(s => { const n = hist.filter(h => h.state === s).length; return n ? `<span style="color:${STATE_COLOR[s]}">${ST(s)} ${Math.round(100 * n / hist.length)} %</span>` : ""; }).filter(Boolean).join(" · ")}</p>`;
    bindActions(el);
    Charts.lineChart($("#chart-veh-1"), [
      { name: t("th_speed"), values: hist.map(h => h.speed_ms != null ? h.speed_ms * 3.6 : null), color: "#58a6ff", unit: "km/h", area: true },
      { name: t("th_load"), values: hist.map(h => h.load), color: "#e8b04b", axis: "right", step: true },
    ], labels, { zeroBase: true, rightAxis: true, unit: "km/h", rightUnit: "", ...tsOpts(hist, "veh") });
    Charts.lineChart($("#chart-veh-2"), [{ name: t("condition"), values: hist.map(h => h.maintenance != null ? h.maintenance * 100 : null), color: "#4f8a8a", unit: "%", area: true }], labels, { percent: true, ...tsOpts(hist, "veh") });
  }

  // ------------------------------------------------------------ lines
  const cargoName = (n) => n ? String(n).replace(/^.*\//, "").replace(/\.cargo.*$/, "").replace(/_/g, " ") : "?";
  const cargoChip = (c) => `<span class="chip">${cargoIcon(c)}${esc(cargoName(cargoLabel(c)))}</span>`;
  const hasLineProblem = (l) => (l.vehicles === 0) || (l.pax_total > 10 && l.pax_bad / l.pax_total > 0.3) || (l.cargo_total > 10 && l.cargo_bad / l.cargo_total > 0.3);
  // Vehicle type of a line: from the vehicles currently on it (icon_type / carrier), else from the line's transport
  // modes (TransportMode enum: 2 CAR 3 BUS 4 TRUCK 5 TRAM 6 ELECTRIC_TRAM 7 TRAIN 8 ELECTRIC_TRAIN 9 AIRCRAFT 10 SHIP
  // 11 SMALL_AIRCRAFT 12 SMALL_SHIP 13 HELICOPTER). Returns one of the LINE_TYPES keys.
  const LINE_TYPES = ["Bus", "Truck", "Tram", "Train", "Ship", "Aircraft", "Helicopter"];
  const LINE_TYPE_ICON = { Bus: "veh_bus", Truck: "veh_truck", Tram: "veh_tram", Train: "veh_train", Ship: "veh_ship", Aircraft: "veh_plane", Helicopter: "veh_heli" };
  const LINE_TYPE_COLOR = { Bus: CARRIER_COLOR.ROAD, Truck: CARRIER_COLOR.ROAD, Tram: CARRIER_COLOR.TRAM, Train: CARRIER_COLOR.RAIL, Ship: CARRIER_COLOR.WATER, Aircraft: CARRIER_COLOR.AIR, Helicopter: CARRIER_COLOR.AIR };
  const MODE_TYPE = { 3: "Bus", 4: "Truck", 5: "Tram", 6: "Tram", 7: "Train", 8: "Train", 9: "Aircraft", 11: "Aircraft", 10: "Ship", 12: "Ship", 13: "Helicopter" };
  function lineType(l) {
    const it = l.live && l.live.icon_types ? String(l.live.icon_types).split(",") : [];
    for (const x of it) { if (x.startsWith("Train")) return "Train"; if (LINE_TYPES.includes(x)) return x; }
    let modes = l.transport_modes; if (typeof modes === "string") { try { modes = JSON.parse(modes); } catch (e) { modes = []; } }
    const found = (modes || []).map(m => MODE_TYPE[m]).filter(Boolean);
    if (found.includes("Bus") && found.includes("Truck")) {
      // a road line with no vehicles yet: pick by what it carries
      return (l.capacities || []).some(c => c.cargo_id !== 0) ? "Truck" : "Bus";
    }
    return found[0] || null;
  }
  // what a line carries, from its capacities (cargo_id 0 = passengers); a line without any capacity yet (no
  // vehicle) is treated as both so nothing is hidden by mistake. Passenger statistics on a freight line (and
  // cargo statistics on a passenger line) are meaningless and are not shown.
  const carriesPax = (l) => !(l.capacities || []).length || (l.capacities || []).some(c => c.cargo_id === 0);
  const carriesCargo = (l) => !(l.capacities || []).length || (l.capacities || []).some(c => c.cargo_id !== 0);
  const NA = '<span class="muted">·</span>';
  const lineTypeIcon = (l, cls = "sm") => { const ty = lineType(l); return ty ? `<span class="vehicon" style="color:${LINE_TYPE_COLOR[ty]}">${ico(LINE_TYPE_ICON[ty], cls, t("line_type." + ty))}</span>` : ""; };
  state.lineTypes = new Set(); state.vehTypes = new Set();  // active type filters per tab (empty = all)
  // Icon toggle bar (one button per vehicle type present, with a count). Click toggles the type; several can be active.
  function renderTypeBar(bar, items, typeOf, active, onChange) {
    if (!bar) return;
    const counts = {}; items.forEach(x => { const ty = typeOf(x); if (ty) counts[ty] = (counts[ty] || 0) + 1; });
    const types = LINE_TYPES.filter(ty => counts[ty]);
    bar.innerHTML = types.map(ty => `<button class="tbtn ${active.has(ty) ? "active" : ""}" data-type="${ty}" title="${esc(t("line_type." + ty))}" style="--c:${LINE_TYPE_COLOR[ty]}">${ico(LINE_TYPE_ICON[ty], "sm")}<small>${counts[ty]}</small></button>`).join("")
      + (active.size ? `<button class="tbtn clear" data-type="" title="${esc(t("all_types"))}">${ico("close", "sm")}</button>` : "");
    $$(".tbtn", bar).forEach(b => b.addEventListener("click", () => {
      const ty = b.dataset.type;
      if (!ty) active.clear(); else if (active.has(ty)) active.delete(ty); else active.add(ty);
      onChange();
    }));
  }
  const renderLineTypeBar = (lines) => renderTypeBar($("#lines-types"), lines, lineType, state.lineTypes, renderLines);
  const vehType = (v) => v.icon_type ? (String(v.icon_type).startsWith("Train") ? "Train" : v.icon_type) : ({ ROAD: "Bus", RAIL: "Train", TRAM: "Tram", AIR: "Aircraft", WATER: "Ship" }[v.carrier] || null);
  async function renderLines() {
    const d = await api("/api/lines"); const lines = d.lines || []; state.cache.lines = lines;
    state.cache.cargoTypes = d.cargo_types || [];
    if (!state.selLine) { const u = +new URLSearchParams(location.search).get("line"); if (u && lines.some(l => l.line_id === u)) state.selLine = u; }  // deep link ?tab=lines&line=<id>
    renderLineTypeBar(lines);
    const q = $("#lines-filter").value.toLowerCase(), onlyP = $("#lines-problems-only").checked;
    const rows = lines.filter(l => (!q || (l.name || "").toLowerCase().includes(q) || l.stop_names.join(" ").toLowerCase().includes(q)) && (!onlyP || hasLineProblem(l)) && (!state.lineTypes.size || state.lineTypes.has(lineType(l))));
    const loadOf = (l) => l.capacities.reduce((a, x) => ({ u: a.u + (x.used || 0), c: a.c + (x.capacity || 0) }), { u: 0, c: 0 });
    const cols = [
      { key: "name", label: t("th_line"), render: l => `<span class="swatch" style="background:${rgb(l.color_r, l.color_g, l.color_b)}"></span>${lineTypeIcon(l)}${esc(l.name)}` },
      { key: "stops", label: t("th_stops"), num: true },
      { key: "vehicles", label: t("th_veh"), num: true, render: l => `${l.vehicles ?? "–"}${l.live ? ` <small>(${l.live.en_route} ${t("en_route")})</small>` : ""}` },
      { key: "max_frequency", label: t("th_headway"), num: true, render: l => headway(l.max_frequency), sortValue: l => l.max_frequency },
      { key: "load", label: t("th_load"), num: true, render: l => { const c = loadOf(l); return c.c ? bar(c.u, c.c, fillCls(pct(c.u, c.c))) : "–"; }, sortValue: l => { const c = loadOf(l); return c.c ? c.u / c.c : null; } },
      { key: "persons_on_line", label: t("th_onboard"), num: true, render: l => carriesPax(l) ? int(l.persons_on_line) : NA, sortValue: l => carriesPax(l) ? l.persons_on_line : null },
      { key: "pax", label: t("th_pax_unhappy"), render: l => carriesPax(l) ? barQuality(l.pax_bad, l.pax_total) : NA, sortValue: l => carriesPax(l) && l.pax_total ? l.pax_bad / l.pax_total : null },
      { key: "cargo", label: t("th_cargo_late"), render: l => carriesCargo(l) ? barQuality(l.cargo_bad, l.cargo_total) : NA, sortValue: l => carriesCargo(l) && l.cargo_total ? l.cargo_bad / l.cargo_total : null },
      { key: "cargos", label: t("th_carries"), wrap: true, render: l => l.capacities.map(c => cargoChip(c)).join("") },
      { key: "act", label: "", render: l => entBtns(l.line_id, { line: true }) },
    ];
    renderTable($("#lines-table"), cols, rows, { id: "line_id", defaultSort: "name", onRow: (id, tr) => { state.selLine = +id; $$("tr", tr.parentElement).forEach(x => x.classList.toggle("sel", x === tr)); renderLineDetail(+id); }, rowClass: l => (l.line_id === state.selLine ? "sel" : "") });
    if (state.selLine) renderLineDetail(state.selLine);
  }

  async function renderLineDetail(id) {
    const l = (state.cache.lines || []).find(x => x.line_id === id); if (!l) return;
    const h = await api("/api/line_history", { id, limit: settings.history, range: settings.range });
    const el = $("#line-detail");
    // a stop editor open on this line must survive the periodic refresh: keep its DOM and put it back below
    const keepStops = state.editStop && state.editStop.line === id && $("#line-stops-wrap tr.editing", el) ? $("#line-stops-wrap", el) : null;
    el.innerHTML = `<h2><span class="swatch" style="background:${rgb(l.color_r, l.color_g, l.color_b)}"></span>${lineTypeIcon(l)}${esc(l.name)} <small>#${l.line_id}</small></h2>
      <div class="actions"><button class="btn act" data-cmd="focus_entity" data-veh="${l.line_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("camera", "sm")}${t("act_focus")}</button><button class="btn act" data-cmd="select_entity" data-veh="${l.line_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("select", "sm")}${t("act_select")}</button><button class="btn act" data-cmd="open_line_manager" data-veh="${l.line_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("configure_line", "sm")}${t("act_manage_line")}</button><button class="btn" id="line-on-map">${ico("locate", "sm")}${t("see_on_map")}</button></div>
      <p class="muted">${l.stop_names.map(esc).join(" → ") || t("unknown_stops")}${l.custom_filters ? ` · <span class="chip">${t("custom_filters")}</span>` : ""}${l.reservation_priority > 1 ? ` · ${ico(l.reservation_priority >= 3 ? "prio_very_high" : "prio_high", "sm")}${t("priority")} ${t("prio_" + Math.min(3, Math.round(l.reservation_priority)))}` : ""}</p>
      <table class="kv">${l.capacities.map(c => `<tr><td>${cargoIcon(c)}${esc(cargoName(c.cargo))}</td><td>${bar(c.used, c.capacity, fillCls(pct(c.used, c.capacity)), `${Math.round(c.used)} / ${Math.round(c.capacity)}`)}</td></tr>`).join("")}</table>
      <h2 style="margin-top:12px">${ico("line_stations")}${t("stops_title")} <small>${(l.stop_list || []).length}</small></h2>
      <div id="line-stops-wrap"></div>
      <h2 style="margin-top:12px">${ico("vehicles")}${t("line_vehicles")} <small>${(h.vehicles || []).length}</small></h2>
      <div class="actions">${lineBulkBtns(l, (h.vehicles || []).length)}</div>
      <div id="line-veh-wrap">${(h.vehicles || []).length ? "" : `<p class="muted">${t("no_line_vehicles")}</p>`}</div>
      <h2 style="margin-top:12px">${ico("vehicles")}${t(carriesPax(l) ? "veh_and_pax" : "kpi_vehicles")}</h2><canvas id="chart-line-1" data-h="170"></canvas>
      <h2>${ico("unhappy")}${t("service_quality")}</h2><canvas id="chart-line-2" data-h="150"></canvas>`;
    if ((h.vehicles || []).length) {
      const vcols = [
        { key: "name", label: t("th_vehicle"), render: v => `${modelImg(v, "sm")}${esc(v.name)}` },
        { key: "state", label: t("th_state"), render: v => { const cls = v.no_path ? "bad" : v.user_stopped ? "warn" : v.state === "EN_ROUTE" ? "ok" : ""; return `<span class="chip ${cls}">${ST(v.state)}${v.no_path ? " · " + t("no_path") : ""}${v.user_stopped ? " · " + t("stopped") : ""}</span>`; } },
        { key: "stop_index", label: t("th_next_stop"), render: v => v.stop_index == null ? "–" : `<small>${v.stop_index + 1}.</small> ${esc(v.stop_name || "?")}`, sortValue: v => v.stop_index },
        { key: "speed_ms", label: t("th_speed"), num: true, render: v => kmh(v.speed_ms) },
        { key: "load", label: t("th_load"), num: true, render: v => v.capacity ? bar(v.load || 0, v.capacity, fillCls(pct(v.load || 0, v.capacity)), `${v.load ?? 0}/${v.capacity}`) : int(v.load), sortValue: v => v.capacity ? (v.load || 0) / v.capacity : null },
        { key: "maintenance", label: t("th_cond_short"), num: true, render: v => v.maintenance == null ? "–" : condIcon(v.maintenance) + bar(v.maintenance, 1, maintCls(v.maintenance)) },
        { key: "act", label: "", render: v => entBtns(v.vehicle_id, { follow: true }) },
      ];
      const tbl = document.createElement("table"); tbl.className = "data"; tbl.id = "line-veh-table"; $("#line-veh-wrap").appendChild(tbl);
      renderTable(tbl, vcols, h.vehicles, { id: "vehicle_id", defaultSort: "stop_index", onRow: (vid) => { state.selVeh = +vid; showTab("vehicles"); } });
    }
    if (keepStops) $("#line-stops-wrap").replaceWith(keepStops); else renderStops(l, $("#line-stops-wrap"));
    const hist = h.history || [], labels = hist.map(x => dateLabel(x));
    const s1 = [{ name: t("kpi_vehicles"), values: hist.map(x => x.vehicles), color: "#4f8a8a", step: true }];
    if (carriesPax(l)) s1.push({ name: t("th_onboard"), values: hist.map(x => x.persons_on_line), axis: "right", color: "#58a6ff", area: true });
    Charts.lineChart($("#chart-line-1"), s1, labels, { rightAxis: carriesPax(l), zeroBase: true, ...tsOpts(hist, "line") });
    const s2 = [];
    if (carriesPax(l)) s2.push({ name: t("th_pax_unhappy"), values: hist.map(x => x.pax_total ? pct(x.pax_bad, x.pax_total) : null), color: "#d62560", unit: "%" });
    if (carriesCargo(l)) s2.push({ name: t("th_cargo_late"), values: hist.map(x => x.cargo_total ? pct(x.cargo_bad, x.cargo_total) : null), color: "#e8b04b", unit: "%" });
    Charts.lineChart($("#chart-line-2"), s2, labels, { percent: true, ...tsOpts(hist, "line") });
    $("#line-on-map").addEventListener("click", () => { map.lineFilter = id; showTab("map"); });
    bindActions(el);
  }

  // ------------------------------------------------------------ line: stops editor + bulk actions
  const LOAD_MODE_ICON = ["load_available", "load_full_any", "load_full_all"];
  const waitLabel = (v) => v == null ? "–" : v < 0 ? t("wait_unlimited") : t("wait_s", { n: Math.round(v) });
  const lineBulkBtns = (l, nveh) => {
    const off = !cmd.enabled || cmd.accepted === 0 || !nveh;
    const b = (name, icon, label, extra = "", confirmMsg = "") => `<button class="btn act ${extra}" data-cmd="${name}" data-veh="${l.line_id}" ${confirmMsg ? `data-confirm="${esc(confirmMsg)}"` : ""} ${off ? "disabled" : ""}>${ico(icon, "sm")}${esc(label)}</button>`;
    return b("line_stop_all", "stop", t("line_stop_all"), "danger", t("confirm_stop_all", { n: nveh })) + b("line_start_all", "play_1", t("line_start_all")) + b("line_all_to_depot", "to_depot", t("line_all_to_depot"), "danger", t("confirm_all_depot", { n: nveh }));
  };
  // Terminals of a stop (same data as the game's "Terminals for Stop N" panel). key "s:t" = station:terminal (0-based).
  const termKey = (x) => `${x.station}:${x.terminal}`;
  const termUsage = (st) => { const alts = new Set((st.alternatives || []).map(termKey)); const main = termKey(st); return { main, alts }; };
  const termTypeLabel = (tm) => tm.pax && tm.cargo ? t("term_both") : tm.pax ? t("term_pax") : tm.class_name ? tm.class_name : t("term_cargo");
  const termChip = (tm) => {
    const c = tm.class_color;
    const style = c ? `background:${rgb(c.x, c.y, c.z)};border-color:${rgb(c.x, c.y, c.z)};color:${(0.299 * c.x + 0.587 * c.y + 0.114 * c.z) > 0.6 ? "#111" : "#fff"}` : "";
    const icon = tm.pax ? cargoIcon({ cargo: "Passengers", cargo_key: "passengers" }) : (tm.class && tm.class !== "UNIVERSAL" ? `<i class="ico sm" style="--ico:url(icons/cargo_class/${esc(String(tm.class).toLowerCase())}.png)"></i>` : ico("cargo", "sm"));
    return `<span class="chip tchip" style="${style}">${icon}${esc(termTypeLabel(tm))}</span>`;
  };
  const termMod = (tm) => {
    if (!tm.compatible && tm.compatible != null) return `<span class="warn" title="${esc(t("term_incompatible"))}">${t("term_incompatible")}</span>`;
    if (tm.speed_mod == null) return "";
    const p = Math.round((tm.speed_mod - 1) * 100); if (!p) return "";
    return `<span class="${p > 0 ? "info" : "bad"}">${p > 0 ? "+" : "−"}${Math.abs(p)} %</span>`;
  };
  // edit block: one row per terminal: [n] type-chip  ±%  length  [x] enabled  (★) preferred
  const termGrid = (st) => {
    const terms = st.terminals || []; if (!terms.length) return "";
    const { main, alts } = termUsage(st);
    return `<div class="termgrid" data-stop="${st.stop_index}"><div class="tg-title">${ico("terminal", "sm")}${t("terminals")}</div>${terms.map(tm => {
      const k = termKey(tm), isMain = k === main, on = isMain || alts.has(k);
      return `<div class="tg-row ${on ? "on" : ""} ${isMain ? "main" : ""}" data-k="${k}">
        <span class="tg-n">${tm.n}</span><span class="tg-type">${termChip(tm)}${tm.overlength ? ico("warning", "sm", t("term_too_short")) : ""}</span>
        <span class="tg-mod">${termMod(tm)}</span><span class="tg-len">${tm.length ? Math.round(tm.length) + " m" : ""}</span>
        <input type="checkbox" class="tg-on" ${on ? "checked" : ""} title="${esc(on ? t("cargo_allowed") : t("cargo_blocked"))}">
        <button type="button" class="tg-star ${isMain ? "on" : ""}" title="${esc(t("term_main"))}">${ico(isMain ? "star" : "star_outline", "sm")}</button></div>`; }).join("")}</div>`;
  };
  // read the grid back -> { main: {station, terminal}, alternatives: [...] } or null when unchanged
  const termCollect = (tr, st) => {
    const grid = $(".termgrid", tr); if (!grid) return null;
    const rows = $$(".tg-row", grid); const mainRow = rows.find(r => $(".tg-star", r).classList.contains("on")); if (!mainRow) return null;
    const parse = (k) => { const [a, b] = k.split(":").map(Number); return { station: a, terminal: b }; };
    const main = parse(mainRow.dataset.k);
    const alternatives = rows.filter(r => r !== mainRow && $(".tg-on", r).checked).map(r => parse(r.dataset.k));
    const before = termUsage(st);
    const same = termKey(main) === before.main && alternatives.length === before.alts.size && alternatives.every(a => before.alts.has(termKey(a)));
    return same ? null : { main, alternatives };
  };
  const bindTermGrid = (root) => {
    $$(".termgrid", root).forEach(grid => {
      const rows = () => $$(".tg-row", grid);
      const setMain = (row) => { rows().forEach(r => { const on = r === row; $(".tg-star", r).classList.toggle("on", on); $(".tg-star .ico", r).style.setProperty("--ico", `url(${ICON_URL(on ? "star" : "star_outline")})`); r.classList.toggle("main", on); if (on) { $(".tg-on", r).checked = true; r.classList.add("on"); } }); };
      $$(".tg-star", grid).forEach(b => b.addEventListener("click", e => { e.stopPropagation(); setMain(b.closest(".tg-row")); }));
      $$(".tg-on", grid).forEach(cb => cb.addEventListener("change", () => {
        const row = cb.closest(".tg-row");
        if (!cb.checked) {
          const others = rows().filter(r => r !== row && $(".tg-on", r).checked);
          if (!others.length) { cb.checked = true; $("#cmd-status").textContent = t("term_keep_one"); return; }
          if (row.classList.contains("main")) setMain(others[0]);
        }
        row.classList.toggle("on", cb.checked);
      }));
    });
  };
  // Stops table of the selected line. View mode shows the departure configuration; "Edit" turns one row into a
  // form; "Apply" sends line_set_stop with only the changed fields (the mod rewrites the whole line component).
  function renderStops(l, root) {
    const stops = l.stop_list || []; if (!root) return;
    if (!stops.length) { root.innerHTML = `<p class="muted">${t("unknown_stops")}</p>`; return; }
    const off = !cmd.enabled || cmd.accepted === 0;
    const cts = state.cache.cargoTypes || [];
    // cargo relevant for this line: what it carries now + anything already filtered
    const lineCargo = new Set(l.capacities.map(c => c.cargo_id));
    const relevant = cts.filter(c => lineCargo.has(c.cargo_id));
    const editing = state.editStop && state.editStop.line === l.line_id ? state.editStop.stop : null;
    // Cargo chips of a stop = what the vehicles may load there. no_load empty = the game allows everything, so show
    // what the line actually carries; otherwise the exact game filter (all cargo types minus no_load). Blocked cargo
    // is simply not shown. Click -> picker modal listing every cargo type.
    const cargoCell = (st, limit = 5) => {
      const blocked = new Set(st.no_load || []);
      let allowed = blocked.size ? cts.filter(c => !blocked.has(c.cargo_id)) : relevant;
      // keep what the line carries first, then the rest; cap the row at `limit` chips + "+N"
      allowed = [...allowed.filter(c => lineCargo.has(c.cargo_id)), ...allowed.filter(c => !lineCargo.has(c.cargo_id))];
      const extra = allowed.length > limit ? allowed.slice(limit) : [];
      if (extra.length) allowed = allowed.slice(0, limit);
      const maxl = new Map((st.max_load || []).map(m => [m.cargo_type, m.max]));
      const chips = (allowed.length ? allowed.map(c => `<span class="chip" title="${esc(c.name)}${maxl.has(c.cargo_id) ? ` <= ${Math.round(maxl.get(c.cargo_id) * 100)} %` : ""}">${cargoIcon({ cargo: c.name, cargo_key: c.key })}${maxl.has(c.cargo_id) ? `<small>&le;${Math.round(maxl.get(c.cargo_id) * 100)}%</small>` : ""}</span>`).join("")
        : `<span class="chip muted">${t("no_cargo")}</span>`) + (extra.length ? `<span class="chip more" title="${esc(extra.map(c => c.name).join(", "))}">+${extra.length}</span>` : "");
      return `<button class="cargo-pick" data-stop="${st.stop_index}" title="${esc(t("pick_cargo"))}" ${off ? "disabled" : ""}>${chips}${off ? "" : ico("plus", "sm")}</button>`;
    };
    const waits = (st) => `<span title="${esc(t("th_min_wait"))}">${waitLabel(st.min_wait)}</span> / <span title="${esc(t("th_max_wait"))}">${waitLabel(st.max_wait)}</span>${st.max_add_wait ? ` <small class="muted" title="${esc(t("th_add_wait"))}">+${waitLabel(st.max_add_wait)}</small>` : ""}`;
    // one compact line per stop: # | name | cargo | terminals (badges: ★ preferred, others = alternatives) | mode | waits | edit
    const termBadges = (st) => {
      const terms = st.terminals || []; if (!terms.length) return '<span class="muted">–</span>';
      const { main, alts } = termUsage(st);
      return `<span class="termbadges">${terms.filter(x => termKey(x) === main || alts.has(termKey(x))).map(x => {
        const isMain = termKey(x) === main, bad = x.compatible === false, short = !!x.overlength;
        const tip = `${t("term_summary", { main: x.n })} · ${isMain ? t("term_main") : t("term_alt")}${bad ? " · " + t("term_incompatible") : ""}${short ? " · " + t("term_too_short") : ""}`;
        return `<span class="tg-n ${isMain ? "main" : "alt"} ${bad || short ? "warn" : ""}" title="${esc(tip)}">${x.n}${isMain ? ico("star", "sm") : ""}</span>`; }).join("")}</span>`;
    };
    const viewRow = (st) => `<tr data-stop="${st.stop_index}">
        <td class="num muted">${st.stop_index}</td>
        <td class="wrap">${esc(st.name || "?")}${st.waypoints ? ` <small class="muted" title="${esc(t("waypoints_n", { n: st.waypoints }))}">(+${st.waypoints})</small>` : ""}</td>
        <td class="nowrap">${cargoCell(st)}${st.force_unload ? ` <span class="chip bad" title="${esc(t("force_unload"))}">${ico("line_unload", "sm")}</span>` : ""}</td>
        <td class="nowrap">${termBadges(st)}</td>
        <td class="center">${st.load_mode == null ? "–" : ico(LOAD_MODE_ICON[st.load_mode] || "load_available", "sm", t("load_mode_" + st.load_mode))}</td>
        <td class="num nowrap">${waits(st)}</td>
        <td class="act"><button class="btn iconbtn stop-edit" data-stop="${st.stop_index}" title="${esc(t("edit"))}" ${off ? "disabled" : ""}>${ico("edit", "sm")}</button></td></tr>`;
    const editRow = (st) => {
      const w = (k, v, min) => `<input type="number" class="stop-in" data-k="${k}" min="${min}" max="600" step="5" value="${v == null ? "" : Math.round(v)}" style="width:62px">`;
      return `<tr class="editing" data-stop="${st.stop_index}"><td colspan="7"><div class="stopedit">
        <div><small>${st.stop_index}.</small> <b>${esc(st.name || "?")}</b>
          <div class="stopcargo">${cargoCell(st, Infinity)}</div>
          <label class="muted" style="font-size:12px"><input type="checkbox" class="stop-in" data-k="force_unload" ${st.force_unload ? "checked" : ""}> ${t("force_unload")}</label></div>
        <div class="waitgrid"><label>${t("th_load_mode")}</label><select class="stop-in" data-k="load_mode">${[0, 1, 2].map(m => `<option value="${m}" ${st.load_mode === m ? "selected" : ""}>${t("load_mode_" + m)}</option>`).join("")}</select>
          <label>${t("th_min_wait")}</label>${w("min_wait", st.min_wait, 0)}<label>${t("th_max_wait")}</label>${w("max_wait", st.max_wait, -1)}<label>${t("th_add_wait")}</label>${w("max_add_wait", st.max_add_wait, 0)}<span></span><small class="muted">-1 = ${t("wait_unlimited")}</small></div>
        ${termGrid(st)}
        <div class="stopbtns"><button class="btn stop-apply" data-stop="${st.stop_index}">${ico("check", "sm")}${t("apply")}</button><button class="btn stop-apply-all" data-stop="${st.stop_index}" title="${esc(t("apply_all_stops"))}">${ico("line_stations", "sm")}${t("apply_all_stops")}</button><button class="btn stop-cancel">${t("cancel")}</button></div>
      </div></td></tr>`;
    };
    root.innerHTML = `${cmdHint()}<table class="data stops"><thead><tr><th class="num">#</th><th>${t("th_stop")}</th><th>${t("th_cargo_filter")}</th><th>${t("terminals")}</th><th class="center">${t("th_load_mode")}</th><th class="num" title="${esc(t("th_min_wait"))} / ${esc(t("th_max_wait"))}">${t("th_wait_short")}</th><th class="act"></th></tr></thead>
      <tbody>${stops.map(st => (editing === st.stop_index ? editRow(st) : viewRow(st))).join("")}</tbody></table>`;
    $$(".stop-edit", root).forEach(b => b.addEventListener("click", e => { e.stopPropagation(); state.editStop = { line: l.line_id, stop: +b.dataset.stop }; renderStops(l, root); }));
    $$(".stop-cancel", root).forEach(b => b.addEventListener("click", e => { e.stopPropagation(); state.editStop = null; renderStops(l, root); }));
    bindTermGrid(root);
    $$(".cargo-pick", root).forEach(b => b.addEventListener("click", e => { e.stopPropagation(); const st = stops.find(x => x.stop_index === +b.dataset.stop); openCargoPicker(l, st, () => renderStops(l, root)); }));
    const collect = (tr, st) => {
      const args = {};
      $$(".stop-in", tr).forEach(i => {
        const k = i.dataset.k;
        if (i.type === "checkbox") { if ((i.checked ? 1 : 0) !== (st[k] ? 1 : 0)) args[k] = i.checked; return; }
        if (i.value === "") return;
        const v = +i.value; if (Number.isNaN(v)) return;
        if (st[k] == null || Math.round(st[k]) !== v) args[k] = v;
      });
      return args;
    };
    $$(".stop-apply", root).forEach(b => b.addEventListener("click", async e => {
      e.stopPropagation(); const tr = b.closest("tr"); const st = stops.find(x => x.stop_index === +b.dataset.stop);
      const args = collect(tr, st); const terms = termCollect(tr, st);
      if (!Object.keys(args).length && !terms) { $("#cmd-status").textContent = t("nothing_changed"); return; }
      let ok = true;
      if (Object.keys(args).length) ok = await sendCmd("line_set_stop", { line: l.line_id, stop: st.stop_index, ...args }, b);
      if (ok && terms) ok = await sendCmd("line_set_terminals", { line: l.line_id, stop: st.stop_index, main: terms.main, alternatives: terms.alternatives }, b);
      if (ok) { state.editStop = null; Object.assign(st, args); if (terms) { st.station = terms.main.station; st.terminal = terms.main.terminal; st.alternatives = terms.alternatives; } renderStops(l, root); }
    }));
    $$(".stop-apply-all", root).forEach(b => b.addEventListener("click", async e => {
      e.stopPropagation(); const tr = b.closest("tr"); const st = stops.find(x => x.stop_index === +b.dataset.stop);
      const all = collect(tr, st); const args = {};
      ["load_mode", "min_wait", "max_wait", "max_add_wait"].forEach(k => { const v = $$(".stop-in", tr).find(i => i.dataset.k === k); if (v && v.value !== "") args[k] = +v.value; });
      if (!Object.keys(args).length) { $("#cmd-status").textContent = t("nothing_changed"); return; }
      if (await sendCmd("line_set_all_stops", { line: l.line_id, ...args }, b)) { state.editStop = null; stops.forEach(x => Object.assign(x, args)); renderStops(l, root); }
    }));
  }

  // Cargo picker modal: every cargo type of the game as a tile (passengers first); the selection = cargo the vehicles
  // may load at this stop. Closing with OK / Escape / click outside sends line_set_stop { no_load } right away when the
  // selection changed (the mod sets customFilters and rewrites the stop's load[] array). Cancel discards.
  function openCargoPicker(l, st, onDone) {
    const cts = (state.cache.cargoTypes || []).slice().sort((a, b) => (a.cargo_id === 0 ? -1 : b.cargo_id === 0 ? 1 : a.name.localeCompare(b.name, loc())));
    if (!cts.length) return;
    const before = new Set(st.no_load || []);
    const sel = new Set(cts.filter(c => !before.has(c.cargo_id)).map(c => c.cargo_id));
    let dlg = $("#cargo-picker");
    if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "cargo-picker"; document.body.appendChild(dlg); }
    const render = () => {
      dlg.innerHTML = `<div class="cp-head"><b>${t("pick_cargo")}</b> <span class="muted">${st.stop_index}. ${esc(st.name || "?")}</span><button class="btn iconbtn cp-x" title="${esc(t("cancel"))}">${ico("close", "sm")}</button></div>
        <div class="cp-grid">${cts.map(c => `<button class="cp-tile ${sel.has(c.cargo_id) ? "on" : ""}" data-ct="${c.cargo_id}" title="${esc(cargoName(c.name))}">${cargoIcon({ cargo: c.name, cargo_key: c.key }, "lg")}<span>${esc(cargoName(c.name))}</span></button>`).join("")}</div>
        <div class="cp-foot"><button class="btn cp-all">${t("all")}</button><button class="btn cp-none">${t("none")}</button><span class="muted cp-count">${t("n_selected", { n: sel.size })}</span><button class="btn cp-cancel">${t("cancel")}</button><button class="btn primary cp-ok">${ico("check", "sm")}OK</button></div>`;
      $$(".cp-tile", dlg).forEach(b => b.addEventListener("click", () => { const id = +b.dataset.ct; if (sel.has(id)) sel.delete(id); else sel.add(id); b.classList.toggle("on", sel.has(id)); $(".cp-count", dlg).textContent = t("n_selected", { n: sel.size }); }));
      $(".cp-all", dlg).addEventListener("click", () => { cts.forEach(c => sel.add(c.cargo_id)); render(); });
      $(".cp-none", dlg).addEventListener("click", () => { sel.clear(); render(); });
      $(".cp-cancel", dlg).addEventListener("click", () => dlg.close("cancel"));
      $(".cp-x", dlg).addEventListener("click", () => dlg.close("cancel"));
      $(".cp-ok", dlg).addEventListener("click", () => dlg.close("ok"));
    };
    render();
    dlg.onclick = (e) => { if (e.target === dlg) dlg.close("ok"); };  // click on the backdrop = apply
    dlg.oncancel = (e) => { e.preventDefault(); dlg.close("ok"); };    // Escape = apply (closing applies, Cancel discards)
    dlg.onclose = async () => {
      if (dlg.returnValue === "cancel") return;
      const no = cts.filter(c => !sel.has(c.cargo_id)).map(c => c.cargo_id).sort((a, b) => a - b);
      const old = [...before].sort((a, b) => a - b);
      if (JSON.stringify(no) === JSON.stringify(old)) return;
      if (await sendCmd("line_set_stop", { line: l.line_id, stop: st.stop_index, no_load: no })) { st.no_load = no; if (onDone) onDone(); }
    };
    dlg.showModal();
  }

  // ------------------------------------------------------------ towns
  async function renderTowns() {
    const d = await api("/api/towns"); const towns = d.towns || []; state.cache.towns = towns;
    const unhappy = (x) => (x.hap_inside_unhappy || 0) + (x.hap_to_res_unhappy || 0) + (x.hap_from_res_unhappy || 0) + (x.hap_to_nonres_unhappy || 0) + (x.hap_from_nonres_unhappy || 0);
    const total = (x) => (x.hap_inside_total || 0) + (x.hap_to_res_total || 0) + (x.hap_from_res_total || 0) + (x.hap_to_nonres_total || 0) + (x.hap_from_nonres_total || 0);
    const cols = [
      { key: "name", label: t("th_town"), icon: "town" },
      { key: "size", label: t("th_capacity"), num: true, render: x => int((x.cap_res || 0) + (x.cap_com || 0) + (x.cap_ind || 0)), sortValue: x => (x.cap_res || 0) + (x.cap_com || 0) + (x.cap_ind || 0) },
      { key: "res", label: t("th_res"), num: true, render: x => `${int(x.used_res)}/${int(x.cap_res)}`, sortValue: x => x.cap_res },
      { key: "com", label: t("th_com"), num: true, render: x => `${int(x.used_com)}/${int(x.cap_com)}`, sortValue: x => x.cap_com },
      { key: "ind", label: t("th_ind"), num: true, render: x => `${int(x.used_ind)}/${int(x.cap_ind)}`, sortValue: x => x.cap_ind },
      { key: "hap", label: t("th_unhappy_travellers"), icon: "unhappy", render: x => barQuality(unhappy(x), total(x)), sortValue: x => total(x) ? unhappy(x) / total(x) : null },
      { key: "line_usage", label: t("th_public_transport"), icon: "line", num: true, render: x => x.line_usage == null ? "–" : bar(x.line_usage, 1, "ok") },
      { key: "traffic_speed", label: t("th_traffic"), icon: "veh_car", num: true, render: x => x.traffic_speed == null ? "–" : kmh(x.traffic_speed) },
      { key: "noise_db", label: t("th_noise"), icon: "noise", num: true, render: x => x.noise_db == null ? "–" : num(x.noise_db, 0) + " dB" },
      { key: "stations", label: t("th_stations"), icon: "station", num: true },
      { key: "development_active", label: t("th_growth"), icon: "town_growth", render: x => x.development_active ? `<span class="chip ok">${t("growth_active")}</span>` : `<span class="chip warn">${t("growth_frozen")}</span>` },
      { key: "act", label: "", render: x => entBtns(x.town_id) },
    ];
    if (!state.selTown) { const u = +new URLSearchParams(location.search).get("town"); if (u && towns.some(x => x.town_id === u)) state.selTown = u; }  // deep link ?tab=towns&town=<id>
    renderTable($("#towns-table"), cols, towns, { id: "town_id", defaultSort: "size", defaultAsc: false, onRow: (id, tr) => { state.selTown = +id; $$("tr", tr.parentElement).forEach(x => x.classList.toggle("sel", x === tr)); renderTownDetail(+id); }, rowClass: x => (x.town_id === state.selTown ? "sel" : "") });
    if (state.selTown) renderTownDetail(state.selTown);
  }

  async function renderTownDetail(id) {
    const tw = (state.cache.towns || []).find(x => x.town_id === id); if (!tw) return;
    const h = await api("/api/town_history", { id, limit: settings.history, range: settings.range });
    const hap = [[t("hap_inside"), tw.hap_inside_unhappy, tw.hap_inside_total], [t("hap_res_out"), tw.hap_from_res_unhappy, tw.hap_from_res_total], [t("hap_res_in"), tw.hap_to_res_unhappy, tw.hap_to_res_total], [t("hap_visitors"), (tw.hap_to_nonres_unhappy || 0) + (tw.hap_from_nonres_unhappy || 0), (tw.hap_to_nonres_total || 0) + (tw.hap_from_nonres_total || 0)], [t("hap_car"), tw.hap_car_unhappy, tw.hap_car_total], [t("hap_walk"), tw.hap_walk_unhappy, tw.hap_walk_total]];
    $("#town-detail").innerHTML = `<h2>${ico("town", "lg")}${esc(tw.name)} <small>#${tw.town_id} · ${tw.area_km2 != null ? num(tw.area_km2, 2) + " km²" : ""}</small></h2>
      <div class="actions"><button class="btn act" data-cmd="focus_entity" data-veh="${tw.town_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("camera", "sm")}${t("act_focus")}</button><button class="btn act" data-cmd="select_entity" data-veh="${tw.town_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("select", "sm")}${t("act_select")}</button></div>
      <table class="kv">${hap.map(([k, b, tot]) => `<tr><td>${k}</td><td>${barQuality(b || 0, tot || 0)}</td></tr>`).join("")}</table>
      <p class="muted" style="font-size:12px">${t("reach", { a: tw.reach_com_private ?? "–", b: tw.reach_com_public ?? "–", c: tw.reach_ind_private ?? "–", d: tw.reach_ind_public ?? "–" })}</p>
      <h2>${ico("town_supplies")}${t("cargo_needs")}</h2>
      <table class="kv">${tw.cargo.length ? tw.cargo.map(c => {
        // Game window figure ("supplied / needed", mod schema 3+) when available, otherwise the warehouse stock.
        const game = c.needed != null && c.needed > 0, a = game ? c.supplied : c.stock, b = game ? c.needed : c.capacity, p = pct(a, b);
        return `<tr><td>${cargoIcon(c)}${esc(cargoName(c.cargo))}</td><td title="${game ? t("tip_town_supplied") : t("tip_town_stock")}">${bar(a, b, p < 30 ? "bad" : p < 70 ? "warn" : "ok", `${int(a)} / ${int(b)}`)}${game ? ` <span class="muted" style="font-size:11px">${t("stock_short", { a: int(c.stock), b: int(c.capacity) })}</span>` : ""}</td></tr>`;
      }).join("") : `<tr><td class="muted">${t("none_m")}</td><td></td></tr>`}</table>
      ${tw.top_lines.length ? `<h2>${ico("line")}${t("top_lines")}</h2><table class="kv">${tw.top_lines.map(l => `<tr><td>${esc(l.name || "#" + l.line_id)}</td><td>${barQuality((l.resident_unhappy || 0) + (l.nonresident_unhappy || 0), (l.resident_total || 0) + (l.nonresident_total || 0))}</td></tr>`).join("")}</table>` : ""}
      <h2 style="margin-top:12px">${ico("town_people")}${t("capacities")}</h2><canvas id="chart-town-1" data-h="160"></canvas>
      <h2>${ico("town_happiness")}${t("satisfaction_pt")}</h2><canvas id="chart-town-2" data-h="150"></canvas>`;
    bindActions($("#town-detail"));
    const hist = h.history || [], labels = hist.map(x => dateLabel(x));
    Charts.lineChart($("#chart-town-1"), [{ name: t("residential"), values: hist.map(x => x.cap_res), color: "#4f8a8a" }, { name: t("commercial"), values: hist.map(x => x.cap_com), color: "#e8b04b" }, { name: t("industrial"), values: hist.map(x => x.cap_ind), color: "#bc8cff" }], labels, { stacked: true, ...tsOpts(hist, "town") });
    Charts.lineChart($("#chart-town-2"), [{ name: t("unhappy_town"), values: hist.map(x => x.hap_inside_total ? pct(x.hap_inside_unhappy, x.hap_inside_total) : null), color: "#d62560", unit: "%" }, { name: t("pt_share"), values: hist.map(x => x.line_usage != null ? x.line_usage * 100 : null), color: "#3fb950", unit: "%" }], labels, { percent: true, ...tsOpts(hist, "town") });
  }

  // ------------------------------------------------------------ industries
  async function renderIndustries() {
    const d = await api("/api/industries"); const inds = d.industries || [];
    const q = $("#ind-filter").value.toLowerCase(), only = $("#ind-unserved").checked;
    const rows = inds.filter(i => (!q || (i.name || "").toLowerCase().includes(q) || (i.construction || "").toLowerCase().includes(q)) && (!only || !i.producing || i.closure_time > 0 || i.cargo.some(c => c.direction === "out" && !c.shipped_year)));
    // one line per industry: the 4 first columns stay pinned on the left, inputs / outputs flow inline after them
    const cargoCell = (i, dir) => i.cargo.filter(c => c.direction === dir).map(c => {
      const a = dir === "out" ? c.produced_year : c.consumed_year, m = dir === "out" ? c.max_prod_year : c.max_cons_year;
      const shipped = dir === "out" ? c.shipped_year : c.delivered_year;
      return `<span class="indcargo">${cargoChip(c)}${bar(a || 0, m || 0, "", `${int(a)}/${int(m)}`)}<small class="muted" title="${esc(dir === "out" ? t("shipped") : t("delivered"))}">${ico(dir === "out" ? "cargo_supplied" : "cargo_received", "sm")}${int(shipped)}</small></span>`;
    }).join("") || '<span class="muted">–</span>';
    const cols = [
      { key: "name", label: t("th_industry"), icon: "industry", sticky: true, render: i => `${esc(i.name)} <small class="muted">${esc((i.construction || "").replace(/^.*\//, "").replace(/\.con$/, ""))}</small>` },
      // Industry.upgradeProgress is always 0 in TF3 (TF2 leftover, unused by the game's own GUI): show level / max instead
      { key: "level", label: t("th_level"), num: true, sticky: true, render: i => i.max_level > 0 ? `${i.level ?? "–"}/${i.max_level} ${bar(i.level || 0, i.max_level, i.level >= i.max_level ? "ok" : "")}` : `${i.level ?? "–"}`, sortValue: i => i.max_level > 0 ? (i.level || 0) / i.max_level : -1 },
      { key: "status", label: t("th_status"), sticky: true, render: i => [i.producing ? `<span class="chip ok">${t("producing")}</span>` : `<span class="chip bad">${t("halted")}</span>`, i.closure_time > 0 ? `<span class="chip bad">${t("closing")}</span>` : "", i.boost_rule || i.boost_persons ? `<span class="chip info">${t("boost")}</span>` : "", i.manual ? `<span class="chip warn">${t("manual")}</span>` : "", i.thrown_away ? `<span class="chip warn">${t("thrown", { n: i.thrown_away })}</span>` : ""].join(""), sortValue: i => (i.producing ? 0 : 2) + (i.closure_time > 0 ? 1 : 0) },
      { key: "production_rating", label: t("th_yield"), icon: "production", num: true, sticky: true, render: i => i.production_rating == null ? "–" : bar(i.production_rating, 1, i.production_rating < 0.3 ? "bad" : i.production_rating < 0.7 ? "warn" : "ok") },
      { key: "in", label: t("th_inputs"), icon: "cargo_received", render: i => cargoCell(i, "in") },
      { key: "out", label: t("th_outputs"), icon: "cargo_supplied", render: i => cargoCell(i, "out") },
      { key: "act", label: "", render: i => entBtns(i.industry_id) },
    ];
    renderTable($("#ind-table"), cols, rows, { defaultSort: "name" });
  }

  // ------------------------------------------------------------ supply chains
  // A chain = a named set of lines (+ cargo legs switched off). The server (chains.py) finds which industries /
  // warehouses each stop serves, the cargo legs between them and their flows; this tab shows them like the game's
  // line window and lets the player build, save and delete chains. The working selection is kept in the browser.
  const chainState = (() => {
    const d = { mode: "chain", id: null, name: "", lines: [], disabled: [], dirty: false, open: [] };
    try { return Object.assign(d, JSON.parse(localStorage.getItem("tf3.chain") || "{}")); } catch (e) { return d; }
  })();
  const saveChainState = () => { try { localStorage.setItem("tf3.chain", JSON.stringify(chainState)); } catch (e) { /* private window */ } };
  const chainMsg = (txt, cls = "") => { const el = $("#chain-msg"); el.textContent = txt || ""; el.className = "small " + (cls || "muted"); };
  async function postChain(body) {
    const r = await fetch("/api/chains", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); if (!j.ok) throw new Error(j.error || r.status); return j;
  }
  function chainEdit(fn) { fn(); chainState.dirty = chainState.id != null; saveChainState(); refresh(); }
  $$("#chain-mode button").forEach(b => b.addEventListener("click", () => { chainState.mode = b.dataset.mode; saveChainState(); refresh(); }));
  $("#chain-add").addEventListener("change", e => {
    const id = +e.target.value; e.target.value = "";
    if (id && !chainState.lines.includes(id)) chainEdit(() => { chainState.lines.push(id); chainState.mode = "chain"; });
  });
  $("#chain-connected").addEventListener("click", async () => {
    if (!chainState.lines.length) { chainMsg(t("chain_pick_first"), "warn"); return; }
    const d = await api("/api/chain_connected", { lines: chainState.lines.join(",") });
    const added = (d.lines || []).filter(id => !chainState.lines.includes(id));
    chainEdit(() => { chainState.lines.push(...added); chainState.mode = "chain"; });
    chainMsg(t("chain_connected_added", { n: added.length }), added.length ? "ok" : "muted");
  });
  $("#chain-clear").addEventListener("click", () => { Object.assign(chainState, { id: null, name: "", lines: [], disabled: [], dirty: false, open: [] }); $("#chain-name").value = ""; saveChainState(); chainMsg(""); refresh(); });
  $("#chain-save").addEventListener("click", async () => {
    const name = $("#chain-name").value.trim();
    if (!name) { chainMsg(t("chain_name_required"), "warn"); $("#chain-name").focus(); return; }
    if (!chainState.lines.length) { chainMsg(t("chain_pick_first"), "warn"); return; }
    try {
      // same id + same name = update; another name = save as a new chain (or replace the one with that name)
      const j = await postChain({ name, lines: chainState.lines, disabled: chainState.disabled, id: chainState.name === name ? chainState.id : null });
      Object.assign(chainState, { id: j.chain.id, name: j.chain.name, dirty: false }); saveChainState();
      chainMsg(t("chain_saved_ok"), "ok"); refresh();
    } catch (e) { chainMsg(t("act_failed", { msg: e.message }), "bad"); }
  });
  function openChain(c) {
    Object.assign(chainState, { mode: "chain", id: c.id, name: c.name, lines: (c.lines || []).slice(), disabled: (c.disabled || []).slice(), dirty: false, open: [] });
    $("#chain-name").value = c.name; saveChainState(); chainMsg(""); refresh();
  }
  const nodeName = (n) => n.kind === "warehouse" ? t("chain_warehouse", { station: n.station_name || "?" }) : (n.name || "#" + n.id);
  const perYear = (n) => int(n);
  const chainStatus = (l) => {
    if (l.status === "none") return `<span class="cst bad">${ico("warning", "sm")}${t("chain_st_none")}</span>`;
    if (l.status === "short") return `<span class="cst bad">${ico("warning", "sm")}${t("chain_st_short", { n: l.vehicles })}</span>`;
    if (l.status === "ok") return `<span class="cst ok">${ico("check", "sm")}${t("chain_st_ok", { n: l.vehicles })}</span>`;
    return `<span class="cst">${t("chain_st_unknown", { n: l.vehicles })}</span>`;
  };
  function chainLineCard(l, mode) {
    const open = chainState.open.includes(l.line_id);
    const carried = l.capacities.filter(c => c.need > 0 || c.capacity > 0);
    const p = l.need ? pct(l.moved, l.need) : 0;
    const flowBar = l.need > 0 ? `<div class="cflow">${bar(l.moved, l.need, p >= 80 ? "ok" : p >= 50 ? "warn" : "bad", t("chain_moved", { a: perYear(l.moved), b: perYear(l.need) }))}</div>` : "";
    const head = `<div class="chead" data-line="${l.line_id}">
        <button class="chev" title="${esc(t("detail"))}">${open ? "▾" : "▸"}</button>
        <span class="swatch" style="background:${rgb(l.color_r, l.color_g, l.color_b)}"></span>${carried.map(c => cargoIcon(c)).join("")}
        <b class="cname">${esc(l.name)}</b>
        ${mode === "chain" ? `<button class="btn iconbtn cremove" title="${esc(t("chain_remove"))}">${ico("close", "sm")}</button>` : (chainState.lines.includes(l.line_id) ? "" : `<button class="btn iconbtn cadd" title="${esc(t("chain_add_sel"))}">${ico("plus", "sm")}</button>`)}
        <span class="cright">${flowBar}</span>
      </div>
      <div class="csub">${chainStatus(l)}${l.load ? ` · <span class="muted">${t("chain_load", { n: Math.round(l.load * 100) })}</span>` : ""}
        ${carried.filter(c => c.need > 0).map(c => `<span class="cneed">${cargoIcon(c)}${perYear(c.need)}/${t("per_year_short")}</span>`).join("")}</div>`;
    if (!open) return `<div class="cline">${head}</div>`;
    const stops = `<div class="cbox"><div class="ctitle">${t("chain_stops")}</div>${l.stops.map(s => `<div class="cstop"><span class="cnum" style="background:${rgb(l.color_r, l.color_g, l.color_b)}">${s.stop_index}</span><span>${esc(s.name || "?")}</span>
        ${s.loads.length ? `<span class="muted">${t("chain_loads")}</span> ${s.loads.map(c => cargoChip(c)).join("")}` : ""}
        ${s.unloads.length ? `<span class="muted">${t("chain_unloads")}</span> ${s.unloads.map(c => cargoChip(c)).join("")}` : ""}
        ${s.nodes.length ? `<small class="muted">· ${s.nodes.map(n => esc(nodeName(n))).join(", ")}</small>` : ""}</div>`).join("")}</div>`;
    const legs = l.legs.length ? `<div class="cbox"><div class="ctitle">${t("chain_cargo_legs")}</div><div class="muted small">${t("chain_legs_hint")}</div>${l.legs.map(g => `<div class="cleg ${g.enabled ? "" : "off"}">
        <button class="btn legtoggle ${g.enabled ? "on" : ""}" data-leg="${esc(g.key)}" ${mode === "all" ? "disabled" : ""}>${t(g.enabled ? "chain_leg_on" : "chain_leg_off")}</button>
        ${cargoIcon(g.cargo)} ${esc(nodeName(g.source_name))} <span class="muted">›</span> ${g.sink_names.length ? g.sink_names.map(n => esc(nodeName(n))).join(", ") : `<span class="muted">${t("chain_to_stop", { n: g.sink_stop })}</span>`}
        <span class="mono muted">${g.enabled ? t("chain_moved", { a: perYear(g.moved), b: perYear(g.flow) }) : ""}</span></div>`).join("")}</div>` : `<div class="cbox muted">${t("chain_no_legs")}</div>`;
    const caps = l.capacities.length ? `<div class="cbox"><div class="ctitle">${t("kpi_fill")}</div><table class="kv">${l.capacities.map(c => `<tr><td>${cargoIcon(c)}${esc(cargoName(c.cargo))}</td><td>${c.capacity ? bar(c.used, c.capacity, fillCls(pct(c.used, c.capacity)), `${Math.round(c.used)} / ${Math.round(c.capacity)}`) : `<span class="chip bad">${t("chain_no_capacity")}</span>`}</td></tr>`).join("")}</table></div>` : "";
    return `<div class="cline open">${head}<div class="cbody">${stops}${legs}${caps}<div class="actions">${entBtns(l.line_id, { line: true })}<button class="btn gotoline" data-line="${l.line_id}">${ico("line", "sm")}${t("tab_lines")}</button></div></div></div>`;
  }
  function chainNodeCard(n) {
    if (n.kind === "warehouse") {
      return `<div class="cnode"><div class="cnode-h">${ico("stock_full", "sm")}<b>${esc(nodeName(n))}</b></div>${(n.cargo || []).map(c => `<div class="small">${t("chain_wh_ships", { cargo: esc(cargoName(c.cargo)), a: perYear(c.shipped) })}</div>`).join("") || `<div class="muted small">–</div>`}</div>`;
    }
    const u = n.utilization || 0;
    const flags = [n.producing === 0 ? `<span class="chip bad">${t("halted")}</span>` : "", n.closure_time ? `<span class="chip bad">${t("closing")}</span>` : "", n.boost ? `<span class="chip info">${t("boost")}</span>` : "", n.thrown_away ? `<span class="chip warn">${t("thrown", { n: n.thrown_away })}</span>` : ""].join("");
    return `<div class="cnode"><div class="cnode-h">${ico("industry", "sm")}<b>${esc(nodeName(n))}</b> ${flags}<span class="cright">${entBtns(n.id)}</span></div>
      ${n.outputs.length ? `<div class="cflow wide">${bar(u, 1, u >= 0.8 ? "ok" : u >= PROD_WARN ? "warn" : "bad", t("chain_capacity_pct", { n: Math.round(u * 100) }))}</div>` : ""}
      ${n.limited_by ? `<div class="small warnt">${t("chain_limited", { cargo: esc(cargoName(n.limited_by.cargo)) })}</div>` : ""}
      ${n.inputs.map(c => `<div class="small">${cargoIcon(c)}${t("chain_receives", { cargo: esc(cargoName(c.cargo)), a: perYear(c.rate), b: perYear(c.max) })}</div>`).join("")}
      ${n.outputs.map(c => `<div class="small">${cargoIcon(c)}${t("chain_produces", { cargo: esc(cargoName(c.cargo)), a: perYear(c.rate), b: perYear(c.max) })}</div>`).join("")}</div>`;
  }
  const PROD_WARN = 0.5;
  let chainDeepDone = false;
  async function renderChains() {
    const list = await api("/api/chains");
    $$("#chain-mode button").forEach(b => b.classList.toggle("active", b.dataset.mode === chainState.mode));
    // saved chains
    const saved = list.chains || [];
    // deep link ?tab=chains&chain=<id>|all (applied once)
    const deep = new URLSearchParams(location.search).get("chain");
    if (deep && !chainDeepDone) {
      chainDeepDone = true;
      if (deep === "all") chainState.mode = "all";
      else { const c = saved.find(x => String(x.id) === deep); if (c) { openChain(c); return; } }
    }
    $("#chain-saved").innerHTML = saved.length ? saved.map(c => `<div class="csaved ${c.id === chainState.id ? "sel" : ""}" data-id="${c.id}">
        <b>${esc(c.name)}</b> <span class="muted">${t("chain_n_lines", { n: (c.lines || []).length })}</span>
        ${c.alerts ? `<span class="chip ${c.alerts_bad ? "bad" : "warn"}">${ico("alert", "sm")}${c.alerts}</span>` : `<span class="chip ok">${ico("check", "sm")}</span>`}
        ${c.id === chainState.id && chainState.dirty ? `<span class="chip warn">${t("chain_unsaved")}</span>` : ""}
        <button class="btn iconbtn cdel" title="${esc(t("chain_delete"))}">${ico("close", "sm")}</button></div>`).join("") : `<div class="muted small">${t("chains_none_saved")}</div>`;
    $$("#chain-saved .csaved").forEach(row => row.addEventListener("click", async e => {
      const c = saved.find(x => x.id === +row.dataset.id); if (!c) return;
      if (e.target.closest(".cdel")) {
        if (!(await modal.confirm(t("confirm_chain_delete", { name: c.name }), { title: t("chain_delete"), ok: t("chain_delete"), danger: true }))) return;
        postChain({ action: "delete", id: c.id }).then(() => { if (chainState.id === c.id) Object.assign(chainState, { id: null, dirty: false }); saveChainState(); refresh(); }).catch(err => chainMsg(t("act_failed", { msg: err.message }), "bad"));
        return;
      }
      openChain(c);
    }));
    // line picker: lines with cargo legs first; rebuilt only when the list changes and the picker is not in use
    const sel = $("#chain-add"), all = (list.lines || []).slice().sort((a, b) => (b.legs > 0) - (a.legs > 0) || String(a.name).localeCompare(String(b.name), loc()));
    const sig = i18n.lang + "|" + all.map(l => l.line_id + ":" + l.legs).join(",");
    if (sel.dataset.sig !== sig && document.activeElement !== sel) {
      sel.innerHTML = `<option value="">${esc(t("chain_add_line"))}</option>` + all.map(l => `<option value="${l.line_id}">${esc(l.name)}${l.legs ? "" : " · " + esc(t("chain_no_cargo"))}</option>`).join("");
      sel.dataset.sig = sig;
    }
    if (document.activeElement !== $("#chain-name") && !$("#chain-name").value && chainState.name) $("#chain-name").value = chainState.name;
    // the view
    const view = $("#chain-view");
    const params = chainState.mode === "all" ? { all: 1 } : { lines: chainState.lines.join(","), disabled: chainState.disabled.join(",") };
    if (chainState.mode === "chain" && !chainState.lines.length) { view.innerHTML = (list.has_catchment ? "" : `<div class="cmdhint">${ico("warning", "sm")}<span>${t("chain_need_mod")}</span></div>`) + `<p class="muted">${t("chain_empty")}</p>`; return; }
    const v = await api("/api/chain_view", params);
    const tt = v.totals || {};
    const al = v.alerts || [];
    view.innerHTML = `${v.has_catchment ? "" : `<div class="cmdhint">${ico("warning", "sm")}<span>${t("chain_need_mod")}</span></div>`}
      <h2>${ico(chainState.mode === "all" ? "line" : "cargo_supplied")}${esc(chainState.mode === "all" ? t("chain_mode_all") : (chainState.name || t("chain_mode_chain")))}${chainState.mode === "chain" && chainState.dirty ? ` <span class="chip warn">${t("chain_unsaved")}</span>` : ""}</h2>
      <div class="kpis ckpis">
        <div class="kpi"><div class="k">${t("chain_k_lines")}</div><div class="v">${tt.lines ?? 0}</div></div>
        <div class="kpi"><div class="k">${t("chain_k_cargo")}</div><div class="v">${int(tt.cargo_year)}</div></div>
        <div class="kpi"><div class="k">${t("chain_k_short")}</div><div class="v ${tt.short ? "neg" : ""}">${t("chain_of", { a: tt.short ?? 0, b: tt.lines ?? 0 })}</div></div>
        <div class="kpi"><div class="k">${t("kpi_alerts")}</div><div class="v ${al.length ? "neg" : "pos"}">${al.length}</div></div>
      </div>
      ${al.length ? `<details class="calerts" ${al.length <= 6 ? "open" : ""}><summary>${t("chain_alerts")} (${al.length})</summary><div id="chain-alerts-list" class="alerts"></div></details>` : ""}
      <div class="clines">${(v.lines || []).map(l => chainLineCard(l, chainState.mode)).join("") || `<p class="muted">${t("no_data")}</p>`}</div>
      ${(v.nodes || []).length ? `<details class="cnodes" open><summary>${t("chain_industries")} (${v.nodes.length})</summary>${v.nodes.map(chainNodeCard).join("")}</details>` : ""}`;
    if (al.length) renderAlerts($("#chain-alerts-list"), al.map(a => ({ ...a, chain: true })));
    $$(".chead", view).forEach(h => {
      const id = +h.dataset.line;
      $(".chev", h).addEventListener("click", () => { const i = chainState.open.indexOf(id); if (i >= 0) chainState.open.splice(i, 1); else chainState.open.push(id); saveChainState(); renderChains(); });
      const rm = $(".cremove", h); if (rm) rm.addEventListener("click", () => chainEdit(() => { chainState.lines = chainState.lines.filter(x => x !== id); }));
      const add = $(".cadd", h); if (add) add.addEventListener("click", () => { if (!chainState.lines.includes(id)) { chainState.lines.push(id); chainState.dirty = chainState.id != null; saveChainState(); chainMsg(t("chain_added", { name: $(".cname", h).textContent }), "ok"); renderChains(); } });
    });
    $$(".legtoggle", view).forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.leg;
      if (chainState.mode === "all") return;  // switching legs off belongs to a chain
      chainEdit(() => { chainState.disabled = chainState.disabled.includes(k) ? chainState.disabled.filter(x => x !== k) : chainState.disabled.concat([k]); });
    }));
    $$(".gotoline", view).forEach(b => b.addEventListener("click", () => { state.selLine = +b.dataset.line; showTab("lines"); }));
    bindActions(view);
  }

  // ------------------------------------------------------------ vehicle catalogue
  // Every vehicle the player can buy (catalogue.lua, mod rev 8+), grouped by the year it becomes available: what is
  // new this year, what comes next, what is withdrawn. Past years and wagons are hidden unless asked for.
  const CAT_TYPE = { bus: "Bus", truck: "Truck", tram: "Tram", train: "Train", waggon: "Train", plane: "Aircraft", zeppelin: "Aircraft", helicopter: "Helicopter", ship: "Ship" };
  const CAT_CARRIER = { Bus: "ROAD", Truck: "ROAD", Tram: "TRAM", Train: "RAIL", Aircraft: "AIR", Helicopter: "AIR", Ship: "WATER" };
  const catType = (m) => CAT_TYPE[m.category] || null;
  state.catTypes = new Set();
  function catCard(m, year) {
    const ty = catType(m);
    const isNew = m.year_from === year, gone = m.year_to > 0 && m.year_to < year;
    const chips = [
      isNew ? `<span class="chip ok">${t("cat_new")}</span>` : "",
      m.year_to > 0 && !gone ? `<span class="chip ${m.year_to <= year + 1 ? "warn" : ""}">${t(m.year_to <= year + 1 ? "cat_retiring" : "cat_until", { y: m.year_to })}</span>` : "",
      gone ? `<span class="chip">${t("cat_retired", { y: m.year_to })}</span>` : "",
      m.multiple_unit != null ? `<span class="chip info">${t("cat_mu")}</span>` : "",
      m.in_fleet ? `<span class="chip info">${t("cat_in_fleet", { n: m.in_fleet })}</span>` : "",
    ].join("");
    const stats = [m.speed_ms ? kmh(m.speed_ms) : "", m.capacity ? t("cat_capacity", { n: int(m.capacity) }) : "", m.power_kw ? t("cat_power", { n: int(m.power_kw) }) : "", m.price ? money(m.price) : ""].filter(Boolean);
    const typeLabel = m.category === "waggon" ? t("cat_wagon") : ty ? t("line_type." + ty) : (m.category || "");
    return `<div class="catcard ${isNew ? "new" : ""} ${gone ? "gone" : ""}">
      <div class="catimg">${modelImg({ model_key: m.model_key, model: m.name, carrier: CAT_CARRIER[ty] || "OTHER" })}</div>
      <div class="n">${ty ? `<span class="vehicon" style="color:${LINE_TYPE_COLOR[ty]}">${ico(LINE_TYPE_ICON[ty], "sm", typeLabel)}</span>` : ""}${esc(m.name || m.model_key)}</div>
      <div class="stats"><span>${esc(typeLabel)}</span>${stats.map(x => `<span>${x}</span>`).join("")}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ""}</div>`;
  }
  async function renderCatalogue() {
    const d = await api("/api/catalogue"); const all = d.models || [], year = d.year;
    const el = $("#cat-list");
    if (!all.length) { $("#cat-types").innerHTML = ""; el.innerHTML = `<div class="cmdhint">${ico("warning", "sm")}<span>${t("cat_need_mod")}</span></div>`; return; }
    const wagons = $("#cat-wagons").checked, past = $("#cat-past").checked, q = $("#cat-filter").value.toLowerCase();
    const base = all.filter(m => (wagons || m.category !== "waggon") && (past || year == null || m.year_from >= year));
    renderTypeBar($("#cat-types"), base, catType, state.catTypes, renderCatalogue);
    const shown = base.filter(m => (!state.catTypes.size || state.catTypes.has(catType(m))) && (!q || (m.name || "").toLowerCase().includes(q) || m.model_key.includes(q)));
    const avail = all.filter(m => m.category !== "waggon" && m.year_from <= year && !(m.year_to > 0 && m.year_to < year));
    const kpi = (k, v, cls = "") => `<div class="kpi"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
    const nNew = all.filter(m => m.category !== "waggon" && m.year_from === year).length;
    const nNext = all.filter(m => m.category !== "waggon" && m.year_from > year && m.year_from <= year + 5).length;
    const nOut = all.filter(m => m.category !== "waggon" && m.year_to > 0 && m.year_to >= year && m.year_to <= year + 1).length;
    const byYear = new Map();
    shown.forEach(m => { if (!byYear.has(m.year_from)) byYear.set(m.year_from, []); byYear.get(m.year_from).push(m); });
    const rel = (y) => y === year ? t("cat_this_year") : y > year ? t("cat_in_years", { n: y - year }) : t("cat_years_ago", { n: year - y });
    el.innerHTML = `<div class="kpis ckpis">${kpi(t("cat_k_new"), nNew, nNew ? "pos" : "")}${kpi(t("cat_k_next"), nNext)}${kpi(t("cat_k_retiring"), nOut, nOut ? "neg" : "")}${kpi(t("cat_k_available"), avail.length)}</div>`
      + ([...byYear.keys()].sort((a, b) => a - b).map(y => `<div class="catyear ${y === year ? "now" : ""}"><b>${y || "–"}</b><span class="muted">${year != null && y ? rel(y) : ""} · ${byYear.get(y).length}</span></div>
          <div class="catgrid">${byYear.get(y).map(m => catCard(m, year)).join("")}</div>`).join("") || `<p class="muted">${t("cat_none")}</p>`);
  }

  // ------------------------------------------------------------ stations & depots
  async function renderStations() {
    const [s, d] = await Promise.all([api("/api/stations"), api("/api/depots")]);
    renderTable($("#st-table"), [
      { key: "name", label: t("th_station"), render: x => `${ico(x.is_cargo ? "cargo" : "passengers", "sm")}${esc(x.name)}` },
      { key: "town_name", label: t("th_town"), render: x => esc(x.town_name || "–") },
      { key: "is_cargo", label: t("th_type"), render: x => x.is_cargo ? `<span class="chip">${t("cargo")}</span>` : `<span class="chip info">${t("pax")}</span>` },
      { key: "used", label: t("th_waiting"), num: true },
      { key: "cap", label: t("th_occupancy"), num: true, render: x => { const cap = (x.terminal_capacity || 0) + (x.pool_capacity || 0); return cap ? bar(x.used || 0, cap, pct(x.used, cap) > 90 ? "bad" : pct(x.used, cap) > 70 ? "warn" : "") : "–"; }, sortValue: x => { const cap = (x.terminal_capacity || 0) + (x.pool_capacity || 0); return cap ? (x.used || 0) / cap : null; } },
      { key: "overflow", label: t("th_overflow"), num: true, render: x => x.overflow ? `<span class="chip bad">${x.overflow}</span>` : "0" },
      { key: "lines", label: t("th_lines"), num: true },
      { key: "act", label: "", render: x => entBtns(x.station_id) },
    ], s.stations || [], { defaultSort: "used", defaultAsc: false });
    const DEPOT_ICON = { RAIL: "depot_rail", ROAD: "depot_road", TRAM: "depot_tram", WATER: "depot_water", AIR: "depot_air" };
    renderTable($("#dep-table"), [
      { key: "name", label: t("th_depot"), render: x => `${ico(DEPOT_ICON[x.carrier] || "depot", "sm")}${esc(x.name)}` },
      { key: "carrier", label: t("th_type"), render: x => CA(x.carrier) },
      { key: "vehicles", label: t("th_parked"), num: true },
      { key: "incoming", label: t("th_incoming"), num: true },
      { key: "maintenance_pool", label: t("th_maint_pool"), num: true, render: x => x.maintenance_pool == null ? "–" : t("pool_fmt", { avg: num(x.pool_avg, 1), max: num(x.pool_max, 0), n: x.maintenance_pool }) },
      { key: "act", label: "", render: x => entBtns(x.depot_id) },
    ], d.depots || [], { defaultSort: "name" });
  }

  // ------------------------------------------------------------ finance (secondary)
  async function renderFinance(o) {
    const fin = await api("/api/finance", { limit: Math.max(600, settings.history), range: settings.range });
    const ser = fin.series || [], labels = ser.map(x => dateLabel(x));
    const tx = tsOpts(ser, "fin");
    Charts.lineChart($("#chart-balance"), [
      { name: t("balance"), values: ser.map(x => x.balance), color: "#4f8a8a", area: true, unit: "$" },
      { name: t("debt"), values: ser.map(x => x.loan), color: "#d62560", dash: [6, 4], unit: "$" },
    ], labels, { unit: "$", ...tx });
    $("#fin-range").textContent = ser.length ? t("balance_range", { n: ser.length, a: date(ser[0]), b: date(ser[ser.length - 1]) }) : "";
    Charts.lineChart($("#chart-earn"), [{ name: t("earnings_ytd"), values: ser.map(x => x.earnings_ytd), color: "#e8b04b", area: true, unit: "$" }], labels, { zeroBase: true, unit: "$", ...tx });
    Charts.lineChart($("#chart-transport"), [
      { name: t("passengers"), values: ser.map(x => x.passengers_transported), color: "#58a6ff" },
      { name: t("cargo"), values: ser.map(x => x.cargo_transported), color: "#e8b04b", axis: "right" },
    ], labels, { rightAxis: true, zeroBase: true, ...tx });
    const c = (o && o.company) || {}, f = (o && o.finance) || {};
    $("#company-table").innerHTML = [
      [t("balance"), money(f.balance)], [t("debt"), money(f.loan)], [t("annual_result"), money(f.earnings_ytd)], [t("assets"), money(c.total_assets)], [t("score"), int(c.total_score)],
      [t("lines"), int(c.number_of_lines)], [t("stations"), t("stations_detail", { n: int(c.total_stations), r: c.rail_stations ?? "–", ro: c.road_stations ?? "–", t: c.tram_stations ?? "–", a: c.aircraft_stations ?? "–", w: c.ship_stations ?? "–" })],
      [t("tracks"), t("electrified", { a: km(c.track_length_m), b: km(c.track_electric_m) })], [t("roads"), km(c.road_length_m)],
      [t("bridges_tunnels"), `${km(c.bridge_length_m)} / ${km(c.tunnel_length_m)}`], [t("towns_supplied"), int(c.supplied_towns)], [t("industries_connected"), int(c.connected_industries)],
      [t("top_speed"), kmh(c.top_speed)], [t("longest_train"), c.top_length != null ? Math.round(c.top_length) + " m" : "–"],
    ].map(([k, val]) => `<tr><td>${k}</td><td>${val}</td></tr>`).join("");
    const fleet = state.cache.fleet || await api("/api/fleet");
    Charts.hbars($("#chart-costs"), (fleet.by_carrier || []).map(x => ({ label: `${CA(x.carrier)} (${x.n})`, value: x.running_cost || 0, color: CARRIER_COLOR[x.carrier], text: money(x.running_cost) })), {});
  }

  // ------------------------------------------------------------ camera views (Map tab panel)
  // Saved on the server next to the database (db/camera_views.json), per savegame. The current camera comes with
  // the overview (snapshot.camera, mod rev 7+); recalling a view sends set_camera to the game.
  const camViews = { list: [], loaded: false, cur: null };
  const fmtCam = (c) => c ? `x ${Math.round(c.x)} · y ${Math.round(c.y)} · ${Math.round(c.dist)} m · ${Math.round(c.angle * 180 / Math.PI)}° / ${Math.round(c.pitch * 180 / Math.PI)}°` : "";
  // "the camera is on this view": same target within 5 % of the distance, same zoom within 10 %, same heading/pitch within ~6°
  const angDiff = (a, b) => { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
  const sameView = (a, b) => !!(a && b) && Math.hypot(a.x - b.x, a.y - b.y) < Math.max(15, b.dist * 0.05) && Math.abs(a.dist - b.dist) < Math.max(10, b.dist * 0.1) && angDiff(a.angle, b.angle) < 0.1 && Math.abs(a.pitch - b.pitch) < 0.1;
  const activeView = () => camViews.list.find(v => sameView(camViews.cur, v)) || null;
  function gotoView(v) { return sendCmd("set_camera", { x: v.x, y: v.y, dist: v.dist, angle: v.angle, pitch: v.pitch }); }
  async function editViews(body) {
    const r = await fetch("/api/views", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.ok) { $("#cmd-status").textContent = t("act_failed", { msg: j.error || r.status }); $("#cmd-status").className = "cmdstatus bad"; return false; }
    camViews.list = j.views || []; renderCamViews(); if (map.data) drawMap($("#map")); return true;
  }
  async function loadViews() { try { const j = await api("/api/views"); camViews.list = j.views || []; } catch (e) { camViews.list = []; } camViews.loaded = true; }
  function renderCamViews() {
    const box = $("#cam-views"); if (!box) return;
    const cur = camViews.cur, off = cmdOff();
    if (cur === null) { box.innerHTML = `<div class="cmdhint">${ico("alert", "sm")}<span>${t("cam_needs_rev7")}</span></div>`; return; }
    const views = camViews.list, act = activeView();
    const row = (v, i) => `<div class="cv ${act && act.id === v.id ? "on" : ""}" data-id="${v.id}">
      <span class="cv-n" title="Shift+${i + 1}">${i + 1}</span>
      <button class="cv-go" data-act="go" title="${esc(t("cam_go_hint", { n: i + 1 }))} · ${fmtCam(v)}" ${off ? "disabled" : ""}>${esc(v.name)}</button>
      <span class="cv-tools">
        <button class="btn" data-act="update" title="${esc(t("cam_update"))}">${ico("star_outline", "sm")}</button>
        <button class="btn" data-act="rename" title="${esc(t("cam_rename"))}">${ico("edit", "sm")}</button>
        <button class="btn" data-act="up" title="${esc(t("cam_move_up"))}" ${i === 0 ? "disabled" : ""}>▲</button>
        <button class="btn" data-act="down" title="${esc(t("cam_move_down"))}" ${i === views.length - 1 ? "disabled" : ""}>▼</button>
        <button class="btn" data-act="delete" title="${esc(t("cam_delete"))}">✕</button>
      </span></div>`;
    box.innerHTML = `${cmdHint()}<button class="btn cv-save" ${views.length >= 9 ? "disabled" : ""} title="${views.length >= 9 ? esc(t("cam_max")) : ""}">${ico("star", "sm")}${esc(t("cam_save"))}</button>` +
      (views.length ? `<div class="cv-list">${views.map(row).join("")}</div>` : `<p class="cv-empty">${t("cam_empty")}</p>`) +
      `<div class="cv-cur">${t("cam_current")}: ${fmtCam(cur)}${cur.follow ? " · " + t("cam_following") : ""}</div>`;
    $(".cv-save", box).addEventListener("click", async () => {
      const name = await modal.prompt(t("cam_name_prompt"), { value: t("cam_default_name", { n: views.length + 1 }), ok: t("cam_save_ok") });
      if (name) editViews({ action: "add", name, camera: camViews.cur });
    });
    $$(".cv", box).forEach(el => {
      const id = +el.dataset.id, v = views.find(x => x.id === id); if (!v) return;
      $$("[data-act]", el).forEach(b => b.addEventListener("click", async e => {
        e.stopPropagation(); const a = b.dataset.act;
        if (a === "go") gotoView(v);
        else if (a === "update") { if (await modal.confirm(t("cam_update_confirm", { name: v.name }), { title: t("cam_update_title"), ok: t("cam_replace_ok") })) editViews({ action: "update", id, camera: camViews.cur }); }
        else if (a === "rename") { const name = await modal.prompt(t("cam_name_prompt"), { value: v.name, ok: t("cam_rename_ok") }); if (name) editViews({ action: "rename", id, name }); }
        else if (a === "up" || a === "down") editViews({ action: "move", id, delta: a === "up" ? -1 : 1 });
        else if (a === "delete") { if (await modal.confirm(t("cam_delete_confirm", { name: v.name }), { title: t("cam_delete_title"), ok: t("cam_delete_title"), danger: true })) editViews({ action: "delete", id }); }
      }));
    });
  }

  // ------------------------------------------------------------ map
  const map = { data: null, scale: 1, ox: 0, oy: 0, drag: null, init: false, fitted: false, lineFilter: null, icons: {} };
  const mapIcon = (name) => { if (!map.icons[name]) { const im = new Image(); im.src = ICON_URL(name); map.icons[name] = im; } return map.icons[name]; };
  async function renderMap(o) {
    camViews.cur = (o && o.camera) || null;
    if (!camViews.loaded) await loadViews();
    renderCamViews();
    map.data = await api("/api/map");
    const canvas = $("#map");
    if (!map.init) { initMap(canvas); map.init = true; }
    const sel = $("#map-line-filter");
    if (sel.options.length - 1 !== (map.data.lines || []).length || sel.dataset.lang !== i18n.lang) { sel.innerHTML = `<option value="">${t("all_lines")}</option>` + (map.data.lines || []).slice().sort((a, b) => String(a.name).localeCompare(b.name)).map(l => `<option value="${l.line_id}">${esc(l.name)}</option>`).join(""); sel.dataset.lang = i18n.lang; }
    if (map.lineFilter != null) { sel.value = String(map.lineFilter); }
    drawMap(canvas);
  }
  function initMap(canvas) {
    canvas.addEventListener("wheel", e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const f = e.deltaY < 0 ? 1.15 : 1 / 1.15; map.ox = mx - (mx - map.ox) * f; map.oy = my - (my - map.oy) * f; map.scale *= f; drawMap(canvas); }, { passive: false });
    canvas.addEventListener("mousedown", e => { map.drag = { x: e.clientX, y: e.clientY, ox: map.ox, oy: map.oy, moved: false }; canvas.style.cursor = "grabbing"; });
    window.addEventListener("mouseup", () => { map.drag = null; canvas.style.cursor = "grab"; });
    canvas.addEventListener("mousemove", e => { if (map.drag) { if (Math.abs(e.clientX - map.drag.x) + Math.abs(e.clientY - map.drag.y) > 3) map.drag.moved = true; map.ox = map.drag.ox + e.clientX - map.drag.x; map.oy = map.drag.oy + e.clientY - map.drag.y; drawMap(canvas); } else hoverMap(canvas, e); });
    canvas.addEventListener("click", e => {
      const hit = pickMap(canvas, e); if (!hit || map.lastDragMoved) return;
      if (hit.kind === "view") gotoView(hit.view);
      else if (hit.entity != null) sendCmd(hit.kind === "vehicle" && e.shiftKey ? "follow_entity" : "focus_entity", { entity: hit.entity });
    });
    canvas.addEventListener("mousedown", () => { map.lastDragMoved = false; });
    canvas.addEventListener("mousemove", () => { if (map.drag && map.drag.moved) map.lastDragMoved = true; });
    $$("#tab-map input").forEach(i => i.addEventListener("change", () => drawMap(canvas)));
    $("#map-line-filter").addEventListener("change", e => { map.lineFilter = e.target.value ? +e.target.value : null; drawMap(canvas); });
    $("#map-fit").addEventListener("click", () => { map.fitted = false; drawMap(canvas); });
    window.addEventListener("resize", () => { if (state.tab === "map") drawMap(canvas); });
    ["veh_bus", "veh_truck", "veh_train", "veh_tram", "veh_plane", "veh_heli", "veh_ship", "veh_car", "industry", "alert", "camera", "star"].forEach(mapIcon);
  }
  function fitMap(canvas) {
    const d = map.data; const pts = [...d.towns, ...d.stations, ...d.industries, ...d.vehicles].filter(p => p.x != null);
    if (!pts.length) return;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    map.scale = 0.9 * Math.min(w / Math.max(1, maxx - minx), h / Math.max(1, maxy - miny));
    map.ox = w / 2 - ((minx + maxx) / 2) * map.scale; map.oy = h / 2 + ((miny + maxy) / 2) * map.scale;
    map.fitted = true;
  }
  const P = (x, y) => [map.ox + x * map.scale, map.oy - y * map.scale]; // game y up
  function drawIcon(ctx, name, x, y, size, color) {
    const im = mapIcon(name); if (!im.complete || !im.naturalWidth) return false;
    // tint: draw the white-on-alpha icon, then multiply color through source-in on an offscreen canvas
    const oc = drawIcon.oc || (drawIcon.oc = document.createElement("canvas")); oc.width = oc.height = size;
    const o = oc.getContext("2d"); o.clearRect(0, 0, size, size); o.drawImage(im, 0, 0, size, size); o.globalCompositeOperation = "source-in"; o.fillStyle = color; o.fillRect(0, 0, size, size); o.globalCompositeOperation = "source-over";
    ctx.drawImage(oc, x - size / 2, y - size / 2); return true;
  }
  // Heading convention of api.gui.camera.getCameraData().angle: assumed 0 = looking towards +y (north), turning
  // counter-clockwise. If the cone points the wrong way in the game, fix CAM_ANGLE_OFFSET / CAM_ANGLE_SIGN here.
  const CAM_ANGLE_OFFSET = 0, CAM_ANGLE_SIGN = 1, CAM_HALF_FOV = 0.35;  // ~40° horizontal field of view
  function drawViewCone(ctx, c, color) {
    const a = CAM_ANGLE_SIGN * c.angle + CAM_ANGLE_OFFSET;
    const dx = -Math.sin(a), dy = Math.cos(a);                            // unit vector eye -> target (game coords)
    // horizontal distance eye -> target, in metres; kept readable on screen (>= 36 px) when the map is zoomed out
    const back = Math.max(c.dist * Math.cos(Math.abs(c.pitch)), 36 / map.scale);
    const ex = c.x - dx * back, ey = c.y - dy * back;                     // eye on the ground plane
    const far = back * 1.6, half = Math.tan(CAM_HALF_FOV) * far;
    const fx = ex + dx * far, fy = ey + dy * far;                         // centre of the far edge
    const [px, py] = P(ex, ey), [tx, ty] = P(c.x, c.y);
    const [lx, ly] = P(fx - dy * half, fy + dx * half), [rx, ry] = P(fx + dy * half, fy - dx * half);
    ctx.save();
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(lx, ly); ctx.lineTo(rx, ry); ctx.closePath();
    ctx.fillStyle = color; ctx.globalAlpha = 0.10; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(px, py); ctx.lineTo(rx, ry); ctx.stroke();   // the two converging lines
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(tx, ty, 4, 0, 7); ctx.stroke();                                         // the target point
    ctx.fillStyle = "#0b1015"; ctx.beginPath(); ctx.arc(px, py, 10, 0, 7); ctx.fill(); ctx.stroke();
    if (!drawIcon(ctx, "camera", px, py, 12, color)) { ctx.fillStyle = color; ctx.fillRect(px - 3, py - 3, 6, 6); }
    ctx.restore();
  }
  function drawMap(canvas) {
    const d = map.data; if (!d) return;
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!map.fitted) fitMap(canvas);
    const lf = map.lineFilter;
    const font = getComputedStyle(document.documentElement).getPropertyValue("--font");
    ctx.fillStyle = "#0b1015"; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#162029"; ctx.lineWidth = 1;
    const step = 1000 * map.scale; if (step > 12) { for (let x = map.ox % step; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); } for (let y = map.oy % step; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); } }
    ctx.font = "12px " + font;
    if ($("#map-lines").checked && d.lines) d.lines.forEach(l => { if (l.points.length < 2) return; const on = lf == null || l.line_id === lf; ctx.strokeStyle = rgb(l.color_r, l.color_g, l.color_b); ctx.globalAlpha = on ? (lf == null ? 0.5 : 0.95) : 0.08; ctx.lineWidth = on && lf != null ? 4 : 2; ctx.beginPath(); l.points.forEach(([x, y], i) => { const [px, py] = P(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.stroke(); ctx.globalAlpha = 1; });
    if ($("#map-towns").checked) d.towns.forEach(tw => { const [x, y] = P(tw.x, tw.y); const r = Math.max(8, Math.min(60, Math.sqrt(tw.size || 100) * 0.3 * Math.sqrt(map.scale * 10))); ctx.fillStyle = "rgba(79,138,138,.15)"; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.strokeStyle = "#4f8a8a"; ctx.stroke(); ctx.fillStyle = "#e6edf3"; ctx.textAlign = "center"; ctx.font = "600 13px " + font; ctx.fillText(tw.name, x, y - r - 5); ctx.font = "12px " + font; });
    const big = map.scale > 0.08;
    if ($("#map-ind").checked) d.industries.forEach(i => { const [x, y] = P(i.x, i.y); if (!big || !drawIcon(ctx, "industry", x, y, 14, "#bc8cff")) { ctx.fillStyle = "#bc8cff"; ctx.fillRect(x - 4, y - 4, 8, 8); } });
    if ($("#map-st").checked) d.stations.forEach(s => { const [x, y] = P(s.x, s.y); ctx.fillStyle = s.is_cargo ? "#e8b04b" : "#58a6ff"; ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.fill(); });
    const showLabels = $("#map-labels").checked;
    if ($("#map-veh").checked) d.vehicles.forEach(v => {
      if (lf != null && v.line_id !== lf) return; const [x, y] = P(v.x, v.y); const col = v.color_r != null ? rgb(v.color_r, v.color_g, v.color_b) : CARRIER_COLOR[v.carrier] || "#fff"; const moving = v.state === "EN_ROUTE" && v.speed_ms > 0.3;
      const stopped = v.state === "EN_ROUTE" && !moving;
      if (big || lf != null) {
        ctx.fillStyle = "#0b1015"; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill(); ctx.lineWidth = stopped ? 2 : 1.5; ctx.strokeStyle = stopped ? "#f85149" : col; ctx.stroke();
        if (!drawIcon(ctx, ICON_BY_TYPE[v.icon_type] || ICON_BY_CARRIER[v.carrier] || "veh_car", x, y, 13, col)) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
      } else { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, moving ? 4.5 : 3.5, 0, 7); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = stopped ? "#f85149" : "#0b1015"; ctx.stroke(); }
      if (showLabels || lf != null) { ctx.fillStyle = "#e6edf3"; ctx.textAlign = "left"; ctx.fillText(v.name, x + 11, y + 4); }
    });
    if ($("#map-alerts").checked) d.alerts.forEach(a => { const [x, y] = P(a.x, a.y); ctx.strokeStyle = "#f85149"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 12, 0, 7); ctx.stroke(); drawIcon(ctx, "alert", x, y, 14, "#f85149"); });
    // current camera as a view cone: eye position (behind the target, by dist * cos(pitch)) and two lines diverging
    // towards the target, then a little beyond; the opening (zoom) is the cone's half-angle. Drawn first so the pins
    // stay readable. Saved views = numbered pins with a star; the one the camera is on is highlighted.
    const act = activeView();
    if (camViews.cur) drawViewCone(ctx, camViews.cur, act ? "#e8b04b" : "#e6edf3");
    camViews.list.forEach((v, i) => {
      const [x, y] = P(v.x, v.y), on = act && act.id === v.id;
      drawIcon(ctx, "star", x, y - 14, 16, "#e8b04b");
      ctx.fillStyle = on ? "#e8b04b" : "#e6edf3"; ctx.strokeStyle = "#0b1015"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, on ? 9 : 8, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#0b1015"; ctx.textAlign = "center"; ctx.font = "600 11px " + font; ctx.fillText(String(i + 1), x, y + 4); ctx.font = "12px " + font;
    });
    const px = 1000 * map.scale; ctx.strokeStyle = "#8b98a8"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(16, h - 16); ctx.lineTo(16 + px, h - 16); ctx.stroke(); ctx.fillStyle = "#8b98a8"; ctx.textAlign = "left"; ctx.fillText("1 km", 16, h - 22);
    $("#map-legend").innerHTML = `<span>${ico("veh_bus", "sm")}${t("legend_vehicle")} · <span style="color:#f85149">○</span> ${t("legend_stopped")}</span><span><span style="color:#58a6ff">◆</span> ${t("legend_pax_station")} · <span style="color:#e8b04b">◆</span> ${t("legend_cargo_station")} · <span style="color:#bc8cff">${ico("industry", "sm")}</span>${t("legend_industry")}</span><span>${t("legend_counts", { v: d.vehicles.length, s: d.stations.length, i: d.industries.length })}</span>`;
  }
  function pickMap(canvas, e) {
    const d = map.data; if (!d) return null;
    const r = canvas.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 140;
    const consider = (obj, kind, entity, txt, extra) => { const [x, y] = P(obj.x, obj.y); const dd = (x - mx) ** 2 + (y - my) ** 2; if (dd < bd) { bd = dd; best = { kind, entity, txt, x, y, ...extra }; } };
    camViews.list.forEach((v, i) => consider(v, "view", null, `<b>${i + 1} · ${esc(v.name)}</b><br>${t("cam_go_hint", { n: i + 1 })}`, { view: v }));
    if ($("#map-veh").checked) d.vehicles.forEach(v => { if (map.lineFilter != null && v.line_id !== map.lineFilter) return; consider(v, "vehicle", v.vehicle_id, `<b>${modelImg(v, "sm")}${esc(v.name)}</b><br>${esc(v.line_name || t("no_line"))} · ${ST(v.state)}<br>${kmh(v.speed_ms)} · ${t("load_n", { a: v.load ?? 0, b: v.capacity ?? "?" })}`); });
    if ($("#map-st").checked) d.stations.forEach(s => consider(s, "station", s.station_id, `<b>${esc(s.name)}</b><br>${s.is_cargo ? t("station_cargo") : t("station_pax")}`));
    if ($("#map-ind").checked) d.industries.forEach(i => consider(i, "industry", i.industry_id, `<b>${esc(i.name)}</b><br>${t("industry")}`));
    if ($("#map-towns").checked) d.towns.forEach(tw => consider(tw, "town", tw.town_id, `<b>${esc(tw.name)}</b><br>${t("capacity_n", { n: int(tw.size) })}`));
    return best ? { ...best, mx, my } : null;
  }
  function hoverMap(canvas, e) {
    const tip = $("#map-tip"); const hit = pickMap(canvas, e);
    canvas.style.cursor = hit ? "pointer" : "grab";
    if (hit) { tip.style.display = "block"; tip.style.left = (hit.mx + 14) + "px"; tip.style.top = (hit.my + 14) + "px"; tip.innerHTML = hit.txt; } else tip.style.display = "none";
  }

  // ------------------------------------------------------------ Windows notifications
  // The browser's Notification API: Chrome / Edge show them as native Windows notifications (toast + notification
  // centre). Settings > Windows notifications: off / serious only / serious and warnings. The alerts already present
  // when the page opens (or when notifications are switched on) are the baseline and are not announced; after that,
  // every new alert of the chosen severity is notified once, then not again for COOLDOWN even if it flickers.
  const Notify = (() => {
    const supported = "Notification" in window;
    const COOLDOWN = 10 * 60 * 1000, POLL = 10000;
    let known = null, lastPoll = 0;
    const lastShown = new Map();
    const keyOf = (a) => [a.kind, a.entity_id, a.type_code, a.related_id].join("|");
    // new vehicles are announced at any level (the game itself announces them); otherwise by severity
    const wanted = (a) => { if (a.kind === "new_vehicle") return true; const sev = ALERT_SEV[a.kind] || "info"; return settings.notify >= 2 ? sev !== "info" : sev === "bad"; };
    const tabFor = (a) => a.catalogue ? "catalogue" : a.chain ? "chains" : ["line_problem", "line_issue"].includes(a.kind) ? "lines"
      : ["vehicle_problem", "blocked_train", "no_path_vehicle"].includes(a.kind) ? "vehicles" : ["closing_industry", "thrown_away_cargo"].includes(a.kind) ? "industries" : "overview";
    let testNote = null;  // result of the last Test click, shown until the settings change
    function hint() {
      const el = $("#notify-hint"); if (!el) return;
      const denied = supported && Notification.permission === "denied";
      const [txt, cls] = !supported ? [t("notify_unsupported"), "bad"] : denied ? [t("notify_denied"), "bad"] : testNote ? testNote
        : settings.notify ? [t("notify_on_hint"), ""] : ["", ""];
      el.textContent = txt;
      el.className = "hintline" + (cls ? " " + cls : "");
      $("#notify-test").disabled = !supported || denied;
    }
    async function permission() {
      if (!supported || Notification.permission === "denied") return false;
      if (Notification.permission === "granted") return true;
      return (await Notification.requestPermission()) === "granted";
    }
    function show(title, body, tag, onclick, onResult) {
      try {
        const n = new Notification(title, { body, tag, icon: ICON_URL("alert") });
        n.onclick = () => { window.focus(); if (onclick) onclick(); n.close(); };
        if (onResult) { n.onshow = () => onResult(true); n.onerror = () => onResult(false); }
      } catch (e) { console.warn("notification failed", e); if (onResult) onResult(false, e); }
    }
    function open(a) {
      const tab = tabFor(a);
      if (tab === "lines") state.selLine = a.entity_id;
      else if (tab === "vehicles") state.selVeh = a.entity_id;
      else if (tab === "industries") $("#ind-filter").value = a.entity_name || "";
      showTab(tab);
    }
    async function check(force) {
      if (!settings.notify || !supported || Notification.permission !== "granted") { known = null; return; }
      const now = Date.now();
      if (!force && now - lastPoll < POLL) return;
      lastPoll = now;
      let al;
      try { al = (await api("/api/alerts")).alerts || []; } catch (e) { return; }
      const cur = new Map(al.map(a => [keyOf(a), a]));
      if (known === null) { known = new Set(cur.keys()); return; }
      const fresh = [...cur].filter(([k, a]) => !known.has(k) && wanted(a) && now - (lastShown.get(k) || 0) > COOLDOWN);
      known = new Set(cur.keys());
      for (const [k, at] of lastShown) if (now - at > COOLDOWN) lastShown.delete(k);
      if (!fresh.length) return;
      fresh.forEach(([k]) => lastShown.set(k, now));
      if (fresh.length > 3) {
        show(t(fresh.every(([, a]) => a.kind === "new_vehicle") ? "notify_new_vehicles" : "notify_many", { n: fresh.length }), fresh.slice(0, 5).map(([, a]) => { const d = alertDesc(a); return `${d.label}: ${d.who}`; }).join("\n"), "tf3-many", () => showTab("overview"));
        return;
      }
      fresh.forEach(([k, a]) => { const d = alertDesc(a); show(`${d.label} — ${d.who}`, d.extra || "", k, () => open(a)); });
    }
    $$("#set-notify button").forEach(b => b.addEventListener("click", async () => {
      const v = +b.dataset.v;
      settings.notify = v && await permission() ? v : 0;
      testNote = v && !settings.notify ? [t(supported && Notification.permission === "default" ? "notify_no_answer" : "notify_denied"), "bad"] : null;
      known = null; applySettings(); check(true);
    }));
    // Test: say what happened. "shown" only means the browser handed it to Windows: if nothing pops up, Windows hid it
    // (Do not disturb, turned on automatically while a game runs full screen, or the browser's notifications are off)
    $("#notify-test").addEventListener("click", async () => {
      if (!(await permission())) { testNote = [t(supported && Notification.permission === "default" ? "notify_no_answer" : "notify_denied"), "bad"]; hint(); return; }
      testNote = [t("notify_sending"), ""]; hint();
      show("TF3 Dashboard", t("notify_test_body"), "tf3-test-" + Date.now(), null, (ok, e) => {
        testNote = ok ? [t("notify_sent"), "ok"] : [t("notify_error", { msg: e ? e.message : "" }), "bad"]; hint();
      });
    });
    return { check, hint };
  })();
  window.Notify = Notify;

  // ------------------------------------------------------------ refresh loop
  const RENDER = { overview: renderOverview, lines: renderLines, vehicles: renderVehicles, towns: renderTowns, industries: renderIndustries, chains: renderChains, catalogue: renderCatalogue, stations: renderStations, map: renderMap, finance: renderFinance };
  let busy = false, again = false;
  async function refresh() {
    if (busy) { again = true; return; } busy = true;
    try {
      const o = await renderTop();
      if (o && RENDER[state.tab]) await RENDER[state.tab](o);
      if (o && !o.empty) Notify.check();
    } catch (e) { $("#st-dot").className = "dot dead"; $("#st-text").textContent = t("server_down", { msg: e.message }); console.error(e); }
    busy = false;
    if (again) { again = false; refresh(); }
  }
  ["#lines-filter", "#lines-problems-only", "#veh-filter", "#veh-state", "#veh-worn", "#veh-problem", "#ind-filter", "#ind-unserved", "#cat-filter", "#cat-past", "#cat-wagons"].forEach(s => { const el = $(s); if (!el) return; el.addEventListener("input", () => refresh()); el.addEventListener("change", () => refresh()); });
  let timer = null;
  function restartTimer() { if (timer) clearInterval(timer); timer = setInterval(() => refresh(), Math.max(1, settings.refresh) * 1000); }
  setLang(pickLang(), false);
  applySettings();
  if (new URLSearchParams(location.search).get("settings")) { $("#settings").classList.add("open"); $("#gear").classList.add("open"); }
  if (new URLSearchParams(location.search).get("layout_edit")) Layout.enterEdit();
  const initial = tabFromUrl() || settings.defaultTab;
  if (initial && RENDER[initial]) showTab(initial, false); else refresh();
  VEH_MANIFEST.loading.then(() => refresh());  // first render may have happened before the model icon list arrived
})();
