import { useState } from 'react'
import type { ConnectionInfo } from '../../../shared/types'
import { t } from '../i18n'

interface Props {
  connection?: ConnectionInfo
  /** Produkcijska konekcija: dodatno upozorenje. */
  prod?: boolean
  table: string
  statements: string[]
  onApply(): Promise<void>
  onClose(): void
}

/** Pregled naredbi prije spremanja izmjena; izvršava se tek na izričitu potvrdu. */
export function EditPreview({ connection, table, statements, onApply, onClose, prod }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = async () => {
    setBusy(true)
    setError(null)
    try {
      await onApply()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="modal edit-preview" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t('editPreview.title', table)}</h2>
        {prod && (
          <p className="guard-section prod">
            <span className="prod-badge">PROD</span> {t('editPreview.prod')}
          </p>
        )}
        <p className="edit-target">
          <span className="edit-conn" style={connection?.color ? { ['--accent' as string]: connection.color } : undefined}>
            {connection?.name ?? '?'}
          </span>
          {' — '}
          {t('editPreview.summary', statements.length)}
        </p>
        <pre className="edit-sql">{statements.map((s) => s + ';').join('\n')}</pre>
        {error && <pre className="status-box err">{error}</pre>}
        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={() => void apply()} disabled={busy} autoFocus>
            {busy ? <span className="spinner small" /> : null} {t('editPreview.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
