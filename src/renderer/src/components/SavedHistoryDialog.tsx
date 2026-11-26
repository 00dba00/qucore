import { useEffect, useRef, useState } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import { api } from '../api'
import '../monaco'
import { MONACO_LANGUAGE } from '../dialect'
import type { ConnectionInfo, QueryVersion, SavedQuery, SavedRun } from '../../../shared/types'
import { dateDMY, num, t, timeHM } from '../i18n'

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${dateDMY(d)} ${timeHM(d)}`
}

/**
 * Mali stupčasti graf jedne mjere (trajanje ili broj redaka) po izvršavanju, najstarije lijevo.
 * Jedna serija → bez legende, naslov je imenuje; neuspjela izvršavanja sivo, s oznakom u tooltipu.
 */
function RunBars({ title, runs, value, format }: { title: string; runs: SavedRun[]; value(r: SavedRun): number; format(v: number): string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 100
  const H = 56
  const max = Math.max(1, ...runs.map(value))
  // Najmanje 30 mjesta: stupci ostaju tanki i kad izvršavanja ima malo; najnovije je desno.
  const slots = Math.max(runs.length, 30)
  const step = W / slots
  const offset = (slots - runs.length) * step
  const gap = Math.min(0.6, step * 0.25)
  const h = hover !== null ? runs[hover] : undefined
  return (
    <div className="run-chart">
      <div className="run-chart-head">
        <span>{title}</span>
        <span className="muted">{t('runs.max', format(max))}</span>
      </div>
      <div className="run-chart-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={title}>
          <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="run-chart-base" />
          {runs.map((r, i) => {
            const v = value(r)
            const bh = Math.max(v > 0 ? 1.5 : 0, (v / max) * (H - 4))
            return (
              <g key={r.id} onMouseEnter={() => setHover(i)}>
                {/* Pogodak širi od stupca: cijela visina i širina koraka. */}
                <rect x={offset + i * step} y={0} width={step} height={H} fill="transparent" />
                <rect
                  x={offset + i * step + gap / 2}
                  y={H - bh}
                  width={Math.max(0.4, step - gap)}
                  height={bh}
                  rx={Math.min(1, (step - gap) / 2)}
                  className={'run-bar' + (r.status !== 'success' ? ' failed' : '') + (hover === i ? ' hover' : '')}
                />
              </g>
            )
          })}
        </svg>
        {h && (
          <div className="run-tip" style={{ left: `${Math.min(85, Math.max(15, ((offset + (hover! + 0.5) * step) * 100) / W))}%` }}>
            <div>{formatDate(h.startedAt)}</div>
            <div>
              {formatMs(h.durationMs)} · {t('common.rowsN', h.rows)}
            </div>
            <div className="muted">
              {h.versionNumber ? t('runs.version', h.versionNumber) : t('runs.noVersion')}
              {h.status === 'error' ? ' · ' + t('history.error') : h.status === 'cancelled' ? ' · ' + t('history.cancelled') : ''}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Verzije spremljenog queryja (usporedba, vraćanje) i trend izvršavanja. */
export function SavedHistoryDialog({
  query,
  connections,
  onClose,
  onRestored,
  onOpenVersion,
  notify
}: {
  query: SavedQuery
  connections: ConnectionInfo[]
  onClose(): void
  onRestored(q: SavedQuery): void
  onOpenVersion(q: SavedQuery, v: QueryVersion): void
  notify(text: string, kind?: 'error' | 'info'): void
}) {
  const [versions, setVersions] = useState<QueryVersion[]>([])
  const [runs, setRuns] = useState<SavedRun[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [current, setCurrent] = useState(query)
  const conn = connections.find((c) => c.id === current.connectionId)

  // Modele diff editora gasimo sami, nakon što ih editor otpusti: inače Monaco javi
  // "TextModel got disposed before DiffEditorWidget model got reset" pri zatvaranju dijaloga.
  const diffRef = useRef<Parameters<DiffOnMount>[0] | null>(null)
  useEffect(
    () => () => {
      const ed = diffRef.current
      const m = ed?.getModel()
      ed?.setModel(null)
      m?.original.dispose()
      m?.modified.dispose()
    },
    []
  )

  const load = async (q: SavedQuery) => {
    const [v, r] = await Promise.all([api.saved.versions(q.id), api.saved.runs(q.id, 30)])
    setVersions(v)
    setRuns(r.reverse())
    // Zadano: pretposljednja verzija prema trenutnoj (što se zadnje promijenilo).
    setSelected((s) => (s && v.some((x) => x.id === s) ? s : (v[v.length - 2] ?? v[v.length - 1])?.id ?? null))
  }

  useEffect(() => {
    load(query).catch((e) => notify((e as Error).message, 'error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.id])

  const latest = versions[versions.length - 1]
  const sel = versions.find((v) => v.id === selected)
  const ok = runs.filter((r) => r.status === 'success')
  const sorted = ok.map((r) => r.durationMs).sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const med = !sorted.length ? 0 : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2

  const restore = async () => {
    if (!sel) return
    try {
      const q = await api.saved.restoreVersion(current.id, sel.id)
      setCurrent(q)
      await load(q)
      onRestored(q)
      notify(t('runs.restored', sel.number, q.versionCount))
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal history-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{t('runs.title', current.title)}</h2>
        <div className="versions-layout">
          <div className="versions-list">
            {[...versions].reverse().map((v) => (
              <button key={v.id} className={'versions-item' + (v.id === selected ? ' active' : '')} onClick={() => setSelected(v.id)}>
                <span className="versions-num">v{v.number}</span>
                <span className="versions-date">{formatDate(v.createdAt)}</span>
                <span className="muted small">
                  {v.id === latest?.id ? t('runs.current') + ' · ' : ''}×{v.runCount}
                </span>
              </button>
            ))}
          </div>
          <div className="versions-diff">
            <div className="versions-diff-head muted small">
              {sel ? (sel.id === latest?.id ? t('runs.isCurrent', sel.number) : t('runs.diff', sel.number, latest?.number ?? 0)) : ''}
            </div>
            {sel && latest && (
              <DiffEditor
                height="300px"
                theme="studio-dark"
                language={conn ? MONACO_LANGUAGE[conn.type] : 'sql'}
                original={sel.sql}
                modified={latest.sql}
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                onMount={(ed) => (diffRef.current = ed)}
                options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true }}
              />
            )}
          </div>
        </div>
        <div className="run-charts">
          {runs.length ? (
            <>
              <RunBars title={t('runs.duration')} runs={runs} value={(r) => r.durationMs} format={formatMs} />
              <RunBars title={t('runs.rows')} runs={runs} value={(r) => r.rows} format={(v) => num(Math.round(v))} />
              <div className="run-summary muted small">
                {t('runs.summary', runs.length, formatMs(med), formatMs(runs[runs.length - 1].durationMs))}
              </div>
            </>
          ) : (
            <div className="muted small">{t('runs.none')}</div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn" disabled={!sel} onClick={() => sel && onOpenVersion(current, sel)}>
            {t('history.openNewTab')}
          </button>
          <button className="btn primary" disabled={!sel || sel.id === latest?.id} onClick={() => void restore()}>
            {t('runs.restore')}
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
