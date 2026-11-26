import { useEffect, useState } from 'react'
import { api } from '../api'
import { paramLiteral, resolvedType } from '../../../core/params'
import type { DbType, ParamType, ParamValue } from '../../../shared/types'
import { t } from '../i18n'

const typeLabels = (): Record<ParamType, string> => ({
  auto: 'auto',
  text: t('params.text'),
  number: t('params.number'),
  null: 'NULL',
  raw: t('params.raw')
})

/**
 * Forma za varijable (:x, ${x}) prije izvršavanja. Početne vrijednosti: iz izvršavanja iz povijesti (preset),
 * inače zadnje upisane u projektu.
 */
export function ParamsDialog({
  names,
  dialect,
  projectId,
  preset,
  onRun,
  onClose
}: {
  names: string[]
  dialect: DbType
  projectId: number | null
  preset?: Record<string, ParamValue>
  onRun(values: Record<string, ParamValue>): void
  onClose(): void
}) {
  const [values, setValues] = useState<Record<string, ParamValue> | null>(null)

  useEffect(() => {
    let cancelled = false
    api.params
      .get(projectId, names)
      .catch(() => ({}) as Record<string, ParamValue>)
      .then((remembered) => {
        if (cancelled) return
        const init: Record<string, ParamValue> = {}
        for (const n of names) init[n] = preset?.[n] ?? remembered[n] ?? { value: '', type: 'auto' }
        setValues(init)
      })
    return () => {
      cancelled = true
    }
  }, [names, projectId, preset])

  if (!values) return null

  const TYPE_LABELS = typeLabels()
  const set = (name: string, patch: Partial<ParamValue>) => setValues((v) => ({ ...v!, [name]: { ...v![name], ...patch } }))
  const literal = (name: string): { text: string; error: boolean } => {
    try {
      return { text: paramLiteral(name, values[name], dialect), error: false }
    } catch (e) {
      return { text: (e as Error).message, error: true }
    }
  }
  const invalid = names.some((n) => literal(n).error)

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal params-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!invalid) onRun(values)
        }}
      >
        <h2>{t('params.title')}</h2>
        <div className="params-grid">
          {names.map((n, i) => {
            const lit = literal(n)
            const type = values[n].type
            return (
              <div key={n} className="params-row">
                <label htmlFor={'param-' + n}>:{n}</label>
                <input
                  id={'param-' + n}
                  autoFocus={i === 0}
                  value={values[n].value}
                  disabled={type === 'null'}
                  placeholder={type === 'raw' ? t('params.rawPlaceholder') : ''}
                  onChange={(e) => set(n, { value: e.target.value })}
                  onFocus={(e) => e.target.select()}
                />
                <select value={type} onChange={(e) => set(n, { type: e.target.value as ParamType })} title={t('params.typeTitle')}>
                  {(Object.keys(TYPE_LABELS) as ParamType[]).map((pt) => (
                    <option key={pt} value={pt}>
                      {pt === 'auto' && type === 'auto' ? `auto (${TYPE_LABELS[resolvedType(values[n])]})` : TYPE_LABELS[pt]}
                    </option>
                  ))}
                </select>
                <code className={'params-literal' + (lit.error ? ' error' : '')} title={t('params.literalTitle')}>
                  {lit.text}
                </code>
              </div>
            )
          })}
        </div>
        <div className="modal-actions">
          <span className="muted small">{projectId !== null ? t('params.rememberProject') : t('params.rememberNoProject')}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={invalid}>
            {t('guard.run')}
          </button>
        </div>
      </form>
    </div>
  )
}
