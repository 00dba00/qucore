import { memo, useCallback, useEffect, useState } from 'react'
import { Icon, type IconName } from './Icons'
import { useContextMenu, type MenuEntry } from './ContextMenu'
import { t } from '../i18n'

export interface TreeNodeData {
  key: string
  label: string
  icon: IconName
  /** Sivi tekst desno od naziva (tip kolone, broj objekata…). */
  detail?: string
  iconClass?: string
  /** Lijeno učitavanje djece; ako nema, čvor je list. */
  load?: () => Promise<TreeNodeData[]>
  /** Filter iz explorera primjenjuje se na djecu ovog čvora. */
  filterChildren?: boolean
  defaultExpanded?: boolean
  onOpen?: () => void
  menu?: (ctx: { refresh: () => void }) => MenuEntry[]
  title?: string
  accent?: string
}

interface Props {
  node: TreeNodeData
  depth: number
  filter: string
}

export const TreeItem = memo(function TreeItem({ node, depth, filter }: Props) {
  const [expanded, setExpanded] = useState(!!node.defaultExpanded)
  const [children, setChildren] = useState<TreeNodeData[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openMenu = useContextMenu()

  const load = useCallback(async () => {
    if (!node.load) return
    setLoading(true)
    setError(null)
    try {
      setChildren(await node.load())
    } catch (e) {
      setError((e as Error).message)
      setChildren(null)
    } finally {
      setLoading(false)
    }
  }, [node])

  const refresh = useCallback(() => {
    setChildren(null)
    setExpanded(true)
    void load()
  }, [load])

  const toggle = () => {
    if (!node.load) return
    const next = !expanded
    setExpanded(next)
    if (next && children === null && !loading) void load()
  }

  // Čvorovi koji su inicijalno otvoreni moraju sami učitati djecu.
  useEffect(() => {
    if (expanded && children === null && node.load) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visible =
    children && node.filterChildren && filter
      ? children.filter((c) => c.label.toLowerCase().includes(filter))
      : children

  return (
    <>
      <div
        className={'tree-row' + (node.accent ? ' accented' : '')}
        style={{ paddingLeft: 6 + depth * 14, ['--accent' as string]: node.accent }}
        onClick={toggle}
        onDoubleClick={(e) => {
          if (node.onOpen) {
            e.stopPropagation()
            node.onOpen()
          }
        }}
        onContextMenu={(e) => node.menu && openMenu(e, node.menu({ refresh }))}
        title={node.title ?? node.label}
      >
        <span className={'tree-chevron' + (expanded ? ' open' : '') + (node.load ? '' : ' hidden')}>
          <Icon name="chevron" />
        </span>
        <Icon name={node.icon} className={node.iconClass} />
        <span className="tree-label">{node.label}</span>
        {node.detail && <span className="tree-detail">{node.detail}</span>}
        {loading && <span className="spinner small" />}
      </div>
      {expanded && error && (
        <div className="tree-error" style={{ paddingLeft: 26 + depth * 14 }} onClick={refresh} title={t('tree.retry')}>
          {error}
        </div>
      )}
      {expanded &&
        visible?.map((c) => <TreeItem key={c.key} node={c} depth={depth + 1} filter={filter} />)}
      {expanded && visible && visible.length === 0 && !loading && (
        <div className="tree-empty" style={{ paddingLeft: 26 + depth * 14 }}>
          {filter && node.filterChildren ? t('tree.noResults') : t('tree.empty')}
        </div>
      )}
    </>
  )
})
