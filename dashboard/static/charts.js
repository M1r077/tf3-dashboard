/* Charts for the dashboard:
   - lineChart: uPlot (vendor/uPlot.iife.min.js) — zoom by drag, double-click to reset, legend toggles, cursor sync,
     right axis, stacked areas, last-value badges, hatched band over per-minute aggregated history
   - donut, hbars: small dependency-free canvas drawings
   Sizes follow the card (see targetHeight: user-resized cards fill their box). */
(function () {
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const PALETTE = ["#4f8a8a", "#d62560", "#e8b04b", "#58a6ff", "#3fb950", "#bc8cff", "#f0883e", "#8b98a8"];
  const FONT = () => css("--font") || "sans-serif";

  /** Height: if the canvas sits in a user-sized card (.card.sized), fill the space left under the title;
      otherwise use data-h (default 200). */
  function targetHeight(canvas) {
    const card = canvas.closest && canvas.closest(".card.sized");
    if (card) {
      const cs = getComputedStyle(card);
      let avail = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const canvases = Array.from(card.children).filter(ch => ch.tagName === "CANVAS");
      Array.from(card.children).forEach(ch => { if (ch.tagName !== "CANVAS" && getComputedStyle(ch).position !== "absolute") avail -= ch.getBoundingClientRect().height + (parseFloat(getComputedStyle(ch).marginTop) || 0) + (parseFloat(getComputedStyle(ch).marginBottom) || 0); });
      // several canvases in one card (detail panels): share the space proportionally to their data-h
      const want = (c) => parseInt(c.dataset.h, 10) || 200;
      if (canvases.length > 1) avail = avail * want(canvas) / canvases.reduce((a, c) => a + want(c), 0);
      if (avail >= 80) return Math.floor(avail);
    }
    return parseInt(canvas.dataset.h || canvas.getAttribute("height") || 200, 10);
  }

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = "100%";
    const w = canvas.parentElement ? (canvas.parentElement.clientWidth - 28) : (canvas.clientWidth || 300);
    const h = targetHeight(canvas);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "12px " + FONT();
    return { ctx, w, h };
  }

  function fmtShort(n, unit) {
    if (n == null || isNaN(n)) return "";
    const a = Math.abs(n); let s;
    if (a >= 1e9) s = (n / 1e9).toFixed(1) + " G";
    else if (a >= 1e6) s = (n / 1e6).toFixed(1) + " M";
    else if (a >= 1e4) s = Math.round(n / 1e3) + " k";
    else if (a >= 100) s = Math.round(n).toString();
    else s = (Math.round(n * 10) / 10).toString();
    return unit ? s + (unit === "%" ? " %" : " " + unit) : s;
  }

  function niceTicks(min, max, count) {
    if (!(isFinite(min) && isFinite(max))) return [];
    if (min === max) { min -= 1; max += 1; }
    const raw = (max - min) / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const t = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) t.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    return t;
  }

  function empty(ctx, w, h, msg) { ctx.fillStyle = css("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(msg || "pas encore de donnÃ©es", w / 2, h / 2); }

  /** Sparse, non-overlapping x labels: show a label only when it differs from the previous one shown. */
  function xLabelIndices(labels, n, pxAvail) {
    const maxLabels = Math.max(2, Math.floor(pxAvail / 90));
    const idx = [];
    let last = null;
    for (let i = 0; i < n; i++) { const l = labels && labels[i]; if (l != null && l !== last) { idx.push(i); last = l; } }
    if (idx.length <= maxLabels) return idx;
    const step = Math.ceil(idx.length / maxLabels);
    return idx.filter((_, k) => k % step === 0);
  }

  // ================================================================ line charts (uPlot)
  // Same call shape as before: lineChart(canvas, series, labels, opts). The <canvas> is used as an anchor:
  // a <div class="uchart"> is created right after it (once) and uPlot renders there; the canvas stays hidden.
  //   series: [{ name, values, color, area, axis:'left'|'right', unit, dash, width, step }]
  //   opts:   { ts: [unix s], aggFrom: index|null, zeroBase, rightAxis, unit, rightUnit, percent, stacked, yMin, yMax,
  //             badges, syncKey, onSelect(fromTs, toTs) }
  // Features: drag-to-zoom (double-click to reset), legend click to hide a series, synchronized cursor
  // across charts with the same syncKey, hatched band over the aggregated (per-minute) part of the series.
  const I18N_T = (k, d) => (window.__t ? window.__t(k) : null) || d;
  const uplots = new WeakMap();
  const hidden = {}; // chartKey -> Set(series index) hidden by the user (survives re-renders)

  function hostFor(canvas) {
    let host = canvas.nextElementSibling;
    if (!host || !host.classList.contains("uchart")) {
      host = document.createElement("div"); host.className = "uchart";
      canvas.parentNode.insertBefore(host, canvas.nextSibling);
    }
    canvas.style.display = "none";
    return host;
  }
  function hostSize(canvas, host) {
    const card = canvas.closest(".card");
    const w = (host.parentElement ? host.parentElement.clientWidth : 300) - (card && card.classList.contains("tablecard") ? 0 : 28);
    canvas.style.display = "";
    const h = targetHeight(canvas);
    canvas.style.display = "none";
    return { w: Math.max(120, w), h: Math.max(80, h) };
  }
  const chartKey = (canvas) => canvas.id || canvas.dataset.key || "c" + Math.random().toString(36).slice(2);

  const LOCALE = () => (window.__locale ? window.__locale() : undefined);
  function fmtTime(ts, span) {
    const d = new Date(ts * 1000);
    const hm = d.toLocaleTimeString(LOCALE(), { hour: "2-digit", minute: "2-digit", hour12: false });
    if (span > 36 * 3600) return d.toLocaleDateString(LOCALE(), { day: "2-digit", month: "short" }) + " " + hm;
    return hm;
  }
  function dateTick(labels, idx) { return labels && labels[idx] != null ? String(labels[idx]) : ""; }

  // tooltip plugin
  function tooltipPlugin(getLabel, series, opts) {
    let el;
    return {
      hooks: {
        init: (u) => {
          el = document.createElement("div"); el.className = "chart-tip"; document.body.appendChild(el);
          u.over.addEventListener("mouseleave", () => { el.style.display = "none"; });
        },
        setCursor: (u) => {
          const i = u.cursor.idx;
          if (i == null || u.cursor.left < 0) { el.style.display = "none"; return; }
          const lines = series.map((s, si) => {
            if (!u.series[si + 1].show) return null;
            const v = s.values[i]; if (v == null) return null;
            return `<span style="color:${s.color}">â—</span> ${s.name}: <b>${fmtShort(v, s.unit || (s.axis === "right" ? opts.rightUnit : opts.unit))}</b>`;
          }).filter(Boolean);
          if (!lines.length) { el.style.display = "none"; return; }
          const isAgg = opts.aggFrom != null && i < opts.aggFrom;
          el.innerHTML = `<div class="t">${getLabel(i)}${isAgg ? ` <span class="aggtag">${I18N_T("chart_agg", "1-min avg")}</span>` : ""}</div>${lines.join("<br>")}`;
          el.style.display = "block";
          const r = u.over.getBoundingClientRect();
          const x = r.left + u.cursor.left, y = r.top + u.cursor.top;
          el.style.left = Math.min(window.innerWidth - 240, x + 14) + "px"; el.style.top = Math.max(4, y - 10) + "px";
        },
        destroy: () => { if (el) el.remove(); },
      },
    };
  }
  // hatched band over the aggregated part + last-value badges
  function decorPlugin(series, opts) {
    return {
      hooks: {
        drawClear: (u) => {
          if (opts.aggFrom == null || opts.aggFrom <= 0) return;
          const ctx = u.ctx; const x0 = u.valToPos(u.data[0][0], "x", true), x1 = u.valToPos(u.data[0][Math.min(opts.aggFrom, u.data[0].length - 1)], "x", true);
          ctx.save(); ctx.beginPath(); ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height); ctx.clip();
          ctx.fillStyle = "rgba(139,152,168,.07)"; ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
          ctx.strokeStyle = "rgba(139,152,168,.35)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x1, u.bbox.top); ctx.lineTo(x1, u.bbox.top + u.bbox.height); ctx.stroke();
          ctx.restore();
        },
        draw: (u) => {
          if (opts.badges === false) return;
          const ctx = u.ctx, dpr = devicePixelRatio || 1; const placed = [];
          ctx.save(); ctx.font = `600 ${11 * dpr}px ${FONT()}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
          series.forEach((s, si) => {
            const us = u.series[si + 1]; if (!us.show) return;
            const d = u.data[si + 1]; let li = d.length - 1; while (li >= 0 && d[li] == null) li--; if (li < 0) return;
            const scale = s.axis === "right" ? "r" : "y";
            const raw = opts.stacked ? s.values[li] : d[li];
            const y = u.valToPos(d[li], scale, true), x = u.valToPos(u.data[0][li], "x", true);
            const txt = fmtShort(raw, s.unit || (s.axis === "right" ? opts.rightUnit : opts.unit));
            const tw = ctx.measureText(txt).width + 8 * dpr, th = 16 * dpr;
            let by = Math.max(u.bbox.top, Math.min(u.bbox.top + u.bbox.height - th, y - th / 2));
            for (let g = 0; g < 12; g++) { const hit = placed.find(p => Math.abs(p - by) < th + 1); if (!hit) break; by = hit + th + 1 <= u.bbox.top + u.bbox.height - th ? hit + th + 1 : hit - th - 1; }
            placed.push(by);
            const right = u.bbox.left + u.bbox.width;
            const bx = (s.axis === "right") ? Math.min(u.width * dpr - tw - 2, right + 4 * dpr) : Math.max(u.bbox.left, right - tw - 4 * dpr);
            ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x, y, 3.5 * dpr, 0, 7); ctx.fill();
            ctx.fillStyle = "rgba(15,20,25,.88)"; ctx.fillRect(bx, by, tw, th); ctx.fillStyle = s.color; ctx.fillText(txt, bx + 4 * dpr, by + th / 2);
          });
          ctx.restore();
        },
      },
    };
  }

  function lineChart(canvas, series, labels, opts = {}) {
    const host = hostFor(canvas);
    const key = chartKey(canvas);
    series = series.map((s, i) => Object.assign({ color: PALETTE[i % PALETTE.length] }, s));
    const n = Math.max(0, ...series.map(s => (s.values || []).length));
    const hasData = series.some(s => (s.values || []).some(v => v != null && isFinite(v)));
    const old = uplots.get(host);
    if (!n || !hasData || n < 2) {
      if (old) { old.destroy(); uplots.delete(host); }
      host.innerHTML = `<div class="empty">${n === 1 ? I18N_T("chart_one_point", "1 point â€” the curve appears with the next sample") : I18N_T("no_data_yet", "no data yet")}</div>`;
      return;
    }
    const xs = opts.ts && opts.ts.length === n ? opts.ts.slice() : Array.from({ length: n }, (_, i) => i);
    const timeAxis = !!(opts.ts && opts.ts.length === n);
    // stacked => cumulative data; keep raw values for badges/tooltip
    let data = series.map(s => s.values.map(v => (v == null || !isFinite(v)) ? null : v));
    if (opts.stacked) { const acc = new Array(n).fill(0); data = data.map(vals => vals.map((v, i) => { acc[i] += v || 0; return acc[i]; })); }
    const { w, h } = hostSize(canvas, host);
    const hid = hidden[key] || (hidden[key] = new Set());
    const span = timeAxis ? xs[n - 1] - xs[0] : 0;
    const getLabel = (i) => timeAxis ? `${fmtTime(xs[i], span)}${labels && labels[i] ? " Â· " + labels[i] : ""}` : dateTick(labels, i) || "#" + i;

    const yRange = (u, min, max, scaleKey) => {
      const forcedMin = scaleKey === "y" ? opts.yMin : null, forcedMax = scaleKey === "y" ? opts.yMax : null;
      if (opts.percent && scaleKey === "y") { min = 0; max = Math.max(max, 100); }
      if (opts.zeroBase || opts.stacked) min = Math.min(0, min);
      if (forcedMin != null) min = forcedMin; if (forcedMax != null) max = forcedMax;
      if (!isFinite(min) || !isFinite(max)) return [0, 1];
      if (min === max) { min -= 1; max += 1; }
      const m = (max - min) * 0.08;
      return [min - ((opts.zeroBase || opts.percent) && min === 0 ? 0 : m), max + m];
    };
    const hasRight = opts.rightAxis && series.some(s => s.axis === "right");
    const uopts = {
      width: w, height: h,
      padding: [8, hasRight ? 4 : 56, 0, 0],
      cursor: { drag: { x: true, y: false, setScale: true }, sync: opts.syncKey ? { key: opts.syncKey, setSeries: false } : undefined, points: { size: 7 } },
      select: { show: true },
      legend: { show: true, live: false, markers: { width: 2 } },
      scales: {
        x: { time: timeAxis },
        y: { range: (u, mn, mx) => yRange(u, mn, mx, "y") },
        r: { range: (u, mn, mx) => yRange(u, mn, mx, "r") },
      },
      axes: [
        { stroke: css("--muted"), grid: { stroke: css("--border"), width: 1 }, ticks: { stroke: css("--border"), width: 1 }, font: `11px ${FONT()}`, gap: 6, size: 28,
          values: timeAxis ? (u, vals) => vals.map(v => fmtTime(v, span)) : (u, vals) => vals.map(v => Number.isInteger(v) ? dateTick(labels, v) : ""),
          space: 90, incrs: timeAxis ? undefined : [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] },
        { scale: "y", stroke: css("--muted"), grid: { stroke: css("--border"), width: 1 }, ticks: { show: false }, font: `11px ${FONT()}`, size: 56, gap: 4,
          values: (u, vals) => vals.map(v => fmtShort(v, opts.unit)) },
        ...(hasRight ? [{ scale: "r", side: 1, stroke: css("--muted"), grid: { show: false }, ticks: { show: false }, font: `11px ${FONT()}`, size: 60, gap: 4,
          values: (u, vals) => vals.map(v => fmtShort(v, opts.rightUnit)) }] : []),
      ],
      series: [
        { label: "", value: (u, v, si, i) => i == null ? "" : getLabel(i) },
        ...series.map((s, si) => ({
          label: s.name, stroke: s.color, width: (s.width || 2) * 1, dash: s.dash, scale: s.axis === "right" ? "r" : "y",
          show: !hid.has(si),
          paths: s.step ? uPlot.paths.stepped({ align: 1 }) : uPlot.paths.linear(),
          fill: (s.area || opts.stacked) ? (opts.stacked ? s.color + "55" : s.color + "26") : undefined,
          points: { show: false },
          value: (u, v) => v == null ? "â€“" : fmtShort(opts.stacked ? s.values[u.cursor.idx] : v, s.unit || (s.axis === "right" ? opts.rightUnit : opts.unit)),
        })),
      ],
      bands: opts.stacked ? series.map((_, si) => si > 0 ? { series: [si + 1, si] } : null).filter(Boolean) : undefined,
      plugins: [tooltipPlugin(getLabel, series, opts), decorPlugin(series, opts)],
      hooks: {
        setSelect: [(u) => { if (opts.onSelect && u.select.width > 0) { const a = u.posToVal(u.select.left, "x"), b = u.posToVal(u.select.left + u.select.width, "x"); opts.onSelect(a, b); } }],
        setSeries: [(u, si, o) => { if (si == null || !("show" in o)) return; if (o.show) hid.delete(si - 1); else hid.add(si - 1); }],
      },
    };
    // stacked: each series keeps its own fill; bands [upper, lower] clip the fill of `upper` down to `lower`,
    // so the first series fills to zero and the others only paint their own slice

    // zoom state: if the user zoomed (x scale differs from full), keep it across re-renders (data refreshes)
    let keepX = null;
    if (old) {
      const xs0 = old.scales.x, full = [old.data[0][0], old.data[0][old.data[0].length - 1]];
      if (xs0 && xs0.min != null && (xs0.min > full[0] + 1e-9 || xs0.max < full[1] - 1e-9)) keepX = [xs0.min, xs0.max];
      old.destroy(); host.innerHTML = "";
    }
    const u = new uPlot(uopts, [xs, ...data], host);
    uplots.set(host, u);
    if (keepX && timeAxis) {
      // follow the live edge: if the previous zoom touched the end, shift the window with the new data
      const lastOld = old ? old.data[0][old.data[0].length - 1] : null;
      const atEnd = lastOld != null && Math.abs(keepX[1] - lastOld) < 1e-6;
      const width = keepX[1] - keepX[0];
      const max = atEnd ? xs[n - 1] : Math.min(keepX[1], xs[n - 1]);
      u.setScale("x", { min: Math.max(xs[0], max - width), max });
    }
    host.ondblclick = () => u.setScale("x", { min: xs[0], max: xs[n - 1] });
    canvas._chart = { u, series, labels, opts };
    return u;
  }

  /** Re-fit every uPlot in `root` to its container (after a panel resize) without re-fetching data. */
  function resizeAll(root = document) {
    Array.from(root.querySelectorAll(".uchart")).forEach(host => {
      const u = uplots.get(host); const canvas = host.previousElementSibling; if (!u || !canvas) return;
      const { w, h } = hostSize(canvas, host); u.setSize({ width: w, height: h });
    });
  }

  /** items: [{label, value, color}] */
  function donut(canvas, items, opts = {}) {
    const { ctx, w, h } = setup(canvas);
    const total = items.reduce((a, b) => a + (b.value || 0), 0);
    if (!total) { empty(ctx, w, h); return; }
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6, r = R * 0.64;
    let a = -Math.PI / 2;
    items.forEach((it, i) => { const da = (it.value / total) * Math.PI * 2; ctx.beginPath(); ctx.arc(cx, cy, R, a, a + da); ctx.arc(cx, cy, r, a + da, a, true); ctx.closePath(); ctx.fillStyle = it.color || PALETTE[i % PALETTE.length]; ctx.fill(); a += da; });
    ctx.fillStyle = css("--text"); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "600 22px " + FONT();
    ctx.fillText(opts.center != null ? opts.center : total, cx, cy - 7);
    ctx.font = "11px " + FONT(); ctx.fillStyle = css("--muted"); ctx.fillText(opts.sub || "", cx, cy + 13);
  }

  /** horizontal bars: items [{label, value, max, color, text}] ; each bar shows value/max */
  function hbars(canvas, items, opts = {}) {
    let rowH = opts.rowH || 26;
    const sized = canvas.closest && canvas.closest(".card.sized");
    if (!sized) canvas.dataset.h = Math.max(40, items.length * rowH + 8);
    const { ctx, w, h } = setup(canvas);
    if (!items.length) { empty(ctx, w, h); return; }
    if (sized) rowH = Math.max(18, Math.min(40, Math.floor((h - 8) / items.length)));
    const labelW = opts.labelW || Math.min(220, Math.max(...items.map(i => ctx.measureText(i.label).width)) + 12);
    const valueW = 90, x0 = labelW, bw = w - labelW - valueW - 8;
    items.forEach((it, i) => {
      const y = 4 + i * rowH, bh = rowH - 10;
      ctx.fillStyle = css("--text"); ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(it.label, 0, y + bh / 2 + 1, labelW - 8);
      ctx.fillStyle = css("--border"); ctx.fillRect(x0, y, bw, bh);
      const max = it.max || Math.max(...items.map(x => x.value || 0)) || 1;
      const p = Math.max(0, Math.min(1, (it.value || 0) / max));
      ctx.fillStyle = it.color || PALETTE[i % PALETTE.length]; ctx.fillRect(x0, y, bw * p, bh);
      ctx.fillStyle = css("--text"); ctx.textAlign = "right"; ctx.fillText(it.text != null ? it.text : fmtShort(it.value, opts.unit), w, y + bh / 2 + 1);
    });
  }

  window.Charts = { lineChart, resizeAll, donut, hbars, PALETTE, fmtShort };
})();
