import { useMemo, useState } from 'react'
import type { PlanNode, QueryPlan } from '../../../shared/types'
import { selfCost, selfTime } from '../../../core/plan'
import { num, t } from '../i18n'

interface Row {
  node: PlanNode
  path: string
  depth: number
  /** Vlastiti udio (vrijeme kod ANALYZE, inače procijenjeni trošak) bez djece. */
  self?: number
}

function flatten(n: PlanNode, analyzed: boolean, depth = 0, path = '0', out: Row[] = []): Row[] {
  const self = analyzed && n.timeMs !== undefined ? selfTime(n) : selfCost(n)
  out.push({ node: n, path, depth, self })
  n.children.forEach((c, i) => flatten(c, analyzed, depth + 1, `${path}.${i}`, out))
  return out
}

const fmt = (n: number | undefined, digits = 0) =>
  n === undefined ? '' : num(n, { maximumFractionDigits: digits, minimumFractionDigits: 0 })

/**
 * Plan kao stablo: najskuplji korak (vlastito vrijeme ili trošak) je istaknut, a velika razlika
 * procijenjenih i stvarnih redaka označena — to su najčešći uzroci sporih upita.
 */
export function PlanView({ plan, canAnalyze, onAnalyze }: { plan: QueryPlan; canAnalyze: boolean; onAnalyze(): void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)
  const rows = useMemo(() => flatten(plan.root, plan.analyzed), [plan])
  const maxSelf = Math.max(0, ...rows.map((r) => r.self ?? 0))
  const visible = rows.filter((r) => ![...collapsed].some((c) => r.path.startsWith(c + '.')))
  const toggle = (path: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(path)) n.delete(path)
      else n.add(path)
      return n
    })
  const misestimate = (n: PlanNode) =>
    n.actualRows !== undefined && n.rows !== undefined && Math.max(n.actualRows, 1) / Math.max(n.rows, 1) >= 10
      ? t('plan.more')
      : n.actualRows !== undefined && n.rows !== undefined && Math.max(n.rows, 1) / Math.max(n.actualRows, 1) >= 10
        ? t('plan.less')
        : undefined

  return (
    <div className="plan-view">
      <div className="plan-head">
        <b>{t('plan.title')}</b>
        <span className="muted small">
          {plan.analyzed
            ? `${t('plan.executed')}${plan.totalMs !== undefined ? ` · ${fmt(plan.totalMs, 1)} ms` : ''}`
            : t('plan.estimate')}
        </span>
        <span style={{ flex: 1 }} />
        {canAnalyze && !plan.analyzed && (
          <button className="link-btn" onClick={onAnalyze} title={t('plan.analyzeTitle')}>
            {t('plan.analyze')}
          </button>
        )}
        <button
          className="link-btn"
          onClick={() => {
            void navigator.clipboard.writeText(plan.raw)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          title={t('plan.copyRawTitle')}
        >
          {copied ? t('common.copied') : t('plan.copyRaw')}
        </button>
      </div>
      <div className="plan-table">
        <table>
          <thead>
            <tr>
              <th>{t('plan.colOperation')}</th>
              <th>{t('plan.colDetail')}</th>
              <th className="num">{t('plan.colCost')}</th>
              <th className="num">{t('plan.colRowsEst')}</th>
              {plan.analyzed && <th className="num">{t('plan.colRowsActual')}</th>}
              {plan.analyzed && <th className="num">{t('plan.colTime')}</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const hot = maxSelf > 0 && r.self !== undefined && r.self >= maxSelf * 0.999
              const miss = misestimate(r.node)
              return (
                <tr key={r.path} className={hot ? 'hot' : ''}>
                  <td style={{ paddingLeft: 8 + r.depth * 16 }} className="plan-op">
                    {r.node.children.length > 0 ? (
                      <button className="plan-toggle" onClick={() => toggle(r.path)}>
                        {collapsed.has(r.path) ? '▸' : '▾'}
                      </button>
                    ) : (
                      <span className="plan-toggle" />
                    )}
                    {r.node.label}
                    {hot && (
                      <span className="plan-hot" title={plan.analyzed ? t('plan.hotTime') : t('plan.hotCost')}>
                        {t('plan.hot')}
                      </span>
                    )}
                  </td>
                  <td className="plan-detail" title={r.node.detail}>
                    {r.node.detail}
                  </td>
                  <td className="num">{fmt(r.node.cost, 2)}</td>
                  <td className="num">{fmt(r.node.rows)}</td>
                  {plan.analyzed && (
                    <td
                      className={'num' + (miss ? ' miss' : '')}
                      title={miss ? t('plan.misestimate', miss) : undefined}
                    >
                      {fmt(r.node.actualRows)}
                    </td>
                  )}
                  {plan.analyzed && <td className="num">{fmt(r.node.timeMs, 2)}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
