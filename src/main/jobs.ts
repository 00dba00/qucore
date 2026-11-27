import { join } from 'node:path'
import type { DataJob, DataJobInput, HttpTestResult, JobRun, JobSource, ResultColumn } from '../shared/types'
import { runDataJob, probeColumns, testHttpJob, JobError, type JobPlan } from '../core/jobs/engine'
import { validateHttpTarget } from '../core/jobs/http'
import type { CredentialStore } from './credentialStore'
import { substituteParams } from '../core/params'
import { quoteIdent } from '../core/util'
import type { ConnectionStore } from './connectionStore'
import type { WorkspaceStore } from './workspaceStore'
import type { FileGrants } from './fileGrants'
import { t } from '../shared/i18n.ts'

const MAX_BATCH = 10000
const DEFAULT_BATCH = 500

/** Poslovi prijenosa podataka: spremanje uz provjere, razrješavanje izvora, izvođenje i log. */
export class JobService {
  private running = new Map<number, { abort: AbortController; done: Promise<unknown> }>()

  constructor(
    private workspace: WorkspaceStore,
    private store: ConnectionStore,
    /** Mape koje je korisnik odabrao u dijalogu (posao smije pisati samo u njih). */
    private folders: FileGrants,
    /** Prijave web servisa (HTTP odredište). */
    private credentials: CredentialStore
  ) {}

  save(input: DataJobInput): DataJob {
    const d = input.config.destination
    if (d.kind === 'file' && !this.folders.has(d.folder)) throw new Error(t('main.jobFolderNotGranted'))
    if (d.kind === 'http') validateHttpTarget(d)
    const batchSize = Math.min(MAX_BATCH, Math.max(1, Math.round(Number(input.config.batchSize) || DEFAULT_BATCH)))
    return this.workspace.saveJob({ ...input, config: { ...input.config, batchSize } })
  }

  remove(id: number): void {
    this.running.get(id)?.abort.abort()
    this.workspace.removeJob(id)
  }

  /** Izvor posla → konekcija, baza i SQL s uvrštenim varijablama. */
  resolveSource(source: JobSource): JobPlan['source'] {
    if (source.kind === 'table') {
      const conn = this.store.get(source.connectionId)
      if (!conn) throw new Error(t('main.jobQueryNoConnection'))
      const q = quoteIdent[conn.type]
      const name =
        conn.type === 'mssql'
          ? `${q(source.database)}.${q(source.schema || 'dbo')}.${q(source.table)}`
          : conn.type === 'postgres'
            ? `${q(source.schema || 'public')}.${q(source.table)}`
            : `${q(source.database)}.${q(source.table)}`
      return { connectionId: source.connectionId, database: source.database, sql: `SELECT * FROM ${name}` }
    }
    const saved = this.workspace.getSaved(source.savedQueryId)
    if (!saved) throw new Error(t('main.jobQueryMissing'))
    let connectionId = saved.connectionId
    let database = saved.database
    if (saved.aliasId) {
      for (const p of this.workspace.listProjects()) {
        const alias = p.aliases.find((a) => a.id === saved.aliasId)
        if (!alias) continue
        const env = source.env ?? p.defaultEnv
        const target = alias.targets.find((x) => x.env === env)
        if (!target) throw new Error(t('main.jobAliasNoTarget', alias.name, env))
        connectionId = target.connectionId
        database = target.database
        break
      }
    }
    const conn = connectionId ? this.store.get(connectionId) : undefined
    if (!conn) throw new Error(t('main.jobQueryNoConnection'))
    return { connectionId: conn.id, database, sql: substituteParams(saved.sql, conn.type, source.params ?? {}) }
  }

  /** Spremljeni posao → plan za engine (izvor, varijable upita za HTTP predloške). */
  private plan(job: DataJob): JobPlan {
    const src = job.config.source
    const variables =
      src.kind === 'query' ? Object.fromEntries(Object.entries(src.params ?? {}).map(([k, v]) => [k, v.type === 'null' ? '' : v.value])) : undefined
    return { name: job.name, source: this.resolveSource(src), columns: job.config.columns, destination: job.config.destination, batchSize: job.config.batchSize, variables }
  }

  /** Probni HTTP zahtjev s prvim retkom izvora spremljenog posla. */
  testHttp(id: number): Promise<HttpTestResult> {
    const job = this.workspace.getJob(id)
    if (!job) throw new Error(t('main.jobMissing'))
    return testHttpJob(this.plan(job), this.store, { credentials: this.credentials })
  }

  sourceColumns(source: JobSource): Promise<ResultColumn[]> {
    return probeColumns(this.resolveSource(source), this.store)
  }

  isRunning(id: number): boolean {
    return this.running.has(id)
  }

  /** Izvodi posao i bilježi izvođenje; greška posla ne baca iznimku nego se vraća u zapisu. */
  async run(id: number, trigger: JobRun['trigger'], onProgress?: (p: { rowsRead: number; rowsWritten: number }) => void): Promise<JobRun> {
    if (this.running.has(id)) throw new Error(t('main.jobAlreadyRunning'))
    const job = this.workspace.getJob(id)
    if (!job) throw new Error(t('main.jobMissing'))
    const d = job.config.destination
    const runId = this.workspace.startJobRun(id, trigger, this.describe(job))
    const abort = new AbortController()
    let finish!: () => void
    this.running.set(id, { abort, done: new Promise<void>((r) => (finish = r)) })
    try {
      if (d.kind === 'file' && !this.folders.has(d.folder)) throw new Error(t('main.jobFolderNotGranted'))
      const r = await runDataJob(this.plan(job), this.store, { signal: abort.signal, onProgress, credentials: this.credentials })
      return this.workspace.finishJobRun(runId, { status: 'success', rowsRead: r.rowsRead, rowsWritten: r.rowsWritten, target: r.target })
    } catch (e) {
      const je = e instanceof JobError ? e : undefined
      return this.workspace.finishJobRun(runId, {
        status: je?.cancelled ? 'cancelled' : 'error',
        rowsRead: je?.counts.rowsRead ?? 0,
        rowsWritten: je?.counts.rowsWritten ?? 0,
        target: je?.target,
        error: (e as Error).message,
        failedRow: je?.failedRow ? JSON.stringify(je.failedRow) : undefined,
        failedRowNumber: je?.failedRowNumber
      })
    } finally {
      this.running.delete(id)
      finish()
    }
  }

  cancel(id: number): void {
    this.running.get(id)?.abort.abort()
  }

  /** Zatvaranje aplikacije: prekini poslove i pričekaj da zabilježe kraj. */
  async cancelAll(): Promise<void> {
    const all = [...this.running.values()]
    for (const r of all) r.abort.abort()
    await Promise.allSettled(all.map((r) => r.done))
  }

  /** Odredište za log prije početka (točna putanja datoteke se zna tek pri izvođenju). */
  private describe(job: DataJob): string {
    const d = job.config.destination
    if (d.kind === 'file') return join(d.folder, d.fileName)
    if (d.kind === 'http') return `${d.method} ${d.url}`
    const conn = this.store.get(d.connectionId)
    return `${conn?.name ?? '?'} / ${[d.database, d.schema, d.table].filter(Boolean).join('.')}`
  }
}
