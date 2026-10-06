/* Panel layout: reorder (drag & drop), resize (width in grid columns, optional fixed height) and hide/show
   the cards of each tab. Each `.panels[data-layout]` container holds `.card[data-panel][data-w]` children.
   State is stored per tab in localStorage "tf3.layout" as { tab: { order: [...], panels: { id: { w, h, hidden } } } }.
   Exposes window.Layout = { enterEdit, exitEdit, toggleEdit, isEditing, reset, resetAll, apply, onChange }. */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const KEY = "tf3.layout";
  const COLS = 12, MIN_W = 2, MIN_H = 120;
  let store = load();
  let editing = false;
  const listeners = [];
  const tr = (k) => (window.__t ? window.__t(k) : k);

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { return {}; } }
  function save() { localStorage.setItem(KEY, JSON.stringify(store)); }
  function tabOf(container) { return container.dataset.layout; }
  function stateOf(container) { const tab = tabOf(container); store[tab] = store[tab] || { order: [], panels: {} }; store[tab].panels = store[tab].panels || {}; return store[tab]; }
  function emit(container) { listeners.forEach(fn => { try { fn(container); } catch (e) { console.error(e); } }); }

  // defaults are captured once from the HTML (data-w + document order)
  function defaults(container) {
    if (!container._defaults) {
      container._defaults = { order: $$(":scope > .card[data-panel]", container).map(c => c.dataset.panel), w: {} };
      $$(":scope > .card[data-panel]", container).forEach(c => { container._defaults.w[c.dataset.panel] = +c.dataset.w || COLS; });
    }
    return container._defaults;
  }

  function apply(container) {
    const st = stateOf(container), def = defaults(container);
    const cards = $$(":scope > .card[data-panel]", container);
    const byId = Object.fromEntries(cards.map(c => [c.dataset.panel, c]));
    // order: stored order first (ignoring unknown ids), then any new panel in default order
    const order = (st.order || []).filter(id => byId[id]).concat(def.order.filter(id => !(st.order || []).includes(id)));
    order.forEach(id => container.appendChild(byId[id]));
    cards.forEach(c => {
      const id = c.dataset.panel, p = st.panels[id] || {};
      const w = Math.max(MIN_W, Math.min(COLS, p.w || def.w[id]));
      c.style.gridColumn = `span ${w}`;
      c.dataset.cols = w;
      if (p.h) { c.style.height = p.h + "px"; c.classList.add("sized"); } else { c.style.height = ""; c.classList.remove("sized"); }
      c.classList.toggle("hidden-panel", !!p.hidden);
    });
    renderHiddenBar(container);
    if (editing) decorate(container);
  }
  function applyAll() { $$(".panels[data-layout]").forEach(apply); }

  // ---------------------------------------------------------------- hidden panels (chips to restore them)
  function renderHiddenBar(container) {
    let bar = container.previousElementSibling && container.previousElementSibling.classList.contains("hidden-bar") ? container.previousElementSibling : null;
    const st = stateOf(container);
    const hidden = $$(":scope > .card[data-panel]", container).filter(c => st.panels[c.dataset.panel] && st.panels[c.dataset.panel].hidden);
    if (!hidden.length) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement("div"); bar.className = "hidden-bar"; container.parentNode.insertBefore(bar, container); }
    bar.innerHTML = `<i class="ico sm" style="--ico:url(icons/hidden.png)"></i><span>${tr("layout_hidden")}</span>` + hidden.map(c => `<button class="chip restore" data-panel="${c.dataset.panel}">${titleOf(c)}</button>`).join("");
    $$("button.restore", bar).forEach(b => b.addEventListener("click", () => { st.panels[b.dataset.panel] = Object.assign({}, st.panels[b.dataset.panel], { hidden: false }); save(); apply(container); emit(container); }));
  }
  function titleOf(card) {
    const h = $("h2", card); if (h) { const s = $("span[data-i18n], span", h); return (s ? s.textContent : h.textContent).trim() || card.dataset.panel; }
    const tbl = $("table[id]", card); if (tbl) return tr("panel." + tbl.id) !== "panel." + tbl.id ? tr("panel." + tbl.id) : tbl.id;
    return tr("panel." + card.dataset.panel) !== "panel." + card.dataset.panel ? tr("panel." + card.dataset.panel) : card.dataset.panel;
  }

  // ---------------------------------------------------------------- edit mode
  function decorate(container) {
    $$(":scope > .card[data-panel]", container).forEach(c => {
      if ($(":scope > .panel-tools", c)) { $(":scope > .panel-tools .ptitle", c).textContent = titleOf(c); return; }
      const tools = document.createElement("div"); tools.className = "panel-tools";
      tools.innerHTML = `<span class="grip" title="${tr("layout_drag")}"><i class="ico" style="--ico:url(icons/drag.png)"></i></span><span class="ptitle">${titleOf(c)}</span><span class="pw">${c.dataset.cols}/${COLS}</span>
        <button class="pbtn" data-act="narrow" title="−">−</button><button class="pbtn" data-act="widen" title="+">+</button>
        <button class="pbtn" data-act="autoh" title="${tr("layout_auto_height")}">↕</button>
        <button class="pbtn" data-act="hide" title="${tr("layout_hide")}"><i class="ico sm" style="--ico:url(icons/hidden.png)"></i></button>`;
      c.insertBefore(tools, c.firstChild);
      const rz = document.createElement("div"); rz.className = "rz rz-e"; c.appendChild(rz);
      const rs = document.createElement("div"); rs.className = "rz rz-s"; c.appendChild(rs);
      const rse = document.createElement("div"); rse.className = "rz rz-se"; c.appendChild(rse);
      c.draggable = true;
      bindCard(container, c);
    });
  }
  function undecorate(container) {
    $$(":scope > .card[data-panel]", container).forEach(c => { $$(":scope > .panel-tools, :scope > .rz", c).forEach(x => x.remove()); c.draggable = false; c.classList.remove("drag-over", "dragging"); });
  }
  function setW(container, c, w) {
    const st = stateOf(container); w = Math.max(MIN_W, Math.min(COLS, Math.round(w)));
    st.panels[c.dataset.panel] = Object.assign({}, st.panels[c.dataset.panel], { w }); save(); apply(container); emit(container);
  }
  function setH(container, c, h) {
    const st = stateOf(container); h = h == null ? null : Math.max(MIN_H, Math.round(h));
    st.panels[c.dataset.panel] = Object.assign({}, st.panels[c.dataset.panel], { h }); save(); apply(container); emit(container);
  }
  function bindCard(container, c) {
    const tools = $(":scope > .panel-tools", c);
    tools.addEventListener("click", e => {
      const b = e.target.closest(".pbtn"); if (!b) return;
      const st = stateOf(container);
      if (b.dataset.act === "narrow") setW(container, c, +c.dataset.cols - 1);
      else if (b.dataset.act === "widen") setW(container, c, +c.dataset.cols + 1);
      else if (b.dataset.act === "autoh") setH(container, c, null);
      else if (b.dataset.act === "hide") { st.panels[c.dataset.panel] = Object.assign({}, st.panels[c.dataset.panel], { hidden: true }); save(); apply(container); emit(container); }
    });
    // drag & drop reorder (HTML5 DnD, only when grabbing the grip or the tools bar)
    c.addEventListener("dragstart", e => {
      if (!e.target.closest || !(e.target === c || e.target.closest(".panel-tools"))) { e.preventDefault(); return; }
      container._drag = c; c.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", c.dataset.panel); } catch (x) {}
    });
    c.addEventListener("dragend", () => { c.classList.remove("dragging"); $$(".drag-over", container).forEach(x => x.classList.remove("drag-over")); container._drag = null; });
    c.addEventListener("dragover", e => { if (!container._drag || container._drag === c) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; c.classList.add("drag-over"); });
    c.addEventListener("dragleave", () => c.classList.remove("drag-over"));
    c.addEventListener("drop", e => {
      e.preventDefault(); const d = container._drag; if (!d || d === c) return;
      const cards = $$(":scope > .card[data-panel]", container);
      const from = cards.indexOf(d), to = cards.indexOf(c);
      container.insertBefore(d, from < to ? c.nextSibling : c);
      const st = stateOf(container); st.order = $$(":scope > .card[data-panel]", container).map(x => x.dataset.panel); save(); apply(container); emit(container);
    });
    // mouse resize handles
    const startResize = (e, mode) => {
      e.preventDefault(); e.stopPropagation();
      const rect = c.getBoundingClientRect(), crect = container.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(container).columnGap) || 14;
      const colW = (crect.width - gap * (COLS - 1)) / COLS;
      const x0 = e.clientX, y0 = e.clientY, w0 = +c.dataset.cols, h0 = rect.height;
      c.classList.add("resizing");
      const ghost = document.createElement("div"); ghost.className = "rz-ghost"; c.appendChild(ghost);
      const move = ev => {
        if (mode !== "s") { const w = Math.max(MIN_W, Math.min(COLS, Math.round((w0 * (colW + gap) + ev.clientX - x0) / (colW + gap)))); if (w !== +c.dataset.cols) { c.style.gridColumn = `span ${w}`; c.dataset.cols = w; $(".pw", c).textContent = `${w}/${COLS}`; } }
        if (mode !== "e") { const h = Math.max(MIN_H, h0 + ev.clientY - y0); c.style.height = h + "px"; c.classList.add("sized"); }
        ghost.textContent = `${c.dataset.cols}/${COLS} · ${Math.round(c.getBoundingClientRect().height)} px`;
      };
      const up = () => {
        window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); c.classList.remove("resizing"); ghost.remove();
        const st = stateOf(container); const p = Object.assign({}, st.panels[c.dataset.panel]);
        if (mode !== "s") p.w = +c.dataset.cols;
        if (mode !== "e") p.h = Math.round(c.getBoundingClientRect().height);
        st.panels[c.dataset.panel] = p; save(); apply(container); emit(container);
      };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    };
    $(".rz-e", c).addEventListener("mousedown", e => startResize(e, "e"));
    $(".rz-s", c).addEventListener("mousedown", e => startResize(e, "s"));
    $(".rz-se", c).addEventListener("mousedown", e => startResize(e, "se"));
  }

  function enterEdit() { editing = true; document.body.classList.add("layout-edit"); $$(".panels[data-layout]").forEach(cn => { apply(cn); decorate(cn); }); const b = $("#layout-btn"); if (b) b.classList.add("open"); }
  function exitEdit() { editing = false; document.body.classList.remove("layout-edit"); $$(".panels[data-layout]").forEach(undecorate); const b = $("#layout-btn"); if (b) b.classList.remove("open"); $$(".panels[data-layout]").forEach(emit); }
  function toggleEdit() { editing ? exitEdit() : enterEdit(); }
  function reset(tab) { delete store[tab]; save(); $$(`.panels[data-layout="${tab}"]`).forEach(cn => { apply(cn); emit(cn); }); }
  function resetAll() { store = {}; save(); $$(".panels[data-layout]").forEach(cn => { apply(cn); emit(cn); }); }

  document.addEventListener("DOMContentLoaded", applyAll);
  if (document.readyState !== "loading") applyAll();
  window.Layout = { enterEdit, exitEdit, toggleEdit, isEditing: () => editing, reset, resetAll, apply, applyAll, onChange: (fn) => listeners.push(fn), titleOf };
})();
