import pg from 'pg'
import type {
  ChildInfo,
  ColumnInfo,
  ConnectionConfig,
  DbObject,
  EditStatement,
  QueryMessage,
  QueryResult,
  ResultSet,
  SchemaGraph,
  TableDetails,
  IndexInfo,
  ForeignKeyInfo,
  QueryPlan,
  TxAction,
  TxState
} from '../../shared/types.ts'
import type { DriverFactory, MetadataDriver, QuerySession } from '../driver.ts'
import { errorMessage, groupForeignKeys, groupTables, quoteIdent, rows, type ResultCollector } from '../util.ts'
import { assertOneRow } from '../edits.ts'
import { pgPlan } from '../plan.ts'
import { parsePgFkDef, parsePgIndexDef } from '../tableDetails.ts'
import { t } from '../../shared/i18n.ts'

// Datume, vremena, JSON i intervale vraćamo kao sirovi tekst iz baze —
// SQL alat treba prikazati točno ono što je u bazi (mikrosekunde, vremenske zone).
const RAW_TEXT_OIDS = new Set([1082, 1083, 1114, 1184, 1186, 1266, 114, 3802])
const typeParser = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (RAW_TEXT_OIDS.has(oid)) return (v: string) => v
    return pg.types.getTypeParser(oid, format as 'text')
  }
}

const SYSTEM_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`

function clientConfig(c: ConnectionConfig, database?: string): pg.ClientConfig {
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: database || c.database || 'postgres',
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: 'QuCore',
    connectionTimeoutMillis: 15000,
    types: typeParser
  }
}

class PostgresMetadata implements MetadataDriver {
  // PostgreSQL ne podržava upite preko baza, pa držimo pool po bazi.
  private pools = new Map<string, pg.Pool>()
  private config: ConnectionConfig

  constructor(config: ConnectionConfig) {
    this.config = config
  }

  private pool(database?: string): pg.Pool {
    const db = database || this.config.database || 'postgres'
    let p = this.pools.get(db)
    if (!p) {
      p = new pg.Pool({ ...clientConfig(this.config, db), max: 3, idleTimeoutMillis: 60000 })
      p.on('error', () => { /* idle klijent pukao — pool će ga zamijeniti */ })
      this.pools.set(db, p)
    }
    return p
  }

  async connect(): Promise<void> {
    await this.pool().query('SELECT 1')
  }

  async close(): Promise<void> {
    const pools = [...this.pools.values()]
    this.pools.clear()
    await Promise.allSettled(pools.map((p) => p.end()))
  }

  async serverVersion(): Promise<string> {
    const r = await this.pool().query<{ v: string }>(`SELECT version() AS v`)
    return r.rows[0].v
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.pool().query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname`
    )
    return r.rows.map((x) => x.datname)
  }

  async databaseSizes(): Promise<Record<string, number>> {
    const r = await this.pool().query<{ datname: string; bytes: string | null }>(
      `SELECT datname, CASE WHEN has_database_privilege(datname, 'CONNECT') THEN pg_database_size(datname) END AS bytes
       FROM pg_database WHERE datallowconn AND NOT datistemplate`
    )
    return Object.fromEntries(r.rows.filter((x) => x.bytes !== null).map((x) => [x.datname, Number(x.bytes)]))
  }

  async applyEdits(database: string, statements: EditStatement[]): Promise<number> {
    const client = await this.pool(database).connect()
    let total = 0
    try {
      await client.query('BEGIN')
      for (const [i, st] of statements.entries()) {
        const r = await client.query(st.sql, st.params)
        const n = r.rowCount ?? 0
        if (st.expectOneRow) assertOneRow(i, n)
        total += n
      }
      await client.query('COMMIT')
      return total
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async listObjects(database: string): Promise<DbObject[]> {
    const p = this.pool(database)
    const [rels, procs, trigs] = await Promise.all([
      p.query<{ schema: string; name: string; relkind: string; bytes: string | null }>(`
        SELECT n.nspname AS schema, c.relname AS name, c.relkind,
               CASE WHEN c.relkind IN ('r', 'm') THEN pg_total_relation_size(c.oid) END AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition AND ${SYSTEM_SCHEMAS}
        ORDER BY n.nspname, c.relname`),
      p.query<{ oid: string; schema: string; name: string; prokind: string; args: string }>(`
        SELECT p.oid::text AS oid, n.nspname AS schema, p.proname AS name, p.prokind,
               pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f', 'p') AND ${SYSTEM_SCHEMAS}
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        ORDER BY n.nspname, p.proname`),
      p.query<{ oid: string; schema: string; name: string; tbl: string }>(`
        SELECT t.oid::text AS oid, n.nspname AS schema, t.tgname AS name, c.relname AS tbl
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND ${SYSTEM_SCHEMAS}
        ORDER BY n.nspname, t.tgname`)
    ])

    const out: DbObject[] = []
    for (const r of rels.rows) {
      const isView = r.relkind === 'v' || r.relkind === 'm'
      out.push({
        kind: isView ? 'view' : 'table',
        schema: r.schema,
        name: r.name,
        label: r.relkind === 'm' ? `${r.name} (materialized)` : undefined,
        expandable: true,
        sizeBytes: r.bytes !== null ? Number(r.bytes) : undefined
      })
    }
    for (const r of procs.rows) {
      out.push({
        kind: r.prokind === 'p' ? 'procedure' : 'function',
        schema: r.schema,
        name: r.name,
        label: `${r.name}(${r.args})`,
        id: r.oid,
        expandable: true
      })
    }
    for (const r of trigs.rows) {
      out.push({ kind: 'trigger', schema: r.schema, name: r.name, id: r.oid, parent: r.tbl, expandable: false })
    }
    return out
  }

  async schemaGraph(database: string): Promise<SchemaGraph> {
    const p = this.pool(database)
    const [cols, fks] = await Promise.all([
      p.query<{ sch: string; tbl: string; col: string; type: string; nullable: boolean; pk: boolean }>(
        `SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col,
                format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${SYSTEM_SCHEMAS}
         ORDER BY n.nspname, c.relname, a.attnum`
      ),
      // Jedan redak po paru kolona; unnest WITH ORDINALITY čuva redoslijed u ključu.
      p.query<{ name: string; fs: string; ft: string; fc: string; ts: string; tt: string; tc: string }>(
        `SELECT con.conname AS name, n.nspname AS fs, c.relname AS ft, fa.attname AS fc,
                rn.nspname AS ts, rc.relname AS tt, ra.attname AS tc
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(fnum, tnum, ord)
         JOIN pg_attribute fa ON fa.attrelid = con.conrelid AND fa.attnum = k.fnum
         JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.tnum
         WHERE con.contype = 'f' AND NOT c.relispartition AND ${SYSTEM_SCHEMAS}
         ORDER BY n.nspname, c.relname, con.conname, k.ord`
      )
    ])
    return { tables: groupTables(cols.rows), foreignKeys: groupForeignKeys(fks.rows) }
  }

  async listChildren(database: string, obj: DbObject): Promise<ChildInfo[]> {
    const p = this.pool(database)
    if (obj.kind === 'table' || obj.kind === 'view') {
      const r = await p.query<ColumnInfo & { name: string }>(
        `SELECT a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS "dataType",
                NOT a.attnotnull AS nullable,
                EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS "primaryKey",
                (a.attidentity <> '' OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%') AS identity,
                pg_get_expr(d.adbin, d.adrelid) AS "defaultValue"
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [obj.schema, obj.name]
      )
      return r.rows.map((c) => ({ type: 'column', ...c }))
    }
    if ((obj.kind === 'function' || obj.kind === 'procedure') && obj.id) {
      const r = await p.query<{ name: string | null; type: string; mode: string }>(
        `SELECT a.name, format_type(a.type, NULL) AS type, a.mode
         FROM pg_proc p,
              LATERAL unnest(
                coalesce(p.proallargtypes, p.proargtypes::oid[]),
                coalesce(p.proargmodes, array_fill('i'::"char", ARRAY[cardinality(p.proargtypes::oid[])])),
                coalesce(p.proargnames, array_fill(''::text, ARRAY[cardinality(coalesce(p.proallargtypes, p.proargtypes::oid[]))]))
              ) WITH ORDINALITY AS a(type, mode, name, ord)
         WHERE p.oid = $1::oid
         ORDER BY a.ord`,
        [obj.id]
      )
      const modeMap: Record<string, 'IN' | 'OUT' | 'INOUT'> = {
        i: 'IN', o: 'OUT', b: 'INOUT', v: 'IN', t: 'OUT'
      }
      const params: ChildInfo[] = r.rows.map((x, i) => ({
        type: 'parameter',
        name: x.name || `$${i + 1}`,
        dataType: x.type,
        mode: modeMap[x.mode] ?? 'IN'
      }))
      if (obj.kind === 'function') {
        const ret = await p.query<{ t: string }>(`SELECT pg_get_function_result($1::oid) AS t`, [obj.id])
        if (ret.rows[0]?.t) params.push({ type: 'parameter', name: 'RETURNS', dataType: ret.rows[0].t, mode: 'RETURN' })
      }
      return params
    }
    return []
  }

  async tableDetails(database: string, obj: DbObject): Promise<TableDetails> {
    const p = this.pool(database)
    const schema = obj.schema ?? 'public'
    const [idx, fks] = await Promise.all([
      p.query<{ name: string; def: string; is_primary: boolean }>(
        `SELECT i.indexname AS name, i.indexdef AS def, COALESCE(x.indisprimary, false) AS is_primary
         FROM pg_indexes i
         JOIN pg_namespace n ON n.nspname = i.schemaname
         JOIN pg_class c ON c.relname = i.indexname AND c.relnamespace = n.oid
         LEFT JOIN pg_index x ON x.indexrelid = c.oid
         WHERE i.schemaname = $1 AND i.tablename = $2`,
        [schema, obj.name]
      ),
      p.query<{ name: string; from_schema: string; from_table: string; to_schema: string; to_table: string; def: string }>(
        `SELECT con.conname AS name, fn.nspname AS from_schema, fc.relname AS from_table,
                tn.nspname AS to_schema, tc.relname AS to_table, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class fc ON fc.oid = con.conrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
         JOIN pg_class tc ON tc.oid = con.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
         WHERE con.contype = 'f' AND ((fn.nspname = $1 AND fc.relname = $2) OR (tn.nspname = $1 AND tc.relname = $2))
         ORDER BY fc.relname, con.conname`,
        [schema, obj.name]
      )
    ])
    const indexes: IndexInfo[] = idx.rows
      .map((r) => {
        const d = parsePgIndexDef(r.def)
        return { name: r.name, columns: d.columns, unique: d.unique || r.is_primary, primary: r.is_primary, type: d.type, included: d.included }
      })
      .sort((a, b) => Number(b.primary) - Number(a.primary) || Number(b.unique) - Number(a.unique) || a.name.localeCompare(b.name))
    const all: ForeignKeyInfo[] = fks.rows.flatMap((r) => {
      const d = parsePgFkDef(r.def)
      return d ? [{ name: r.name, fromSchema: r.from_schema, fromTable: r.from_table, fromColumns: d.fromColumns, toSchema: r.to_schema, toTable: r.to_table, toColumns: d.toColumns }] : []
    })
    return {
      indexes,
      foreignKeys: all.filter((f) => f.fromSchema === schema && f.fromTable === obj.name),
      referencedBy: all.filter((f) => f.toSchema === schema && f.toTable === obj.name)
    }
  }

  async getDefinition(database: string, obj: DbObject): Promise<string> {
    const p = this.pool(database)
    const q = quoteIdent.postgres
    const full = `${q(obj.schema!)}.${q(obj.name)}`
    switch (obj.kind) {
      case 'view': {
        const r = await p.query<{ def: string; kind: string }>(
          `SELECT pg_get_viewdef(c.oid, true) AS def, c.relkind AS kind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2`,
          [obj.schema, obj.name]
        )
        const row = r.rows[0]
        const head = row.kind === 'm' ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW'
        return `${head} ${full} AS\n${row.def}`
      }
      case 'function':
      case 'procedure': {
        const r = await p.query<{ def: string }>(`SELECT pg_get_functiondef($1::oid) AS def`, [obj.id])
        return r.rows[0].def
      }
      case 'trigger': {
        const r = await p.query<{ def: string }>(`SELECT pg_get_triggerdef($1::oid, true) AS def`, [obj.id])
        return r.rows[0].def + ';'
      }
      case 'table':
        return this.tableDdl(database, obj)
    }
  }

  private async tableDdl(database: string, obj: DbObject): Promise<string> {
    const p = this.pool(database)
    const q = quoteIdent.postgres
    const cols = (await this.listChildren(database, obj)) as (ChildInfo & { type: 'column' })[]
    const cons = await p.query<{ name: string; def: string }>(
      `SELECT con.conname AS name, pg_get_constraintdef(con.oid, true) AS def
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
       ORDER BY con.contype = 'p' DESC, con.conname`,
      [obj.schema, obj.name]
    )
    const lines = cols.map((c) => {
      let l = `  ${q(c.name)} ${c.dataType}`
      if (c.defaultValue) l += ` DEFAULT ${c.defaultValue}`
      if (!c.nullable) l += ' NOT NULL'
      return l
    })
    for (const c of cons.rows) lines.push(`  CONSTRAINT ${q(c.name)} ${c.def}`)
    return `CREATE TABLE ${q(obj.schema!)}.${q(obj.name)} (\n${lines.join(',\n')}\n);`
  }
}

class PostgresSession implements QuerySession {
  private client: pg.Client | null = null
  private notices: QueryMessage[] = []
  private cancelled = false
  private config: ConnectionConfig
  private database?: string

  constructor(config: ConnectionConfig, database?: string) {
    this.config = config
    this.database = database
  }

  async open(): Promise<void> {
    const client = new pg.Client(clientConfig(this.config, this.database))
    client.on('notice', (n) => this.notices.push({ kind: 'info', text: `${n.severity ?? 'NOTICE'}: ${n.message}` }))
    client.on('error', () => { this.client = null })
    await client.connect()
    this.client = client
  }

  async close(): Promise<void> {
    const c = this.client
    this.client = null
    if (c) await c.end().catch(() => {})
  }

  async transactionState(): Promise<TxState> {
    if (!this.client) return 'none'
    // Status iz zadnjeg ReadyForQuery poruke servera: I = bez transakcije, T = u transakciji, E = u grešci.
    const s = (this.client as unknown as { getTransactionStatus(): string | null }).getTransactionStatus()
    return s === 'I' ? 'none' : s === 'T' ? 'open' : s === 'E' ? 'failed' : 'unknown'
  }

  async explain(sql: string, analyze: boolean): Promise<QueryPlan> {
    if (!this.client) await this.open()
    const r = await this.client!.query(`EXPLAIN (FORMAT JSON${analyze ? ', ANALYZE' : ''}) ${sql}`)
    // json stupci ovdje dolaze kao tekst (RAW_TEXT_OIDS), pa se plan parsira ručno.
    const cell = r.rows[0]?.['QUERY PLAN'] as unknown
    const json = typeof cell === 'string' ? (JSON.parse(cell) as unknown) : cell
    return pgPlan(json, JSON.stringify(json, null, 2))
  }

  async transaction(action: TxAction): Promise<void> {
    if (!this.client) await this.open()
    await this.client!.query(action === 'begin' ? 'BEGIN' : action === 'commit' ? 'COMMIT' : 'ROLLBACK')
  }

  async execute(sql: string, collector: ResultCollector): Promise<QueryResult> {
    if (!this.client) await this.open()
    const started = performance.now()
    // NOTICE poruke idu ravno u collector, pa su i u snimci pauziranog rezultata.
    this.notices = collector.messages
    this.cancelled = false
    // pg Result objekt → indeks seta u collectoru (set nastaje s prvim retkom).
    const setIndex = new Map<unknown, number>()
    let current: unknown = null
    const messages = collector.messages
    try {
      // Bez parametara pg koristi "simple query" protokol koji podržava više naredbi odjednom.
      // Uz listener na 'row' pg ne gomila retke u memoriji.
      const query = new pg.Query({ text: sql, rowMode: 'array' } as pg.QueryArrayConfig)
      query.on('row', (row: unknown[], result?: pg.ResultBuilder) => {
        if (result && result !== current) {
          current = result
          collector.endSet()
          setIndex.set(result, collector.startSet(result.fields.map((f) => ({ name: f.name, type: pgTypeName(f.dataTypeID) }))))
        }
        collector.addRow(row)
      })
      // Pauza na limitu: zaustavlja se čitanje socketa (server čeka, upit ostaje otvoren).
      const conn = (this.client as unknown as { connection: { stream: { pause(): void; resume(): void } } }).connection
      collector.setSource({ pause: () => conn.stream.pause(), resume: () => conn.stream.resume() })
      const res = await new Promise<pg.QueryArrayResult | pg.QueryArrayResult[]>((resolve, reject) => {
        query.on('end', resolve)
        query.on('error', reject)
        this.client!.query(query)
      }).finally(() => collector.setSource(null))
      // Konačni redoslijed iz pg rezultata; setovi bez redaka nisu prošli kroz 'row'.
      const resultSets: ResultSet[] = []
      for (const r of Array.isArray(res) ? res : [res]) {
        if (r.fields && r.fields.length > 0) {
          const i = setIndex.get(r)
          resultSets.push(
            i !== undefined
              ? collector.sets[i]
              : { columns: r.fields.map((f) => ({ name: f.name, type: pgTypeName(f.dataTypeID) })), rows: [], truncated: false, totalRows: 0 }
          )
          messages.push({ kind: 'rows', text: `${r.command ?? 'SELECT'}: ${rows(r.rowCount ?? (i !== undefined ? collector.sets[i].totalRows : 0))}` })
        } else if (r.command) {
          const n = r.rowCount
          messages.push({ kind: 'rows', text: n !== null && n !== undefined ? `${r.command}: ${rows(n)}` : `${r.command} OK` })
        }
      }
      return { resultSets, messages, durationMs: performance.now() - started }
    } catch (err) {
      const e = err as Error & { position?: string; hint?: string }
      let text = this.cancelled ? t('core.queryCancelled') : errorMessage(err)
      if (!this.cancelled && e.position) text += ` (${t('core.position', e.position)})`
      if (!this.cancelled && e.hint) text += `
Hint: ${e.hint}`
      // pg javlja grešku prije serverovog ReadyForQuery, pa bi stanje transakcije bilo staro (T umjesto E).
      // Prazan upit je dopušten i u prekinutoj transakciji, a završava tek nakon ReadyForQuery.
      await this.client?.query('').catch(() => {})
      // Retci primljeni do greške ili prekida ostaju vidljivi.
      return {
        resultSets: collector.sets,
        messages: [...messages, { kind: 'error', text }],
        durationMs: performance.now() - started,
        error: text,
        cancelled: this.cancelled || undefined
      }
    }
  }

  async cancel(): Promise<void> {
    const pid = (this.client as unknown as { processID?: number } | null)?.processID
    if (!pid) return
    this.cancelled = true
    const killer = new pg.Client(clientConfig(this.config, this.database))
    try {
      await killer.connect()
      await killer.query('SELECT pg_cancel_backend($1)', [pid])
    } finally {
      await killer.end().catch(() => {})
    }
  }

  async currentDatabase(): Promise<string | undefined> {
    if (!this.client) return this.database
    const r = await this.client.query<{ db: string }>('SELECT current_database() AS db')
    return r.rows[0].db
  }
}

const PG_TYPE_NAMES: Record<number, string> = {
  16: 'bool', 17: 'bytea', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 114: 'json', 700: 'float4',
  701: 'float8', 1042: 'char', 1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp',
  1184: 'timestamptz', 1186: 'interval', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb'
}
function pgTypeName(oid: number): string | undefined {
  return PG_TYPE_NAMES[oid]
}

export const postgresFactory: DriverFactory = {
  metadata: (c) => new PostgresMetadata(c),
  session: (c, db) => new PostgresSession(c, db)
}
