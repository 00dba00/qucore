import mysql from 'mysql2/promise'
import type { Connection as CoreConnection, FieldPacket, ResultSetHeader } from 'mysql2'
import type {
  ChildInfo,
  ConnectionConfig,
  DbObject,
  EditStatement,
  QueryMessage,
  QueryResult,
  SchemaGraph,
  TableDetails,
  QueryPlan,
  TxAction,
  TxState
} from '../../shared/types.ts'
import type { DriverFactory, MetadataDriver, QuerySession } from '../driver.ts'
import { errorMessage, groupForeignKeys, groupTables, quoteIdent, rows, type ResultCollector } from '../util.ts'
import { assertOneRow } from '../edits.ts'
import { mariaPlan } from '../plan.ts'
import { groupForeignKeyRows, groupIndexes, type FkColumnRow } from '../tableDetails.ts'
import { t } from '../../shared/i18n.ts'

const q = quoteIdent.mariadb

function baseOptions(c: ConnectionConfig, database?: string): mysql.ConnectionOptions {
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: database || c.database || undefined,
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 15000,
    // Datume i velike brojeve vraćamo kao tekst — točno kako su u bazi.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    charset: 'utf8mb4'
  }
}

class MariadbMetadata implements MetadataDriver {
  private pool: mysql.Pool
  private config: ConnectionConfig
  constructor(config: ConnectionConfig) {
    this.config = config
    this.pool = mysql.createPool({ ...baseOptions(config), connectionLimit: 3, idleTimeout: 60000 })
  }

  async connect(): Promise<void> {
    await this.pool.query('SELECT 1')
  }
  async close(): Promise<void> {
    await this.pool.end().catch(() => {})
  }

  private async rows<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query(text, params)
    return rows as T[]
  }

  async serverVersion(): Promise<string> {
    const r = await this.rows<{ v: string; c: string }>(`SELECT VERSION() AS v, @@version_comment AS c`)
    return `${r[0].c} ${r[0].v}`
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.rows<{ name: string }>(
      `SELECT schema_name AS name FROM information_schema.schemata
       ORDER BY schema_name IN ('information_schema','mysql','performance_schema','sys'), schema_name`
    )
    return r.map((x) => x.name)
  }

  async databaseSizes(): Promise<Record<string, number>> {
    const r = await this.rows<{ name: string; bytes: string | number | null }>(
      `SELECT table_schema AS name, SUM(data_length + index_length) AS bytes
       FROM information_schema.tables GROUP BY table_schema`
    )
    return Object.fromEntries(r.map((x) => [x.name, Number(x.bytes ?? 0)]))
  }

  async listObjects(database: string): Promise<DbObject[]> {
    const [tables, routines, triggers] = await Promise.all([
      this.rows<{ name: string; type: string; bytes: string | null }>(
        `SELECT table_name AS name, table_type AS type, data_length + index_length AS bytes FROM information_schema.tables
         WHERE table_schema = ? ORDER BY table_name`,
        [database]
      ),
      this.rows<{ name: string; type: string }>(
        `SELECT routine_name AS name, routine_type AS type FROM information_schema.routines
         WHERE routine_schema = ? ORDER BY routine_name`,
        [database]
      ),
      this.rows<{ name: string; tbl: string }>(
        `SELECT trigger_name AS name, event_object_table AS tbl FROM information_schema.triggers
         WHERE trigger_schema = ? ORDER BY trigger_name`,
        [database]
      )
    ])
    const out: DbObject[] = []
    for (const t of tables) {
      const isView = t.type.includes('VIEW')
      out.push({
        kind: isView ? 'view' : 'table',
        name: t.name,
        label: t.type === 'SEQUENCE' ? `${t.name} (sequence)` : undefined,
        expandable: true,
        sizeBytes: !isView && t.bytes !== null ? Number(t.bytes) : undefined
      })
    }
    for (const r of routines) {
      out.push({ kind: r.type === 'PROCEDURE' ? 'procedure' : 'function', name: r.name, expandable: true })
    }
    for (const t of triggers) out.push({ kind: 'trigger', name: t.name, parent: t.tbl, expandable: false })
    return out
  }

  async schemaGraph(database: string): Promise<SchemaGraph> {
    const [cols, fks] = await Promise.all([
      this.rows<{ tbl: string; col: string; type: string; nullable: string; pk: string }>(
        `SELECT c.table_name AS tbl, c.column_name AS col, c.column_type AS type,
                c.is_nullable AS nullable, c.column_key AS pk
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = ? AND t.table_type = 'BASE TABLE'
         ORDER BY c.table_name, c.ordinal_position`,
        [database]
      ),
      this.rows<{ name: string; ft: string; fc: string; tt: string; tc: string; ts: string }>(
        `SELECT constraint_name AS name, table_name AS ft, column_name AS fc,
                referenced_table_schema AS ts, referenced_table_name AS tt, referenced_column_name AS tc
         FROM information_schema.key_column_usage
         WHERE table_schema = ? AND referenced_table_name IS NOT NULL
         ORDER BY table_name, constraint_name, ordinal_position`,
        [database]
      )
    ])
    return {
      tables: groupTables(cols.map((c) => ({ ...c, pk: c.pk === 'PRI' }))),
      // Shema je baza; ista baza se ne ponavlja, druga baza ostaje vidljiva u nazivu.
      foreignKeys: groupForeignKeys(fks.map((f) => ({ ...f, ts: f.ts === database ? null : f.ts })))
    }
  }

  async listChildren(database: string, obj: DbObject): Promise<ChildInfo[]> {
    if (obj.kind === 'table' || obj.kind === 'view') {
      const r = await this.rows<{ name: string; type: string; nullable: string; ckey: string; extra: string; def: string | null }>(
        `SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
                column_key AS ckey, extra, column_default AS def
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ?
         ORDER BY ordinal_position`,
        [database, obj.name]
      )
      return r.map((c) => ({
        type: 'column',
        name: c.name,
        dataType: c.type,
        nullable: c.nullable === 'YES',
        primaryKey: c.ckey === 'PRI',
        identity: /auto_increment/i.test(c.extra ?? ''),
        defaultValue: c.def
      }))
    }
    if (obj.kind === 'procedure' || obj.kind === 'function') {
      const r = await this.rows<{ name: string | null; type: string; mode: string | null; pos: number }>(
        `SELECT parameter_name AS name, dtd_identifier AS type, parameter_mode AS mode, ordinal_position AS pos
         FROM information_schema.parameters
         WHERE specific_schema = ? AND specific_name = ? AND routine_type = ?
         ORDER BY ordinal_position = 0, ordinal_position`,
        [database, obj.name, obj.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION']
      )
      return r.map((p) => ({
        type: 'parameter',
        name: p.pos === 0 ? 'RETURNS' : (p.name ?? ''),
        dataType: p.type,
        mode: p.pos === 0 ? 'RETURN' : ((p.mode ?? 'IN') as 'IN' | 'OUT' | 'INOUT')
      }))
    }
    return []
  }

  async applyEdits(_database: string, statements: EditStatement[]): Promise<number> {
    // Zasebna konekcija (ne iz poola) jer joj mijenjamo sql_mode: bez STRICT moda MariaDB bi
    // 'abc' u INT koloni ili NULL u NOT NULL koloni tiho pretvorio u 0 / '' umjesto greške.
    const conn = await mysql.createConnection(baseOptions(this.config))
    let total = 0
    try {
      await conn.query("SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES')")
      await conn.beginTransaction()
      for (const [i, st] of statements.entries()) {
        // execute = prepared statement: parametre veže server, ne zamjena teksta na klijentu.
        // mysql2 po defaultu šalje FOUND_ROWS, pa affectedRows broji pogođene, ne samo promijenjene retke.
        const [res] = await conn.execute<ResultSetHeader>(st.sql, st.params)
        if (st.expectOneRow) assertOneRow(i, res.affectedRows)
        total += res.affectedRows
      }
      await conn.commit()
      return total
    } catch (err) {
      await conn.rollback().catch(() => {})
      throw err
    } finally {
      await conn.end().catch(() => conn.destroy())
    }
  }

  async tableDetails(database: string, obj: DbObject): Promise<TableDetails> {
    const fkSql = (where: string) =>
      `SELECT constraint_name AS name, table_schema AS fromSchema, table_name AS fromTable, column_name AS fromColumn,
              referenced_table_schema AS toSchema, referenced_table_name AS toTable, referenced_column_name AS toColumn
       FROM information_schema.key_column_usage
       WHERE ${where} AND referenced_table_name IS NOT NULL
       ORDER BY table_name, constraint_name, ordinal_position`
    const [idx, out, inc] = await Promise.all([
      this.rows<{ name: string; col: string; uniq: number; pk: number; type: string }>(
        `SELECT index_name AS name, column_name AS col, non_unique = 0 AS uniq, index_name = 'PRIMARY' AS pk, index_type AS type
         FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = ?
         ORDER BY index_name, seq_in_index`,
        [database, obj.name]
      ),
      this.rows<FkColumnRow>(fkSql('table_schema = ? AND table_name = ?'), [database, obj.name]),
      this.rows<FkColumnRow>(fkSql('referenced_table_schema = ? AND referenced_table_name = ?'), [database, obj.name])
    ])
    return {
      indexes: groupIndexes(idx.map((r) => ({ name: r.name, column: r.col, unique: r.uniq, primary: r.pk, type: r.type }))),
      foreignKeys: groupForeignKeyRows(out),
      referencedBy: groupForeignKeyRows(inc)
    }
  }

  async getDefinition(database: string, obj: DbObject): Promise<string> {
    const full = `${q(database)}.${q(obj.name)}`
    const keyword = { table: 'TABLE', view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER' }[obj.kind]
    const r = await this.rows<Record<string, string>>(`SHOW CREATE ${keyword} ${full}`)
    const row = r[0] ?? {}
    const key = Object.keys(row).find((k) => /^Create /i.test(k) && k !== 'Create Time') ?? 'SQL Original Statement'
    const def = row[key]
    if (!def) return t('core.defUnavailableMaria')
    if (obj.kind === 'procedure' || obj.kind === 'function' || obj.kind === 'trigger') {
      // Tijela rutina sadrže ";" pa ih treba izvršiti kao jednu naredbu.
      return `DELIMITER $$\n${def}$$\nDELIMITER ;\n`
    }
    return def + ';'
  }
}

/**
 * Podrška za DELIMITER (kao mysql CLI), kako bi CREATE PROCEDURE skripte radile.
 * Vraća listu naredbi za izvršavanje.
 */
export function splitDelimiterScript(text: string): string[] {
  if (!/^\s*DELIMITER\s+/im.test(text)) return [text]
  const out: string[] = []
  let delimiter = ';'
  let buf = ''
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(line)
    if (m) {
      if (buf.trim()) out.push(buf)
      buf = ''
      delimiter = m[1]
      continue
    }
    buf += (buf ? '\n' : '') + line
    if (delimiter !== ';') {
      let idx: number
      while ((idx = buf.indexOf(delimiter)) !== -1) {
        const stmt = buf.slice(0, idx)
        if (stmt.trim()) out.push(stmt)
        buf = buf.slice(idx + delimiter.length)
      }
    }
  }
  if (buf.trim()) out.push(buf)
  return out
}

class MariadbSession implements QuerySession {
  private conn: mysql.Connection | null = null
  private config: ConnectionConfig
  private database?: string
  private cancelled = false

  constructor(config: ConnectionConfig, database?: string) {
    this.config = config
    this.database = database
  }

  async open(): Promise<void> {
    const conn = await mysql.createConnection({ ...baseOptions(this.config, this.database), multipleStatements: true })
    conn.on('error', () => { this.conn = null })
    this.conn = conn
  }

  async close(): Promise<void> {
    const c = this.conn
    this.conn = null
    if (c) await c.end().catch(() => c.destroy())
  }

  async execute(text: string, collector: ResultCollector): Promise<QueryResult> {
    if (!this.conn) await this.open()
    const started = performance.now()
    const messages = collector.messages
    this.cancelled = false

    for (const stmt of splitDelimiterScript(text)) {
      if (this.cancelled) break
      try {
        await this.stream(stmt, collector, messages)
        await this.collectWarnings(messages)
      } catch (err) {
        const text = this.cancelled ? t('core.queryCancelled') : errorMessage(err)
        messages.push({ kind: 'error', text })
        return {
          resultSets: collector.sets,
          messages,
          durationMs: performance.now() - started,
          error: text,
          cancelled: this.cancelled || undefined
        }
      }
    }
    return { resultSets: collector.sets, messages, durationMs: performance.now() - started }
  }

  /**
   * Jedna naredba (može vratiti više setova, npr. CALL) preko emittera mysql2 core konekcije:
   * bez callbacka mysql2 ne gomila retke, nego za svaki emitira 'result'.
   *  - 'fields' s listom kolona → počinje result set, slijede retci (polja) u 'result'
   *  - 'fields' bez liste → slijedi ResultSetHeader (DML/DDL) u 'result'
   */
  private stream(stmt: string, collector: ResultCollector, messages: QueryMessage[]): Promise<void> {
    return new Promise((resolve, reject) => {
      let open = -1
      const closeSet = () => {
        if (open < 0) return
        messages.push({ kind: 'rows', text: rows(collector.sets[open].totalRows) })
        collector.endSet()
        open = -1
      }
      // PromiseConnection u runtimeu drži core konekciju, ali tipovi je ne izlažu.
      const core = (this.conn as unknown as { connection: CoreConnection }).connection
      const q = core.query({ sql: stmt, rowsAsArray: true })
      // Pauza na limitu: mysql2 prestaje čitati socket i čuva već primljene pakete.
      collector.setSource({ pause: () => core.pause(), resume: () => core.resume() })
      q.on('fields', (fields?: FieldPacket[]) => {
        closeSet()
        if (fields?.length) open = collector.startSet(fields.map((f) => ({ name: f.name, type: mysqlTypeName(f.columnType) })))
      })
      q.on('result', (res: unknown) => {
        if (Array.isArray(res)) {
          collector.addRow(res)
        } else if (res && typeof res === 'object' && 'affectedRows' in res) {
          const h = res as ResultSetHeader
          messages.push({ kind: 'rows', text: t('core.rowsAffected', h.affectedRows) + (h.insertId ? `, insert id ${h.insertId}` : '') })
        }
      })
      q.on('error', (err: Error) => {
        closeSet()
        collector.setSource(null)
        reject(err)
      })
      q.on('end', () => {
        closeSet()
        collector.setSource(null)
        resolve()
      })
    })
  }

  private async collectWarnings(messages: QueryMessage[]): Promise<void> {
    const [w] = await this.conn!.query<mysql.RowDataPacket[]>('SHOW WARNINGS')
    for (const row of w) messages.push({ kind: 'info', text: `${row.Level} ${row.Code}: ${row.Message}` })
  }

  async cancel(): Promise<void> {
    if (!this.conn) return
    this.cancelled = true
    const killer = await mysql.createConnection(baseOptions(this.config))
    try {
      await killer.query(`KILL QUERY ${Number(this.conn.threadId)}`)
    } finally {
      await killer.end().catch(() => {})
    }
  }

  async transactionState(): Promise<TxState> {
    if (!this.conn) return 'none'
    // DO 0 vraća OK paket sa statusom servera; zastavica IN_TRANS (1) radi i na MariaDB i na MySQL-u.
    const [h] = await this.conn.query<ResultSetHeader>('DO 0')
    return h.serverStatus & 1 ? 'open' : 'none'
  }

  async explain(sql: string, analyze: boolean): Promise<QueryPlan> {
    if (!this.conn) await this.open()
    // MariaDB: ANALYZE FORMAT=JSON izvršava upit i dodaje r_rows / r_total_time_ms.
    const [rows] = await this.conn!.query<mysql.RowDataPacket[]>(`${analyze ? 'ANALYZE' : 'EXPLAIN'} FORMAT=JSON ${sql}`)
    const raw = String(Object.values(rows[0] ?? {})[0] ?? '')
    return mariaPlan(JSON.parse(raw), raw)
  }

  async transaction(action: TxAction): Promise<void> {
    if (!this.conn) await this.open()
    await this.conn!.query(action === 'begin' ? 'START TRANSACTION' : action === 'commit' ? 'COMMIT' : 'ROLLBACK')
  }

  async currentDatabase(): Promise<string | undefined> {
    if (!this.conn) return this.database
    const [r] = await this.conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS db')
    return r[0].db ?? undefined
  }
}

const MYSQL_TYPES: Record<number, string> = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 7: 'timestamp', 8: 'bigint',
  9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 15: 'varchar', 16: 'bit', 245: 'json',
  246: 'decimal', 252: 'blob', 253: 'varchar', 254: 'char'
}
function mysqlTypeName(t?: number): string | undefined {
  return t === undefined ? undefined : MYSQL_TYPES[t]
}

export const mariadbFactory: DriverFactory = {
  metadata: (c) => new MariadbMetadata(c),
  session: (c, db) => new MariadbSession(c, db)
}
