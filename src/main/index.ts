import { basename, join } from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type WebContents } from 'electron'
import { decodeText, encodeText } from '../core/textFile'

import { ConnectionManager } from '../core/manager'
import { ConnectionStore } from './connectionStore'
import { WorkspaceStore, type NewRun } from './workspaceStore'
import { FileGrants } from './fileGrants'
import { fingerprintSql, type FingerprintDialect } from '../core/fingerprint'
import { analyzeSql } from '../core/sqlRefs'
import type {
  ConnectionConfig,
  DbObject,
  DbRef,
  EditTable,
  Environment,
  ParamValue,
  ExecuteOptions,
  TextEncodingName,
  TextFile,
  TxAction,
  FetchMode,
  HistoryEntry,
  HistoryQuery,
  ProjectInput,
  QueryProgress,
  QueryResult,
  RowEdit,
  RunInfo,
  SavedQueryFilter,
  SavedQueryInput,
  SnippetInput
} from '../shared/types'
import { isLang, setLang, t } from '../shared/i18n.ts'

/** Najveća .sql datoteka koju editor otvara. */
const MAX_FILE_BYTES = 20 * 1024 * 1024

let store: ConnectionStore
let manager: ConnectionManager
let workspace: WorkspaceStore
let grants: FileGrants

// QUCORE_USER_DATA: zaseban profil za testove (ne dira pravi profil korisnika).
const userData = process.env.QUCORE_USER_DATA || resolveUserData()
mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', userData)

/**
 * Profil je u %APPDATA%/QuCore. Stara mapa "SQL Studio" (prije preimenovanja) jednom se preimenuje u cijelosti,
 * zajedno s Local State, pa ključ za lozinke ostaje isti. Ako preimenovanje ne uspije (npr. stara verzija
 * još radi i drži datoteke), koristi se stara mapa i pokušava se ponovno pri idućem pokretanju.
 */
function resolveUserData(): string {
  const current = join(app.getPath('appData'), 'QuCore')
  const legacy = join(app.getPath('appData'), 'SQL Studio')
  if (existsSync(current) || !existsSync(legacy)) return current
  try {
    renameSync(legacy, current)
    return current
  } catch {
    return legacy
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1e1f22',
    title: 'QuCore',
    // Windows: ICO s ručno crtanim 16-32 px znakom; PNG od 512 px se u naslovnoj traci mutno smanjuje.
    icon: join(app.getAppPath(), process.platform === 'win32' ? 'resources/icon.ico' : 'resources/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())

  // Vanjske linkove otvaraj u browseru, nikad u aplikaciji.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Registrira IPC handler; greške se šalju UI-u kao čitljive poruke. fn kao this dobiva pošiljatelja. */
function handle<A extends unknown[], R>(channel: string, fn: (this: WebContents, ...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return { ok: true, value: await fn.apply(e.sender, args as A) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

function registerIpc(): void {
  handle('app:setLanguage', (lang: unknown) => {
    if (isLang(lang)) setLang(lang)
  })
  handle('app:relaunch', function () {
    // Zatvaranje prozora prolazi kroz pitanja renderera (otvorene transakcije); ponovno pokretanje tek pri izlasku.
    relaunchOnQuit = true
    BrowserWindow.fromWebContents(this)?.close()
  })
  handle('app:cancelRelaunch', () => {
    relaunchOnQuit = false
  })
  handle('connections:list', () => store.list())
  handle('connections:get', (id: string) => store.get(id))
  handle('connections:save', async (c: ConnectionConfig) => {
    const info = await store.save(c)
    // Promijenjena konfiguracija → zatvori stare konekcije.
    await manager.disconnect(info.id)
    return info
  })
  handle('connections:remove', async (id: string) => {
    await manager.disconnect(id)
    store.remove(id)
    workspace.forgetConnection(id)
  })
  handle('connections:test', async (c: ConnectionConfig) => ConnectionManager.test(await store.withStoredPassword(c)))
  handle('connections:passwordStorage', () => store.passwordStorage())

  handle('explorer:connect', (id: string) => manager.connect(id))
  handle('explorer:disconnect', (id: string) => manager.disconnect(id))
  handle('explorer:databases', (id: string) => manager.databases(id))
  handle('explorer:databaseSizes', (id: string) => manager.databaseSizes(id))
  handle('explorer:objects', async (id: string, db: string) => {
    const objects = await manager.objects(id, db)
    // Svježi popis objekata: označi spremljene queryje koji koriste tablice kojih više nema.
    try {
      workspace.checkSchema(id, db, objects)
    } catch (err) {
      console.error('schema check:', err)
    }
    return objects
  })
  handle('explorer:children', (id: string, db: string, o: DbObject) => manager.children(id, db, o))
  handle('explorer:definition', (id: string, db: string, o: DbObject) => manager.definition(id, db, o))
  handle('explorer:schemaGraph', (id: string, db: string) => manager.schemaGraph(id, db))
  handle('explorer:tableDetails', (id: string, db: string, o: DbObject) => manager.tableDetails(id, db, o))

  handle('edits:preview', (id: string, t: EditTable, e: RowEdit[]) => manager.previewEdits(id, t, e))
  handle('edits:apply', (id: string, t: EditTable, e: RowEdit[]) => manager.applyEdits(id, t, e))

  handle('query:openSession', (id: string, db?: string) => manager.openSession(id, db))
  handle('query:execute', async function (sid: string, sql: string, o?: ExecuteOptions) {
    const started = performance.now()
    // Dijelovi rezultata idu prozoru koji je pokrenuo upit dok se upit još izvršava.
    const progress = (p: QueryProgress) => {
      if (!this.isDestroyed()) this.send('query:progress', sid, p)
    }
    let result: QueryResult
    try {
      result = await manager.execute(sid, sql, o, progress)
    } catch (err) {
      recordRun(sid, sql, undefined, performance.now() - started, o)
      throw err
    }
    const runInfo = recordRun(sid, sql, result, performance.now() - started, o)
    return runInfo ? { ...result, runInfo } : result
  })
  handle('query:fetchMore', function (sid: string, mode: FetchMode) {
    return manager.fetchMore(sid, mode, (p) => {
      if (!this.isDestroyed()) this.send('query:progress', sid, p)
    })
  })
  handle('query:cancel', (sid: string) => manager.cancel(sid))
  handle('query:closeSession', (sid: string) => manager.closeSession(sid))
  handle('query:currentDatabase', (sid: string) => manager.currentDatabase(sid))
  handle('query:transaction', (sid: string, action: TxAction) => manager.transaction(sid, action))
  handle('query:explain', (sid: string, sql: string, analyze: boolean) => manager.explain(sid, sql, analyze))

  handle('history:list', (q?: HistoryQuery) => workspace.listRuns(q))
  handle('history:remove', (id: string) => workspace.removeRun(id))
  handle('history:clear', () => workspace.clearRuns())
  handle('history:ignoreSuggestion', (fp: string) => workspace.ignoreFingerprint(fp))

  handle('projects:list', () => workspace.listProjects())
  handle('projects:save', (p: ProjectInput) => workspace.saveProject(p))
  handle('projects:remove', (id: number) => workspace.removeProject(id))
  handle('projects:setDatabaseProjects', (ref: DbRef, ids: number[]) => workspace.setDatabaseProjects(ref, ids))
  handle('projects:setDefaultEnv', (id: number, env: Environment) => workspace.setDefaultEnv(id, env))
  handle('params:get', (projectId: number | null, names: string[]) => workspace.getParams(projectId, names))
  handle('params:save', (projectId: number | null, values: Record<string, ParamValue>) => workspace.saveParams(projectId, values))

  handle('saved:list', (f?: SavedQueryFilter) => workspace.listSaved(f))
  handle('saved:get', (id: number) => workspace.getSaved(id))
  handle('saved:save', (q: SavedQueryInput) => saveQuery(q))
  handle('saved:versions', (id: number) => workspace.versions(id))
  handle('saved:runs', (id: number, limit?: number) => workspace.savedRuns(id, limit))
  handle('saved:folders', () => workspace.folders())
  handle('saved:restoreVersion', (id: number, versionId: number) => {
    const q = workspace.getSaved(id)
    const v = workspace.version(id, versionId)
    if (!q || !v) throw new Error(t('main.versionMissing'))
    return saveQuery({ ...q, sql: v.sql })
  })
  handle('snippets:list', (projectId: number | null) => workspace.listSnippets(projectId))
  handle('snippets:save', (s: SnippetInput) => workspace.saveSnippet(s))
  handle('snippets:remove', (id: number) => workspace.removeSnippet(id))

  // .sql datoteke: kodiranje se prepoznaje pri čitanju i zadržava pri spremanju.
  const readTextFile = async (path: string): Promise<TextFile> => {
    const size = (await stat(path)).size
    if (size > MAX_FILE_BYTES) throw new Error(t('main.fileTooLarge', Math.round(size / 1048576)))
    const { text, encoding } = decodeText(await readFile(path))
    return { path, name: basename(path), text, encoding }
  }
  const sqlFilters = () => [
    { name: t('main.filterSql'), extensions: ['sql'] },
    { name: t('main.filterText'), extensions: ['txt'] },
    { name: t('main.filterAll'), extensions: ['*'] }
  ]
  handle('files:open', async function () {
    const win = BrowserWindow.fromWebContents(this)
    const opts = { title: t('main.openSqlTitle'), filters: sqlFilters(), properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled) return []
    r.filePaths.forEach((p) => grants.add(p))
    return Promise.all(r.filePaths.map(readTextFile))
  })
  // Putanju daje preload (webUtils.getPathForFile) za datoteku povučenu u prozor; renderer je ne može izmisliti.
  handle('files:readDropped', (path: string) => {
    if (typeof path !== 'string' || !path) throw new Error(t('main.fileNotGranted'))
    grants.add(path)
    return readTextFile(path)
  })
  handle('files:save', async (path: string, text: string, encoding: TextEncodingName) => {
    if (!grants.has(path)) throw new Error(t('main.fileNotGranted'))
    const out = encodeText(text, encoding)
    await writeFile(path, out.bytes)
    return out.encoding
  })
  handle('files:saveAs', async function (name: string, text: string, encoding?: TextEncodingName) {
    const win = BrowserWindow.fromWebContents(this)
    const defaultPath = /\.\w+$/.test(name) ? name : `${name || t('main.defaultFileName')}.sql`
    const opts = { title: t('main.saveSqlTitle'), defaultPath, filters: sqlFilters() }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    grants.add(r.filePath)
    const out = encodeText(text, encoding ?? 'utf8')
    await writeFile(r.filePath, out.bytes)
    return { path: r.filePath, name: basename(r.filePath), text, encoding: out.encoding }
  })
  handle('saved:remove', (id: number) => workspace.removeSaved(id))
  handle('saved:setPinned', (id: number, pinned: boolean) => workspace.setPinned(id, pinned))
}

/** Spremanje queryja s fingerprintom i analizom po dijalektu konekcije (i za vraćanje verzije). */
function saveQuery(q: SavedQueryInput) {
  const dialect = dialectOf(q.connectionId)
  const { tables, types } = analyzeSql(q.sql, dialect)
  return workspace.saveQuery(q, { fingerprint: fingerprintSql(q.sql, dialect).hash, tables, types })
}

function dialectOf(connectionId: string | undefined): FingerprintDialect {
  return (connectionId && store.get(connectionId)?.type) || 'generic'
}

/** Bilježi svako izvršavanje, i uspješno i neuspješno; greška u povijesti nikad ne ruši upit. */
function recordRun(sid: string, sql: string, result: QueryResult | undefined, elapsedMs: number, o?: ExecuteOptions): RunInfo | undefined {
  try {
    const s = manager.sessionInfo(sid)
    if (!s) return undefined
    const durationMs = result?.durationMs ?? elapsedMs
    // Izvršavanje s varijablama: u povijest ide predložak + vrijednosti (fingerprint ne ovisi o vrijednostima).
    const text = o?.template ?? sql
    return workspace.addRun({
      sql: text,
      params: o?.template ? o.params : undefined,
      fingerprint: fingerprintSql(text, dialectOf(s.connectionId)).hash,
      connectionId: s.connectionId,
      connectionName: store.get(s.connectionId)?.name ?? '?',
      database: s.database,
      queryId: o?.savedQueryId,
      projectId: o?.projectId,
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      durationMs,
      rows: result ? result.resultSets.reduce((n, rs) => n + rs.totalRows, 0) : 0,
      status: !result ? 'error' : result.cancelled ? 'cancelled' : result.error ? 'error' : 'success',
      error: result ? result.error : t('main.runFailed')
    })
  } catch (err) {
    console.error('history:', err)
    return undefined
  }
}

/** Queryji spremljeni prije v0.11 dobivaju tablice i vrste naredbi (jednom). */
function analyzeOldQueries(): void {
  try {
    for (const q of workspace.unanalyzed()) {
      const { tables, types } = analyzeSql(q.sql, dialectOf(q.connectionId))
      workspace.setAnalysis(q.id, tables, types)
    }
  } catch (err) {
    console.error('analyze saved queries:', err)
  }
}

/** Stara povijest (history.jsonl, do v0.9) prelazi u qucore.db jednom; datoteka ostaje kao .imported. */
function importOldHistory(file: string): void {
  if (!existsSync(file)) return
  try {
    if (workspace.runCount() === 0) {
      const runs: NewRun[] = []
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as HistoryEntry
          runs.push({
            sql: e.sql,
            fingerprint: fingerprintSql(e.sql, dialectOf(e.connectionId)).hash,
            connectionId: e.connectionId,
            connectionName: e.connectionName,
            database: e.database,
            startedAt: e.ts,
            durationMs: e.durationMs,
            rows: e.rows,
            status: e.error ? 'error' : 'success',
            error: e.error
          })
        } catch {
          // oštećen redak se preskače, kao i dosad
        }
      }
      workspace.importRuns(runs)
    }
    renameSync(file, file + '.imported')
  } catch (err) {
    console.error('history import:', err)
  }
}

app.whenReady().then(() => {
  store = new ConnectionStore(join(app.getPath('userData'), 'connections.json'))
  manager = new ConnectionManager(store)
  workspace = new WorkspaceStore(join(app.getPath('userData'), 'qucore.db'))
  grants = new FileGrants(join(app.getPath('userData'), 'file-grants.json'))
  importOldHistory(join(app.getPath('userData'), 'history.jsonl'))
  analyzeOldQueries()
  // Windows/Linux: bez izbornika (sve je u prozoru). macOS bez izbornika aplikacije nema Cmd+C/V/X/A ni Cmd+Q,
  // pa dobiva standardne uloge (QuCore, Uredi, Prozor).
  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null
  )
  // Aplikacija ne treba kameru, mikrofon, lokaciju, obavijesti…: sve se odbija osim pisanja u međuspremnik (Kopiraj).
  const allowed = new Set(['clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
let relaunchOnQuit = false
app.on('will-quit', () => {
  if (relaunchOnQuit) app.relaunch()
})
app.on('before-quit', (e) => {
  if (quitting || !manager) return
  e.preventDefault()
  quitting = true
  manager.closeAll().finally(() => {
    workspace?.close()
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
