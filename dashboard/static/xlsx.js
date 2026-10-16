// A minimal .xlsx writer: sheets of rows of strings/numbers, bold header row, thousands separators on numbers, frozen
// header row and first column, column widths from the content. Office Open XML is a zip of a few XML files; the zip
// is written "stored" (no compression: a whole game's finances is a few hundred KB, and the zip format then needs
// only a CRC-32), so this runs in any browser with no library.
//   XLSX.build([{ name, rows: [[...], ...], numberFrom: 1, kinds: ["group", ...], banded: true }]) -> Blob;  XLSX.download(blob, "file.xlsx")
// numberFrom: columns from this index are numbers (cells get the thousands format even when empty).
// kinds[i]: "group" (bold, raised), "total" (bold, blue-grey) or "detail" for row i; banded: alternate row fills;
// filter: false to leave out the header's filter/sort arrows (default on).
// charts: native Excel charts drawn on the sheet (see chartXml).
// Dark sheets like the page: numbers blue positive, salmon negative, grey zero (the game's colours).
const XLSX = (() => {
  const CRC = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
  const crc32 = (u8) => { let c = -1; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const enc = new TextEncoder();
  const xml = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  const col = (i) => { let s = ""; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };

  // zip, stored: local headers + data, then the central directory, then the end record
  function zip(files) {
    const parts = [], central = [];
    let off = 0;
    const le16 = (v) => [v & 255, (v >> 8) & 255], le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const [name, text] of files) {
      const nm = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const head = new Uint8Array([0x50, 0x4B, 3, 4, ...le16(20), ...le16(0x800), ...le16(0), ...le16(dosTime), ...le16(dosDate), ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(nm.length), ...le16(0)]);
      parts.push(head, nm, data);
      central.push(new Uint8Array([0x50, 0x4B, 1, 2, ...le16(20), ...le16(20), ...le16(0x800), ...le16(0), ...le16(dosTime), ...le16(dosDate), ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(nm.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(off)]), nm);
      off += head.length + nm.length + data.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new Uint8Array([0x50, 0x4B, 5, 6, ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length), ...le32(cdSize), ...le32(off), ...le16(0)]);
    return new Blob([...parts, ...central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  // Native Excel charts (a drawing per sheet, a chart part per chart), dark like the sheets. A chart reads its data
  // from cells, so it follows any edit; the cached values let viewers that do not recalculate draw it too.
  //   sheet.charts = [{ type: "line" | "bar", title, src: sheet index (default: this sheet), cat: column index,
  //     series: [{ col, color, pointColors? }], r0, r1: first/last data row (1-based), at: { col, row } (0-based),
  //     w, h: size in px, barDir: "bar" (horizontal) | "col", reverse: categories top-down, money: axis in millions }]
  // Series names come from the header row (row 1, or nameRow) of their column. stacked: stacked bars.
  const txPr = (sz, b, c = "D6DAE0") => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}"${b ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${c}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
  function chartXml(ch, self, sheets, rawNames) {
    const si = ch.src == null ? self : ch.src, rows = sheets[si].rows || [], sn = `'${rawNames[si].replace(/'/g, "''")}'`;
    const ref = (c, a, b) => `${sn}!$${col(c)}$${a}${b != null && b !== a ? `:$${col(c)}$${b}` : ""}`;
    const n = ch.r1 - ch.r0 + 1, cell = (r, c) => (rows[r - 1] || [])[c];
    const strCache = (c, a, b) => `<c:strCache><c:ptCount val="${b - a + 1}"/>${Array.from({ length: b - a + 1 }, (_, k) => { const v = cell(a + k, c); return v == null || v === "" ? "" : `<c:pt idx="${k}"><c:v>${xml(v)}</c:v></c:pt>`; }).join("")}</c:strCache>`;
    const numCache = (c) => `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${Array.from({ length: n }, (_, k) => { const v = cell(ch.r0 + k, c); return typeof v === "number" && isFinite(v) ? `<c:pt idx="${k}"><c:v>${v}</c:v></c:pt>` : ""; }).join("")}</c:numCache>`;
    const bar = ch.type === "bar";
    const sers = ch.series.map((s, i) => {
      const nr = ch.nameRow || 1, tx = `<c:tx><c:strRef><c:f>${xml(ref(s.col, nr))}</c:f>${strCache(s.col, nr, nr)}</c:strRef></c:tx>`;
      const cat = `<c:cat><c:strRef><c:f>${xml(ref(ch.cat, ch.r0, ch.r1))}</c:f>${strCache(ch.cat, ch.r0, ch.r1)}</c:strRef></c:cat>`;
      const val = `<c:val><c:numRef><c:f>${xml(ref(s.col, ch.r0, ch.r1))}</c:f>${numCache(s.col)}</c:numRef></c:val>`;
      const head = `<c:idx val="${i}"/><c:order val="${i}"/>${tx}`;
      if (bar) {
        const pts = (s.pointColors || []).map((c, k) => c ? `<c:dPt><c:idx val="${k}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill></c:spPr></c:dPt>` : "").join("");
        return `<c:ser>${head}<c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>${pts}${cat}${val}</c:ser>`;
      }
      return `<c:ser>${head}<c:spPr><a:ln w="${s.width || 22225}" cap="rnd"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>${cat}${val}<c:smooth val="0"/></c:ser>`;
    }).join("");
    const plot = bar
      ? `<c:barChart><c:barDir val="${ch.barDir || "col"}"/><c:grouping val="${ch.stacked ? "stacked" : "clustered"}"/><c:varyColors val="0"/>${sers}<c:gapWidth val="${ch.stacked ? 30 : 40}"/>${ch.stacked ? '<c:overlap val="100"/>' : ""}<c:axId val="1"/><c:axId val="2"/></c:barChart>`
      : `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/><c:axId val="1"/><c:axId val="2"/></c:lineChart>`;
    const horiz = bar && ch.barDir === "bar";
    const catAx = `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="${ch.reverse ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${horiz ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="3A4250"/></a:solidFill></a:ln></c:spPr>${txPr(900)}<c:crossAx val="2"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>${horiz ? '<c:tickLblSkip val="1"/>' : ""}<c:noMultiLvlLbl val="0"/></c:catAx>`;
    const valAx = `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horiz ? "b" : "l"}"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="2B3340"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${xml(ch.money ? '#,##0,," M"' : "#,##0")}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900)}<c:crossAx val="1"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
    const title = `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:pPr><a:r><a:rPr lang="en-US" sz="1200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>${xml(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
    const legend = ch.series.length > 1 ? `<c:legend><c:legendPos val="${ch.legend || "b"}"/><c:overlay val="0"/>${txPr(900)}</c:legend>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}${catAx}${valAx}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="171B21"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="2B3340"/></a:solidFill></a:ln></c:spPr>${txPr(1000)}</c:chartSpace>`;
  }
  function drawingXml(charts) {
    const px = 9525;  // EMU per pixel
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${charts.map((ch, k) => `<xdr:oneCellAnchor><xdr:from><xdr:col>${ch.at.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${ch.at.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${Math.round(ch.w * px)}" cy="${Math.round(ch.h * px)}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${k + 2}" name="Chart ${k + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${k + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`).join("")}</xdr:wsDr>`;
  }

  // Pivot table (+ optional pivot chart) over another sheet's rows, rebuilt by Excel when the file opens
  // (refreshOnLoad), so the user can drag fields around at once.
  //   sheet.pivot = { src: sheet index, rows: field, cols: field, data: field, dataName, name, chart: { title, w, h } }
  // Fields are column indices of the source sheet (header row = field names). Text columns become item lists,
  // number columns stay numbers.
  // axis = the field indices placed on rows/columns: they get item lists (numbers too, as <n> items, sorted)
  function pivotCache(src, axis) {
    const rows = src.rows || [], head = rows[0] || [], body = rows.slice(1);
    const fields = head.map((h, c) => {
      const vals = body.map(r => r[c]);
      const isNum = vals.every(v => v == null || v === "" || (typeof v === "number" && isFinite(v)));
      if (isNum && !axis.includes(c)) { const ns = vals.filter(v => typeof v === "number"); return { name: String(h), num: true, int: ns.every(Number.isInteger), min: ns.length ? Math.min(...ns) : 0, max: ns.length ? Math.max(...ns) : 0, blank: ns.length < vals.length }; }
      if (isNum) {
        const items = [...new Set(vals.filter(v => typeof v === "number"))].sort((a, b) => a - b);
        return { name: String(h), num: false, numItems: true, items, index: new Map(items.map((v, i) => [v, i])) };
      }
      const items = [...new Set(vals.map(v => v == null ? "" : String(v)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return { name: String(h), num: false, items, index: new Map(items.map((v, i) => [v, i])) };
    });
    return { fields, body, ncol: head.length, nrow: rows.length };
  }
  function pivotCacheDefXml(pc, srcName) {
    const cf = pc.fields.map(f => f.num
      ? `<cacheField name="${xml(f.name)}" numFmtId="0"><sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1"${f.int ? ' containsInteger="1"' : ""}${f.blank ? ' containsBlank="1"' : ""} minValue="${f.min}" maxValue="${f.max}"/></cacheField>`
      : f.numItems
        ? `<cacheField name="${xml(f.name)}" numFmtId="0"><sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1" containsInteger="1" minValue="${f.items[0] ?? 0}" maxValue="${f.items[f.items.length - 1] ?? 0}" count="${f.items.length}">${f.items.map(v => `<n v="${v}"/>`).join("")}</sharedItems></cacheField>`
        : `<cacheField name="${xml(f.name)}" numFmtId="0"><sharedItems count="${f.items.length}">${f.items.map(v => `<s v="${xml(v)}"/>`).join("")}</sharedItems></cacheField>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1" refreshOnLoad="1" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3" recordCount="${pc.body.length}"><cacheSource type="worksheet"><worksheetSource ref="A1:${col(pc.ncol - 1)}${pc.nrow}" sheet="${xml(srcName)}"/></cacheSource><cacheFields count="${pc.fields.length}">${cf}</cacheFields></pivotCacheDefinition>`;
  }
  function pivotRecordsXml(pc) {
    const recs = pc.body.map(r => `<r>${pc.fields.map((f, c) => { const v = r[c]; return f.num ? (typeof v === "number" ? `<n v="${v}"/>` : "<m/>") : `<x v="${f.index.get(f.numItems ? v : v == null ? "" : String(v)) ?? 0}"/>`; }).join("")}</r>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheRecords xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${pc.body.length}">${recs}</pivotCacheRecords>`;
  }
  function pivotTableXml(pv, pc, cacheId) {
    const fItems = (f) => `<items count="${f.items.length + 1}">${f.items.map((_, i) => `<item x="${i}"/>`).join("")}<item t="default"/></items>`;
    const pf = pc.fields.map((f, c) => c === pv.rows ? `<pivotField axis="axisRow" showAll="0">${fItems(f)}</pivotField>`
      : c === pv.cols ? `<pivotField axis="axisCol" showAll="0">${fItems(f)}</pivotField>`
      : c === pv.data ? '<pivotField dataField="1" showAll="0"/>' : '<pivotField showAll="0"/>').join("");
    const nr = pc.fields[pv.rows].items.length, nc = pv.cols != null ? pc.fields[pv.cols].items.length : 0;
    const ref = `A3:${col(nc + 1)}${nr + 5}`;
    const rowItems = `<rowItems count="${nr + 1}">${Array.from({ length: nr }, (_, i) => `<i><x${i ? ` v="${i}"` : ""}/></i>`).join("")}<i t="grand"><x/></i></rowItems>`;
    const colPart = pv.cols != null ? `<colFields count="1"><field x="${pv.cols}"/></colFields><colItems count="${nc + 1}">${Array.from({ length: nc }, (_, i) => `<i><x${i ? ` v="${i}"` : ""}/></i>`).join("")}<i t="grand"><x/></i></colItems>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="${xml(pv.name || "Pivot1")}" cacheId="${cacheId}" applyNumberFormats="1" applyBorderFormats="1" applyFontFormats="1" applyPatternFormats="1" applyAlignmentFormats="1" applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="6" minRefreshableVersion="3" createdVersion="6" useAutoFormatting="1" indent="0" outline="1" outlineData="1" multipleFieldFilters="0"${pv.chart ? ' chartFormat="1"' : ""}><location ref="${ref}" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/><pivotFields count="${pc.fields.length}">${pf}</pivotFields><rowFields count="1"><field x="${pv.rows}"/></rowFields>${rowItems}${colPart}<dataFields count="1"><dataField name="${xml(pv.dataName || pc.fields[pv.data].name)}" fld="${pv.data}" baseField="0" baseItem="0" numFmtId="3"/></dataFields><pivotTableStyleInfo showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/></pivotTableDefinition>`;
  }
  function pivotChartXml(pv, sheetName, fileName) {
    const ch = pv.chart;
    const title = `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:pPr><a:r><a:rPr lang="en-US" sz="1200" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>${xml(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
    const ax = (id, cross, pos, cat) => cat
      ? `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${txPr(900)}<c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
      : `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="2B3340"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${xml('#,##0,," M"')}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${txPr(900)}<c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:pivotSource><c:name>[${xml(fileName)}]${xml(sheetName)}!${xml(pv.name || "Pivot1")}</c:name><c:fmtId val="0"/></c:pivotSource><c:chart>${title}<c:pivotFmts/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="stacked"/><c:varyColors val="0"/><c:gapWidth val="30"/><c:overlap val="100"/><c:axId val="1"/><c:axId val="2"/></c:barChart>${ax(1, 2, "b", true)}${ax(2, 1, "l", false)}<c:spPr><a:noFill/></c:spPr></c:plotArea><c:legend><c:legendPos val="r"/><c:overlay val="0"/>${txPr(900)}</c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="171B21"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="2B3340"/></a:solidFill></a:ln></c:spPr>${txPr(1000)}<c:extLst><c:ext uri="{781A3756-C4B2-4CAC-9D66-4F8BD8637D16}" xmlns:c14="http://schemas.microsoft.com/office/drawing/2007/8/2/chart"><c14:pivotOptions><c14:dropZoneFilter val="1"/><c14:dropZoneCategories val="1"/><c14:dropZoneData val="1"/><c14:dropZoneSeries val="1"/></c14:pivotOptions></c:ext></c:extLst></c:chartSpace>`;
  }

  // a chart sheet (sheet.chartsheet = chart): the chart alone, filling the window like Excel's "Move chart > New sheet"
  const chartsheetXml = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr/><sheetViews><sheetView zoomScale="100" zoomToFit="1" workbookViewId="0"/></sheetViews><pageMargins left="0.3" right="0.3" top="0.3" bottom="0.3" header="0" footer="0"/><drawing r:id="rId1"/></chartsheet>';
  const chartsheetDrawingXml = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="9294091" cy="6003636"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></xdr:cNvGraphicFramePr></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor></xdr:wsDr>';

  function sheetXml(sh) {
    const rows = sh.rows || [], nf = sh.numberFrom == null ? Infinity : sh.numberFrom, kinds = sh.kinds || [];
    const ncol = rows.reduce((n, r) => Math.max(n, r.length), 0), widths = new Array(ncol).fill(6);
    let body = "";
    rows.forEach((r, ri) => {
      let cells = "";
      r.forEach((v, ci) => {
        const ref = col(ci) + (ri + 1), head = ri === 0, num = typeof v === "number" && isFinite(v), isNum = ci >= nf;
        // style id = fill x (text | number): see styles in build(); fill 0 plain, 1 header, 2 group, 3 total, 4 band, 5 first column
        const fill = head ? 1 : kinds[ri] === "group" ? 2 : kinds[ri] === "total" ? 3 : (sh.banded && ri % 2 === 0) ? 4 : (ci === 0 && !isNum) ? 5 : 0;  // 0 = plain dark
        const style = fill * 2 + (isNum && (num || v == null || v === "" || head) ? 1 : 0);  // a text in a number column stays text
        if (num) { cells += `<c r="${ref}" s="${style}"><v>${v}</v></c>`; widths[ci] = Math.max(widths[ci], String(Math.round(v)).length * 1.3 + 2); }
        else if (v != null && v !== "") { cells += `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`; widths[ci] = Math.max(widths[ci], Math.min(60, String(v).length + 2)); }
        else cells += `<c r="${ref}" s="${style}"/>`;  // an empty cell still takes the row's fill (dark sheet, no holes)
      });
      body += `<row r="${ri + 1}">${cells}</row>`;
    });
    // column styles make the empty area dark too (used columns and everything beyond); no gridlines on dark
    const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(1)}" customWidth="1" style="0"/>`).join("") + `<col min="${ncol + 1}" max="16384" style="0"/>`;
    const freeze = sh.freeze === false ? `<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>` : rows.length > 1 ? `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>` : "";
    // the header row gets the filter/sort arrows (sheets with grouped rows keep their structure: no filter there)
    const filter = sh.filter !== false && rows.length > 1 && ncol > 0 ? `<autoFilter ref="A1:${col(ncol - 1)}${rows.length}"/>` : "";
    const drawing = (sh.charts || []).length ? '<drawing r:id="rId1"/>' : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${freeze}<cols>${cols}</cols><sheetData>${body}</sheetData>${filter}${drawing}</worksheet>`;
  }

  // fills 0..5 (see sheetXml) x text/number = 12 cell styles, dark like the page: plain 13171C, header 1E232B,
  // group rows 2B3340, totals 24303D, bands 1A1F26, first column 171B21. Text D6DAE0, bold on groups/totals, white
  // on the header. Number cells get a format whose sections colour the sign like the game: blue / salmon / grey.
  function stylesXml() {
    const fills = ["13171C", "1E232B", "2B3340", "24303D", "1A1F26", "171B21"];
    const fontOf = (f) => f === 1 ? 2 : (f === 2 || f === 3) ? 1 : 0;  // 0 plain light, 1 bold light, 2 bold white
    const xfs = [];
    fills.forEach((_, f) => {
      for (const num of [0, 1]) {
        xfs.push(`<xf numFmtId="${num ? 164 : 0}" fontId="${fontOf(f)}" fillId="${f + 2}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="${num}"${f === 1 ? ' applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' : "/>"}`);  // header cells centred
      }
    });
    const fillXml = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>', ...fills.map(c => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor rgb="FF${c}"/></patternFill></fill>`)];
    const fonts = ['<font><sz val="11"/><color rgb="FFD6DAE0"/><name val="Calibri"/></font>', '<font><b/><sz val="11"/><color rgb="FFD6DAE0"/><name val="Calibri"/></font>', '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'];
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="[Color4]#,##0;[Color3]-#,##0;[Color16]0"/></numFmts><fonts count="3">${fonts.join("")}</fonts><fills count="${fillXml.length}">${fillXml.join("")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><colors><indexedColors>${INDEXED.map(c => `<rgbColor rgb="FF${c}"/>`).join("")}</indexedColors></colors></styleSheet>`;
  }
  // the 64-entry legacy palette: [ColorN] in a number format points at indexed entry N + 7 (entries 0-7 are the
  // fixed EGA duplicates), so [Color4] = index 11, [Color3] = index 10, [Color16] = index 23. Before 0.14 the
  // overrides sat at 3/4/16 and Excel read 10/11 instead: positives came out red, negatives white.
  // Colours of the game's Finances charts: income blue 8AB4F8, expenses salmon F08080, zero grey 7D8590.
  const INDEXED = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "F08080", "8AB4F8", "0000FF", "FFFF00", "FF00FF", "00FFFF", "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "7D8590", "808080", "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF", "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF", "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99", "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696", "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333"];

  // fileName: the name the workbook is saved under (a pivot chart names its pivot table as [file]sheet!table)
  function build(sheets, fileName = "book.xlsx") {
    const rawNames = sheets.map((s, i) => String(s.name || `Sheet${i + 1}`).replace(/[\\/*?:[\]]/g, " ").slice(0, 31));
    const names = rawNames.map(xml);
    const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
    const rels = (list) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.join("")}</Relationships>`;
    // pivot tables: one cache per pivot, the pivot chart joins the sheet's charts
    const extra = [], over = [], wbPivot = [], wbRels = [];
    let np = 0;
    const sheetRels = sheets.map(() => []);
    sheets.forEach((s, i) => {
      const pv = s.pivot; if (!pv) return;
      const p = ++np, pc = pivotCache(sheets[pv.src], [pv.rows, pv.cols].filter(v => v != null));
      const rid = `rId${sheets.length + 1 + p}`;
      extra.push([`xl/pivotCache/pivotCacheDefinition${p}.xml`, pivotCacheDefXml(pc, rawNames[pv.src])]);
      extra.push([`xl/pivotCache/pivotCacheRecords${p}.xml`, pivotRecordsXml(pc)]);
      extra.push([`xl/pivotCache/_rels/pivotCacheDefinition${p}.xml.rels`, rels([`<Relationship Id="rId1" Type="${REL}pivotCacheRecords" Target="pivotCacheRecords${p}.xml"/>`])]);
      extra.push([`xl/pivotTables/pivotTable${p}.xml`, pivotTableXml(pv, pc, p)]);
      extra.push([`xl/pivotTables/_rels/pivotTable${p}.xml.rels`, rels([`<Relationship Id="rId1" Type="${REL}pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition${p}.xml"/>`])]);
      over.push(`<Override PartName="/xl/pivotCache/pivotCacheDefinition${p}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>`,
        `<Override PartName="/xl/pivotCache/pivotCacheRecords${p}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"/>`,
        `<Override PartName="/xl/pivotTables/pivotTable${p}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>`);
      wbPivot.push(`<pivotCache cacheId="${p}" r:id="${rid}"/>`);
      wbRels.push(`<Relationship Id="${rid}" Type="${REL}pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition${p}.xml"/>`);
      sheetRels[i].push(`<Relationship Id="rId2" Type="${REL}pivotTable" Target="../pivotTables/pivotTable${p}.xml"/>`);
      if (pv.chart) s.charts = [...(s.charts || []), { ...pv.chart, pivotOf: pv, pivotHost: i }];
    });
    // drawings and charts: drawing d+1 for each sheet with charts, charts numbered across the workbook
    let nd = 0, nc = 0;
    sheets.forEach((s) => { if (s.chartsheet) s.charts = [s.chartsheet]; });
    sheets.forEach((s, i) => {
      const charts = s.charts || []; if (!charts.length) return;
      const d = ++nd;
      sheetRels[i].unshift(`<Relationship Id="rId1" Type="${REL}drawing" Target="../drawings/drawing${d}.xml"/>`);
      extra.push([`xl/drawings/drawing${d}.xml`, s.chartsheet ? chartsheetDrawingXml() : drawingXml(charts)]);
      over.push(`<Override PartName="/xl/drawings/drawing${d}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
      const rels = charts.map((ch, k) => {
        const c = ++nc;
        extra.push([`xl/charts/chart${c}.xml`, ch.pivotOf ? pivotChartXml(ch.pivotOf, rawNames[ch.pivotHost], fileName) : chartXml(ch, i, sheets, rawNames)]);
        over.push(`<Override PartName="/xl/charts/chart${c}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
        return `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${c}.xml"/>`;
      });
      extra.push([`xl/drawings/_rels/drawing${d}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`]);
    });
    const part = (s) => s.chartsheet ? "chartsheets" : "worksheets";
    sheetRels.forEach((r, i) => { if (r.length) extra.push([`xl/${part(sheets[i])}/_rels/sheet${i + 1}.xml.rels`, rels(r)]); });
    const files = [
      ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/${part(s)}/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${s.chartsheet ? "chartsheet" : "worksheet"}+xml"/>`).join("")}${over.join("")}</Types>`],
      ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><definedNames>${sheets.map((s, i) => { const rows = s.rows || [], nc = rows.reduce((n, r) => Math.max(n, r.length), 0); return !s.chartsheet && s.filter !== false && rows.length > 1 && nc > 0 ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${names[i].replace(/'/g, "''")}'!$A$1:$${col(nc - 1)}$${rows.length}</definedName>` : ""; }).join("")}</definedNames>${wbPivot.length ? `<pivotCaches>${wbPivot.join("")}</pivotCaches>` : ""}</workbook>`],
      ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}${s.chartsheet ? "chartsheet" : "worksheet"}" Target="${part(s)}/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${wbRels.join("")}</Relationships>`],
      ["xl/styles.xml", stylesXml()],
    ];
    sheets.forEach((s, i) => files.push([`xl/${part(s)}/sheet${i + 1}.xml`, s.chartsheet ? chartsheetXml() : sheetXml(s)]));
    return zip(files.concat(extra));
  }

  function download(blob, filename) {
    const a = document.createElement("a"), url = URL.createObjectURL(blob);
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return { build, download };
})();
