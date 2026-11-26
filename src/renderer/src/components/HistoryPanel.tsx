import { useEffect, useState } from 'react'
import { History, Search } from '@vectilume/react'
import { api } from '../api'
import type { ConnectionInfo, DbRef, HistoryEntry } from '../../../shared/types'
import { rows } from '../../../core/util'
import { useContextMenu } from './ContextMenu'
import { dateDMY, t, timeHM } from '../i18n'

interface Props {
  connections: ConnectionInfo[]
  /** Konekcija aktivnog taba — za filter "Samo ova konekcija". */
  activeConnectionId?: string
  /** Baze aktivnog projekta; undefined = sva izvršavanja. */
  scope?: DbRef[]
  /** Mijenja se nakon svakog izvršavanja, pa se lista ponovno učita. */
  version: number
  visible: boolean
  onOpen(entry: HistoryEntry): void
  onInsert(sql: string): void
  notify(text: string, kind?: 'error' | 'info'): void
}

function firstLine(sql: string): string {
  const line = sql.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('--')) ?? sql.trim()
  return line.length > 200 ? line.slice(0, 200) + '…' : line
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const hm = timeHM(d)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return hm
  return `${dateDMY(d, d.getFullYear() !== today.getFullYear())} ${hm}`
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

export function HistoryPanel({ connections, activeConnectionId, scope, version, visible, onOpen, onInsert, notify }: Props) {
  const [search, setSearch] = useState('')
  const [onlyActive, setOnlyActive] = useState(false)
  const [items, setItems] = useState<HistoryEntry[]>([])
  const [reload, setReload] = useState(0)
  const openMenu = useContextMenu()

  const connectionId = onlyActive ? activeConnectionId : undefined

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const list = await api.history.list({ search, connectionId, scope })
        if (!cancelled) setItems(list)
      } catch (e) {
        notify((e as Error).message, 'error')
      }
    }, search ? 150 : 0)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [visible, search, connectionId, scope, version, reload, notify])

  const remove = async (id: string) => {
    await api.history.remove(id)
    setReload((n) => n + 1)
  }

  const names = new Map(connections.map((c) => [c.id, c]))

  return (
    <div className="history" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="explorer-filter">
        <Search size={14} />
        <input
          placeholder={t('history.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
        />
      </div>
      <label className="history-only" title={activeConnectionId ? undefined : t('history.noActiveConnection')}>
        <input type="checkbox" checked={onlyActive} disabled={!activeConnectionId} onChange={(e) => setOnlyActive(e.target.checked)} />
        {t('history.onlyActive')}
      </label>
      <div className="history-list">
        {items.map((h) => {
          const conn = names.get(h.connectionId)
          return (
            <div
              key={h.id}
              className={'history-row' + (h.error ? ' failed' : '')}
              style={conn?.color ? { ['--accent' as string]: conn.color } : undefined}
              title={h.sql.length > 2000 ? h.sql.slice(0, 2000) + '\n…' : h.sql}
              onDoubleClick={() => onOpen(h)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: t('history.openNewTab'), shortcut: t('common.doubleClick'), onClick: () => onOpen(h) },
                  { label: t('history.insert'), onClick: () => onInsert(h.sql) },
                  { label: t('common.copySql'), onClick: () => void navigator.clipboard.writeText(h.sql) },
                  'separator',
                  { label: t('history.delete'), danger: true, onClick: () => void remove(h.id) }
                ])
              }
            >
              <div className="history-sql">{firstLine(h.sql)}</div>
              <div className="history-meta">
                <span className={conn?.color ? 'history-conn accented' : 'history-conn'}>
                  {conn?.name ?? h.connectionName}
                  {h.database ? ` / ${h.database}` : ''}
                </span>
                <span>{formatTime(h.ts)}</span>
                <span>{formatDuration(h.durationMs)}</span>
                {h.error ? (
                  <span className="history-err" title={h.error}>{t('history.error')}</span>
                ) : h.cancelled ? (
                  <span className="history-cancelled">{t('history.cancelled')}</span>
                ) : (
                  <span>{rows(h.rows)}</span>
                )}
                {(h.repeats ?? 0) > 1 && (
                  <span className="history-repeats" title={t('history.repeats', h.repeats ?? 0)}>
                    ×{h.repeats}
                  </span>
                )}
              </div>
            </div>
          )
        })}
        {items.length === 0 && (
          <div className="explorer-empty">
            <History size={28} />
            <p>{search || onlyActive ? t('common.noResults') : scope ? t('history.emptyProject') : t('history.empty')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

/** Briše cijelu povijest uz potvrdu; vraća true ako je obrisano. */
export async function clearHistory(): Promise<boolean> {
  if (!confirm(t('history.confirmClear'))) return false
  await api.history.clear()
  return true
}
