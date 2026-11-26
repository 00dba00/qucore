import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ELK from 'elkjs/lib/elk.bundled.js'
import { api } from '../api'
import { HEADER_H, ROW_H, buildSvg, shortType, svgToPng } from '../erExport'
import type { ConnectionInfo, GraphTable, SchemaGraph } from '../../../shared/types'
import type { TabData } from './QueryTab'
import { Icon } from './Icons'
import { t } from '../i18n'

const CHAR_W = 7.2
/** Iznad ovog broja tablica dijagram se ne crta sam — prvo treba suziti shemu ili pretragu. */
const LARGE = 300

type TableData = { table: GraphTable; fkColumns: Set<string>; highlight: boolean; dim: boolean }
type TableNode = Node<TableData, 'table'>

const tableKey = (schema: string | undefined, name: string) => (schema ? `${schema}.${name}` : name)

function nodeWidth(t: GraphTable): number {
  const longest = Math.max(t.name.length + (t.schema ? t.schema.length + 1 : 0) + 4, ...t.columns.map((c) => c.name.length + shortType(c.type).length + 6))
  return Math.round(Math.min(420, Math.max(170, longest * CHAR_W + 40)))
}

/** Tablica: zaglavlje i kolone; svaka kolona ima ručke s obje strane za veze. */
const TableNodeView = memo(function TableNodeView({ data, selected }: NodeProps<TableNode>) {
  const { table, fkColumns, highlight, dim } = data
  return (
    <div className={'er-table' + (selected ? ' selected' : '') + (highlight ? ' highlight' : '') + (dim ? ' dim' : '')}>
      <div className="er-head" title={tableKey(table.schema, table.name)}>
        <Icon name="table" />
        {table.schema && <span className="er-schema">{table.schema}.</span>}
        <span className="er-name">{table.name}</span>
      </div>
      {table.columns.map((c) => (
        <div key={c.name} className="er-col">
          <Handle type="target" position={Position.Left} id={`${c.name}|tl`} className="er-handle" isConnectable={false} />
          <Handle type="source" position={Position.Left} id={`${c.name}|sl`} className="er-handle" isConnectable={false} />
          <span className="er-mark">
            {c.primaryKey ? <Icon name="key" className="er-pk" /> : fkColumns.has(c.name) ? <Icon name="link" className="er-fk" /> : null}
          </span>
          <span className={'er-col-name' + (c.primaryKey ? ' pk' : '')}>{c.name}</span>
          <span className="er-col-type" title={c.type + (c.nullable ? '' : ' NOT NULL')}>
            {shortType(c.type)}
            {c.nullable ? '' : ' ·'}
          </span>
          <Handle type="target" position={Position.Right} id={`${c.name}|tr`} className="er-handle" isConnectable={false} />
          <Handle type="source" position={Position.Right} id={`${c.name}|sr`} className="er-handle" isConnectable={false} />
        </div>
      ))}
    </div>
  )
})

const nodeTypes = { table: TableNodeView }
const elk = new ELK()

const nodeHeight = (t: GraphTable) => HEADER_H + ROW_H * t.columns.length + 4

/**
 * Raspored: povezane tablice ELK layered algoritmom (veza ide od tablice sa stranim ključem prema
 * referenciranoj), a tablice bez veza u mrežu ispod njih — inače zauzmu vrh dijagrama.
 */
async function layout(tables: GraphTable[], graph: SchemaGraph): Promise<Map<string, { x: number; y: number }>> {
  const keys = new Set(tables.map((t) => tableKey(t.schema, t.name)))
  const links = graph.foreignKeys
    .map((fk, i) => ({ id: 'e' + i, sources: [tableKey(fk.from.schema, fk.from.table)], targets: [tableKey(fk.to.schema, fk.to.table)] }))
    .filter((e) => keys.has(e.sources[0]) && keys.has(e.targets[0]) && e.sources[0] !== e.targets[0])
  const linked = new Set(links.flatMap((e) => [e.sources[0], e.targets[0]]))
  const related = tables.filter((t) => linked.has(tableKey(t.schema, t.name)))
  const isolated = tables.filter((t) => !linked.has(tableKey(t.schema, t.name)))
  const pos = new Map<string, { x: number; y: number }>()
  let bottom = 0
  let right = 1600
  if (related.length) {
    const res = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.layered.spacing.nodeNodeBetweenLayers': '90',
        'elk.spacing.nodeNode': '40',
        'elk.spacing.componentComponent': '70',
        'elk.aspectRatio': '1.8',
        'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF'
      },
      children: related.map((t) => ({ id: tableKey(t.schema, t.name), width: nodeWidth(t), height: nodeHeight(t) })),
      edges: links
    })
    for (const c of res.children ?? []) {
      pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 })
      bottom = Math.max(bottom, (c.y ?? 0) + (c.height ?? 0) + 120)
      right = Math.max(right, (c.x ?? 0) + (c.width ?? 0))
    }
  }
  // Mreža: redovi do širine povezanog dijela, visina reda po najvišoj tablici u njemu.
  let x = 0
  let y = bottom
  let rowH = 0
  for (const t of isolated) {
    const w = nodeWidth(t)
    if (x > 0 && x + w > right) {
      x = 0
      y += rowH + 40
      rowH = 0
    }
    pos.set(tableKey(t.schema, t.name), { x, y })
    x += w + 40
    rowH = Math.max(rowH, nodeHeight(t))
  }
  return pos
}

interface Props {
  tab: TabData
  active: boolean
  connections: ConnectionInfo[]
}

export function DiagramTab(props: Props) {
  return (
    <div className="diagram-tab" data-tab={props.tab.id} style={{ display: props.active ? 'flex' : 'none' }}>
      <ReactFlowProvider>
        <Diagram {...props} />
      </ReactFlowProvider>
    </div>
  )
}

function Diagram({ tab, active, connections }: Props) {
  const conn = connections.find((c) => c.id === tab.connectionId)
  const flow = useReactFlow()
  const [graph, setGraph] = useState<SchemaGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [schema, setSchema] = useState<string>('')
  const [search, setSearch] = useState('')
  const [nodes, setNodes] = useState<TableNode[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [forceLarge, setForceLarge] = useState(false)
  const [layoutBusy, setLayoutBusy] = useState(false)

  const load = useCallback(async () => {
    if (!tab.connectionId || !tab.database) return
    setLoading(true)
    setError(null)
    try {
      const g = await api.explorer.schemaGraph(tab.connectionId, tab.database)
      setGraph(g)
      // Puno tablica u više shema: kreni od sheme s najviše tablica.
      const schemas = [...new Set(g.tables.map((t) => t.schema).filter(Boolean))] as string[]
      if (g.tables.length > LARGE && schemas.length > 1) {
        const count = (s: string) => g.tables.filter((t) => t.schema === s).length
        setSchema(schemas.sort((a, b) => count(b) - count(a))[0])
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [tab.connectionId, tab.database])

  useEffect(() => {
    void load()
  }, [load])

  const schemas = useMemo(
    () => [...new Set((graph?.tables ?? []).map((t) => t.schema).filter(Boolean))].sort() as string[],
    [graph]
  )
  const tables = useMemo(() => (graph?.tables ?? []).filter((t) => !schema || t.schema === schema), [graph, schema])
  const tooLarge = tables.length > LARGE && !forceLarge

  const fkColumns = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const fk of graph?.foreignKeys ?? []) {
      const k = tableKey(fk.from.schema, fk.from.table)
      if (!m.has(k)) m.set(k, new Set())
      fk.from.columns.forEach((c) => m.get(k)!.add(c))
    }
    return m
  }, [graph])

  const relayout = useCallback(async () => {
    if (!graph || tooLarge) return setNodes([])
    setLayoutBusy(true)
    try {
      const pos = await layout(tables, graph)
      setNodes(
        tables.map((t) => {
          const id = tableKey(t.schema, t.name)
          return {
            id,
            type: 'table',
            position: pos.get(id) ?? { x: 0, y: 0 },
            data: { table: t, fkColumns: fkColumns.get(id) ?? new Set(), highlight: false, dim: false },
            width: nodeWidth(t)
          }
        })
      )
      requestAnimationFrame(() => void flow.fitView({ padding: 0.08, duration: 200 }))
    } finally {
      setLayoutBusy(false)
    }
  }, [graph, tables, tooLarge, fkColumns, flow])

  useEffect(() => {
    void relayout()
  }, [relayout])

  // Pretraga ističe tablice koje sadrže tekst (u nazivu tablice ili kolone), ostale blijede.
  const q = search.trim().toLowerCase()
  const shownNodes = useMemo(
    () =>
      nodes.map((n) => {
        const t = n.data.table
        const hit = !!q && (t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q)))
        return hit === n.data.highlight && (!!q && !hit) === n.data.dim ? n : { ...n, data: { ...n.data, highlight: hit, dim: !!q && !hit } }
      }),
    [nodes, q]
  )

  const edges = useMemo<Edge[]>(() => {
    if (!graph) return []
    const at = new Map(nodes.map((n) => [n.id, n]))
    const out: Edge[] = []
    graph.foreignKeys.forEach((fk, i) => {
      const s = at.get(tableKey(fk.from.schema, fk.from.table))
      const t = at.get(tableKey(fk.to.schema, fk.to.table))
      if (!s || !t) return
      // Ručke na stranama koje gledaju jedna prema drugoj; veza na samu sebe ide zdesna nadesno.
      const self = s.id === t.id
      const sRight = self || s.position.x + (s.width ?? 0) / 2 <= t.position.x + (t.width ?? 0) / 2
      const hot = selected !== null && (selected === s.id || selected === t.id)
      out.push({
        id: 'fk' + i,
        source: s.id,
        target: t.id,
        sourceHandle: `${fk.from.columns[0]}|${sRight ? 'sr' : 'sl'}`,
        targetHandle: `${fk.to.columns[0]}|${self || !sRight ? 'tr' : 'tl'}`,
        type: 'smoothstep',
        className: 'er-edge' + (hot ? ' hot' : ''),
        zIndex: hot ? 1 : 0,
        ariaLabel: `${fk.name}: ${fk.from.table}(${fk.from.columns.join(', ')}) → ${fk.to.table}(${fk.to.columns.join(', ')})`
      })
    })
    return out
  }, [graph, nodes, selected])

  const focusFirstMatch = () => {
    const hit = shownNodes.find((n) => n.data.highlight)
    if (hit) void flow.fitView({ nodes: [{ id: hit.id }], padding: 0.6, duration: 300, maxZoom: 1.2 })
  }

  const exportImage = async (format: 'png' | 'svg') => {
    if (nodes.length === 0) return
    // Putanje veza koje je React Flow već izračunao (u koordinatama dijagrama).
    const root = document.querySelector(`.diagram-tab[data-tab="${tab.id}"]`)
    const paths = [...(root?.querySelectorAll<SVGPathElement>('.react-flow__edge-path') ?? [])].map((p) => p.getAttribute('d') ?? '')
    const { svg, width, height } = buildSvg(
      nodes.map((n) => ({
        table: n.data.table,
        fkColumns: n.data.fkColumns,
        x: n.position.x,
        y: n.position.y,
        width: n.measured?.width ?? nodeWidth(n.data.table),
        height: n.measured?.height ?? nodeHeight(n.data.table)
      })),
      paths.filter(Boolean),
      `${tab.database ?? ''}${schema ? ' / ' + schema : ''} — ${t('diagram.title')}`
    )
    const url = format === 'svg' ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) : await svgToPng(svg, width, height)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(tab.database ?? t('diagram.fileName')).replace(/[^\w.-]+/g, '_')}${schema ? '_' + schema : ''}-er.${format}`
    a.click()
  }

  const relations = edges.length
  return (
    <>
      <div className="toolbar" style={conn?.color ? { boxShadow: `inset 0 -2px 0 ${conn.color}` } : undefined}>
        <button className="btn" onClick={() => void load()} disabled={loading} title={t('diagram.reloadTitle')}>
          <Icon name="refresh" /> {t('common.refresh')}
        </button>
        <button className="btn" onClick={() => void relayout()} disabled={layoutBusy || nodes.length === 0} title={t('diagram.relayoutTitle')}>
          <Icon name="diagram" /> {t('diagram.relayout')}
        </button>
        <span className="toolbar-sep" />
        {schemas.length > 1 && (
          <select value={schema} onChange={(e) => setSchema(e.target.value)} title={t('diagram.schema')}>
            <option value="">{t('diagram.allSchemas')}</option>
            {schemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <span className="er-search">
          <Icon name="search" />
          <input
            placeholder={t('diagram.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && focusFirstMatch()}
          />
        </span>
        <span className="toolbar-sep" />
        <button className="icon-btn" onClick={() => void flow.zoomOut({ duration: 150 })} title={t('diagram.zoomOut')}>
          <Icon name="minus" />
        </button>
        <button className="icon-btn" onClick={() => void flow.zoomIn({ duration: 150 })} title={t('diagram.zoomIn')}>
          <Icon name="plus" />
        </button>
        <button className="icon-btn" onClick={() => void flow.fitView({ padding: 0.08, duration: 200 })} title={t('diagram.fit')}>
          <Icon name="fit" />
        </button>
        <span style={{ flex: 1 }} />
        <span className="muted small">
          {tables.length} tablica · {relations} veza
        </span>
        <button className="btn" onClick={() => void exportImage('png')} disabled={nodes.length === 0} title={t('diagram.export', 'PNG')}>
          <Icon name="image" /> PNG
        </button>
        <button className="btn" onClick={() => void exportImage('svg')} disabled={nodes.length === 0} title={t('diagram.export', 'SVG')}>
          <Icon name="download" /> SVG
        </button>
      </div>
      <div className="er-canvas" data-active={active}>
        {error ? (
          <div className="empty err">{error}</div>
        ) : loading && !graph ? (
          <div className="empty">
            <span className="spinner small" /> {t('diagram.loading')}
          </div>
        ) : tooLarge ? (
          <div className="empty">
            <div>
              {t('diagram.tooLarge', tables.length)}
              {schemas.length > 1 ? ` ${t('diagram.pickSchemaOr')} ` : ' '}
              <button className="link-btn" onClick={() => setForceLarge(true)}>
                {t('diagram.drawAll')}
              </button>
            </div>
          </div>
        ) : graph && tables.length === 0 ? (
          <div className="empty">{t('diagram.noTables')}</div>
        ) : (
          <ReactFlow
            nodes={shownNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => setNodes((list) => applyNodeChanges(changes, list))}
            onSelectionChange={({ nodes: sel }) => setSelected(sel[0]?.id ?? null)}
            nodesConnectable={false}
            edgesFocusable={false}
            minZoom={0.05}
            maxZoom={2}
            colorMode="dark"
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <MiniMap pannable zoomable nodeColor="#3574f0" maskColor="rgba(20,21,24,0.7)" />
          </ReactFlow>
        )}
      </div>
    </>
  )
}
