import { useState } from 'react'
import { AlertTriangle, Info } from '@vectilume/react'
import { DEFAULT_SETTINGS, MAX_ROWS_OPTIONS, getSettings, saveSettings, type Settings } from '../settings'
import { api } from '../api'
import { LANGUAGES, getLang, num, t, type MsgKey } from '../i18n'

type Note = { text: string; level: 'info' | 'warn' } | null

interface Row<K extends keyof Settings = keyof Settings> {
  key: K
  label: string
  description: string
  /** Napomena za odabranu vrijednost; 'warn' = rizičniji izbor. */
  note?(value: Settings[K]): Note
  /** Bez opcija: prekidač (boolean). */
  options?: [Settings[K], string][]
}

const row = <K extends keyof Settings>(r: Row<K>) => r as unknown as Row

const warn = (key: MsgKey): Note => ({ level: 'warn', text: t(key as 'settings.intro') })
const info = (key: MsgKey): Note => ({ level: 'info', text: t(key as 'settings.intro') })

/** Sekcije se grade pri otvaranju dijaloga (tekstovi u trenutnom jeziku). */
function sections(): { title: string; rows: Row[] }[] {
  return [
    {
      title: t('settings.sec.safety'),
      rows: [
        row({
          key: 'guardProd',
          label: t('settings.guardProd.label'),
          description: t('settings.guardProd.desc'),
          note: (v) => (v ? null : warn('settings.guardProd.off'))
        }),
        row({
          key: 'guardUnbounded',
          label: t('settings.guardUnbounded.label'),
          description: t('settings.guardUnbounded.desc'),
          note: (v) => (v ? null : warn('settings.guardUnbounded.off'))
        }),
        row({
          key: 'guardWrongDb',
          label: t('settings.guardWrongDb.label'),
          description: t('settings.guardWrongDb.desc'),
          note: (v) => (v ? null : warn('settings.guardWrongDb.off'))
        })
      ]
    },
    {
      title: t('settings.sec.tx'),
      rows: [
        row({
          key: 'autoCommitDefault',
          label: t('settings.autoCommitDefault.label'),
          description: t('settings.autoCommitDefault.desc'),
          note: (v) => (v ? null : warn('settings.autoCommitDefault.off'))
        }),
        row({
          key: 'autoCommitProd',
          label: t('settings.autoCommitProd.label'),
          description: t('settings.autoCommitProd.desc'),
          note: (v) => (v ? warn('settings.autoCommitProd.on') : info('settings.autoCommitProd.off'))
        }),
        row({
          key: 'txWarnMinutes',
          label: t('settings.txWarnMinutes.label'),
          description: t('settings.txWarnMinutes.desc'),
          options: [1, 5, 15, 30, 60].map((n) => [n, `${n} min`]),
          note: (v) => (v >= 30 ? warn('settings.txWarnMinutes.long') : null)
        })
      ]
    },
    {
      title: t('settings.sec.editor'),
      rows: [
        row({
          key: 'ctrlEnterScope',
          label: t('settings.ctrlEnterScope.label'),
          description: t('settings.ctrlEnterScope.desc'),
          options: [
            ['statement', t('settings.ctrlEnterScope.statement')],
            ['all', t('settings.ctrlEnterScope.all')]
          ],
          note: (v) => (v === 'all' ? warn('settings.ctrlEnterScope.allNote') : null)
        }),
        row({
          key: 'blankLineSplits',
          label: t('settings.blankLineSplits.label'),
          description: t('settings.blankLineSplits.desc'),
          note: (v) => (v ? null : warn('settings.blankLineSplits.off'))
        }),
        row({
          key: 'restoreTabs',
          label: t('settings.restoreTabs.label'),
          description: t('settings.restoreTabs.desc'),
          note: (v) => (v ? info('settings.restoreTabs.on') : info('settings.restoreTabs.off'))
        }),
        row({
          key: 'defaultMaxRows',
          label: t('settings.defaultMaxRows.label'),
          description: t('settings.defaultMaxRows.desc'),
          options: MAX_ROWS_OPTIONS.map((n) => [n, num(n)]),
          note: (v) => (v >= 100000 ? info('settings.defaultMaxRows.many') : null)
        })
      ]
    },
    {
      title: t('settings.sec.help'),
      rows: [
        row({
          key: 'suggestSave',
          label: t('settings.suggestSave.label'),
          description: t('settings.suggestSave.desc')
        }),
        row({
          key: 'runWarnings',
          label: t('settings.runWarnings.label'),
          description: t('settings.runWarnings.desc'),
          note: (v) => (v ? null : info('settings.runWarnings.off'))
        })
      ]
    }
  ]
}

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const [draft, setDraft] = useState<Settings>(getSettings)
  const [secs] = useState(sections)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const changed = JSON.stringify(draft) !== JSON.stringify(getSettings())
  // Jezik nije ponašanje s rizikom: Vrati zadano ga ne mijenja.
  const defaults = { ...DEFAULT_SETTINGS, language: draft.language }
  const isDefault = JSON.stringify(draft) === JSON.stringify(defaults)
  const langChanged = draft.language !== getLang()

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal settings-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={(e) => {
          e.preventDefault()
          saveSettings(draft)
          onClose()
          if (langChanged) void api.app.relaunch()
        }}
      >
        <h2>{t('settings.title')}</h2>
        <p className="muted small settings-intro">{t('settings.intro')}</p>
        <div className="settings-body">
          <section>
            <h3>{t('settings.sec.language')}</h3>
            <div className="setting-row">
              <div className="setting-head">
                <span className="setting-label">{t('settings.language.label')}</span>
                <select value={draft.language} onChange={(e) => set('language', e.target.value as Settings['language'])}>
                  {LANGUAGES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              {langChanged && (
                <div className="setting-note info">
                  <Info size={14} />
                  <span>{t('settings.language.restart')}</span>
                </div>
              )}
            </div>
          </section>
          {secs.map((sec) => (
            <section key={sec.title}>
              <h3>{sec.title}</h3>
              {sec.rows.map((r) => {
                const value = draft[r.key]
                const note = r.note?.(value as never)
                return (
                  <div key={r.key} className="setting-row">
                    <div className="setting-head">
                      {r.options ? (
                        <>
                          <span className="setting-label">{r.label}</span>
                          <select
                            value={String(value)}
                            onChange={(e) => {
                              const opt = r.options!.find(([v]) => String(v) === e.target.value)
                              if (opt) set(r.key, opt[0])
                            }}
                          >
                            {r.options.map(([v, label]) => (
                              <option key={String(v)} value={String(v)}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <label className="setting-label toggle">
                          <input type="checkbox" checked={value as boolean} onChange={(e) => set(r.key, e.target.checked as never)} />
                          {r.label}
                        </label>
                      )}
                      {value !== DEFAULT_SETTINGS[r.key] && <span className="setting-changed">{t('settings.changed')}</span>}
                    </div>
                    <div className="muted small">{r.description}</div>
                    {note && (
                      <div className={'setting-note ' + note.level}>
                        {note.level === 'warn' ? <AlertTriangle size={14} /> : <Info size={14} />}
                        <span>{note.text}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" disabled={isDefault} onClick={() => setDraft(defaults)}>
            {t('settings.reset')}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!changed}>
            {langChanged ? t('settings.saveRestart') : t('common.save')}
          </button>
        </div>
      </form>
    </div>
  )
}
