import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import logo from './assets/logo.svg'
import './completion'
import { setFormatErrorHandler } from './formatting'
import type { SourceTable } from './editing'
import type { ConnectionInfo, DbObject, DbRef, Environment, ParamValue, Project, SavedQuery, TextFile } from '../../shared/types'
import { ConnectionDialog } from './components/ConnectionDialog'
import { ContextMenuProvider, useContextMenu } from './components/ContextMenu'
import { Explorer, type ExplorerActions } from './components/Explorer'
import { HistoryPanel, clearHistory } from './components/HistoryPanel'
import { Bookmark, HelpCircle, History, Plus, Server, Trash } from '@vectilume/react'
import { DatabaseProjectsDialog, ProjectPicker, ProjectsDialog, projectScope } from './components/Projects'
import { SaveQueryDialog, SavedPanel, type SaveRequest } from './components/Saved'
import { QuickSwitcher } from './components/QuickSwitcher'
import { SavedHistoryDialog } from './components/SavedHistoryDialog'
import { Icon } from './components/Icons'
import { QueryTab, findAlias, type EditorHandle, type TabData } from './components/QueryTab'
import { TxCloseDialog, UnsavedFileDialog } from './components/TxCloseDialog'
import { ENCODING_LABELS } from '../../core/textFile'
import { SettingsDialog } from './components/SettingsDialog'
import { getSettings, useSettings } from './settings'
import { DiagramTab } from './components/DiagramTab'
import { TableTab } from './components/TableTab'
import { selectTopSql } from './dialect'
import { GuideTab } from './components/GuideTab'
// tr = t unutar tabs.map((t) => …), gdje je t tab.
import { t, t as tr } from './i18n'

interface Toast {
  id: number
  text: string
  kind: 'error' | 'info'
}

let tabCounter = 0
let toastCounter = 0

const ACTIVE_PROJECT_KEY = 'qucore.activeProject'
const OPEN_TABS_KEY = 'qucore.openTabs.v1'

interface StoredTabs {
  activeId: string | null
  tabs: TabData[]
}

/** Tabovi iz zadnje sesije (bez izvršavanja i rezultata); dijagrami se učitavaju tek kad se aktiviraju. */
function storedTabs(): StoredTabs {
  if (!getSettings().restoreTabs) return { activeId: null, tabs: [] }
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? 'null') as StoredTabs | null
    if (!v || !Array.isArray(v.tabs)) return { activeId: null, tabs: [] }
    const tabs = v.tabs.map((t) => ({ ...t, lazy: (t.kind === 'diagram' || t.kind === 'table') && t.id !== v.activeId }))
    for (const t of tabs) tabCounter = Math.max(tabCounter, Number(/^tab-(\d+)$/.exec(t.id)?.[1] ?? 0))
    return { activeId: tabs.some((t) => t.id === v.activeId) ? v.activeId : (tabs[0]?.id ?? null), tabs }
  } catch {
    return { activeId: null, tabs: [] }
  }
}

function storedProjectId(): number | null {
  const v = Number(localStorage.getItem(ACTIVE_PROJECT_KEY))
  return Number.isInteger(v) && v > 0 ? v : null
}

export function App() {
  return (
    <ContextMenuProvider>
      <Studio />
    </ContextMenuProvider>
  )
}

function Studio() {
  const [connections, setConnections] = useState<ConnectionInfo[]>([])
  const [restored] = useState(storedTabs)
  const [tabs, setTabs] = useState<TabData[]>(restored.tabs)
  const [activeId, setActiveId] = useState<string | null>(restored.activeId)
  const connectionsLoaded = useRef(false)
  const [dialog, setDialog] = useState<{ initial?: ConnectionInfo } | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [sidebarW, setSidebarW] = useState(300)
  const [panel, setPanel] = useState<'explorer' | 'saved' | 'history'>('explorer')
  const [historyVersion, setHistoryVersion] = useState(0)
  const bumpHistory = useCallback(() => setHistoryVersion((n) => n + 1), [])
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectIdState] = useState<number | null>(storedProjectId)
  const [savedVersion, setSavedVersion] = useState(0)
  const [projectsDialog, setProjectsDialog] = useState<{ initialId?: number | null } | null>(null)
  const [dbProjects, setDbProjects] = useState<{ ref: DbRef; connectionName: string } | null>(null)
  const [saveRequest, setSaveRequest] = useState<SaveRequest | null>(null)
  const [switcher, setSwitcher] = useState<'all' | 'projects' | null>(null)
  const [historyDlg, setHistoryDlg] = useState<SavedQuery | null>(null)
  const editors = useRef(new Map<string, EditorHandle>())
  /** Zatvaranje taba/aplikacije čeka odluku o otvorenim transakcijama. */
  const [txClose, setTxClose] = useState<{ ids: string[]; quitting: boolean } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Zatvaranje taba datoteke s nespremljenim izmjenama čeka odgovor; dirtyAnswered = već odgovoreno. */
  const [fileClose, setFileClose] = useState<string | null>(null)
  const dirtyAnswered = useRef(new Set<string>())
  useSettings() // ponovno iscrtavanje kad se postavke promijene
  const allowQuit = useRef(false)
  const openMenu = useContextMenu()

  // Refovi kako bi akcije explorera uvijek vidjele zadnje stanje.
  const state = useRef({ tabs, activeId, connections, activeProjectId, projects })
  state.current = { tabs, activeId, connections, activeProjectId, projects }

  const setActiveProjectId = useCallback((id: number | null) => {
    setActiveProjectIdState(id)
    if (id === null) localStorage.removeItem(ACTIVE_PROJECT_KEY)
    else localStorage.setItem(ACTIVE_PROJECT_KEY, String(id))
  }, [])

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const scope = useMemo(() => projectScope(activeProject), [activeProject])

  const notify = useCallback((text: string, kind: 'error' | 'info' = 'info') => {
    const id = ++toastCounter
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3000)
  }, [])

  const reloadConnections = useCallback(async () => {
    try {
      const list = await api.connections.list()
      setConnections(list)
      // Vraćeni tab čija konekcija više ne postoji ostaje bez konekcije (samo kod prvog učitavanja).
      if (!connectionsLoaded.current) {
        connectionsLoaded.current = true
        setTabs((ts) =>
          ts.map((t) => (t.connectionId && !list.some((c) => c.id === t.connectionId) ? { ...t, connectionId: undefined, database: undefined, source: undefined } : t))
        )
      }
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  }, [notify])

  useEffect(() => {
    void reloadConnections()
  }, [reloadConnections])

  const reloadProjects = useCallback(async () => {
    try {
      const list = await api.projects.list()
      setProjects(list)
      // Obrisan projekt više ne može biti aktivan.
      const active = state.current.activeProjectId
      if (active !== null && !list.some((p) => p.id === active)) setActiveProjectId(null)
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  }, [notify, setActiveProjectId])

  useEffect(() => {
    void reloadProjects()
  }, [reloadProjects])

  useEffect(() => setFormatErrorHandler((m) => notify(m, 'error')), [notify])

  const newQuery = useCallback(
    (
      connectionId?: string,
      database?: string,
      sql = '',
      opts: {
        run?: boolean
        title?: string
        source?: SourceTable
        savedQueryId?: number
        alias?: { aliasId: number; env: Environment }
        params?: Record<string, ParamValue>
        file?: TabData['file']
      } = {}
    ) => {
      const id = `tab-${++tabCounter}`
      const conn = state.current.connections.find((c) => c.id === connectionId)
      const s = getSettings()
      const autoCommit = conn?.environment === 'prod' ? s.autoCommitProd : s.autoCommitDefault
      const tab: TabData = {
        autoCommit: autoCommit ? undefined : false,
        id,
        title: opts.title ?? t('app.queryN', tabCounter),
        connectionId: conn?.id,
        database: database ?? conn?.database,
        initialSql: sql,
        runOnOpen: opts.run,
        source: opts.source,
        savedQueryId: opts.savedQueryId,
        alias: opts.alias,
        params: opts.params,
        file: opts.file
      }
      setTabs((t) => [...t, tab])
      setActiveId(id)
    },
    []
  )

  const openDiagram = useCallback((connectionId: string, database: string) => {
    // Isti dijagram se ne otvara dvaput — samo se aktivira postojeći tab.
    const existing = state.current.tabs.find((t) => t.kind === 'diagram' && t.connectionId === connectionId && t.database === database)
    if (existing) return setActiveId(existing.id)
    const id = `tab-${++tabCounter}`
    setTabs((t) => [...t, { id, kind: 'diagram', title: `ER: ${database}`, connectionId, database, initialSql: '' }])
    setActiveId(id)
  }, [])

  /** Tab tablice; ista tablica se ne otvara dvaput. Počinje na Kolonama, Podaci se izvrše kad se otvore. */
  const openTable = useCallback((connectionId: string, database: string, target: DbObject) => {
    // MariaDB: "shema" je baza; strani ključ je navodi i za istu bazu, Explorer ne — isti ključ za oba.
    const type = state.current.connections.find((c) => c.id === connectionId)?.type
    const obj = type === 'mariadb' && target.schema === database ? { ...target, schema: undefined } : target
    const same = state.current.tabs.find(
      (t) => t.kind === 'table' && t.connectionId === connectionId && t.database === database && t.object?.schema === obj.schema && t.object?.name === obj.name
    )
    if (same) return setActiveId(same.id)
    const conn = state.current.connections.find((c) => c.id === connectionId)
    if (!conn) return
    const id = `tab-${++tabCounter}`
    const s = getSettings()
    const autoCommit = conn.environment === 'prod' ? s.autoCommitProd : s.autoCommitDefault
    setTabs((t) => [
      ...t,
      {
        id,
        kind: 'table',
        title: obj.name,
        connectionId,
        database,
        object: obj,
        sub: 'columns',
        initialSql: selectTopSql(conn.type, obj),
        dataRunOnOpen: true,
        source: obj.kind === 'table' ? { database, schema: obj.schema, table: obj.name } : undefined,
        autoCommit: autoCommit ? undefined : false
      }
    ])
    setActiveId(id)
  }, [])

  const patchTab = useCallback((id: string, patch: Partial<TabData>) => {
    setTabs((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }, [])

  const openSaved = useCallback(
    (q: SavedQuery) => {
      const open = state.current.tabs.find((t) => t.savedQueryId === q.id)
      if (open) return setActiveId(open.id)
      const exists = !!q.connectionId && state.current.connections.some((c) => c.id === q.connectionId)
      if (q.connectionId && !exists) notify(t('app.queryConnMissing'))
      // Query vezan na alias otvara se u zadanom okruženju projekta (ili prvom koje alias ima).
      const found = q.aliasId ? findAlias(state.current.projects, q.aliasId) : undefined
      const target = found && (found.alias.targets.find((t) => t.env === found.project.defaultEnv) ?? found.alias.targets[0])
      if (found && target) {
        return newQuery(target.connectionId, target.database, q.sql, {
          title: q.title,
          savedQueryId: q.id,
          alias: { aliasId: found.alias.id, env: target.env }
        })
      }
      newQuery(exists ? q.connectionId : undefined, exists ? q.database : undefined, q.sql, { title: q.title, savedQueryId: q.id })
    },
    [newQuery, notify]
  )

  const afterSave = useCallback(
    (q: SavedQuery, tabId?: string) => {
      // Tab iz kojeg se spremalo dobiva vezu; svi tabovi tog queryja dobivaju novi naslov.
      setTabs((list) =>
        list.map((t) => {
          if (t.id !== tabId) return t.savedQueryId === q.id ? { ...t, title: q.title } : t
          // Spremljen na alias: tab se veže na okruženje u kojem već radi (ili zadano okruženje projekta).
          let alias = t.alias
          const found = q.aliasId ? findAlias(state.current.projects, q.aliasId) : undefined
          if (found) {
            const here = found.alias.targets.find((x) => x.connectionId === t.connectionId && x.database === t.database)
            const target = here ?? found.alias.targets.find((x) => x.env === found.project.defaultEnv) ?? found.alias.targets[0]
            if (target) alias = { aliasId: found.alias.id, env: target.env }
          } else alias = undefined
          return { ...t, savedQueryId: q.id, title: q.title, alias }
        })
      )
      setSavedVersion((n) => n + 1)
      void reloadProjects()
    },
    [reloadProjects]
  )

  /** Ctrl+S: spremljeni query se ažurira odmah, novi otvara dijalog. Ctrl+Shift+S: uvijek kao novi. */
  const saveActiveTab = useCallback(
    async (asNew: boolean) => {
      const { tabs: list, activeId: active } = state.current
      const tab = list.find((t) => t.id === active)
      if (!tab || (tab.kind && tab.kind !== 'query')) return
      const sql = editors.current.get(tab.id)?.getText() ?? ''
      if (!sql.trim()) return notify(t('main.queryEmpty'))
      try {
        const existing = !asNew && tab.savedQueryId ? await api.saved.get(tab.savedQueryId) : null
        if (existing) {
          const q = await api.saved.save({ ...existing, sql, connectionId: tab.connectionId, database: tab.database, aliasId: tab.alias?.aliasId })
          afterSave(q, tab.id)
          notify(t('common.savedName', q.title))
          return
        }
        setSaveRequest({
          sql,
          connectionId: tab.connectionId,
          database: tab.database,
          aliasId: tab.alias?.aliasId,
          defaultTitle: /^Upit \d+$/.test(tab.title) ? '' : tab.title,
          tabId: tab.id
        })
      } catch (e) {
        notify((e as Error).message, 'error')
      }
    },
    [afterSave, notify]
  )

  /** Otvorene datoteke: ista datoteka se ne otvara dvaput; novi tab dobiva konekciju i bazu aktivnog taba. */
  const openFiles = useCallback(
    (files: TextFile[]) => {
      const { tabs: list, activeId: active, connections: conns } = state.current
      const cur = list.find((t) => t.id === active)
      for (const f of files) {
        const open = list.find((t) => t.file && t.file.path.toLowerCase() === f.path.toLowerCase())
        if (open) {
          setActiveId(open.id)
          continue
        }
        newQuery(cur?.connectionId ?? conns[0]?.id, cur?.database, f.text, {
          title: f.name,
          file: { path: f.path, name: f.name, encoding: f.encoding, savedText: f.text }
        })
        if (f.encoding !== 'utf8') notify(t('app.encodingKept', f.name, ENCODING_LABELS[f.encoding]))
      }
    },
    [newQuery, notify]
  )
  const openFileDialog = useCallback(async () => {
    try {
      openFiles(await api.files.open())
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  }, [openFiles, notify])

  /** Ctrl+S na tabu datoteke (ili Spremi u datoteku kao…): sprema tekst editora; vraća false ako nije spremljeno. */
  const saveFileTab = useCallback(
    async (id: string, asNew: boolean): Promise<boolean> => {
      const tab = state.current.tabs.find((t) => t.id === id)
      const h = editors.current.get(id)
      if (!tab || !h) return false
      const text = h.getText()
      try {
        if (tab.file && !asNew) {
          const enc = await api.files.save(tab.file.path, text, tab.file.encoding)
          patchTab(id, { file: { ...tab.file, encoding: enc, savedText: text }, dirty: false })
          if (enc !== tab.file.encoding) {
            notify(t('app.encodingChanged', tab.file.name, ENCODING_LABELS[tab.file.encoding], ENCODING_LABELS[enc]))
          } else notify(t('common.savedName', tab.file.name))
          return true
        }
        const name = tab.file?.name ?? (/^(Upit|Query) \d+$/.test(tab.title) ? t('main.defaultFileName') : tab.title.replace(/[\\/:*?"<>|]+/g, '_'))
        const f = await api.files.saveAs(name, text, tab.file?.encoding)
        if (!f) return false
        patchTab(id, { title: f.name, file: { path: f.path, name: f.name, encoding: f.encoding, savedText: text }, dirty: false })
        notify(t('common.savedName', f.path))
        return true
      } catch (e) {
        notify((e as Error).message, 'error')
        return false
      }
    },
    [patchTab, notify]
  )

  // Povlačenje .sql/.txt datoteka u prozor otvara ih u novim tabovima.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const all = [...(e.dataTransfer?.files ?? [])]
      const sql = all.filter((f) => /\.(sql|txt)$/i.test(f.name))
      if (sql.length < all.length) notify(t('app.onlySqlTxt'))
      try {
        openFiles(await Promise.all(sql.map((f) => api.files.readDropped(f))))
      } catch (err) {
        notify((err as Error).message, 'error')
      }
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [openFiles, notify])

  /** Vodič: jedan tab, ponovno se aktivira. */
  const openGuide = useCallback(() => {
    const existing = state.current.tabs.find((t) => t.kind === 'guide')
    if (existing) return setActiveId(existing.id)
    const id = `tab-${++tabCounter}`
    setTabs((list) => [...list, { id, kind: 'guide', title: t('app.guide'), initialSql: '' }])
    setActiveId(id)
  }, [])

  // F1 (izvan editora; editor šalje događaj qucore:guide).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault()
        openGuide()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('qucore:guide', openGuide)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('qucore:guide', openGuide)
    }
  }, [openGuide])

  // Otvoreni tabovi i njihov (i nespremljeni) tekst preživljavaju zatvaranje aplikacije.
  useEffect(() => {
    let last = ''
    const persist = () => {
      // Postavka isključena: tekst tabova se ne sprema, a ranije spremljeni se briše.
      if (!getSettings().restoreTabs) {
        if (last !== 'off') localStorage.removeItem(OPEN_TABS_KEY)
        last = 'off'
        return
      }
      const { tabs: list, activeId: active } = state.current
      const data: StoredTabs = {
        activeId: active,
        tabs: list.map((t) => {
          const ed = editors.current.get(t.id)
          const rest = { ...t }
          delete rest.runOnOpen
          delete rest.params
          delete rest.lazy
          delete rest.txOpen
          return { ...rest, initialSql: ed?.getText() ?? t.initialSql, cursor: ed?.getCursor() ?? t.cursor }
        })
      }
      const json = JSON.stringify(data)
      if (json === last) return
      try {
        localStorage.setItem(OPEN_TABS_KEY, json)
        last = json
      } catch {
        // Pun localStorage: zadnje uspješno spremljeno stanje ostaje.
      }
    }
    const timer = setInterval(persist, 1500)
    window.addEventListener('beforeunload', persist)
    return () => {
      clearInterval(timer)
      window.removeEventListener('beforeunload', persist)
    }
  }, [])

  // Vraćeni dijagram se učitava tek kad ga korisnik otvori.
  useEffect(() => {
    if (tabs.some((t) => t.id === activeId && t.lazy)) patchTab(activeId!, { lazy: false })
  }, [activeId, tabs, patchTab])

  const closeTab = useCallback((id: string, force = false) => {
    const { tabs: list, activeId: active } = state.current
    const tab = list.find((t) => t.id === id)
    // Datoteka s nespremljenim izmjenama: Spremi / Ne spremaj / Odustani (prije pitanja o transakciji).
    if (tab?.file && tab.dirty && !dirtyAnswered.current.has(id)) return setFileClose(id)
    // Zatvaranje sesije bi otvorenu transakciju tiho poništilo — prvo pitaj.
    if (!force && tab?.txOpen) return setTxClose({ ids: [id], quitting: false })
    dirtyAnswered.current.delete(id)
    const idx = list.findIndex((t) => t.id === id)
    const next = list.filter((t) => t.id !== id)
    setTabs(next)
    if (active === id) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? null)
  }, [])

  /** Commit/Rollback u tabovima; false čim jedan ne uspije (greška je prikazana). */
  const resolveTx = useCallback(async (ids: string[], action: 'commit' | 'rollback') => {
    for (const id of ids) {
      const h = editors.current.get(id)
      if (h && !(await h.transaction(action))) return false
    }
    return true
  }, [])

  // Izlazak iz aplikacije s otvorenom transakcijom: zaustavi zatvaranje prozora i pitaj.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (allowQuit.current) return
      const open = state.current.tabs.filter((t) => t.txOpen)
      if (!open.length) return
      e.preventDefault()
      e.returnValue = false
      setTxClose({ ids: open.map((t) => t.id), quitting: true })
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  /** Tabovi te konekcije s otvorenom transakcijom: potvrda pa Rollback (odspajanje/brisanje zatvara sesije). */
  const rollbackConnectionTabs = useCallback(
    async (connectionId: string, what: string) => {
      const open = state.current.tabs.filter((t) => t.txOpen && t.connectionId === connectionId)
      if (!open.length) return true
      const names = open.map((t) => t.title).join(', ')
      if (!confirm(t(open.length > 1 ? 'app.txConfirmMany' : 'app.txConfirmOne', names, what))) return false
      return resolveTx(open.map((t) => t.id), 'rollback')
    },
    [resolveTx]
  )

  const actions = useMemo<ExplorerActions>(
    () => ({
      beforeDisconnect: (id) => rollbackConnectionTabs(id, t('app.disconnecting')),
      openTable,
      newQuery,
      openDiagram,
      notify,
      insertText(text) {
        const h = state.current.activeId ? editors.current.get(state.current.activeId) : undefined
        if (h) h.insert(text)
        else newQuery(undefined, undefined, text)
      },
      editConnection: (c) => setDialog({ initial: c }),
      newConnection: () => setDialog({}),
      editDatabaseProjects: (c, database) => setDbProjects({ ref: { connectionId: c.id, database }, connectionName: c.name }),
      objectsLoaded: () => setSavedVersion((n) => n + 1),
      async deleteConnection(c) {
        if (!confirm(t('app.confirmDeleteConn', c.name))) return
        if (!(await rollbackConnectionTabs(c.id, t('app.deletingConn')))) return
        await api.connections.remove(c.id)
        await reloadConnections()
        await reloadProjects()
      }
    }),
    [newQuery, openDiagram, notify, reloadConnections, reloadProjects, rollbackConnectionTabs, openTable]
  )

  const registerEditor = useCallback((tabId: string, h: EditorHandle | null) => {
    if (h) editors.current.set(tabId, h)
    else editors.current.delete(tabId)
  }, [])

  // Prečaci: Ctrl+T novi tab, Ctrl+W zatvori tab, Ctrl+Tab sljedeći, Ctrl+S spremi, Ctrl+P switcher.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const { tabs: list, activeId: active, connections: conns } = state.current
      const cur = list.find((t) => t.id === active)
      const key = e.key.toLowerCase()
      if (key === 'o') {
        e.preventDefault()
        if (!document.querySelector('.modal-backdrop')) void openFileDialog()
        return
      }
      if (key === ',') {
        e.preventDefault()
        if (!document.querySelector('.modal-backdrop')) setSettingsOpen(true)
        return
      }
      if (key === 's') {
        e.preventDefault()
        if (document.querySelector('.modal-backdrop')) return
        // Tab datoteke: Ctrl+S sprema u datoteku; Ctrl+Shift+S i dalje sprema kao novi query u projekt.
        if (!e.shiftKey && cur?.file) void saveFileTab(cur.id, false)
        else void saveActiveTab(e.shiftKey)
        return
      }
      if (key === 'p') {
        e.preventDefault()
        if (!document.querySelector('.modal-backdrop')) setSwitcher(e.shiftKey ? 'projects' : 'all')
        return
      }
      if (key === 't') {
        e.preventDefault()
        newQuery(cur?.connectionId ?? conns[0]?.id, cur?.database)
      } else if (e.key.toLowerCase() === 'w' && active) {
        e.preventDefault()
        closeTab(active)
      } else if (e.key === 'Tab' && list.length > 1) {
        e.preventDefault()
        const i = list.findIndex((t) => t.id === active)
        setActiveId(list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newQuery, closeTab, saveActiveTab, saveFileTab, openFileDialog])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarW
    const move = (ev: MouseEvent) => setSidebarW(Math.min(700, Math.max(180, startW + ev.clientX - startX)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const activeTab = tabs.find((t) => t.id === activeId)

  return (
    <div className="app">
      <aside className="sidebar" style={{ width: sidebarW }}>
        <ProjectPicker
          projects={projects}
          activeId={activeProject ? activeProject.id : null}
          onChange={setActiveProjectId}
          onManage={() => setProjectsDialog({ initialId: activeProject?.id })}
          onGuide={openGuide}
          onSettings={() => setSettingsOpen(true)}
          onDefaultEnv={async (env) => {
            if (!activeProject) return
            try {
              await api.projects.setDefaultEnv(activeProject.id, env)
              await reloadProjects()
            } catch (e) {
              notify((e as Error).message, 'error')
            }
          }}
        />
        <div className="sidebar-tabs">
          <button className={'sidebar-tab' + (panel === 'explorer' ? ' active' : '')} onClick={() => setPanel('explorer')} title={t('app.connections')}>
            <Server size={14} /> <span className="sidebar-tab-label">{t('app.connections')}</span>
          </button>
          <button className={'sidebar-tab' + (panel === 'saved' ? ' active' : '')} onClick={() => setPanel('saved')} title={t('app.savedTitle')}>
            <Bookmark size={14} /> <span className="sidebar-tab-label">{t('app.saved')}</span>
          </button>
          <button className={'sidebar-tab' + (panel === 'history' ? ' active' : '')} onClick={() => setPanel('history')} title={t('app.historyTitle')}>
            <History size={14} /> <span className="sidebar-tab-label">{t('app.history')}</span>
          </button>
          <span className="sidebar-tabs-spacer" />
          {panel === 'explorer' ? (
            <button className="icon-btn" title={t('conn.new')} onClick={actions.newConnection}>
              <Plus size={16} />
            </button>
          ) : panel === 'saved' ? null : (
            <button
              className="icon-btn"
              title={t('app.clearHistory')}
              onClick={async () => {
                try {
                  if (await clearHistory()) bumpHistory()
                } catch (e) {
                  notify((e as Error).message, 'error')
                }
              }}
            >
              <Trash size={16} />
            </button>
          )}
        </div>
        <Explorer connections={connections} actions={actions} scope={scope} projectName={activeProject?.name} visible={panel === 'explorer'} />
        <SavedPanel
          connections={connections}
          projects={projects}
          activeProjectId={activeProject ? activeProject.id : null}
          version={savedVersion}
          visible={panel === 'saved'}
          notify={notify}
          onOpen={openSaved}
          onInsert={actions.insertText}
          onEdit={(q) => setSaveRequest({ existing: q, sql: q.sql, connectionId: q.connectionId, database: q.database, defaultTitle: q.title })}
          onHistory={setHistoryDlg}
          onChanged={() => {
            setSavedVersion((n) => n + 1)
            void reloadProjects()
          }}
        />
        <HistoryPanel
          connections={connections}
          activeConnectionId={tabs.find((t) => t.id === activeId)?.connectionId}
          scope={activeProject?.databases}
          version={historyVersion}
          visible={panel === 'history'}
          notify={notify}
          onInsert={actions.insertText}
          onOpen={(h) => {
            const exists = connections.some((c) => c.id === h.connectionId)
            if (!exists) notify(t('app.historyConnMissing', h.connectionName))
            newQuery(exists ? h.connectionId : undefined, exists ? h.database : undefined, h.sql, { title: t('app.fromHistory'), params: h.params })
          }}
        />
      </aside>
      <div className="sidebar-resizer" onMouseDown={startResize} />
      <main className="app-main">
        <div className="tabs">
          {tabs.map((t) => {
            const conn = connections.find((c) => c.id === t.connectionId)
            return (
              <div
                key={t.id}
                className={'tab' + (t.id === activeId ? ' active' : '') + (conn?.environment === 'prod' ? ' prod' : '')}
                style={conn?.color ? { ['--tab-accent' as string]: conn.color } : undefined}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    closeTab(t.id)
                  } else if (e.button === 0) setActiveId(t.id)
                }}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: tr('common.close'), shortcut: 'Ctrl+W', onClick: () => closeTab(t.id) },
                    {
                      label: tr('app.closeOthers'),
                      onClick: () => {
                        // Tabovi s otvorenom transakcijom ostaju dok se ne odluči Commit/Rollback,
                        // a datoteke s nespremljenim izmjenama ostaju otvorene (bez tihog gubitka teksta).
                        const withTx = tabs.filter((x) => x.id !== t.id && x.txOpen).map((x) => x.id)
                        const dirty = tabs.filter((x) => x.id !== t.id && !x.txOpen && x.file && x.dirty)
                        setTabs((list) => list.filter((x) => x.id === t.id || withTx.includes(x.id) || dirty.some((d) => d.id === x.id)))
                        setActiveId(t.id)
                        if (withTx.length) setTxClose({ ids: withTx, quitting: false })
                        if (dirty.length) notify(tr('app.dirtyLeftOpen', dirty.map((d) => d.title).join(', ')))
                      }
                    },
                    'separator',
                    ...(!t.kind || t.kind === 'query'
                      ? [
                          ...(t.file ? [{ label: tr('app.saveToFile'), shortcut: 'Ctrl+S', onClick: () => void saveFileTab(t.id, false) }] : []),
                          { label: tr('app.saveToFileAs'), onClick: () => void saveFileTab(t.id, true) },
                          'separator' as const
                        ]
                      : []),
                    { label: tr('app.newQuerySameConn'), onClick: () => newQuery(t.connectionId, t.database) }
                  ])
                }
                title={
                  (t.file ? t.file.path + '\n' : '') + (conn ? `${conn.name}${t.database ? ' / ' + t.database : ''}` : tr('app.noConnection'))
                }
              >
                <span className="tab-title">{t.title}</span>
                {t.dirty && (
                  <span className="tab-dirty" title={tr('unsavedFile.title')}>
                    ●
                  </span>
                )}
                {t.database && <span className="tab-db">{t.database}</span>}
                <button
                  className="tab-close"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => closeTab(t.id)}
                  title={tr('app.closeTabTitle')}
                >
                  <Icon name="close" />
                </button>
              </div>
            )
          })}
          <button
            className="icon-btn new-tab"
            title={t('app.newQueryTitle')}
            onClick={() => newQuery(activeTab?.connectionId ?? connections[0]?.id, activeTab?.database)}
          >
            <Icon name="plus" />
          </button>
        </div>
        <div className="tab-content">
          {tabs.map((t) =>
            t.kind === 'guide' ? (
              <GuideTab key={t.id} active={t.id === activeId} />
            ) : t.kind === 'table' ? (
              t.lazy ? null : (
                <TableTab
                  key={t.id}
                  tab={t}
                  active={t.id === activeId}
                  connections={connections}
                  onSub={(sub) => patchTab(t.id, { sub })}
                  onOpenTable={(obj) => t.connectionId && t.database && openTable(t.connectionId, t.database, obj)}
                  onNewQuery={(sql, title) => newQuery(t.connectionId, t.database, sql, { title })}
                  renderData={(dataActive) => (
                    <QueryTab
                      tab={{ ...t, kind: 'query', runOnOpen: t.dataRunOnOpen }}
                      active={dataActive}
                      connections={connections}
                      registerEditor={registerEditor}
                      onExecuted={bumpHistory}
                      projectId={activeProject?.id}
                      onSuggestSave={() => void saveActiveTab(false)}
                      projects={projects}
                      notify={notify}
                      onChange={(p) => {
                        // runOnOpen se odnosi na Podatke ovog taba; ostalo (konekcija, transakcija…) na tab.
                        const { runOnOpen, ...rest } = p
                        patchTab(t.id, { ...rest, ...(runOnOpen !== undefined ? { dataRunOnOpen: runOnOpen } : {}) })
                      }}
                    />
                  )}
                />
              )
            ) : t.kind === 'diagram' ? (
              t.lazy ? null : <DiagramTab key={t.id} tab={t} active={t.id === activeId} connections={connections} />
            ) : (
              <QueryTab
                key={t.id}
                tab={t}
                active={t.id === activeId}
                connections={connections}
                registerEditor={registerEditor}
                onExecuted={bumpHistory}
                projectId={activeProject?.id}
                onSuggestSave={() => void saveActiveTab(false)}
                projects={projects}
                notify={notify}
                onChange={(patch) => patchTab(t.id, patch)}
              />
            )
          )}
          {tabs.length === 0 && (
            <div className="welcome">
              <h1><img className="welcome-logo" src={logo} alt="QuCore" /></h1>
              <p className="welcome-slogan">The Power Behind Every Query.</p>
              <p className="muted">SQL Server · PostgreSQL · MariaDB</p>
              <div className="welcome-actions">
                <button className="btn primary" onClick={() => setDialog({})}>
                  <Icon name="plug" /> {t('conn.new')}
                </button>
                <button className="btn" onClick={() => newQuery(connections[0]?.id)} disabled={connections.length === 0}>
                  <Icon name="plus" /> {t('explorer.newQuery')}
                </button>
                <button className="btn" onClick={openGuide} title={t('app.guideTitle')}>
                  <HelpCircle size={14} /> {t('app.guide')}
                </button>
              </div>
              <table className="shortcuts">
                <tbody>
                  <tr><td>Ctrl+Enter</td><td>{t('app.sc.runStatement')}</td></tr>
                  <tr><td>F5 / Alt+X</td><td>{t('app.sc.runAll')}</td></tr>
                  <tr><td>Esc</td><td>{t('app.sc.cancel')}</td></tr>
                  <tr><td>Ctrl+T / Ctrl+W</td><td>{t('app.sc.tabs')}</td></tr>
                  <tr><td>Ctrl+S</td><td>{t('app.sc.save')}</td></tr>
                  <tr><td>Ctrl+P / Ctrl+Shift+P</td><td>{t('app.sc.switcher')}</td></tr>
                  <tr><td>Ctrl+Space</td><td>{t('app.sc.suggest')}</td></tr>
                  <tr><td>Ctrl+O</td><td>{t('app.sc.open')}</td></tr>
                  <tr><td>Ctrl+,</td><td>{t('settings.title')}</td></tr>
                  <tr><td>F1</td><td>{t('app.guide')}</td></tr>
                  <tr><td>{t('app.sc.dblClickTable')}</td><td>{t('app.sc.first100')}</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {dialog && (
        <ConnectionDialog
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onSaved={async (c) => {
            setDialog(null)
            await reloadConnections()
            notify(t('common.savedName', c.name))
          }}
        />
      )}

      {projectsDialog && (
        <ProjectsDialog
          projects={projects}
          connections={connections}
          initialId={projectsDialog.initialId}
          notify={notify}
          onClose={() => setProjectsDialog(null)}
          onChanged={reloadProjects}
        />
      )}

      {dbProjects && (
        <DatabaseProjectsDialog
          target={dbProjects.ref}
          connectionName={dbProjects.connectionName}
          projects={projects}
          notify={notify}
          onClose={() => setDbProjects(null)}
          onChanged={reloadProjects}
        />
      )}

      {saveRequest && (
        <SaveQueryDialog
          request={saveRequest}
          projects={projects}
          activeProjectId={activeProject ? activeProject.id : null}
          connections={connections}
          notify={notify}
          onClose={() => setSaveRequest(null)}
          onSaved={(q) => {
            setSaveRequest(null)
            afterSave(q, saveRequest.tabId)
            notify(t('common.savedName', q.title))
          }}
        />
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {fileClose && (
        <UnsavedFileDialog
          name={tabs.find((t) => t.id === fileClose)?.title ?? ''}
          onClose={() => setFileClose(null)}
          onResolve={async (save) => {
            const id = fileClose
            if (save && !(await saveFileTab(id, false))) return
            setFileClose(null)
            dirtyAnswered.current.add(id)
            closeTab(id)
          }}
        />
      )}
      {txClose && (
        <TxCloseDialog
          tabs={txClose.ids.map((id) => tabs.find((t) => t.id === id)?.title ?? id)}
          quitting={txClose.quitting}
          onClose={() => {
            // Odustajanje od izlaska: ako je izlaz bio zbog promjene jezika, aplikacija se ne pokreće ponovno.
            if (txClose.quitting) void api.app.cancelRelaunch()
            setTxClose(null)
          }}
          onResolve={async (action) => {
            if (!(await resolveTx(txClose.ids, action))) return false
            setTxClose(null)
            if (txClose.quitting) {
              allowQuit.current = true
              window.close()
            } else txClose.ids.forEach((id) => closeTab(id, true))
            return true
          }}
        />
      )}
      {historyDlg && (
        <SavedHistoryDialog
          query={historyDlg}
          connections={connections}
          notify={notify}
          onClose={() => setHistoryDlg(null)}
          onRestored={(q) => {
            // Otvoreni tab tog queryja dobiva vraćeni SQL (Ctrl+Z ga vraća).
            for (const t of state.current.tabs) if (t.savedQueryId === q.id) editors.current.get(t.id)?.setText(q.sql)
            setSavedVersion((n) => n + 1)
          }}
          onOpenVersion={(q, v) => {
            setHistoryDlg(null)
            const exists = !!q.connectionId && state.current.connections.some((c) => c.id === q.connectionId)
            newQuery(exists ? q.connectionId : undefined, exists ? q.database : undefined, v.sql, { title: `${q.title} (v${v.number})` })
          }}
        />
      )}

      {switcher && (
        <QuickSwitcher
          mode={switcher}
          projects={projects}
          activeProjectId={activeProject ? activeProject.id : null}
          connections={connections}
          onClose={() => setSwitcher(null)}
          onProject={setActiveProjectId}
          onQuery={openSaved}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={'toast ' + t.kind} onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
