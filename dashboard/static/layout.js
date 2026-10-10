/* Panel layout: every card of a tab sits on a 12-column grid with 10 px rows and has an explicit place
   {x, y, w, h} (column, row, width in columns, height in rows). In edit mode a card is dragged anywhere and
   resized from its edges; the ghost snaps to the grid, i.e. to the edges of its neighbours, and cards float up to
   fill the holes (gravity), so a layout never has large gaps and stays stable when the window changes width.
   Each `.panels[data-layout]` container holds `.card[data-panel][data-w]` children; the first time a card is seen
   its default height is measured from its content.
   State per tab in localStorage "tf3.layout" (v2): { tab: { v: 2, panels: { id: { x, y, w, h, hidden } } } }.
   A v1 state (order + width + optional height) is migrated by flowing the cards in order.
   Exposes window.Layout = { enterEdit, exitEdit, toggleEdit, isEditing, reset, resetAll, apply, applyAll, onChange, titleOf }. */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const KEY = "tf3.layout", PIN_KEY = "tf3.pinned";  // pinned: ids of cards shown on Operations instead of their home tab
  const COLS = 12, ROW = 10, GAP = 14, MIN_W = 2, MIN_H = 12;  // MIN_H rows = 120 px
  /** Shipped layout, per tab: panel -> [x, y, w, h] (grid columns / rows of ROW px). Used when a tab has no saved
      layout (first start, Reset); cards unknown to the preset (added later) flow below it as usual. */
  const PRESET = {
    overview: { "fleet-state": [4, 35, 3, 35], "by-carrier": [2, 0, 5, 35], "alerts": [0, 0, 2, 49], "fleet-perf": [2, 90, 5, 33], "idle": [0, 49, 2, 74], "stuck": [2, 35, 2, 55], "worn": [7, 35, 4, 34], "lines-bad": [7, 0, 4, 35], "lines-load": [7, 69, 4, 37] },
    vehicles: { "veh-table": [0, 0, 7, 64], "veh-detail": [7, 0, 5, 64] },
    lines: { "lines-table": [0, 0, 6, 123], "line-detail": [6, 0, 6, 123] },
    map: { "cam-views": [7, 0, 2, 39], "travellings": [9, 0, 3, 39], "map": [0, 0, 7, 111], "trv-workshop": [7, 39, 4, 63] },
    towns: { "towns-table": [0, 0, 7, 117], "town-detail": [7, 0, 5, 117] },
    industries: { "ind-table": [0, 0, 7, 105], "ind-detail": [7, 0, 5, 101] },
    stations: { "st-table": [0, 0, 7, 64], "st-detail": [7, 0, 5, 99], "dep-table": [0, 64, 7, 64] },
    finance: { "journal": [0, 0, 6, 83], "balance": [6, 0, 3, 32], "earnings": [0, 83, 6, 37], "transport": [6, 32, 3, 28], "network": [9, 32, 3, 28], "company-chart": [9, 0, 3, 32], "company": [8, 60, 4, 56], "costs": [6, 60, 2, 30] },
  };
  let store = load();
  let editing = false;
  const listeners = [];
  const tr = (k) => (window.__t ? window.__t(k) : k);

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { return {}; } }
  // ---------------------------------------------------------------- cards pinned to Operations
  // A card with data-home="<tab>" can be shown on the Operations page instead of its own tab: the element itself
  // moves (its ids keep working, the renderer that fills it keeps filling it), and app.js renders the home tab's
  // data on Operations too (see pinnedHomes). Not for the map, the detail panes or the big tables.
  let pinned = (() => { try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); } catch (e) { return new Set(); } })();
  const savePinned = () => localStorage.setItem(PIN_KEY, JSON.stringify([...pinned]));
  function movePinned() {
    const ops = $('.panels[data-layout="overview"]'); if (!ops) return;
    $$(".card[data-home]").forEach(c => {
      const home = $(`.panels[data-layout="${c.dataset.home}"]`);
      const want = pinned.has(c.dataset.panel) ? ops : home;
      if (want && c.parentElement !== want) { want.appendChild(c); }
    });
    $$(".panels[data-layout]").forEach(cn => { delete cn._defaults; });  // card lists changed
  }
  function pin(id, on) {
    const c = $(`.card[data-panel="${id}"][data-home]`); if (!c) return;
    const from = c.parentElement, fromTab = tabOf(from);
    if (on) pinned.add(id); else pinned.delete(id);
    savePinned();
    // forget its place in the grid it leaves, so it flows in fresh where it lands
    if (store[fromTab] && store[fromTab].panels) delete store[fromTab].panels[id];
    movePinned();
    const to = c.parentElement, toTab = tabOf(to);
    if (store[toTab] && store[toTab].panels) delete store[toTab].panels[id];
    save();
    [from, to].forEach(cn => { cn.classList.remove("placed"); apply(cn); if (editing) decorate(cn); emit(cn); });
  }
  const pinnedHomes = () => [...new Set($$(".card[data-home]").filter(c => pinned.has(c.dataset.panel)).map(c => c.dataset.home))];
  function save() { localStorage.setItem(KEY, JSON.stringify(store)); }
  function tabOf(container) { return container.dataset.layout; }
  function emit(container) { listeners.forEach(fn => { try { fn(container); } catch (e) { console.error(e); } }); }
  const cardsOf = (container) => $$(":scope > .card[data-panel]", container);

  // ---------------------------------------------------------------- geometry helpers
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const sortYX = (items) => items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  /** Gravity: every card moves up as far as it can without overlapping a card placed before it (top to bottom). */
  function compact(items, pinned) {
    const placed = [];
    for (const it of sortYX(items)) {
      if (it !== pinned) { while (it.y > 0 && !placed.some(p => overlap({ ...it, y: it.y - 1 }, p))) it.y--; }
      placed.push(it);
    }
    return items;
  }
  /** Push every card that overlaps `moved` below it (recursively), then compact. */
  function resolve(items, moved) {
    let guard = 0;
    for (;;) {
      const hit = sortYX(items).find(it => it !== moved && overlap(it, moved) && !it._done);
      if (!hit || guard++ > 500) break;
      hit.y = moved.y + moved.h;
      hit._done = true;
      resolve(items, hit);
    }
    items.forEach(it => delete it._done);
    return compact(items, moved);
  }
  /** Flow cards left to right, top to bottom, into the grid (first layout, v1 migration, new panels). */
  function flow(items, start) {
    let x = 0, y = start ? start.y : 0, rowH = 0;
    const placed = [];
    for (const it of items) {
      // data-under="<panel>" in the HTML: stack this card below that one (same column), e.g. the three camera cards
      // next to the map; falls back to the normal left-to-right flow when the anchor is not in this batch
      const under = it.under && placed.find(p => p.id === it.under);
      if (under) { it.x = under.x; it.y = under.y + under.h; it.w = Math.min(it.w, COLS - it.x); placed.push(it); continue; }
      if (x + it.w > COLS) { x = 0; y += rowH; rowH = 0; }
      it.x = x; it.y = y; x += it.w; rowH = Math.max(rowH, it.h);
      placed.push(it);
    }
    // the stacked cards may stick out below the row they joined: the next flow row starts under everything
    return items;
  }

  // ---------------------------------------------------------------- state
  function defaults(container) {
    if (!container._defaults) {
      container._defaults = { order: cardsOf(container).map(c => c.dataset.panel), w: {} };
      cardsOf(container).forEach(c => { container._defaults.w[c.dataset.panel] = +c.dataset.w || COLS; });
    }
    return container._defaults;
  }
  /** Natural height of a card's content in rows (measured once, outside the grid). */
  function measure(container, c) {
    const def = defaults(container);
    const kind = c.classList.contains("mapcard") ? "map" : c.classList.contains("tablecard") ? "table" : c.classList.contains("sticky") ? "detail" : c.classList.contains("camviews") ? "list" : "card";
    if (kind === "map") return Math.max(40, Math.round((window.innerHeight - 230) / ROW));
    if (kind === "table" || kind === "detail") return Math.max(MIN_H, Math.round(Math.min(window.innerHeight - 230, 640) / ROW));
    // natural height = paddings + the children's own heights (independent of the grid track the card sits in);
    // a chart counts its requested height, an empty list a sensible minimum
    let px = 24;
    $$(":scope > *:not(.panel-tools):not(.rz):not(.rz-ghost)", c).forEach(el => {
      if (el.tagName === "CANVAS" || el.classList.contains("uchart")) px += Math.max(200, +el.dataset.h || +(($("canvas", el) || {}).dataset || {}).h || 220) + 8;
      else px += Math.max(el.scrollHeight, el.getBoundingClientRect().height) + 6;
    });
    if (kind === "list") px = Math.max(px, 320);
    if (px < 160 && !$(":scope > canvas, :scope > .uchart", c)) px = 300;  // nothing rendered yet (first load): a sensible default, ↕ re-measures later
    if (c.dataset.minh) px = Math.max(px, +c.dataset.minh);  // a card that knows its content needs room (e.g. the journal table)
    return Math.max(MIN_H, Math.round(Math.min(px, 720) / ROW));
  }
  function stateOf(container) {
    const tab = tabOf(container), def = defaults(container);
    let st = store[tab];
    if (!st && PRESET[tab]) {
      st = { v: 2, panels: {} };
      for (const [id, g] of Object.entries(PRESET[tab])) if (def.order.includes(id)) st.panels[id] = { x: g[0], y: g[1], w: g[2], h: g[3], hidden: false };
      store[tab] = st; save();
    }
    if (!st || st.v !== 2) {
      // migrate v1 (order + w + h in px) or start from the HTML defaults: flow in order
      const old = st || {};
      const order = (old.order || []).filter(id => def.order.includes(id)).concat(def.order.filter(id => !(old.order || []).includes(id)));
      const byId = Object.fromEntries(cardsOf(container).map(c => [c.dataset.panel, c]));
      const items = order.map(id => { const p = (old.panels || {})[id] || {}; const c = byId[id]; return { id, under: c.dataset.under, w: Math.max(MIN_W, Math.min(COLS, p.w || def.w[id])), h: p.h ? Math.max(MIN_H, Math.round(p.h / ROW)) : measure(container, c), hidden: !!p.hidden }; });
      flow(items.filter(it => !it.hidden));
      st = { v: 2, panels: {} };
      items.forEach(it => { st.panels[it.id] = { x: it.x || 0, y: it.y || 0, w: it.w, h: it.h, hidden: it.hidden }; });
      store[tab] = st; save();
    }
    // a card that left this grid (pinned elsewhere): forget its slot so it does not hold space
    Object.keys(st.panels).forEach(id => { if (!def.order.includes(id)) delete st.panels[id]; });
    // panels added by a newer version (or a card pinned here): append below everything
    const missing = def.order.filter(id => !st.panels[id]);
    if (missing.length) {
      const byId = Object.fromEntries(cardsOf(container).map(c => [c.dataset.panel, c]));
      const bottom = Math.max(0, ...Object.values(st.panels).filter(p => !p.hidden).map(p => p.y + p.h));
      // a new card that asks to sit under an existing one goes there when that card's column is free below it
      const items = missing.map(id => ({ id, under: byId[id].dataset.under, w: def.w[id], h: measure(container, byId[id]), hidden: false }));
      const rest = [];
      for (const it of items) {
        const a = it.under && st.panels[it.under];
        if (a && !a.hidden) {
          const y = Math.max(a.y + a.h, ...Object.values(st.panels).filter(p => !p.hidden && p.x < a.x + a.w && p.x + p.w > a.x).map(p => p.y + p.h));
          st.panels[it.id] = { x: a.x, y, w: Math.min(it.w, COLS - a.x), h: it.h, hidden: false };
        } else rest.push(it);
      }
      flow(rest, { y: Math.max(bottom, ...Object.values(st.panels).filter(p => !p.hidden).map(p => p.y + p.h)) });
      items.forEach(it => { if (!st.panels[it.id]) st.panels[it.id] = { x: it.x, y: it.y, w: it.w, h: it.h, hidden: false }; });
      save();
      return st;
    }
    return st;
  }
  function items(st, container) {
    const here = container ? new Set(cardsOf(container).map(c => c.dataset.panel)) : null;
    return Object.entries(st.panels).filter(([id, p]) => !p.hidden && (!here || here.has(id))).map(([id, p]) => ({ id, x: p.x, y: p.y, w: p.w, h: p.h }));
  }
  function commit(st, its) { its.forEach(it => { Object.assign(st.panels[it.id], { x: it.x, y: it.y, w: it.w, h: it.h }); }); save(); }

  // ---------------------------------------------------------------- apply to the DOM
  function place(c, p) {
    c.style.gridColumn = `${p.x + 1} / span ${p.w}`;
    c.style.gridRow = `${p.y + 1} / span ${p.h}`;
    c.style.height = "";
    c.dataset.cols = p.w;
    c.classList.add("sized");
  }
  function apply(container) {
    // measuring needs a visible container (hidden tab = zero heights): first placement waits for the tab to show
    if (!container.offsetParent && !(store[tabOf(container)] && store[tabOf(container)].v === 2)) return;
    const st = stateOf(container);
    container.classList.add("placed");
    compact(items(st, container)).forEach(it => Object.assign(st.panels[it.id], { y: it.y }));
    cardsOf(container).forEach(c => {
      const p = st.panels[c.dataset.panel];
      c.classList.toggle("hidden-panel", !!p.hidden);
      if (!p.hidden) place(c, p);
    });
    renderHiddenBar(container);
    if (editing) decorate(container);
  }
  function applyAll() { movePinned(); $$(".panels[data-layout]").forEach(apply); }

  // ---------------------------------------------------------------- hidden panels (chips to restore them)
  function renderHiddenBar(container) {
    let bar = container.previousElementSibling && container.previousElementSibling.classList.contains("hidden-bar") ? container.previousElementSibling : null;
    const st = stateOf(container);
    const hidden = cardsOf(container).filter(c => st.panels[c.dataset.panel] && st.panels[c.dataset.panel].hidden);
    if (!hidden.length) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement("div"); bar.className = "hidden-bar"; container.parentNode.insertBefore(bar, container); }
    bar.innerHTML = `<i class="ico sm" style="--ico:url(icons/hidden.png)"></i><span>${tr("layout_hidden")}</span>` + hidden.map(c => `<button class="chip restore" data-panel="${c.dataset.panel}">${titleOf(c)}</button>`).join("");
    $$("button.restore", bar).forEach(b => b.addEventListener("click", () => {
      const p = st.panels[b.dataset.panel]; p.hidden = false;
      // back at the bottom, full default width
      const bottom = Math.max(0, ...items(st).map(it => it.y + it.h));
      p.x = 0; p.y = bottom;
      save(); apply(container); emit(container);
    }));
  }
  function titleOf(card) {
    const h = $("h2", card); if (h) { const s = $("span[data-i18n], span", h); return (s ? s.textContent : h.textContent).trim() || card.dataset.panel; }
    const tbl = $("table[id]", card); if (tbl) return tr("panel." + tbl.id) !== "panel." + tbl.id ? tr("panel." + tbl.id) : tbl.id;
    return tr("panel." + card.dataset.panel) !== "panel." + card.dataset.panel ? tr("panel." + card.dataset.panel) : card.dataset.panel;
  }

  // ---------------------------------------------------------------- edit mode
  function decorate(container) {
    cardsOf(container).forEach(c => {
      if ($(":scope > .panel-tools", c)) {
        $(":scope > .panel-tools .ptitle", c).textContent = titleOf(c); $(":scope > .panel-tools .pw", c).textContent = `${c.dataset.cols}/${COLS}`;
        const pb = $(":scope > .panel-tools .pbtn.pin", c);
        if (pb) { const on = pinned.has(c.dataset.panel); pb.classList.toggle("active", on); pb.title = tr(on ? "layout_unpin" : "layout_pin"); $(".ico", pb).style.setProperty("--ico", `url(icons/star${on ? "" : "_outline"}.png)`); }
        return;
      }
      const tools = document.createElement("div"); tools.className = "panel-tools";
      tools.innerHTML = `<span class="grip" title="${tr("layout_drag")}"><i class="ico" style="--ico:url(icons/drag.png)"></i></span><span class="ptitle">${titleOf(c)}</span><span class="pw">${c.dataset.cols}/${COLS}</span>
        <button class="pbtn" data-act="narrow" title="−">−</button><button class="pbtn" data-act="widen" title="+">+</button>
        <button class="pbtn" data-act="autoh" title="${tr("layout_auto_height")}">↕</button>
        ${c.dataset.home ? `<button class="pbtn pin ${pinned.has(c.dataset.panel) ? "active" : ""}" data-act="pin" title="${tr(pinned.has(c.dataset.panel) ? "layout_unpin" : "layout_pin")}"><i class="ico sm" style="--ico:url(icons/star${pinned.has(c.dataset.panel) ? "" : "_outline"}.png)"></i></button>` : ""}
        <button class="pbtn" data-act="hide" title="${tr("layout_hide")}"><i class="ico sm" style="--ico:url(icons/hidden.png)"></i></button>`;
      c.insertBefore(tools, c.firstChild);
      ["e", "s", "se", "w", "n"].forEach(k => { const rz = document.createElement("div"); rz.className = "rz rz-" + k; c.appendChild(rz); });
      bindCard(c);
    });
  }
  function undecorate(container) {
    cardsOf(container).forEach(c => { $$(":scope > .panel-tools, :scope > .rz, :scope > .rz-ghost", c).forEach(x => x.remove()); c.classList.remove("dragging", "resizing"); });
    const ph = $(":scope > .placeholder", container); if (ph) ph.remove();
  }
  /** Pixel metrics of the grid at this moment. */
  function metrics(container) {
    const r = container.getBoundingClientRect();
    const colW = (r.width - GAP * (COLS - 1)) / COLS;
    return { left: r.left, top: r.top, colW, rowH: ROW, cellX: colW + GAP, cellY: ROW };
  }
  function setGeom(container, c, patch) {
    const st = stateOf(container), p = st.panels[c.dataset.panel];
    const next = Object.assign({}, p, patch);
    next.w = Math.max(MIN_W, Math.min(COLS, next.w)); next.x = Math.max(0, Math.min(COLS - next.w, next.x)); next.h = Math.max(MIN_H, next.h); next.y = Math.max(0, next.y);
    const its = items(st); const me = its.find(it => it.id === c.dataset.panel); Object.assign(me, next);
    commit(st, resolve(its, me)); apply(container); emit(container);
  }
  function bindCard(c) {
    const tools = $(":scope > .panel-tools", c);
    tools.addEventListener("click", e => {
      const b = e.target.closest(".pbtn"); if (!b) return;
      const container = c.parentElement;  // a pinned card may have moved to another grid since it was bound
      const st = stateOf(container), p = st.panels[c.dataset.panel];
      if (b.dataset.act === "narrow") setGeom(container, c, { w: p.w - 1 });
      else if (b.dataset.act === "widen") setGeom(container, c, { w: p.w + 1 });
      else if (b.dataset.act === "autoh") setGeom(container, c, { h: measure(container, c) });
      else if (b.dataset.act === "hide") { p.hidden = true; save(); apply(container); emit(container); }
      else if (b.dataset.act === "pin") pin(c.dataset.panel, !pinned.has(c.dataset.panel));
    });
    // free drag (mouse): the card follows the pointer, a placeholder shows where it will land (snapped to the grid),
    // the other cards make room live
    $(".grip", tools).addEventListener("mousedown", e => startDrag(e, c.parentElement, c));
    tools.addEventListener("mousedown", e => { if (e.target.closest(".pbtn")) return; if (!e.target.closest(".grip")) startDrag(e, c.parentElement, c); });
    ["e", "s", "se", "w", "n"].forEach(k => $(".rz-" + k, c).addEventListener("mousedown", e => startResize(e, c.parentElement, c, k)));
  }
  function startDrag(e, container, c) {
    e.preventDefault(); e.stopPropagation();
    const st = stateOf(container), id = c.dataset.panel, p0 = Object.assign({}, st.panels[id]);
    const m = metrics(container), rect = c.getBoundingClientRect();
    const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
    const ph = document.createElement("div"); ph.className = "placeholder"; container.appendChild(ph);
    c.classList.add("dragging"); document.body.classList.add("layout-dragging");
    Object.assign(c.style, { position: "fixed", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px", zIndex: 50, gridColumn: "", gridRow: "" });
    let last = null;
    const move = ev => {
      c.style.left = (ev.clientX - offX) + "px"; c.style.top = (ev.clientY - offY) + "px";
      const x = Math.round((ev.clientX - offX - m.left) / m.cellX), y = Math.round((ev.clientY - offY - m.top + container.parentElement.scrollTop * 0) / m.cellY);
      const nx = Math.max(0, Math.min(COLS - p0.w, x)), ny = Math.max(0, y);
      if (last && last.x === nx && last.y === ny) return;
      last = { x: nx, y: ny };
      const its = items(st); const me = its.find(it => it.id === id); me.x = nx; me.y = ny;
      resolve(its, me);
      its.forEach(it => { if (it.id !== id) { const el = $(`:scope > .card[data-panel="${it.id}"]`, container); place(el, it); } });
      ph.style.gridColumn = `${me.x + 1} / span ${me.w}`; ph.style.gridRow = `${me.y + 1} / span ${me.h}`;
      ph._geom = me;
      // keep the pointer's row in view
      if (ev.clientY > window.innerHeight - 40) window.scrollBy(0, 12); else if (ev.clientY < 60) window.scrollBy(0, -12);
    };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      Object.assign(c.style, { position: "", left: "", top: "", width: "", height: "", zIndex: "" });
      c.classList.remove("dragging"); document.body.classList.remove("layout-dragging");
      const its = items(st); const me = its.find(it => it.id === id);
      if (ph._geom) { me.x = ph._geom.x; me.y = ph._geom.y; }
      ph.remove();
      commit(st, resolve(its, me)); apply(container); emit(container);
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }
  function startResize(e, container, c, mode) {
    e.preventDefault(); e.stopPropagation();
    const st = stateOf(container), id = c.dataset.panel, p0 = Object.assign({}, st.panels[id]);
    const m = metrics(container), x0 = e.clientX, y0 = e.clientY;
    c.classList.add("resizing");
    const ghost = document.createElement("div"); ghost.className = "rz-ghost"; c.appendChild(ghost);
    let last = null;
    const move = ev => {
      const dx = Math.round((ev.clientX - x0) / m.cellX), dy = Math.round((ev.clientY - y0) / m.cellY);
      const g = { x: p0.x, y: p0.y, w: p0.w, h: p0.h };
      if (mode.includes("e")) g.w = p0.w + dx;
      if (mode.includes("s")) g.h = p0.h + dy;
      if (mode === "w") { g.x = p0.x + dx; g.w = p0.w - dx; }
      if (mode === "n") { g.y = p0.y + dy; g.h = p0.h - dy; }
      g.w = Math.max(MIN_W, Math.min(COLS - g.x, g.w)); g.h = Math.max(MIN_H, g.h); g.x = Math.max(0, Math.min(COLS - MIN_W, g.x)); g.y = Math.max(0, g.y);
      if (last && last.x === g.x && last.y === g.y && last.w === g.w && last.h === g.h) return;
      last = g;
      const its = items(st); const me = its.find(it => it.id === id); Object.assign(me, g);
      resolve(its, me);
      its.forEach(it => place($(`:scope > .card[data-panel="${it.id}"]`, container), it));
      $(".pw", c).textContent = `${g.w}/${COLS}`;
      ghost.textContent = `${g.w}/${COLS} · ${g.h * ROW} px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); c.classList.remove("resizing"); ghost.remove();
      if (last) { const its = items(st); const me = its.find(it => it.id === id); Object.assign(me, last); commit(st, resolve(its, me)); }
      apply(container); emit(container);
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }

  // A view that rewrites a card with innerHTML (detail cards on a refresh) wipes the tools and handles: put them back.
  const redecorate = new MutationObserver(muts => {
    if (!editing) return;
    const cards = new Set(muts.map(m => m.target).filter(el => el.classList && el.classList.contains("card") && el.dataset.panel && !$(":scope > .panel-tools", el)));
    cards.forEach(c => decorate(c.parentElement));
  });
  function enterEdit() {
    editing = true; document.body.classList.add("layout-edit");
    $$(".panels[data-layout]").forEach(cn => { apply(cn); decorate(cn); redecorate.observe(cn, { childList: true, subtree: true }); });
    const b = $("#layout-btn"); if (b) b.classList.add("open");
  }
  function exitEdit() {
    editing = false; document.body.classList.remove("layout-edit"); redecorate.disconnect();
    $$(".panels[data-layout]").forEach(undecorate); const b = $("#layout-btn"); if (b) b.classList.remove("open"); $$(".panels[data-layout]").forEach(emit);
  }
  function toggleEdit() { editing ? exitEdit() : enterEdit(); }
  function reset(tab) { delete store[tab]; save(); $$(`.panels[data-layout="${tab}"]`).forEach(cn => { apply(cn); emit(cn); }); }
  function resetAll() { store = {}; save(); $$(".panels[data-layout]").forEach(cn => { apply(cn); emit(cn); }); }

  document.addEventListener("DOMContentLoaded", applyAll);
  if (document.readyState !== "loading") applyAll();
  // a tab becoming visible: place its cards if that was deferred
  new MutationObserver(() => $$(".panels[data-layout]").forEach(cn => { if (!cn.classList.contains("placed") && cn.offsetParent) apply(cn); })).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class"] });
  window.Layout = { enterEdit, exitEdit, toggleEdit, isEditing: () => editing, reset, resetAll, apply, applyAll, onChange: (fn) => listeners.push(fn), titleOf, pin, pinnedHomes, isPinned: (id) => pinned.has(id) };
})();
