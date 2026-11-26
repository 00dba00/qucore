import { useState } from 'react'
import { rich, t } from '../i18n'

/**
 * Zatvaranje taba ili aplikacije dok je transakcija otvorena: Commit, Rollback ili odustani.
 * Bez odgovora se ništa ne zatvara (zatvaranje sesije bi transakciju tiho poništilo).
 */
export function TxCloseDialog({
  tabs,
  quitting,
  onResolve,
  onClose
}: {
  /** Nazivi tabova s otvorenom transakcijom. */
  tabs: string[]
  /** Zatvara se cijela aplikacija (inače jedan tab). */
  quitting: boolean
  /** Vraća false ako nije uspjelo (dijalog ostaje otvoren). */
  onResolve(action: 'commit' | 'rollback'): Promise<boolean>
  onClose(): void
}) {
  const [busy, setBusy] = useState(false)
  const run = async (action: 'commit' | 'rollback') => {
    setBusy(true)
    // Uspjeh zatvara dijalog izvana; neuspjeh (greška je već prikazana) ostavlja izbor.
    await onResolve(action)
    setBusy(false)
  }
  const many = tabs.length > 1

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="modal guard-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <h2>{t('txClose.title')}</h2>
        <p>
          {rich(t(many ? 'txClose.textMany' : 'txClose.textOne'), <b>{tabs.join(', ')}</b>)} {quitting ? t('txClose.beforeQuit') : t('txClose.beforeClose')}
        </p>
        <ul className="muted small">
          <li>
            <b>Commit</b> — {t('txClose.commitNote')}
          </li>
          <li>
            <b>Rollback</b> — {t('txClose.rollbackNote')}
          </li>
        </ul>
        <div className="modal-actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void run('commit')}>
            {quitting ? t('txClose.commitQuit') : t('txClose.commitClose')}
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void run('rollback')}>
            {quitting ? t('txClose.rollbackQuit') : t('txClose.rollbackClose')}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" autoFocus disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Zatvaranje taba .sql datoteke s nespremljenim izmjenama: Spremi / Ne spremaj / Odustani. */
export function UnsavedFileDialog({
  name,
  onResolve,
  onClose
}: {
  name: string
  /** save = true: spremi u datoteku pa zatvori (ako spremanje ne uspije, tab ostaje). */
  onResolve(save: boolean): Promise<void>
  onClose(): void
}) {
  const [busy, setBusy] = useState(false)
  const run = async (save: boolean) => {
    setBusy(true)
    await onResolve(save)
    setBusy(false)
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="modal guard-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <h2>{t('unsavedFile.title')}</h2>
        <p>
          {rich(t('unsavedFile.text'), <b>{name}</b>)}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn primary" autoFocus disabled={busy} onClick={() => void run(true)}>
            {t('common.save')}
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void run(false)}>
            {t('unsavedFile.dontSave')}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
