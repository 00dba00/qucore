import { join } from 'node:path'
import type { ColumnInfo, DbType, JobColumn, JobDatabaseTarget, JobDestination, ResultColumn } from '../../shared/types.ts'
import type { MetadataDriver, QuerySession } from '../driver.ts'
import { FACTORIES, type ConnectionResolver } from '../manager.ts'
import { ResultCollector, errorMessage, type PausableSource } from '../util.ts'
import { tableName } from '../edits.ts'
import {
  adaptValue,
  createTableSql,
  deleteAllSql,
  insertSql,
  kindOf,
  mapRow,
  maxRowsPerStatement,
  resolveColumns,
  upsertSql,
  type OutColumn,
  type TransferValue
} from './sql.ts'
import { expandFileName, openFileSink, uniqueFileName } from './files.ts'
import { t } from '../../shared/i18n.ts'

/** Posao s već razriješenim izvorom (konekcija, baza i SQL s uvrštenim varijablama). */
export interface JobPlan {
  name: string
  source: { connectionId: string; database?: string; sql: string }
  columns: JobColumn[]
  destination: JobDestination
  batchSize: number
}

export interface JobCounts {
  rowsRead: number
  rowsWritten: number
}

export interface JobHooks {
  onProgress?(p: JobCounts): void
  signal?: AbortSignal
  /** Vrijeme za {date}/{time} u nazivu datoteke. */
  now?: Date
}

export interface JobOutcome extends JobCounts {
  /** Opis odredišta (konekcija/baza.tablica ili putanja datoteke). */
  target: string
  /** Result setovi nakon prvog (npr. poruke procedure) se ne prenose. */
  ignoredSets: number
  createdTable: boolean
}

/** Greška posla s brojevima do trenutka greške i, ako se dao pronaći, retkom koji je pao. */
export class JobError extends Error {
  counts: JobCounts
  target: string
  cancelled: boolean
  failedRow?: Record<string, unknown>
  failedRowNumber?: number
  constructor(message: string, counts: JobCounts, target: string, extra: { cancelled?: boolean; failedRow?: Record<string, unknown>; failedRowNumber?: number } = {}) {
    super(message)
    this.counts = counts
    this.target = target
    this.cancelled = extra.cancelled ?? false
    this.failedRow = extra.failedRow
    this.failedRowNumber = extra.failedRowNumber
  }
}

/** Upis paketa nije uspio; nosi retke paketa da se može pronaći koji je kriv. */
class BatchError extends Error {
  rows: TransferValue[][]
  offset: number
  constructor(cause: unknown, rows: TransferValue[][], offset: number) {
    super(errorMessage(cause))
    this.rows = rows
    this.offset = offset
  }
}

const PROGRESS_MS = 200

/**
 * Collector koji retke ne čuva: skuplja ih u pakete i predaje odredištu. Dok se paket upisuje,
 * čitanje izvora je pauzirano (isti mehanizam kao "Max rows" u editoru), pa memorija ne raste.
 * Prenosi se samo prvi result set; ostali se broje.
 */
export class RowStream extends ResultCollector {
  columns: ResultColumn[] | null = null
  ignoredSets = 0
  rowsRead = 0
  error: unknown = null
  private inFirstSet = false
  private buffer: unknown[][] = []
  private src: PausableSource | null = null
  private chain: Promise<void> = Promise.resolve()
  private lastProgress = 0
  private readonly batch: number
  private readonly sink: (columns: ResultColumn[], rows: unknown[][]) => Promise<void>
  private readonly onFail: () => void
  private readonly onRead?: () => void

  constructor(batch: number, sink: (columns: ResultColumn[], rows: unknown[][]) => Promise<void>, onFail: () => void, onRead?: () => void) {
    super(0)
    this.batch = Math.max(1, batch)
    this.sink = sink
    this.onFail = onFail
    this.onRead = onRead
  }

  override setSource(source: PausableSource | null): void {
    super.setSource(source)
    this.src = source
  }

  override startSet(columns: ResultColumn[]): number {
    const index = super.startSet(columns)
    if (this.columns === null) {
      this.columns = columns
      this.inFirstSet = true
    } else {
      this.inFirstSet = false
      this.ignoredSets++
    }
    return index
  }

  override endSet(): void {
    super.endSet()
    this.inFirstSet = false
  }

  override addRow(raw: unknown[]): void {
    // Driveri (MariaDB) iz broja redaka seta pišu poruku; retci se ne čuvaju.
    const set = this.sets[this.sets.length - 1]
    if (set) set.totalRows++
    if (!this.inFirstSet || this.error) return
    this.rowsRead++
    this.buffer.push(raw)
    if (this.buffer.length >= this.batch) this.flushBatch()
    else if (this.onRead && (this.rowsRead & 63) === 0 && performance.now() - this.lastProgress > PROGRESS_MS) {
      this.lastProgress = performance.now()
      this.onRead()
    }
  }

  private flushBatch(): void {
    const rows = this.buffer
    this.buffer = []
    const src = this.src
    src?.pause()
    this.chain = this.chain
      .then(() => (this.error ? undefined : this.sink(this.columns!, rows)))
      .then(
        // Uvijek nastavi: i nakon greške ili prekida driver mora pročitati odgovor servera do kraja,
        // inače čeka zauvijek (retci nakon greške se ionako odbacuju u addRow).
        () => src?.resume(),
        (e) => {
          this.error ??= e
          src?.resume()
          this.onFail()
        }
      )
  }

  /** Nakon kraja upita: upiši ostatak i pričekaj sve pakete. */
  async drain(): Promise<void> {
    if (this.buffer.length && !this.error) this.flushBatch()
    await this.chain
    if (this.error) throw this.error
  }
}

/** Izvršava SQL na sesiji odredišta; greška iz rezultata postaje iznimka. */
async function exec(session: QuerySession, sql: string): Promise<void> {
  const r = await session.execute(sql, new ResultCollector(0))
  if (r.error) throw new Error(r.error)
}

interface Writer {
  readonly target: string
  readonly createdTable: boolean
  rowsWritten: number
  write(rows: TransferValue[][], offset: number): Promise<void>
  finish(): Promise<string>
  abort(): Promise<void>
  /** Nakon greške paketa: izvodi retke jedan po jedan u transakciji koja se uvijek poništava. */
  locate?(rows: TransferValue[][]): Promise<number | undefined>
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Opis odredišta za log: "Konekcija / baza.shema.tablica". */
function describeTable(connectionName: string, d: JobDatabaseTarget): string {
  return `${connectionName} / ${[d.database, d.schema, d.table].filter(Boolean).join('.')}`
}

async function findTable(meta: MetadataDriver, d: JobDatabaseTarget, dialect: DbType): Promise<{ columns: ColumnInfo[] } | null> {
  const schema = d.schema || (dialect === 'mssql' ? 'dbo' : dialect === 'postgres' ? 'public' : undefined)
  const objects = await meta.listObjects(d.database)
  const obj =
    objects.find((o) => o.kind === 'table' && o.name === d.table && (!schema || o.schema === schema)) ??
    objects.find((o) => o.kind === 'table' && sameName(o.name, d.table) && (!schema || sameName(o.schema ?? '', schema)))
  if (!obj) return null
  const children = await meta.listChildren(d.database, obj)
  return { columns: children.filter((c): c is { type: 'column' } & ColumnInfo => c.type === 'column') }
}

async function openDbWriter(d: JobDatabaseTarget, columns: OutColumn[], first: TransferValue[][], resolver: ConnectionResolver): Promise<Writer> {
  const config = await resolver.resolve(d.connectionId)
  const dialect = config.type
  const target = describeTable(config.name, d)
  const table = { database: d.database, schema: d.schema || undefined, table: d.table }
  const names = columns.map((c) => c.name)
  if (d.mode === 'upsert') {
    if (!d.keyColumns.length) throw new Error(t('core.jobNoKeys'))
    const missing = d.keyColumns.filter((k) => !names.some((n) => sameName(n, k)))
    if (missing.length) throw new Error(t('core.jobKeyNotMapped', missing.join(', ')))
  }

  const meta = FACTORIES[dialect].metadata(config)
  let existing: { columns: ColumnInfo[] } | null
  try {
    await meta.connect()
    existing = await findTable(meta, d, dialect)
  } finally {
    await meta.close()
  }

  const session = FACTORIES[dialect].session(config, d.database)
  await session.open()
  let createdTable = false
  let identityOn = false
  let inTx = false
  try {
    // Tekst datuma uvijek godina-mjesec-dan, bez obzira na jezik prijave na SQL Serveru.
    if (dialect === 'mssql') await exec(session, 'SET DATEFORMAT ymd')
    if (!existing) {
      if (!d.createTable) throw new Error(t('core.jobTableMissing', target))
      const kinds = columns.map((c, i) => ({ name: c.name, kind: kindOf(c.sourceType, first.map((r) => r[i])) }))
      // Prije transakcije: MariaDB DDL ionako odmah potvrđuje.
      await exec(session, createTableSql(dialect, table, kinds, d.mode === 'upsert' ? d.keyColumns : []))
      createdTable = true
    } else {
      const missing = names.filter((n) => !existing!.columns.some((c) => sameName(c.name, n)))
      if (missing.length) throw new Error(t('core.jobTargetColumnMissing', missing.join(', '), target))
    }
    const targetTypes = names.map((n) => existing?.columns.find((c) => sameName(c.name, n))?.dataType)
    // SQL Server: eksplicitne vrijednosti identity stupca traže IDENTITY_INSERT.
    const needsIdentity = dialect === 'mssql' && !!existing?.columns.some((c) => c.identity && names.some((n) => sameName(n, c.name)))
    if (needsIdentity) {
      await exec(session, `SET IDENTITY_INSERT ${tableName(dialect, table)} ON`)
      identityOn = true
    }

    const statement = (rows: TransferValue[][]) => {
      const adapted = rows.map((r) => r.map((v, i) => adaptValue(v, dialect, targetTypes[i])))
      return d.mode === 'upsert' ? upsertSql(dialect, table, names, d.keyColumns, adapted) : insertSql(dialect, table, names, adapted)
    }
    const perStatement = maxRowsPerStatement(dialect, Number.MAX_SAFE_INTEGER)

    if (d.transaction === 'all') {
      await session.transaction('begin')
      inTx = true
    }
    if (d.mode === 'replace') await exec(session, deleteAllSql(dialect, table))

    const finishSession = async (commit: boolean) => {
      if (inTx) {
        inTx = false
        await session.transaction(commit ? 'commit' : 'rollback')
      }
      if (identityOn) {
        identityOn = false
        await exec(session, `SET IDENTITY_INSERT ${tableName(dialect, table)} OFF`).catch(() => {})
      }
    }

    const writer: Writer = {
      target,
      createdTable,
      rowsWritten: 0,
      async write(rows, offset) {
        for (let i = 0; i < rows.length; i += perStatement) {
          const part = rows.slice(i, i + perStatement)
          try {
            await exec(session, statement(part))
          } catch (e) {
            throw new BatchError(e, part, offset + i)
          }
          writer.rowsWritten += part.length
        }
      },
      async finish() {
        await finishSession(true)
        await session.close()
        return target
      },
      async abort() {
        await finishSession(false).catch(() => {})
        await session.close().catch(() => {})
      },
      async locate(rows) {
        // Nova sesija: glavna je možda u prekinutoj transakciji ili već zatvorena.
        const probe = FACTORIES[dialect].session(config, d.database)
        await probe.open()
        try {
          if (dialect === 'mssql') await exec(probe, 'SET DATEFORMAT ymd')
          if (needsIdentity) await exec(probe, `SET IDENTITY_INSERT ${tableName(dialect, table)} ON`)
          await probe.transaction('begin')
          if (d.mode === 'replace') await exec(probe, deleteAllSql(dialect, table))
          for (let i = 0; i < rows.length; i++) {
            try {
              await exec(probe, statement([rows[i]]))
            } catch {
              return i
            }
          }
          return undefined
        } finally {
          await probe.transaction('rollback').catch(() => {})
          await probe.close().catch(() => {})
        }
      }
    }
    return writer
  } catch (e) {
    if (inTx) await session.transaction('rollback').catch(() => {})
    await session.close().catch(() => {})
    throw e
  }
}

function openFileWriter(d: Extract<JobDestination, { kind: 'file' }>, columns: OutColumn[], jobName: string, now: Date): Writer {
  const name = expandFileName(d.fileName, jobName, now, d.format)
  const fileName = d.ifExists === 'new' ? uniqueFileName(d.folder, name) : name
  const path = join(d.folder, fileName)
  const sink = openFileSink(d, columns, path)
  const writer: Writer = {
    target: path,
    createdTable: false,
    rowsWritten: 0,
    async write(rows) {
      await sink.write(rows)
      writer.rowsWritten += rows.length
    },
    finish: () => sink.finish(),
    abort: () => sink.abort()
  }
  return writer
}

/** Prijenos: izvor kao tok → mapiranje stupaca → paketi u odredište. */
export async function runDataJob(plan: JobPlan, resolver: ConnectionResolver, hooks: JobHooks = {}): Promise<JobOutcome> {
  const srcConfig = await resolver.resolve(plan.source.connectionId)
  const srcDialect = srcConfig.type
  const session = FACTORIES[srcDialect].session(srcConfig, plan.source.database)
  let writer: Writer | null = null
  let outColumns: OutColumn[] | null = null
  let rowsBefore = 0
  let cancelled = false
  const counts = (): JobCounts => ({ rowsRead: stream.rowsRead, rowsWritten: writer?.rowsWritten ?? 0 })
  const report = () => hooks.onProgress?.(counts())

  const open = async (first: TransferValue[][]): Promise<Writer> => {
    const d = plan.destination
    return d.kind === 'database' ? openDbWriter(d, outColumns!, first, resolver) : openFileWriter(d, outColumns!, plan.name, hooks.now ?? new Date())
  }

  const stream: RowStream = new RowStream(
    plan.batchSize,
    async (columns, raw) => {
      outColumns ??= resolveColumns(columns, plan.columns)
      const rows = raw.map((r) => mapRow(r, outColumns!, srcDialect))
      writer ??= await open(rows)
      const offset = rowsBefore
      rowsBefore += rows.length
      await writer.write(rows, offset)
      report()
    },
    () => void session.cancel().catch(() => {}),
    report
  )

  const onAbort = () => {
    cancelled = true
    stream.error ??= new Error(t('core.jobCancelled'))
    void session.cancel().catch(() => {})
  }
  if (hooks.signal?.aborted) throw new JobError(t('core.jobCancelled'), { rowsRead: 0, rowsWritten: 0 }, '', { cancelled: true })
  hooks.signal?.addEventListener('abort', onAbort)

  try {
    await session.open()
    const result = await session.execute(plan.source.sql, stream)
    if (result.error && !stream.error) throw new Error(t('core.jobSourceFailed', result.error))
    await stream.drain()
    // PostgreSQL za rezultat bez redaka ne javlja zaglavlje kroz collector, nego tek u rezultatu.
    const columns = stream.columns ?? result.resultSets[0]?.columns
    if (!columns) throw new Error(t('core.jobNoResultSet'))
    // Izvor bez redaka: i dalje se kreira tablica / zapisuje prazna datoteka sa zaglavljem.
    outColumns ??= resolveColumns(columns, plan.columns)
    writer ??= await open([])
    const target = await writer.finish()
    report()
    return { ...counts(), target, ignoredSets: stream.ignoredSets, createdTable: writer.createdTable }
  } catch (e) {
    const err = stream.error ?? e
    await writer?.abort()
    let extra: { cancelled?: boolean; failedRow?: Record<string, unknown>; failedRowNumber?: number } = { cancelled }
    let message = cancelled ? t('core.jobCancelled') : errorMessage(err)
    if (!cancelled && err instanceof BatchError) {
      const i = writer?.locate && err.rows.length > 1 ? await writer.locate(err.rows).catch(() => undefined) : err.rows.length === 1 ? 0 : undefined
      if (i !== undefined) {
        extra = { failedRowNumber: err.offset + i + 1, failedRow: rowObject(outColumns!, err.rows[i]) }
        message = t('core.jobRowFailed', err.offset + i + 1, err.message)
      } else {
        message = t('core.jobBatchFailed', err.offset + 1, err.offset + err.rows.length, err.message)
      }
    }
    throw new JobError(message, counts(), writer?.target ?? '', extra)
  } finally {
    hooks.signal?.removeEventListener('abort', onAbort)
    await session.close().catch(() => {})
  }
}

/** Redak kao objekt za log (binarni podaci skraćeni). */
function rowObject(columns: OutColumn[], row: TransferValue[]): Record<string, unknown> {
  return Object.fromEntries(
    columns.map((c, i) => {
      const v = row[i]
      if (!(v instanceof Uint8Array)) return [c.name, v]
      const hex = Buffer.from(v.buffer, v.byteOffset, v.byteLength).subarray(0, 32).toString('hex').toUpperCase()
      return [c.name, `0x${hex}${v.byteLength > 32 ? `… (${v.byteLength} B)` : ''}`]
    })
  )
}

/** Stupci izvora: upit se izvodi samo dok ne stigne zaglavlje prvog result seta, pa se prekida. */
export async function probeColumns(source: JobPlan['source'], resolver: ConnectionResolver): Promise<ResultColumn[]> {
  const config = await resolver.resolve(source.connectionId)
  const session = FACTORIES[config.type].session(config, source.database)
  let columns: ResultColumn[] | null = null
  const collector = new (class extends ResultCollector {
    override startSet(c: ResultColumn[]): number {
      const i = super.startSet(c)
      if (!columns) {
        columns = c
        void session.cancel().catch(() => {})
      }
      return i
    }
    override addRow(): void {
      const set = this.sets[this.sets.length - 1]
      if (set) set.totalRows++
    }
  })(0)
  try {
    await session.open()
    const r = await session.execute(source.sql, collector)
    // PostgreSQL: zaglavlje rezultata bez redaka stiže tek u rezultatu.
    const found = columns ?? r.resultSets[0]?.columns
    if (!found && r.error) throw new Error(r.error)
    if (!found) throw new Error(t('core.jobNoResultSet'))
    return found
  } finally {
    await session.close().catch(() => {})
  }
}
