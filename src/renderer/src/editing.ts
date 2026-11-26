import { api } from './api'
import type { CellValue, ColumnInfo, EditTable, ResultSet, RowEdit } from '../../shared/types'
import { t } from './i18n'

/** Tablica iz koje je tab otvoren (Explorer → tablica). */
export interface SourceTable extends EditTable {}

/** Izmjene koje još nisu spremljene. Postojeći redovi se prepoznaju po referenci na niz iz rezultata. */
export interface Pending {
  /** redak → (indeks kolone → nova vrijednost) */
  updates: Map<CellValue[], Map<number, CellValue>>
  deletes: Set<CellValue[]>
  /** Novi redovi: samo popunjene kolone; ostale dobiju DEFAULT. */
  inserts: Map<number, CellValue>[]
}

export interface EditContext {
  target: EditTable
  /** Po koloni rezultata: smije li se uređivati. */
  editable: boolean[]
  /** Indeksi kolona primarnog ključa u rezultatu. */
  pkCols: number[]
}

export const emptyPending = (): Pending => ({ updates: new Map(), deletes: new Set(), inserts: [] })

export function pendingCount(p: Pending): number {
  let n = p.deletes.size + p.inserts.length
  for (const [row, cells] of p.updates) if (cells.size && !p.deletes.has(row)) n++
  return n
}

/** Brisanja prvo (da novi redak smije preuzeti obrisani ključ), zatim izmjene, pa novi redovi. */
export function toRowEdits(rs: ResultSet, ctx: EditContext, p: Pending): RowEdit[] {
  const name = (i: number) => rs.columns[i].name
  const key = (row: CellValue[]) => Object.fromEntries(ctx.pkCols.map((i) => [name(i), row[i]]))
  const values = (cells: Map<number, CellValue>) => Object.fromEntries([...cells].map(([i, v]) => [name(i), v]))
  const out: RowEdit[] = []
  for (const row of p.deletes) out.push({ kind: 'delete', key: key(row) })
  for (const [row, cells] of p.updates) {
    if (cells.size && !p.deletes.has(row)) out.push({ kind: 'update', key: key(row), values: values(cells) })
  }
  for (const cells of p.inserts) out.push({ kind: 'insert', values: values(cells) })
  return out
}

const BINARY = /binary|blob|bytea|image|varbinary|geometry|geography|hierarchyid/i

/**
 * Provjerava smije li se rezultat uređivati: svaka kolona mora biti prava kolona izvorne tablice,
 * a primarni ključ mora postojati i biti u rezultatu. Vraća kontekst ili razlog zašto ne.
 */
export async function resolveEditContext(
  connectionId: string,
  database: string | undefined,
  source: SourceTable,
  rs: ResultSet,
  resultSetCount: number
): Promise<{ ctx?: EditContext; reason?: string }> {
  const label = source.schema ? `${source.schema}.${source.table}` : source.table
  if (resultSetCount !== 1) return { reason: t('editCtx.manyResults') }
  if (database !== source.database) return { reason: t('editCtx.otherDb', source.database) }
  const children = await api.explorer.children(connectionId, source.database, {
    kind: 'table',
    schema: source.schema,
    name: source.table,
    expandable: true
  })
  const cols = children.filter((c): c is { type: 'column' } & ColumnInfo => c.type === 'column')
  const byName = new Map(cols.map((c) => [c.name.toLowerCase(), c]))
  const seen = new Set<string>()
  const mapped: ColumnInfo[] = []
  for (const rc of rs.columns) {
    const k = rc.name.toLowerCase()
    const col = byName.get(k)
    if (!col) return { reason: t('editCtx.notTableColumn', rc.name, label) }
    if (seen.has(k)) return { reason: t('editCtx.duplicateColumn', rc.name) }
    seen.add(k)
    mapped.push(col)
  }
  const pk = cols.filter((c) => c.primaryKey)
  if (pk.length === 0) return { reason: t('editCtx.noPk', label) }
  const pkCols: number[] = []
  for (const c of pk) {
    const i = mapped.indexOf(c)
    if (i < 0) return { reason: t('editCtx.pkMissing', c.name) }
    if (BINARY.test(c.dataType)) return { reason: t('editCtx.pkBinary') }
    pkCols.push(i)
  }
  return {
    ctx: {
      target: { database: source.database, schema: source.schema, table: source.table },
      editable: mapped.map((c) => !BINARY.test(c.dataType)),
      pkCols
    }
  }
}
