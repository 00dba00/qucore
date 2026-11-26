import { useState } from 'react'
import { Briefcase, Close, HelpCircle, Plus, Settings, Sliders } from '@vectilume/react'
import { api } from '../api'
import { ENVIRONMENTS, type AliasTarget, type ConnectionInfo, type DbRef, type Environment, type Project } from '../../../shared/types'
import { t } from '../i18n'

export const PROJECT_COLORS = ['', '#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#a855f7']

/** Konekcija → baze aktivnog projekta; undefined = bez filtra. */
export type ProjectScope = Map<string, Set<string>>

export function projectScope(p: Project | undefined): ProjectScope | undefined {
  if (!p) return undefined
  const m: ProjectScope = new Map()
  for (const d of p.databases) m.set(d.connectionId, (m.get(d.connectionId) ?? new Set()).add(d.database))
  return m
}

export const sameRef = (a: DbRef, b: DbRef) => a.connectionId === b.connectionId && a.database === b.database

/** Izbor aktivnog projekta na vrhu sidebara. */
export function ProjectPicker({
  projects,
  activeId,
  onChange,
  onManage,
  onDefaultEnv,
  onGuide,
  onSettings
}: {
  projects: Project[]
  activeId: number | null
  onChange(id: number | null): void
  onManage(): void
  onDefaultEnv(env: Environment): void
  onGuide(): void
  onSettings(): void
}) {
  const active = projects.find((p) => p.id === activeId)
  const visible = projects.filter((p) => !p.archived || p.id === activeId)
  return (
    <div className="project-picker" style={active?.color ? { ['--project' as string]: active.color } : undefined}>
      <Briefcase size={14} className={active ? 'project-icon active' : 'project-icon'} />
      <select
        value={activeId ?? ''}
        title={t('projects.pickerTitle')}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">{t('common.allProjects')}</option>
        {visible.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.archived ? ` (${t('projects.archived')})` : ''}
          </option>
        ))}
      </select>
      {active && active.aliases.length > 0 && (
        <select
          className={'env-select env-' + active.defaultEnv}
          value={active.defaultEnv}
          title={t('projects.envTitle')}
          onChange={(e) => onDefaultEnv(e.target.value as Environment)}
        >
          {ENVIRONMENTS.map((e) => (
            <option key={e} value={e}>
              {e.toUpperCase()}
            </option>
          ))}
        </select>
      )}
      <button className="icon-btn" title={t('explorer.projects')} onClick={onManage}>
        <Settings size={15} />
      </button>
      <button className="icon-btn" title={t('projects.settingsTitle')} onClick={onSettings}>
        <Sliders size={15} />
      </button>
      <button className="icon-btn" title={t('projects.guideTitle')} onClick={onGuide}>
        <HelpCircle size={15} />
      </button>
    </div>
  )
}

/** Popis projekata s uređivanjem odabranog. */
export function ProjectsDialog({
  projects,
  connections,
  initialId,
  onClose,
  onChanged,
  notify
}: {
  projects: Project[]
  connections: ConnectionInfo[]
  initialId?: number | null
  onClose(): void
  onChanged(selectId?: number): Promise<void> | void
  notify(text: string, kind?: 'error' | 'info'): void
}) {
  const [selected, setSelected] = useState<number | 'new'>(initialId ?? projects[0]?.id ?? 'new')
  const current = selected === 'new' ? undefined : projects.find((p) => p.id === selected)

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal projects-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{t('projects.title')}</h2>
        <div className="projects-layout">
          <div className="projects-list">
            {projects.map((p) => (
              <button
                key={p.id}
                className={'projects-item' + (p.id === selected ? ' active' : '') + (p.archived ? ' archived' : '')}
                onClick={() => setSelected(p.id)}
              >
                <span className="color-dot static" style={{ background: p.color || 'var(--bg-3)' }} />
                <span className="projects-item-name">{p.name}</span>
                <span className="muted small">{p.queryCount}</span>
              </button>
            ))}
            <button className={'projects-item new' + (selected === 'new' ? ' active' : '')} onClick={() => setSelected('new')}>
              + {t('projects.new')}
            </button>
          </div>
          <ProjectForm
            key={selected}
            project={current}
            connections={connections}
            notify={notify}
            onSaved={async (id) => {
              await onChanged(id)
              setSelected(id)
            }}
            onRemoved={async () => {
              await onChanged()
              setSelected('new')
            }}
          />
        </div>
        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

function ProjectForm({
  project,
  connections,
  notify,
  onSaved,
  onRemoved
}: {
  project?: Project
  connections: ConnectionInfo[]
  notify(text: string, kind?: 'error' | 'info'): void
  onSaved(id: number): Promise<void>
  onRemoved(): Promise<void>
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [color, setColor] = useState(project?.color ?? '')
  const [archived, setArchived] = useState(project?.archived ?? false)
  const [databases, setDatabases] = useState<DbRef[]>(project?.databases ?? [])
  const [aliases, setAliases] = useState<{ id?: number; name: string; targets: AliasTarget[] }[]>(project?.aliases ?? [])
  const [busy, setBusy] = useState(false)
  const names = new Map(connections.map((c) => [c.id, c]))

  const save = async () => {
    setBusy(true)
    try {
      // Cilj aliasa mora biti baza projekta; makni ciljeve baza koje su izbačene iz projekta.
      const cleaned = aliases.map((a) => ({ ...a, targets: a.targets.filter((t) => databases.some((d) => sameRef(d, t))) }))
      const p = await api.projects.save({ id: project?.id, name, description, color: color || undefined, archived, databases, aliases: cleaned })
      notify(t('common.savedName', p.name))
      await onSaved(p.id)
    } catch (e) {
      notify((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!project) return
    const extra = project.queryCount ? ' ' + t('projects.deleteKeepsQueries', project.queryCount) : ''
    if (!confirm(t('projects.confirmDelete', project.name) + extra)) return
    try {
      await api.projects.remove(project.id)
      await onRemoved()
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  }

  return (
    <form
      className="project-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="form-grid">
        <label>{t('common.name')}</label>
        <input autoFocus value={name} placeholder={t('projects.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
        <label>{t('projects.description')}</label>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <label>{t('conn.color')}</label>
        <div className="colors">
          {PROJECT_COLORS.map((c) => (
            <button
              type="button"
              key={c || 'none'}
              className={'color-dot' + (color === c ? ' active' : '') + (c ? '' : ' none')}
              style={{ background: c || undefined }}
              title={c || t('conn.noColor')}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <label />
        <label className="inline-check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {t('projects.archivedLabel')}
        </label>
        <label className="top">{t('projects.databases')}</label>
        <div className="project-dbs">
          {databases.map((d) => {
            const c = names.get(d.connectionId)
            return (
              <div key={d.connectionId + '\u0000' + d.database} className="project-db">
                <span className="color-dot static" style={{ background: c?.color || 'var(--bg-3)' }} />
                <span className="project-db-name">
                  {c?.name ?? t('projects.deletedConnection')} / <b>{d.database}</b>
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  title={t('projects.removeDb')}
                  onClick={() => setDatabases((l) => l.filter((x) => !sameRef(x, d)))}
                >
                  <Close size={14} />
                </button>
              </div>
            )
          })}
          <p className="muted small">
            {databases.length ? '' : t('projects.noDbs') + ' '}{t('projects.addDbHint')}
          </p>
        </div>
        <label className="top">{t('projects.aliases')}</label>
        <div className="project-aliases">
          {aliases.length > 0 && (
            <div className="alias-row alias-head">
              <span>{t('projects.aliasName')}</span>
              {ENVIRONMENTS.map((e) => (
                <span key={e} className={'env-' + e}>
                  {e.toUpperCase()}
                </span>
              ))}
              <span />
            </div>
          )}
          {aliases.map((a, i) => (
            <div key={a.id ?? 'new' + i} className="alias-row">
              <input
                value={a.name}
                placeholder={t('projects.aliasPlaceholder')}
                onChange={(e) => setAliases((l) => l.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))}
              />
              {ENVIRONMENTS.map((env) => {
                const tg = a.targets.find((x) => x.env === env)
                return (
                  <select
                    key={env}
                    value={tg ? `${tg.connectionId}\n${tg.database}` : ''}
                    onChange={(e) => {
                      const [connectionId, database] = e.target.value.split('\n')
                      setAliases((l) =>
                        l.map((x, k) =>
                          k !== i
                            ? x
                            : {
                                ...x,
                                targets: [
                                  ...x.targets.filter((y) => y.env !== env),
                                  ...(e.target.value ? [{ env, connectionId, database }] : [])
                                ]
                              }
                        )
                      )
                    }}
                  >
                    <option value="">—</option>
                    {databases.map((d) => (
                      <option key={d.connectionId + d.database} value={`${d.connectionId}\n${d.database}`}>
                        {d.database} — {names.get(d.connectionId)?.name ?? '?'}
                      </option>
                    ))}
                  </select>
                )
              })}
              <button type="button" className="icon-btn" title={t('projects.deleteAlias')} onClick={() => setAliases((l) => l.filter((_, k) => k !== i))}>
                <Close size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="link-btn add-alias"
            disabled={databases.length === 0}
            title={databases.length ? undefined : t('projects.addDbsFirst')}
            onClick={() => setAliases((l) => [...l, { name: '', targets: [] }])}
          >
            <Plus size={12} /> {t('projects.addAlias')}
          </button>
          <p className="muted small">{t('projects.aliasHelp')}</p>
        </div>
      </div>
      <div className="modal-actions">
        {project && (
          <button type="button" className="btn danger" onClick={remove} disabled={busy}>
            {t('projects.delete')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
          {project ? t('common.save') : t('projects.add')}
        </button>
      </div>
    </form>
  )
}

/** Desni klik na bazu → Projekti…: kojim projektima baza pripada. */
export function DatabaseProjectsDialog({
  target,
  connectionName,
  projects,
  onClose,
  onChanged,
  notify
}: {
  target: DbRef
  connectionName: string
  projects: Project[]
  onClose(): void
  onChanged(): Promise<void> | void
  notify(text: string, kind?: 'error' | 'info'): void
}) {
  const [checked, setChecked] = useState(
    () => new Set(projects.filter((p) => p.databases.some((d) => sameRef(d, target))).map((p) => p.id))
  )
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const toggle = (id: number) =>
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const save = async () => {
    setBusy(true)
    try {
      const ids = [...checked]
      if (newName.trim()) ids.push((await api.projects.save({ name: newName })).id)
      await api.projects.setDatabaseProjects(target, ids)
      await onChanged()
      onClose()
    } catch (e) {
      notify((e as Error).message, 'error')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal small-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2>{t('projects.dbTitle')}</h2>
        <p className="muted">
          {connectionName} / <b>{target.database}</b>
        </p>
        <div className="check-list">
          {projects.map((p) => (
            <label key={p.id} className={p.archived ? 'archived' : ''}>
              <input type="checkbox" checked={checked.has(p.id)} onChange={() => toggle(p.id)} />
              <span className="color-dot static" style={{ background: p.color || 'var(--bg-3)' }} />
              {p.name}
              {p.archived ? <span className="muted small"> ({t('projects.archived')})</span> : null}
            </label>
          ))}
          <label>
            <input type="checkbox" checked={!!newName.trim()} readOnly tabIndex={-1} />
            <input
              autoFocus={projects.length === 0}
              className="check-list-new"
              value={newName}
              placeholder={t('projects.newPlaceholder')}
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
        </div>
        <div className="modal-actions">
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
