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
  const DEFAULTS = { ico: 28, fs: 14, rowpad: 6, refresh: 3, history: 400, finance: true, keys: true, clock: false, defaultTab: "overview", range: "1gy" };
  // one range per question: since the game was set running, the last month played, this year, the trend, everything
  const RANGES = ["run", "1gm", "1gy", "5gy", "all"];
  const RANGE_ALIASES = { "5m": "1gm", "10m": "1gm", "15m": "1gm", "20m": "1gm", "30m": "1gm", "45m": "1gm", "1h": "1gy", "6gm": "1gy" };  // earlier versions
  const settings = Object.assign({}, DEFAULTS, (() => { try { return JSON.parse(localStorage.getItem("tf3.settings") || "{}"); } catch (e) { return {}; } })());
  function applySettings() {
    const root = document.documentElement.style;
    root.setProperty("--isz", settings.ico + "px"); root.setProperty("--fs", settings.fs + "px"); root.setProperty("--rowpad", settings.rowpad + "px");
    document.body.classList.toggle("hide-finance", !settings.finance);
    if (typeof drawMap === "function" && $("#map") && state.tab === "map") drawMap($("#map"));  // canvas markers follow the icon size too
    $$("#settings .seg").forEach(seg => $$("button", seg).forEach(b => b.classList.toggle("active", String(settings[seg.dataset.set]) === b.dataset.v)));
    $("#set-refresh").value = settings.refresh; $("#set-refresh-val").textContent = t("seconds_unit", { n: settings.refresh });
    $("#set-history").value = settings.history; $("#set-history-val").textContent = t("samples_unit", { n: settings.history });
    $("#set-finance").checked = settings.finance; $("#set-keys").checked = settings.keys; $("#set-clock").checked = settings.clock; $("#set-default-tab").value = settings.defaultTab;
    const urlRange = new URLSearchParams(location.search).get("range"); if (urlRange) settings.range = RANGE_ALIASES[urlRange] || urlRange;  // ?range= for screenshots / links
    settings.range = RANGE_ALIASES[settings.range] || settings.range;
    if (!RANGES.includes(settings.range)) settings.range = DEFAULTS.range;
    $$("#range-bar button").forEach(b => b.classList.toggle("active", b.dataset.range === settings.range));
    localStorage.setItem("tf3.settings", JSON.stringify(settings));
    if (settings.finance === false && state.tab === "finance") showTab("overview");
    restartTimer();
  }
  $("#gear").addEventListener("click", () => { const o = !$("#settings").classList.contains("open"); $("#settings").classList.toggle("open", o); $("#gear").classList.toggle("open", o); if (o) renderSaves(); });
  $("#settings-close").addEventListener("click", () => { $("#settings").classList.remove("open"); $("#gear").classList.remove("open"); });
  document.addEventListener("click", e => { if (!e.target.closest("#settings, #gear")) { $("#settings").classList.remove("open"); $("#gear").classList.remove("open"); } });
  $$("#settings .seg button").forEach(b => b.addEventListener("click", () => { settings[b.closest(".seg").dataset.set] = +b.dataset.v; applySettings(); }));
  $("#set-refresh").addEventListener("input", e => { settings.refresh = +e.target.value; applySettings(); });
  $("#set-history").addEventListener("input", e => { settings.history = +e.target.value; applySettings(); refresh(true); });
  $("#set-finance").addEventListener("change", e => { settings.finance = e.target.checked; applySettings(); });
  $("#set-keys").addEventListener("change", e => { settings.keys = e.target.checked; applySettings(); });
  $("#set-clock").addEventListener("change", e => { settings.clock = e.target.checked; applySettings(); refresh(true); });
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
  $$("#range-bar button").forEach(b => b.addEventListener("click", () => { settings.range = b.dataset.range; applySettings(); refresh(true); }));
  /** uPlot options for a server series. The x axis is the SIMULATION clock (gt, seconds of game time: the clock
   *  of vehicles, running costs and the finance report), like the game's own charts: a pause is a point, not a
   *  plateau, and the collector keeps one timeline per save, so the axis never runs backwards. Ticks read the game
   *  month; the tooltip adds the wall-clock time of the sample (real). Rows without a clock fall back to real time. */
  // month only, no year: the year boundary shows by itself (the year-to-date result drops to zero), and a month label
  // per tick stays short enough to read on a small chart
  const monthLabel = (s) => !(s && s.month) ? "" : i18n.dict._ymd ? `${s.month}月` : MON()[s.month] || "";
  function tsOpts(hist, syncKey) {
    if (!hist.length || hist[0].ts == null) return {};
    let aggFrom = 0; while (aggFrom < hist.length && hist[aggFrom].agg) aggFrom++;
    const months = hist.map(monthLabel);
    const game = hist.every(h => h.gt != null);
    // consecutive samples on the same game second (game paused) share an x: uPlot needs strictly increasing x, keep the last
    if (game) for (let i = 1; i < hist.length; i++) if (hist[i].gt <= hist[i - 1].gt) hist[i].gt = hist[i - 1].gt + 0.001;
    return { ts: hist.map(h => game ? h.gt : h.ts), real: game ? hist.map(h => h.ts) : null, aggFrom: aggFrom > 0 ? aggFrom : null, syncKey, xGame: months.some(Boolean) ? months : null };
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
  // Station kind from the terminal flags. Old mods only sent is_cargo (true for most passenger stations too, since
  // universal terminals "support cargo"), so without is_pax a station is pax when it is not cargo.
  function stKind(s) {
    const pax = s.is_pax == null ? !s.is_cargo : !!s.is_pax, cargo = s.is_pax == null ? !!s.is_cargo : !!s.is_cargo;
    return { pax, cargo,
      icons: (sz) => (pax ? ico("passengers", sz) : "") + (cargo ? ico("cargo", sz) : ""),
      label: () => [pax ? t("station_pax") : "", cargo ? t("station_cargo") : ""].filter(Boolean).join(" · ") };
  }
  const cargoIcon = (c, cls = "sm") => { const k = cargoKey(c); return `<i class="ico cargo-img ${cls}" style="--ico:url(icons/cargo/${CARGO_ICON_FILES.has(k) ? k : "_mixed"}.png)" title="${esc(cargoName(cargoLabel(c)))}"></i>`; };
  // What is on board, by cargo type (vehicle_state.cargo): the icons the game draws above the wagons,
  // with the count. Nothing when the mod does not export it (older revision) or the vehicle is empty.
  const onBoard = (v, cls = "sm") => Array.isArray(v.cargo) && v.cargo.length
    ? ` <span class="onboard">${v.cargo.map(c => `<span class="ob" title="${esc(cargoName(c.cargo))}: ${c.n}">${cargoIcon(c, cls)}<small>${c.n}</small></span>`).join("")}</span>` : "";
  const ALERT_ICON = { line_problem: "line_problem", line_issue: "line_unload", vehicle_problem: "no_path", blocked_train: "stop", no_path_vehicle: "no_path", town_problem: "town", closing_industry: "industry_closed", thrown_away_cargo: "stock_full" };

  // ------------------------------------------------------------ formatting
  const loc = () => i18n.dict._locale || "en";
  const money = (n) => n == null ? "–" : (n < 0 ? "−" : "") + Math.abs(Math.round(n)).toLocaleString(loc()) + " $";
  const int = (n) => n == null ? "–" : Math.round(n).toLocaleString(loc());
  const num = (n, d = 1) => n == null ? "–" : Number(n).toFixed(d);
  const pct = (a, b) => (b ? (100 * a / b) : 0);
  const kmh = (ms) => ms == null ? "–" : Math.round(ms * 3.6) + " km/h";
  const km = (m) => m == null ? "–" : (m / 1000).toFixed(1) + " km";
  const MON = () => i18n.dict._months;
  // _ymd: year-first languages (zh: 2769年9月9日); otherwise "9 Sep 2769"
  const date = (s) => !s ? "–" : i18n.dict._ymd ? `${s.year ?? ""}年${s.month ?? "?"}月${s.day ?? "?"}日` : `${s.day ?? "?"} ${MON()[s.month] || s.month || ""} ${s.year ?? ""}`;
  const dateLabel = (s) => !(s && s.month) ? "" : i18n.dict._ymd ? `${s.year}年${s.month}月${s.day ? s.day + "日" : ""}` : `${s.day ? s.day + " " : ""}${MON()[s.month]} ${s.year}`;
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
  const ALERT_SEV = { line_problem: "bad", line_issue: "warn", vehicle_problem: "bad", blocked_train: "bad", no_path_vehicle: "bad", town_problem: "warn", closing_industry: "warn", thrown_away_cargo: "info" };
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
          <div class="md-foot"><button class="btn md-cancel">${esc(o.cancel || t("cancel"))}</button><button class="btn primary md-ok ${o.danger ? "danger" : ""}">${o.danger ? "" : ico("check", "sm")}${esc(o.ok || "OK")}</button></div>`,
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
    const calFactor = mpd == null ? null : mpd === 0 ? 0 : Math.round(4000 / mpd * 100) / 100;  // 0 = calendar paused (the date stands still, the simulation runs)
    $$("#cal-speed .cbtn").forEach(b => { b.disabled = off; b.classList.toggle("active", calFactor != null && +b.dataset.cal === calFactor); });
    $("#cal-speed").title = off ? (cmd.enabled ? t("commands_off") : t("commands_na")) : t("calendar_speed") + (calFactor == null ? "" : calFactor === 0 ? ` · ${t("pause")}` : ` · ${calFactor}x`);
    const st = $("#cmd-status");
    if (c.ack && cmd.lastSent && c.ack.id === cmd.lastSent.id) {
      st.textContent = `${c.ack.cmd} · ${c.ack.ok ? t("act_done") : t("act_failed", { msg: c.ack.error || "" })}`; st.className = "cmdstatus " + (c.ack.ok ? "ok" : "bad");
      // an older mod answers "unknown command" to camera_path: say which revision the travelling needs
      if (!c.ack.ok && /^camera_(path|stop)/.test(c.ack.cmd || "") && /unknown command/i.test(c.ack.error || "")) { st.textContent = t("cam_travel_needs_rev10"); if (camViews.cur) camViews.cur.path = null; renderCamViews(); }
      if (cmd.lastSent.el) cmd.lastSent.el.classList.remove("pending");
      cmd.pendingId = null;
    } else if (cmd.pendingId && !c.pending && cmd.lastSent && Date.now() - cmd.lastSent.at > 8000) {
      // the mod removed the file but no ack came back (older mod?) -> stop blinking
      if (cmd.lastSent.el) cmd.lastSent.el.classList.remove("pending"); cmd.pendingId = null;
    }
    if (off) { st.textContent = ""; }
  }
  // Explains greyed-out command buttons: the mod ships with "Permit game control" = Off.
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
    // H = horn of the selected vehicle (Vehicles tab) or of every vehicle of the selected line (Lines tab). Mod rev 8+.
    else if (e.code === "KeyH" && !e.shiftKey) {
      if (state.tab === "vehicles" && state.selVeh) sendCmd("horn", { vehicle: state.selVeh });
      else if (state.tab === "lines" && state.selLine) sendCmd("horn", { line: state.selLine });
    }
  });
  const vehActions = (v) => {
    const off = !cmd.enabled || cmd.accepted === 0;
    const b = (name, icon, label, extra = "") => `<button class="btn act ${extra}" data-cmd="${name}" data-veh="${v.vehicle_id}" ${off ? "disabled" : ""}>${ico(icon, "sm")}${esc(label)}</button>`;
    return `${cmdHint()}<div class="actions">${b("focus_entity", "camera", t("act_focus"))}${b("follow_entity", "locate", t("act_follow"))}${b("select_entity", "select", t("act_select"))}${v.user_stopped ? b("vehicle_start", "play_1", t("act_start")) : b("vehicle_stop", "stop", t("act_stop"), "danger")}${b("vehicle_reverse", "reverse", t("act_reverse"))}${b("vehicle_depart", "depart", t("act_depart"))}${b("vehicle_to_depot", "to_depot", t("act_depot"), "danger")}${b("horn", "noise", t("act_horn"))}</div>`;
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
      const args = n.startsWith("vehicle_") || n === "horn" ? { vehicle: id } : (n === "open_line_manager" || n.startsWith("line_")) ? { line: id } : { entity: id };
      if (n === "horn" && b.dataset.line) { args.line = +b.dataset.line; delete args.vehicle; }
      sendCmd(n, args, b);
    }));
    // navigation links between sheets: <a class="goto" data-line="id"> (or data-veh, data-st) opens the entity in its tab
    $$(".goto[data-line], .goto[data-veh], .goto[data-st]", root).forEach(a => a.addEventListener("click", e => {
      e.stopPropagation(); e.preventDefault();
      if (a.dataset.line) { state.selLine = +a.dataset.line; showTab("lines"); }
      else if (a.dataset.st) { state.selSt = +a.dataset.st; showTab("stations"); }
      else { state.selVeh = +a.dataset.veh; showTab("vehicles"); }
    }));
  }
  const lineLink = (id, name) => id ? `<a class="goto" data-line="${id}" title="${esc(t("goto_line"))}">${esc(name || "#" + id)}</a>` : "–";

  // ------------------------------------------------------------ tabs
  const state = { tab: "overview", sort: {}, selLine: null, selTown: null, selVeh: null, selInd: null, selSt: null, cache: {} };
  function showTab(name, push = true) {
    const b = $(`#tabs button[data-tab="${name}"]`); if (!b) return;
    $$("#tabs button").forEach(x => x.classList.toggle("active", x === b));
    $$(".tab").forEach(tb => tb.classList.toggle("active", tb.id === "tab-" + name));
    state.tab = name;
    if (push) { const u = new URL(location.href); u.searchParams.set("tab", name); history.replaceState(null, "", u); }
    refresh(true);
  }
  $$("#tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
  const tabFromUrl = () => new URLSearchParams(location.search).get("tab") || location.hash.slice(1);

  // ------------------------------------------------------------ sortable tables
  const COLW_KEY = "tf3.colw";
  const colWidths = (tableId) => { try { return (JSON.parse(localStorage.getItem(COLW_KEY) || "{}")[tableId]) || {}; } catch (e) { return {}; } };
  const saveColWidths = (tableId, w) => { let all = {}; try { all = JSON.parse(localStorage.getItem(COLW_KEY) || "{}"); } catch (e) { /* ignore */ } if (Object.keys(w).length) all[tableId] = w; else delete all[tableId]; localStorage.setItem(COLW_KEY, JSON.stringify(all)); };
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
    const cls = (c, i) => `${c.num ? "num" : ""} ${c.gauge ? "gauge" : ""} ${c.noicon ? "noicon" : ""} ${c.key === "act" ? "act" : ""} ${c.sticky ? "stick" : ""} ${i === lastStick ? "stick-last" : ""}`;
    // column widths chosen by the user (drag the right edge of a header), per table, in this browser
    const widths = colWidths(key);
    const thead = `<thead><tr>${cols.map((c, i) => `<th class="${cls(c, i)} ${c.key === sort.col ? "sorted " + (sort.asc ? "asc" : "") : ""}" data-key="${c.key}"${widths[c.key] ? ` style="width:${widths[c.key]}px;min-width:${widths[c.key]}px;max-width:${widths[c.key]}px"` : ""}><span class="thl">${c.icon ? ico(c.icon, "sm") : ""}${esc(c.label)}</span>${c.key === "act" ? "" : '<span class="colgrip"></span>'}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${sorted.map(r => `<tr class="${opts.rowClass ? opts.rowClass(r) : ""} ${opts.onRow ? "clickable" : ""}" data-id="${opts.id ? r[opts.id] : ""}">${cols.map((c, i) => `<td class="${cls(c, i)} ${c.wrap ? "wrap" : ""}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join("")}</tr>`).join("")}</tbody>`;
    table.innerHTML = thead + tbody;
    if (!sorted.length) {
      // A real message in the middle of the card, not a one-line "no data". opts.total = rows before the filters
      // (so the filters hide everything); opts.empty = { icon, text, hint } for "nothing exists yet".
      const e = opts.total > 0 ? { icon: "hidden", text: t("empty_filtered"), hint: t("empty_filtered_hint") } : (opts.empty || { icon: "info", text: t("no_data") });
      table.innerHTML += `<tbody><tr class="emptyrow"><td colspan="${cols.length}"><div class="emptystate">${ico(e.icon)}<div class="t">${esc(e.text)}</div>${e.hint ? `<div class="h">${esc(e.hint)}</div>` : ""}</div></td></tr></tbody>`;
    }
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
    $$("th", table).forEach(th => th.addEventListener("click", (e) => {
      if (e.target.classList.contains("colgrip") || table._resizing) return;
      const k = th.dataset.key; if (sort.col === k) sort.asc = !sort.asc; else { sort.col = k; sort.asc = !(cols.find(c => c.key === k)?.num); }
      renderTable(table, cols, rows, opts);
    }));
    // resizable columns: drag the grip at the right edge of a header; double-click it to reset that column
    $$("th .colgrip", table).forEach(g => {
      const th = g.parentElement;
      g.addEventListener("dblclick", (e) => { e.stopPropagation(); const w = colWidths(key); delete w[th.dataset.key]; saveColWidths(key, w); renderTable(table, cols, rows, opts); });
      g.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        const x0 = e.clientX, w0 = th.getBoundingClientRect().width; let moved = false;
        table._resizing = true; table.classList.add("resizing"); g.setPointerCapture(e.pointerId);
        const move = (ev) => { const w = Math.max(40, Math.round(w0 + ev.clientX - x0)); moved = true; th.style.width = th.style.minWidth = th.style.maxWidth = w + "px"; };
        const up = () => {
          g.removeEventListener("pointermove", move); g.removeEventListener("pointerup", up); table.classList.remove("resizing");
          setTimeout(() => { table._resizing = false; }, 0);
          if (moved) { const w = colWidths(key); w[th.dataset.key] = parseInt(th.style.width, 10); saveColWidths(key, w); }
        };
        g.addEventListener("pointermove", move); g.addEventListener("pointerup", up);
      });
    });
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
    // optional game clock (snapshot.time_of_day_s, seconds since midnight in game time)
    const clock = settings.clock && s.time_of_day_s != null ? ` ${String(Math.floor(s.time_of_day_s / 3600) % 24).padStart(2, "0")}:${String(Math.floor(s.time_of_day_s / 60) % 60).padStart(2, "0")}` : "";
    $("#k-date").textContent = date(s) + clock;
    // the save was reloaded from an older date less than a day (real time) ago: say so under the date, with the
    // savegame label, so the player knows which history he is looking at
    const rel = o.game && Array.isArray(o.game.reloads) ? o.game.reloads : [], lastRel = rel[rel.length - 1];
    const recent = lastRel && (Date.now() - new Date(lastRel.at).getTime()) < 86400e3;
    $("#k-date").title = o.game ? `${o.game.label || o.game.key}${rel.length ? "\n" + t("saves_reloads", { n: rel.length, from: gameDay(lastRel.from_day), to: gameDay(lastRel.to_day), at: realDate(lastRel.at) }) : ""}` : "";
    $("#k-date").classList.toggle("rewound", !!recent);
    // two independent speeds: simulation (pause / ×1 / ×2 / ×4) and calendar (the game's slider, 1x = 4000 ms/day)
    const cal = s.millis_per_day == null ? null : s.millis_per_day === 0 ? 0 : Math.round(4000 / s.millis_per_day * 100) / 100;
    $("#k-speed").innerHTML = s.speed === 0 ? `${ico("play_pause", "sm")}${t("pause")}` : s.speed == null ? "" :
      `<span title="${esc(t("sim_speed"))}">${ico("play_1", "sm")}${t("speed_x", { n: s.speed })}</span>${cal != null ? ` <span class="muted" title="${esc(t("calendar_speed"))}">${ico("calendar", "sm")}${cal === 0 ? t("pause") : t("speed_x", { n: cal })}</span>` : ""}`;
    $("#k-veh").textContent = int(v.n);
    $("#k-veh-detail").innerHTML = v.n ? `<span style="color:${STATE_COLOR.EN_ROUTE}">${v.en_route} ${t("en_route")}</span> · ${v.at_terminal} ${t("at_terminal")} · ${v.in_depot} ${t("in_depot")}${v.no_path ? ` · <span class="neg">${v.no_path} ${t("no_path")}</span>` : ""}` : "";
    const fillEl = $("#k-fill");
    if (v.capacity) { fillEl.textContent = Math.round(pct(v.load, v.capacity)) + " %"; $("#k-fill-detail").textContent = t("seats", { a: int(v.load), b: int(v.capacity) }); } else { fillEl.textContent = "–"; $("#k-fill-detail").textContent = ""; }
    const m = $("#k-maint"); m.innerHTML = v.maint != null ? `${condIcon(v.maint)}${Math.round(v.maint * 100)} %` : "–"; m.className = "v " + (v.maint != null ? (v.maint < 0.5 ? "neg" : v.maint < 0.7 ? "" : "pos") : "");
    $("#k-maint-detail").textContent = v.worn != null ? t("worn_count", { n: v.worn }) : "";
    const na = (o.alerts || []).reduce((a, b) => a + b.n, 0);
    const ka = $("#k-alerts"); ka.textContent = na; ka.className = "v " + (na ? "bad" : "ok");
    $("#k-alerts-detail").innerHTML = (o.alerts || []).map(a => `<span title="${esc(alertLabel(a.kind))}">${ico(ALERT_ICON[a.kind] || "alert", "sm")}${a.n}</span>`).join(" ");
    $("#k-pax").textContent = int(f.passengers_transported) + " " + t("pax");
    $("#k-cargo").textContent = int(f.cargo_transported) + " " + t("cargo");
    $("#k-balance").textContent = money(f.balance);
    const bd = $("#k-balance-delta");
    if (o.balance_prev && o.balance_prev.balance != null) { const d = f.balance - o.balance_prev.balance; bd.textContent = (d >= 0 ? "+" : "") + money(d) + " / " + ago(o.balance_prev.real_time); bd.className = "s " + (d >= 0 ? "pos" : "neg"); } else bd.textContent = "";
    const ec = $("#errors-card"); if (o.errors && o.errors.length) { ec.style.display = ""; $("#errors-list").textContent = o.errors.map(x => `${x.section}: ${x.error}`).join("\n"); } else ec.style.display = "none";
    updateCmdUi(o);
    // the mod says the camera path ended (or the player grabbed the camera): forget the travelling, stop the music
    if (travel.active && o && o.camera && Date.now() - travel.active.at > 4000 && !(o.camera.path && o.camera.path.playing)) { travel.active = null; if (!travelPrefs().tail) musicStop(); }
    return o;
  }

  // ------------------------------------------------------------ empty database: say exactly which link of the chain is missing
  // game (mod enabled in the savegame) -> <userdata>/towns_industries/tf3dash_live.lua -> collector -> db -> this page
  // (mod rev <= 8 wrote <userdata>/dashboard_export/live.lua; the server reports which layout it watches as live_name)
  async function renderSetup() {
    const card = $("#setup-card"); card.style.display = "";
    let d;
    try { d = await api("/api/diag"); } catch (e) { $("#setup-body").innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    const steps = [];
    const step = (ok, label, detail) => steps.push(`<li class="${ok === null ? "" : ok ? "ok" : "bad"}"><span class="mark">${ok === null ? "·" : ok ? "✓" : "✗"}</span><div><div class="n">${label}</div>${detail ? `<div class="d">${detail}</div>` : ""}</div></li>`);
    const mono = s => `<code>${esc(s)}</code>`;
    // 1. the game's userdata folder
    if (!d.export_dir) {
      step(false, t("setup_no_folder"), t("setup_no_folder_help", { cfg: mono("config.json"), ex: mono(`{ "export_dir": "%APPDATA%\\Transport Fever 3\\towns_industries" }`) }));
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
        else if (g.save_errors > 0 && !g.writes_to && (g.build || 0) >= 40420 && /not available or invalid/.test(g.last_error || "")) {
          // game build 40420+ only lets mods write to a few userdata folders: an old mod revision (<= 8) still tries
          // dashboard_export and is refused. Not a rights problem: update the mod.
          step(false, t("setup_mod_outdated", { build: g.build }), t("setup_mod_outdated_help") + "<br>" + mono(g.last_error));
        }
        else if (g.save_errors > 0) {
          // the game refuses to write. Narrow it down: a junction/symlink on the path (moved Steam folder), or the
          // companion writes fine in that very folder -> only the game process is refused (Controlled folder access,
          // antivirus, game and Steam not run the same way)
          let help = d.reparse_point ? t("setup_write_reparse_help")
            : (d.companion_files || []).length ? t("setup_write_game_only_help", { files: d.companion_files.map(mono).join(", ") })
            : t("setup_log_write_error_help", { log: logRef });
          step(false, t("setup_log_write_error", { n: g.save_errors }), mono(g.last_error) + "<br>" + help + "<br>" + t("setup_write_report", { log: logRef }));
        }
        else if (g.mod_lines === 0) step(false, t("setup_log_mod_idle"), t("setup_log_mod_idle_help", { log: logRef }));
        else step(null, t("setup_log_ok", { n: g.written, src: esc(g.mod_source || "?") }), logRef);
      }
      // 2. the live file written by the mod
      const live = d.live_name || "tf3dash_live.lua";
      if (!d.live_exists) step(false, t("setup_no_live", { live }), t("setup_no_live_help") + " " + t("setup_no_live_log"));
      else if (d.live_age_s > 120) step(false, t("setup_live_old", { live, ago: fmtDur(d.live_age_s) }), t("setup_live_old_help"));
      else step(true, t("setup_live_ok", { live, ago: fmtDur(d.live_age_s) }), null);
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
      bc.map(c => `<tr><td><span class="vehicon" style="color:${CARRIER_COLOR[c.carrier] || "#888"}">${ico(ICON_BY_CARRIER[c.carrier] || "veh_car")}<span>${CA(c.carrier)}</span></span></td><td class="num">${c.n}</td><td class="num">${c.en_route}</td><td class="num">${c.at_terminal}</td><td class="num">${c.in_depot}</td>
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

    // the bars of the three rankings open the vehicle / the line
    const toVeh = { onClick: it => { state.selVeh = it.id; showTab("vehicles"); } };
    const toLine = { onClick: it => { state.selLine = it.id; showTab("lines"); } };
    Charts.hbars($("#chart-worn"), (fleet.worn || []).slice(0, 10).map(v => ({ id: v.vehicle_id, label: v.name, value: 1 - (v.maintenance ?? 1), max: 1, color: maintCls(v.maintenance) === "bad" ? "#f85149" : maintCls(v.maintenance) === "warn" ? "#e8b04b" : "#3fb950", text: t("state_cond", { n: Math.round((v.maintenance ?? 1) * 100) }) })), toVeh);
    const lines = state.cache.lines;
    const bad = lines.map(l => { const tot = (l.pax_total || 0) + (l.cargo_total || 0), b = (l.pax_bad || 0) + (l.cargo_bad || 0); return { l, tot, b, p: tot ? 100 * b / tot : 0 }; }).filter(x => x.tot >= 5).sort((a, b) => b.p - a.p).slice(0, 10);
    Charts.hbars($("#chart-lines-bad"), bad.map(x => ({ id: x.l.line_id, label: x.l.name, value: x.p, max: 100, color: x.p > 30 ? "#f85149" : x.p > 10 ? "#e8b04b" : "#3fb950", text: `${Math.round(x.p)} % (${x.b}/${x.tot})` })), toLine);
    const load = lines.map(l => { const c = l.capacities.reduce((a, x) => ({ u: a.u + (x.used || 0), c: a.c + (x.capacity || 0) }), { u: 0, c: 0 }); return { l, p: c.c ? 100 * c.u / c.c : 0, u: c.u, c: c.c }; }).filter(x => x.c > 0).sort((a, b) => b.p - a.p).slice(0, 10);
    Charts.hbars($("#chart-lines-load"), load.map(x => ({ id: x.l.line_id, label: x.l.name, value: x.p, max: 100, color: x.p >= 80 ? "#3fb950" : x.p < 25 ? "#e8b04b" : "#4f8a8a", text: `${Math.round(x.p)} % (${Math.round(x.u)}/${Math.round(x.c)})` })), toLine);
  }

  function renderAlerts(el, alerts) {
    if (!alerts.length) { el.innerHTML = `<div class="empty">${t("all_good")}</div>`; return; }
    const order = { bad: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => (order[ALERT_SEV[a.kind]] ?? 3) - (order[ALERT_SEV[b.kind]] ?? 3) || b.seen - a.seen);
    el.innerHTML = alerts.map(a => {
      const sev = ALERT_SEV[a.kind] || "info";
      const codeTable = ALERT_CODE[a.kind] ? t(ALERT_CODE[a.kind]) : null;
      const code = codeTable && a.type_code != null ? (codeTable[a.type_code] ?? ("code " + a.type_code)) : "";
      const extra = [code, a.stop_index != null ? t("stop_n", { n: a.stop_index }) : "", a.amount != null ? t("units_n", { n: a.amount }) : "", a.related_id != null && a.kind === "blocked_train" ? t("by_id", { id: a.related_id }) : ""].filter(Boolean).join(" · ");
      const who = a.entity_name || (a.entity_id != null ? "#" + a.entity_id : "");
      // thrown_away_cargo points at a stock list = an industry (no line is involved): camera / select target the
      // industry and an extra button opens the Industries tab on it
      const focus = a.kind === "thrown_away_cargo"
        ? (a.industry_id != null ? `<span class="entbtns">${entBtns(a.industry_id)}<button class="btn iconbtn goto" data-ind="${esc(a.entity_name)}" title="${esc(t("tab_industries"))}">${ico("industry", "sm")}</button></span>` : "")
        : a.entity_id != null ? entBtns(a.entity_id) : "";
      return `<div class="alert"><div class="sev ${sev}"></div><div style="color:${sev === "bad" ? "var(--bad)" : sev === "warn" ? "var(--warn)" : "var(--info)"}">${ico(ALERT_ICON[a.kind] || "alert")}</div><div><div class="what">${esc(alertLabel(a.kind))}${extra ? " — " + esc(extra) : ""}</div><div class="who">${esc(who)}</div></div><div class="age">${a.seen > 1 ? t("seen_n", { n: a.seen }) : t("new")}${a.since ? "<br>" + t("since", { ago: ago(a.since) }) : ""}</div>${focus}</div>`;
    }).join("");
    bindActions(el);
    $$("button.goto[data-ind]", el).forEach(b => b.addEventListener("click", e => { e.stopPropagation(); $("#ind-filter").value = b.dataset.ind; showTab("industries"); }));
  }

  // ------------------------------------------------------------ vehicles
  async function renderVehicles() {
    const d = await api("/api/vehicles"); const veh = d.vehicles || []; state.cache.vehicles = veh;
    if (!state.selVeh) { const u = +new URLSearchParams(location.search).get("veh"); if (u && veh.some(v => v.vehicle_id === u)) state.selVeh = u; }  // deep link ?tab=vehicles&veh=<id>
    renderTypeBar($("#veh-types"), veh, vehType, state.vehTypes, renderVehicles);
    renderStateBar($("#veh-states"), veh);
    const q = $("#veh-filter").value.toLowerCase(), worn = $("#veh-worn").checked, prob = $("#veh-problem").checked;
    const rows = veh.filter(v => (!q || [v.name, v.line_name, v.town_name, v.model, ...(v.capacities || []).map(c => cargoName(c.cargo))].join(" ").toLowerCase().includes(q)) && (!state.vehTypes.size || state.vehTypes.has(vehType(v))) && (!state.vehStates.size || state.vehStates.has(v.state)) && (!worn || (v.maintenance != null && v.maintenance < 0.5)) && (!prob || v.no_path || v.user_stopped || !v.line_id || (v.days_in_depot + v.days_at_terminal) > 2));
    $("#veh-count").textContent = `${rows.length} / ${veh.length}`;
    const cols = [
      { key: "name", label: t("th_vehicle"), render: v => `${esc(v.name)}${v.model ? `<br><small>${esc(v.model)}</small>` : ""}` },
      { key: "carrier", label: t("th_type"), render: v => `<span class="vehicon" style="color:${CARRIER_COLOR[v.carrier] || "#888"}">${modelImg(v)}${ENGINE_ICON[v.icon_type] ? ico(ENGINE_ICON[v.icon_type], "sm", t("icon_type." + v.icon_type)) : ""}</span>`, sortValue: v => (v.carrier || "") + (v.icon_type || "") },
      { key: "line_name", label: t("th_line"), render: v => lineLink(v.line_id, v.line_name) },
      { key: "state", label: t("th_state"), render: v => { const cls = v.no_path ? "bad" : v.user_stopped ? "warn" : v.state === "EN_ROUTE" ? "ok" : ""; return `<span class="chip ${cls}">${ST(v.state)}${v.no_path ? " · " + t("no_path") : ""}${v.user_stopped ? " · " + t("stopped") : ""}</span>`; } },
      { key: "speed_ms", label: t("th_speed"), num: true, render: v => kmh(v.speed_ms) },
      // "carries" = what is on board right now (icon + count per cargo), "load" = the gauge; the capacities of the
      // vehicle are in the sheet (same icons in the same column so the eye follows)
      { key: "carries", label: t("th_carries"), gauge: true, noicon: true, render: v => onBoard(v, "sm") || (Array.isArray(v.capacities) && v.capacities.length ? `<span class="onboard dim">${v.capacities.map(c => `<span class="ob" title="${esc(cargoName(c.cargo))}">${cargoIcon(c, "sm")}</span>`).join("")}</span>` : ""), sortValue: v => Array.isArray(v.cargo) && v.cargo.length ? cargoName(v.cargo[0].cargo) : null },
      { key: "load", label: t("th_load"), gauge: true, num: true, render: v => v.capacity ? bar(v.load || 0, v.capacity, fillCls(pct(v.load || 0, v.capacity)), `${v.load ?? 0}/${v.capacity}`) : int(v.load), sortValue: v => v.capacity ? (v.load || 0) / v.capacity : null },
      { key: "maintenance", label: t("th_cond_short"), gauge: true, num: true, render: v => v.maintenance == null ? "–" : condIcon(v.maintenance) + bar(v.maintenance, 1, maintCls(v.maintenance)) },
      { key: "idle", label: t("th_idle_short"), num: true, render: v => { const d = (v.days_in_depot || 0) + (v.days_at_terminal || 0); return d ? `<span class="${d > 3 ? "neg" : ""}">${d} j</span>` : "–"; }, sortValue: v => (v.days_in_depot || 0) + (v.days_at_terminal || 0) },
      { key: "running_cost", label: t("th_cost_year"), num: true, render: v => money(v.running_cost) },
      { key: "value", label: t("th_value"), num: true, render: v => money(v.value) },
      { key: "town_name", label: t("th_near"), render: v => esc(v.town_name || "–") },
      { key: "act", label: "", render: v => entBtns(v.vehicle_id, { follow: true }) },
    ];
    renderTable($("#veh-table"), cols, rows, { total: veh.length, empty: { icon: "vehicles", text: t("empty_vehicles"), hint: t("empty_vehicles_hint") }, id: "vehicle_id", defaultSort: "name", onRow: (id, tr) => { state.selVeh = +id; $$("tr", tr.parentElement).forEach(x => x.classList.toggle("sel", x === tr)); renderVehicleDetail(+id); }, rowClass: v => (v.vehicle_id === state.selVeh ? "sel" : "") });
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
        <tr><td>${t("th_line")}</td><td>${lineLink(cur.line_id || last.line_id, v.line_name)}</td></tr>
        <tr><td>${t("th_state")}</td><td><span class="chip" style="color:${STATE_COLOR[last.state] || "#fff"}">${ST(last.state)}</span> · ${t("stop")} ${last.stop_index ?? "–"}</td></tr>
        ${Array.isArray(v.capacities) && v.capacities.length ? `<tr><td>${t("th_carries")}</td><td>${v.capacities.map(c => `${cargoChip(c)} <span class="mono">${c.n}</span>`).join(" ")}</td></tr>` : ""}
        <tr><td>${t("th_load")}</td><td>${onBoard(v, "")}${v.capacity ? bar(last.load || 0, v.capacity, fillCls(pct(last.load || 0, v.capacity)), `${last.load ?? 0}/${v.capacity}`) : "–"}</td></tr>
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
  // vehicle state filter: the game's icons as toggles (no dropdown: a <select> closes at every refresh), empty = all
  state.vehStates = new Set();
  const STATE_ICON = { EN_ROUTE: "speed", AT_TERMINAL: "terminal", IN_DEPOT: "depot", GOING_TO_DEPOT: "to_depot" };
  function renderStateBar(bar, veh) {
    if (!bar) return;
    const counts = {}; veh.forEach(v => { counts[v.state] = (counts[v.state] || 0) + 1; });
    const active = state.vehStates;
    bar.innerHTML = Object.keys(STATE_ICON).filter(s => counts[s]).map(s => `<button class="tbtn ${active.has(s) ? "active" : ""}" data-type="${s}" title="${esc(ST(s))}" style="--c:${STATE_COLOR[s]}">${ico(STATE_ICON[s], "sm")}<small>${counts[s]}</small></button>`).join("")
      + (active.size ? `<button class="tbtn clear" data-type="" title="${esc(t("all_states"))}">${ico("close", "sm")}</button>` : "");
    $$(".tbtn", bar).forEach(b => b.addEventListener("click", () => {
      const s = b.dataset.type;
      if (!s) active.clear(); else if (active.has(s)) active.delete(s); else active.add(s);
      renderVehicles();
    }));
  }
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
      // average speed of the vehicles en route right now (live snapshot), the game shows no such figure for a line
      { key: "speed", label: t("th_avg_speed"), num: true, render: l => kmh(l.live && l.live.speed), sortValue: l => l.live ? l.live.speed : null },
      // load: one short gauge per cargo type (icon + used/capacity), stacked for multi-cargo lines; sorted by the overall ratio
      { key: "load", label: t("th_load"), gauge: true, render: l => l.capacities.some(c => c.capacity) ? `<span class="qstack">${l.capacities.filter(c => c.capacity).map(c => `<span title="${esc(cargoName(c.cargo))}">${cargoIcon(c, "sm")}${bar(c.used || 0, c.capacity, fillCls(pct(c.used || 0, c.capacity)), `${c.used || 0}/${c.capacity}`)}</span>`).join("")}</span>` : "–", sortValue: l => { const c = loadOf(l); return c.c ? c.u / c.c : null; } },
      { key: "persons_on_line", label: t("th_onboard"), num: true, render: l => carriesPax(l) ? int(l.persons_on_line) : NA, sortValue: l => carriesPax(l) ? l.persons_on_line : null },
      // the game's "transported" figure of the line window (last 12 months): pax or cargo units per year
      { key: "throughput", label: t("th_per_year"), num: true, render: l => l.throughput == null ? "–" : int(l.throughput), sortValue: l => l.throughput },
      // one "quality" column: unhappy pax, late cargo, or both stacked (one small row each, icon in front) for mixed lines
      { key: "quality", label: t("th_unhappy"), render: l => { const q = []; if (carriesPax(l) && l.pax_total) q.push(ico("passengers", "sm") + barQuality(l.pax_bad, l.pax_total)); if (carriesCargo(l) && l.cargo_total) q.push(ico("cargo", "sm") + barQuality(l.cargo_bad, l.cargo_total)); return q.length ? `<span class="qstack">${q.map(r => `<span>${r}</span>`).join("")}</span>` : NA; }, sortValue: l => Math.max(l.pax_total ? l.pax_bad / l.pax_total : -1, l.cargo_total ? l.cargo_bad / l.cargo_total : -1) },
      { key: "act", label: "", render: l => entBtns(l.line_id, { line: true }) },
    ];
    renderTable($("#lines-table"), cols, rows, { total: lines.length, empty: { icon: "line", text: t("empty_lines"), hint: t("empty_lines_hint") }, id: "line_id", defaultSort: "name", onRow: (id, tr) => { state.selLine = +id; $$("tr", tr.parentElement).forEach(x => x.classList.toggle("sel", x === tr)); renderLineDetail(+id); }, rowClass: l => (l.line_id === state.selLine ? "sel" : "") });
    if (state.selLine) renderLineDetail(state.selLine);
  }

  async function renderLineDetail(id) {
    const l = (state.cache.lines || []).find(x => x.line_id === id); if (!l) return;
    const h = await api("/api/line_history", { id, limit: settings.history, range: settings.range });
    const el = $("#line-detail");
    // a stop editor open on this line must survive the periodic refresh: keep its DOM and put it back below
    const keepStops = state.editStop && state.editStop.line === id && $("#line-stops-wrap tr.editing", el) ? $("#line-stops-wrap", el) : null;
    el.innerHTML = `<h2><span class="swatch" style="background:${rgb(l.color_r, l.color_g, l.color_b)}"></span>${lineTypeIcon(l)}${esc(l.name)} <small>#${l.line_id}</small></h2>
      <div class="actions"><button class="btn act" data-cmd="focus_entity" data-veh="${l.line_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("camera", "sm")}${t("act_focus")}</button><button class="btn act" data-cmd="select_entity" data-veh="${l.line_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("select", "sm")}${t("act_select")}</button><button class="btn act" data-cmd="open_line_manager" data-veh="${l.line_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("configure_line", "sm")}${t("act_manage_line")}</button><button class="btn" id="line-on-map">${ico("locate", "sm")}${t("see_on_map")}</button>${travel.active && travel.active.kind === "line" && travel.active.id === id ? `<button class="btn" id="line-travel" data-stop="1">${ico("stop", "sm")}${t("cam_travel_stop")}</button>` : `<button class="btn" id="line-travel" title="${esc(t("line_travel_hint"))}" ${!cmd.enabled || cmd.accepted === 0 || (l.stop_list || []).length < 2 ? "disabled" : ""}>${ico("follow", "sm")}${t("line_travel")}</button>`}${music.el && !travel.active ? `<button class="btn" id="line-music-off">${ico("stop", "sm")}${t("cam_music_off")}</button>` : ""}</div>
      <p class="muted">${l.stop_names.map(esc).join(" → ") || t("unknown_stops")}${l.custom_filters ? ` · <span class="chip">${t("custom_filters")}</span>` : ""}${l.reservation_priority > 1 ? ` · ${ico(l.reservation_priority >= 3 ? "prio_very_high" : "prio_high", "sm")}${t("priority")} ${t("prio_" + Math.min(3, Math.round(l.reservation_priority)))}` : ""}</p>
      <table class="kv">${l.capacities.map(c => `<tr><td>${cargoIcon(c)}${esc(cargoName(c.cargo))}</td><td>${bar(c.used, c.capacity, fillCls(pct(c.used, c.capacity)), `${Math.round(c.used)} / ${Math.round(c.capacity)}`)}</td></tr>`).join("")}
        <tr><td>${t("th_headway")}</td><td>${headway(l.max_frequency)}</td></tr>
        <tr><td>${t("det_throughput")}</td><td>${int(l.throughput)}</td></tr>
        <tr><td>${t("det_vehicles")}</td><td>${int(l.vehicles)}${l.live ? ` <span class="muted">· ${int(l.live.en_route)} ${t("state.EN_ROUTE").toLowerCase()} · ${kmh(l.live.speed)}</span>` : ""}</td></tr>
        ${carriesPax(l) ? `<tr><td>${t("det_on_line")}</td><td>${int(l.persons_on_line)}</td></tr><tr><td>${t("th_pax_unhappy")}</td><td>${l.pax_total ? barQuality(l.pax_bad || 0, l.pax_total) : "–"}${l.pax_avg_quality != null && l.pax_total ? ` <span class="muted">${t("det_quality").toLowerCase()} ${Math.round(l.pax_avg_quality * 100)} %</span>` : ""}</td></tr>` : ""}
        ${carriesCargo(l) ? `<tr><td>${t("th_cargo_late")}</td><td>${l.cargo_total ? barQuality(l.cargo_bad || 0, l.cargo_total) : "–"}${l.cargo_avg_quality != null && l.cargo_total ? ` <span class="muted">${t("det_quality").toLowerCase()} ${Math.round(l.cargo_avg_quality * 100)} %</span>` : ""}</td></tr>` : ""}
      </table>
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
        { key: "carries", label: t("th_carries"), gauge: true, noicon: true, render: v => onBoard(v, "sm"), sortValue: v => Array.isArray(v.cargo) && v.cargo.length ? cargoName(v.cargo[0].cargo) : null },
        { key: "load", label: t("th_load"), gauge: true, num: true, render: v => v.capacity ? bar(v.load || 0, v.capacity, fillCls(pct(v.load || 0, v.capacity)), `${v.load ?? 0}/${v.capacity}`) : int(v.load), sortValue: v => v.capacity ? (v.load || 0) / v.capacity : null },
        { key: "maintenance", label: t("th_cond_short"), gauge: true, num: true, render: v => v.maintenance == null ? "–" : condIcon(v.maintenance) + bar(v.maintenance, 1, maintCls(v.maintenance)) },
        { key: "act", label: "", render: v => entBtns(v.vehicle_id, { follow: true }) },
      ];
      const tbl = document.createElement("table"); tbl.className = "data"; tbl.id = "line-veh-table"; $("#line-veh-wrap").appendChild(tbl);
      renderTable(tbl, vcols, h.vehicles, { id: "vehicle_id", defaultSort: "stop_index", onRow: (vid) => { state.selVeh = +vid; showTab("vehicles"); } });
    }
    if (keepStops) $("#line-stops-wrap").replaceWith(keepStops); else renderStops(l, $("#line-stops-wrap"));
    const hist = h.history || [], labels = hist.map(x => dateLabel(x));
    // throughput = the game's "transported per year" figure of the line window, on the right axis next to vehicles
    const s1 = [{ name: t("kpi_vehicles"), values: hist.map(x => x.vehicles), color: "#4f8a8a", step: true }];
    if (carriesPax(l)) s1.push({ name: t("th_onboard"), values: hist.map(x => x.persons_on_line), axis: "right", color: "#58a6ff", area: true });
    s1.push({ name: t("line_throughput"), values: hist.map(x => x.throughput), axis: "right", color: "#e8b04b", dash: [5, 4] });
    Charts.lineChart($("#chart-line-1"), s1, labels, { rightAxis: true, zeroBase: true, ...tsOpts(hist, "line") });
    // quality: the game's average rating (0..1, as in the line window) alongside the share of unhappy / late
    const s2 = [];
    if (carriesPax(l)) s2.push({ name: t("th_pax_unhappy"), values: hist.map(x => x.pax_total ? pct(x.pax_bad, x.pax_total) : null), color: "#d62560", unit: "%" },
      { name: t("line_pax_rating"), values: hist.map(x => x.pax_avg_quality != null && x.pax_total ? x.pax_avg_quality * 100 : null), color: "#58a6ff", dash: [5, 4], unit: "%" });
    if (carriesCargo(l)) s2.push({ name: t("th_cargo_late"), values: hist.map(x => x.cargo_total ? pct(x.cargo_bad, x.cargo_total) : null), color: "#e8b04b", unit: "%" },
      { name: t("line_cargo_rating"), values: hist.map(x => x.cargo_avg_quality != null && x.cargo_total ? x.cargo_avg_quality * 100 : null), color: "#bc8cff", dash: [5, 4], unit: "%" });
    Charts.lineChart($("#chart-line-2"), s2, labels, { percent: true, ...tsOpts(hist, "line") });
    $("#line-on-map").addEventListener("click", () => { map.lineFilter = id; showTab("map"); });
    musicTracks();  // prefetch, so "Any" can pick a track synchronously inside the click
    $("#line-travel").addEventListener("click", async (e) => { if (e.currentTarget.dataset.stop) stopTravelling(); else { trvDraft({ kind: "line", line: l.line_id }); await lineTravelling(l, trv.draft); } renderLineDetail(id); });
    const mo = $("#line-music-off"); if (mo) mo.addEventListener("click", () => { musicStop(); renderLineDetail(id); });
    bindActions(el);
  }
  // Travelling along a line = a tour of its vehicles, driven by the mod with live positions (camera_tour):
  // one path built by the mod from the stops (route sent here) + the vehicles' positions at that moment; the
  // dashboard derives altitude and speed from the size of the line and the travelling preferences.
  async function lineTravelling(l, prefs) {
    prefs = prefs || travelPrefs();
    // audio may only start inside the click (no await before play): the music starts first, with a provisional
    // duration, and is dropped again if the line turns out to have no route
    musicStart({ ...prefs, dur: 120 });  // provisional; the real duration is set by musicRetime below
    // the route = the stops of the line in order (map data)
    const findRoute = () => { const ml = map.data && (map.data.lines || []).find(x => x.line_id === l.line_id); return ml ? ml.points.map(p => ({ x: p[0], y: p[1] })) : []; };
    let route = findRoute();
    // no map yet, or a line whose stops were not all known when the map was fetched: fetch it again once
    if (route.length < 2) { try { map.data = await api("/api/map"); route = findRoute(); } catch (e) { musicStop(); return; } }
    if (route.length < 2) { musicStop(); $("#cmd-status").textContent = t("line_travel_noroute"); $("#cmd-status").className = "cmdstatus bad"; return; }
    // along the network when the legs are known: the ground track = the legs' polylines chained in stop
    // order, thinned to ~every 60 m (the mod bends through the points), with the stops marked; the mod then flies
    // the rails / roads instead of the straight stop-to-stop route
    const stopsAlong = findRoute();
    let stops = null;
    const legs = linePolylines(l.line_id);
    if (legs && legs.length) {
      const track = [], marks = [];
      const push = (p) => { const q = track[track.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 60) track.push(p); };
      legs.forEach(leg => { marks.push(track.length); leg.pts.forEach(push); });
      if (track.length > 2) { route = track.map(p => ({ x: p[0], y: p[1] })); stops = marks; }
    }
    // the mod builds ONE path from the stops + the vehicles' positions at this moment and derives the altitude from
    // the size of the line; amp scales that altitude, the duration preference sets the speed (full loop in dur x 4 s
    // at x1: 10 km of line in ~80 s at the 20 s setting), loop replays it
    const closed = stops ? (() => { const a = route[0], b = route[route.length - 1]; return Math.hypot(a.x - b.x, a.y - b.y) < 200; })() : route.length > 2;
    const len = route.reduce((a, p, i) => i ? a + Math.hypot(p.x - route[i - 1].x, p.y - route[i - 1].y) : 0, 0) + (closed ? Math.hypot(route[0].x - route[route.length - 1].x, route[0].y - route[route.length - 1].y) : 0);
    const xs = stopsAlong.map(p => p.x), ys = stopsAlong.map(p => p.y), span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    // altitude: 15 % of the span, 250..900 m (a 2-stop shuttle 4 km long is seen from 600 m, not 1700), x amp
    const alt = Math.max(250, Math.min(900, span * 0.15)) * prefs.amp;
    // speed = apparent motion: a sixteenth of the altitude per second whatever the length (seen from 600 m, 37 m/s
    // reads as a calm helicopter; the former alt/8 = 75 m/s with the camera diving over every stop was nauseating);
    // the duration preference can only speed it up, and never beyond alt/6
    const speed = Math.min(alt / 6, Math.max(alt / 16, len / Math.max(20, prefs.dur * 4))), dur = len / speed;
    sendCmd("camera_tour", { line: l.line_id, route, stops, closed, alt, speed, loop: prefs.loop });
    travel.active = { kind: "line", id: l.line_id, points: route.concat(closed ? [route[0]] : []).map(p => ({ ...p, dist: 0, angle: 0, pitch: 0 })), loop: prefs.loop, at: Date.now(), dur };  // dist 0 = eye drawn on the route itself
    if (camViews.cur) camViews.cur.path = { playing: true, progress: 0, loop: prefs.loop, n: stopsAlong.length };
    musicRetime(dur);
    renderCamViews(); renderTravellings(); if (map.data) drawMap($("#map"));
  }

  // ------------------------------------------------------------ line: stops editor + bulk actions
  const LOAD_MODE_ICON = ["load_available", "load_full_any", "load_full_all"];
  const waitLabel = (v) => v == null ? "–" : v < 0 ? t("wait_unlimited") : t("wait_s", { n: Math.round(v) });
  const lineBulkBtns = (l, nveh) => {
    const off = !cmd.enabled || cmd.accepted === 0 || !nveh;
    const b = (name, icon, label, extra = "", confirmMsg = "") => `<button class="btn act ${extra}" data-cmd="${name}" data-veh="${l.line_id}" ${confirmMsg ? `data-confirm="${esc(confirmMsg)}"` : ""} ${off ? "disabled" : ""}>${ico(icon, "sm")}${esc(label)}</button>`;
    return b("line_stop_all", "stop", t("line_stop_all"), "danger", t("confirm_stop_all", { n: nveh })) + b("line_start_all", "play_1", t("line_start_all")) + b("line_all_to_depot", "to_depot", t("line_all_to_depot"), "danger", t("confirm_all_depot", { n: nveh }))
      + `<button class="btn act" data-cmd="horn" data-veh="${l.line_id}" data-line="${l.line_id}" ${off ? "disabled" : ""}>${ico("noise", "sm")}${esc(t("act_horn_all"))}</button>`;
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
    // one compact line per stop: # | name | cargo | terminals | mode | waits | edit
    // every terminal of the station is shown, like the game: ★ preferred, alternatives, the others dimmed (unused)
    const termBadges = (st) => {
      const terms = st.terminals || []; if (!terms.length) return '<span class="muted">–</span>';
      const { main, alts } = termUsage(st);
      return `<span class="termbadges">${terms.map(x => {
        const isMain = termKey(x) === main, isAlt = alts.has(termKey(x)), bad = x.compatible === false, short = !!x.overlength;
        const tip = `${t("term_summary", { main: x.n })} · ${isMain ? t("term_main") : isAlt ? t("term_alt") : t("term_unused")}${bad ? " · " + t("term_incompatible") : ""}${short ? " · " + t("term_too_short") : ""}`;
        return `<span class="tg-n ${isMain ? "main" : isAlt ? "alt" : "off"} ${(isMain || isAlt) && (bad || short) ? "warn" : ""}" title="${esc(tip)}">${x.n}${isMain ? ico("star", "sm") : ""}</span>`; }).join("")}</span>`;
    };
    // waiting at the stop for this line (the figure of the game's line window): icon + count, red when some are unhappy
    const ctById = new Map(cts.map(c => [c.cargo_id, c]));
    const waiting = (st) => {
      const w = st.waiting || []; if (!w.length) return '<span class="muted">–</span>';
      return w.map(x => { const c = ctById.get(x.cargo_type); return `<span class="chip ${x.bad ? "bad" : ""}" title="${esc(c ? c.name : x.cargo_type)}: ${x.total}${x.bad ? ` (${t("waiting_bad", { n: x.bad })})` : ""}">${cargoIcon({ cargo: c && c.name, cargo_key: c && c.key })}${x.total}</span>`; }).join("");
    };
    const viewRow = (st) => `<tr data-stop="${st.stop_index}">
        <td class="num muted">${st.stop_index}</td>
        <td class="wrap">${st.station_group ? `<a class="goto" data-st="${st.station_group}" title="${esc(t("goto_station"))}">${esc(st.name || "?")}</a>` : esc(st.name || "?")}${st.waypoints ? ` <small class="muted" title="${esc(t("waypoints_n", { n: st.waypoints }))}">(+${st.waypoints})</small>` : ""}</td>
        <td class="nowrap">${cargoCell(st)}${st.force_unload ? ` <span class="chip bad" title="${esc(t("force_unload"))}">${ico("line_unload", "sm")}</span>` : ""}</td>
        <td class="nowrap">${termBadges(st)}</td>
        <td class="nowrap">${waiting(st)}</td>
        <td class="center">${st.load_mode == null ? "–" : ico(LOAD_MODE_ICON[st.load_mode] || "load_available", "sm", t("load_mode_" + st.load_mode))}</td>
        <td class="num nowrap">${waits(st)}</td>
        <td class="act">${st.station_group ? entBtns(st.station_group) : ""}<button class="btn iconbtn stop-edit" data-stop="${st.stop_index}" title="${esc(t("edit"))}" ${off ? "disabled" : ""}>${ico("edit", "sm")}</button></td></tr>`;
    const editRow = (st) => {
      const w = (k, v, min) => `<input type="number" class="stop-in" data-k="${k}" min="${min}" max="600" step="5" value="${v == null ? "" : Math.round(v)}" style="width:62px">`;
      return `<tr class="editing" data-stop="${st.stop_index}"><td colspan="8"><div class="stopedit">
        <div><small>${st.stop_index}.</small> <b>${esc(st.name || "?")}</b>
          <div class="stopcargo">${cargoCell(st, Infinity)}</div>
          <label class="muted" style="font-size:12px"><input type="checkbox" class="stop-in" data-k="force_unload" ${st.force_unload ? "checked" : ""}> ${t("force_unload")}</label></div>
        <div class="waitgrid"><label>${t("th_load_mode")}</label><span class="seg lm-seg"><input type="hidden" class="stop-in" data-k="load_mode" value="${st.load_mode ?? ""}">${[0, 1, 2].map(m => `<button type="button" class="lm-btn ${st.load_mode === m ? "active" : ""}" data-m="${m}" title="${esc(t("load_mode_" + m))}">${ico(LOAD_MODE_ICON[m], "sm")}</button>`).join("")}</span>
          <label>${t("th_min_wait")}</label>${w("min_wait", st.min_wait, 0)}<label>${t("th_max_wait")}</label>${w("max_wait", st.max_wait, -1)}<label>${t("th_add_wait")}</label>${w("max_add_wait", st.max_add_wait, 0)}<span></span><small class="muted">-1 = ${t("wait_unlimited")}</small></div>
        ${termGrid(st)}
        <div class="stopbtns"><button class="btn stop-apply" data-stop="${st.stop_index}">${ico("check", "sm")}${t("apply")}</button><button class="btn stop-apply-all" data-stop="${st.stop_index}" title="${esc(t("apply_all_stops"))}">${ico("line_stations", "sm")}${t("apply_all_stops")}</button><button class="btn stop-cancel">${t("cancel")}</button></div>
      </div></td></tr>`;
    };
    root.innerHTML = `${cmdHint()}<table class="data stops"><thead><tr><th class="num">#</th><th>${t("th_stop")}</th><th>${t("th_cargo_filter")}</th><th>${t("terminals")}</th><th>${t("th_waiting")}</th><th class="center">${t("th_load_mode")}</th><th class="num" title="${esc(t("th_min_wait"))} / ${esc(t("th_max_wait"))}">${t("th_wait_short")}</th><th class="act"></th></tr></thead>
      <tbody>${stops.map(st => (editing === st.stop_index ? editRow(st) : viewRow(st))).join("")}</tbody></table>`;
    bindActions(root);  // camera button and station link of each stop
    $$(".lm-btn", root).forEach(b => b.addEventListener("click", e => {
      e.stopPropagation(); const seg = b.closest(".lm-seg");
      $$(".lm-btn", seg).forEach(x => x.classList.toggle("active", x === b)); $(".stop-in", seg).value = b.dataset.m;
    }));
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
      { key: "name", label: t("th_town"), icon: "town", render: x => esc(x.name) + (x.has_hq ? ` <span class="hqstar" title="${esc(t("town_hq"))}">${ico("star", "sm")}</span>` : "") },
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
    renderTable($("#towns-table"), cols, towns, { empty: { icon: "town", text: t("empty_towns") }, id: "town_id", defaultSort: "size", defaultAsc: false, onRow: (id, tr) => { state.selTown = +id; $$("tr", tr.parentElement).forEach(x => x.classList.toggle("sel", x === tr)); renderTownDetail(+id); }, rowClass: x => (x.town_id === state.selTown ? "sel" : "") });
    if (state.selTown) renderTownDetail(state.selTown);
  }

  async function renderTownDetail(id) {
    const tw = (state.cache.towns || []).find(x => x.town_id === id); if (!tw) return;
    const h = await api("/api/town_history", { id, limit: settings.history, range: settings.range });
    const hap = [[t("hap_inside"), tw.hap_inside_unhappy, tw.hap_inside_total], [t("hap_res_out"), tw.hap_from_res_unhappy, tw.hap_from_res_total], [t("hap_res_in"), tw.hap_to_res_unhappy, tw.hap_to_res_total], [t("hap_visitors"), (tw.hap_to_nonres_unhappy || 0) + (tw.hap_from_nonres_unhappy || 0), (tw.hap_to_nonres_total || 0) + (tw.hap_from_nonres_total || 0)], [t("hap_car"), tw.hap_car_unhappy, tw.hap_car_total], [t("hap_walk"), tw.hap_walk_unhappy, tw.hap_walk_total]];
    $("#town-detail").innerHTML = `<h2>${ico("town", "lg")}${esc(tw.name)}${tw.has_hq ? ` <span class="hqstar" title="${esc(t("town_hq"))}">${ico("star", "sm")}</span>` : ""} <small>#${tw.town_id} · ${tw.area_km2 != null ? num(tw.area_km2, 2) + " km²" : ""}</small></h2>
      <div class="actions"><button class="btn act" data-cmd="focus_entity" data-veh="${tw.town_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("camera", "sm")}${t("act_focus")}</button><button class="btn act" data-cmd="select_entity" data-veh="${tw.town_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("select", "sm")}${t("act_select")}</button></div>
      <table class="kv">
        <tr><td>${t("residential")} · ${t("commercial").toLowerCase()} · ${t("industrial").toLowerCase()}</td><td>${[["used_res", "cap_res"], ["used_com", "cap_com"], ["used_ind", "cap_ind"]].map(([u, c]) => `<span class="mono">${int(tw[u])}/${int(tw[c])}</span>`).join(" · ")}</td></tr>
        <tr><td>${t("th_stations")} · ${t("det_area").toLowerCase()}</td><td>${int(tw.stations)} · ${tw.area_km2 != null ? num(tw.area_km2, 2) + " km²" : "–"} ${tw.development_active ? `<span class="chip ok">${t("det_dev_active")}</span>` : `<span class="chip warn">${t("det_dev_inactive")}</span>`}</td></tr>
        <tr><td>${t("pt_share")}</td><td>${tw.line_usage != null ? bar(tw.line_usage, 1, "", Math.round(tw.line_usage * 100) + " %") : "–"}</td></tr>
        <tr><td>${t("det_traffic")}</td><td>${kmh(tw.traffic_speed)}</td></tr>
        <tr><td>${ico("noise", "sm")}${t("det_noise")} · ${ico("pollution", "sm")}${t("det_pollution").toLowerCase()}</td><td>${tw.noise_db != null ? num(tw.noise_db, 0) + " dB" : "–"} · <span title="${esc(t("th_pollution_title"))}">${tw.pollution_db != null ? num(tw.pollution_db, 0) : "–"}</span></td></tr>
      </table>
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
    const d = await api("/api/industries"); const inds = d.industries || []; state.cache.industries = inds;
    if (!state.selInd) { const u = +new URLSearchParams(location.search).get("ind"); if (u && inds.some(i => i.industry_id === u)) state.selInd = u; }  // deep link ?tab=industries&ind=<id>
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
    renderTable($("#ind-table"), cols, rows, { total: inds.length, empty: { icon: "industry", text: t("empty_industries") }, id: "industry_id", defaultSort: "name", onRow: (id, tr) => { state.selInd = +id; $$("tr", tr.parentElement).forEach(x => x.classList.toggle("sel", x === tr)); renderIndustryDetail(+id); }, rowClass: i => (i.industry_id === state.selInd ? "sel" : "") });
    if (state.selInd) renderIndustryDetail(state.selInd);
  }

  // Detail card: yearly figures of each cargo over time (produced vs max, shipped; consumed vs max, delivered),
  // plus level and production rating. Game figures only, same as the industry window.
  const CARGO_COLORS = ["#4f8a8a", "#e8b04b", "#58a6ff", "#bc8cff", "#3fb950", "#d62560", "#f0883e", "#8b98a8"];
  async function renderIndustryDetail(id) {
    const ind = (state.cache.industries || []).find(x => x.industry_id === id); if (!ind) return;
    const h = await api("/api/industry_history", { id, limit: settings.history, range: settings.range });
    const hist = h.history || [], labels = hist.map(x => dateLabel(x));
    // per-cargo series aligned on the history snapshots
    const idx = new Map(hist.map((x, i) => [x.snapshot_id, i]));
    const byKey = new Map();
    for (const c of (h.cargo || [])) {
      const k = c.direction + ":" + c.cargo_id;
      if (!byKey.has(k)) byKey.set(k, { c, a: hist.map(() => null), m: hist.map(() => null), s: hist.map(() => null) });
      const e = byKey.get(k), i = idx.get(c.snapshot_id); if (i == null) continue;
      if (c.direction === "out") { e.a[i] = c.produced_year; e.m[i] = c.max_prod_year; e.s[i] = c.shipped_year; }
      else { e.a[i] = c.consumed_year; e.m[i] = c.max_cons_year; e.s[i] = c.delivered_year; }
    }
    const outs = [...byKey.values()].filter(e => e.c.direction === "out"), ins = [...byKey.values()].filter(e => e.c.direction === "in");
    const status = [ind.producing ? `<span class="chip ok">${t("producing")}</span>` : `<span class="chip bad">${t("halted")}</span>`, ind.closure_time > 0 ? `<span class="chip bad">${t("closing")}</span>` : "", ind.boost_rule || ind.boost_persons ? `<span class="chip info">${t("boost")}</span>` : "", ind.manual ? `<span class="chip warn">${t("manual")}</span>` : ""].join("");
    const kind = (ind.construction || "").replace(/^.*\//, "").replace(/\.con$/, "");
    $("#ind-detail").innerHTML = `<h2>${ico("industry", "lg")}${esc(ind.name)} <small>#${ind.industry_id} · ${esc(kind)}</small></h2>
      <div class="actions"><button class="btn act" data-cmd="focus_entity" data-veh="${ind.industry_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("camera", "sm")}${t("act_focus")}</button><button class="btn act" data-cmd="select_entity" data-veh="${ind.industry_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("select", "sm")}${t("act_select")}</button></div>
      <p>${status}${ind.max_level > 0 ? ` <span class="chip">${t("th_level")} ${ind.level ?? "–"}/${ind.max_level}</span>` : ""}${ind.production_rating != null ? ` <span class="chip">${t("th_yield")} ${Math.round(ind.production_rating * 100)} %</span>` : ""}${ind.thrown_away ? ` <span class="chip warn">${t("det_thrown")} ${int(ind.thrown_away)}</span>` : ""}${ind.closure_time > 0 ? ` <span class="chip bad">${t("det_closure")} ${int(ind.closure_time)}</span>` : ""}</p>
      <table class="kv">${(ind.cargo || []).map(c => { const out = c.direction === "out", a = out ? c.produced_year : c.consumed_year, m = out ? c.max_prod_year : c.max_cons_year, sh = out ? c.shipped_year : c.delivered_year;
        return `<tr><td>${cargoChip(c)} <small class="muted">${out ? t("th_outputs") : t("th_inputs")}</small></td><td>${m != null || a != null ? `${bar(a || 0, m || 0, "", `${int(a)}/${int(m)}`)} <small class="muted" title="${esc(out ? t("shipped") : t("delivered"))}">${ico(out ? "cargo_supplied" : "cargo_received", "sm")}${int(sh)}</small>` : ""}${c.capacity != null ? ` <span class="pile" title="${esc(t("det_piles"))}">${ico("stock_full", "sm")}<span class="mono">${int(c.stock)}/${int(c.capacity)}</span></span>` : ""}</td></tr>`; }).join("")}</table>
      ${outs.length ? `<h2>${ico("cargo_supplied")}${t("th_outputs")}</h2><canvas id="chart-ind-out" data-h="170"></canvas>` : ""}
      ${ins.length ? `<h2>${ico("cargo_received")}${t("th_inputs")}</h2><canvas id="chart-ind-in" data-h="170"></canvas>` : ""}
      <h2>${ico("production")}${t("ind_level_rating")}</h2><canvas id="chart-ind-lvl" data-h="130"></canvas>`;
    bindActions($("#ind-detail"));
    const tx = tsOpts(hist, "ind");
    // one colour per cargo: solid = produced/consumed, dashed = shipped/delivered, faint = yearly maximum
    const cargoSeries = (list, aName, sName) => list.flatMap((e, i) => { const col = CARGO_COLORS[i % CARGO_COLORS.length], n = cargoName(e.c.cargo); return [
      { name: `${n} · ${aName}`, values: e.a, color: col },
      { name: `${n} · ${sName}`, values: e.s, color: col, dash: [5, 4] },
      { name: `${n} · ${t("ind_max")}`, values: e.m, color: col + "55", dash: [2, 4] },
    ]; });
    if (outs.length) Charts.lineChart($("#chart-ind-out"), cargoSeries(outs, t("ind_produced"), t("shipped")), labels, { zeroBase: true, ...tx });
    if (ins.length) Charts.lineChart($("#chart-ind-in"), cargoSeries(ins, t("ind_consumed"), t("delivered")), labels, { zeroBase: true, ...tx });
    Charts.lineChart($("#chart-ind-lvl"), [
      { name: t("th_yield"), values: hist.map(x => x.production_rating != null ? x.production_rating * 100 : null), color: "#3fb950", unit: "%" },
      { name: t("th_level"), values: hist.map(x => x.level), color: "#bc8cff", axis: "right", step: true },
    ], labels, { percent: true, rightAxis: true, rightUnit: "", ...tx });
  }

  // ------------------------------------------------------------ stations & depots
  async function renderStations() {
    const [s, d] = await Promise.all([api("/api/stations"), api("/api/depots")]);
    const stations = s.stations || []; state.cache.stations = stations;
    if (!state.selSt) { const u = +new URLSearchParams(location.search).get("st"); if (u && stations.some(x => x.station_id === u)) state.selSt = u; }  // deep link ?tab=stations&st=<id>
    renderTable($("#st-table"), [
      { key: "name", label: t("th_station"), render: x => `${stKind(x).icons("sm")}${esc(x.name)}` },
      { key: "town_name", label: t("th_town"), render: x => esc(x.town_name || "–") },
      { key: "is_cargo", label: t("th_type"), render: x => { const k = stKind(x); return (k.pax ? `<span class="chip info">${t("pax")}</span>` : "") + (k.cargo ? `<span class="chip">${t("cargo")}</span>` : ""); } },
      { key: "used", label: t("th_waiting"), num: true },
      { key: "cap", label: t("th_occupancy"), num: true, render: x => { const cap = (x.terminal_capacity || 0) + (x.pool_capacity || 0); return cap ? bar(x.used || 0, cap, pct(x.used, cap) > 90 ? "bad" : pct(x.used, cap) > 70 ? "warn" : "") : "–"; }, sortValue: x => { const cap = (x.terminal_capacity || 0) + (x.pool_capacity || 0); return cap ? (x.used || 0) / cap : null; } },
      { key: "overflow", label: t("th_overflow"), num: true, render: x => x.overflow ? `<span class="chip bad">${x.overflow}</span>` : "0" },
      { key: "lines", label: t("th_lines"), num: true },
      { key: "act", label: "", render: x => entBtns(x.station_id) },
    ], stations, { empty: { icon: "station", text: t("empty_stations"), hint: t("empty_stations_hint") }, id: "station_id", defaultSort: "used", defaultAsc: false, onRow: (id, tr) => { state.selSt = +id; $$("tr", tr.parentElement).forEach(x => x.classList.toggle("sel", x === tr)); renderStationDetail(+id); }, rowClass: x => (x.station_id === state.selSt ? "sel" : "") });
    if (state.selSt) renderStationDetail(state.selSt);
    const DEPOT_ICON = { RAIL: "depot_rail", ROAD: "depot_road", TRAM: "depot_tram", WATER: "depot_water", AIR: "depot_air" };
    renderTable($("#dep-table"), [
      { key: "name", label: t("th_depot"), render: x => `${ico(DEPOT_ICON[x.carrier] || "depot", "sm")}${esc(x.name)}` },
      { key: "carrier", label: t("th_type"), render: x => CA(x.carrier) },
      { key: "vehicles", label: t("th_parked"), num: true },
      { key: "incoming", label: t("th_incoming"), num: true },
      { key: "maintenance_pool", label: t("th_maint_pool"), num: true, render: x => x.maintenance_pool == null ? "–" : t("pool_fmt", { avg: num(x.pool_avg, 1), max: num(x.pool_max, 0), n: x.maintenance_pool }) },
      { key: "act", label: "", render: x => entBtns(x.depot_id) },
    ], d.depots || [], { empty: { icon: "depot", text: t("empty_depots") }, defaultSort: "name" });
  }

  // Detail card: waiting items against the capacity (platforms + storage) and the overflow over time, plus the lines
  // calling at the station. Game figures only, as in the station window.
  async function renderStationDetail(id) {
    const st = (state.cache.stations || []).find(x => x.station_id === id); if (!st) return;
    const h = await api("/api/station_history", { id, limit: settings.history, range: settings.range });
    const hist = h.history || [], labels = hist.map(x => dateLabel(x)), lines = h.lines || [];
    const cap = (st.terminal_capacity || 0) + (st.pool_capacity || 0);
    $("#st-detail").innerHTML = `<h2>${stKind(st).icons("lg")}${esc(st.name)} <small>#${st.station_id}${st.town_name ? " · " + esc(st.town_name) : ""}</small></h2>
      <div class="actions"><button class="btn act" data-cmd="focus_entity" data-veh="${st.station_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("camera", "sm")}${t("act_focus")}</button><button class="btn act" data-cmd="select_entity" data-veh="${st.station_id}" ${!cmd.enabled || cmd.accepted === 0 ? "disabled" : ""}>${ico("select", "sm")}${t("act_select")}</button></div>
      <table class="kv"><tr><td>${t("th_waiting")}</td><td>${int(st.used)}${cap ? ` / ${int(cap)} ${bar(st.used || 0, cap, pct(st.used, cap) > 90 ? "bad" : pct(st.used, cap) > 70 ? "warn" : "")}` : ""}</td></tr>
        <tr><td>${t("st_capacity_split")}</td><td>${t("st_capacity_fmt", { t: int(st.terminal_capacity), p: int(st.pool_capacity) })}</td></tr>
        <tr><td>${t("th_overflow")}</td><td>${st.overflow ? `<span class="chip bad">${st.overflow}</span>` : "0"}</td></tr>
        <tr><td>${t("det_group")}</td><td class="mono">#${st.station_group ?? "–"}${st.lines != null ? ` <span class="muted">· ${int(st.lines)} ${t("det_lines").toLowerCase()}</span>` : ""}</td></tr></table>
      <h2>${ico("line")}${t("th_lines")} <small>${lines.length}</small></h2>
      ${lines.length ? `<div class="minilist">${lines.map(l => `<div class="row goto" data-line="${l.line_id}" title="${esc(t("tab_lines"))}"><span class="n"><span class="swatch" style="background:${rgb(l.color_r, l.color_g, l.color_b)}"></span>${lineTypeIcon(l)}${esc(l.name || "#" + l.line_id)}</span><span class="r">${ico("line", "sm")}</span></div>`).join("")}</div>` : `<p class="muted">${t("none_m")}</p>`}
      <h2 style="margin-top:12px">${ico("terminal_full")}${t("st_waiting_history")}</h2><canvas id="chart-st-1" data-h="170"></canvas>`;
    bindActions($("#st-detail"));  // also binds the .goto[data-line] rows
    Charts.lineChart($("#chart-st-1"), [
      { name: t("th_waiting"), values: hist.map(x => x.used), color: "#4f8a8a", area: true },
      { name: t("th_capacity"), values: hist.map(x => (x.terminal_capacity || 0) + (x.pool_capacity || 0) || null), color: "#8b98a8", dash: [4, 4] },
      { name: t("th_overflow"), values: hist.map(x => x.overflow), color: "#d62560", step: true },
    ], labels, { zeroBase: true, ...tsOpts(hist, "st") });
  }

  // ------------------------------------------------------------ finance (secondary)
  // ---- the game's accounting journal. Keys are the engine's "type/maintenance/construction" numbers,
  // checked line by line against the Finances window (see docs). Carriers: 0 road 1 rail 2 tram 3 other 4 air 5 water.
  const JOURNAL_CARRIERS = [[0, "ROAD"], [1, "RAIL"], [2, "TRAM"], [5, "WATER"], [4, "AIR"], [3, "OTHER"]];
  const JOURNAL_LINES = [  // in the game's order within a carrier
    ["4/0/6", "journal_running"], ["4/3/6", "journal_maint_vehicles"], ["4/1/0", "journal_upkeep_roads"], ["4/1/1", "journal_upkeep_tracks"],
    ["4/1/6", "journal_upkeep_buildings"], ["4/1/7", "journal_upkeep_warehouses"], ["5/2/6", "journal_income"], ["7/2/6", "journal_other"],
  ];
  const JOURNAL_INVEST = [["3/2/6", "journal_buy_vehicles"], ["2/2/0", "journal_build_roads"], ["2/2/1", "journal_build_tracks"], ["2/2/6", "journal_build_buildings"], ["2/2/7", "journal_other"]];
  const journalUi = { view: "window", open: new Set(["1"]), data: null, history: null };
  // the game prints "$-35,6 M": sign after the currency, one decimal, K / M / B
  const moneyGame = (n) => {
    if (n == null) return "–";
    const a = Math.abs(n), sgn = n < 0 ? "-" : "";
    const num = (v, d) => v.toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d });
    if (a >= 1e9) return `$${sgn}${num(a / 1e9, 2)} B`;
    if (a >= 1e6) return `$${sgn}${num(a / 1e6, a >= 1e7 ? 1 : 2)} M`;
    if (a >= 1e3) return `$${sgn}${num(a / 1e3, 0)} K`;
    return `$${sgn}${num(a, 0)}`;
  };
  $$("#journal-view button").forEach(b => b.addEventListener("click", async () => { journalUi.view = b.dataset.v; journalUi.scrolled = null; $$("#journal-view button").forEach(x => x.classList.toggle("active", x === b)); journalUi.data = await api("/api/journal", { view: journalUi.view }); renderJournalTable(); }));
  function renderJournalTable() {
    const j = journalUi.data, tbl = $("#journal-table");
    if (!j || !j.cols.length) { tbl.innerHTML = `<tr><td class="empty">${t("no_data_yet")}</td></tr>`; return; }
    const n = j.cols.length, idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    const L = j.lines, zero = new Array(n).fill(0);
    const row = (vals) => vals || zero;
    const cells = (vals, strong) => idx.map(i => { const v = row(vals)[i]; return `<td class="${v === 0 ? "zero" : v < 0 ? "neg" : "pos"}">${moneyGame(v)}</td>`; }).join("");
    const sum = (keys) => { const out = new Array(n).fill(0); keys.forEach(k => (L[k] || []).forEach((v, i) => out[i] += v)); return out; };
    let h = `<thead><tr><th></th>${idx.map(i => `<th>${esc(j.cols[i].label)}</th>`).join("")}</tr></thead><tbody>`;
    // transport, one block per carrier with lines in the game's order; carriers without a single entry are skipped
    JOURNAL_CARRIERS.forEach(([c, name]) => {
      const keys = JOURNAL_LINES.map(([k]) => `transport/${c}/${k}`).filter(k => L[k]);
      if (!keys.length) return;
      const open = journalUi.open.has(String(c));
      h += `<tr class="carrier ${open ? "open" : ""}" data-c="${c}"><td><span class="chev"></span>${ico(ICON_BY_CARRIER[name])}${CA(name)}</td>${cells(sum(keys))}</tr>`;
      if (open) JOURNAL_LINES.forEach(([k, label]) => { const key = `transport/${c}/${k}`; if (L[key]) h += `<tr class="detail"><td>${t(label)}</td>${cells(L[key])}</tr>`; });
    });
    // investments, only the lines that exist
    const inv = JOURNAL_INVEST.filter(([k]) => L[`investment/${k}`]);
    if (inv.length) {
      const open = journalUi.open.has("inv");
      h += `<tr class="carrier ${open ? "open" : ""}" data-c="inv"><td><span class="chev"></span>${ico("station")}${t("journal_investments")}</td>${cells(sum(inv.map(([k]) => `investment/${k}`)))}</tr>`;
      if (open) inv.forEach(([k, label]) => h += `<tr class="detail"><td>${t(label)}</td>${cells(L[`investment/${k}`])}</tr>`);
    }
    h += `<tr class="section"><td colspan="${idx.length + 1}">${t("journal_summary")}<i></i></td></tr>`;
    h += `<tr class="summary strong"><td>${t("journal_income")}</td>${cells(L.total)}</tr>`;
    const loansOpen = journalUi.open.has("loan");
    h += `<tr class="carrier ${loansOpen ? "open" : ""}" data-c="loan"><td><span class="chev"></span>${ico("money")}${t("journal_loans")}</td>${cells(sum(["loanBorrowing", "loanRepayment", "interest"]))}</tr>`;
    if (loansOpen) { h += `<tr class="detail"><td>${t("journal_new_loans")}</td>${cells(L.loanBorrowing)}</tr><tr class="detail"><td>${t("journal_repay")}</td>${cells(L.loanRepayment)}</tr><tr class="detail"><td>${t("journal_interest")}</td>${cells(L.interest)}</tr>`; }
    h += `<tr class="summary"><td>${t("journal_bank")}</td>${cells(L.balance)}</tr>`;
    h += `<tr class="summary"><td>${t("journal_debt")}</td>${cells(L.loan)}</tr></tbody>`;
    tbl.innerHTML = h;
    $$("tr.carrier", tbl).forEach(tr => tr.addEventListener("click", () => { const c = tr.dataset.c; if (journalUi.open.has(c)) journalUi.open.delete(c); else journalUi.open.add(c); renderJournalTable(); }));
    $("#journal-range").textContent = t("journal_periods", { n, a: j.cols[0].label, b: j.cols[n - 1].label });
    const wrap = tbl.parentElement; if (wrap && !journalUi.scrolled) { wrap.scrollLeft = wrap.scrollWidth; journalUi.scrolled = journalUi.view; }  // like the game: the latest periods first
  }

  async function renderFinance(o) {
    const fin = await api("/api/finance", { limit: Math.max(600, settings.history), range: settings.range });
    const ser = fin.series || [], labels = ser.map(x => dateLabel(x));
    const tx = tsOpts(ser, "fin");
    // journal: the game's table (the view the user picked) and, as curves, the whole-game history: one point per
    // engine column placed at the START of its period on a game-time axis (months), labelled with the engine's header
    const [jt, jh] = await Promise.all([api("/api/journal", { view: journalUi.view }), api("/api/journal", { view: "history" })]);
    journalUi.data = jt; journalUi.history = jh; renderJournalTable();
    const hc = (jh.cols || []).filter(c => c.start != null), hl = hc.map(c => c.label), hx = hc.map(c => c.start * 2629800);  // months -> "seconds" so the axis is monotonic
    const pick = (name) => hc.map(c => (jh.lines && jh.lines[name] || [])[c.col]);
    const monthName = (c) => { const y = Math.floor(c.start / 12), m = Math.floor(c.start % 12); return c.end - c.start >= 12 ? String(y) : `${m + 1}/${String(y).slice(-2)}`; };
    const xg = hc.map(monthName);
    Charts.lineChart($("#chart-balance"), [
      { name: t("journal_bank"), values: pick("balance"), color: "#4f8a8a", area: true, unit: "$" },
      { name: t("journal_debt"), values: pick("loan"), color: "#d62560", dash: [6, 4], unit: "$" },
    ], hl, { unit: "$", ts: hx, xGame: xg, gameOnly: true });
    Charts.lineChart($("#chart-earn"), [{ name: t("journal_total"), values: pick("total"), color: "#e8b04b", area: true, unit: "$", step: true }], hl, { zeroBase: true, unit: "$", ts: hx, xGame: xg, gameOnly: true });
    Charts.lineChart($("#chart-transport"), [
      { name: t("passengers"), values: ser.map(x => x.passengers_transported), color: "#58a6ff" },
      { name: t("cargo"), values: ser.map(x => x.cargo_transported), color: "#e8b04b", axis: "right" },
    ], labels, { rightAxis: true, zeroBase: true, ...tx });
    // company figures (slow export): network size and company value over the same range
    const comp = fin.company || [], clabels = comp.map(x => dateLabel(x)), ctx = tsOpts(comp, "fin");
    Charts.lineChart($("#chart-network"), [
      { name: t("tracks"), values: comp.map(x => x.track_length_m != null ? x.track_length_m / 1000 : null), color: "#4f8a8a", unit: "km" },
      { name: t("roads"), values: comp.map(x => x.road_length_m != null ? x.road_length_m / 1000 : null), color: "#e8b04b", unit: "km" },
      { name: t("lines"), values: comp.map(x => x.number_of_lines), color: "#58a6ff", axis: "right", step: true },
      { name: t("stations"), values: comp.map(x => x.total_stations), color: "#bc8cff", axis: "right", step: true },
    ], clabels, { rightAxis: true, zeroBase: true, unit: "km", rightUnit: "", ...ctx });
    Charts.lineChart($("#chart-company"), [
      { name: t("score"), values: comp.map(x => x.total_score), color: "#3fb950" },
      { name: t("assets"), values: comp.map(x => x.total_assets), color: "#4f8a8a", axis: "right", unit: "$" },
      { name: t("debt"), values: comp.map(x => x.debt), color: "#d62560", axis: "right", dash: [6, 4], unit: "$" },
    ], clabels, { rightAxis: true, zeroBase: true, rightUnit: "$", ...ctx });
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
  // the overview (snapshot.camera); recalling a view sends set_camera to the game.
  const camViews = { list: [], loaded: false, cur: null, game: null };  // game = key of the savegame the list belongs to
  const fmtCam = (c) => c ? `x ${Math.round(c.x)} · y ${Math.round(c.y)} · ${Math.round(c.dist)} m · ${Math.round(c.angle * 180 / Math.PI)}° / ${Math.round(c.pitch * 180 / Math.PI)}°` : "";
  // "the camera is on this view": same target within 5 % of the distance, same zoom within 10 %, same heading/pitch within ~6°
  const angDiff = (a, b) => { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
  const sameView = (a, b) => !!(a && b) && Math.hypot(a.x - b.x, a.y - b.y) < Math.max(15, b.dist * 0.05) && Math.abs(a.dist - b.dist) < Math.max(10, b.dist * 0.1) && angDiff(a.angle, b.angle) < 0.1 && Math.abs(a.pitch - b.pitch) < 0.1;
  // a view attached to a vehicle is "active" while the camera follows that vehicle (its position moves)
  const activeView = () => camViews.list.find(v => v.follow ? (camViews.cur && camViews.cur.follow === v.follow) : sameView(camViews.cur, v)) || null;
  // a view attached to a vehicle, resolved to where the vehicle is NOW (map data); null when the vehicle is unknown
  function liveView(v) {
    if (!v.follow) return v;
    const veh = map.data && (map.data.vehicles || []).find(x => x.vehicle_id === v.follow);
    return veh && veh.x != null ? { ...v, x: veh.x, y: veh.y } : null;
  }
  function gotoView(v) { return v.follow ? sendCmd("follow_view", { entity: v.follow, dist: v.dist, angle: v.angle, pitch: v.pitch }) : sendCmd("set_camera", { x: v.x, y: v.y, dist: v.dist, angle: v.angle, pitch: v.pitch }); }
  // travelling preferences, this browser only: { dur, loop, move, dir, amp, music, vol }
  const TRAVEL_DEFAULTS = { dur: 20, loop: false, move: "orbit", dir: 1, amp: 1, music: "auto", vol: 0.6 };
  const travelPrefs = () => { try { return Object.assign({}, TRAVEL_DEFAULTS, JSON.parse(localStorage.getItem("tf3.travel") || "{}")); } catch (e) { return { ...TRAVEL_DEFAULTS }; } };
  const saveTravelPrefs = (p) => localStorage.setItem("tf3.travel", JSON.stringify(p));
  // Movements around ONE view (the view is the subject; the game's orbit camera is centre + distance + heading +
  // pitch, so a travelling is a curve in those four numbers). Each returns the camera_path points + whether the
  // mod should ease every leg (no: the generated points are dense, easing is baked into the sampling).
  const TRAVEL_MOVES = {
    // full turn around the centre, distance and pitch kept; amp = fraction of a turn (1 = 360°)
    orbit: (v, p) => { const n = Math.max(8, Math.round(36 * p.amp)); const pts = []; for (let i = 0; i <= n; i++) { const a = v.angle + p.dir * 2 * Math.PI * p.amp * i / n; pts.push({ x: v.x, y: v.y, dist: v.dist, angle: a, pitch: v.pitch }); } return pts; },
    // dolly: from far (amp × dist) down to the view (dir = 1) or away from it (dir = -1), eased
    dolly: (v, p) => { const n = 24, far = v.dist * (1 + 2 * p.amp); const pts = []; for (let i = 0; i <= n; i++) { let t = i / n; t = t * t * (3 - 2 * t); const d = p.dir > 0 ? far + (v.dist - far) * t : v.dist + (far - v.dist) * t; pts.push({ x: v.x, y: v.y, dist: d, angle: v.angle, pitch: v.pitch }); } return pts; },
    // flyover: arrive from high and far, slowly turning, levelling to the view's pitch (dir = -1 leaves instead)
    flyover: (v, p) => { const n = 30, far = v.dist * (1 + 3 * p.amp), hi = Math.min(1.45, v.pitch + 0.6); const pts = []; for (let i = 0; i <= n; i++) { let t = i / n; if (p.dir < 0) t = 1 - t; t = t * t * (3 - 2 * t); pts.push({ x: v.x, y: v.y, dist: far + (v.dist - far) * t, angle: v.angle - 0.6 * (1 - t), pitch: hi + (v.pitch - hi) * t }); } return pts; },
    // sweep: back and forth ±(45° × amp) around the heading, eased at the ends
    sweep: (v, p) => { const n = 32, w = Math.PI / 4 * p.amp; const pts = []; for (let i = 0; i <= n; i++) { const t = i / n; const a = v.angle + p.dir * w * Math.sin(2 * Math.PI * t); pts.push({ x: v.x, y: v.y, dist: v.dist, angle: a, pitch: v.pitch }); } return pts; },
    // spiral: orbit while coming closer (dir = 1) or drifting away
    spiral: (v, p) => { const n = 40, far = v.dist * (1 + 1.5 * p.amp); const pts = []; for (let i = 0; i <= n; i++) { const t = i / n; const d = p.dir > 0 ? far + (v.dist - far) * t : v.dist + (far - v.dist) * t; pts.push({ x: v.x, y: v.y, dist: d, angle: v.angle + 2 * Math.PI * t, pitch: v.pitch }); } return pts; },
  };
  const TRAVEL_MOVE_ICON = { orbit: "reset", dolly: "speed", flyover: "follow", sweep: "reverse", spiral: "line" };
  const travel = { active: null, sel: null };  // { kind: "view"|"chain", id, points } = what we asked the mod to play
  function playTravelling(kind, points, prefs) {
    const loop = prefs.loop && kind !== "dolly" && kind !== "flyover";
    // duration = total, spread over the legs
    const legs = points.length - 1 + (loop ? 1 : 0);
    sendCmd("camera_path", { points: points.map(pt => ({ ...pt, duration: prefs.dur / legs })), loop, ease: false });
    travel.active = { kind, points, loop, at: Date.now(), dur: prefs.dur };
    if (camViews.cur) camViews.cur.path = { playing: true, progress: 0, loop, n: points.length };
    musicStart(prefs);
    renderCamViews(); renderTravellings(); if (map.data) drawMap($("#map"));
  }
  function stopTravelling() {
    sendCmd("camera_stop", {}); travel.active = null; if (camViews.cur) camViews.cur.path = null; musicStop(); renderCamViews(); renderTravellings(); if (map.data) drawMap($("#map"));
  }
  // music on the dashboard side (the game has no "play this file" API): tracks served from <companion>/music/,
  // fade in over 2 s and out over the last 3 s of the travelling; stops with it
  const music = { el: null, timer: null, list: null };
  async function musicTracks() { if (music.list) return music.list; try { const j = await api("/api/music"); music.list = j.tracks || []; music.game = j.game || []; } catch (e) { return []; } return music.list; }
  // Must stay synchronous up to el.play(): browsers only allow audio to start inside the user's click. "auto"
  // therefore picks from the list already fetched (the panel loads it; the line sheet prefetches it below).
  function musicStart(prefs) {
    // a track already playing (e.g. left to finish after the previous travelling) is kept: just retime its end
    if (music.el && !music.el.ended && !music.el.paused) { music.total = Math.max(music.total || 0, (Date.now() - music.t0) + prefs.dur * 1000); music.kept = true; return; }
    music.kept = false;
    musicStop();
    if (!prefs.music) return;  // "" = off; "auto" = any track of the folder (none there = silence); else a file name
    let file = prefs.music;
    // "auto" = the player's own files, or the game's soundtrack when music/ is empty
    if (file === "auto") { const tracks = (music.list && music.list.length) ? music.list : (music.game || []); if (!tracks.length) { musicTracks(); return; } file = tracks[Math.floor(Math.random() * tracks.length)]; }
    const el = new Audio("music/" + encodeURIComponent(file)); el.loop = !!prefs.loop; el.volume = 0; music.el = el;
    el.play().catch(e => { $("#cmd-status").textContent = t("cam_music_blocked"); $("#cmd-status").className = "cmdstatus bad"; console.warn("music", e); });
    const vol = prefs.vol ?? 0.6, t0 = Date.now();
    // tail = let the track play to its end after the travelling (no fade-out at `total`); a manual stop still fades
    const tail = !!prefs.tail;
    music.total = prefs.dur * 1000; music.t0 = t0;
    music.timer = setInterval(() => {
      const e = Date.now() - t0, total = music.total;
      let v = Math.min(1, e / 2000);
      if (!prefs.loop && !tail) v = Math.min(v, Math.max(0, (total - e) / 3000));
      el.volume = Math.max(0, Math.min(1, v * vol));
      if (!prefs.loop && !tail && e > total) musicStop();
      if (tail && el.ended) musicStop();
    }, 100);
  }
  // the travelling's real duration is known a moment after the music had to start: adjust the fade-out point
  function musicRetime(durS) {
    if (!music.el) return;
    const end = (Date.now() - music.t0) + durS * 1000;
    music.total = music.kept ? Math.max(music.total || 0, end) : end;  // a kept track is never shortened
  }
  // stop: quick 1 s fade so a manual stop does not cut the music dead
  function musicStop() {
    if (music.timer) clearInterval(music.timer); music.timer = null;
    const el = music.el; music.el = null; if (!el) return;
    const v0 = el.volume; let k = 10;
    const fade = setInterval(() => { k--; el.volume = Math.max(0, v0 * k / 10); if (k <= 0) { clearInterval(fade); el.pause(); } }, 100);
  }
  async function editViews(body) {
    let j;
    try {
      const r = await fetch("/api/views", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      j = await r.json(); if (!j.ok && !j.error) j.error = String(r.status);
    } catch (e) { j = { ok: false, error: e.message }; }  // server down / non-JSON reply used to throw out of the click handler
    if (!j.ok) { $("#cmd-status").textContent = t("act_failed", { msg: j.error }); $("#cmd-status").className = "cmdstatus bad"; return false; }
    camViews.list = j.views || []; renderCamViews(); if (map.data) drawMap($("#map")); return true;
  }
  async function loadViews() { try { const j = await api("/api/views"); camViews.list = j.views || []; camViews.game = j.game || null; } catch (e) { camViews.list = []; } camViews.loaded = true; }
  function renderCamViews() {
    const box = $("#cam-views"); if (!box) return;
    const cur = camViews.cur, off = cmdOff();
    if (cur === null) { box.innerHTML = `<div class="cmdhint">${ico("alert", "sm")}<span>${t("cam_needs_rev7")}</span></div>`; return; }
    const views = camViews.list, act = activeView();
    // rows are draggable: dropped on a chain in the travellings panel, the view is appended there
    const row = (v, i) => `<div class="cv ${act && act.id === v.id ? "on" : ""}" data-id="${v.id}" draggable="true">
      <span class="cv-n" title="Shift+${i + 1}">${i + 1}</span>
      <button class="cv-go" data-act="go" title="${esc(t("cam_go_hint", { n: i + 1 }))} · ${v.follow ? esc(t("cam_follow_view", { v: v.follow_name || v.follow })) : fmtCam(v)}" ${off ? "disabled" : ""}>${v.follow ? ico("follow", "sm") : ""}${esc(v.name)}</button>
      <span class="cv-tools">
        <button class="btn" data-act="travel" title="${esc(t("cam_travel_here"))}" ${off ? "disabled" : ""}>${ico("follow", "sm")}</button>
        <button class="btn" data-act="update" title="${esc(t("cam_update"))}">${ico("star_outline", "sm")}</button>
        <button class="btn" data-act="rename" title="${esc(t("cam_rename"))}">${ico("edit", "sm")}</button>
        <button class="btn" data-act="up" title="${esc(t("cam_move_up"))}" ${i === 0 ? "disabled" : ""}>▲</button>
        <button class="btn" data-act="down" title="${esc(t("cam_move_down"))}" ${i === views.length - 1 ? "disabled" : ""}>▼</button>
        <button class="btn" data-act="delete" title="${esc(t("cam_delete"))}">✕</button>
      </span></div>`;
    // the travelling settings and buttons live in their own panel (renderTravellings); the views' tools only
    // hand a draft over to it
    const path = cur.path;
    box.innerHTML = `${cmdHint()}<button class="btn cv-save" ${views.length >= 9 ? "disabled" : ""} title="${views.length >= 9 ? esc(t("cam_max")) : ""}">${ico("star", "sm")}${esc(t("cam_save"))}</button>` +
      (views.length ? `<div class="cv-list">${views.map(row).join("")}</div>` : `<p class="cv-empty">${t("cam_empty")}</p>`) +
      `<div class="cv-cur">${t("cam_current")}: ${fmtCam(cur)}${cur.follow ? " · " + t("cam_following") : ""}${path ? " · " + t("cam_travel") : ""}</div>`;
    $(".cv-save", box).addEventListener("click", async () => {
      const cur = camViews.cur; if (!cur) return;
      // following a vehicle: offer to attach the view to it (recalled = follow it again with this framing)
      const attach = cur.follow ? await modal.confirm(t("cam_attach_confirm"), { title: t("cam_attach_title"), ok: t("cam_attach_yes"), cancel: t("cam_attach_no") }) : false;
      const name = await modal.prompt(t("cam_name_prompt"), { value: t("cam_default_name", { n: views.length + 1 }), ok: t("cam_save_ok") });
      if (name) editViews({ action: "add", name, camera: cur, attach });
    });
    $$(".cv", box).forEach(el => {
      const id = +el.dataset.id, v = views.find(x => x.id === id); if (!v) return;
      el.addEventListener("dragstart", e => { e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("text/plain", "view:" + id); });
      $$("[data-act]", el).forEach(b => b.addEventListener("click", async e => {
        e.stopPropagation(); const a = b.dataset.act;
        if (a === "go") { travel.sel = v.id; gotoView(v); renderCamViews(); renderTravellings(); }
        else if (a === "travel") { travel.sel = v.id; trvDraft({ kind: "view", view: v.id }); if (!trvPlay(trv.draft)) { $("#cmd-status").textContent = t("trv_gone"); $("#cmd-status").className = "cmdstatus bad"; } }
        else if (a === "update") { if (await modal.confirm(t("cam_update_confirm", { name: v.name }), { title: t("cam_update_title"), ok: t("cam_replace_ok") })) editViews({ action: "update", id, camera: camViews.cur, attach: !!(camViews.cur && camViews.cur.follow && v.follow) }); }
        else if (a === "rename") { const name = await modal.prompt(t("cam_name_prompt"), { value: v.name, ok: t("cam_rename_ok") }); if (name) editViews({ action: "rename", id, name }); }
        else if (a === "up" || a === "down") editViews({ action: "move", id, delta: a === "up" ? -1 : 1 });
        else if (a === "delete") { if (await modal.confirm(t("cam_delete_confirm", { name: v.name }), { title: t("cam_delete_title"), ok: t("cam_delete_title"), danger: true })) editViews({ action: "delete", id }); }
      }));
    });
  }


  // ------------------------------------------------------------ travellings panel
  // A travelling is a recipe {kind: "view"|"chain"|"line", view?, line?, move, dir, amp, dur, loop, music, vol, tail}
  // rebuilt from the current state when played (today's vehicles on the line, a view that follows its vehicle).
  // The panel holds ONE draft (what the view/line buttons hand over, editable) and the saved list (db/travellings.json,
  // per savegame, max 20). Playing anything also makes it the draft, so "save" always keeps what was just seen.
  const trv = { list: [], draft: null, loaded: false, editing: null };
  const SPEC_KEYS = ["kind", "view", "line", "views", "move", "dir", "amp", "dur", "loop", "music", "vol", "tail"];
  // the views of a chain, in order: the recipe's own list (ids that still exist) or every view of the panel
  const chainViews = (s) => (s.views ? s.views.map(id => camViews.list.find(v => v.id === id)).filter(Boolean) : camViews.list);
  const specOf = (o) => { const s = {}; SPEC_KEYS.forEach(k => { if (o[k] !== undefined) s[k] = o[k]; }); return s; };
  // the draft starts from the browser preferences (last used settings) + the subject
  function trvDraft(subject) { trv.draft = { ...travelPrefs(), ...subject }; if (subject.kind === "line") trv.line = subject.line; saveTravelPrefs(specOf(trv.draft)); renderTravellings(); }
  function trvSubjectName(s) {
    if (s.kind === "chain") return t("trv_chain_n", { n: chainViews(s).length });
    if (s.kind === "line") { const l = (state.lines || []).find(x => x.line_id === s.line) || (map.data && (map.data.lines || []).find(x => x.line_id === s.line)); return l ? l.name : t("line") + " " + s.line; }
    const v = camViews.list.find(x => x.id === s.view); return v ? v.name : t("trv_view_gone");
  }
  // run a recipe: returns false when the subject no longer exists
  function trvPlay(s) {
    const tp = { ...TRAVEL_DEFAULTS, ...s };
    if (s.kind === "line") { const l = (state.lines || []).find(x => x.line_id === s.line) || { line_id: s.line, name: trvSubjectName(s) }; lineTravelling(l, tp); return true; }
    if (s.kind === "chain") { const vs = chainViews(s), pts = vs.map(liveView).filter(Boolean).map(v => ({ x: v.x, y: v.y, dist: v.dist, angle: v.angle, pitch: v.pitch })); if (pts.length < 2) return false; playTravelling("chain", pts, { ...tp, dur: tp.dur * Math.max(1, vs.length - 1) / 2 }); return true; }
    const v = camViews.list.find(x => x.id === s.view), lv = v && liveView(v); if (!lv) return false;
    playTravelling(tp.move, TRAVEL_MOVES[tp.move](lv, tp), tp); return true;
  }
  async function editTravellings(body) {
    let j;
    try {
      const r = await fetch("/api/travellings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      j = await r.json(); if (!j.ok && !j.error) j.error = String(r.status);
    } catch (e) { j = { ok: false, error: e.message }; }
    if (!j.ok) { $("#cmd-status").textContent = t("act_failed", { msg: j.error }); $("#cmd-status").className = "cmdstatus bad"; return false; }
    trv.list = j.items || []; renderTravellings(); return true;
  }
  async function loadTravellings() { try { const j = await api("/api/travellings"); trv.list = j.items || []; } catch (e) { trv.list = []; } trv.loaded = true; }
  function renderTravellings() {
    const box = $("#travellings"); if (!box) return;
    const cur = camViews.cur, off = cmdOff();
    if (cur === null) { box.innerHTML = `<div class="cmdhint">${ico("alert", "sm")}<span>${t("cam_needs_rev7")}</span></div>`; return; }
    // always a draft: the selected view (or the first one) with the browser preferences
    if (!trv.draft && camViews.list.length) { const pf = travelPrefs(); trv.draft = { ...pf, kind: pf.kind === "chain" && camViews.list.length >= 2 ? "chain" : "view", view: (travel.sel && camViews.list.find(v => v.id === travel.sel)) ? travel.sel : (camViews.list.find(v => v.id === pf.view) ? pf.view : camViews.list[0].id) }; }
    if (trv.draft && trv.draft.kind === "view" && !camViews.list.find(v => v.id === trv.draft.view)) trv.draft = camViews.list.length ? { ...trv.draft, view: camViews.list[0].id } : null;
    const path = cur.path, d = trv.draft, editing = trv.editing != null ? trv.list.find(x => x.id === trv.editing) : null;
    // the settings being edited: a saved travelling (pencil) or the draft
    const tp = editing || d;
    const seg = (name, opts, val, fmt) => `<span class="seg" data-tset="${name}">${opts.map(o => `<button data-v="${o}" class="${String(val) === String(o) ? "active" : ""}">${fmt ? fmt(o) : o}</button>`).join("")}</span>`;
    const kindIco = (s) => s.kind === "line" ? ico("line", "sm") : s.kind === "chain" ? ico("line", "sm") : ico(TRAVEL_MOVE_ICON[s.move] || "reset", "sm");
    const summary = (s) => `${s.dur} s · ×${s.amp}${s.loop ? " · " + t("cam_travel_loop") : ""}${s.music ? " · " + ico("noise", "sm") : ""}`;
    const row = (s, i) => `<div class="cv ${trv.editing === s.id ? "on" : ""}" data-id="${s.id}">
      <span class="cv-n">${i + 1}</span>
      <button class="cv-go" data-act="play" title="${esc(trvSubjectName(s))} · ${esc(summary(s).replace(/<[^>]+>/g, ""))}" ${off ? "disabled" : ""}>${kindIco(s)}${esc(s.name)}</button>
      <span class="cv-tools">
        <button class="btn" data-act="edit" title="${esc(t("trv_edit"))}">${ico("settings", "sm")}</button>
        <button class="btn" data-act="rename" title="${esc(t("cam_rename"))}">${ico("edit", "sm")}</button>
        <button class="btn" data-act="up" title="${esc(t("cam_move_up"))}" ${i === 0 ? "disabled" : ""}>▲</button>
        <button class="btn" data-act="down" title="${esc(t("cam_move_down"))}" ${i === trv.list.length - 1 ? "disabled" : ""}>▼</button>
        <button class="btn" data-act="delete" title="${esc(t("cam_delete"))}">✕</button>
      </span></div>`;
    // subject: a view (pick by number), the chain of views, the line handed over by a line sheet (kept in the draft)
    const kinds = ["view"].concat(camViews.list.length >= 2 ? ["chain"] : []).concat((tp && tp.kind === "line") || trv.line ? ["line"] : []);
    const KIND_ICO = { view: "star", chain: "line", line: "configure_line" };
    const settings = tp ? `<div class="cv-travel">
        <div class="tr-row"><span class="lbl">${editing ? kindIco(tp) + esc(editing.name) : t("trv_draft")}</span>
          ${seg("kind", kinds, tp.kind, k => `<span title="${esc(t("trv_kind_" + k))}">${ico(KIND_ICO[k], "sm")}</span>`)}
          ${tp.kind === "view" ? seg("view", camViews.list.map(v => v.id), tp.view, id => { const v = camViews.list.find(x => x.id === id); return `<span title="${esc(v.name)}">${camViews.list.indexOf(v) + 1}</span>`; }) : `<span class="muted small">${esc(trvSubjectName(tp))}</span>`}
          ${editing ? `<button class="btn" data-tdone title="${esc(t("trv_done"))}">${ico("check", "sm")}</button>` : ""}</div>
        ${tp.kind === "view" ? `<div class="tr-row"><span class="lbl">${t("cam_travel")}</span>${seg("move", Object.keys(TRAVEL_MOVES), tp.move, m => `<span title="${esc(t("cam_move_" + m))}">${ico(TRAVEL_MOVE_ICON[m], "sm")}</span>`)}
          <button class="btn tgl ${tp.dir < 0 ? "active" : ""}" data-tset="dir" title="${esc(t("cam_travel_dir"))}">${ico("reverse", "sm")}</button></div>
        <div class="tr-row"><span class="muted small tr-desc">${t("cam_move_" + tp.move)}</span></div>` : ""}
        ${tp.kind === "chain" ? `<div class="tr-chain" data-chain>${chainViews(tp).map((v, i) => `<div class="cv ch" draggable="true" data-ci="${i}"><span class="cv-n">${i + 1}</span><span class="ch-name">${v.follow ? ico("follow", "sm") : ""}${esc(v.name)}</span><button class="btn" data-chrm="${i}" title="${esc(t("trv_chain_remove"))}">✕</button></div>`).join("")}<div class="ch-drop muted small">${t("trv_chain_hint")}</div></div>` : ""}
        <div class="tr-row"><span class="lbl">${t("cam_travel_dur")}</span>${seg("dur", [10, 20, 40, 90], tp.dur, x => x + " s")}
          <button class="btn tgl ${tp.loop ? "active" : ""}" data-tset="loop" title="${esc(t("cam_travel_loop"))}">${ico("reset", "sm")}</button></div>
        <div class="tr-row"><span class="lbl">${tp.kind === "line" ? t("trv_alt") : t("cam_travel_amp")}</span>${seg("amp", [0.5, 1, 2], tp.amp, a => "×" + a)}</div>
        <div class="tr-row" id="tr-music"></div>
        <div class="tr-row">
          ${path ? `<button class="btn primary" data-travel="stop">${ico("play_pause", "sm")}${t("cam_travel_stop")}</button><span class="bar travel"><i style="width:${Math.round((path.progress || 0) * 100)}%"></i></span>`
                 : `<button class="btn primary" data-travel="play" ${off ? "disabled" : ""}>${ico("play_1", "sm")}${t("trv_play")}</button>`}
          ${!editing && trv.list.length < 20 ? `<button class="btn" data-travel="save" title="${esc(t("trv_save_hint"))}">${ico("star", "sm")}${t("trv_save")}</button>` : ""}
        </div>
      </div>` : "";
    box.innerHTML = cmdHint() +
      (trv.list.length ? `<div class="cv-list">${trv.list.map(row).join("")}</div>` : `<p class="cv-empty">${t("trv_empty")}</p>`) +
      settings +
      (path && !tp ? `<div class="tr-row"><button class="btn primary" data-travel="stop">${ico("play_pause", "sm")}${t("cam_travel_stop")}</button><span class="bar travel"><i style="width:${Math.round((path.progress || 0) * 100)}%"></i></span></div>` : "");
    // settings: segments and toggles (edit the saved travelling in place, or the draft)
    const applyAll = (patch) => { if (editing) editTravellings({ action: "update", id: editing.id, spec: { ...specOf(editing), ...patch } }); else { Object.assign(tp, patch); saveTravelPrefs(specOf(tp)); renderTravellings(); } };
    const apply = (k, v) => applyAll({ [k]: v });
    $$("[data-tset] button, .btn[data-tset]", box).forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.tset || b.closest("[data-tset]").dataset.tset;
      const val = isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v;
      if (k === "dir") apply("dir", -(tp.dir || 1)); else if (k === "loop") apply("loop", !tp.loop);
      else if (k === "kind") { const patch = { kind: val }; if (val === "chain" && !tp.views) patch.views = camViews.list.map(v => v.id); if (val === "line" && trv.line && !editing) patch.line = trv.line; applyAll(patch); }
      else apply(k, val);
    }));
    const done = $("[data-tdone]", box); if (done) done.addEventListener("click", () => { trv.editing = null; renderTravellings(); });
    // chain editor: drag a row to reorder, drop a view from the camera views card to append it, x removes
    const chainBox = $("[data-chain]", box);
    if (chainBox) {
      const ids = () => chainViews(tp).map(v => v.id);
      const setChain = (list) => apply("views", list);
      $$("[data-chrm]", chainBox).forEach(b => b.addEventListener("click", () => { const l = ids(); l.splice(+b.dataset.chrm, 1); setChain(l); }));
      let from = null;
      $$(".cv.ch", chainBox).forEach(r => {
        r.addEventListener("dragstart", e => { from = +r.dataset.ci; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "chain:" + from); });
        r.addEventListener("dragend", () => { from = null; $$(".drag-over", chainBox).forEach(x => x.classList.remove("drag-over")); });
      });
      chainBox.addEventListener("dragover", e => { e.preventDefault(); const r = e.target.closest(".cv.ch"); $$(".drag-over", chainBox).forEach(x => x.classList.remove("drag-over")); (r || chainBox).classList.add("drag-over"); });
      chainBox.addEventListener("dragleave", e => { if (e.target === chainBox) chainBox.classList.remove("drag-over"); });
      chainBox.addEventListener("drop", e => {
        e.preventDefault(); const l = ids(), r = e.target.closest(".cv.ch"), to = r ? +r.dataset.ci : l.length;
        const data = e.dataTransfer.getData("text/plain") || "";
        if (data.startsWith("view:")) { l.splice(to, 0, +data.slice(5)); setChain(l); }           // a view dragged from the views card
        else if (from != null) { const [m] = l.splice(from, 1); l.splice(to > from ? to - 1 : to, 0, m); setChain(l); }
        chainBox.classList.remove("drag-over");
      });
    }
    $$("[data-travel]", box).forEach(b => b.addEventListener("click", async () => {
      const a = b.dataset.travel;
      if (a === "stop") return stopTravelling();
      if (a === "play" && tp) { if (!trvPlay(tp)) { $("#cmd-status").textContent = t("trv_gone"); $("#cmd-status").className = "cmdstatus bad"; } return; }
      if (a === "save" && d) { const name = await modal.prompt(t("cam_name_prompt"), { value: trvSubjectName(d).slice(0, 40), ok: t("trv_save") }); if (name) { await editTravellings({ action: "add", name, spec: specOf(d) }); } }
    }));
    // music row (async: the track list comes from the server); two groups: the player's files, the game's soundtrack
    if (tp) musicTracks().then(() => {
      const row = $("#tr-music", box); if (!row) return;
      const own = music.list || [], game = music.game || [];
      const label = (x) => x.startsWith("game:") ? x.slice(5).replace(/^.*\//, "") : x;
      const btn = (x) => `<button data-v="${esc(x)}" class="${tp.music === x ? "active" : ""}" title="${esc(label(x))}">${esc(label(x).replace(/\.[^.]+$/, "").slice(0, 18))}</button>`;
      if (!own.length && !game.length) { row.innerHTML = `<span class="lbl">${ico("noise", "sm")}${t("cam_music")}</span><span class="muted small">${t("cam_music_none")}</span>`; return; }
      row.innerHTML = `<span class="lbl">${ico("noise", "sm")}${t("cam_music")}</span><span class="seg wrap" data-tset="music"><button data-v="" class="${tp.music ? "" : "active"}">${t("none")}</button><button data-v="auto" class="${tp.music === "auto" ? "active" : ""}" title="${esc(t("cam_music_auto_hint"))}">${t("cam_music_auto")}</button>${own.map(btn).join("")}</span>
        ${game.length ? `<span class="seg wrap" data-tset="music"><span class="lbl">${t("trv_music_game")}</span>${game.map(btn).join("")}</span>` : ""}
        <input type="range" min="0" max="1" step="0.05" value="${tp.vol}" data-tvol title="${esc(t("cam_music_vol"))}">
        <button class="btn tgl ${tp.tail ? "active" : ""}" data-ttail title="${esc(t("cam_music_tail_hint"))}">${ico("play_1", "sm")}${t("cam_music_tail")}</button>
        ${music.el && !path ? `<button class="btn" data-tmute title="${esc(t("cam_music_off"))}">${ico("stop", "sm")}${t("cam_music_off")}</button>` : ""}`;
      $$("[data-tset=music] button", row).forEach(b => b.addEventListener("click", () => apply("music", b.dataset.v)));
      $("[data-ttail]", row).addEventListener("click", () => apply("tail", !tp.tail));
      const mute = $("[data-tmute]", row); if (mute) mute.addEventListener("click", () => { musicStop(); renderTravellings(); });
      $("[data-tvol]", row).addEventListener("input", e => { tp.vol = +e.target.value; if (!editing) saveTravelPrefs(specOf(tp)); if (music.el) music.el.volume = tp.vol; });
      $("[data-tvol]", row).addEventListener("change", e => { if (editing) apply("vol", +e.target.value); });
    });
    $$(".cv", box).forEach(el => {
      const id = +el.dataset.id, s = trv.list.find(x => x.id === id); if (!s) return;
      $$("[data-act]", el).forEach(b => b.addEventListener("click", async e => {
        e.stopPropagation(); const a = b.dataset.act;
        if (a === "play") { if (!trvPlay(s)) { $("#cmd-status").textContent = t("trv_gone"); $("#cmd-status").className = "cmdstatus bad"; } }
        else if (a === "edit") { trv.editing = trv.editing === id ? null : id; renderTravellings(); }
        else if (a === "rename") { const name = await modal.prompt(t("cam_name_prompt"), { value: s.name, ok: t("cam_rename_ok") }); if (name) editTravellings({ action: "rename", id, name }); }
        else if (a === "up" || a === "down") editTravellings({ action: "move", id, delta: a === "up" ? -1 : 1 });
        else if (a === "delete") { if (await modal.confirm(t("cam_delete_confirm", { name: s.name }), { title: t("cam_delete_title"), ok: t("cam_delete_title"), danger: true })) { if (trv.editing === id) trv.editing = null; editTravellings({ action: "delete", id }); } }
      }));
    });
  }

  // ------------------------------------------------------------ savegames & backups (settings panel)
  // The companion keeps one history per savegame (key = player entity, the game reuses it at every load of that
  // save). A backup = zip of the database + camera views in db/backups/; restoring the views is immediate, restoring
  // the database is applied by the collector at its next start.
  const gameDay = (n) => n ? `${Math.floor(n / 10000)}-${String(Math.floor(n / 100) % 100).padStart(2, "0")}-${String(n % 100).padStart(2, "0")}` : "–";
  const realDate = (s) => s ? new Date(s).toLocaleString(loc(), { dateStyle: "short", timeStyle: "short" }) : "–";
  const kb = (n) => n == null ? "" : n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
  async function renderSaves() {
    const box = $("#saves"); if (!box) return;
    let d; try { d = await api("/api/games"); } catch (e) { box.innerHTML = `<p class="muted">${esc(String(e))}</p>`; return; }
    const games = d.games || [], backups = d.backups || [];
    const gameRow = (gm) => {
      const cur = gm.key === d.current, rel = gm.reloads || [];
      return `<div class="save ${cur ? "cur" : ""}">
        <div class="save-h"><b>${esc(gm.label || gm.key)}</b>${cur ? ` <span class="tag ok">${t("saves_current")}</span>` : ""}${gm.label ? `<small class="mono">${esc(gm.key)}</small>` : ""}</div>
        <div class="save-d">${t("saves_game_date")}: <b>${gameDay(gm.last_game_day)}</b> · ${t("saves_seen", { a: realDate(gm.first_seen), b: realDate(gm.last_seen) })}</div>
        <div class="save-d">${t("saves_counts", { s: int(gm.snapshots), l: int(gm.lines), v: int(gm.vehicles), c: gm.views })}</div>
        ${rel.length ? `<div class="save-d warn">${ico("alert", "sm")}${t("saves_reloads", { n: rel.length, from: gameDay(rel[rel.length - 1].from_day), to: gameDay(rel[rel.length - 1].to_day), at: realDate(rel[rel.length - 1].at) })}</div>` : ""}
      </div>`;
    };
    const bkRow = (b) => `<div class="save bk ${b.bad ? "bad" : ""}">
        <div class="save-h"><b>${esc(b.label || b.file)}</b><small class="mono">${esc(b.file)} · ${kb(b.size)}</small></div>
        <div class="save-d">${realDate(b.created || b.time)}${b.games ? " · " + b.games.map(g => `${esc(g.label || g.key)} (${gameDay(g.last_game_day)})`).join(", ") : ""}</div>
        ${b.bad ? "" : `<div class="save-a"><button class="btn" data-restore="views" data-file="${esc(b.file)}">${ico("camera", "sm")}${t("saves_restore_views")}</button><button class="btn" data-restore="all" data-file="${esc(b.file)}">${ico("load_game", "sm")}${t("saves_restore_all")}</button></div>`}
      </div>`;
    box.innerHTML = `${games.length ? games.map(gameRow).join("") : `<p class="muted">${t("no_data")}</p>`}
      <div class="save-a"><button class="btn primary" id="bk-now">${ico("save", "sm")}${t("saves_backup_now")}</button><span class="muted small">${esc(d.dir || "")}</span></div>
      ${d.restore_pending ? `<div class="save-d warn">${ico("alert", "sm")}${t("saves_restore_pending")}</div>` : ""}
      ${backups.length ? `<h3>${t("saves_backups")}</h3>${backups.map(bkRow).join("")}` : `<p class="muted small">${t("saves_no_backup")}</p>`}
      <p class="setnote">${t("saves_note")}</p>`;
    $("#bk-now", box).addEventListener("click", async () => {
      const r = await fetch("/api/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); const j = await r.json();
      $("#cmd-status").textContent = j.ok ? t("saves_backup_done", { f: j.file }) : t("act_failed", { msg: j.error || r.status }); $("#cmd-status").className = "cmdstatus " + (j.ok ? "ok" : "bad");
      renderSaves();
    });
    $$("[data-restore]", box).forEach(b => b.addEventListener("click", async () => {
      const what = b.dataset.restore, file = b.dataset.file;
      const msg = what === "all" ? t("saves_restore_all_confirm", { f: file }) : t("saves_restore_views_confirm", { f: file });
      if (!await modal.confirm(msg, { title: t("confirm_title"), ok: t("saves_restore"), danger: what === "all" })) return;
      const r = await fetch("/api/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, what }) }); const j = await r.json();
      $("#cmd-status").textContent = j.ok ? t("saves_restored", { n: j.views_merged }) + (j.db_staged ? " · " + t("saves_restore_pending") : "") : t("act_failed", { msg: j.error || r.status });
      $("#cmd-status").className = "cmdstatus " + (j.ok ? "ok" : "bad");
      camViews.loaded = false; renderSaves();
    }));
  }

  // ------------------------------------------------------------ map
  const map = { data: null, scale: 1, ox: 0, oy: 0, drag: null, init: false, fitted: false, lineFilter: null, icons: {} };
  // every marker on the canvas scales with the icon-size setting (S 16 / M 22 / L 28 / XL 36): factor 1 = the default L.
  // Markers whose size carries data (stock piles, town circles) keep their own growth: only their base follows.
  const isz = () => (settings.ico || 28) / 28;
  const mapIcon = (name) => { if (!map.icons[name]) { const im = new Image(); im.src = ICON_URL(name); map.icons[name] = im; } return map.icons[name]; };
  async function renderMap(o) {
    camViews.cur = (o && o.camera) || null;
    // views belong to a savegame: reload the list when the game changed (another save loaded while the page stayed open)
    const gameKey = o && o.game && o.game.key;
    map.gameKey = gameKey || map.gameKey;
    // reload when the savegame changed, and when the first load happened before any snapshot (game was null then)
    if (!camViews.loaded || (gameKey && gameKey !== camViews.game)) { await loadViews(); await loadTravellings(); }
    renderCamViews(); renderTravellings();
    map.data = await api("/api/map");
    await loadGeo(); await loadLinePaths(); await loadMapCargo(); loadHeightmap();
    const canvas = $("#map");
    if (!map.init) { initMap(canvas); map.init = true; }
    const sel = $("#map-line-filter");
    if (sel.options.length - 1 !== (map.data.lines || []).length || sel.dataset.lang !== i18n.lang) { sel.innerHTML = `<option value="">${t("all_lines")}</option>` + (map.data.lines || []).slice().sort((a, b) => String(a.name).localeCompare(b.name)).map(l => `<option value="${l.line_id}">${esc(l.name)}</option>`).join(""); sel.dataset.lang = i18n.lang; }
    if (map.lineFilter != null) { sel.value = String(map.lineFilter); }
    drawMap(canvas);
  }
  function initMap(canvas) {
    canvas.addEventListener("wheel", e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const f = e.deltaY < 0 ? 1.15 : 1 / 1.15; map.ox = mx - (mx - map.ox) * f; map.oy = my - (my - map.oy) * f; map.scale *= f; saveView(); drawMap(canvas); }, { passive: false });
    canvas.addEventListener("mousedown", e => { map.drag = { x: e.clientX, y: e.clientY, ox: map.ox, oy: map.oy, moved: false }; canvas.style.cursor = "grabbing"; });
    window.addEventListener("mouseup", () => { if (map.drag && map.drag.moved) saveView(); map.drag = null; canvas.style.cursor = ruler.on ? "crosshair" : "grab"; });
    canvas.addEventListener("mousemove", e => { if (map.drag) { if (Math.abs(e.clientX - map.drag.x) + Math.abs(e.clientY - map.drag.y) > 3) map.drag.moved = true; map.ox = map.drag.ox + e.clientX - map.drag.x; map.oy = map.drag.oy + e.clientY - map.drag.y; drawMap(canvas); } else hoverMap(canvas, e); });
    canvas.addEventListener("click", e => {
      if (map.lastDragMoved) return;
      if (ruler.on) { rulerClick(canvas, e); return; }
      const hit = pickMap(canvas, e); if (!hit) return;
      if (hit.kind === "view") gotoView(hit.view);
      // a vehicle: follow it (Shift+click = just look at it); anything else: look at it
      else if (hit.entity != null) sendCmd(hit.kind === "vehicle" && !e.shiftKey ? "follow_entity" : "focus_entity", { entity: hit.entity });
    });
    canvas.addEventListener("mousedown", () => { map.lastDragMoved = false; });
    canvas.addEventListener("mousemove", () => { if (map.drag && map.drag.moved) map.lastDragMoved = true; });
    $$("#tab-map input").forEach(i => i.addEventListener("change", async () => { if (["map-prod", "map-need", "map-stock"].includes(i.id) && !mapCargo.data) await loadMapCargo(); drawMap(canvas); }));
    $("#map-line-filter").addEventListener("change", e => { map.lineFilter = e.target.value ? +e.target.value : null; drawMap(canvas); });
    $("#map-fit").addEventListener("click", () => { map.fitted = false; map.userView = false; try { localStorage.removeItem(viewKey()); } catch (e) { /* ignore */ } map.restoreKey = viewKey(); drawMap(canvas); });
    $("#map-style-btn").addEventListener("click", (e) => { e.preventDefault(); const b = $("#map-style"); const open = b.hidden; b.hidden = !open; $("#map-style-btn").classList.toggle("active", open); if (open) renderMapStyle(); });
    $("#map-ruler-btn").addEventListener("click", (e) => { e.preventDefault(); rulerSet(!ruler.on); });
    document.addEventListener("keydown", (e) => { if (e.code === "Escape" && ruler.on && state.tab === "map") rulerSet(false); });
    if (new URLSearchParams(location.search).get("mapstyle")) { $("#map-style").hidden = false; $("#map-style-btn").classList.add("active"); renderMapStyle(); }
    // ?maplayers=prod,need,stock turns cargo layers on; ?mapzoom=<town_id> centres on a town at a readable scale (links, screenshots)
    const ml = new URLSearchParams(location.search).get("maplayers"); if (ml) ml.split(",").forEach(k => { const el = $("#map-" + k); if (el) el.checked = true; });
    window.addEventListener("resize", () => { if (state.tab === "map") drawMap(canvas); });
    ["veh_bus", "veh_truck", "veh_train", "veh_tram", "veh_plane", "veh_heli", "veh_ship", "veh_car", "industry", "depot", "alert", "camera", "star"].forEach(mapIcon);
  }
  // ---- geography: terrain bounds, water contours, street/track network. Static per savegame: fetched
  // with the geo_seq we already have, the server answers "unchanged" unless the mod rewrote its file (network edit).
  const geo = { data: null, seq: null, game: null, layer: null, key: "" };
  async function loadGeo() {
    try {
      const g = await api("/api/geo" + (geo.seq != null ? `?have=${geo.seq}&game=${geo.game}` : ""));
      if (g.unchanged) return;
      if (!g.available) { geo.data = null; geo.seq = null; geo.game = null; geo.layer = null; return; }
      geo.data = g; geo.seq = g.geo_seq; geo.game = g.game_id; geo.layer = null; geo.key = ""; geo.edgeById = null;
      // first geography of the session: refit on the real bounds, unless the player already has a view (panned / zoomed /
      // restored from the last visit) - never move the map under their hands
      if (!geo.firstFit && !map.userView) map.fitted = false; geo.firstFit = true;
    } catch (e) { /* older server: no endpoint */ }
  }
  // line paths: per line, the legs' edge ids -> polylines over geo.edges. Fetched with the stamp we have;
  // rebuilt when either the paths or the geography changed.
  const linePaths = { stamp: null, lines: null, poly: {}, builtFor: "" };
  async function loadLinePaths() {
    try {
      const r = await api("/api/line_paths" + (linePaths.stamp ? `?have=${encodeURIComponent(linePaths.stamp)}` : ""));
      if (r.unchanged) return;
      linePaths.stamp = r.stamp; linePaths.lines = r.lines || null; linePaths.builtFor = "";
    } catch (e) { /* older server */ }
  }
  // one polyline per leg. A leg is either a list of edge ids (real, from a vehicle's MOVE_PATH, or predicted by the
  // server over the network) -> chain the geo segments, orienting each to continue from the previous end; or a list
  // of points (water route, air, or no path found). Returns [{pts, predicted}] or null.
  function linePolylines(lineId) {
    const g = geo.data, lp = linePaths.lines && linePaths.lines[lineId];
    if (!g || !g.edges || !lp || !lp.legs) return null;
    if (linePaths.builtFor !== geo.seq + "|" + linePaths.stamp) { linePaths.poly = {}; linePaths.builtFor = geo.seq + "|" + linePaths.stamp; }
    if (linePaths.poly[lineId] !== undefined) return linePaths.poly[lineId];
    if (!geo.edgeById) { geo.edgeById = new Map(); g.edges.forEach(e => { if (e[5] != null) geo.edgeById.set(e[5], e); }); }
    const legs = [];
    lp.legs.forEach(leg => {
      if (leg.points && leg.points.length > 1) { legs.push({ pts: leg.points.map(p => [p[0], p[1]]), predicted: !!leg.predicted }); return; }
      const ids = leg.edges || []; let pts = [], last = null;
      ids.forEach((id, k) => {
        const e = geo.edgeById.get(id); if (!e) return;
        let a = [e[0], e[1]], b = [e[2], e[3]];
        if (last) { const da = Math.hypot(a[0] - last[0], a[1] - last[1]), db = Math.hypot(b[0] - last[0], b[1] - last[1]); if (db < da) { [a, b] = [b, a]; } if (Math.min(da, db) > 150) { if (pts.length > 1) legs.push({ pts, predicted: !!leg.predicted }); pts = []; } }
        else if (ids.length > 1) { const n = geo.edgeById.get(ids[k + 1]); if (n) { const d = (p) => Math.min(Math.hypot(p[0] - n[0], p[1] - n[1]), Math.hypot(p[0] - n[2], p[1] - n[3])); if (d(a) < d(b)) { [a, b] = [b, a]; } } }
        if (!pts.length) pts.push(a); pts.push(b); last = b;
      });
      if (pts.length > 1) legs.push({ pts, predicted: !!leg.predicted });
    });
    linePaths.poly[lineId] = legs.length ? legs : null;
    return linePaths.poly[lineId];
  }  // water and network drawn once per view (scale/offset/size/toggles) into an offscreen canvas, blitted on every
  // refresh: 10 000 edges + a few thousand water vertices cost ~15 ms to stroke, the blit nothing
  // map style (gear next to the layer checkboxes): a few looks, each a palette + relief / network strength. Kept in
  // localStorage; changing one invalidates the terrain bitmap and the geo layer.
  const MAP_THEMES = {
    dark:  { land: [30, 40, 48],   water: [16, 41, 74],   street: "#34424f", track: "#8a98a8", bridge: "#b8c4d0", frame: "#2c3a4a", page: "#0b1015" },
    night: { land: [20, 24, 30],   water: [10, 22, 44],   street: "#2a323c", track: "#6a7684", bridge: "#98a4b0", frame: "#1e262e", page: "#07090c" },
    atlas: { land: [96, 112, 92],  water: [58, 110, 160], street: "#c8c2b0", track: "#2e2e2e", bridge: "#111111", frame: "#3a4a3a", page: "#1a2024", ink: "#101418", halo: "rgba(255,255,255,.55)" },
    paper: { land: [214, 206, 188], water: [150, 184, 210], street: "#ffffff", track: "#5a5248", bridge: "#2a2622", frame: "#a09888", page: "#2a2a2a", ink: "#1a1612", halo: "rgba(255,255,255,.7)" },
    // the look of the game's own map preview: forest green by altitude, grey rock where the ground is steep, blue-grey water
    satellite: { land: [96, 116, 66], water: [86, 112, 128], street: "#e6dcb8", track: "#262626", bridge: "#0e0e0e", frame: "#3a4a34", page: "#0b1015", ink: "#f4f6f8", halo: "rgba(0,0,0,.65)", sat: true },
  };
  const MAP_DEFAULTS = { theme: "dark", relief: 1, net: 1, lines: 1 };
  const mapPrefs = () => { try { const p = Object.assign({}, MAP_DEFAULTS, JSON.parse(localStorage.getItem("tf3.map") || "{}")); const q = new URLSearchParams(location.search).get("mapstyle"); if (q && MAP_THEMES[q]) p.theme = q; return p; } catch (e) { return { ...MAP_DEFAULTS }; } };  // ?mapstyle= for screenshots
  const saveMapPrefs = (p) => { localStorage.setItem("tf3.map", JSON.stringify(p)); geo.layer = null; geo.key = ""; geo.bmSeq = null; };
  const mapTheme = () => MAP_THEMES[mapPrefs().theme] || MAP_THEMES.dark;
  function renderMapStyle() {
    const box = $("#map-style"); if (!box) return;
    const p = mapPrefs();
    const seg = (name, opts, val, fmt) => `<span class="seg" data-mset="${name}">${opts.map(o => `<button data-v="${o}" class="${String(val) === String(o) ? "active" : ""}">${fmt ? fmt(o) : o}</button>`).join("")}</span>`;
    const lvl = (o) => ({ 0: t("map_off"), 0.5: t("map_low"), 1: t("map_mid"), 1.5: t("map_high"), 2: t("map_max") })[o] || o;
    box.innerHTML = `<label>${t("map_theme")}</label>${seg("theme", Object.keys(MAP_THEMES), p.theme, o => t("map_theme_" + o))}<label>${t("map_relief")}</label>${seg("relief", [0, 0.5, 1, 1.5, 2], p.relief, lvl)}<label>${t("map_network")}</label>${seg("net", [0.5, 1, 1.5], p.net, lvl)}<label>${t("map_lines")}</label>${seg("lines", [0.5, 1, 1.5, 2], p.lines, lvl)}`;
    $$("#map-style [data-mset] button").forEach(b => b.addEventListener("click", () => { const q = mapPrefs(); const k = b.parentElement.dataset.mset; q[k] = k === "theme" ? b.dataset.v : +b.dataset.v; saveMapPrefs(q); renderMapStyle(); drawMap($("#map")); }));
  }
  // terrain bitmap at grid resolution, built once per geography: land shaded by height (dark low, lighter high,
  // with a soft hill shade from the west), water cells blue. Rows are run lengths starting with land, north first.
  // terrain bitmap at `sub` x the grid resolution (the shore cells carry a sub x sub land/water mask: 11 m on an
  // 11 km map), built once per geography. Land: hillshade on the theme tone, plus on the light themes a height ramp
  // (green - ochre - grey - snow) so the mountains read as mountains. Water: theme blue.
  // ---- full-resolution terrain: db/height_<game>.png, a 16-bit grayscale picture at 4 m written by the
  // collector; metres = raw * res_z + offset_z. Decoded once into a Uint16Array, shaded once per theme into a bitmap
  // (2 817 x 2 817 on an 11 km map: ~60 ms), then drawn like the grid bitmap. Water = below the game's water level,
  // refined by the shore masks of the grid where they exist (the sea is below the level, lakes and rivers are meshes
  // that can sit above it).
  // a shore mask is a number (older mods, sub <= 7) or a string of base-64 digits (6 bits each); bit k = sub-cell k on water
  const B64IDX = (() => { const m = {}; "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((c, i) => m[c] = i); return m; })();
  const maskBit = (mask, k) => typeof mask === "string" ? ((B64IDX[mask[Math.floor(k / 6)]] || 0) >> (k % 6)) & 1 : (mask / Math.pow(2, k)) & 1;
  const hmap = { meta: null, data: null, w: 0, h: 0, loading: false, revs: null };
  async function loadHeightmap() {
    if (hmap.loading) return;
    hmap.loading = true;
    try {
      const m = await api("/api/heightmap");
      if (!m || !m.available || m.url === hmap.revs) return;  // url carries the picture's cache key
      // decoded by hand: a canvas would keep only the high byte of the 16-bit grey (2 m steps that band the shading).
      // The collector writes the simplest PNG there is (one IDAT, filter 0 on every row), inflated with the
      // browser's DecompressionStream.
      const buf = new Uint8Array(await (await fetch(m.url)).arrayBuffer());
      const dv = new DataView(buf.buffer); let p = 8, w = 0, h = 0; const idat = [];
      while (p < buf.length) { const len = dv.getUint32(p), tag = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]); if (tag === "IHDR") { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); } else if (tag === "IDAT") idat.push(buf.subarray(p + 8, p + 8 + len)); p += 12 + len; }
      const z = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"));
      const raw = new Uint8Array(await new Response(z).arrayBuffer());
      const n = w * h, out = new Float32Array(n), stride = 1 + w * 2;
      for (let y = 0; y < h; y++) { const ro = y * stride + 1, oo = y * w; for (let x = 0; x < w; x++) { const q = ro + x * 2; out[oo + x] = (raw[q] << 8) | raw[q + 1]; } }
      hmap.meta = m; hmap.data = out; hmap.w = w; hmap.h = h; hmap.revs = m.url;
      geo.bmSeq = null; geo.layer = null; geo.key = "";
      if (state.tab === "map") drawMap($("#map"));
    } catch (e) { /* no heightmap yet */ } finally { hmap.loading = false; }
  }
  function terrainBitmapHD(g, withWater) {
    const m = hmap.meta, H = hmap.data; if (!m || !H) return null;
    const W = hmap.w, Hh = hmap.h, th = mapTheme(), relief = mapPrefs().relief, light = th.land[0] > 80 || th.sat;
    const c = document.createElement("canvas"); c.width = W; c.height = Hh;
    const ctx = c.getContext("2d"), img = ctx.createImageData(W, Hh), px = img.data;
    const toM = (v) => v * m.res_z + m.offset_z, waterRaw = (m.water_level - m.offset_z) / m.res_z;
    const hmin = toM(m.raw_min), hmax = toM(m.raw_max), step = m.step || 4;
    // the land/water grid of the geography, for the shore detail (lakes above the water level)
    let wat = null, nx = 0, ny = 0, sub = 1, shore = null;
    if (g && g.grid && g.water_rows) {
      [nx, ny] = g.grid; sub = g.shore_sub || 1; wat = new Uint8Array(nx * ny);
      for (let row = 0; row < ny; row++) { const runs = String(g.water_rows[row] || "").split(",").map(Number); let col = 0, on = false; for (const k of runs) { if (on) for (let q = 0; q < k && col + q < nx; q++) wat[row * nx + col + q] = 1; col += k; on = !on; } }
      shore = new Map(); (g.shore || []).forEach(s => shore.set(s[1] * nx + s[0], s[2]));
    }
    // altitude ramp (metres above water): the satellite look is forest green low, lighter and drier high, snow at the top
    // satellite: the game's preview tones - olive meadows low, lighter yellow-green higher, dry ochre near the tops,
    // snow only at the very top; the rock comes from the slope, not from this ramp
    const ramp = th.sat
      ? [[0, 92, 116, 60], [0.2, 112, 132, 70], [0.45, 138, 148, 84], [0.7, 160, 150, 104], [0.9, 176, 168, 150], [1, 236, 238, 240]]
      : [[0, 92, 118, 86], [0.35, 118, 134, 88], [0.6, 150, 136, 100], [0.8, 140, 134, 128], [0.9, 236, 238, 240], [1, 255, 255, 255]];
    const rampAt = (t) => { let i = 1; while (i < ramp.length - 1 && ramp[i][0] < t) i++; const a = ramp[i - 1], b = ramp[i], u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]); return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u]; };
    const rock = [132, 128, 122], water = th.water, zx = (th.sat ? 1.4 : 1.0) * relief, lx = -0.5, ly = -0.5, lz = 0.7071;
    const hAt = (x, y) => H[Math.max(0, Math.min(Hh - 1, y)) * W + Math.max(0, Math.min(W - 1, x))];
    const bw = m.bounds, gw = g && g.bounds ? g.bounds : bw;
    for (let y = 0; y < Hh; y++) {
      // the picture runs north (row 0) to south like the grid; world y of this row
      const wy = bw[3] - (y + 0.5) / Hh * (bw[3] - bw[1]);
      for (let x = 0; x < W; x++) {
        const i = y * W + x, o = i * 4, raw = H[i];
        const wx = bw[0] + (x + 0.5) / W * (bw[2] - bw[0]);
        // water: below the level, or a grid/shore cell says so (lakes above the level)
        let isW = raw <= waterRaw + 0.5;
        if (!isW && wat) {
          const col = Math.floor((wx - gw[0]) / (gw[2] - gw[0]) * nx), row = Math.floor((gw[3] - wy) / (gw[3] - gw[1]) * ny);
          if (col >= 0 && col < nx && row >= 0 && row < ny) {
            const mask = shore.get(row * nx + col);
            if (mask != null) { const sc = Math.min(sub - 1, Math.floor(((wx - gw[0]) / (gw[2] - gw[0]) * nx - col) * sub)), sr = Math.min(sub - 1, Math.floor(((gw[3] - wy) / (gw[3] - gw[1]) * ny - row) * sub)); isW = maskBit(mask, sr * sub + sc) === 1; }
            else isW = wat[row * nx + col] === 1;
          }
        }
        if (isW && withWater) { px[o] = water[0]; px[o + 1] = water[1]; px[o + 2] = water[2]; px[o + 3] = 255; continue; }
        // slope from the neighbours (metres per metre) and a west-north-west light
        const dzdx = (hAt(x + 1, y) - hAt(x - 1, y)) * m.res_z / (2 * step), dzdy = (hAt(x, y + 1) - hAt(x, y - 1)) * m.res_z / (2 * step);
        const slope = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
        const sx = dzdx * zx, sy = dzdy * zx, nl = 1 / Math.sqrt(sx * sx + sy * sy + 1);
        const shade = Math.max(0, (-sx * lx - sy * ly + lz) * nl);
        const f = relief ? 0.6 + 0.6 * (shade - 0.7071) : 0.65;
        const hm = toM(raw), tH = Math.max(0, Math.min(1, (hm - Math.max(hmin, m.water_level)) / Math.max(1, hmax - Math.max(hmin, m.water_level))));
        let r, gg, b;
        if (light) {
          let base = rampAt(tH);
          if (th.sat) {
            // rock where the ground is steep (above ~35 %), blended in over 15 points of slope; bare earth tint on gentle slopes
            const rk = Math.max(0, Math.min(1, (slope - 0.3) / 0.2));
            base = [base[0] + (rock[0] - base[0]) * rk, base[1] + (rock[1] - base[1]) * rk, base[2] + (rock[2] - base[2]) * rk];
          }
          const k = th.sat ? 0.85 + 0.9 * (f - 0.6) : 0.75 + 0.5 * (f - 0.6); r = base[0] * k; gg = base[1] * k; b = base[2] * k;
        } else { const t = relief ? tH * 0.25 : 0; r = th.land[0] * (f + t); gg = th.land[1] * (f + t); b = th.land[2] * (f + t); }
        if (!light && tH > 0.9) { const u = (tH - 0.9) / 0.1; r = r + (200 - r) * u * 0.8; gg = gg + (205 - gg) * u * 0.8; b = b + (215 - b) * u * 0.8; }
        px[o] = Math.min(255, Math.round(r)); px[o + 1] = Math.min(255, Math.round(gg)); px[o + 2] = Math.min(255, Math.round(b)); px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  function terrainBitmap(g, withWater) {
    if (hmap.data) { const hd = terrainBitmapHD(g, withWater); if (hd) return hd; }
    if (!g.grid || !g.water_rows || !g.water_rows.length) return null;
    const [nx, ny] = g.grid, sub = g.shore_sub || 1, W = nx * sub, Hh = ny * sub;
    const c = document.createElement("canvas"); c.width = W; c.height = Hh;
    const ctx = c.getContext("2d"), img = ctx.createImageData(W, Hh), px = img.data;
    const th = mapTheme(), relief = mapPrefs().relief, light = th.land[0] > 80;
    const every = g.height_every || 4, hx = Math.ceil(nx / every), hy = Math.ceil(ny / every), H = g.heights || [];
    const [hmin, hmax] = g.height_range && g.height_range.length === 2 ? g.height_range : [0, 1];
    const hRaw = (ci, ri) => { ci = Math.max(0, Math.min(hx - 1, ci)); ri = Math.max(0, Math.min(hy - 1, ri)); const v = H[ri * hx + ci]; return v != null ? v : hmin; };
    const hAt = (col, row) => { const fx = Math.max(0, col / every - 0.5), fy = Math.max(0, row / every - 0.5), ci = Math.floor(fx), ri = Math.floor(fy), tx = fx - ci, ty = fy - ri; const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty); return (hRaw(ci, ri) * (1 - sx) + hRaw(ci + 1, ri) * sx) * (1 - sy) + (hRaw(ci, ri + 1) * (1 - sx) + hRaw(ci + 1, ri + 1) * sx) * sy; };
    // smooth height field at grid resolution (3x3 blur), slopes from it
    const hb0 = new Float32Array(nx * ny), hb = new Float32Array(nx * ny);
    for (let row = 0; row < ny; row++) for (let col = 0; col < nx; col++) hb0[row * nx + col] = hAt(col, row);
    for (let row = 0; row < ny; row++) for (let col = 0; col < nx; col++) { let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const r = row + dy, q = col + dx; if (r >= 0 && r < ny && q >= 0 && q < nx) { s += hb0[r * nx + q]; n++; } } hb[row * nx + col] = s / n; }
    const hAtB = (col, row) => hb[Math.max(0, Math.min(ny - 1, row)) * nx + Math.max(0, Math.min(nx - 1, col))];
    const cell = (g.bounds[2] - g.bounds[0]) / nx, zx = 1.6 * relief, lx = -0.5, ly = -0.5, lz = 0.7071;
    // land / water at grid resolution, then the shore masks
    const wat = new Uint8Array(nx * ny);
    for (let row = 0; row < ny; row++) { const runs = String(g.water_rows[row] || "").split(",").map(Number); let col = 0, on = false; for (const n of runs) { if (on) for (let k = 0; k < n && col + k < nx; k++) wat[row * nx + col + k] = 1; col += n; on = !on; } }
    const shore = new Map(); (g.shore || []).forEach(s => shore.set(s[1] * nx + s[0], s[2]));
    // height ramp for the light themes: [t, r, g, b]
    const ramp = [[0, 92, 118, 86], [0.35, 118, 134, 88], [0.6, 150, 136, 100], [0.8, 140, 134, 128], [0.9, 236, 238, 240], [1, 255, 255, 255]];
    const rampAt = (t) => { let i = 1; while (i < ramp.length - 1 && ramp[i][0] < t) i++; const a = ramp[i - 1], b = ramp[i], u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]); return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u]; };
    const water = th.water;
    for (let row = 0; row < ny; row++) {
      for (let col = 0; col < nx; col++) {
        const i = row * nx + col, mask = shore.get(i);
        // land colour of the cell (hillshade x ramp or tone)
        const dzdx = (hAtB(col + 1, row) - hAtB(col - 1, row)) / (2 * cell) * zx, dzdy = (hAtB(col, row + 1) - hAtB(col, row - 1)) / (2 * cell) * zx;
        const nl = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
        const shade = Math.max(0, (-dzdx * lx - dzdy * ly + lz) * nl);
        const f = relief ? 0.6 + 0.6 * (shade - 0.7071) : 0.65;
        const tH = Math.max(0, Math.min(1, (hAtB(col, row) - hmin) / Math.max(1, hmax - hmin)));
        let r, gg, b;
        if (light) { const base = rampAt(tH); const k = 0.75 + 0.5 * (f - 0.6); r = base[0] * k; gg = base[1] * k; b = base[2] * k; }
        else { const t = relief ? tH * 0.25 : 0; r = th.land[0] * (f + t); gg = th.land[1] * (f + t); b = th.land[2] * (f + t); }
        // snow on the dark themes too: a light cap above 90 % of the range
        if (!light && tH > 0.9) { const u = (tH - 0.9) / 0.1; r = r + (200 - r) * u * 0.8; gg = gg + (205 - gg) * u * 0.8; b = b + (215 - b) * u * 0.8; }
        for (let sr = 0; sr < sub; sr++) for (let sc = 0; sc < sub; sc++) {
          const isW = mask != null ? maskBit(mask, sr * sub + sc) === 1 : wat[i] === 1;
          const o = ((row * sub + sr) * W + col * sub + sc) * 4;
          if (isW && withWater) { px[o] = water[0]; px[o + 1] = water[1]; px[o + 2] = water[2]; px[o + 3] = 255; }
          else { px[o] = Math.min(255, Math.round(r)); px[o + 1] = Math.min(255, Math.round(gg)); px[o + 2] = Math.min(255, Math.round(b)); px[o + 3] = 255; }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }  function geoLayer(w, h, dpr) {
    const g = geo.data; if (!g) return null;
    const showW = $("#map-water").checked, showN = $("#map-net").checked, mp = mapPrefs(), th = mapTheme();
    const EDGE_STREET = th.street, EDGE_TRACK = th.track, EDGE_BRIDGE = th.bridge, WATER_FILL = `rgb(${th.water.join(",")})`, WATER_EDGE = th.track;
    const key = [w, h, dpr, map.scale.toFixed(5), Math.round(map.ox), Math.round(map.oy), showW, showN, geo.seq, mp.theme, mp.relief, mp.net].join("|");
    if (geo.layer && geo.key === key) return geo.layer;
    const oc = geo.layer || document.createElement("canvas"); oc.width = w * dpr; oc.height = h * dpr;
    const ctx = oc.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    // the terrain: the sampled land/water bitmap stretched over the bounds (smoothed by the browser), else a plain
    // slightly lighter rectangle so the map's edge is visible
    if (g.bounds) {
      const hb = hmap.data && hmap.meta ? hmap.meta.bounds : g.bounds;  // the HD picture covers its own bounds
      const [ax, ay] = P(hb[0], hb[3]), [bx, by] = P(hb[2], hb[1]);
      const bmKey = showW ? "bmW" : "bmL";
      if (!geo[bmKey] || geo.bmSeq !== geo.seq) { geo.bmW = terrainBitmap(g, true); geo.bmL = terrainBitmap(g, false); geo.bmSeq = geo.seq; }
      if (geo[bmKey]) { ctx.imageSmoothingEnabled = true; ctx.drawImage(geo[bmKey], ax, ay, bx - ax, by - ay); }
      else { ctx.fillStyle = `rgb(${th.land.join(",")})`; ctx.fillRect(ax, ay, bx - ax, by - ay); }
      ctx.strokeStyle = th.frame; ctx.lineWidth = 1; ctx.strokeRect(ax + .5, ay + .5, bx - ax - 1, by - ay - 1);
    }
    // river / lake meshes: only where the grid has no shore detail (no refined cells yet = older mod); with the
    // refined grid the meshes would add tile-seam jaggies on top of a better picture
    if (showW && g.water && !(g.shore && g.shore.length)) {
      ctx.fillStyle = WATER_FILL;
      ctx.beginPath();
      g.water.forEach(c => { for (let i = 0; i < c.length; i += 2) { const [x, y] = P(c[i], c[i + 1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); } ctx.closePath(); });
      ctx.fill("evenodd");
    }
    if (showN && g.edges) {
      // streets thin and dark, tracks lighter; bridges a shade lighter, tunnels dashed. Below ~0.05 px/m streets
      // would only grey the map: skip them, keep tracks.
      const streets = map.scale >= 0.03, k = mp.net;
      const pass = (kindTest, color, width, dash) => { ctx.strokeStyle = color; ctx.lineWidth = width * k; ctx.globalAlpha = Math.min(1, 0.6 + 0.4 * k); ctx.setLineDash(dash || []); ctx.beginPath(); g.edges.forEach(e => { if (!kindTest(e[4])) return; const [x0, y0] = P(e[0], e[1]), [x1, y1] = P(e[2], e[3]); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; };
      if (streets) { pass(k => (k & 1) === 0 && !(k & 4), EDGE_STREET, Math.max(1, Math.min(3, map.scale * 8))); pass(k => (k & 1) === 0 && (k & 4), EDGE_STREET, 1, [3, 3]); }
      pass(k => (k & 1) === 1 && !(k & 6), EDGE_TRACK, Math.max(1, Math.min(2.5, map.scale * 6)));
      pass(k => (k & 1) === 1 && (k & 2), EDGE_BRIDGE, Math.max(1.5, Math.min(3, map.scale * 7)));
      pass(k => (k & 1) === 1 && (k & 4), EDGE_TRACK, 1.5, [4, 3]);
    }
    geo.layer = oc; geo.key = key;
    return oc;
  }
  function fitMap(canvas) {
    const d = map.data; const w = canvas.clientWidth, h = canvas.clientHeight;
    let minx, maxx, miny, maxy;
    if (geo.data && geo.data.bounds) { [minx, miny, maxx, maxy] = geo.data.bounds; }
    else {
      const pts = [...d.towns, ...d.stations, ...d.industries, ...d.vehicles, ...(d.headquarters ? [d.headquarters] : [])].filter(p => p.x != null);
      if (!pts.length) return;
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      minx = Math.min(...xs); maxx = Math.max(...xs); miny = Math.min(...ys); maxy = Math.max(...ys);
    }
    map.scale = (geo.data && geo.data.bounds ? 0.97 : 0.9) * Math.min(w / Math.max(1, maxx - minx), h / Math.max(1, maxy - miny));
    map.ox = w / 2 - ((minx + maxx) / 2) * map.scale; map.oy = h / 2 + ((miny + maxy) / 2) * map.scale;
    map.fitted = true;
  }
  // the view (scale / offset) is remembered per savegame and restored on the next visit; set from wheel / drag / recentre
  const viewKey = () => "tf3.mapview." + (map.gameKey || "default");
  function saveView() { map.userView = true; try { localStorage.setItem(viewKey(), JSON.stringify({ s: map.scale, x: map.ox, y: map.oy, w: $("#map").clientWidth, h: $("#map").clientHeight })); } catch (e) { /* ignore */ } }
  function restoreView(canvas) {
    try {
      const v = JSON.parse(localStorage.getItem(viewKey()) || "null"); if (!v || !(v.s > 0)) return false;
      // the canvas may have another size now: keep the same world point in the centre
      const cx = (canvas.clientWidth / 2 - v.x) / v.s, cy = -(canvas.clientHeight / 2 - v.y) / v.s;
      const cx0 = (v.w / 2 - v.x) / v.s, cy0 = -(v.h / 2 - v.y) / v.s;
      map.scale = v.s; map.ox = canvas.clientWidth / 2 - cx0 * v.s; map.oy = canvas.clientHeight / 2 + cy0 * v.s;
      map.fitted = true; map.userView = true; return true;
    } catch (e) { return false; }
  }
  const P = (x, y) => [map.ox + x * map.scale, map.oy - y * map.scale]; // game y up
  // ---- cargo layers. Three toggles, one visual grammar for towns and industries: small cargo icons in rows anchored
  // to their owner. Above = what it produces (industries), below = what it needs (towns and industries), right = what
  // is lying there now (towns; industry piles need a mod export). Production and demand icons are fixed size, dimmed
  // when the rate is low (produced vs max production, delivered vs need); stock icons grow with the amount (square
  // root, 10 to 26 px). Each row sits on a dark pill so it reads over the relief. Only from a zoom where the rows do
  // not collide (the `big` threshold of the map); a row that would still overlap an earlier one is left out.
  const mapCargo = { data: null, at: 0 };
  const townRadius = (tw) => Math.max(8, Math.min(60, Math.sqrt(tw.size || 100) * 0.3 * Math.sqrt(map.scale * 10)));
  const cargoAny = () => $("#map-prod").checked || $("#map-need").checked || $("#map-stock").checked;
  async function loadMapCargo() {
    try { mapCargo.data = await api("/api/map_cargo"); mapCargo.at = Date.now(); } catch (e) { /* keep what we have */ }
  }
  const cargoImg = (key) => mapIcon("cargo/" + (CARGO_ICON_FILES.has(key) ? key : "_mixed"));
  function drawCargoLayers(ctx, d) {
    const cd = mapCargo.data; if (!cd || !cargoAny() || map.scale <= 0.06) return;
    const prod = $("#map-prod").checked, need = $("#map-need").checked, stock = $("#map-stock").checked;
    // pills already placed this frame: a new one that would overlap an earlier one is skipped (owners are drawn
    // biggest first, so at a middle zoom the small neighbours give way instead of piling up)
    const placed = [];
    const free = (x, y, w, h) => { for (const p of placed) if (x < p[0] + p[2] && x + w > p[0] && y < p[1] + p[3] && y + h > p[1]) return false; placed.push([x, y, w, h]); return true; };
    const row = (items, cx, cy, side, sizer, alpha) => {
      if (!items || !items.length) return false;
      const sizes = items.map(sizer), gap = 3, w = sizes.reduce((a, b) => a + b, 0) + gap * (items.length - 1), hmax = Math.max(...sizes);
      let x0, y0;  // top-left of the row
      if (side === "above") { x0 = cx - w / 2; y0 = cy - 17 * k - hmax; }
      else if (side === "below") { x0 = cx - w / 2; y0 = cy + 17 * k; }
      else { x0 = cx + 17 * k; y0 = cy - hmax / 2; }
      if (!free(x0 - 3, y0 - 3, w + 6, hmax + 6)) return false;
      ctx.fillStyle = "rgba(11,16,21,.85)"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0 - 3, y0 - 3, w + 6, hmax + 6, 4) : ctx.rect(x0 - 3, y0 - 3, w + 6, hmax + 6); ctx.fill();
      let x = x0;
      items.forEach((it, i) => { const sz = sizes[i], im = cargoImg(it.key); ctx.globalAlpha = alpha(it); if (im.complete && im.naturalWidth) ctx.drawImage(im, x, y0 + (hmax - sz) / 2, sz, sz); else { ctx.fillStyle = "#c9d1d9"; ctx.fillRect(x, y0 + (hmax - sz) / 2, sz, sz); } x += sz + gap; });
      ctx.globalAlpha = 1;
      return true;
    };
    const k = isz();
    const fixed = () => 16 * k;
    const grow = (it) => 12 * k + Math.min(16, Math.sqrt(it.amount || 0) * 1.1);  // base follows the setting, the pile does not
    const rateAlpha = (it) => it.rate == null ? 0.9 : 0.35 + 0.65 * Math.max(0, Math.min(1, it.rate));
    const stockAlpha = (it) => (it.amount || 0) > 0 ? 1 : 0.3;
    const stroke = (cx, cy, side) => { /* a short tie from the owner to the row, so ownership stays obvious when rows are close */ ctx.strokeStyle = "rgba(188,140,255,.8)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, cy); if (side === "above") ctx.lineTo(cx, cy - 15 * k); else if (side === "below") ctx.lineTo(cx, cy + 15 * k); else ctx.lineTo(cx + 15 * k, cy); ctx.stroke(); };
    const draw = (kind, list, idKey, offset) => list.forEach(o => {
      const c = cd[kind][String(o[idKey])]; if (!c) return;
      let [x, y] = P(o.x, o.y);
      if (x < -200 || y < -200 || x > ctx.canvas.clientWidth + 200 || y > ctx.canvas.clientHeight + 200) return;
      // a town is a crowd of vehicles and stations: its rows hang below the town circle, not on the centre
      const dy = offset ? offset(o) : 0;
      if (prod && c.out.length && row(c.out, x, y, "above", fixed, rateAlpha)) stroke(x, y, "above");
      const needShown = need && c.in.length && row(c.in, x, y + dy, "below", fixed, rateAlpha);
      if (needShown && !dy) stroke(x, y, "below");
      // empty stocks are only worth showing when the demand row is off (it already says what is missing)
      const st = stock ? c.stock.filter(it => (it.amount || 0) > 0 || !need || !c.in.length) : [];
      if (st.length && row(st, x, y + dy + (needShown ? 16 * k + 10 : 0), dy ? "below" : "right", grow, stockAlpha) && !dy) stroke(x, y, "right");
    });
    // biggest owners first: at a middle zoom the small neighbours yield
    const bySize = (list, sz) => list.slice().sort((a, b) => sz(b) - sz(a));
    if ($("#map-ind").checked) draw("industries", bySize(d.industries, i => (i.level || 1) * 10 + (cd.industries[String(i.industry_id)] || { out: [], in: [] }).out.length), "industry_id");
    if ($("#map-towns").checked) draw("towns", bySize(d.towns, tw => tw.size || 0), "town_id", (tw) => townRadius(tw) + 2);
  }
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
  // ---- ruler. The game pays by the straight line between pickup and dropoff, never by the length of track
  // (base/content/economy.zip, economy/cargo_income.script.lua: distance = |AB| + 8 * max(dz, 0)), so a ruler as the
  // crow flies IS the planning figure. Click A, click B: the segment, its length, the height difference from the
  // terrain grid when the geography is known, and the "paid" distance when B is higher. A third click starts over,
  // the button or Escape leaves. Companion only, nothing sent to the game.
  // Once B is fixed the companion also asks /api/distance for the shortest way over the existing roads and over the
  // existing tracks (Dijkstra on the exported geography, server side): the ruler then shows both lengths and draws
  // the two routes, which is what a ruler is for when planning a line between two points that are already served.
  const ruler = { on: false, a: null, b: null, hover: null, net: null, netKey: null };
  // km/h used when the player owns no vehicle of that carrier yet (the mod exports the top speed of each vehicle;
  // the server returns the fastest owned one per carrier as road_kmh / rail_kmh)
  const RULER_SPEED = { road: 50, rail: 80 };
  function rulerSet(on) {
    ruler.on = on; ruler.a = ruler.b = ruler.hover = ruler.net = ruler.netKey = null;
    $("#map-ruler-btn").classList.toggle("active", on);
    const c = $("#map"); c.style.cursor = on ? "crosshair" : "grab"; $("#map-tip").style.display = "none"; drawMap(c);
  }
  const worldAt = (canvas, e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left - map.ox) / map.scale, y: -(e.clientY - r.top - map.oy) / map.scale }; };
  function rulerClick(canvas, e) {
    const p = worldAt(canvas, e);
    if (!ruler.a || ruler.b) { ruler.a = p; ruler.b = null; ruler.net = null; } else { ruler.b = p; rulerNetwork(canvas); }
    drawMap(canvas);
  }
  async function rulerNetwork(canvas) {
    const a = ruler.a, b = ruler.b; if (!a || !b || !geo.data) return;
    const key = [a.x, a.y, b.x, b.y].map(v => Math.round(v)).join(",");
    ruler.netKey = key;
    try {
      const r = await api(`/api/distance?ax=${a.x.toFixed(1)}&ay=${a.y.toFixed(1)}&bx=${b.x.toFixed(1)}&by=${b.y.toFixed(1)}`);
      if (ruler.netKey === key && ruler.b) { ruler.net = r; drawMap(canvas); }
    } catch (e) { /* no geography yet: the ruler stays as the crow flies */ }
  }
  // terrain height at a world point, from the coarse height grid of the geography (bilinear); null without geography
  function heightAt(x, y) {
    const g = geo.data; if (!g || !g.heights || !g.grid || !g.bounds) return null;
    const [nx, ny] = g.grid, every = g.height_every || 4, hx = Math.ceil(nx / every), hy = Math.ceil(ny / every);
    const fx = (x - g.bounds[0]) / (g.bounds[2] - g.bounds[0]) * nx / every - 0.5, fy = (g.bounds[3] - y) / (g.bounds[3] - g.bounds[1]) * ny / every - 0.5;  // row 0 = north
    const ci = Math.floor(fx), ri = Math.floor(fy), tx = fx - ci, ty = fy - ri;
    const H = (c, r) => { c = Math.max(0, Math.min(hx - 1, c)); r = Math.max(0, Math.min(hy - 1, r)); const v = g.heights[r * hx + c]; return v != null ? v : 0; };
    return (H(ci, ri) * (1 - tx) + H(ci + 1, ri) * tx) * (1 - ty) + (H(ci, ri + 1) * (1 - tx) + H(ci + 1, ri + 1) * tx) * ty;
  }
  const fmtDist = (m) => m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
  function drawRuler(ctx, w, h, font, ink, halo) {
    if (!ruler.on) { rulerPanel(null, null, null); return; }
    const a = ruler.a, b = ruler.b || ruler.hover;
    ctx.save(); ctx.strokeStyle = "#e8b04b"; ctx.fillStyle = "#e8b04b"; ctx.lineWidth = 2;
    const dot = (p) => { const [x, y] = P(p.x, p.y); ctx.beginPath(); ctx.arc(x, y, 5 * isz(), 0, 7); ctx.fill(); ctx.strokeStyle = "#0b1015"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.strokeStyle = "#e8b04b"; ctx.lineWidth = 2; };
    // the network routes first, under the straight segment: road in the street colour, rail in the track colour
    const net = ruler.b && ruler.net;
    // solid = the way over the existing network, dashed = the legs to build (A to the network, network to B; when
    // A and B sit on separate networks the second leg bridges the gap)
    const route = (pts, color, dashed) => {
      if (!pts || pts.length < 2) return;
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = dashed ? 2 : 3; ctx.lineJoin = "round"; ctx.globalAlpha = .9;
      if (dashed) ctx.setLineDash([5, 5]);
      ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke(); ctx.restore();
    };
    const show = (mode, color) => { route(net[mode + "_points"], color, false); (net[mode + "_legs"] || []).forEach(l => route(l, color, true)); };
    if (net) { show("road", "#f0a35e"); show("rail", "#7fb8ff"); }
    if (a) dot(a);
    if (a && b) {
      const [ax, ay] = P(a.x, a.y), [bx, by] = P(b.x, b.y);
      if (!ruler.b) ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      if (ruler.b) dot(b);
      rulerPanel(a, b, net);
    } else rulerPanel(a, null, null);
    ctx.restore();
  }
  // The readout is an HTML box under the toolbar, always the same rows (placeholders until known) so it never
  // jumps or hides what is being drawn. Rows: as the crow flies, height, paid as, by road, by rail.
  function rulerPanel(a, b, net) {
    const el = $("#map-ruler"); if (!el) return;
    el.style.display = ruler.on ? "" : "none";
    if (!ruler.on) return;
    // hung right under the ruler button (the toolbar lives outside the map card, so position from its screen rect)
    const br = $("#map-ruler-btn").getBoundingClientRect(), cr = el.offsetParent.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(cr.width - el.offsetWidth - 8, br.right - cr.left - el.offsetWidth)) + "px";
    el.style.top = Math.max(8, br.bottom - cr.top + 6) + "px";
    if (!a || !b) { el.innerHTML = `<div class="hint">${t(a ? "ruler_hint_b" : "ruler_hint_a")}</div>`; return; }
    const dist = Math.hypot(b.x - a.x, b.y - a.y), ha = heightAt(a.x, a.y), hb = heightAt(b.x, b.y);
    const dz = ha != null && hb != null ? hb - ha : null;
    const trip = (m, kmh, owned) => { const mm = Math.round(m / (kmh / 3.6) / 60); return (mm >= 60 ? Math.floor(mm / 60) + " h " + String(mm % 60).padStart(2, "0") : mm + " min") + " @ " + kmh + " km/h" + (owned ? "" : " <small class=\"muted\">" + t("ruler_speed_guess") + "</small>"); };
    const parts = (p, gap) => gap ? t("ruler_build_straight") : `A +${fmtDist(p[0])} · ${fmtDist(p[1])} · +${fmtDist(p[2])} B`;
    const row = (sw, v, s, cls) => `<div class="r"><i style="background:${sw || "transparent"}"></i><b class="${cls || ""}">${v}</b><span>${s}</span></div>`;
    const netRow = (mode, sw, kmh) => {
      if (!net || !net.available) return row(sw, "…", t("ruler_" + mode, { d: "" }).trim());
      if (net[mode] == null) return row(sw, "–", t("ruler_" + mode, { d: t("ruler_none") }));
      const owned = net[mode + "_kmh"] > 0;
      return row(sw, fmtDist(net[mode]), trip(net[mode], owned ? net[mode + "_kmh"] : kmh, owned) + (net[mode + "_parts"] ? "<br>" + parts(net[mode + "_parts"], net[mode + "_gap"]) : ""));
    };
    el.innerHTML = row("#e8b04b", fmtDist(dist), ruler.b ? "" : "…")
      + row(null, dz != null ? (dz >= 0 ? "+" : "") + Math.round(dz) + " m" : "–", t("ruler_height"), dz > 0 ? "up" : "down")
      + row(null, dz != null ? fmtDist(dist + 8 * Math.max(0, dz)) : fmtDist(dist), t("ruler_paid_as"))
      + netRow("road", "#f0a35e", RULER_SPEED.road) + netRow("rail", "#7fb8ff", RULER_SPEED.rail);
  }
  function drawMap(canvas) {
    const d = map.data; if (!d) return;
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!map.fitted) { if (map.restoreKey !== viewKey()) { map.restoreKey = viewKey(); if (!restoreView(canvas)) fitMap(canvas); } else fitMap(canvas); }
    if (!map.zoomedOnce) { map.zoomedOnce = true; const z = +new URLSearchParams(location.search).get("mapzoom"); const tw = z && d.towns.find(x => x.town_id === z); if (tw) { map.scale = 0.25; map.ox = w / 2 - tw.x * map.scale; map.oy = h / 2 + tw.y * map.scale; } }
    const lf = map.lineFilter;
    const font = getComputedStyle(document.documentElement).getPropertyValue("--font");
    const th = mapTheme(), lw = mapPrefs().lines, ink = th.ink || "#e6edf3", halo = th.halo || "#0b1015", k = isz();
    ctx.fillStyle = th.page; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = th.frame; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    const step = 1000 * map.scale; if (step > 12) { for (let x = map.ox % step; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); } for (let y = map.oy % step; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); } } ctx.globalAlpha = 1;
    const gl = geoLayer(w, h, dpr); if (gl) ctx.drawImage(gl, 0, 0, w, h);
    ctx.font = "12px " + font;
    // lines: along the network when the mod reported the legs, else straight from stop to stop
    if ($("#map-lines").checked && d.lines) { ctx.lineJoin = "round"; ctx.lineCap = "round"; d.lines.forEach(l => { const on = lf == null || l.line_id === lf; ctx.strokeStyle = rgb(l.color_r, l.color_g, l.color_b); ctx.globalAlpha = on ? (lf == null ? Math.min(1, 0.5 * lw + 0.1) : 0.95) : 0.08; ctx.lineWidth = (on && lf != null ? 4 : 2) * lw; const legs = linePolylines(l.line_id); if (legs) { [false, true].forEach(pred => { const sel = legs.filter(g => g.predicted === pred); if (!sel.length) return; ctx.setLineDash(pred ? [7, 5] : []); ctx.beginPath(); sel.forEach(g => g.pts.forEach(([x, y], i) => { const [px, py] = P(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); })); ctx.stroke(); }); ctx.setLineDash([]); } else if (l.points.length > 1) { ctx.setLineDash(lf == null ? [] : [6, 4]); ctx.beginPath(); l.points.forEach(([x, y], i) => { const [px, py] = P(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.stroke(); ctx.setLineDash([]); } ctx.globalAlpha = 1; }); ctx.lineJoin = "miter"; ctx.lineCap = "butt"; }
    if ($("#map-towns").checked) d.towns.forEach(tw => { const [x, y] = P(tw.x, tw.y); const r = townRadius(tw); ctx.fillStyle = "rgba(79,138,138,.15)"; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.strokeStyle = th.ink ? "#2f6b6b" : "#4f8a8a"; ctx.stroke(); ctx.textAlign = "center"; ctx.font = "600 13px " + font; ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.strokeText(tw.name, x, y - r - 5); ctx.fillStyle = ink; ctx.fillText(tw.name, x, y - r - 5); ctx.font = "12px " + font; });
    if ($("#map-hq").checked && d.headquarters) { const [x, y] = P(d.headquarters.x, d.headquarters.y); ctx.fillStyle = "#e8b04b"; ctx.beginPath(); ctx.arc(x, y, 9 * k, 0, 7); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#0b1015"; ctx.stroke(); ctx.fillStyle = "#e6edf3"; ctx.textAlign = "center"; ctx.font = "600 12px " + font; ctx.fillText(t("map_hq"), x, y - 14 * k); ctx.font = "12px " + font; }
    const big = map.scale > 0.08;
    if ($("#map-ind").checked) d.industries.forEach(i => { const [x, y] = P(i.x, i.y); if (!big || !drawIcon(ctx, "industry", x, y, 20 * k, "#bc8cff")) { ctx.fillStyle = "#bc8cff"; ctx.fillRect(x - 5 * k, y - 5 * k, 10 * k, 10 * k); } });
    if ($("#map-dep").checked) (d.depots || []).forEach(dp => { const [x, y] = P(dp.x, dp.y); if (!big || !drawIcon(ctx, "depot", x, y, 18 * k, "#9aa7b4")) { ctx.fillStyle = "#9aa7b4"; ctx.fillRect(x - 4 * k, y - 4 * k, 8 * k, 8 * k); } });
    if ($("#map-st").checked) d.stations.forEach(s => { const [x, y] = P(s.x, s.y); const kd = stKind(s); ctx.fillStyle = kd.pax ? "#58a6ff" : "#e8b04b"; ctx.beginPath(); ctx.moveTo(x, y - 7 * k); ctx.lineTo(x + 7 * k, y); ctx.lineTo(x, y + 7 * k); ctx.lineTo(x - 7 * k, y); ctx.closePath(); ctx.fill();
      if (kd.pax && kd.cargo) { ctx.fillStyle = "#e8b04b"; ctx.beginPath(); ctx.moveTo(x, y - 3.5 * k); ctx.lineTo(x + 3.5 * k, y); ctx.lineTo(x, y + 3.5 * k); ctx.lineTo(x - 3.5 * k, y); ctx.closePath(); ctx.fill(); } });
    drawCargoLayers(ctx, d);
    const showLabels = $("#map-labels").checked;
    if ($("#map-veh").checked) d.vehicles.forEach(v => {
      if (lf != null && v.line_id !== lf) return; const [x, y] = P(v.x, v.y); const col = v.color_r != null ? rgb(v.color_r, v.color_g, v.color_b) : CARRIER_COLOR[v.carrier] || "#fff"; const moving = v.state === "EN_ROUTE" && v.speed_ms > 0.3;
      const stopped = v.state === "EN_ROUTE" && !moving;
      if (big || lf != null) {
        ctx.fillStyle = "#0b1015"; ctx.beginPath(); ctx.arc(x, y, 12 * k, 0, 7); ctx.fill(); ctx.lineWidth = stopped ? 2.5 : 1.5; ctx.strokeStyle = stopped ? "#f85149" : col; ctx.stroke();
        if (!drawIcon(ctx, ICON_BY_TYPE[v.icon_type] || ICON_BY_CARRIER[v.carrier] || "veh_car", x, y, 17 * k, col)) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
      } else { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, (moving ? 5.5 : 4.5) * k, 0, 7); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = stopped ? "#f85149" : "#0b1015"; ctx.stroke(); }
      if (showLabels || lf != null) { ctx.textAlign = "left"; ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.strokeText(v.name, x + 14 * k, y + 4); ctx.fillStyle = ink; ctx.fillText(v.name, x + 14 * k, y + 4); }
    });
    if ($("#map-alerts").checked) d.alerts.forEach(a => { const [x, y] = P(a.x, a.y); ctx.strokeStyle = "#f85149"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 15 * k, 0, 7); ctx.stroke(); drawIcon(ctx, "alert", x, y, 18 * k, "#f85149"); });
    // current camera as a view cone: eye position (behind the target, by dist * cos(pitch)) and two lines diverging
    // towards the target, then a little beyond; the opening (zoom) is the cone's half-angle. Drawn first so the pins
    // stay readable. Saved views = numbered pins with a star; the one the camera is on is highlighted.
    const act = activeView();
    // the travelling being played (orbit circle, dolly segment, chain curve...): the points we sent, drawn where the
    // camera EYE is on the ground (centre pushed back along the heading by dist*cos(pitch)); dashed preview of the
    // selected movement when idle. The current camera itself is the view cone drawn just below.
    // preview = the draft of the travellings panel when it is a movement around a view (dotted eye track)
    const tv = travel.active || (trv.draft && trv.draft.kind === "view" && camViews.list.find(v => v.id === trv.draft.view) ? (() => { const tp = { ...TRAVEL_DEFAULTS, ...trv.draft }, v = liveView(camViews.list.find(x => x.id === tp.view)); return v ? { points: TRAVEL_MOVES[tp.move](v, tp), preview: true } : null; })() : null);
    if (tv && tv.points.length > 1) {
      ctx.save(); ctx.strokeStyle = tv.preview ? "rgba(232,176,75,.45)" : "#e8b04b"; ctx.lineWidth = 2; if (tv.preview) ctx.setLineDash([6, 6]);
      ctx.beginPath();
      tv.points.forEach((pt, i) => { const a = CAM_ANGLE_SIGN * pt.angle + CAM_ANGLE_OFFSET, back = pt.dist * Math.cos(Math.abs(pt.pitch)); const ex = pt.x + Math.sin(a) * back, ey = pt.y - Math.cos(a) * back; const [x, y] = P(ex, ey); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke(); ctx.restore();
    }
    if (camViews.cur) drawViewCone(ctx, camViews.cur, act ? "#e8b04b" : ink);
    camViews.list.forEach((v0, i) => {
      const v = liveView(v0) || v0;  // attached views are pinned where the vehicle is now
      const [x, y] = P(v.x, v.y), on = act && act.id === v0.id;
      drawIcon(ctx, "star", x, y - 17 * k, 20 * k, "#e8b04b");
      ctx.fillStyle = on ? "#e8b04b" : "#e6edf3"; ctx.strokeStyle = "#0b1015"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, (on ? 11 : 10) * k, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#0b1015"; ctx.textAlign = "center"; ctx.font = "600 11px " + font; ctx.fillText(String(i + 1), x, y + 4); ctx.font = "12px " + font;
    });
    if (ruler.on) { ctx.save(); ctx.globalCompositeOperation = "saturation"; ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, w, h); ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = "rgba(11,16,21,.35)"; ctx.fillRect(0, 0, w, h); ctx.restore(); }  // measuring: the map steps back in grey, only the ruler is in colour
    drawRuler(ctx, w, h, font, ink, halo);
    const px = 1000 * map.scale; ctx.strokeStyle = th.ink ? "#3a4048" : "#8b98a8"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(16, h - 16); ctx.lineTo(16 + px, h - 16); ctx.stroke(); ctx.fillStyle = th.ink ? "#3a4048" : "#8b98a8"; ctx.textAlign = "left"; ctx.fillText("1 km", 16, h - 22);
    $("#map-legend").innerHTML = `<span>${ico("veh_bus", "sm")}${t("legend_vehicle")} · <span style="color:#f85149">○</span> ${t("legend_stopped")}</span><span><span style="color:#58a6ff">◆</span> ${t("legend_pax_station")} · <span style="color:#e8b04b">◆</span> ${t("legend_cargo_station")} · <span style="color:#bc8cff">${ico("industry", "sm")}</span>${t("legend_industry")} · <span style="color:#9aa7b4">${ico("depot", "sm")}</span>${t("legend_depot")}</span><span>${t("legend_counts", { v: d.vehicles.length, s: d.stations.length, i: d.industries.length })}</span>${geo.data ? `<span><span style="color:${th.track}">━</span> ${t("legend_track")} · <span style="color:${th.street}">━</span> ${t("legend_street")} · <span style="color:rgb(${th.water.join(",")})">▇</span> ${t("legend_water")}</span>` : `<span class="muted">${t("legend_no_geo")}</span>`}`;
  }
  function pickMap(canvas, e) {
    const d = map.data; if (!d) return null;
    const r = canvas.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 140;
    // what a vehicle carries right now, icon + amount per cargo (same layout as the owner tooltips)
    const vehCargoTip = (v) => { const e = Object.entries(v.cargo || {}); return e.length ? `<div class="tipcargo"><div class="tr">${e.map(([k, n]) => `<span class="tc">${cargoIcon({ cargo_key: k }, "sm")}<b>${n}</b></span>`).join("")}</div></div>` : ""; };
    const consider = (obj, kind, entity, txt, extra) => { const [x, y] = P(obj.x, obj.y); const dd = (x - mx) ** 2 + (y - my) ** 2; if (dd < bd) { bd = dd; best = { kind, entity, txt, x, y, ...extra }; } };
    camViews.list.forEach((v0, i) => { const v = liveView(v0) || v0; consider(v, "view", null, `<b>${i + 1} · ${esc(v.name)}</b><br>${t("cam_go_hint", { n: i + 1 })}`, { view: v0 }); });
    if ($("#map-veh").checked) d.vehicles.forEach(v => { if (map.lineFilter != null && v.line_id !== map.lineFilter) return; consider(v, "vehicle", v.vehicle_id, `<b>${modelImg(v, "sm")}${esc(v.name)}</b><br>${esc(v.line_name || t("no_line"))} · ${ST(v.state)}<br>${kmh(v.speed_ms)} · ${t("load_n", { a: v.load ?? 0, b: v.capacity ?? "?" })}${vehCargoTip(v)}`); });
    if ($("#map-st").checked) d.stations.forEach(s => consider(s, "station", s.station_id, `<b>${esc(s.name)}</b><br>${stKind(s).label()}`));
    // the cargo figures behind the layers: rate as a percentage, stocks as amounts (the map only shows icons)
    const cargoTip = (kind, id) => {
      const c = mapCargo.data && mapCargo.data[kind] && mapCargo.data[kind][String(id)]; if (!c) return "";
      // one row per layer: label, then icon+figure pairs that never break in the middle
      const li = (items, f) => items.map(it => `<span class="tc">${cargoIcon({ cargo_key: it.key }, "sm")}<b>${f(it)}</b></span>`).join("");
      const pc = (it) => it.rate == null ? "–" : Math.round(it.rate * 100) + "%";
      let s = "";
      if (c.out.length) s += `<div class="tr"><span class="tl">${t("map_prod")}</span>${li(c.out, pc)}</div>`;
      if (c.in.length) s += `<div class="tr"><span class="tl">${t("map_need")}</span>${li(c.in, pc)}</div>`;
      if (c.stock.length) s += `<div class="tr"><span class="tl">${t("map_stock")}</span>${li(c.stock, it => it.capacity ? `${it.amount}/${it.capacity}` : String(it.amount))}</div>`;
      return s ? `<div class="tipcargo">${s}</div>` : "";
    };
    if ($("#map-ind").checked) d.industries.forEach(i => consider(i, "industry", i.industry_id, `<b>${esc(i.name)}</b><br>${t("industry")}${cargoTip("industries", i.industry_id)}`));
    if ($("#map-dep").checked) (d.depots || []).forEach(dp => consider(dp, "depot", dp.depot_id, `<b>${esc(dp.name)}</b><br>${t("th_depot")} · ${CA(dp.carrier)}<br>${t("th_parked")} ${dp.vehicles ?? 0} · ${t("th_incoming")} ${dp.incoming ?? 0}`));
    if ($("#map-towns").checked) d.towns.forEach(tw => consider(tw, "town", tw.town_id, `<b>${esc(tw.name)}</b><br>${t("capacity_n", { n: int(tw.size) })}${cargoTip("towns", tw.town_id)}`));
    if ($("#map-hq").checked && d.headquarters) consider(d.headquarters, "hq", d.headquarters.id ?? null, `<b>${t("map_hq")}</b>`);
    return best ? { ...best, mx, my } : null;
  }
  function hoverMap(canvas, e) {
    const tip = $("#map-tip");
    if (ruler.on) { tip.style.display = "none"; if (ruler.a && !ruler.b) { ruler.hover = worldAt(canvas, e); drawMap(canvas); } return; }
    const hit = pickMap(canvas, e);
    canvas.style.cursor = hit ? "pointer" : "grab";
    if (hit) { tip.style.display = "block"; tip.style.left = (hit.mx + 14) + "px"; tip.style.top = (hit.my + 14) + "px"; tip.innerHTML = hit.txt; } else tip.style.display = "none";
  }

  // ------------------------------------------------------------ refresh loop
  const RENDER = { overview: renderOverview, lines: renderLines, vehicles: renderVehicles, towns: renderTowns, industries: renderIndustries, stations: renderStations, map: renderMap, finance: renderFinance };
  let busy = false, again = false;
  // A pointer button held down = the user is mid-click. Re-rendering now would swap the element under
  // the pointer between mousedown and mouseup and the browser would drop the click (one had to click twice).
  // The guard is released on pointerup / cancel / click / blur, and after 1.5 s whatever happened: a pointerup lost
  // to a disabled control or to an element replaced mid-click must never leave the refresh loop stalled.
  let pointerDown = false, pointerTimer = null;
  const pointerUp = () => { if (pointerTimer) { clearTimeout(pointerTimer); pointerTimer = null; } if (!pointerDown) return; pointerDown = false; if (again) { again = false; setTimeout(refresh, 0); } };
  document.addEventListener("pointerdown", () => { pointerDown = true; if (pointerTimer) clearTimeout(pointerTimer); pointerTimer = setTimeout(pointerUp, 1500); }, true);
  document.addEventListener("pointerup", pointerUp, true);
  document.addEventListener("pointercancel", pointerUp, true);
  document.addEventListener("click", pointerUp, true);
  window.addEventListener("blur", pointerUp);
  async function refresh() {
    if (busy || pointerDown) { again = true; return; } busy = true;
    try {
      const o = await renderTop();
      if (o && RENDER[state.tab]) await RENDER[state.tab](o);
    } catch (e) { $("#st-dot").className = "dot dead"; $("#st-text").textContent = t("server_down", { msg: e.message }); console.error(e); }
    busy = false;
    if (again) { again = false; refresh(); }
  }
  ["#lines-filter", "#lines-problems-only", "#veh-filter", "#veh-worn", "#veh-problem", "#ind-filter", "#ind-unserved"].forEach(s => { const el = $(s); if (!el) return; el.addEventListener("input", () => refresh()); el.addEventListener("change", () => refresh()); });
  let timer = null;
  function restartTimer() { if (timer) clearInterval(timer); timer = setInterval(() => refresh(), Math.max(1, settings.refresh) * 1000); }
  setLang(pickLang(), false);
  applySettings();
  if (new URLSearchParams(location.search).get("settings")) { $("#settings").classList.add("open"); $("#gear").classList.add("open"); renderSaves(); }
  if (new URLSearchParams(location.search).get("layout_edit")) Layout.enterEdit();
  const initial = tabFromUrl() || settings.defaultTab;
  if (initial && RENDER[initial]) showTab(initial, false); else refresh();
  VEH_MANIFEST.loading.then(() => refresh());  // first render may have happened before the model icon list arrived
})();
