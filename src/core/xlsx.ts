import type { CellValue } from '../shared/types.ts'
import { isNumericColumn, safeNumber, type ResultView } from './resultFormats.ts'

/*
 * Minimalni .xlsx (Office Open XML) bez biblioteke: ZIP bez kompresije s pet XML datoteka.
 * Brojevi i datumi su pravi tipovi (Excel s njima računa i sortira), zaglavlje je podebljano i zamrznuto.
 */

const DATE_TYPE = /date|time/i
const DATE_VALUE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/
/** Excel ćelija prima najviše ovoliko znakova. */
const MAX_TEXT = 32767

/** Zabranjeni XML 1.0 kontrolni znakovi (osim tab, CR, LF) se izbacuju. */
function xml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function colName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** Excel serijski datum (dani od 1899-12-30) ili undefined ako vrijednost nije datum. */
export function excelDate(s: string): { serial: number; withTime: boolean } | undefined {
  const m = DATE_VALUE.exec(s)
  if (!m) return undefined
  const [, y, mo, d, h, mi, sec, frac] = m
  const ms = Date.UTC(+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0), +(sec ?? 0), frac ? Math.round(+('0.' + frac) * 1000) : 0)
  if (Number.isNaN(ms)) return undefined
  return { serial: (ms - Date.UTC(1899, 11, 30)) / 86400000, withTime: h !== undefined }
}

// Stilovi (cellXfs): 0 obično, 1 zaglavlje (bold), 2 datum i vrijeme, 3 datum.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>`

function cell(ref: string, v: CellValue, numeric: boolean, dateCol: boolean): string {
  if (v === null) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : ''
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`
  if (numeric) {
    const n = safeNumber(v)
    if (n !== undefined) return `<c r="${ref}"><v>${n}</v></c>`
  }
  if (dateCol) {
    const d = excelDate(v)
    if (d) return `<c r="${ref}" s="${d.withTime ? 2 : 3}"><v>${d.serial}</v></c>`
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v.slice(0, MAX_TEXT))}</t></is></c>`
}

function sheetXml(view: ResultView): string {
  const numeric = view.columns.map((_, i) => isNumericColumn(view, i))
  const dates = view.columns.map((c) => !!c.type && DATE_TYPE.test(c.type) && !/^time/i.test(c.type))
  // Širina stupca prema najduljem tekstu u prvih 200 redaka (8–60 znakova).
  const widths = view.columns.map((c, i) => {
    let w = c.name.length
    for (const r of view.rows.slice(0, 200)) w = Math.max(w, r[i] === null ? 4 : String(r[i]).length)
    return Math.min(60, Math.max(8, w + 2))
  })
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>',
    '<sheetData>',
    '<row r="1">' +
      view.columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xml(c.name)}</t></is></c>`).join('') +
      '</row>'
  ]
  view.rows.forEach((r, k) => {
    const n = k + 2
    out.push(`<row r="${n}">` + r.map((v, i) => cell(`${colName(i)}${n}`, v, numeric[i], dates[i])).join('') + '</row>')
  })
  if (view.columns.length) out.push('</sheetData>', `<autoFilter ref="A1:${colName(view.columns.length - 1)}${view.rows.length + 1}"/>`)
  else out.push('</sheetData>')
  out.push('</worksheet>')
  return out.join('')
}

/** .xlsx s jednim listom; sheetName se skraćuje na 31 znak i čisti od znakova koje Excel ne dopušta. */
export function buildXlsx(view: ResultView, sheetName = 'Result'): Uint8Array<ArrayBuffer> {
  const name = xml(sheetName.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Result')
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>` +
        (view.columns.length
          ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${colName(view.columns.length - 1)}$${view.rows.length + 1}</definedName></definedNames>`
          : '') +
        '</workbook>'
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
    ],
    ['xl/worksheets/sheet1.xml', sheetXml(view)],
    ['xl/styles.xml', STYLES]
  ]
  return zipStore(files.map(([path, text]) => [path, new TextEncoder().encode(text)]))
}

// ---------- ZIP bez kompresije (method 0) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function zipStore(entries: [string, Uint8Array][]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [path, data] of entries) {
    const name = new TextEncoder().encode(path)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // verzija za raspakiranje
    local.setUint16(6, 0x0800, true) // UTF-8 nazivi
    local.setUint16(8, 0, true) // bez kompresije
    local.setUint16(10, 0, true) // vrijeme
    local.setUint16(12, 0x21, true) // datum 1980-01-01
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)
    parts.push(new Uint8Array(local.buffer), name, data)

    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true)
    cd.setUint16(6, 20, true)
    cd.setUint16(8, 0x0800, true)
    cd.setUint16(10, 0, true)
    cd.setUint16(12, 0, true)
    cd.setUint16(14, 0x21, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, data.length, true)
    cd.setUint32(24, data.length, true)
    cd.setUint16(28, name.length, true)
    cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), name)
    offset += 30 + name.length + data.length
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, cdSize, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const p of all) {
    out.set(p, pos)
    pos += p.length
  }
  return out
}
