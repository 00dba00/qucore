import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Project, Snippet } from '../../../shared/types'
import { t } from '../i18n'

/** Snippeti: popis lijevo, uređivanje desno. initialBody otvara novi snippet s označenim tekstom. */
export function SnippetsDialog({
  projects,
  activeProjectId,
  initialBody,
  onClose,
  onChanged,
  notify
}: {
  projects: Project[]
  activeProjectId: number | null
  initialBody?: string
  onClose(): void
  onChanged(): void
  notify(text: string, kind?: 'error' | 'info'): void
}) {
  const [list, setList] = useState<Snippet[]>([])
  const [selected, setSelected] = useState<number | 'new'>('new')
  const [name, setName] = useState('')
  const [body, setBody] = useState(initialBody ?? '')
  const [projectId, setProjectId] = useState<number | null>(activeProjectId)
  const [busy, setBusy] = useState(false)

  const reload = async (select?: number | 'new') => {
    const l = await api.snippets.list(activeProjectId)
    setList(l)
    if (select !== undefined) setSelected(select)
  }

  useEffect(() => {
    reload(initialBody !== undefined ? 'new' : undefined).catch((e) => notify((e as Error).message, 'error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = (id: number | 'new') => {
    setSelected(id)
    const s = id === 'new' ? undefined : list.find((x) => x.id === id)
    setName(s?.name ?? '')
    setBody(s?.body ?? '')
    setProjectId(s ? s.projectId : activeProjectId)
  }

  const save = async () => {
    setBusy(true)
    try {
      const s = await api.snippets.save({ id: selected === 'new' ? undefined : selected, projectId, name, body })
      await reload(s.id)
      onChanged()
      notify(t('common.savedName', s.name))
    } catch (e) {
      notify((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (selected === 'new' || !confirm(t('snippets.confirmDelete', name))) return
    await api.snippets.remove(selected)
    await reload('new')
    pick('new')
    onChanged()
  }

  const projectName = (id: number | null) => (id === null ? t('snippets.allProjectsLower') : (projects.find((p) => p.id === id)?.name ?? '?'))

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal projects-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{t('snippets.title')}</h2>
        <div className="projects-layout">
          <div className="projects-list">
            {list.map((s) => (
              <button key={s.id} className={'projects-item' + (s.id === selected ? ' active' : '')} onClick={() => pick(s.id)}>
                <span className="projects-item-name">{s.name}</span>
                <span className="muted small">{s.projectId === null ? t('snippets.all') : projectName(s.projectId)}</span>
              </button>
            ))}
            <button className={'projects-item new' + (selected === 'new' ? ' active' : '')} onClick={() => pick('new')}>
              + {t('snippets.new')}
            </button>
          </div>
          <form
            className="project-form"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <div className="form-grid">
              <label>{t('common.name')}</label>
              <input autoFocus value={name} placeholder={t('snippets.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
              <label>{t('snippets.appliesTo')}</label>
              <select value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{t('common.allProjects')}</option>
                {projects
                  .filter((p) => !p.archived || p.id === projectId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <label className="top">SQL</label>
              <textarea className="snippet-body" rows={10} value={body} spellCheck={false} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div className="modal-actions">
              {selected !== 'new' && (
                <button type="button" className="btn danger" onClick={() => void remove()}>
                  {t('common.delete')}
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button type="button" className="btn" onClick={onClose}>
                {t('common.close')}
              </button>
              <button type="submit" className="btn primary" disabled={busy || !name.trim() || !body.trim()}>
                {selected === 'new' ? t('snippets.add') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
