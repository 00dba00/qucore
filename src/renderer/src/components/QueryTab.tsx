import { Bookmark, CodeBlock } from '@vectilume/react'
import { useContextMenu, type MenuEntry } from './ContextMenu'
import { SnippetsDialog } from './SnippetsDialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { api } from '../api'
import { monaco } from '../monaco'
import { setModelContext } from '../completion'
import { formatEditor } from '../formatting'
import { MONACO_LANGUAGE, ident } from '../dialect'
import type {
  RunInfo,
  ConnectionInfo,
  DbObject,
  Environment,
  ExecuteOptions,
  FetchMode,
  ParamValue,
  Project,
  ProjectAlias,
  QueryResult,
  ResultSet,
  RunAnomaly,
  QueryPlan,
  TextEncodingName,
  TxAction,
  TxState
} from '../../../shared/types'
import { paramNames, substituteParams } from '../../../core/params'
import { rows } from '../../../core/util'
import { findUnboundedWrites } from '../../../core/guard'
import { statementAt } from '../../../core/statements'
import { MAX_ROWS_OPTIONS, getSettings, useSettings } from '../settings'
import { analyzeSql } from '../../../core/sqlRefs'
import { ParamsDialog } from './ParamsDialog'
import { GuardDialog, hasIssues, type GuardIssues } from './GuardDialog'
import { ResultsGrid, type GridHandle } from './ResultsGrid'
import { PlanView } from './PlanView'
import { toCsv, toInserts, toJson, toMarkdown } from '../../../core/resultFormats'
import { buildXlsx } from '../../../core/xlsx'
import { EditPreview } from './EditPreview'
import {
  emptyPending,
  pendingCount,
  resolveEditContext,
  toRowEdits,
  type EditContext,
  type Pending,
  type SourceTable
} from '../editing'
import { Icon } from './Icons'
import { num, rich, t } from '../i18n'

export interface TabData {
  id: string
  /** Vrsta taba; bez vrijednosti je SQL upit. */
  kind?: 'query' | 'diagram' | 'guide' | 'table' | 'job'
  /** Tab posla prijenosa podataka: spremljeni posao (bez id-a = novi) i njegov projekt. */
  jobId?: number
  jobProjectId?: number
  title: string
  connectionId?: string
  database?: string
  initialSql: string
  runOnOpen?: boolean
  /** Tab otvoren iz Explorera za tablicu — omogućuje uređivanje podataka. */
  source?: SourceTable
  /** Spremljeni query koji je otvoren ili spremljen u ovom tabu (Ctrl+S ga ažurira). */
  savedQueryId?: number
  /** Tab vezan na alias projekta: konekcija/baza slijede odabrano okruženje. */
  alias?: { aliasId: number; env: Environment }
  /** Vrijednosti varijabli za prvo izvršavanje (tab otvoren iz povijesti). */
  params?: Record<string, ParamValue>
  /** Položaj kursora pri otvaranju (vraćeni tab nakon ponovnog pokretanja). */
  cursor?: { lineNumber: number; column: number }
  /** Vraćeni dijagram se učitava tek kad se tab prvi put aktivira. */
  lazy?: boolean
  /** false: ručne transakcije (Commit/Rollback u toolbaru). Zadano uključeno. */
  autoCommit?: boolean
  /** Na sesiji taba je otvorena transakcija (za potvrdu pri zatvaranju; ne sprema se). */
  txOpen?: boolean
  /** Tab vezan na .sql datoteku: Ctrl+S sprema u nju; savedText = sadržaj zadnjeg spremanja/otvaranja. */
  file?: { path: string; name: string; encoding: TextEncodingName; savedText: string }
  /** Tekst se razlikuje od datoteke (oznaka ● i pitanje pri zatvaranju). */
  dirty?: boolean
  /** Tab tablice: objekt, odabrana podkartica i hoće li se Podaci izvršiti pri prvom otvaranju. */
  object?: DbObject
  sub?: 'columns' | 'data' | 'indexes' | 'fks' | 'ddl'
  dataRunOnOpen?: boolean
}

/** Alias i njegov projekt po id-u aliasa. */
export function findAlias(projects: Project[], aliasId: number): { project: Project; alias: ProjectAlias } | undefined {
  for (const project of projects) {
    const alias = project.aliases.find((a) => a.id === aliasId)
    if (alias) return { project, alias }
  }
  return undefined
}

export interface EditorHandle {
  insert(text: string): void
  focus(): void
  /** Cijeli tekst editora. */
  getText(): string
  /** Zamjenjuje cijeli tekst (jedan korak za Ctrl+Z). */
  setText(text: string): void
  /** Položaj kursora (za vraćanje tabova). */
  getCursor(): { lineNumber: number; column: number } | null
  /** Commit/Rollback otvorene transakcije (pri zatvaranju taba); false ako nije uspjelo. */
  transaction(action: TxAction): Promise<boolean>
}

/** Trajanje otvorene transakcije: m:ss ili h:mm:ss. */
function formatClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

interface Props {
  tab: TabData
  active: boolean
  connections: ConnectionInfo[]
  onChange(patch: Partial<TabData>): void
  registerEditor(tabId: string, h: EditorHandle | null): void
  /** Poziva se nakon svakog izvršavanja (osvježava povijest). */
  onExecuted?(): void
  /** Aktivni projekt — zapisuje se uz izvršavanje. */
  projectId?: number
  /** Korisnik je prihvatio prijedlog "Spremiti ga?". */
  onSuggestSave?(): void
  /** Projekti — za aliase. */
  projects?: Project[]
  notify?(text: string, kind?: 'error' | 'info'): void
}

const dbCache = new Map<string, Promise<string[]>>()

/**
 * Poziva execute/fetchMore i dok traje gradi živi rezultat iz dojava napretka.
 * base: već prikazani setovi (nastavak upita) — dojave se nadovezuju na njih.
 */
async function streamResult(
  sid: string,
  base: ResultSet[],
  call: () => Promise<QueryResult>,
  onLive: (sets: ResultSet[], first: boolean) => void
): Promise<QueryResult> {
  const live = [...base]
  let first = base.length === 0
  const off = api.query.onProgress(sid, (p) => {
    for (const d of p.sets) {
      const prev = live[d.index]
      live[d.index] = {
        columns: prev?.columns ?? d.columns ?? [],
        rows: prev ? prev.rows.concat(d.rows) : d.rows,
        totalRows: d.totalRows,
        truncated: d.truncated,
        hasMore: d.hasMore
      }
    }
    onLive([...live], first)
    first = false
  })
  try {
    return await call()
  } finally {
    off()
  }
}

/** Nastavak zadržava već prikazane retke (i njihove reference, na koje se vežu izmjene u gridu) i kolone. */
function mergeContinuation(base: ResultSet[], r: QueryResult): QueryResult {
  return {
    ...r,
    resultSets: r.resultSets.map((set, i) => {
      const old = base[i]
      if (!old || old.rows.length > set.rows.length) return set
      return { ...set, columns: old.columns, rows: old.rows.concat(set.rows.slice(old.rows.length)) }
    })
  }
}

/** Kratko istakne izvršenu naredbu u editoru (Ctrl+Enter bez označenog teksta). */
function flashRange(ed: monaco.editor.IStandaloneCodeEditor, start: number, end: number) {
  const model = ed.getModel()
  if (!model) return
  const a = model.getPositionAt(start)
  const b = model.getPositionAt(end)
  const deco = ed.createDecorationsCollection([
    { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), options: { className: 'run-flash' } }
  ])
  setTimeout(() => deco.clear(), 700)
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`
}

export function QueryTab({ tab, active, connections, onChange, registerEditor, onExecuted, projectId, onSuggestSave, projects = [], notify }: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const sessionRef = useRef<{ id: string; key: string } | null>(null)
  /** Otvorena transakcija na sesiji taba: stanje, od kada i koliko izvršavanja je u njoj. */
  const [tx, setTxState] = useState<{ state: 'open' | 'failed'; since: number; count: number } | null>(null)
  const txRef = useRef(tx)
  const setTx = (v: typeof tx) => {
    txRef.current = v
    setTxState(v)
  }
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!tx) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [!!tx])
  useEffect(() => {
    if (!!tx !== !!tab.txOpen) onChange({ txOpen: !!tx })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!tx])
  /** Promjena konekcije/baze zatvara sesiju, a time i otvorenu transakciju. */
  const leaveTx = () =>
    !txRef.current ||
    confirm(t('q.leaveTx'))
  const [databases, setDatabases] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [resultTab, setResultTab] = useState(0)
  const settings = useSettings()
  const [maxRows, setMaxRows] = useState(() => getSettings().defaultMaxRows)
  /** Veličina stranice pauziranog upita (Max redaka u trenutku izvršavanja). */
  const [pageSize, setPageSize] = useState(10000)
  const [split, setSplit] = useState(0.45)
  const [editInfo, setEditInfo] = useState<{ ctx?: EditContext; reason?: string } | null>(null)
  const [pending, setPending] = useState<Pending>(emptyPending)
  const [preview, setPreview] = useState<string[] | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  /** Prijedlog spremanja često pokretanog queryja; "Kasnije" ga skriva za taj fingerprint u ovom tabu. */
  const [suggest, setSuggest] = useState<RunInfo | null>(null)
  const laterRef = useRef(new Set<string>())
  /** Forma za varijable prije izvršavanja. */
  const [paramsReq, setParamsReq] = useState<{ text: string; names: string[] } | null>(null)
  /** Potvrda prije izvršavanja (prod, bez WHERE, kriva baza). */
  const [guardReq, setGuardReq] = useState<{ text: string; params?: Record<string, ParamValue>; issues: GuardIssues } | null>(null)
  /** "Ne pitaj više u ovom tabu" za krivu bazu. */
  const skipWrongDbRef = useRef(false)
  /** Upozorenje: izvršavanje bitno sporije ili prazno u odnosu na dosadašnja. */
  const [anomaly, setAnomaly] = useState<{ a: RunAnomaly; durationMs: number } | null>(null)
  const paramsOpen = useRef(false)
  paramsOpen.current = !!paramsReq || !!guardReq
  /** Gumb Kopiraj: funkcija iz grida i kratka potvrda ("Kopirano N redaka"). */
  const gridRef = useRef<GridHandle | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const flashCopied = (text: string) => {
    setCopied(text)
    setTimeout(() => setCopied(null), 2000)
  }
  const copyResult = async () => {
    try {
      const n = (await gridRef.current?.copyAll()) ?? 0
      flashCopied(t('q.copiedRows', n))
    } catch {
      flashCopied(t('q.copyFailed'))
    }
  }
  /** Zadnji izvršeni SQL (za naziv tablice kod kopiranja kao INSERT). */
  const lastRunRef = useRef('')
  /** Dijalog snippeta; body = označeni tekst za novi snippet. */
  const [snippetsDlg, setSnippetsDlg] = useState<{ body?: string } | null>(null)
  const openMenu = useContextMenu()

  /** Toolbar Snippeti: popis (projekt + globalni) ubacuje na kursor; spremanje označenog; uređivanje. */
  const openSnippets = async (e: React.MouseEvent) => {
    const at = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} } as unknown as React.MouseEvent
    const ed = editorRef.current
    const sel = ed?.getSelection()
    const selected = ed && sel && !sel.isEmpty() ? ed.getModel()!.getValueInRange(sel) : ''
    const list = await api.snippets.list(projectId ?? null).catch(() => [])
    const items: MenuEntry[] = list.map((s) => ({
      label: s.name + (s.projectId === null ? '' : ' ·'),
      onClick: () => {
        if (!ed) return
        ed.executeEdits('snippet', [{ range: ed.getSelection()!, text: s.body, forceMoveMarkers: true }])
        ed.focus()
      }
    }))
    if (!items.length) items.push({ label: t('q.noSnippets'), disabled: true, onClick: () => {} })
    items.push('separator')
    items.push({ label: t('q.saveSnippet'), disabled: !selected.trim(), onClick: () => setSnippetsDlg({ body: selected }) })
    items.push({ label: t('q.editSnippets'), onClick: () => setSnippetsDlg({}) })
    openMenu(at, items)
  }
  const changes = pendingCount(pending)
  const containerRef = useRef<HTMLDivElement>(null)

  const conn = connections.find((c) => c.id === tab.connectionId)
  const sessionKey = `${tab.connectionId ?? ''}/${tab.database ?? ''}`

  // Popis baza za odabranu konekciju.
  useEffect(() => {
    if (!tab.connectionId) return setDatabases([])
    let p = dbCache.get(tab.connectionId)
    if (!p) {
      p = api.explorer.databases(tab.connectionId)
      p.catch(() => dbCache.delete(tab.connectionId!))
      dbCache.set(tab.connectionId, p)
    }
    let alive = true
    p.then((d) => alive && setDatabases(d)).catch(() => alive && setDatabases([]))
    return () => {
      alive = false
    }
  }, [tab.connectionId])

  // Promjena konekcije/baze → zatvori staru sesiju (nova se otvara pri sljedećem izvršavanju).
  useEffect(() => {
    const s = sessionRef.current
    if (s && s.key !== sessionKey) {
      sessionRef.current = null
      void api.query.closeSession(s.id).catch(() => {})
      setTx(null)
    }
    const model = editorRef.current?.getModel()
    if (model) {
      setModelContext(model, tab.connectionId, tab.database)
      if (conn) monaco.editor.setModelLanguage(model, MONACO_LANGUAGE[conn.type])
    }
  }, [sessionKey, conn, tab.connectionId, tab.database])

  // Zatvaranje taba → zatvori sesiju.
  useEffect(
    () => () => {
      const s = sessionRef.current
      if (s) void api.query.closeSession(s.id).catch(() => {})
    },
    []
  )

  useEffect(() => {
    if (!running) return
    const start = performance.now()
    const t = setInterval(() => setElapsed(performance.now() - start), 100)
    return () => clearInterval(t)
  }, [running])

  /**
   * scope 'statement' (Ctrl+Enter): bez označenog teksta izvršava samo naredbu pod kursorom;
   * 'all' (F5, Alt+X, gumb Izvrši): cijeli editor. Označeni tekst uvijek ima prednost.
   */
  const execute = useCallback(async (opts: { force?: boolean; text?: string; params?: Record<string, ParamValue>; confirmed?: boolean; scope?: 'statement' | 'all' } = {}) => {
    const ed = editorRef.current
    if (!ed || running || (paramsOpen.current && !opts.params && !opts.confirmed)) return
    if (!tab.connectionId) {
      setResult({ resultSets: [], messages: [{ kind: 'error', text: t('q.pickConnection') }], durationMs: 0, error: 'x' })
      return
    }
    const sel = ed.getSelection()
    const model = ed.getModel()!
    let text = opts.text ?? (sel && !sel.isEmpty() ? model.getValueInRange(sel) : model.getValue())
    const prefs = getSettings()
    if (opts.text === undefined && opts.scope === 'statement' && prefs.ctrlEnterScope === 'statement' && sel?.isEmpty()) {
      const st = statementAt(text, model.getOffsetAt(sel.getPosition()), conn?.type ?? 'generic', { blankLines: prefs.blankLineSplits })
      if (!st) return
      text = st.text
      flashRange(ed, st.start, st.end)
    }
    if (!text.trim()) return
    if (changes > 0 && !opts.force && !confirm(t('q.discardEdits', changes))) return

    // Varijable (:x, ${x}): prvo forma, pa izvršavanje sa zamijenjenim vrijednostima.
    const dialect = conn?.type ?? 'generic'
    const names = paramNames(text, dialect)
    const options: ExecuteOptions = { maxRows, savedQueryId: tab.savedQueryId, projectId }
    if (tab.autoCommit === false) options.autoCommit = false
    let runText = text
    if (names.length) {
      if (!opts.params) {
        setParamsReq({ text, names })
        return
      }
      try {
        runText = substituteParams(text, dialect, opts.params)
      } catch (e) {
        const msg = (e as Error).message
        setResult({ resultSets: [], messages: [{ kind: 'error', text: msg }], durationMs: 0, error: msg })
        setResultTab(-1)
        return
      }
      options.template = text
      options.params = Object.fromEntries(names.map((n) => [n, opts.params![n]]))
    }

    // Zaštita: pisanje na prod, UPDATE/DELETE bez WHERE i TRUNCATE (svugdje), spremljeni query na drugoj bazi.
    if (!opts.confirmed) {
      // Svaka zaštita se može isključiti u Postavkama (uz napomenu o riziku).
      const issues: GuardIssues = { unbounded: prefs.guardUnbounded ? findUnboundedWrites(runText, dialect) : [] }
      const target = `${conn?.name ?? '?'}${tab.database ? ' / ' + tab.database : ''}`
      if (prefs.guardProd && conn?.environment === 'prod') {
        const writes = analyzeSql(runText, dialect).types.filter((t) => t !== 'select')
        if (writes.length) issues.prod = { target, types: writes }
      }
      if (prefs.guardWrongDb && tab.savedQueryId && !tab.alias && !skipWrongDbRef.current) {
        const saved = await api.saved.get(tab.savedQueryId).catch(() => null)
        // Query spremljen bez baze radi na zadanoj bazi konekcije, pa se baza uspoređuje samo kad je zapisana.
        if (saved?.connectionId && (saved.connectionId !== tab.connectionId || (saved.database !== undefined && saved.database !== tab.database))) {
          const sc = connections.find((c) => c.id === saved.connectionId)
          issues.wrongDb = { saved: `${sc?.name ?? t('projects.deletedConnection')}${saved.database ? ' / ' + saved.database : ''}`, current: target }
        }
      }
      if (hasIssues(issues)) {
        setGuardReq({ text, params: opts.params, issues })
        return
      }
    }

    lastRunRef.current = runText
    setRunning(true)
    setElapsed(0)
    setPending(emptyPending())
    setEditInfo(null)
    try {
      if (!sessionRef.current || sessionRef.current.key !== sessionKey) {
        const s = await api.query.openSession(tab.connectionId, tab.database)
        sessionRef.current = { id: s.sessionId, key: sessionKey }
      }
      const sid = sessionRef.current.id
      setPageSize(maxRows)
      // Rezultat stiže u dijelovima: prvi retci se prikazuju dok upit još traje.
      const r = await streamResult(sid, [], () => api.query.execute(sid, runText, options), (sets, first) => {
        setResult({ resultSets: sets, messages: [], durationMs: 0 })
        if (first) setResultTab(0)
      })
      setResult(r)
      applyTx(r.tx, true)
      const info = r.runInfo
      setSuggest(prefs.suggestSave && info?.suggestSave && !laterRef.current.has(info.fingerprint) ? info : null)
      setAnomaly(prefs.runWarnings && info?.anomaly ? { a: info.anomaly, durationMs: r.durationMs } : null)
      // Prekinut upit zadržava primljene retke u gridu; greška vodi na poruke.
      const showGrid = r.resultSets.length > 0 && (!r.error || r.cancelled)
      setResultTab((t) => (showGrid ? (t >= 0 && t < r.resultSets.length ? t : 0) : -1))
      if (tab.source && !r.error && r.resultSets.length > 0 && tab.connectionId) {
        resolveEditContext(tab.connectionId, tab.database, tab.source, r.resultSets[0], r.resultSets.length)
          .then(setEditInfo)
          .catch((e) => setEditInfo({ reason: (e as Error).message }))
      }
    } catch (e) {
      const msg = (e as Error).message
      const messages: QueryResult['messages'] = [{ kind: 'error', text: msg }]
      if (txRef.current) messages.push({ kind: 'info', text: t('q.txRolledBackClose') })
      setResult({ resultSets: [], messages, durationMs: 0, error: msg })
      setSuggest(null)
      setAnomaly(null)
      setResultTab(-1)
      // Konekcija je možda pukla — zatvori sesiju (ne smije ostati otvorena s transakcijom), sljedeći put nova.
      const old = sessionRef.current
      sessionRef.current = null
      if (old) void api.query.closeSession(old.id).catch(() => {})
      setTx(null)
    } finally {
      setRunning(false)
      onExecuted?.()
    }
  }, [running, tab.connectionId, tab.database, tab.source, tab.savedQueryId, tab.alias, tab.autoCommit, projectId, sessionKey, maxRows, onExecuted, changes, conn, connections])

  /** Stanje transakcije iz rezultata; ranStatement = izvršen je upit (broji se u transakciji). */
  function applyTx(state: TxState | undefined, ranStatement: boolean) {
    if (!state || state === 'unknown') return
    const prev = txRef.current
    if (state === 'none') {
      if (prev && ranStatement) {
        const text = t('q.txClosed')
        setResult((r) => r && { ...r, messages: [...r.messages, { kind: 'info', text }] })
      }
      setTx(null)
    } else {
      setTx({ state, since: prev?.since ?? Date.now(), count: (prev?.count ?? 0) + (ranStatement ? 1 : 0) })
    }
  }

  /** Commit/Rollback iz toolbara ili pri zatvaranju taba. */
  const runTx = async (action: TxAction): Promise<boolean> => {
    const s = sessionRef.current
    if (!s) {
      setTx(null)
      return true
    }
    try {
      const state = await api.query.transaction(s.id, action)
      // Rollback zatvara i rezultat koji je čekao ostatak redaka.
      if (action === 'rollback') setResult((r) => r && (r.pending ? { ...r, pending: false } : r))
      setTx(state === 'open' || state === 'failed' ? { state, since: txRef.current?.since ?? Date.now(), count: txRef.current?.count ?? 0 } : null)
      notify?.(action === 'commit' ? t('q.committed') : t('q.rolledBack'))
      return true
    } catch (e) {
      notify?.((e as Error).message, 'error')
      return false
    }
  }
  const runTxRef = useRef(runTx)
  runTxRef.current = runTx

  // Alias: konekcija/baza taba prate odabrano okruženje; obrisan alias odvezuje tab.
  const aliasInfo = tab.alias ? findAlias(projects, tab.alias.aliasId) : undefined
  const aliasTarget = aliasInfo?.alias.targets.find((t) => t.env === tab.alias!.env)
  useEffect(() => {
    if (!tab.alias || !projects.length) return
    if (!aliasInfo || !aliasTarget) return onChange({ alias: undefined })
    if (aliasTarget.connectionId !== tab.connectionId || aliasTarget.database !== tab.database) {
      onChange({ connectionId: aliasTarget.connectionId, database: aliasTarget.database })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.alias, aliasInfo, aliasTarget?.connectionId, aliasTarget?.database, projects.length])

  // Spremljen tab više ne treba prijedlog.
  useEffect(() => {
    if (tab.savedQueryId) setSuggest(null)
  }, [tab.savedQueryId])

  const suggestLater = () => {
    if (suggest) laterRef.current.add(suggest.fingerprint)
    setSuggest(null)
  }
  const suggestNever = () => {
    if (suggest) void api.history.ignoreSuggestion(suggest.fingerprint)
    setSuggest(null)
  }

  const cancel = () => {
    if (sessionRef.current) void api.query.cancel(sessionRef.current.id)
  }

  /** Nastavak upita pauziranog na Max redaka. */
  const fetchMore = async (mode: FetchMode) => {
    const sid = sessionRef.current?.id
    if (!sid || !result?.pending || running) return
    const base = result.resultSets
    setRunning(true)
    setElapsed(0)
    try {
      const r = await streamResult(sid, base, () => api.query.fetchMore(sid, mode), (sets) =>
        setResult((prev) => prev && { ...prev, resultSets: sets, pending: false })
      )
      setResult(mergeContinuation(base, r))
      applyTx(r.tx, false)
      if (r.error && !r.cancelled) setResultTab(-1)
    } catch (e) {
      const msg = (e as Error).message
      setResult((prev) => prev && { ...prev, pending: false, error: msg, messages: [...prev.messages, { kind: 'error', text: msg }] })
      setResultTab(-1)
    } finally {
      setRunning(false)
    }
  }

  // Monaco komande se registriraju jednom, pa koristimo ref na zadnju verziju funkcije.
  const executeRef = useRef(execute)
  executeRef.current = execute
  /** Plan izvršavanja (kartica Plan): naredba pod kursorom ili označeno; analyze = stvarno izvrši (samo SELECT). */
  const [plan, setPlan] = useState<{ plan: QueryPlan; sql: string } | null>(null)
  const explain = async (analyze: boolean, sqlText?: string) => {
    const ed = editorRef.current
    if (!ed || running || !tab.connectionId) return
    let text = sqlText ?? ''
    if (!text) {
      const sel = ed.getSelection()
      const model = ed.getModel()!
      if (sel && !sel.isEmpty()) text = model.getValueInRange(sel)
      else if (sel) {
        const st = statementAt(model.getValue(), model.getOffsetAt(sel.getPosition()), conn?.type ?? 'generic', { blankLines: getSettings().blankLineSplits })
        if (!st) return notify?.(t('q.planCursor'))
        text = st.text
        flashRange(ed, st.start, st.end)
      }
    }
    if (paramNames(text, conn?.type ?? 'generic').length) {
      return notify?.(t('q.planParams'), 'error')
    }
    setRunning(true)
    setElapsed(0)
    try {
      if (!sessionRef.current || sessionRef.current.key !== sessionKey) {
        const s = await api.query.openSession(tab.connectionId, tab.database)
        sessionRef.current = { id: s.sessionId, key: sessionKey }
      }
      const p = await api.query.explain(sessionRef.current.id, text, analyze)
      setPlan({ plan: p, sql: text })
      // Pauzirani rezultat je zatvoren (sesija je slobodna za plan); prazan rezultat otvara donji panel.
      setResult((r) => (r ? (r.pending ? { ...r, pending: false } : r) : { resultSets: [], messages: [], durationMs: 0 }))
      setResultTab(-2)
    } catch (e) {
      notify?.(t('q.planError', (e as Error).message), 'error')
    } finally {
      setRunning(false)
    }
  }
  const explainRef = useRef(explain)
  explainRef.current = explain

  const fileRef = useRef(tab.file)
  fileRef.current = tab.file
  const dirtyRef = useRef(!!tab.dirty)
  dirtyRef.current = !!tab.dirty
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    const model = editor.getModel()!
    setModelContext(model, tab.connectionId, tab.database)
    if (conn) monaco.editor.setModelLanguage(model, MONACO_LANGUAGE[conn.type])
    // addAction, ne addCommand: addCommand veže prečac na zadnji montirani editor, pa bi s više
    // tabova Ctrl+Enter izvršio upit iz drugog taba.
    const key = (id: string, keybinding: number, run: () => void) =>
      editor.addAction({ id: `qucore.${id}`, label: id, keybindings: [keybinding], run })
    key('runStatement', monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void executeRef.current({ scope: 'statement' }))
    key('runStatementE', monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => void executeRef.current({ scope: 'statement' }))
    key('runAll', monaco.KeyMod.Alt | monaco.KeyCode.KeyX, () => void executeRef.current({ scope: 'all' }))
    key('explain', monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE, () => void explainRef.current(false))
    // F1 otvara vodič (umjesto Monacove palete naredbi).
    key('guide', monaco.KeyCode.F1, () => window.dispatchEvent(new Event('qucore:guide')))
    if (tab.cursor) {
      editor.setPosition(tab.cursor)
      editor.revealPositionInCenterIfOutsideViewport(tab.cursor)
    }
    // Tab datoteke: oznaka ● dok se tekst razlikuje od zadnjeg spremanja (vraćanje na isti tekst je briše).
    editor.onDidChangeModelContent(() => {
      const f = fileRef.current
      if (!f) return
      const dirty = editor.getValue() !== f.savedText
      if (dirty !== dirtyRef.current) {
        dirtyRef.current = dirty
        onChangeRef.current({ dirty })
      }
    })
    registerEditor(tab.id, {
      getCursor: () => editor.getPosition(),
      transaction: (action) => runTxRef.current(action),
      insert(text) {
        const sel = editor.getSelection()!
        editor.executeEdits('explorer', [{ range: sel, text, forceMoveMarkers: true }])
        editor.focus()
      },
      focus: () => editor.focus(),
      getText: () => editor.getValue(),
      setText: (text) => {
        const model = editor.getModel()
        if (!model) return
        editor.pushUndoStop()
        editor.executeEdits('restore', [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }])
        editor.pushUndoStop()
      }
    })
    if (active) editor.focus()
    if (tab.runOnOpen) {
      onChange({ runOnOpen: false })
      setTimeout(() => void executeRef.current(), 0)
    }
  }

  useEffect(() => () => registerEditor(tab.id, null), [tab.id, registerEditor])
  useEffect(() => {
    if (active) editorRef.current?.focus()
  }, [active])

  // F5 (globalno za aktivni tab — radi i kad je fokus u tablici rezultata) i Esc za prekid.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault()
        void executeRef.current({ scope: 'all' })
      } else if (e.key === 'Escape' && running) {
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const startSplit = (e: React.MouseEvent) => {
    e.preventDefault()
    const box = containerRef.current!.getBoundingClientRect()
    const move = (ev: MouseEvent) => setSplit(Math.min(0.9, Math.max(0.1, (ev.clientY - box.top) / box.height)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const rs = result && resultTab >= 0 ? result.resultSets[resultTab] : undefined

  const editTarget = editInfo?.ctx?.target
  const editLabel = editTarget ? (editTarget.schema ? `${editTarget.schema}.${editTarget.table}` : editTarget.table) : ''
  const openPreview = async () => {
    if (!result || !editInfo?.ctx || !tab.connectionId) return
    if (txRef.current) {
      // Spremanje ide preko zasebne veze i čekalo bi na retke koje drži transakcija ovog taba.
      alertInResults(t('q.editsTxOpen'))
      return
    }
    try {
      const edits = toRowEdits(result.resultSets[0], editInfo.ctx, pending)
      setPreview(await api.edits.preview(tab.connectionId, editInfo.ctx.target, edits))
    } catch (e) {
      alertInResults((e as Error).message)
    }
  }
  const applyEdits = async () => {
    if (!result || !editInfo?.ctx || !tab.connectionId) return
    const edits = toRowEdits(result.resultSets[0], editInfo.ctx, pending)
    const n = await api.edits.apply(tab.connectionId, editInfo.ctx.target, edits)
    setPreview(null)
    setPending(emptyPending())
    setSaved(t('q.savedRows', n))
    setTimeout(() => setSaved(null), 5000)
    // Osvježi prikaz iz baze (izmjene su već spremljene, pa nema pitanja o odbacivanju).
    setTimeout(() => void executeRef.current({ force: true }), 0)
  }
  const alertInResults = (text: string) =>
    setResult((r) => r && { ...r, messages: [...r.messages, { kind: 'error', text }] })
  /** Sprema datoteku (Electron pita gdje); naziv iz naslova taba. */
  const saveFile = (data: BlobPart, ext: string, type: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([data], { type }))
    a.download = `${tab.title.replace(/[^\w.-]+/g, '_') || t('q.resultFile')}.${ext}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  /**
   * Naziv tablice za INSERT: izvor taba (Explorer, uređivanje), inače jedina tablica iz upita,
   * inače naziv_tablice (s napomenom da ga treba zamijeniti).
   */
  const insertTable = (): string => {
    const d = conn?.type ?? 'mariadb'
    const q = (schema: string | undefined, table: string) => (schema ? ident(d, schema) + '.' : '') + ident(d, table)
    const src = editInfo?.ctx?.target ?? tab.source
    if (src) return q(src.schema, src.table)
    const refs = analyzeSql(lastRunRef.current, d).tables
    if (refs.length === 1) return q(refs[0].schema, refs[0].table)
    notify?.(t('q.tableUnknown', t('q.tablePlaceholder')))
    return t('q.tablePlaceholder')
  }

  /** Kopiraj kao: INSERT, JSON, Markdown, CSV — prikazani retci (sortirani, filtrirani). */
  const copyAs = (e: React.MouseEvent) => {
    const copy = async (label: string, make: () => string) => {
      const v = gridRef.current?.view()
      if (!v) return
      try {
        await navigator.clipboard.writeText(make())
        flashCopied(`${label}: ${rows(v.rows.length)} ✓`)
      } catch {
        flashCopied(t('q.copyFailed'))
      }
    }
    const view = () => gridRef.current!.view()
    openMenu(e, [
      {
        label: t('q.insertStatements'),
        disabled: !conn,
        onClick: () => void copy('INSERT', () => toInserts(view(), conn!.type, insertTable(), (n) => ident(conn!.type, n)))
      },
      { label: 'JSON', onClick: () => void copy('JSON', () => toJson(view())) },
      { label: t('q.markdownTable'), onClick: () => void copy('Markdown', () => toMarkdown(view())) },
      { label: 'CSV', onClick: () => void copy('CSV', () => toCsv(view()).replace(/^﻿/, '')) }
    ])
  }

  /** Export prikazanih redaka u datoteku. */
  const exportAs = (e: React.MouseEvent) => {
    const view = () => gridRef.current?.view()
    openMenu(e, [
      { label: 'CSV (.csv)', onClick: () => { const v = view(); if (v) saveFile(toCsv(v), 'csv', 'text/csv;charset=utf-8') } },
      {
        label: 'Excel (.xlsx)',
        onClick: () => {
          const v = view()
          if (v) saveFile(buildXlsx(v, tab.title), 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        }
      },
      { label: 'JSON (.json)', onClick: () => { const v = view(); if (v) saveFile(toJson(v), 'json', 'application/json') } }
    ])
  }

  return (
    <div className={'query-tab' + (conn?.environment === 'prod' ? ' prod' : '')} style={{ display: active ? 'flex' : 'none' }}>
      <div className="toolbar" style={conn?.color ? { boxShadow: `inset 0 -2px 0 ${conn.color}` } : undefined}>
        <button className="btn run" onClick={() => void execute({ scope: 'all' })} disabled={running} title={t('q.runTitle')}>
          <Icon name="play" /> {t('guard.run')}
        </button>
        <button className="btn" onClick={cancel} disabled={!running} title={t('q.cancelTitle')}>
          <Icon name="stop" /> {t('q.cancel')}
        </button>
        <button
          className="btn"
          onClick={() => editorRef.current && formatEditor(editorRef.current)}
          title={t('q.formatTitle')}
        >
          <Icon name="format" /> {t('q.format')}
        </button>
        <button
          className="btn"
          onClick={() => void explain(false)}
          disabled={running || !tab.connectionId}
          title={t('q.planTitle')}
        >
          <Icon name="diagram" /> Plan
        </button>
        <button className="btn" onClick={(e) => void openSnippets(e)} title={t('q.snippetsTitle')}>
          <CodeBlock size={14} /> {t('snippets.title')}
        </button>
        <span className="toolbar-sep" />
        {conn?.environment === 'prod' && (
          <span className="prod-badge" title={t('q.prodTitle')}>
            PROD
          </span>
        )}
        {aliasInfo && tab.alias ? (
          <span className="alias-bar" title={t('q.aliasTitle', aliasInfo.project.name)}>
            <span className="alias-chip">{aliasInfo.alias.name}</span>
            <select
              className={'env-select env-' + tab.alias.env}
              value={tab.alias.env}
              onChange={(e) => leaveTx() && onChange({ alias: { aliasId: tab.alias!.aliasId, env: e.target.value as Environment } })}
            >
              {aliasInfo.alias.targets.map((tg) => (
                <option key={tg.env} value={tg.env}>
                  {tg.env.toUpperCase()}
                </option>
              ))}
            </select>
            <span className="muted small alias-target">
              {conn?.name ?? '?'} / {tab.database}
            </span>
            <button className="link-btn" onClick={() => onChange({ alias: undefined })} title={t('q.unbindTitle')}>
              {t('q.unbind')}
            </button>
          </span>
        ) : (
          <>
        <select
          value={tab.connectionId ?? ''}
          onChange={(e) => {
            if (!leaveTx()) return
            const c = connections.find((x) => x.id === e.target.value)
            onChange({ connectionId: c?.id, database: c?.database })
          }}
        >
          <option value="">— {t('q.connection')} —</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={tab.database ?? ''}
          disabled={!tab.connectionId}
          onChange={(e) => leaveTx() && onChange({ database: e.target.value || undefined })}
        >
          <option value="">— {t('q.defaultDb')} —</option>
          {tab.database && !databases.includes(tab.database) && <option value={tab.database}>{tab.database}</option>}
          {databases.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
          </>
        )}
        <span className="toolbar-sep" />
        <label className="muted small">{t('q.maxRows')}</label>
        <select value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))}>
          {MAX_ROWS_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {num(n)}
            </option>
          ))}
        </select>
        <span className="toolbar-sep" />
        <label
          className="tx-toggle"
          title={t('q.autoCommitTitle')}
        >
          <input type="checkbox" checked={tab.autoCommit !== false} onChange={(e) => onChange({ autoCommit: e.target.checked })} />
          Auto-commit
        </label>
        {tx && (
          <>
            <span
              className={'tx-badge' + (tx.state === 'failed' ? ' failed' : Date.now() - tx.since > settings.txWarnMinutes * 60000 ? ' old' : '')}
              title={
                tx.state === 'failed'
                  ? t('q.txFailedTitle')
                  : t('q.txOpenTitle')
              }
            >
              {tx.state === 'failed' ? t('q.txFailed') : t('q.tx')} · {t('q.runsN', tx.count)} ·{' '}
              {formatClock(Date.now() - tx.since)}
            </span>
            <button className="btn tx-commit" disabled={running || tx.state === 'failed'} onClick={() => void runTx('commit')}>
              Commit
            </button>
            <button className="btn tx-rollback" disabled={running} onClick={() => void runTx('rollback')}>
              Rollback
            </button>
          </>
        )}
        <span style={{ flex: 1 }} />
        {running && (
          <span className="status running">
            <span className="spinner small" /> {formatMs(elapsed)}
          </span>
        )}
      </div>

      <div className="split" ref={containerRef}>
        <div className="editor-pane" style={{ height: `${split * 100}%` }}>
          <Editor
            defaultValue={tab.initialSql}
            defaultLanguage={conn ? MONACO_LANGUAGE[conn.type] : 'sql'}
            theme="studio-dark"
            onMount={onMount}
            options={{
              fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
              fontSize: 14,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 4,
              renderLineHighlight: 'all',
              wordBasedSuggestions: 'off',
              quickSuggestions: { other: true, comments: false, strings: false },
              suggestOnTriggerCharacters: true,
              fixedOverflowWidgets: true,
              acceptSuggestionOnEnter: 'smart'
            }}
          />
        </div>
        <div className="splitter" onMouseDown={startSplit} />
        <div className="results-pane">
          {result ? (
            <>
              <div className="result-tabs">
                {result.resultSets.map((r, i) => (
                  <button key={i} className={resultTab === i ? 'active' : ''} onClick={() => setResultTab(i)}>
                    {t('q.resultN', i + 1)}{' '}
                    <span className="muted">
                      ({r.hasMore ? `${num(r.rows.length)}+` : num(r.totalRows)})
                    </span>
                  </button>
                ))}
                <button className={(resultTab === -1 ? 'active' : '') + (result.error ? ' has-error' : '')} onClick={() => setResultTab(-1)}>
                  {t('q.messages')}{result.error ? ' ●' : ''}
                </button>
                {plan && (
                  <button className={resultTab === -2 ? 'active' : ''} onClick={() => setResultTab(-2)}>
                    Plan
                  </button>
                )}
                <span style={{ flex: 1 }} />
                {rs && resultTab === 0 && editInfo?.ctx && (
                  <span className="edit-bar">
                    {saved && <span className="edit-saved">{saved}</span>}
                    {changes > 0 && (
                      <>
                        <span className="edit-count">{t('q.changesN', changes)}</span>
                        <button className="btn primary small-btn" onClick={() => void openPreview()}>{t('q.saveEllipsis')}</button>
                        <button className="btn small-btn" onClick={() => setPending(emptyPending())}>{t('q.discard')}</button>
                      </>
                    )}
                    <button
                      className="link-btn"
                      title={t('q.newRowTitle')}
                      onClick={() => setPending((p) => ({ ...p, inserts: [...p.inserts, new Map()] }))}
                    >
                      + {t('q.newRow')}
                    </button>
                  </span>
                )}
                {rs && resultTab === 0 && editInfo?.reason && (
                  <span className="muted small edit-readonly" title={t('q.readOnlyTitle', editInfo.reason)}>
                    {t('q.readOnly', editInfo.reason)}
                  </span>
                )}
                {rs && rs.columns.length > 0 && (
                  <button
                    className="link-btn"
                    onClick={() => void copyResult()}
                    title={t('q.copyTitle')}
                  >
                    {copied ?? t('common.copy')}
                  </button>
                )}
                {rs && rs.columns.length > 0 && (
                  <>
                    <button className="link-btn" onClick={copyAs} title={t('q.copyAsTitle')}>
                      {t('q.copyAs')} ▾
                    </button>
                    <button className="link-btn" onClick={exportAs} title={t('q.exportTitle')}>
                      Export ▾
                    </button>
                  </>
                )}
              </div>
              {anomaly && (
                <div className="anomaly-bar">
                  <span>
                    {anomaly.a.kind === 'slow' ? (
                      <>
                        {rich(
                          t('q.anomalySlow', Math.round(anomaly.durationMs / Math.max(1, anomaly.a.medianMs)), formatMs(anomaly.a.medianMs), anomaly.a.samples),
                          <b>{formatMs(anomaly.durationMs)}</b>
                        )}
                      </>
                    ) : (
                      <>
                        {rich(t('q.anomalyEmpty', num(Math.round(anomaly.a.medianRows)), anomaly.a.samples), <b>{t('common.rowsN', 0)}</b>)}
                      </>
                    )}
                  </span>
                  <button className="link-btn" onClick={() => setAnomaly(null)}>
                    {t('common.close')}
                  </button>
                </div>
              )}
              {suggest && !tab.savedQueryId && (
                <div className="suggest-bar">
                  <Bookmark size={14} />
                  <span>
                    {rich(t('q.suggest'), <b>{suggest.recentRuns}</b>)}
                  </span>
                  <button className="btn small-btn primary" onClick={() => onSuggestSave?.()}>
                    {t('q.saveEllipsis')}
                  </button>
                  <button className="btn small-btn" onClick={suggestLater}>
                    {t('q.later')}
                  </button>
                  <button className="link-btn" onClick={suggestNever} title={t('q.neverTitle')}>
                    {t('q.never')}
                  </button>
                </div>
              )}
              <div className="result-body">
                {resultTab === -2 && plan ? (
                  <PlanView plan={plan.plan} canAnalyze={conn?.type !== 'mssql'} onAnalyze={() => void explain(true, plan.sql)} />
                ) : rs ? (
                  rs.columns.length > 0 ? (
                    <ResultsGrid
                      rs={rs}
                      gridRef={gridRef}
                      insert={conn ? { dialect: conn.type, table: insertTable } : undefined}
                      edit={
                        resultTab === 0 && editInfo?.ctx
                          ? { editable: editInfo.ctx.editable, pending, onChange: setPending }
                          : undefined
                      }
                    />
                  ) : (
                    <div className="empty">{t('q.noColumns')}</div>
                  )
                ) : (
                  <div className="messages">
                    {result.messages.length === 0 && <div className="msg">{t('q.done')}</div>}
                    {result.messages.map((m, i) => (
                      <div key={i} className={'msg ' + m.kind}>
                        {m.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="result-status">
                {running ? (
                  <span className="muted">{t('common.loading')}</span>
                ) : result.pending ? (
                  <span className="pending">{t('q.paused')}</span>
                ) : result.cancelled ? (
                  <span className="err">{t('q.cancelled')}</span>
                ) : result.error ? (
                  <span className="err">{t('q.error')}</span>
                ) : (
                  <span className="ok">{t('q.success')}</span>
                )}
                <span>{formatMs(running ? elapsed : result.durationMs)}</span>
                {rs && (
                  <span>
                    {rs.hasMore
                      ? t('q.shownMore', rs.rows.length)
                      : result.cancelled
                        ? t('common.rowsN', rs.rows.length)
                        : rs.truncated
                          ? t('q.shownOf', rs.rows.length, rs.totalRows)
                          : t('common.rowsN', rs.totalRows)}
                  </span>
                )}
                {result.pending && !running && (
                  <span className="more-bar" title={t('q.pausedTitle')}>
                    <button className="btn small-btn primary" onClick={() => void fetchMore('page')}>
                      {t('q.loadMore', num(pageSize))}
                    </button>
                    <button className="btn small-btn" onClick={() => void fetchMore('count')} title={t('q.countRestTitle')}>
                      {t('q.countRest')}
                    </button>
                    <button className="btn small-btn" onClick={() => void fetchMore('close')} title={t('q.closeQueryTitle')}>
                      {t('common.close')}
                    </button>
                  </span>
                )}
                {conn && (
                  <span className="muted">
                    {conn.name}
                    {tab.database ? ` / ${tab.database}` : ''}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="empty">
              <div>
                {rich(t('q.emptyHelp'), <b>Ctrl+Enter</b>, <b>F5</b>)}
              </div>
              <div className="muted">{t('q.emptyHint')}</div>
            </div>
          )}
        </div>
      </div>
      {snippetsDlg && (
        <SnippetsDialog
          projects={projects}
          activeProjectId={projectId ?? null}
          initialBody={snippetsDlg.body}
          onClose={() => setSnippetsDlg(null)}
          onChanged={() => {}}
          notify={notify ?? (() => {})}
        />
      )}
      {guardReq && (
        <GuardDialog
          issues={guardReq.issues}
          onClose={() => setGuardReq(null)}
          onRun={({ skipWrongDb }) => {
            const req = guardReq
            setGuardReq(null)
            if (skipWrongDb) skipWrongDbRef.current = true
            void execute({ text: req.text, params: req.params, force: true, confirmed: true })
          }}
        />
      )}
      {paramsReq && conn && (
        <ParamsDialog
          names={paramsReq.names}
          dialect={conn.type}
          projectId={projectId ?? null}
          preset={tab.params}
          onClose={() => setParamsReq(null)}
          onRun={(values) => {
            const text = paramsReq.text
            setParamsReq(null)
            void api.params.save(projectId ?? null, values).catch(() => {})
            // Vrijednosti iz povijesti vrijede samo za prvo izvršavanje.
            if (tab.params) onChange({ params: undefined })
            void execute({ text, params: values, force: true })
          }}
        />
      )}
      {preview && (
        <EditPreview
          connection={conn}
          prod={conn?.environment === 'prod'}
          table={editLabel}
          statements={preview}
          onApply={applyEdits}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}
