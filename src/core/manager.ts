import { randomUUID } from 'node:crypto'
import type {
  ChildInfo,
  ConnectionConfig,
  DbObject,
  DbType,
  EditTable,
  RowEdit,
  SchemaGraph,
  TableDetails,
  ExecuteOptions,
  FetchMode,
  QueryProgress,
  QueryResult,
  QueryPlan,
  SessionInfo,
  TxAction,
  TxState
} from '../shared/types.ts'
import type { DriverFactory, MetadataDriver, QuerySession } from './driver.ts'
import { mariadbFactory } from './drivers/mariadb.ts'
import { mssqlFactory } from './drivers/mssql.ts'
import { postgresFactory } from './drivers/postgres.ts'
import { ResultCollector, errorMessage } from './util.ts'
import { splitStatements } from './statements.ts'
import { analyzeSql } from './sqlRefs.ts'
import { buildEditStatements, literalSql } from './edits.ts'
import { t } from '../shared/i18n.ts'

export const FACTORIES: Record<DbType, DriverFactory> = {
  mssql: mssqlFactory,
  postgres: postgresFactory,
  mariadb: mariadbFactory
}

/** Izvor konfiguracija konekcija (desktop: kriptirana datoteka; web: baza/korisnički račun). */
export interface ConnectionResolver {
  resolve(connectionId: string): Promise<ConnectionConfig>
}

const DEFAULT_MAX_ROWS = 10000

/** Upit u tijeku ili pauziran na limitu; drži collector i obećanje drivera do kraja. */
interface Execution {
  collector: ResultCollector
  run: Promise<QueryResult>
  started: number
}

interface SessionEntry {
  connectionId: string
  database?: string
  session: QuerySession
  /** Dijalekt (za dijeljenje naredbi i analizu kod plana). */
  type: DbType
  exec?: Execution
}

/**
 * Središnje mjesto za sve aktivne konekcije.
 * Ne ovisi o Electronu — isti kod koristi i web server.
 */
export class ConnectionManager {
  private metadata = new Map<string, MetadataDriver>()
  private sessions = new Map<string, SessionEntry>()
  private resolver: ConnectionResolver

  constructor(resolver: ConnectionResolver) {
    this.resolver = resolver
  }

  static async test(config: ConnectionConfig): Promise<{ ok: boolean; message: string; version?: string }> {
    const driver = FACTORIES[config.type].metadata(config)
    try {
      await driver.connect()
      const version = await driver.serverVersion()
      return { ok: true, message: t('core.connectionOk'), version }
    } catch (err) {
      return { ok: false, message: errorMessage(err) }
    } finally {
      await driver.close()
    }
  }

  private async meta(connectionId: string): Promise<MetadataDriver> {
    let d = this.metadata.get(connectionId)
    if (!d) {
      const config = await this.resolver.resolve(connectionId)
      d = FACTORIES[config.type].metadata(config)
      try {
        await d.connect()
      } catch (err) {
        await d.close()
        throw err
      }
      this.metadata.set(connectionId, d)
    }
    return d
  }

  async connect(connectionId: string): Promise<{ version: string }> {
    const d = await this.meta(connectionId)
    return { version: await d.serverVersion() }
  }

  async disconnect(connectionId: string): Promise<void> {
    const d = this.metadata.get(connectionId)
    this.metadata.delete(connectionId)
    await d?.close()
    for (const [id, s] of this.sessions) {
      if (s.connectionId === connectionId) await this.closeSession(id)
    }
  }

  async databases(connectionId: string): Promise<string[]> {
    return (await this.meta(connectionId)).listDatabases()
  }
  /** Veličine baza; greška (npr. nedostaju prava) daje prazan rezultat umjesto rušenja explorera. */
  async databaseSizes(connectionId: string): Promise<Record<string, number>> {
    return (await this.meta(connectionId)).databaseSizes().catch(() => ({}))
  }
  async objects(connectionId: string, database: string): Promise<DbObject[]> {
    return (await this.meta(connectionId)).listObjects(database)
  }
  async children(connectionId: string, database: string, obj: DbObject): Promise<ChildInfo[]> {
    return (await this.meta(connectionId)).listChildren(database, obj)
  }
  async definition(connectionId: string, database: string, obj: DbObject): Promise<string> {
    return (await this.meta(connectionId)).getDefinition(database, obj)
  }
  async tableDetails(connectionId: string, database: string, obj: DbObject): Promise<TableDetails> {
    return (await this.meta(connectionId)).tableDetails(database, obj)
  }
  async schemaGraph(connectionId: string, database: string): Promise<SchemaGraph> {
    return (await this.meta(connectionId)).schemaGraph(database)
  }

  /** Naredbe s literalima, točno kako će se izvršiti (za dijalog prije spremanja). */
  async previewEdits(connectionId: string, target: EditTable, edits: RowEdit[]): Promise<string[]> {
    const { type } = await this.resolver.resolve(connectionId)
    return buildEditStatements(type, target, edits).map((st) => literalSql(type, st))
  }

  async applyEdits(connectionId: string, target: EditTable, edits: RowEdit[]): Promise<number> {
    const { type } = await this.resolver.resolve(connectionId)
    const statements = buildEditStatements(type, target, edits)
    return (await this.meta(connectionId)).applyEdits(target.database, statements)
  }

  async openSession(connectionId: string, database?: string): Promise<SessionInfo> {
    const config = await this.resolver.resolve(connectionId)
    const session = FACTORIES[config.type].session(config, database)
    await session.open()
    const sessionId = randomUUID()
    this.sessions.set(sessionId, { connectionId, database, session, type: config.type })
    return { sessionId, connectionId, database }
  }

  /** Konekcija i početna baza sesije (za povijest upita). */
  sessionInfo(sessionId: string): { connectionId: string; database?: string } | undefined {
    const s = this.sessions.get(sessionId)
    return s && { connectionId: s.connectionId, database: s.database }
  }

  private entry(sessionId: string): SessionEntry {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(t('core.sessionMissing'))
    return s
  }

  /**
   * Izvršava upit. Ako result set dosegne maxRows, čitanje se pauzira i vraća se rezultat
   * s pending: true — upit ostaje otvoren dok ga fetchMore ne nastavi ili zatvori.
   */
  async execute(
    sessionId: string,
    sql: string,
    options: ExecuteOptions = {},
    onProgress?: (p: QueryProgress) => void
  ): Promise<QueryResult> {
    const s = this.entry(sessionId)
    // Pauzirani prethodni upit drži konekciju: zatvori ga prije novog.
    if (s.exec) await this.discard(s)
    // Auto-commit isključen: prvi upit otvara transakciju, ostaje otvorena do Commit/Rollback.
    if (options.autoCommit === false && (await s.session.transactionState()) === 'none') await s.session.transaction('begin')
    const collector = new ResultCollector(options.maxRows ?? DEFAULT_MAX_ROWS, onProgress)
    const exec: Execution = { collector, started: performance.now(), run: s.session.execute(sql, collector) }
    s.exec = exec
    return this.withTx(s, await this.settle(s, exec))
  }

  /** Dodaje stanje transakcije završenom rezultatu (pauziran drži konekciju, pa se ne pita). */
  private async withTx(s: SessionEntry, r: QueryResult): Promise<QueryResult> {
    if (r.pending) return r
    const tx = await s.session.transactionState().catch((): TxState => 'unknown')
    return { ...r, tx }
  }

  /**
   * Plan izvršavanja jedne naredbe na sesiji taba (ista baza, privremene tablice, transakcija).
   * ANALYZE stvarno izvršava upit, pa je dopušten samo za naredbe koje ne pišu.
   */
  async explain(sessionId: string, sql: string, analyze: boolean): Promise<QueryPlan> {
    const s = this.entry(sessionId)
    const dialect = s.type
    const statements = splitStatements(sql, dialect)
    if (statements.length !== 1) throw new Error(statements.length ? t('core.planOneStatement') : t('core.planNoStatement'))
    if (analyze && analyzeSql(statements[0].text, dialect).types.some((t) => t !== 'select')) {
      throw new Error(t('core.analyzeSelectOnly'))
    }
    if (s.exec) await this.discard(s)
    return s.session.explain(statements[0].text.replace(/;\s*$/, ''), analyze)
  }

  /** Ručna transakcija na sesiji taba. Vraća stanje nakon akcije. */
  async transaction(sessionId: string, action: TxAction): Promise<TxState> {
    const s = this.entry(sessionId)
    if (s.exec) {
      // PostgreSQL: prekid pauziranog upita ruši transakciju, pa bi COMMIT tiho napravio ROLLBACK.
      if (action === 'commit') throw new Error(t('core.commitPending'))
      await this.discard(s)
    }
    if (action === 'commit' && (await s.session.transactionState()) === 'failed') {
      throw new Error(t('core.txFailed'))
    }
    await s.session.transaction(action)
    return s.session.transactionState().catch((): TxState => 'unknown')
  }

  /** Nastavlja pauzirani upit: još jedna stranica, prebrojavanje ostatka ili zatvaranje. */
  async fetchMore(sessionId: string, mode: FetchMode, onProgress?: (p: QueryProgress) => void): Promise<QueryResult> {
    const s = this.entry(sessionId)
    const exec = s.exec
    if (!exec) throw new Error(t('core.noFetchPending'))
    exec.collector.onProgress = onProgress
    if (mode === 'close') {
      exec.collector.stop()
      await s.session.cancel().catch(() => {})
    } else {
      exec.collector.resume(mode)
    }
    return this.withTx(s, await this.settle(s, exec))
  }

  /** Čeka kraj upita ili sljedeću pauzu na limitu. */
  private settle(s: SessionEntry, exec: Execution): Promise<QueryResult> {
    const snapshot = (): QueryResult => ({
      resultSets: exec.collector.sets,
      messages: exec.collector.messages,
      durationMs: performance.now() - exec.started,
      pending: true
    })
    return new Promise<QueryResult>((resolve, reject) => {
      if (exec.collector.paused) return resolve(snapshot())
      exec.collector.onPause = () => resolve(snapshot())
      exec.run.then(
        (r) => {
          // Driver je možda pročitao sve, a dio redaka još čeka u preljevu collectora.
          if (exec.collector.paused) return resolve(snapshot())
          if (s.exec === exec) s.exec = undefined
          resolve(r)
        },
        (err) => {
          if (s.exec === exec) s.exec = undefined
          reject(err)
        }
      )
    }).finally(() => {
      exec.collector.onPause = undefined
    })
  }

  /** Zatvara upit u tijeku ili pauziran i čeka da driver završi. */
  private async discard(s: SessionEntry): Promise<void> {
    const exec = s.exec
    if (!exec) return
    exec.collector.onProgress = undefined
    exec.collector.stop()
    await s.session.cancel().catch(() => {})
    await exec.run.catch(() => {})
    if (s.exec === exec) s.exec = undefined
  }

  async cancel(sessionId: string): Promise<void> {
    const s = this.entry(sessionId)
    // Pauzirani socket mora nastaviti da driver pročita prekid.
    s.exec?.collector.stop()
    await s.session.cancel()
  }
  async currentDatabase(sessionId: string): Promise<string | undefined> {
    const s = this.entry(sessionId)
    if (s.exec) throw new Error(t('core.sessionBusy'))
    return s.session.currentDatabase()
  }
  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    if (!s) return
    if (s.exec) await this.discard(s)
    await s.session.close()
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.closeSession(id)))
    await Promise.allSettled([...this.metadata.values()].map((d) => d.close()))
    this.metadata.clear()
  }
}
