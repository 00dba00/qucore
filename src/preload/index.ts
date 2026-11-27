import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { JobProgress, QueryProgress, StudioApi } from '../shared/types'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; value?: T; error?: string }
  if (!r.ok) throw new Error(r.error)
  return r.value as T
}

const api: StudioApi = {
  app: {
    setLanguage: (lang) => call('app:setLanguage', lang),
    relaunch: () => call('app:relaunch'),
    cancelRelaunch: () => call('app:cancelRelaunch')
  },
  connections: {
    list: () => call('connections:list'),
    get: (id) => call('connections:get', id),
    save: (c) => call('connections:save', c),
    remove: (id) => call('connections:remove', id),
    test: (c) => call('connections:test', c),
    passwordStorage: () => call('connections:passwordStorage')
  },
  explorer: {
    connect: (id) => call('explorer:connect', id),
    disconnect: (id) => call('explorer:disconnect', id),
    databases: (id) => call('explorer:databases', id),
    databaseSizes: (id) => call('explorer:databaseSizes', id),
    objects: (id, db) => call('explorer:objects', id, db),
    children: (id, db, o) => call('explorer:children', id, db, o),
    definition: (id, db, o) => call('explorer:definition', id, db, o),
    tableDetails: (id, db, o) => call('explorer:tableDetails', id, db, o),
    schemaGraph: (id, db) => call('explorer:schemaGraph', id, db)
  },
  edits: {
    preview: (id, t, e) => call('edits:preview', id, t, e),
    apply: (id, t, e) => call('edits:apply', id, t, e)
  },
  query: {
    openSession: (id, db) => call('query:openSession', id, db),
    execute: (sid, sql, o) => call('query:execute', sid, sql, o),
    fetchMore: (sid, mode) => call('query:fetchMore', sid, mode),
    onProgress: (sid, listener) => {
      const h = (_e: IpcRendererEvent, s: string, p: QueryProgress) => {
        if (s === sid) listener(p)
      }
      ipcRenderer.on('query:progress', h)
      return () => void ipcRenderer.removeListener('query:progress', h)
    },
    cancel: (sid) => call('query:cancel', sid),
    closeSession: (sid) => call('query:closeSession', sid),
    currentDatabase: (sid) => call('query:currentDatabase', sid),
    transaction: (sid, action) => call('query:transaction', sid, action),
    explain: (sid, sql, analyze) => call('query:explain', sid, sql, analyze)
  },
  history: {
    list: (q) => call('history:list', q),
    remove: (id) => call('history:remove', id),
    clear: () => call('history:clear'),
    ignoreSuggestion: (fp) => call('history:ignoreSuggestion', fp)
  },
  projects: {
    list: () => call('projects:list'),
    save: (p) => call('projects:save', p),
    remove: (id) => call('projects:remove', id),
    setDatabaseProjects: (ref, ids) => call('projects:setDatabaseProjects', ref, ids),
    setDefaultEnv: (id, env) => call('projects:setDefaultEnv', id, env)
  },
  params: {
    get: (projectId, names) => call('params:get', projectId, names),
    save: (projectId, values) => call('params:save', projectId, values)
  },
  saved: {
    list: (f) => call('saved:list', f),
    get: (id) => call('saved:get', id),
    save: (q) => call('saved:save', q),
    remove: (id) => call('saved:remove', id),
    setPinned: (id, pinned) => call('saved:setPinned', id, pinned),
    versions: (id) => call('saved:versions', id),
    runs: (id, limit) => call('saved:runs', id, limit),
    restoreVersion: (id, versionId) => call('saved:restoreVersion', id, versionId),
    folders: () => call('saved:folders')
  },
  snippets: {
    list: (projectId) => call('snippets:list', projectId),
    save: (s) => call('snippets:save', s),
    remove: (id) => call('snippets:remove', id)
  },
  jobs: {
    list: (projectId) => call('jobs:list', projectId),
    get: (id) => call('jobs:get', id),
    save: (j) => call('jobs:save', j),
    remove: (id) => call('jobs:remove', id),
    run: (id) => call('jobs:run', id),
    cancel: (id) => call('jobs:cancel', id),
    onProgress: (listener) => {
      const h = (_e: IpcRendererEvent, p: JobProgress) => listener(p)
      ipcRenderer.on('jobs:progress', h)
      return () => void ipcRenderer.removeListener('jobs:progress', h)
    },
    runs: (id, limit) => call('jobs:runs', id, limit),
    sourceColumns: (source) => call('jobs:sourceColumns', source),
    chooseFolder: () => call('jobs:chooseFolder'),
    testHttp: (id) => call('jobs:testHttp', id)
  },
  credentials: {
    list: () => call('credentials:list'),
    save: (c) => call('credentials:save', c),
    remove: (id) => call('credentials:remove', id)
  },
  files: {
    open: () => call('files:open'),
    readDropped: (file) => call('files:readDropped', webUtils.getPathForFile(file)),
    save: (path, text, encoding) => call('files:save', path, text, encoding),
    saveAs: (name, text, encoding) => call('files:saveAs', name, text, encoding)
  }
}

contextBridge.exposeInMainWorld('api', api)
