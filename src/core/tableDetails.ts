import type { ForeignKeyInfo, IndexInfo } from '../shared/types.ts'

/** Jedan redak kataloga po stupcu indeksa (redoslijed = redoslijed stupaca u ključu). */
export interface IndexColumnRow {
  name: string
  column: string
  unique: boolean | number | string
  primary: boolean | number | string
  type?: string | null
  included?: boolean | number | string | null
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 't' || v === 'YES'

export function groupIndexes(rows: IndexColumnRow[]): IndexInfo[] {
  const map = new Map<string, IndexInfo>()
  for (const r of rows) {
    let ix = map.get(r.name)
    if (!ix) {
      ix = { name: r.name, columns: [], unique: truthy(r.unique), primary: truthy(r.primary), type: r.type ?? undefined }
      map.set(r.name, ix)
    }
    if (truthy(r.included)) (ix.included ??= []).push(r.column)
    else ix.columns.push(r.column)
  }
  // Primarni ključ prvi, zatim jedinstveni, pa ostali po nazivu.
  return [...map.values()].sort((a, b) => Number(b.primary) - Number(a.primary) || Number(b.unique) - Number(a.unique) || a.name.localeCompare(b.name))
}

/** Jedan redak kataloga po paru stupaca stranog ključa. */
export interface FkColumnRow {
  name: string
  fromSchema?: string | null
  fromTable: string
  fromColumn: string
  toSchema?: string | null
  toTable: string
  toColumn: string
}

export function groupForeignKeyRows(rows: FkColumnRow[]): ForeignKeyInfo[] {
  const map = new Map<string, ForeignKeyInfo>()
  for (const r of rows) {
    const key = `${r.fromSchema ?? ''}.${r.fromTable}.${r.name}`
    let fk = map.get(key)
    if (!fk) {
      fk = {
        name: r.name,
        fromSchema: r.fromSchema ?? undefined,
        fromTable: r.fromTable,
        fromColumns: [],
        toSchema: r.toSchema ?? undefined,
        toTable: r.toTable,
        toColumns: []
      }
      map.set(key, fk)
    }
    fk.fromColumns.push(r.fromColumn)
    fk.toColumns.push(r.toColumn)
  }
  return [...map.values()]
}

/**
 * PostgreSQL pg_indexes.indexdef → stupci i vrsta, npr.
 * "CREATE UNIQUE INDEX x ON s.t USING btree (a, lower(b)) INCLUDE (c)".
 */
export function parsePgIndexDef(def: string): { columns: string[]; unique: boolean; type?: string; included?: string[] } {
  const unique = /^CREATE UNIQUE/i.test(def)
  const type = /USING (\w+)/i.exec(def)?.[1]
  // Prva zagrada nakon USING (ili ON …) s uravnoteženim zagradama.
  const start = def.indexOf('(', def.search(/USING|\bON\b/i))
  const cols: string[] = []
  let depth = 0
  let cur = ''
  let end = start
  for (let i = start + 1; i < def.length; i++) {
    const c = def[i]
    if (c === '(') depth++
    if (c === ')') {
      if (depth === 0) {
        end = i
        break
      }
      depth--
    }
    if (c === ',' && depth === 0) {
      cols.push(cur.trim())
      cur = ''
    } else cur += c
  }
  if (cur.trim()) cols.push(cur.trim())
  const inc = /INCLUDE \(([^)]*)\)/i.exec(def.slice(end))
  return { columns: cols.map((c) => c.replace(/^"|"$/g, '')), unique, type, included: inc ? inc[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')) : undefined }
}

/** PostgreSQL pg_get_constraintdef → "FOREIGN KEY (a, b) REFERENCES s.t(x, y) …". */
export function parsePgFkDef(def: string): { fromColumns: string[]; toSchema?: string; toTable: string; toColumns: string[] } | undefined {
  const m = /FOREIGN KEY \(([^)]*)\) REFERENCES ([^(]+)\(([^)]*)\)/i.exec(def)
  if (!m) return undefined
  const split = (s: string) => s.split(',').map((x) => x.trim().replace(/^"|"$/g, ''))
  const target = m[2].trim().split('.').map((x) => x.replace(/^"|"$/g, ''))
  return { fromColumns: split(m[1]), toSchema: target.length > 1 ? target[0] : undefined, toTable: target[target.length - 1], toColumns: split(m[3]) }
}
