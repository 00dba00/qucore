import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bookmark, ChevronRight, Folder, HelpCircle, Search, StarSolid } from '@vectilume/react'
import { parseSavedSearch, searchHelp } from '../../../core/savedSearch'
import { api } from '../api'
import type { ConnectionInfo, Project, SavedQuery, SavedQueryInput } from '../../../shared/types'
import { useContextMenu } from './ContextMenu'
import { compareText, dateDMY, locale, t, timeHM } from '../i18n'

/**
 * Projekti koje dijalog nudi kod prvog spremanja: ako baza pripada samo jednom projektu, taj;
 * ako pripada na više ili nijednom, aktivni projekt (ako postoji).
 */
export function suggestProjects(projects: Project[], connectionId: string | undefined, database: string | undefined, activeId: number | null): number[] {
  const owners = projects.filter((p) => !p.archived && p.databases.some((d) => d.connectionId === connectionId && d.database === database))
  if (owners.length === 1) return [owners[0].id]
  return activeId !== null ? [activeId] : []
}

export interface SaveRequest {
  /** Postojeći query (Spremi kao… ga nema). */
  existing?: SavedQuery
  sql: string
  connectionId?: string
  database?: string
  /** Alias taba (ako je vezan) — predlaže se pri spremanju. */
  aliasId?: number
  defaultTitle: string
  /** Tab iz kojeg se sprema — dobiva vezu na spremljeni query. */
  tabId?: string
}

export function SaveQueryDialog({
  request,
  projects,
  activeProjectId,
  connections,
  onClose,
  onSaved,
  notify
}: {
  request: SaveRequest
  projects: Project[]
  activeProjectId: number | null
  connections: ConnectionInfo[]
  onClose(): void
  onSaved(q: SavedQuery): void
  notify(text: string, kind?: 'error' | 'info'): void
}) {
  const { existing } = request
  const [title, setTitle] = useState(existing?.title ?? request.defaultTitle)
  const [description, setDescription] = useState(existing?.description ?? '')
  const [folder, setFolder] = useState(existing?.folder ?? '')
  const [folders, setFolders] = useState<string[]>([])
  useEffect(() => {
    api.saved.folders().then(setFolders, () => setFolders([]))
  }, [])
  const [checked, setChecked] = useState(
    () => new Set(existing ? existing.projectIds : suggestProjects(projects, request.connectionId, request.database, activeProjectId))
  )
  const [busy, setBusy] = useState(false)
  const conn = connections.find((c) => c.id === request.connectionId)

  // Aliasi svih aktivnih projekata; predlaže se alias taba, ili jedini alias koji pokazuje na bazu taba.
  const aliases = projects.filter((p) => !p.archived).flatMap((p) => p.aliases.map((a) => ({ project: p, alias: a })))
  const [aliasId, setAliasId] = useState<number | undefined>(() => {
    if (existing) return existing.aliasId
    if (request.aliasId) return request.aliasId
    const here = aliases.filter((x) => x.alias.targets.some((t) => t.connectionId === request.connectionId && t.database === request.database))
    return here.length === 1 ? here[0].alias.id : undefined
  })
  // Odabran alias uključuje i svoj projekt.
  const aliasProject = aliases.find((x) => x.alias.id === aliasId)?.project.id
  useEffect(() => {
    if (aliasProject !== undefined) setChecked((s) => (s.has(aliasProject) ? s : new Set([...s, aliasProject])))
  }, [aliasProject])

  const toggle = (id: number) =>
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const save = async () => {
    setBusy(true)
    try {
      const input: SavedQueryInput = {
        id: existing?.id,
        title,
        description,
        sql: request.sql,
        connectionId: request.connectionId,
        database: request.database,
        projectIds: [...checked],
        aliasId,
        folder
      }
      onSaved(await api.saved.save(input))
    } catch (e) {
      notify((e as Error).message, 'error')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2>{existing ? t('saved.titleExisting') : t('saved.titleNew')}</h2>
        <div className="form-grid">
          <label>{t('saved.titleLabel')}</label>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onFocus={(e) => e.target.select()} />
          <label className="top">{t('projects.description')}</label>
          <textarea rows={3} value={description} placeholder={t('saved.descPlaceholder')} onChange={(e) => setDescription(e.target.value)} />
          <label>{t('saved.folder')}</label>
          <input list="saved-folders" value={folder} placeholder={t('saved.folderPlaceholder')} onChange={(e) => setFolder(e.target.value)} />
          <datalist id="saved-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <label>{t('conn.database')}</label>
          <span className={conn ? '' : 'muted'}>
            {conn ? `${conn.name}${request.database ? ' / ' + request.database : ''}` : t('saved.noConnection')}
          </span>
          {aliases.length > 0 && (
            <>
              <label>Alias</label>
              <select
                value={aliasId ?? ''}
                title={t('saved.aliasTitle')}
                onChange={(e) => setAliasId(e.target.value ? Number(e.target.value) : undefined)}
              >
                <option value="">— {t('saved.fixedConnection')} —</option>
                {aliases.map(({ project, alias }) => (
                  <option key={alias.id} value={alias.id}>
                    {alias.name} ({project.name}: {alias.targets.map((x) => x.env).join('/') || t('saved.noDbs')})
                  </option>
                ))}
              </select>
            </>
          )}
          <label className="top">{t('projects.title')}</label>
          <div className="check-list">
            {projects
              .filter((p) => !p.archived || checked.has(p.id))
              .map((p) => (
                <label key={p.id}>
                  <input type="checkbox" checked={checked.has(p.id)} onChange={() => toggle(p.id)} />
                  <span className="color-dot static" style={{ background: p.color || 'var(--bg-3)' }} />
                  {p.name}
                </label>
              ))}
            {projects.length === 0 && <span className="muted small">{t('saved.noProjects')}</span>}
          </div>
        </div>
        <div className="modal-actions">
          <span className="muted small">{t('saved.sqlChars', request.sql.length)}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim()}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  )
}

const COLLAPSED_KEY = 'qucore.collapsedFolders'
const RECENT_DAYS = 14
const RECENT_MAX = 5

function formatDate(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return timeHM(d)
  return dateDMY(d, d.getFullYear() !== today.getFullYear())
}

/** Sidebar panel: spremljeni queryji aktivnog projekta (ili svi), prikvačeni prvi. */
export function SavedPanel({
  connections,
  projects,
  activeProjectId,
  version,
  visible,
  onOpen,
  onInsert,
  onEdit,
  onHistory,
  onChanged,
  notify
}: {
  connections: ConnectionInfo[]
  projects: Project[]
  activeProjectId: number | null
  /** Mijenja se kad se nešto spremi, pa se lista ponovno učita. */
  version: number
  visible: boolean
  onOpen(q: SavedQuery): void
  onInsert(sql: string): void
  onEdit(q: SavedQuery): void
  /** Verzije i izvršavanja. */
  onHistory(q: SavedQuery): void
  onChanged(): void
  notify(text: string, kind?: 'error' | 'info'): void
}) {
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<SavedQuery[]>([])
  const [help, setHelp] = useState(false)
  const openMenu = useContextMenu()
  // Zatvorene mape pamte se između pokretanja.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggleFolder = (f: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(f)) n.delete(f)
      else n.add(f)
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...n]))
      return n
    })

  // Napomene o sintaksi i nepoznatim projektima (filtriranje radi main).
  const hints = useMemo(() => {
    const parsed = parseSavedSearch(search)
    const names = new Set(projects.map((p) => p.name.toLowerCase()))
    return [...parsed.problems, ...parsed.projects.filter((n) => !names.has(n.toLowerCase())).map((n) => t('saved.noSuchProject', n))]
  }, [search, projects])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const list = await api.saved.list({ search, projectId: activeProjectId ?? undefined })
        if (!cancelled) setItems(list)
      } catch (e) {
        notify((e as Error).message, 'error')
      }
    }, search ? 150 : 0)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [visible, search, activeProjectId, version, notify])

  const names = new Map(connections.map((c) => [c.id, c]))
  const projectNames = new Map(projects.map((p) => [p.id, p]))

  const act = (fn: () => Promise<void>) => () =>
    void fn().then(onChanged, (e) => notify((e as Error).message, 'error'))

  const renderRow = (q: SavedQuery, keyPrefix: string, searching: boolean) => {
    const broken = (q.schemaCheck?.missing.length ?? 0) > 0
    const conn = q.connectionId ? names.get(q.connectionId) : undefined
    return (
      <div
        key={keyPrefix + q.id}
        className="history-row saved-row"
        title={
          (q.description ? q.description + '\n\n' : '') +
          (q.tables.length ? `${t('saved.tables')}: ${q.tables.join(', ')}\n` : '') +
          (q.statementTypes.length ? `${t('saved.kind')}: ${q.statementTypes.join(', ')}\n\n` : q.tables.length ? '\n' : '') +
          (q.sql.length > 2000 ? q.sql.slice(0, 2000) + '\n…' : q.sql)
        }
        onDoubleClick={() => onOpen(q)}
        onContextMenu={(e) =>
          openMenu(e, [
            { label: t('saved.open'), shortcut: t('common.doubleClick'), onClick: () => onOpen(q) },
            { label: t('history.insert'), onClick: () => onInsert(q.sql) },
            { label: t('common.copySql'), onClick: () => void navigator.clipboard.writeText(q.sql) },
            'separator',
            { label: q.pinned ? t('saved.unpin') : t('saved.pin'), onClick: act(() => api.saved.setPinned(q.id, !q.pinned)) },
            { label: t('saved.editMeta'), onClick: () => onEdit(q) },
            { label: t('saved.versions', q.versionCount), onClick: () => onHistory(q) },
            'separator',
            {
              label: t('common.delete'),
              danger: true,
              onClick: act(async () => {
                if (confirm(t('saved.confirmDelete', q.title))) await api.saved.remove(q.id)
              })
            }
          ])
        }
      >
        <div className="saved-title">
          {q.pinned && <StarSolid size={12} className="saved-pin" />}
          {broken && (
            <span
              className="saved-broken"
              title={t('saved.broken', q.schemaCheck!.missing.join(', '), `${names.get(q.schemaCheck!.connectionId)?.name ?? '?'} / ${q.schemaCheck!.database}`, formatDate(q.schemaCheck!.at))}
            >
              <AlertTriangle size={12} />
            </span>
          )}
          <span>{q.title}</span>
        </div>
        <div className="history-meta">
          {searching && q.folder && <span className="project-chip">{q.folder}</span>}
          <span className={conn?.color ? 'history-conn accented' : 'history-conn'} style={conn?.color ? { color: conn.color } : undefined}>
            {conn ? `${conn.name}${q.database ? ' / ' + q.database : ''}` : t('saved.noConnection')}
          </span>
          {activeProjectId === null &&
            q.projectIds.map((id) => {
              const p = projectNames.get(id)
              return p ? (
                <span key={id} className="project-chip" style={p.color ? { borderColor: p.color } : undefined}>
                  {p.name}
                </span>
              ) : null
            })}
          {q.runCount > 0 ? (
            <span title={t('saved.runs', q.runCount, new Date(q.lastRunAt!).toLocaleString(locale()))}>
              ×{q.runCount} · {formatDate(q.lastRunAt!)}
            </span>
          ) : (
            <span title={t('saved.notRun')}>{formatDate(q.updatedAt)}</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="history" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="explorer-filter">
        <Search size={14} />
        <input
          placeholder={t('saved.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
        />
        <button className={'icon-btn search-help-btn' + (help ? ' active' : '')} title={t('saved.searchHelp')} onClick={() => setHelp((h) => !h)}>
          <HelpCircle size={14} />
        </button>
      </div>
      {help && (
        <div className="search-help">
          <p>{t('saved.searchHelpText')}</p>
          <table>
            <tbody>
              {searchHelp().map(([example, text]) => (
                <tr key={example}>
                  <td>
                    <button className="link-btn" onClick={() => setSearch((s) => (s.trim() ? s.trim() + ' ' : '') + example)}>
                      {example}
                    </button>
                  </td>
                  <td>{text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hints.length > 0 && (
        <div className="search-hints">
          {hints.map((h) => (
            <div key={h}>{h}</div>
          ))}
        </div>
      )}
      <div className="history-list">
        {(() => {
          // Bez pretrage: Nedavno pokretano, pa queryji bez mape, pa mape (abecedno, sklopive).
          const searching = !!search.trim()
          const row = (q: SavedQuery, keyPrefix = '') => renderRow(q, keyPrefix, searching)
          if (searching) return items.map((q) => row(q))
          const since = Date.now() - RECENT_DAYS * 86400000
          const recent = items
            .filter((q) => q.lastRunAt && Date.parse(q.lastRunAt) >= since)
            .sort((a, b) => Date.parse(b.lastRunAt!) - Date.parse(a.lastRunAt!))
            .slice(0, RECENT_MAX)
          const byFolder = new Map<string, SavedQuery[]>()
          for (const q of items) byFolder.set(q.folder, [...(byFolder.get(q.folder) ?? []), q])
          const folderNames = [...byFolder.keys()].filter(Boolean).sort(compareText)
          return (
            <>
              {recent.length > 0 && items.length > RECENT_MAX && (
                <>
                  <div className="saved-group-head static">{t('saved.recent')}</div>
                  {recent.map((q) => row(q, 'r'))}
                  <div className="saved-group-head static">{t('saved.all')}</div>
                </>
              )}
              {(byFolder.get('') ?? []).map((q) => row(q))}
              {folderNames.map((f) => (
                <div key={'f:' + f}>
                  <div className="saved-group-head" onClick={() => toggleFolder(f)}>
                    <ChevronRight size={12} className={'saved-chevron' + (collapsed.has(f) ? '' : ' open')} />
                    <Folder size={13} />
                    <span>{f}</span>
                    <span className="muted small">{byFolder.get(f)!.length}</span>
                  </div>
                  {!collapsed.has(f) && byFolder.get(f)!.map((q) => row(q))}
                </div>
              ))}
            </>
          )
        })()}
        {items.length === 0 && (
          <div className="explorer-empty">
            <Bookmark size={28} />
            <p>{search ? t('common.noResults') : activeProjectId !== null ? t('saved.emptyProject') : t('saved.empty')}</p>
            {!search && <p className="small">{t('saved.emptyHint')}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
