// A minimal .xlsx writer: sheets of rows of strings/numbers, bold header row, thousands separators on numbers, frozen
// header row and first column, column widths from the content. Office Open XML is a zip of a few XML files; the zip
// is written "stored" (no compression: a whole game's finances is a few hundred KB, and the zip format then needs
// only a CRC-32), so this runs in any browser with no library.
//   XLSX.build([{ name, rows: [[...], ...], numberFrom: 1, kinds: ["group", ...], banded: true }]) -> Blob;  XLSX.download(blob, "file.xlsx")
// numberFrom: columns from this index are numbers (cells get the thousands format even when empty).
// kinds[i]: "group" (bold, raised), "total" (bold, blue-grey) or "detail" for row i; banded: alternate row fills;
// filter: false to leave out the header's filter/sort arrows (default on).
// Dark sheets like the page: numbers green positive, red negative, grey zero.
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
    const freeze = rows.length > 1 ? `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>` : "";
    // the header row gets the filter/sort arrows (sheets with grouped rows keep their structure: no filter there)
    const filter = sh.filter !== false && rows.length > 1 && ncol > 0 ? `<autoFilter ref="A1:${col(ncol - 1)}${rows.length}"/>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}<cols>${cols}</cols><sheetData>${body}</sheetData>${filter}</worksheet>`;
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

  function build(sheets) {
    const names = sheets.map((s, i) => xml(String(s.name || `Sheet${i + 1}`).replace(/[\\/*?:[\]]/g, " ").slice(0, 31)));
    const files = [
      ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
      ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><definedNames>${sheets.map((s, i) => { const rows = s.rows || [], nc = rows.reduce((n, r) => Math.max(n, r.length), 0); return s.filter !== false && rows.length > 1 && nc > 0 ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${names[i].replace(/'/g, "''")}'!$A$1:$${col(nc - 1)}$${rows.length}</definedName>` : ""; }).join("")}</definedNames></workbook>`],
      ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ["xl/styles.xml", stylesXml()],
    ];
    sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]));
    return zip(files);
  }

  function download(blob, filename) {
    const a = document.createElement("a"), url = URL.createObjectURL(blob);
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return { build, download };
})();
