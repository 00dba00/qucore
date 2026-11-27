import type { DbType, JobColumn, ResultColumn } from '../../shared/types.ts'
import { mssqlDateText, quoteIdent } from '../util.ts'
import { sqlLiteral, tableName, type EditTarget } from '../edits.ts'
import { t } from '../../shared/i18n.ts'

/**
 * Vrijednost u prijenosu: bez gubitka (binarni podaci cijeli, veliki brojevi i decimale kao tekst,
 * datumi kao tekst kakav je u izvornoj bazi).
 */
export type TransferValue = string | number | boolean | null | Uint8Array

const pad = (n: number, len = 2) => String(n).padStart(len, '0')

/** Vrsta tipa bez parametara: "decimal(18,2)" → "decimal", "double precision" ostaje. */
function baseType(type: string | undefined): string {
  return (type ?? '').toLowerCase().replace(/\(.*$/, '').trim()
}

/**
 * Vrijednost iz drivera → vrijednost za prijenos. PostgreSQL i MariaDB datume već vraćaju kao tekst;
 * SQL Server (tedious, useUTC) daje Date čije UTC komponente su vrijednost iz baze.
 */
export function transferValue(v: unknown, sourceDialect: DbType, columnType?: string): TransferValue {
  if (v === null || v === undefined) return null
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v
    case 'number':
      return Number.isFinite(v) ? v : String(v)
    case 'bigint':
      return v.toString()
  }
  if (v instanceof Uint8Array) return v
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return String(v)
    // SQL Server driver datume već daje kao tekst; Date ovdje stiže samo izravno iz tediousa.
    if (sourceDialect === 'mssql') return mssqlDateText(v, columnType)
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}.${pad(v.getMilliseconds(), 3)}`
  }
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** SQL literal vrijednosti u prijenosu (tekst s escapeom po dijalektu, binarni podaci kao hex). */
export function transferLiteral(dialect: DbType, v: TransferValue): string {
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')
    return dialect === 'mssql' ? `0x${hex}` : dialect === 'postgres' ? `'\\x${hex}'::bytea` : `X'${hex}'`
  }
  return sqlLiteral(dialect, v)
}

const MSSQL_LEGACY_DATETIME = new Set(['datetime', 'smalldatetime'])
const LONG_FRACTION = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d{3})\d+$/

/**
 * Prilagodba vrijednosti tipu odredišnog stupca. SQL Server datetime prima najviše tri decimale sekundi
 * (PostgreSQL i MariaDB šalju mikrosekunde), inače pretvorba teksta pada.
 */
export function adaptValue(v: TransferValue, targetDialect: DbType, targetType?: string): TransferValue {
  if (typeof v === 'string' && targetDialect === 'mssql' && MSSQL_LEGACY_DATETIME.has(baseType(targetType))) {
    const m = LONG_FRACTION.exec(v)
    if (m) return m[1]
  }
  return v
}

// ---------- Stupci ----------

/** Stupac odredišta: iz stupca izvora (indeks) ili konstanta. */
export interface OutColumn {
  name: string
  from?: number
  constant?: string
  /** Tip stupca izvora (za kreiranje tablice i formate datoteka). */
  sourceType?: string
}

/** Mapiranje iz posla primijenjeno na stupce izvora; prazno mapiranje = svi stupci pod istim nazivima. */
export function resolveColumns(source: ResultColumn[], mapping: JobColumn[]): OutColumn[] {
  const out: OutColumn[] = mapping.length
    ? mapping.map((m) => {
        const name = m.target.trim()
        if (!name) throw new Error(t('core.jobTargetNameEmpty'))
        if (m.source === undefined) return { name, constant: m.constant ?? '' }
        let from = source.findIndex((c) => c.name === m.source)
        if (from < 0) from = source.findIndex((c) => c.name.toLowerCase() === m.source!.toLowerCase())
        if (from < 0) throw new Error(t('core.jobSourceColumnMissing', m.source))
        return { name, from, sourceType: source[from].type }
      })
    : source.map((c, i) => ({ name: c.name, from: i, sourceType: c.type }))
  const seen = new Set<string>()
  for (const c of out) {
    const key = c.name.toLowerCase()
    if (seen.has(key)) throw new Error(t('core.jobDuplicateColumn', c.name))
    seen.add(key)
  }
  if (!out.length) throw new Error(t('core.jobNoColumns'))
  return out
}

/** Redak izvora → redak odredišta. */
export function mapRow(raw: unknown[], columns: OutColumn[], sourceDialect: DbType): TransferValue[] {
  return columns.map((c) => (c.from === undefined ? (c.constant ?? null) : transferValue(raw[c.from], sourceDialect, c.sourceType)))
}

// ---------- Tipovi za novu tablicu ----------

export type ValueKind = 'bool' | 'int' | 'bigint' | 'decimal' | 'float' | 'date' | 'time' | 'datetime' | 'datetimetz' | 'uuid' | 'json' | 'binary' | 'text'

const KIND_BY_TYPE: Record<string, ValueKind> = {
  bool: 'bool', boolean: 'bool', bit: 'bool',
  tinyint: 'int', smallint: 'int', int: 'int', int2: 'int', int4: 'int', integer: 'int', mediumint: 'int', year: 'int', serial: 'int',
  int8: 'bigint', bigint: 'bigint', bigserial: 'bigint',
  decimal: 'decimal', numeric: 'decimal', money: 'decimal', smallmoney: 'decimal',
  float: 'float', float4: 'float', float8: 'float', real: 'float', double: 'float', 'double precision': 'float',
  date: 'date',
  time: 'time', timetz: 'time',
  timestamp: 'datetime', datetime: 'datetime', datetime2: 'datetime', smalldatetime: 'datetime',
  timestamptz: 'datetimetz', datetimeoffset: 'datetimetz',
  uuid: 'uuid', uniqueidentifier: 'uuid',
  json: 'json', jsonb: 'json',
  bytea: 'binary', binary: 'binary', varbinary: 'binary', image: 'binary', longblob: 'binary', mediumblob: 'binary', tinyblob: 'binary'
}

/**
 * Vrsta vrijednosti stupca prema tipu izvora; kad tip ne kaže dovoljno (MariaDB 'blob' je i TEXT,
 * izraz bez tipa), odlučuju vrijednosti iz prvog paketa.
 */
export function kindOf(type: string | undefined, sample: TransferValue[]): ValueKind {
  const known = KIND_BY_TYPE[baseType(type)]
  if (known) return known
  const v = sample.find((x) => x !== null)
  if (v === undefined) return 'text'
  if (v instanceof Uint8Array) return 'binary'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? (Math.abs(v) < 2 ** 31 ? 'int' : 'bigint') : 'float'
  return 'text'
}

const TYPES: Record<ValueKind, Record<DbType, string>> = {
  bool: { mssql: 'bit', postgres: 'boolean', mariadb: 'tinyint(1)' },
  int: { mssql: 'int', postgres: 'integer', mariadb: 'int' },
  bigint: { mssql: 'bigint', postgres: 'bigint', mariadb: 'bigint' },
  decimal: { mssql: 'decimal(38,10)', postgres: 'numeric', mariadb: 'decimal(38,10)' },
  float: { mssql: 'float', postgres: 'double precision', mariadb: 'double' },
  date: { mssql: 'date', postgres: 'date', mariadb: 'date' },
  time: { mssql: 'time(7)', postgres: 'time', mariadb: 'time(6)' },
  datetime: { mssql: 'datetime2(7)', postgres: 'timestamp', mariadb: 'datetime(6)' },
  datetimetz: { mssql: 'datetimeoffset(7)', postgres: 'timestamptz', mariadb: 'datetime(6)' },
  uuid: { mssql: 'uniqueidentifier', postgres: 'uuid', mariadb: 'char(36)' },
  json: { mssql: 'nvarchar(max)', postgres: 'jsonb', mariadb: 'json' },
  binary: { mssql: 'varbinary(max)', postgres: 'bytea', mariadb: 'longblob' },
  text: { mssql: 'nvarchar(max)', postgres: 'text', mariadb: 'longtext' }
}

/** Ključ (primarni ključ za upsert) ne smije biti neograničen tekst ili binarni podatak. */
const KEY_TYPES: Partial<Record<ValueKind, Partial<Record<DbType, string>>>> = {
  text: { mssql: 'nvarchar(450)', mariadb: 'varchar(255)' },
  json: { mssql: 'nvarchar(450)', mariadb: 'varchar(255)' },
  binary: { mssql: 'varbinary(900)', mariadb: 'varbinary(255)' }
}

export function columnType(kind: ValueKind, dialect: DbType, isKey = false): string {
  return (isKey && KEY_TYPES[kind]?.[dialect]) || TYPES[kind][dialect]
}

// ---------- Naredbe ----------

export type { EditTarget as TargetTable }

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** CREATE TABLE prema stupcima odredišta; s ključem (upsert) dobiva primarni ključ. */
export function createTableSql(dialect: DbType, table: EditTarget, columns: { name: string; kind: ValueKind }[], keys: string[] = []): string {
  const q = quoteIdent[dialect]
  const defs = columns.map((c) => {
    const isKey = keys.some((k) => sameName(k, c.name))
    return `  ${q(c.name)} ${columnType(c.kind, dialect, isKey)}${isKey ? ' NOT NULL' : ' NULL'}`
  })
  if (keys.length) defs.push(`  PRIMARY KEY (${keys.map(q).join(', ')})`)
  // MariaDB: starije verzije imaju latin1 kao zadani skup znakova baze, a izvor može imati bilo koji tekst.
  return `CREATE TABLE ${tableName(dialect, table)} (\n${defs.join(',\n')}\n)${dialect === 'mariadb' ? ' DEFAULT CHARSET=utf8mb4' : ''}`
}

export function deleteAllSql(dialect: DbType, table: EditTarget): string {
  return `DELETE FROM ${tableName(dialect, table)}`
}

function valuesList(dialect: DbType, rows: TransferValue[][]): string {
  return rows.map((r) => `(${r.map((v) => transferLiteral(dialect, v)).join(', ')})`).join(',\n')
}

/** Jedan INSERT s više redaka (SQL Server prima najviše 1000 redaka u VALUES). */
export function insertSql(dialect: DbType, table: EditTarget, columns: string[], rows: TransferValue[][]): string {
  const q = quoteIdent[dialect]
  return `INSERT INTO ${tableName(dialect, table)} (${columns.map(q).join(', ')}) VALUES\n${valuesList(dialect, rows)}`
}

/**
 * Dodaj ili ažuriraj po ključnim stupcima. PostgreSQL i MariaDB trebaju jedinstveni ključ (ili primarni)
 * na tim stupcima; SQL Server koristi MERGE.
 */
export function upsertSql(dialect: DbType, table: EditTarget, columns: string[], keys: string[], rows: TransferValue[][]): string {
  const q = quoteIdent[dialect]
  if (!keys.length) throw new Error(t('core.jobNoKeys'))
  const missing = keys.filter((k) => !columns.some((c) => sameName(c, k)))
  if (missing.length) throw new Error(t('core.jobKeyNotMapped', missing.join(', ')))
  const rest = columns.filter((c) => !keys.some((k) => sameName(k, c)))
  const cols = columns.map(q).join(', ')
  if (dialect === 'postgres') {
    const action = rest.length ? `DO UPDATE SET ${rest.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}` : 'DO NOTHING'
    return `${insertSql(dialect, table, columns, rows)}\nON CONFLICT (${keys.map(q).join(', ')}) ${action}`
  }
  if (dialect === 'mariadb') {
    const set = rest.length ? rest.map((c) => `${q(c)} = VALUES(${q(c)})`).join(', ') : `${q(keys[0])} = ${q(keys[0])}`
    return `${insertSql(dialect, table, columns, rows)}\nON DUPLICATE KEY UPDATE ${set}`
  }
  const on = keys.map((k) => `t.${q(k)} = s.${q(k)}`).join(' AND ')
  const update = rest.length ? `\nWHEN MATCHED THEN UPDATE SET ${rest.map((c) => `t.${q(c)} = s.${q(c)}`).join(', ')}` : ''
  return (
    `MERGE INTO ${tableName(dialect, table)} WITH (HOLDLOCK) AS t\nUSING (VALUES\n${valuesList(dialect, rows)}\n) AS s (${cols})\nON ${on}${update}` +
    `\nWHEN NOT MATCHED THEN INSERT (${cols}) VALUES (${columns.map((c) => `s.${q(c)}`).join(', ')});`
  )
}

/** Najviše redaka u jednoj naredbi. */
export function maxRowsPerStatement(dialect: DbType, batchSize: number): number {
  return Math.max(1, Math.min(batchSize, dialect === 'mssql' ? 1000 : 5000))
}
