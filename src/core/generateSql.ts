import type { ColumnInfo, DbType } from '../shared/types.ts'
import { t as tr } from '../shared/i18n.ts'

/*
 * Predlošci SQL-a iz Explorera. Vrijednosti su varijable aplikacije (:stupac), pa izvršavanje
 * otvori dijalog za vrijednosti (poglavlje Varijable). Bez primarnog ključa UPDATE/DELETE dobivaju
 * WHERE 1 = 0 — ne mijenjaju ništa dok se uvjet ne napiše.
 */

/** Naziv varijable iz naziva stupca (slova, brojke, _). */
export function paramName(column: string): string {
  const n = column.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '')
  return /^\p{L}|^_/u.test(n) ? n : `p_${n || 'x'}`
}

const typeNote = (c: ColumnInfo) =>
  `${c.dataType}${c.nullable ? '' : ', not null'}${c.defaultValue != null && c.defaultValue !== '' ? `, default ${c.defaultValue}` : ''}`

const list = (items: string[], indent = '    ') => items.map((s, i) => indent + s + (i < items.length - 1 ? ',' : '')).join('\n')

export interface GenTarget {
  type: DbType
  /** Citirani puni naziv tablice. */
  table: string
  columns: ColumnInfo[]
  /** Citira naziv stupca (navodnici samo kad trebaju). */
  quote(name: string): string
}

/** SELECT sa svim stupcima navedenim po imenu (umjesto *), ograničen na 100 redaka. */
export function genSelect(t: GenTarget): string {
  const cols = list(t.columns.map((c) => t.quote(c.name)))
  return t.type === 'mssql' ? `SELECT TOP 100\n${cols}\nFROM ${t.table};` : `SELECT\n${cols}\nFROM ${t.table}\nLIMIT 100;`
}

/** Identity / auto_increment / serial stupci se izostavljaju (baza ih sama puni). */
export function genInsert(t: GenTarget): string {
  const cols = t.columns.filter((c) => !c.identity)
  if (!cols.length) return `INSERT INTO ${t.table} DEFAULT VALUES;`
  // Komentar ide iza zareza, inače bi zarez završio u komentaru.
  const values = cols.map((c, i) => `    :${paramName(c.name)}${i < cols.length - 1 ? ',' : ''} -- ${c.name}: ${typeNote(c)}`)
  return `INSERT INTO ${t.table} (\n${list(cols.map((c) => t.quote(c.name)))}\n)\nVALUES (\n${values.join('\n')}\n);`
}

function where(t: GenTarget): string {
  const pk = t.columns.filter((c) => c.primaryKey)
  if (!pk.length) return tr('core.genNoPk')
  return 'WHERE ' + pk.map((c) => `${t.quote(c.name)} = :${paramName(c.name)}`).join('\n  AND ')
}

export function genUpdate(t: GenTarget): string {
  const set = t.columns.filter((c) => !c.primaryKey && !c.identity)
  if (!set.length) return tr('core.genNoColumns') + '\n'
  return `UPDATE ${t.table}\nSET\n${list(set.map((c) => `${t.quote(c.name)} = :${paramName(c.name)}`))}\n${where(t)};`
}

export function genDelete(t: GenTarget): string {
  return `DELETE FROM ${t.table}\n${where(t)};`
}
