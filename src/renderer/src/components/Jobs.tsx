import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Folder, Play, Plus, Refresh, Save, Stop, SwapHorizontal, Trash } from '@vectilume/react'
import { api } from '../api'
import { paramNames } from '../../../core/params'
import type {
  ConnectionInfo,
  DataJob,
  DataJobConfig,
  DbObject,
  Environment,
  JobColumn,
  JobDatabaseTarget,
  JobDestination,
  JobFileTarget,
  JobRun,
  JobSource,
  ParamType,
  ParamValue,
  Project,
  ResultColumn,
  SavedQuery
} from '../../../shared/types'
import { ENVIRONMENTS } from '../../../shared/types'
import { useContextMenu } from './ContextMenu'
import { dateDMY, num, t, timeHM } from '../i18n'
import type { TabData } from './QueryTab'

const DEFAULT_BATCH = 500

export function emptyJobConfig(): DataJobConfig {
  return {
    source: { kind: 'query', savedQueryId: 0 },
    columns: [],
    destination: { kind: 'file', format: 'csv', folder: '', fileName: '{job}-{date}', ifExists: 'overwrite' },
    batchSize: DEFAULT_BATCH
  }
}

const when = (iso: string) => {
  const d = new Date(iso)
  return `${dateDMY(d, false)} ${timeHM(d)}`
}

const duration = (r: JobRun) => {
  if (!r.finishedAt) return ''
  const ms = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function StatusDot({ run, running }: { run?: JobRun; running?: boolean }) {
  const status = running ? 'running' : (run?.status ?? 'none')
  return <span className={`job-status ${status}`} title={t(`jobs.status.${status}` as 'jobs.status.none')} />
}

// ---------- Panel u bočnoj traci ----------

export function JobsPanel({
  projectId,
  version,
  visible,
  running,
  notify,
  onOpen,
  onNew,
  onChanged
}: {
  projectId: number | null
  version: number
  visible: boolean
  running: Set<number>
  notify(text: string, kind?: 'error' | 'info'): void
  onOpen(job: DataJob): void
  onNew(): void
  onChanged(): void
}) {
  const [jobs, setJobs] = useState<DataJob[]>([])
  const openMenu = useContextMenu()

  useEffect(() => {
    if (!visible || projectId === null) return
    let cancelled = false
    api.jobs.list(projectId).then(
      (list) => !cancelled && setJobs(list),
      (e) => notify((e as Error).message, 'error')
    )
    return () => {
      cancelled = true
    }
  }, [projectId, version, visible, notify])

  return (
    <div className="history" style={{ display: visible ? 'flex' : 'none' }}>
      {projectId === null ? (
        <div className="explorer-empty">
          <SwapHorizontal size={28} />
          <p>{t('jobs.needProject')}</p>
        </div>
      ) : (
        <>
          <div className="jobs-head">
            <button className="btn small-btn" onClick={onNew}>
              <Plus size={13} /> {t('jobs.new')}
            </button>
          </div>
          <div className="history-list">
            {jobs.map((j) => (
              <div
                key={j.id}
                className={'history-row' + (j.lastRun?.status === 'error' ? ' failed' : '')}
                onDoubleClick={() => onOpen(j)}
                onClick={() => onOpen(j)}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: t('jobs.open'), onClick: () => onOpen(j) },
                    'separator',
                    {
                      label: t('common.delete'),
                      danger: true,
                      onClick: async () => {
                        if (!window.confirm(t('jobs.deleteConfirm', j.name))) return
                        try {
                          await api.jobs.remove(j.id)
                          onChanged()
                        } catch (err) {
                          notify((err as Error).message, 'error')
                        }
                      }
                    }
                  ])
                }
              >
                <div className="saved-title">
                  <StatusDot run={j.lastRun} running={running.has(j.id)} />
                  {j.name}
                </div>
                <div className="history-meta">
                  <span>{describeDestination(j.config.destination)}</span>
                  {j.lastRun && <span>{when(j.lastRun.startedAt)}</span>}
                </div>
              </div>
            ))}
            {jobs.length === 0 && (
              <div className="explorer-empty">
                <SwapHorizontal size={28} />
                <p>{t('jobs.empty')}</p>
                <p className="small">{t('jobs.emptyHint')}</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function describeDestination(d: JobDestination, connections?: ConnectionInfo[]): string {
  if (d.kind === 'file') return `${d.format.toUpperCase()} · ${d.fileName}`
  const conn = connections?.find((c) => c.id === d.connectionId)
  return `${conn ? conn.name + ' / ' : ''}${[d.database, d.schema, d.table].filter(Boolean).join('.')}`
}

// ---------- Tab posla ----------

const PARAM_TYPES: ParamType[] = ['auto', 'text', 'number', 'null', 'raw']

export function JobTab({
  tab,
  active,
  connections,
  projects,
  running,
  notify,
  onSaved,
  onRunState
}: {
  tab: TabData
  active: boolean
  connections: ConnectionInfo[]
  projects: Project[]
  /** Posao ovog taba upravo radi (App prati sve poslove u tijeku). */
  running: boolean
  notify(text: string, kind?: 'error' | 'info'): void
  onSaved(job: DataJob): void
  onRunState(jobId: number, running: boolean): void
}) {
  const projectId = tab.jobProjectId!
  const project = projects.find((p) => p.id === projectId)
  const [jobId, setJobId] = useState<number | undefined>(tab.jobId)
  const [name, setName] = useState(tab.jobId ? '' : t('jobs.newName'))
  const [config, setConfig] = useState<DataJobConfig>(emptyJobConfig)
  const [loaded, setLoaded] = useState(!tab.jobId)
  const [missing, setMissing] = useState(false)
  const [dirty, setDirty] = useState(!tab.jobId)
  const [busy, setBusy] = useState(false)
  const [runs, setRuns] = useState<JobRun[]>([])
  const [progress, setProgress] = useState<{ rowsRead: number; rowsWritten: number } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [sourceCols, setSourceCols] = useState<ResultColumn[] | null>(null)

  // Učitavanje postojećeg posla.
  useEffect(() => {
    if (!tab.jobId) return
    api.jobs.get(tab.jobId).then(
      (j) => {
        if (!j) return setMissing(true)
        setName(j.name)
        setConfig(j.config)
        setLoaded(true)
        setDirty(false)
      },
      (e) => notify((e as Error).message, 'error')
    )
  }, [tab.jobId, notify])

  const loadRuns = useCallback(() => {
    if (jobId) api.jobs.runs(jobId, 30).then(setRuns, () => {})
  }, [jobId])
  useEffect(loadRuns, [loadRuns])

  useEffect(() => {
    api.saved.list({ projectId }).then(setSavedQueries, () => setSavedQueries([]))
  }, [projectId])

  useEffect(() => {
    if (!jobId) return
    return api.jobs.onProgress((p) => {
      if (p.jobId === jobId) setProgress({ rowsRead: p.rowsRead, rowsWritten: p.rowsWritten })
    })
  }, [jobId])

  const update = (patch: Partial<DataJobConfig>) => {
    setConfig((c) => ({ ...c, ...patch }))
    setDirty(true)
  }
  const setSource = (source: JobSource) => {
    update({ source })
    setSourceCols(null)
  }
  const setDest = (patch: Partial<JobDatabaseTarget> | Partial<JobFileTarget>) =>
    update({ destination: { ...config.destination, ...patch } as JobDestination })

  const problem = validate(name, config)

  const save = useCallback(async (): Promise<number | undefined> => {
    if (problem) {
      notify(problem, 'error')
      return undefined
    }
    setBusy(true)
    try {
      const job = await api.jobs.save({ id: jobId, projectId, name, config })
      setJobId(job.id)
      setDirty(false)
      onSaved(job)
      return job.id
    } catch (e) {
      notify((e as Error).message, 'error')
      return undefined
    } finally {
      setBusy(false)
    }
  }, [problem, jobId, projectId, name, config, notify, onSaved])

  // Ctrl+S sprema posao kad je tab aktivan.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !document.querySelector('.modal-backdrop')) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, save])

  const destConn = config.destination.kind === 'database' ? connections.find((c) => c.id === (config.destination as JobDatabaseTarget).connectionId) : undefined
  const toProd = destConn?.environment === 'prod'

  const startRun = async () => {
    const id = dirty || !jobId ? await save() : jobId
    if (!id) return
    // Prvo izvođenje i pisanje u produkciju: najprije pokaži odakle i kamo idu podaci.
    if (runs.length === 0 || toProd) return setConfirm(true)
    void run(id)
  }

  const run = async (id: number) => {
    setConfirm(false)
    setProgress({ rowsRead: 0, rowsWritten: 0 })
    onRunState(id, true)
    try {
      const r = await api.jobs.run(id)
      if (r.status === 'success') notify(t('jobs.done', r.rowsWritten))
      else if (r.status === 'error') notify(r.error ?? t('jobs.status.error'), 'error')
    } catch (e) {
      notify((e as Error).message, 'error')
    } finally {
      setProgress(null)
      loadRuns()
      onRunState(id, false)
    }
  }

  if (missing) {
    return (
      <div className="job-tab" style={{ display: active ? 'flex' : 'none' }}>
        <div className="explorer-empty">{t('jobs.missing')}</div>
      </div>
    )
  }
  if (!loaded) return <div className="job-tab" style={{ display: active ? 'flex' : 'none' }} />

  return (
    <div className="job-tab" style={{ display: active ? 'flex' : 'none' }}>
      <div className="job-toolbar">
        <input className="job-name" value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} placeholder={t('common.name')} />
        <span className="muted small">{project?.name}</span>
        <span style={{ flex: 1 }} />
        {dirty && <span className="muted small">{t('jobs.unsaved')}</span>}
        <button className="btn" onClick={() => void save()} disabled={busy || running} title="Ctrl+S">
          <Save size={14} /> {t('common.save')}
        </button>
        {running ? (
          <button className="btn danger" onClick={() => jobId && void api.jobs.cancel(jobId)}>
            <Stop size={14} /> {t('jobs.cancel')}
          </button>
        ) : (
          <button className="btn primary" onClick={() => void startRun()} disabled={busy || !!problem} title={problem ?? undefined}>
            <Play size={14} /> {t('jobs.run')}
          </button>
        )}
      </div>
      {running && progress && (
        <div className="job-progress">
          <span className="spinner" /> {t('jobs.progress', num(progress.rowsRead), num(progress.rowsWritten))}
        </div>
      )}
      <div className="job-body">
        <section>
          <h3>{t('jobs.source')}</h3>
          <SourceEditor
            source={config.source}
            project={project}
            savedQueries={savedQueries}
            connections={connections}
            onChange={setSource}
          />
        </section>

        <section>
          <h3>{t('jobs.columns')}</h3>
          <ColumnsEditor
            columns={config.columns}
            sourceCols={sourceCols}
            onLoad={async () => {
              try {
                const cols = await api.jobs.sourceColumns(config.source)
                setSourceCols(cols)
                return cols
              } catch (e) {
                notify((e as Error).message, 'error')
                return null
              }
            }}
            onChange={(columns) => update({ columns })}
          />
        </section>

        <section>
          <h3>{t('jobs.destination')}</h3>
          <DestinationEditor destination={config.destination} connections={connections} onChange={setDest} onKind={(destination) => update({ destination })} notify={notify} />
          <div className="form-grid job-grid">
            <label>{t('jobs.batchSize')}</label>
            <div className="row">
              <input type="number" min={1} max={10000} value={config.batchSize} onChange={(e) => update({ batchSize: Number(e.target.value) || DEFAULT_BATCH })} style={{ width: 100 }} />
              <span className="muted small">{t('jobs.batchHint')}</span>
            </div>
          </div>
        </section>

        <section>
          <div className="job-runs-head">
            <h3>{t('jobs.runs')}</h3>
            <button className="icon-btn" title={t('common.refresh')} onClick={loadRuns}>
              <Refresh size={14} />
            </button>
          </div>
          {runs.length === 0 ? (
            <p className="muted small">{t('jobs.noRuns')}</p>
          ) : (
            <table className="job-runs">
              <thead>
                <tr>
                  <th />
                  <th>{t('jobs.runStarted')}</th>
                  <th>{t('jobs.runDuration')}</th>
                  <th className="num">{t('jobs.runRead')}</th>
                  <th className="num">{t('jobs.runWritten')}</th>
                  <th>{t('jobs.runTarget')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {confirm && jobId && (
        <div className="modal-backdrop" onMouseDown={() => setConfirm(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && setConfirm(false)}>
            <h2>{t('jobs.confirmTitle')}</h2>
            <div className="form-grid">
              <label>{t('jobs.source')}</label>
              <span>{describeSource(config.source, savedQueries, connections, project)}</span>
              <label>{t('jobs.destination')}</label>
              <span>
                {describeDestination(config.destination, connections)}
                {config.destination.kind === 'database' && <span className="muted"> · {t(`jobs.mode.${config.destination.mode}`)}</span>}
              </span>
            </div>
            {toProd && (
              <div className="status-box err">
                <AlertTriangle size={14} /> {t('jobs.prodWarning', destConn!.name)}
              </div>
            )}
            <div className="modal-actions">
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => setConfirm(false)}>
                {t('common.cancel')}
              </button>
              <button className={'btn ' + (toProd ? 'danger-solid' : 'primary')} autoFocus onClick={() => void run(jobId)}>
                <Play size={14} /> {toProd ? t('jobs.runProd') : t('jobs.run')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function RunRow({ run }: { run: JobRun }) {
  const [open, setOpen] = useState(false)
  const failed = run.status === 'error' || run.status === 'cancelled'
  return (
    <>
      <tr className={failed ? 'clickable' : ''} onClick={() => failed && setOpen((o) => !o)}>
        <td>
          <StatusDot run={run} running={run.status === 'running'} />
        </td>
        <td>{when(run.startedAt)}</td>
        <td>{duration(run)}</td>
        <td className="num">{num(run.rowsRead)}</td>
        <td className="num">{num(run.rowsWritten)}</td>
        <td className="job-run-target" title={run.target}>
          {failed ? <span className="job-run-error">{run.error}</span> : run.target}
        </td>
      </tr>
      {open && (
        <tr className="job-run-detail">
          <td />
          <td colSpan={5}>
            <div className="status-box err">
              {run.error}
              {run.failedRow && `\n\n${t('jobs.failedRow', run.failedRowNumber ?? '?')}\n${JSON.stringify(JSON.parse(run.failedRow), null, 2)}`}
              {`\n\n${t('jobs.runTarget')}: ${run.target}`}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function describeSource(s: JobSource, saved: SavedQuery[], connections: ConnectionInfo[], project?: Project): string {
  if (s.kind === 'table') {
    const c = connections.find((x) => x.id === s.connectionId)
    return `${c?.name ?? '?'} / ${[s.database, s.schema, s.table].filter(Boolean).join('.')}`
  }
  const q = saved.find((x) => x.id === s.savedQueryId)
  const alias = q?.aliasId ? project?.aliases.find((a) => a.id === q.aliasId) : undefined
  const env = s.env ?? project?.defaultEnv
  const where = alias ? `${alias.name} (${env})` : (connections.find((c) => c.id === q?.connectionId)?.name ?? '?') + (q?.database ? ` / ${q.database}` : '')
  return `${q?.title ?? '?'} · ${where}`
}

/** Prva greška koja sprječava spremanje (ili undefined). */
function validate(name: string, c: DataJobConfig): string | undefined {
  if (!name.trim()) return t('jobs.err.name')
  if (c.source.kind === 'query' ? !c.source.savedQueryId : !c.source.connectionId || !c.source.database || !c.source.table) return t('jobs.err.source')
  if (c.columns.some((x) => !x.target.trim())) return t('jobs.err.columnName')
  const d = c.destination
  if (d.kind === 'database') {
    if (!d.connectionId || !d.database || !d.table.trim()) return t('jobs.err.destination')
    if (d.mode === 'upsert' && d.keyColumns.length === 0) return t('jobs.err.keys')
  } else {
    if (!d.folder) return t('jobs.err.folder')
    if (!d.fileName.trim()) return t('jobs.err.fileName')
  }
  return undefined
}

// ---------- Dijelovi forme ----------

function useDatabases(connectionId: string | undefined) {
  const [dbs, setDbs] = useState<string[]>([])
  useEffect(() => {
    if (!connectionId) return setDbs([])
    let cancelled = false
    api.explorer.databases(connectionId).then(
      (d) => !cancelled && setDbs(d),
      () => !cancelled && setDbs([])
    )
    return () => {
      cancelled = true
    }
  }, [connectionId])
  return dbs
}

function useTables(connectionId: string | undefined, database: string | undefined, views = false) {
  const [objs, setObjs] = useState<DbObject[]>([])
  useEffect(() => {
    if (!connectionId || !database) return setObjs([])
    let cancelled = false
    api.explorer.objects(connectionId, database).then(
      (o) => !cancelled && setObjs(o.filter((x) => x.kind === 'table' || (views && x.kind === 'view'))),
      () => !cancelled && setObjs([])
    )
    return () => {
      cancelled = true
    }
  }, [connectionId, database, views])
  return objs
}

function ConnectionSelect({ value, connections, onChange }: { value: string; connections: ConnectionInfo[]; onChange(id: string): void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('jobs.chooseConnection')}</option>
      {connections.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
          {c.environment ? ` (${c.environment})` : ''}
        </option>
      ))}
    </select>
  )
}

function SourceEditor({
  source,
  project,
  savedQueries,
  connections,
  onChange
}: {
  source: JobSource
  project?: Project
  savedQueries: SavedQuery[]
  connections: ConnectionInfo[]
  onChange(s: JobSource): void
}) {
  const dbs = useDatabases(source.kind === 'table' ? source.connectionId : undefined)
  const tables = useTables(source.kind === 'table' ? source.connectionId : undefined, source.kind === 'table' ? source.database : undefined, true)
  const query = source.kind === 'query' ? savedQueries.find((q) => q.id === source.savedQueryId) : undefined
  const alias = query?.aliasId ? project?.aliases.find((a) => a.id === query.aliasId) : undefined
  const dialect = connections.find((c) => c.id === (alias ? alias.targets[0]?.connectionId : query?.connectionId))?.type
  const names = useMemo(() => (query ? paramNames(query.sql, dialect ?? 'generic') : []), [query, dialect])

  return (
    <div className="form-grid job-grid">
      <label>{t('jobs.sourceKind')}</label>
      <div className="checks">
        <label>
          <input type="radio" checked={source.kind === 'query'} onChange={() => onChange({ kind: 'query', savedQueryId: 0 })} /> {t('jobs.sourceQuery')}
        </label>
        <label>
          <input type="radio" checked={source.kind === 'table'} onChange={() => onChange({ kind: 'table', connectionId: '', database: '', table: '' })} /> {t('jobs.sourceTable')}
        </label>
      </div>
      {source.kind === 'query' ? (
        <>
          <label>{t('jobs.query')}</label>
          <select value={source.savedQueryId || ''} onChange={(e) => onChange({ kind: 'query', savedQueryId: Number(e.target.value), env: source.env })}>
            <option value="">{savedQueries.length ? t('jobs.chooseQuery') : t('jobs.noQueries')}</option>
            {savedQueries.map((q) => (
              <option key={q.id} value={q.id}>
                {q.folder ? `${q.folder} / ` : ''}
                {q.title}
              </option>
            ))}
          </select>
          {alias && (
            <>
              <label>{t('jobs.env')}</label>
              <div className="row">
                <select value={source.env ?? project?.defaultEnv ?? 'dev'} onChange={(e) => onChange({ ...source, env: e.target.value as Environment })}>
                  {ENVIRONMENTS.filter((env) => alias.targets.some((x) => x.env === env)).map((env) => (
                    <option key={env} value={env}>
                      {env}
                    </option>
                  ))}
                </select>
                <span className="muted small">{t('jobs.aliasHint', alias.name)}</span>
              </div>
            </>
          )}
          {names.map((n) => {
            const v: ParamValue = source.params?.[n] ?? { value: '', type: 'auto' }
            const set = (patch: Partial<ParamValue>) => onChange({ ...source, params: { ...source.params, [n]: { ...v, ...patch } } })
            return (
              <FragmentRow key={n} label={`:${n}`}>
                <div className="row">
                  <input value={v.value} disabled={v.type === 'null'} onChange={(e) => set({ value: e.target.value })} />
                  <select value={v.type} onChange={(e) => set({ type: e.target.value as ParamType })} title={t('params.typeTitle')}>
                    {PARAM_TYPES.map((pt) => (
                      <option key={pt} value={pt}>
                        {pt === 'auto' ? 'auto' : pt === 'null' ? 'NULL' : t(`params.${pt}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </FragmentRow>
            )
          })}
        </>
      ) : (
        <>
          <label>{t('jobs.connection')}</label>
          <ConnectionSelect value={source.connectionId} connections={connections} onChange={(connectionId) => onChange({ ...source, connectionId, database: '', table: '' })} />
          <label>{t('jobs.database')}</label>
          <select value={source.database} onChange={(e) => onChange({ ...source, database: e.target.value, table: '' })}>
            <option value="" />
            {dbs.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
          <label>{t('jobs.table')}</label>
          <select
            value={source.table ? `${source.schema ?? ''}\u0000${source.table}` : ''}
            onChange={(e) => {
              const [schema, table] = e.target.value.split('\u0000')
              onChange({ ...source, schema: schema || undefined, table })
            }}
          >
            <option value="" />
            {tables.map((o) => (
              <option key={`${o.schema}.${o.name}`} value={`${o.schema ?? ''}\u0000${o.name}`}>
                {o.schema ? `${o.schema}.` : ''}
                {o.name}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  )
}

/** Labela + polje kao dva elementa grida. */
function FragmentRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <label>{label}</label>
      {children}
    </>
  )
}

function ColumnsEditor({
  columns,
  sourceCols,
  onLoad,
  onChange
}: {
  columns: JobColumn[]
  sourceCols: ResultColumn[] | null
  onLoad(): Promise<ResultColumn[] | null>
  onChange(c: JobColumn[]): void
}) {
  const [loading, setLoading] = useState(false)
  const all = columns.length === 0
  const load = async () => {
    setLoading(true)
    const cols = await onLoad()
    setLoading(false)
    return cols
  }
  const set = (i: number, patch: Partial<JobColumn>) => onChange(columns.map((c, k) => (k === i ? { ...c, ...patch } : c)))
  const sourceNames = sourceCols?.map((c) => c.name) ?? [...new Set(columns.map((c) => c.source).filter((x): x is string => !!x))]

  return (
    <div className="job-columns">
      <div className="row">
        <label className="inline-check">
          <input
            type="checkbox"
            checked={all}
            onChange={async (e) => {
              if (e.target.checked) return onChange([])
              const cols = sourceCols ?? (await load())
              if (cols?.length) onChange(cols.map((c) => ({ target: c.name, source: c.name })))
            }}
          />{' '}
          {t('jobs.allColumns')}
        </label>
        <button className="btn small-btn" onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spinner" /> : null} {t('jobs.loadColumns')}
        </button>
        {sourceCols && <span className="muted small">{sourceCols.map((c) => c.name + (c.type ? ` ${c.type}` : '')).join(', ')}</span>}
      </div>
      {!all && (
        <table className="job-mapping">
          <thead>
            <tr>
              <th>{t('jobs.targetColumn')}</th>
              <th>{t('jobs.sourceColumn')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {columns.map((c, i) => (
              <tr key={i}>
                <td>
                  <input value={c.target} onChange={(e) => set(i, { target: e.target.value })} />
                </td>
                <td>
                  <div className="row">
                    <select
                      value={c.source === undefined ? '\u0000' : c.source}
                      onChange={(e) => set(i, e.target.value === '\u0000' ? { source: undefined, constant: c.constant ?? '' } : { source: e.target.value, constant: undefined })}
                    >
                      {sourceNames.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                      {c.source !== undefined && !sourceNames.includes(c.source) && <option value={c.source}>{c.source}</option>}
                      <option value={'\u0000'}>{t('jobs.constant')}</option>
                    </select>
                    {c.source === undefined && <input value={c.constant ?? ''} placeholder={t('jobs.constantValue')} onChange={(e) => set(i, { constant: e.target.value })} />}
                  </div>
                </td>
                <td>
                  <button className="icon-btn" title={t('common.delete')} onClick={() => onChange(columns.filter((_, k) => k !== i))}>
                    <Trash size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!all && (
        <button className="btn small-btn" onClick={() => onChange([...columns, { target: '', source: sourceNames[0] }])}>
          <Plus size={13} /> {t('jobs.addColumn')}
        </button>
      )}
    </div>
  )
}

function DestinationEditor({
  destination: d,
  connections,
  onChange,
  onKind,
  notify
}: {
  destination: JobDestination
  connections: ConnectionInfo[]
  onChange(patch: Partial<JobDatabaseTarget> | Partial<JobFileTarget>): void
  onKind(d: JobDestination): void
  notify(text: string, kind?: 'error' | 'info'): void
}) {
  const db = d.kind === 'database' ? d : undefined
  const dbs = useDatabases(db?.connectionId)
  const tables = useTables(db?.connectionId, db?.database)
  const [keys, setKeys] = useState(db?.keyColumns.join(', ') ?? '')

  return (
    <div className="form-grid job-grid">
      <label>{t('jobs.destKind')}</label>
      <div className="checks">
        <label>
          <input
            type="radio"
            checked={d.kind === 'database'}
            onChange={() => onKind({ kind: 'database', connectionId: '', database: '', table: '', mode: 'insert', keyColumns: [], createTable: true, transaction: 'all' })}
          />{' '}
          {t('jobs.destDatabase')}
        </label>
        <label>
          <input type="radio" checked={d.kind === 'file'} onChange={() => onKind(emptyJobConfig().destination)} /> {t('jobs.destFile')}
        </label>
      </div>
      {d.kind === 'database' ? (
        <>
          <label>{t('jobs.connection')}</label>
          <ConnectionSelect value={d.connectionId} connections={connections} onChange={(connectionId) => onChange({ connectionId, database: '' })} />
          <label>{t('jobs.database')}</label>
          <select value={d.database} onChange={(e) => onChange({ database: e.target.value })}>
            <option value="" />
            {dbs.map((x) => (
              <option key={x}>{x}</option>
            ))}
            {d.database && !dbs.includes(d.database) && <option>{d.database}</option>}
          </select>
          <label>{t('jobs.table')}</label>
          <div className="row">
            <input value={d.schema ?? ''} placeholder={t('jobs.schema')} style={{ width: 110 }} onChange={(e) => onChange({ schema: e.target.value || undefined })} />
            <input
              list="job-dest-tables"
              value={d.table}
              placeholder={t('jobs.tablePlaceholder')}
              onChange={(e) => {
                const v = e.target.value
                const match = tables.find((o) => `${o.schema ? o.schema + '.' : ''}${o.name}` === v)
                onChange(match ? { schema: match.schema, table: match.name } : { table: v })
              }}
            />
            <datalist id="job-dest-tables">
              {tables.map((o) => (
                <option key={`${o.schema}.${o.name}`} value={`${o.schema ? o.schema + '.' : ''}${o.name}`} />
              ))}
            </datalist>
          </div>
          <label />
          <label className="inline-check">
            <input type="checkbox" checked={d.createTable} onChange={(e) => onChange({ createTable: e.target.checked })} /> {t('jobs.createTable')}
          </label>
          <label>{t('jobs.writeMode')}</label>
          <div className="row">
            <select value={d.mode} onChange={(e) => onChange({ mode: e.target.value as JobDatabaseTarget['mode'] })}>
              {(['insert', 'upsert', 'replace'] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`jobs.mode.${m}`)}
                </option>
              ))}
            </select>
            <span className="muted small">{t(`jobs.modeHint.${d.mode}`)}</span>
          </div>
          {d.mode === 'upsert' && (
            <>
              <label>{t('jobs.keys')}</label>
              <div className="row">
                <input
                  value={keys}
                  placeholder="id"
                  onChange={(e) => {
                    setKeys(e.target.value)
                    onChange({ keyColumns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
                  }}
                />
                <span className="muted small">{t('jobs.keysHint')}</span>
              </div>
            </>
          )}
          <label>{t('jobs.transaction')}</label>
          <select value={d.transaction} onChange={(e) => onChange({ transaction: e.target.value as JobDatabaseTarget['transaction'] })}>
            <option value="all">{t('jobs.tx.all')}</option>
            <option value="batch">{t('jobs.tx.batch')}</option>
          </select>
        </>
      ) : (
        <>
          <label>{t('jobs.format')}</label>
          <div className="row">
            <select value={d.format} onChange={(e) => onChange({ format: e.target.value as JobFileTarget['format'] })}>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
              <option value="xlsx">Excel (XLSX)</option>
            </select>
            {d.format === 'csv' && (
              <select value={d.delimiter ?? ';'} onChange={(e) => onChange({ delimiter: e.target.value as JobFileTarget['delimiter'] })} title={t('jobs.delimiter')}>
                <option value=";">; {t('jobs.semicolon')}</option>
                <option value=",">, {t('jobs.comma')}</option>
                <option value={'\t'}>{t('jobs.tab')}</option>
              </select>
            )}
          </div>
          <label>{t('jobs.folder')}</label>
          <div className="row">
            <input value={d.folder} readOnly placeholder={t('jobs.noFolder')} title={d.folder} style={{ width: 340 }} />
            <button
              className="btn"
              onClick={async () => {
                try {
                  const f = await api.jobs.chooseFolder()
                  if (f) onChange({ folder: f })
                } catch (e) {
                  notify((e as Error).message, 'error')
                }
              }}
            >
              <Folder size={14} /> {t('jobs.chooseFolder')}
            </button>
          </div>
          <label>{t('jobs.fileName')}</label>
          <div className="row">
            <input value={d.fileName} onChange={(e) => onChange({ fileName: e.target.value })} />
            <span className="muted small">{t('jobs.fileNameHint')}</span>
          </div>
          <label>{t('jobs.ifExists')}</label>
          <select value={d.ifExists} onChange={(e) => onChange({ ifExists: e.target.value as JobFileTarget['ifExists'] })}>
            <option value="overwrite">{t('jobs.overwrite')}</option>
            <option value="new">{t('jobs.newFile')}</option>
          </select>
        </>
      )}
    </div>
  )
}
