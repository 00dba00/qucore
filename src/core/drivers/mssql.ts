import { execFile } from 'node:child_process'
import sql from 'mssql'
import type {
  ChildInfo,
  ConnectionConfig,
  DbObject,
  EditStatement,
  ObjectKind,
  QueryMessage,
  QueryResult,
  SchemaGraph,
  TableDetails,
  QueryPlan,
  TxAction,
  TxState
} from '../../shared/types.ts'
import type { DriverFactory, MetadataDriver, QuerySession } from '../driver.ts'
import { errorMessage, groupForeignKeys, groupTables, quoteIdent, splitGoBatches, type ResultCollector } from '../util.ts'
import { assertOneRow } from '../edits.ts'
import { mssqlPlan } from '../plan.ts'
import { groupForeignKeyRows, groupIndexes, type FkColumnRow, type IndexColumnRow } from '../tableDetails.ts'
import { t } from '../../shared/i18n.ts'

const q = quoteIdent.mssql

/** mssql modul: tedious (SQL login, NTLM) ili msnodesqlv8 (Windows prijava preko ODBC-a). Isti API. */
type Mssql = typeof sql

let v8Module: Promise<Mssql> | null = null
/** Naziv kao varijabla: msnodesqlv8 postoji samo na Windowsu, pa typecheck ne smije ovisiti o njegovim tipovima. */
const MSNODESQLV8 = 'msnodesqlv8'

function loadModule(c: ConnectionConfig): Promise<Mssql> {
  if (c.mssqlAuth !== 'windows') return Promise.resolve(sql)
  if (process.platform !== 'win32') return Promise.reject(new Error(t('core.winAuthWindowsOnly')))
  v8Module ??= Promise.all([import(/* @vite-ignore */ MSNODESQLV8), import('mssql/msnodesqlv8.js')])
    .then(([raw, m]) => {
      preferRealOdbcError((raw as { default?: unknown }).default ?? raw)
      return ((m as { default?: Mssql }).default ?? m) as Mssql
    })
    .catch((e) => {
      v8Module = null
      throw new Error(t('core.winAuthDriverFailed', errorMessage(e)))
    })
  return v8Module
}

interface OdbcDetail {
  sqlState?: string
}
type OpenCallback = (err: (Error & { details?: OdbcDetail[] }) | null, conn: unknown) => void

/**
 * mssql za poruku greške spajanja uzima zadnji ODBC zapis, a to je često samo informacija
 * (SQLSTATE 01xxx, npr. 'ConnectionOpen (Connect()).'). Prava greška se pomiče na kraj.
 */
function preferRealOdbcError(driver: unknown): void {
  const d = driver as { open: (cfg: unknown, cb: OpenCallback) => unknown; __qucorePatched?: boolean }
  if (d.__qucorePatched) return
  const open = d.open.bind(d)
  d.open = (cfg, cb) =>
    open(cfg, (err, conn) => {
      const details = err?.details
      if (details?.length) {
        const real = details.filter((x) => !x.sqlState?.startsWith('01'))
        if (real.length) err!.details = [...details.filter((x) => x.sqlState?.startsWith('01')), ...real.reverse()]
      }
      cb(err, conn)
    })
  d.__qucorePatched = true
}

/** ODBC driveri za SQL Server, od najboljeg; 'SQL Server' je stari driver koji dolazi s Windowsom. */
const ODBC_DRIVERS = ['ODBC Driver 18 for SQL Server', 'ODBC Driver 17 for SQL Server', 'SQL Server Native Client 11.0', 'SQL Server']

let odbcDriver: Promise<string> | null = null

function detectOdbcDriver(): Promise<string> {
  odbcDriver ??= new Promise<string>((resolve, reject) => {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers'], { windowsHide: true }, (err, stdout) => {
      const installed = new Set(
        err ? [] : stdout.split(/\r?\n/).map((l) => /^\s+(.+?)\s+REG_SZ\s+Installed\s*$/i.exec(l)?.[1]).filter((x): x is string => !!x)
      )
      const found = ODBC_DRIVERS.find((d) => installed.has(d))
      if (found) resolve(found)
      else reject(new Error(t('core.odbcMissing')))
    })
  }).catch((e) => {
    odbcDriver = null
    throw e
  })
  return odbcDriver
}

/** Vrijednost u ODBC connection stringu: u vitičastim zagradama, '}' udvostručen. */
const odbcValue = (v: string) => '{' + v.replace(/}/g, '}}') + '}'

/** ODBC poruke počinju s [Microsoft][ODBC Driver 18 for SQL Server][SQL Server]; to se ne prikazuje. */
const cleanOdbc = (e: unknown): Error => {
  if (!(e instanceof Error)) return new Error(errorMessage(e))
  e.message = e.message.replace(/^(\[[^\]]*\])+\s*/, '')
  return e
}

/** NTLM: domena iz posebnog polja ili iz korisnika upisanog kao DOMENA\korisnik. */
function ntlmIdentity(c: ConnectionConfig): { domain: string; userName: string } {
  const slash = c.user.indexOf('\\')
  if (!c.domain?.trim() && slash > 0) return { domain: c.user.slice(0, slash), userName: c.user.slice(slash + 1) }
  return { domain: c.domain?.trim() ?? '', userName: c.user }
}

async function poolConfig(c: ConnectionConfig, database: string | undefined, max: number, requestTimeout: number): Promise<sql.config> {
  const db = database || c.database || 'master'
  const base = {
    server: c.host,
    port: c.port,
    database: db,
    connectionTimeout: 15000,
    requestTimeout,
    pool: { min: max === 1 ? 1 : 0, max, idleTimeoutMillis: 600000 }
  }
  const encrypt = c.encrypt ?? true
  const trust = c.trustServerCertificate ?? true

  if (c.mssqlAuth === 'windows') {
    // Imenovana instanca (host\INSTANCA) ide preko SQL Browsera, bez porta.
    const server = c.host.includes('\\') ? c.host : `${c.host},${c.port}`
    const driver = await detectOdbcDriver()
    const connectionString = [
      `Driver=${odbcValue(driver)}`,
      `Server=${odbcValue(server)}`,
      `Database=${odbcValue(db)}`,
      'Trusted_Connection=yes',
      `Encrypt=${encrypt ? 'yes' : 'no'}`,
      // Stari driver 'SQL Server' ne zna TrustServerCertificate: upozorenje 01S00 bi mssql prikazao
      // umjesto prave greške spajanja.
      ...(driver === 'SQL Server' ? [] : [`TrustServerCertificate=${trust ? 'yes' : 'no'}`]),
      'APP=QuCore'
    ].join(';')
    return { ...base, connectionString, options: { useUTC: true } } as sql.config
  }

  const options = { encrypt, trustServerCertificate: trust, appName: 'QuCore', enableArithAbort: true }
  if (c.mssqlAuth === 'ntlm') {
    return {
      ...base,
      authentication: { type: 'ntlm', options: { ...ntlmIdentity(c), password: c.password ?? '' } },
      options
    }
  }
  return { ...base, user: c.user, password: c.password, options }
}

/** Pool s modulom koji odgovara načinu prijave. */
async function createPool(c: ConnectionConfig, database: string | undefined, max: number, requestTimeout: number) {
  const m = await loadModule(c)
  const pool = new m.ConnectionPool(await poolConfig(c, database, max, requestTimeout))
  pool.on('error', () => {})
  return { m, pool }
}

/** Lijepi prikaz SQL Server tipa: nvarchar(50), decimal(18,2), varchar(MAX)… */
function formatType(name: string, maxLength: number, precision: number, scale: number): string {
  const n = name.toLowerCase()
  if (['varchar', 'char', 'varbinary', 'binary'].includes(n)) return `${name}(${maxLength === -1 ? 'MAX' : maxLength})`
  if (['nvarchar', 'nchar'].includes(n)) return `${name}(${maxLength === -1 ? 'MAX' : maxLength / 2})`
  if (['decimal', 'numeric'].includes(n)) return `${name}(${precision},${scale})`
  if (['datetime2', 'time', 'datetimeoffset'].includes(n)) return `${name}(${scale})`
  return name
}

const TYPE_TO_KIND: Record<string, ObjectKind> = {
  U: 'table', V: 'view', P: 'procedure', FN: 'function', IF: 'function', TF: 'function', TR: 'trigger'
}

class MssqlMetadata implements MetadataDriver {
  private ready: Promise<{ m: Mssql; pool: sql.ConnectionPool }> | null = null
  private config: ConnectionConfig
  constructor(config: ConnectionConfig) {
    this.config = config
  }

  /** Pool se stvara pri prvom spajanju (modul i ODBC driver se biraju asinkrono); neuspjeh se ponavlja idući put. */
  private conn() {
    this.ready ??= createPool(this.config, undefined, 4, 60000).then(
      async (p) => {
        await p.pool.connect()
        return p
      }
    ).catch((e) => {
      this.ready = null
      throw cleanOdbc(e)
    })
    return this.ready
  }

  async connect(): Promise<void> {
    await this.conn()
  }
  async close(): Promise<void> {
    const r = this.ready
    this.ready = null
    if (r) await r.then((p) => p.pool.close()).catch(() => {})
  }

  private async query<T>(text: string, params: Record<string, string> = {}): Promise<T[]> {
    const { m, pool } = await this.conn()
    const req = pool.request()
    for (const [k, v] of Object.entries(params)) req.input(k, m.NVarChar, v)
    const r = await req.query<T>(text).catch((e) => Promise.reject(cleanOdbc(e)))
    return r.recordset
  }

  async serverVersion(): Promise<string> {
    const r = await this.query<{ v: string }>(`SELECT @@VERSION AS v`)
    return r[0].v.split('\n')[0].trim()
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.query<{ name: string }>(
      `SELECT name FROM sys.databases
       WHERE state = 0 AND HAS_DBACCESS(name) = 1
       ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name`
    )
    return r.map((x) => x.name)
  }

  async databaseSizes(): Promise<Record<string, number>> {
    // Veličina datoteka (data + log), u stranicama od 8 KB.
    const r = await this.query<{ name: string; bytes: string | number }>(
      `SELECT DB_NAME(database_id) AS name, SUM(CAST(size AS bigint)) * 8192 AS bytes
       FROM sys.master_files GROUP BY database_id`
    )
    return Object.fromEntries(r.filter((x) => x.name).map((x) => [x.name, Number(x.bytes)]))
  }

  async applyEdits(_database: string, statements: EditStatement[]): Promise<number> {
    // Naredbe koriste puni naziv [baza].[shema].[tablica], pa baza konekcije nije bitna.
    const { m, pool } = await this.conn()
    const tx = new m.Transaction(pool)
    await tx.begin()
    let total = 0
    try {
      for (const [i, st] of statements.entries()) {
        const req = new m.Request(tx)
        st.params.forEach((v, k) => req.input(`p${k + 1}`, v))
        const r = await req.query(st.sql)
        // rowsAffected[0] je sama naredba; triggeri mogu dodati svoje brojeve iza.
        const n = r.rowsAffected[0] ?? 0
        if (st.expectOneRow) assertOneRow(i, n)
        total += n
      }
      await tx.commit()
      return total
    } catch (err) {
      await tx.rollback().catch(() => {})
      throw err
    }
  }

  async listObjects(database: string): Promise<DbObject[]> {
    const db = q(database)
    const rows = await this.query<{ schema_name: string; name: string; type: string; parent: string | null; bytes: string | number | null }>(
      `SELECT s.name AS schema_name, o.name, RTRIM(o.type) AS type,
              CASE WHEN o.type = 'TR' THEN OBJECT_NAME(o.parent_object_id, DB_ID(@db)) END AS parent,
              sz.bytes
       FROM ${db}.sys.objects o
       JOIN ${db}.sys.schemas s ON s.schema_id = o.schema_id
       LEFT JOIN (
         SELECT p.object_id, SUM(CAST(a.total_pages AS bigint)) * 8192 AS bytes
         FROM ${db}.sys.partitions p
         JOIN ${db}.sys.allocation_units a ON a.container_id = p.partition_id
         GROUP BY p.object_id
       ) sz ON sz.object_id = o.object_id AND o.type = 'U'
       WHERE o.is_ms_shipped = 0 AND o.type IN ('U','V','P','FN','IF','TF','TR')
       ORDER BY s.name, o.name`,
      { db: database }
    )
    return rows.map((r) => {
      const kind = TYPE_TO_KIND[r.type]
      return {
        kind,
        schema: r.schema_name,
        name: r.name,
        parent: r.parent ?? undefined,
        expandable: kind !== 'trigger',
        sizeBytes: r.bytes !== null ? Number(r.bytes) : undefined
      }
    })
  }

  private fullName(database: string, obj: DbObject): string {
    return `${q(database)}.${q(obj.schema ?? 'dbo')}.${q(obj.name)}`
  }

  async schemaGraph(database: string): Promise<SchemaGraph> {
    const db = q(database)
    const [cols, fks] = await Promise.all([
      this.query<{ sch: string; tbl: string; col: string; type_name: string; max_length: number; precision: number; scale: number; nullable: boolean; pk: boolean }>(
        `SELECT s.name AS sch, t.name AS tbl, c.name AS col, ty.name AS type_name, c.max_length, c.precision, c.scale,
                c.is_nullable AS nullable,
                CAST(CASE WHEN ic.column_id IS NULL THEN 0 ELSE 1 END AS bit) AS pk
         FROM ${db}.sys.tables t
         JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
         JOIN ${db}.sys.columns c ON c.object_id = t.object_id
         JOIN ${db}.sys.types ty ON ty.user_type_id = c.user_type_id
         LEFT JOIN ${db}.sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
         LEFT JOIN ${db}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.column_id = c.column_id
         WHERE t.is_ms_shipped = 0
         ORDER BY s.name, t.name, c.column_id`
      ),
      this.query<{ name: string; fs: string; ft: string; fc: string; ts: string; tt: string; tc: string }>(
        `SELECT fk.name, ps.name AS fs, pt.name AS ft, pc.name AS fc, rs.name AS ts, rt.name AS tt, rc.name AS tc
         FROM ${db}.sys.foreign_key_columns fkc
         JOIN ${db}.sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
         JOIN ${db}.sys.tables pt ON pt.object_id = fkc.parent_object_id
         JOIN ${db}.sys.schemas ps ON ps.schema_id = pt.schema_id
         JOIN ${db}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN ${db}.sys.tables rt ON rt.object_id = fkc.referenced_object_id
         JOIN ${db}.sys.schemas rs ON rs.schema_id = rt.schema_id
         JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
         ORDER BY ps.name, pt.name, fk.name, fkc.constraint_column_id`
      )
    ])
    return {
      tables: groupTables(cols.map((c) => ({ ...c, type: formatType(c.type_name, c.max_length, c.precision, c.scale) }))),
      foreignKeys: groupForeignKeys(fks)
    }
  }

  async listChildren(database: string, obj: DbObject): Promise<ChildInfo[]> {
    const db = q(database)
    const full = this.fullName(database, obj)
    if (obj.kind === 'table' || obj.kind === 'view') {
      const rows = await this.query<{
        name: string; type_name: string; max_length: number; precision: number; scale: number
        is_nullable: boolean; is_identity: boolean; pk: boolean; def: string | null
      }>(
        `SELECT c.name, t.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
                CAST(CASE WHEN EXISTS (
                  SELECT 1 FROM ${db}.sys.index_columns ic
                  JOIN ${db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                  WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
                ) THEN 1 ELSE 0 END AS bit) AS pk,
                dc.definition AS def
         FROM ${db}.sys.columns c
         JOIN ${db}.sys.types t ON t.user_type_id = c.user_type_id
         LEFT JOIN ${db}.sys.default_constraints dc ON dc.object_id = c.default_object_id
         WHERE c.object_id = OBJECT_ID(@full)
         ORDER BY c.column_id`,
        { full }
      )
      return rows.map((r) => ({
        type: 'column',
        name: r.name,
        dataType: formatType(r.type_name, r.max_length, r.precision, r.scale),
        nullable: r.is_nullable,
        primaryKey: r.pk,
        identity: r.is_identity,
        defaultValue: r.def
      }))
    }
    if (obj.kind === 'procedure' || obj.kind === 'function') {
      const rows = await this.query<{
        name: string; type_name: string; max_length: number; precision: number; scale: number
        is_output: boolean; parameter_id: number
      }>(
        `SELECT p.name, t.name AS type_name, p.max_length, p.precision, p.scale, p.is_output, p.parameter_id
         FROM ${db}.sys.parameters p
         JOIN ${db}.sys.types t ON t.user_type_id = p.user_type_id
         WHERE p.object_id = OBJECT_ID(@full)
         ORDER BY CASE WHEN p.parameter_id = 0 THEN 1 ELSE 0 END, p.parameter_id`,
        { full }
      )
      return rows.map((r) => ({
        type: 'parameter',
        name: r.parameter_id === 0 ? 'RETURNS' : r.name,
        dataType: formatType(r.type_name, r.max_length, r.precision, r.scale),
        mode: r.parameter_id === 0 ? 'RETURN' : r.is_output ? 'OUT' : 'IN'
      }))
    }
    return []
  }

  async tableDetails(database: string, obj: DbObject): Promise<TableDetails> {
    const full = this.fullName(database, obj)
    const db = q(database)
    const [idx, fks] = await Promise.all([
      this.query<IndexColumnRow>(
        `SELECT i.name AS name, c.name AS [column], i.is_unique AS [unique], i.is_primary_key AS [primary],
                i.type_desc AS type, ic.is_included_column AS included
         FROM ${db}.sys.indexes i
         JOIN ${db}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN ${db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.object_id = OBJECT_ID(@full) AND i.name IS NOT NULL
         ORDER BY i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id`,
        { full }
      ),
      this.query<FkColumnRow & { outgoing: number; incoming: number }>(
        `SELECT fk.name AS name, fs.name AS fromSchema, ft.name AS fromTable, fc.name AS fromColumn,
                ts.name AS toSchema, tt.name AS toTable, tc.name AS toColumn,
                CASE WHEN fk.parent_object_id = OBJECT_ID(@full) THEN 1 ELSE 0 END AS outgoing,
                CASE WHEN fk.referenced_object_id = OBJECT_ID(@full) THEN 1 ELSE 0 END AS incoming
         FROM ${db}.sys.foreign_keys fk
         JOIN ${db}.sys.foreign_key_columns k ON k.constraint_object_id = fk.object_id
         JOIN ${db}.sys.tables ft ON ft.object_id = fk.parent_object_id
         JOIN ${db}.sys.schemas fs ON fs.schema_id = ft.schema_id
         JOIN ${db}.sys.columns fc ON fc.object_id = k.parent_object_id AND fc.column_id = k.parent_column_id
         JOIN ${db}.sys.tables tt ON tt.object_id = fk.referenced_object_id
         JOIN ${db}.sys.schemas ts ON ts.schema_id = tt.schema_id
         JOIN ${db}.sys.columns tc ON tc.object_id = k.referenced_object_id AND tc.column_id = k.referenced_column_id
         WHERE fk.parent_object_id = OBJECT_ID(@full) OR fk.referenced_object_id = OBJECT_ID(@full)
         ORDER BY ft.name, fk.name, k.constraint_column_id`,
        { full }
      )
    ])
    return {
      indexes: groupIndexes(idx),
      foreignKeys: groupForeignKeyRows(fks.filter((r) => r.outgoing)),
      referencedBy: groupForeignKeyRows(fks.filter((r) => r.incoming))
    }
  }

  async getDefinition(database: string, obj: DbObject): Promise<string> {
    const full = this.fullName(database, obj)
    if (obj.kind === 'table') return this.tableDdl(database, obj)
    const rows = await this.query<{ definition: string | null }>(
      `SELECT m.definition FROM ${q(database)}.sys.sql_modules m WHERE m.object_id = OBJECT_ID(@full)`,
      { full }
    )
    const def = rows[0]?.definition
    if (def == null) return t('core.defUnavailableMssql')
    return def.trim() + '\nGO\n'
  }

  private async tableDdl(database: string, obj: DbObject): Promise<string> {
    const cols = (await this.listChildren(database, obj)) as (ChildInfo & { type: 'column' })[]
    const pk = await this.query<{ name: string; col: string }>(
      `SELECT kc.name, c.name AS col
       FROM ${q(database)}.sys.key_constraints kc
       JOIN ${q(database)}.sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
       JOIN ${q(database)}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE kc.type = 'PK' AND kc.parent_object_id = OBJECT_ID(@full)
       ORDER BY ic.key_ordinal`,
      { full: this.fullName(database, obj) }
    )
    const lines = cols.map((c) => {
      let l = `    ${q(c.name)} ${c.dataType}`
      if (c.identity) l += ' IDENTITY(1,1)'
      l += c.nullable ? ' NULL' : ' NOT NULL'
      if (c.defaultValue) l += ` DEFAULT ${c.defaultValue}`
      return l
    })
    if (pk.length) lines.push(`    CONSTRAINT ${q(pk[0].name)} PRIMARY KEY (${pk.map((p) => q(p.col)).join(', ')})`)
    return `CREATE TABLE ${q(obj.schema ?? 'dbo')}.${q(obj.name)} (\n${lines.join(',\n')}\n);\nGO\n`
  }
}

class MssqlSession implements QuerySession {
  private pool: sql.ConnectionPool | null = null
  private current: sql.Request | null = null
  private cancelled = false
  private messages: QueryMessage[] = []
  private config: ConnectionConfig
  private database?: string

  constructor(config: ConnectionConfig, database?: string) {
    this.config = config
    this.database = database
  }

  async open(): Promise<void> {
    // Jedna konekcija (min = max = 1) → stanje sesije ostaje između izvršavanja.
    const { pool } = await createPool(this.config, this.database, 1, 0).catch((e) => Promise.reject(cleanOdbc(e)))
    await pool.connect().catch((e) => Promise.reject(cleanOdbc(e)))
    this.pool = pool
  }

  async close(): Promise<void> {
    const p = this.pool
    this.pool = null
    if (p) await p.close().catch(() => {})
  }

  async execute(text: string, collector: ResultCollector): Promise<QueryResult> {
    if (!this.pool) await this.open()
    const started = performance.now()
    this.messages = collector.messages
    this.cancelled = false

    for (const batch of splitGoBatches(text)) {
      if (this.cancelled) break
      const errors = await this.stream(batch.text, collector)
      if (errors.length) {
        // Zadnja greška je glavna; prethodne (npr. 'Statement terminated') idu prije nje.
        const last = errors[errors.length - 1] as Error & { lineNumber?: number }
        for (const pe of errors.slice(0, -1)) this.messages.push({ kind: 'error', text: cleanOdbc(pe).message })
        const line = last.lineNumber ? ` (${t('core.line', batch.startLine + last.lineNumber - 1)})` : ''
        const text = this.cancelled ? t('core.queryCancelled') : errorMessage(cleanOdbc(last)).replace(/ \((?:linija|line) \d+\)$/, '') + line
        this.messages.push({ kind: 'error', text })
        this.current = null
        return {
          resultSets: collector.sets,
          messages: this.messages,
          durationMs: performance.now() - started,
          error: text,
          cancelled: this.cancelled || undefined
        }
      }
    }
    this.current = null
    return { resultSets: collector.sets, messages: this.messages, durationMs: performance.now() - started }
  }

  /** Jedan batch u stream načinu: mssql emitira kolone, retke i broj obuhvaćenih redaka bez gomilanja. */
  private stream(batch: string, collector: ResultCollector): Promise<Error[]> {
    const req = this.pool!.request()
    req.arrayRowMode = true
    req.stream = true
    this.current = req
    // Pauza na limitu: tedious prestaje čitati odgovor servera.
    collector.setSource({ pause: () => req.pause(), resume: () => req.resume() })
    const errors: Error[] = []
    return new Promise((resolve) => {
      req.on('info', (m: { message: string }) => this.messages.push({ kind: 'info', text: cleanOdbc(new Error(m.message)).message }))
      req.on('recordset', (columns: { name: string; type?: { declaration?: string } }[]) => {
        collector.endSet()
        collector.startSet(columns.map((c) => ({ name: c.name, type: c.type?.declaration })))
      })
      req.on('row', (row: unknown[]) => collector.addRow(row))
      req.on('rowsaffected', (n: number) => this.messages.push({ kind: 'rows', text: `(${t('core.rowsAffected', n)})` }))
      // U stream načinu mssql nakon grešaka uvijek emitira 'done'.
      req.on('error', (err: Error) => errors.push(err))
      req.on('done', () => {
        collector.endSet()
        collector.setSource(null)
        resolve(errors)
      })
      // batch, ne query: query ide kroz sp_executesql, pa bi #temp tablice i SET opcije nestale na kraju
      // tog poziva umjesto da ostanu u sesiji taba.
      void req.batch(batch).catch(() => { /* greške stižu kroz 'error' */ })
    })
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    this.current?.cancel()
  }

  async transactionState(): Promise<TxState> {
    if (!this.pool) return 'none'
    const r = await this.pool.request().query<{ n: number; s: number }>('SELECT @@TRANCOUNT AS n, XACT_STATE() AS s')
    const { n, s } = r.recordset[0]
    return s === -1 ? 'failed' : n > 0 ? 'open' : 'none'
  }

  async explain(sql: string, analyze: boolean): Promise<QueryPlan> {
    if (analyze) throw new Error(t('core.mssqlNoAnalyze'))
    if (!this.pool) await this.open()
    const pool = this.pool!
    // SHOWPLAN_XML mora biti sam u batchu; dok je uključen, naredbe se ne izvršavaju nego vraćaju plan.
    await pool.request().batch('SET SHOWPLAN_XML ON').catch((e) => Promise.reject(cleanOdbc(e)))
    try {
      const r = await pool.request().batch(sql).catch((e) => Promise.reject(cleanOdbc(e)))
      const row = (r.recordset?.[0] ?? {}) as Record<string, unknown>
      return mssqlPlan(String(Object.values(row)[0] ?? ''))
    } finally {
      await pool.request().batch('SET SHOWPLAN_XML OFF').catch(() => {})
    }
  }

  async transaction(action: TxAction): Promise<void> {
    if (!this.pool) await this.open()
    // Ugniježđeni BEGIN TRAN povećava @@TRANCOUNT; Commit iz toolbara zatvara sve razine.
    const sql =
      action === 'begin'
        ? 'BEGIN TRANSACTION'
        : action === 'commit'
          ? 'WHILE @@TRANCOUNT > 0 COMMIT TRANSACTION'
          : 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION'
    await this.pool!.request().batch(sql).catch((e) => Promise.reject(cleanOdbc(e)))
  }

  async currentDatabase(): Promise<string | undefined> {
    if (!this.pool) return this.database
    const r = await this.pool.request().query<{ db: string }>('SELECT DB_NAME() AS db')
    return r.recordset[0].db
  }
}

export const mssqlFactory: DriverFactory = {
  metadata: (c) => new MssqlMetadata(c),
  session: (c, db) => new MssqlSession(c, db)
}
