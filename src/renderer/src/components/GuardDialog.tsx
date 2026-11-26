import { useState } from 'react'
import type { UnboundedWrite } from '../../../core/guard'
import { rich, t } from '../i18n'

export interface GuardIssues {
  /** Pisanje na prod konekciji. */
  prod?: { target: string; types: string[] }
  /** UPDATE/DELETE bez WHERE, TRUNCATE (na bilo kojem okruženju). */
  unbounded: UnboundedWrite[]
  /** Spremljeni query pokreće se na drugoj bazi. */
  wrongDb?: { saved: string; current: string }
}

export const hasIssues = (i: GuardIssues) => !!i.prod || i.unbounded.length > 0 || !!i.wrongDb

const typeLabel = (type: string): string =>
  ({ insert: 'INSERT', update: 'UPDATE', delete: 'DELETE', merge: 'MERGE', ddl: 'DDL (CREATE / ALTER / DROP / TRUNCATE)', exec: t('guard.typeExec') })[type] ?? type

const kindText = (kind: UnboundedWrite['kind']): string =>
  ({ update: t('guard.kindUpdate'), delete: t('guard.kindDelete'), truncate: t('guard.kindTruncate') })[kind]

/** Potvrda prije izvršavanja: prod, naredbe bez WHERE, kriva baza. */
export function GuardDialog({
  issues,
  onRun,
  onClose
}: {
  issues: GuardIssues
  /** skipWrongDb: korisnik ne želi više pitanje o krivoj bazi u ovom tabu. */
  onRun(opts: { skipWrongDb: boolean }): void
  onClose(): void
}) {
  const [understood, setUnderstood] = useState(false)
  const [skipWrongDb, setSkipWrongDb] = useState(false)
  const needsTick = issues.unbounded.length > 0
  const danger = !!issues.prod || needsTick

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className={'modal guard-modal' + (danger ? ' danger' : '')}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!needsTick || understood) onRun({ skipWrongDb })
        }}
      >
        <h2>{t('guard.title')}</h2>
        {issues.prod && (
          <div className="guard-section prod">
            <div className="guard-title">
              <span className="prod-badge">PROD</span> {issues.prod.target}
            </div>
            <div>{t('guard.prodWrites', issues.prod.types.map(typeLabel).join(', '))}</div>
          </div>
        )}
        {needsTick && (
          <div className="guard-section unbounded">
            {issues.unbounded.map((u, i) => (
              <div key={i} className="guard-item">
                <b>{kindText(u.kind)}</b>
                {u.table ? ' ' + t('guard.inTable', u.table) : ''}
                <code>{u.snippet.length > 120 ? u.snippet.slice(0, 120) + '…' : u.snippet}</code>
              </div>
            ))}
            <label className="guard-check">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> {t('guard.understand')}
            </label>
          </div>
        )}
        {issues.wrongDb && (
          <div className="guard-section">
            <div>
              {rich(t('guard.wrongDb'), <b>{issues.wrongDb.saved}</b>, <b>{issues.wrongDb.current}</b>)}
            </div>
            <label className="guard-check">
              <input type="checkbox" checked={skipWrongDb} onChange={(e) => setSkipWrongDb(e.target.checked)} /> {t('guard.dontAskTab')}
            </label>
          </div>
        )}
        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" autoFocus onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className={'btn ' + (danger ? 'danger-solid' : 'primary')} disabled={needsTick && !understood}>
            {t('guard.run')}
          </button>
        </div>
      </form>
    </div>
  )
}
