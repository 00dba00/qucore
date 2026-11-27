import type { CellValue, DbType, EditStatement, RowEdit } from '../shared/types.ts'
import { quoteIdent } from './util.ts'
import { t } from '../shared/i18n.ts'

/** Tablica nad kojom se rade izmjene. */
export interface EditTarget {
  database: string
  schema?: string
  table: string
}

export function tableName(type: DbType, t: EditTarget): string {
  const q = quoteIdent[type]
  if (type === 'mssql') return `${q(t.database)}.${q(t.schema ?? 'dbo')}.${q(t.table)}`
  if (type === 'postgres') return `${q(t.schema ?? 'public')}.${q(t.table)}` // PostgreSQL: baza je određena konekcijom
  return `${q(t.database)}.${q(t.table)}`
}

function placeholder(type: DbType, n: number): string {
  return type === 'mariadb' ? '?' : type === 'postgres' ? `$${n}` : `@p${n}`
}

/**
 * Pretvara izmjene iz grida u parametrizirane naredbe. Isti rezultat koristi i pregled (literalSql)
 * i izvršavanje, pa korisnik vidi točno ono što se izvršava.
 */
export function buildEditStatements(type: DbType, target: EditTarget, edits: RowEdit[]): EditStatement[] {
  const q = quoteIdent[type]
  const name = tableName(type, target)
  return edits.map((e, i) => {
    const params: CellValue[] = []
    const p = (v: CellValue) => {
      params.push(v)
      return placeholder(type, params.length)
    }
    const where = (key: Record<string, CellValue> | undefined) => {
      const entries = Object.entries(key ?? {})
      if (entries.length === 0) throw new Error(t('core.editNoPk', i + 1))
      // "= NULL" nikad ne pogađa redak — primarni ključ ionako ne smije biti NULL.
      return entries.map(([c, v]) => `${q(c)} = ${p(v)}`).join(' AND ')
    }

    if (e.kind === 'update') {
      const set = Object.entries(e.values ?? {})
      if (set.length === 0) throw new Error(t('core.editNoChanges', i + 1))
      const setSql = set.map(([c, v]) => `${q(c)} = ${p(v)}`).join(', ')
      return { sql: `UPDATE ${name} SET ${setSql} WHERE ${where(e.key)}`, params, expectOneRow: true }
    }
    if (e.kind === 'delete') {
      return { sql: `DELETE FROM ${name} WHERE ${where(e.key)}`, params, expectOneRow: true }
    }
    const cols = Object.entries(e.values ?? {})
    if (cols.length === 0) {
      return { sql: type === 'mariadb' ? `INSERT INTO ${name} () VALUES ()` : `INSERT INTO ${name} DEFAULT VALUES`, params, expectOneRow: true }
    }
    return {
      sql: `INSERT INTO ${name} (${cols.map(([c]) => q(c)).join(', ')}) VALUES (${cols.map(([, v]) => p(v)).join(', ')})`,
      params,
      expectOneRow: true
    }
  })
}

/** Literal za pregled (nikad se ne izvršava — izvršavanje ide preko parametara). */
export function sqlLiteral(type: DbType, v: CellValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return type === 'mssql' ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE'
  let s = v.replace(/'/g, "''")
  if (type === 'mariadb') s = s.replace(/\\/g, '\\\\')
  return (type === 'mssql' ? 'N' : '') + `'${s}'`
}

/** Naredba s parametrima zamijenjenim literalima — samo za prikaz u pregledu. */
export function literalSql(type: DbType, st: EditStatement): string {
  const re = type === 'mariadb' ? /\?/g : type === 'postgres' ? /\$(\d+)/g : /@p(\d+)/g
  let i = 0
  let out = ''
  // Nazivi u navodnicima (`x`, "x", [x]) smiju sadržavati ?, $1 ili @p1 — njih preskačemo.
  const parts = st.sql.split(/(`(?:[^`]|``)*`|"(?:[^"]|"")*"|\[(?:[^\]]|\]\])*\])/)
  for (const part of parts) {
    if (/^[`"[]/.test(part)) out += part
    // Bez grupe (MariaDB "?") replace kao drugi argument daje poziciju, ne broj — zato typeof provjera.
    else out += part.replace(re, (_m, n: unknown) => sqlLiteral(type, st.params[typeof n === 'string' ? Number(n) - 1 : i++]))
  }
  return out
}

/** Provjera nakon svake naredbe: bez ovoga bi pogrešan WHERE mogao tiho promijeniti 0 ili više redaka. */
export function assertOneRow(index: number, affected: number): void {
  if (affected !== 1) {
    throw new Error(t('core.editNotOneRow', index + 1, affected))
  }
}
