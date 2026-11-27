import type { CellValue, GraphForeignKey, GraphTable, QueryMessage, QueryProgress, QueryResult, ResultColumn, ResultSet, ResultSetDelta } from '../shared/types.ts'
import { t } from '../shared/i18n.ts'

const MAX_BINARY_PREVIEW = 64

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0')
}

/**
 * Datum sa SQL Servera kao tekst kakav je u bazi. tedious (useUTC) vraća Date čije su UTC komponente
 * vrijednost iz baze; lokalno formatiranje bi je pomaknulo za vremensku zonu. Tip stupca određuje oblik.
 */
export function mssqlDateText(v: Date, columnType?: string): string {
  if (Number.isNaN(v.getTime())) return String(v)
  const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`
  const time = `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}.${pad(v.getUTCMilliseconds(), 3)}`
  const type = (columnType ?? '').toLowerCase().replace(/\(.*$/, '').trim()
  if (type === 'date') return date
  if (type === 'time') return time
  if (type === 'datetimeoffset') return `${date} ${time}+00:00`
  return `${date} ${time}`
}

/** Pretvara vrijednost iz drivera u nešto što se sigurno serijalizira (IPC i JSON). */
export function normalizeValue(v: unknown): CellValue {
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
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return String(v)
    // Lokalno vrijeme, bez pretvaranja u UTC — prikaz kao u bazi.
    return (
      `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ` +
      `${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}.${pad(v.getMilliseconds(), 3)}`
    )
  }
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.subarray(0, MAX_BINARY_PREVIEW)).toString('hex').toUpperCase()
    return '0x' + hex + (v.length > MAX_BINARY_PREVIEW ? `… (${v.length} B)` : '')
  }
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function buildResultSet(
  columns: ResultColumn[],
  rawRows: unknown[][],
  maxRows: number
): ResultSet {
  const total = rawRows.length
  const limit = Math.min(total, maxRows)
  const rows: CellValue[][] = new Array(limit)
  for (let i = 0; i < limit; i++) rows[i] = normalizeRow(rawRows[i])
  return { columns, rows, truncated: total > maxRows, totalRows: total }
}

function normalizeRow(src: unknown[]): CellValue[] {
  const out: CellValue[] = new Array(src.length)
  for (let j = 0; j < src.length; j++) out[j] = normalizeValue(src[j])
  return out
}

/** Koliko često (ms) i nakon koliko novih redaka collector šalje dojavu napretka. */
const PROGRESS_INTERVAL_MS = 200
const PROGRESS_ROWS = 500

/** Izvor redaka koji se može pauzirati (socket / request trenutne naredbe). */
export interface PausableSource {
  pause(): void
  resume(): void
}

/**
 * Skuplja retke koji stižu kao tok. Kad result set dosegne svoj limit (maxRows), pauzira izvor
 * i čeka resume(): 'page' podiže limit za još maxRows, 'count' ostatak samo broji.
 * Retci koje driver već parsira nakon pauze idu u mali preljev i čekaju nastavak.
 * Bez izvora (setSource) ili u count načinu ponaša se kao prije: čuva limit, ostale broji.
 */
export class ResultCollector {
  readonly sets: ResultSet[] = []
  /** Poruke izvršavanja (driveri pišu ovdje, pa ih ima i snimka pauziranog rezultata). */
  readonly messages: QueryMessage[] = []
  onProgress?: (p: QueryProgress) => void
  /** Poziva se kad collector pauzira izvor na limitu. */
  onPause?: () => void
  private current: ResultSet | null = null
  private limits: number[] = []
  private overflow: { set: number; raw: unknown[] }[] = []
  private source: PausableSource | null = null
  private pausedFlag = false
  private countOnly = false
  private stopped = false
  /** Po setu: koliko je redaka već poslano u dojavama i jesu li poslane kolone. */
  private sent: { rows: number; total: number; columns: boolean; more: boolean }[] = []
  private lastEmit = performance.now()
  private unsentRows = 0
  private readonly maxRows: number

  constructor(maxRows: number, onProgress?: (p: QueryProgress) => void) {
    this.maxRows = maxRows
    this.onProgress = onProgress
  }

  get paused(): boolean {
    return this.pausedFlag
  }

  /** Izvor trenutne naredbe; null kad naredba završi. */
  setSource(source: PausableSource | null): void {
    this.source = source
  }

  /** Počinje novi result set; vraća njegov indeks. */
  startSet(columns: ResultColumn[]): number {
    this.current = { columns, rows: [], truncated: false, totalRows: 0 }
    this.sets.push(this.current)
    this.limits.push(this.maxRows)
    this.sent.push({ rows: 0, total: 0, columns: false, more: false })
    return this.sets.length - 1
  }

  addRow(raw: unknown[]): void {
    const s = this.current
    if (!s) throw new Error('ResultCollector: row without a result set')
    s.totalRows++
    if (this.stopped) return
    const index = this.sets.length - 1
    // Nakon pauze driver još može predati retke iz već primljenog paketa.
    if (this.pausedFlag || this.overflow.length) this.overflow.push({ set: index, raw })
    else this.place(index, raw)
    // Vrijeme provjeravamo svakih 64 retka, ne za svaki redak.
    if (this.onProgress && (this.unsentRows >= PROGRESS_ROWS || (s.totalRows & 63) === 0)) {
      if (this.unsentRows >= PROGRESS_ROWS || performance.now() - this.lastEmit >= PROGRESS_INTERVAL_MS) this.flush()
    }
  }

  private place(index: number, raw: unknown[]): void {
    const s = this.sets[index]
    if (s.rows.length < this.limits[index]) {
      s.rows.push(normalizeRow(raw))
      this.unsentRows++
    } else if (this.countOnly || !this.source) {
      s.truncated = true
    } else {
      this.overflow.push({ set: index, raw })
      this.pause(index)
    }
  }

  private pause(index: number): void {
    this.pausedFlag = true
    this.sets[index].hasMore = true
    this.source?.pause()
    this.flush()
    this.onPause?.()
  }

  /** Nastavlja nakon pauze: 'page' učita još maxRows u pauziranom setu, 'count' ostatak samo broji. */
  resume(mode: 'page' | 'count'): void {
    if (!this.pausedFlag) return
    const index = this.overflow[0]?.set ?? this.sets.length - 1
    if (mode === 'count') this.countOnly = true
    else this.limits[index] += this.maxRows
    this.sets[index].hasMore = false
    this.pausedFlag = false
    const buffered = this.overflow
    this.overflow = []
    for (let i = 0; i < buffered.length; i++) {
      if (this.pausedFlag) {
        this.overflow.push(...buffered.slice(i))
        break
      }
      this.place(buffered[i].set, buffered[i].raw)
    }
    if (!this.pausedFlag) {
      this.source?.resume()
      this.flush()
    }
  }

  /** Prekid ili zatvaranje: preljev se odbacuje, izvor nastavlja da driver pročita kraj ili grešku. */
  stop(): void {
    this.stopped = true
    for (const { set } of this.overflow) this.sets[set].truncated = true
    for (const s of this.sets) {
      if (!s.hasMore) continue
      s.hasMore = false
      s.truncated = true
    }
    this.overflow = []
    const wasPaused = this.pausedFlag
    this.pausedFlag = false
    if (wasPaused) this.source?.resume()
  }

  /** Trenutni set je gotov; sljedeći redak traži novi startSet. */
  endSet(): void {
    this.current = null
  }

  /** Odmah šalje sve što još nije javljeno. */
  flush(): void {
    this.lastEmit = performance.now()
    this.unsentRows = 0
    if (!this.onProgress) return
    const deltas: ResultSetDelta[] = []
    this.sets.forEach((s, index) => {
      const sent = this.sent[index]
      const more = !!s.hasMore
      if (sent.columns && sent.rows === s.rows.length && sent.total === s.totalRows && sent.more === more) return
      deltas.push({
        index,
        columns: sent.columns ? undefined : s.columns,
        rows: s.rows.slice(sent.rows),
        totalRows: s.totalRows,
        truncated: s.truncated,
        hasMore: more || undefined
      })
      this.sent[index] = { rows: s.rows.length, total: s.totalRows, columns: true, more }
    })
    if (deltas.length) this.onProgress({ sets: deltas })
  }
}

/** Retke katalog upita (jedan redak po koloni stranog ključa) slaže u strane ključeve. */
export function groupForeignKeys(
  rows: { name: string; fs?: string | null; ft: string; fc: string; ts?: string | null; tt: string; tc: string }[]
): GraphForeignKey[] {
  const byKey = new Map<string, GraphForeignKey>()
  for (const r of rows) {
    const key = `${r.fs ?? ''}.${r.ft}.${r.name}`
    let fk = byKey.get(key)
    if (!fk) {
      fk = {
        name: r.name,
        from: { schema: r.fs ?? undefined, table: r.ft, columns: [] },
        to: { schema: r.ts ?? undefined, table: r.tt, columns: [] }
      }
      byKey.set(key, fk)
    }
    fk.from.columns.push(r.fc)
    fk.to.columns.push(r.tc)
  }
  return [...byKey.values()]
}

/** Retke katalog upita (jedan redak po koloni) slaže u tablice, redoslijedom kako stižu. */
export function groupTables(
  rows: { sch?: string | null; tbl: string; col: string; type: string; nullable: boolean | number | string; pk: boolean | number | string }[]
): GraphTable[] {
  const byKey = new Map<string, GraphTable>()
  const truthy = (v: boolean | number | string) => v === true || v === 1 || v === '1' || v === 'YES' || v === 'PRI' || v === 't'
  for (const r of rows) {
    const key = `${r.sch ?? ''}.${r.tbl}`
    let t = byKey.get(key)
    if (!t) {
      t = { schema: r.sch ?? undefined, name: r.tbl, columns: [] }
      byKey.set(key, t)
    }
    t.columns.push({ name: r.col, type: r.type, nullable: truthy(r.nullable), primaryKey: truthy(r.pk) })
  }
  return [...byKey.values()]
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { lineNumber?: number; line?: number; position?: string; code?: string }
    let msg = e.message
    if (e.lineNumber) msg += ` (${t('core.line', e.lineNumber)})`
    return msg
  }
  return String(err)
}

/** Broj redaka s riječju u trenutnom jeziku (1 redak, 2 retka, 5 redaka / 1 row, 2 rows). */
export function rows(n: number | string): string {
  return t('core.rows', n)
}

export function emptyResult(): QueryResult {
  return { resultSets: [], messages: [], durationMs: 0 }
}

export interface SqlBatch {
  text: string
  /** Linija (1-based) u originalnoj skripti na kojoj batch počinje — za točne poruke o greškama. */
  startLine: number
}

/**
 * Dijeli T-SQL skriptu po `GO` separatorima (kao SSMS).
 * Podržava `GO n` (ponavljanje) i ignorira GO unutar komentara / stringova.
 */
export function splitGoBatches(sql: string): SqlBatch[] {
  const batches: SqlBatch[] = []
  const lines = sql.split(/\r?\n/)
  let current: string[] = []
  let currentStart = 1
  let inBlockComment = false
  let inString = false

  lines.forEach((line, idx) => {
    const startedInsideLiteral = inBlockComment || inString
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      const n = line[i + 1]
      if (inBlockComment) {
        if (c === '*' && n === '/') { inBlockComment = false; i++ }
      } else if (inString) {
        if (c === "'") {
          if (n === "'") i++
          else inString = false
        }
      } else if (c === '-' && n === '-') {
        break
      } else if (c === '/' && n === '*') {
        inBlockComment = true; i++
      } else if (c === "'") {
        inString = true
      }
    }

    const m = !startedInsideLiteral && /^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i.exec(line)
    if (m) {
      const count = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1
      const text = current.join('\n')
      if (text.trim()) for (let k = 0; k < count; k++) batches.push({ text, startLine: currentStart })
      current = []
      currentStart = idx + 2
    } else {
      current.push(line)
    }
  })
  const rest = current.join('\n')
  if (rest.trim()) batches.push({ text: rest, startLine: currentStart })
  return batches
}

/** Escape identifikatora za pojedini dijalekt. */
export const quoteIdent = {
  mssql: (s: string) => '[' + s.replace(/]/g, ']]') + ']',
  postgres: (s: string) => '"' + s.replace(/"/g, '""') + '"',
  mariadb: (s: string) => '`' + s.replace(/`/g, '``') + '`'
}
