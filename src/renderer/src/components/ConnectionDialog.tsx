import { useEffect, useState } from 'react'
import { AlertTriangle } from '@vectilume/react'
import { api } from '../api'
import {
  DB_TYPE_LABELS,
  DEFAULT_PORTS,
  ENVIRONMENTS,
  MSSQL_AUTHS,
  mssqlAuthLabel,
  type ConnectionConfig,
  type ConnectionInfo,
  type DbType,
  type Environment,
  type MssqlAuth
} from '../../../shared/types'
import { t } from '../i18n'

const COLORS = ['', '#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#a855f7']

interface Props {
  initial?: ConnectionInfo
  onClose(): void
  onSaved(c: ConnectionInfo): void
}

export function ConnectionDialog({ initial, onClose, onSaved }: Props) {
  const [form, setForm] = useState<ConnectionConfig>(() =>
    initial
      ? { ...initial, password: undefined }
      : { id: '', name: '', type: 'mssql', host: 'localhost', port: DEFAULT_PORTS.mssql, user: '', encrypt: true, trustServerCertificate: true }
  )
  const [password, setPassword] = useState('')
  const [passwordTouched, setPasswordTouched] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // Linux bez keyringa: lozinka se sprema praktički kao običan tekst — korisnik mora to znati prije spremanja.
  const [plainText, setPlainText] = useState(false)
  useEffect(() => {
    api.connections.passwordStorage().then((s) => setPlainText(s === 'plaintext'), () => {})
  }, [])

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => setForm((f) => ({ ...f, [k]: v }))

  const setType = (t: DbType) =>
    setForm((f) => ({ ...f, type: t, port: f.port === DEFAULT_PORTS[f.type] ? DEFAULT_PORTS[t] : f.port }))

  // Način prijave postoji samo za SQL Server; ostali tipovi uvijek koriste korisnika i lozinku.
  const auth: MssqlAuth = form.type === 'mssql' ? (form.mssqlAuth ?? 'sql') : 'sql'

  const payload = (): ConnectionConfig => {
    const windows = auth === 'windows'
    return {
      ...form,
      mssqlAuth: form.type === 'mssql' ? auth : undefined,
      domain: auth === 'ntlm' ? form.domain?.trim() || undefined : undefined,
      user: windows ? '' : form.user,
      name: form.name.trim() || (windows ? `Windows@${form.host.trim()}` : `${form.user}@${form.host.trim()}`),
      host: form.host.trim(),
      database: form.database?.trim() || undefined,
      // '' = obriši spremljenu lozinku (Windows prijava je ne treba), undefined = zadrži spremljenu
      password: windows ? '' : passwordTouched || !initial ? password : undefined
    }
  }

  const test = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const r = await api.connections.test(payload())
      setStatus({ ok: r.ok, text: r.ok ? `${r.message}\n${r.version ?? ''}` : r.message })
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!form.host.trim()) return setStatus({ ok: false, text: t('conn.hostRequired') })
    setBusy(true)
    try {
      onSaved(await api.connections.save(payload()))
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message })
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>{initial ? t('conn.edit') : t('conn.new')}</h2>

        <div className="type-picker">
          {(Object.keys(DB_TYPE_LABELS) as DbType[]).map((dt) => (
            <button type="button" key={dt} className={form.type === dt ? 'active' : ''} onClick={() => setType(dt)}>
              {DB_TYPE_LABELS[dt]}
            </button>
          ))}
        </div>

        <div className="form-grid">
          <label>{t('common.name')}</label>
          <input autoFocus value={form.name} placeholder={t('conn.namePlaceholder')} onChange={(e) => set('name', e.target.value)} />

          <label>Host</label>
          <div className="row">
            <input value={form.host} onChange={(e) => set('host', e.target.value)} style={{ flex: 1 }} />
            <span className="muted">{t('conn.port')}</span>
            <input
              type="number"
              value={form.port}
              onChange={(e) => set('port', Number(e.target.value))}
              style={{ width: 80 }}
            />
          </div>

          {form.type === 'mssql' && (
            <>
              <label>{t('conn.auth')}</label>
              <select value={auth} onChange={(e) => set('mssqlAuth', e.target.value as MssqlAuth)}>
                {MSSQL_AUTHS.map((a) => (
                  <option key={a} value={a}>
                    {mssqlAuthLabel(a)}
                  </option>
                ))}
              </select>
            </>
          )}

          {auth === 'windows' ? (
            <>
              <label />
              <span className="muted small">
                {t('conn.windowsNote')}
              </span>
            </>
          ) : (
            <>
              {auth === 'ntlm' && (
                <>
                  <label>{t('conn.domain')}</label>
                  <input
                    value={form.domain ?? ''}
                    placeholder={t('conn.domainPlaceholder')}
                    onChange={(e) => set('domain', e.target.value)}
                  />
                </>
              )}

              <label>{t('conn.user')}</label>
              <input value={form.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" />

              <label>{t('conn.password')}</label>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                placeholder={initial?.hasPassword && !passwordTouched ? t('conn.passwordSaved') : ''}
                onChange={(e) => {
                  setPassword(e.target.value)
                  setPasswordTouched(true)
                }}
              />
              {plainText && (
                <>
                  <label />
                  <div className="setting-note warn conn-password-warn">
                    <AlertTriangle size={14} />
                    <span>{t('conn.plainTextWarning')}</span>
                  </div>
                </>
              )}
            </>
          )}

          <label>{t('conn.database')}</label>
          <input
            value={form.database ?? ''}
            placeholder={form.type === 'postgres' ? 'postgres' : t('conn.optional')}
            onChange={(e) => set('database', e.target.value)}
          />

          {form.type === 'mssql' ? (
            <>
              <label>{t('conn.security')}</label>
              <div className="checks">
                <label>
                  <input type="checkbox" checked={form.encrypt ?? true} onChange={(e) => set('encrypt', e.target.checked)} /> {t('conn.encrypt')}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.trustServerCertificate ?? true}
                    onChange={(e) => set('trustServerCertificate', e.target.checked)}
                  />{' '}
                  {t('conn.trustCert')}
                </label>
              </div>
            </>
          ) : (
            <>
              <label>{t('conn.security')}</label>
              <div className="checks">
                <label>
                  <input type="checkbox" checked={!!form.ssl} onChange={(e) => set('ssl', e.target.checked)} /> SSL
                </label>
              </div>
            </>
          )}

          <label>{t('conn.environment')}</label>
          <div className="env-picker">
            {(['', ...ENVIRONMENTS] as const).map((e) => (
              <button
                type="button"
                key={e || 'none'}
                className={'env-option' + ((form.environment ?? '') === e ? ' active' : '') + (e ? ' env-' + e : '')}
                onClick={() => set('environment', (e || undefined) as Environment | undefined)}
              >
                {e || t('conn.noEnv')}
              </button>
            ))}
          </div>

          <label>{t('conn.color')}</label>
          <div className="colors">
            {COLORS.map((c) => (
              <button
                type="button"
                key={c || 'none'}
                className={'color-dot' + ((form.color ?? '') === c ? ' active' : '') + (c ? '' : ' none')}
                style={{ background: c || undefined }}
                title={c ? c : t('conn.noColor')}
                onClick={() => set('color', c || undefined)}
              />
            ))}
            <span className="muted small">{t('conn.colorHint')}</span>
          </div>
        </div>

        {status && <pre className={'status-box ' + (status.ok ? 'ok' : 'err')}>{status.text}</pre>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={test} disabled={busy}>
            {busy ? <span className="spinner small" /> : null} {t('conn.test')}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  )
}
