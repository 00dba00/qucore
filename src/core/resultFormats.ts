import type { CellValue, ResultColumn, DbType } from '../shared/types.ts'

/** Rezultat kako je prikazan u gridu (sortiran, filtriran, s neuspremljenim izmjenama). */
export interface ResultView {
  columns: ResultColumn[]
  rows: CellValue[][]
}

const NUMERIC_TYPE = /int|numeric|decimal|float|double|real|money|serial|number/i
const BINARY_TYPE = /binary|blob|bytea|image/i
const PLAIN_NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

export function csvValue(v: CellValue): string {
  if (v === null) return ''
  const s = String(v)
  return /[;,\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** CSV sa ";" i BOM-om, kako ga Excel s hrvatskim postavkama otvara ispravno. */
export function toCsv(view: ResultView): string {
  const lines = [view.columns.map((c) => csvValue(c.name)).join(';')]
  for (const r of view.rows) lines.push(r.map(csvValue).join(';'))
  return '﻿' + lines.join('\r\n')
}

/** Jedinstveni ključevi za JSON objekte (dva stupca "a" → "a", "a_2"). */
function uniqueNames(columns: ResultColumn[]): string[] {
  const seen = new Map<string, number>()
  return columns.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1
    seen.set(c.name, n)
    return n === 1 ? c.name : `${c.name}_${n}`
  })
}

/** Broj iz teksta ako se točno prikazuje u JavaScriptu/Excelu (do 15 značajnih znamenki), inače undefined. */
export function safeNumber(s: string): number | undefined {
  if (!/^-?\d+(\.\d+)?$/.test(s)) return undefined
  if (s.replace(/^-?0*|\./g, '').length > 15) return undefined
  return Number(s)
}

/**
 * JSON polje objekata; NULL je null. Brojevi iz numeričkih stupaca (driver ih često šalje kao tekst,
 * npr. DECIMAL i BIGINT) postaju brojevi kad se ne gubi preciznost, inače ostaju tekst.
 */
export function toJson(view: ResultView): string {
  const names = uniqueNames(view.columns)
  const numeric = view.columns.map((_, i) => isNumericColumn(view, i))
  const value = (v: CellValue, i: number) => (numeric[i] && typeof v === 'string' ? (safeNumber(v) ?? v) : v)
  return JSON.stringify(
    view.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, value(r[i] ?? null, i)]))),
    null,
    2
  )
}

function mdCell(v: CellValue): string {
  if (v === null) return 'NULL'
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

/** Markdown tablica (GitHub, Jira, Confluence, README). */
export function toMarkdown(view: ResultView): string {
  const head = '| ' + view.columns.map((c) => mdCell(c.name)).join(' | ') + ' |'
  const sep = '| ' + view.columns.map((c, i) => (isNumericColumn(view, i) ? '---:' : '---')).join(' | ') + ' |'
  return [head, sep, ...view.rows.map((r) => '| ' + r.map(mdCell).join(' | ') + ' |')].join('\n')
}

export function isNumericColumn(view: ResultView, i: number): boolean {
  const t = view.columns[i].type
  return t ? NUMERIC_TYPE.test(t) : view.rows.slice(0, 50).some((r) => typeof r[i] === 'number')
}

/** SQL literal vrijednosti za dijalekt (tip stupca pomaže za brojeve i binarne podatke). */
export function sqlLiteral(v: CellValue, dialect: DbType, colType?: string): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return dialect === 'mssql' ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE'
  const s = String(v)
  if (colType && NUMERIC_TYPE.test(colType) && PLAIN_NUMBER.test(s)) return s
  if (colType && BINARY_TYPE.test(colType) && /^0x[0-9a-f]*$/i.test(s)) {
    return dialect === 'postgres' ? `'\\x${s.slice(2)}'::bytea` : s
  }
  // MariaDB (bez NO_BACKSLASH_ESCAPES) tumači \ u stringu, pa ga se udvostručuje.
  const body = (dialect === 'mariadb' ? s.replace(/\\/g, '\\\\') : s).replace(/'/g, "''")
  return dialect === 'mssql' ? `N'${body}'` : `'${body}'`
}

/**
 * Jedna INSERT naredba po retku (radi na svim bazama, bez ograničenja broja redaka u VALUES).
 * table i quote dolaze izvana: naziv tablice je već citiran, quote citira nazive stupaca.
 */
export function toInserts(view: ResultView, dialect: DbType, table: string, quote: (name: string) => string): string {
  const cols = view.columns.map((c) => quote(c.name)).join(', ')
  return view.rows
    .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v, i) => sqlLiteral(v, dialect, view.columns[i].type)).join(', ')});`)
    .join('\n')
}
