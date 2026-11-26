import { useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, Briefcase } from '@vectilume/react'
import { api } from '../api'
import type { ConnectionInfo, Project, SavedQuery } from '../../../shared/types'
import { t } from '../i18n'

type Item =
  | { kind: 'all'; key: string; label: string }
  | { kind: 'project'; key: string; label: string; project: Project }
  | { kind: 'query'; key: string; label: string; query: SavedQuery; detail: string }

/** Svako slovo upita mora se pojaviti redom (kao u VS Code Ctrl+P); manji rezultat = bolje. */
function fuzzyScore(text: string, q: string): number | null {
  if (!q) return 0
  const t = text.toLowerCase()
  const direct = t.indexOf(q)
  if (direct >= 0) return direct
  let pos = -1
  let gaps = 0
  for (const ch of q) {
    const next = t.indexOf(ch, pos + 1)
    if (next < 0) return null
    gaps += next - pos - 1
    pos = next
  }
  return 100 + gaps
}

/**
 * Ctrl+P: projekti i spremljeni queryji (aktivnog projekta, ili svi); Ctrl+Shift+P: samo projekti.
 */
export function QuickSwitcher({
  mode,
  projects,
  activeProjectId,
  connections,
  onClose,
  onProject,
  onQuery
}: {
  mode: 'all' | 'projects'
  projects: Project[]
  activeProjectId: number | null
  connections: ConnectionInfo[]
  onClose(): void
  onProject(id: number | null): void
  onQuery(q: SavedQuery): void
}) {
  const [text, setText] = useState('')
  const [queries, setQueries] = useState<SavedQuery[]>([])
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mode !== 'all') return
    api.saved.list({ projectId: activeProjectId ?? undefined }).then(setQueries, () => setQueries([]))
  }, [mode, activeProjectId])

  const items = useMemo(() => {
    const q = text.trim().toLowerCase()
    const names = new Map(connections.map((c) => [c.id, c.name]))
    const all: Item[] = [
      ...(mode === 'all'
        ? queries.map<Item>((s) => ({
            kind: 'query',
            key: 'q' + s.id,
            label: s.title,
            query: s,
            detail: s.connectionId ? `${names.get(s.connectionId) ?? '?'}${s.database ? ' / ' + s.database : ''}` : ''
          }))
        : []),
      { kind: 'all', key: 'all', label: t('common.allProjects') },
      ...projects.filter((p) => !p.archived).map<Item>((p) => ({ kind: 'project', key: 'p' + p.id, label: p.name, project: p }))
    ]
    return all
      .map((it) => ({ it, score: fuzzyScore(it.label, q) }))
      .filter((x): x is { it: Item; score: number } => x.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.it)
  }, [text, queries, projects, connections, mode])

  useEffect(() => setIndex(0), [text])
  useEffect(() => {
    listRef.current?.querySelector('.qs-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (it: Item | undefined) => {
    if (!it) return
    onClose()
    if (it.kind === 'all') onProject(null)
    else if (it.kind === 'project') onProject(it.project.id)
    else onQuery(it.query)
  }

  return (
    <div className="modal-backdrop qs-backdrop" onMouseDown={onClose}>
      <div className="quick-switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={text}
          placeholder={mode === 'all' ? t('qs.placeholderAll') : t('qs.placeholderProjects')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(items.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(items[index])
            }
          }}
        />
        <div className="qs-list" ref={listRef}>
          {items.map((it, i) => {
            const isActiveProject = (it.kind === 'project' && it.project.id === activeProjectId) || (it.kind === 'all' && activeProjectId === null)
            return (
              <div
                key={it.key}
                className={'qs-item' + (i === index ? ' active' : '')}
                onMouseEnter={() => setIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(it)
                }}
              >
                {it.kind === 'query' ? (
                  <Bookmark size={14} className="qs-icon" />
                ) : (
                  <Briefcase size={14} className="qs-icon" style={it.kind === 'project' && it.project.color ? { color: it.project.color } : undefined} />
                )}
                <span className="qs-label">{it.label}</span>
                <span className="qs-detail">
                  {it.kind === 'query' ? it.detail : isActiveProject ? t('qs.active') : t('qs.project')}
                </span>
              </div>
            )
          })}
          {items.length === 0 && <div className="qs-empty">{t('common.noResults')}</div>}
        </div>
      </div>
    </div>
  )
}
