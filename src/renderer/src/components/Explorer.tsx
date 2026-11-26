import { useMemo, useState } from 'react'
import { api } from '../api'
import { invalidateObjects, primeObjects } from '../completion'
import { countSql, ident, qualifiedName, selectTopSql } from '../dialect'
import { genDelete, genInsert, genSelect, genUpdate } from '../../../core/generateSql'
import {
  DB_TYPE_LABELS,
  objectKindLabel,
  type ConnectionInfo,
  type DbObject,
  type ObjectKind
} from '../../../shared/types'
import { Icon } from './Icons'
import type { SourceTable } from '../editing'
import { TreeItem, type TreeNodeData } from './Tree'
import type { ProjectScope } from './Projects'
import { num, t } from '../i18n'

export interface ExplorerActions {
  newQuery(connectionId: string, database?: string, sql?: string, opts?: { run?: boolean; title?: string; source?: SourceTable }): void
  insertText(text: string): void
  /** ER dijagram baze (tablice i strani ključevi). */
  openDiagram(connectionId: string, database: string): void
  editConnection(c: ConnectionInfo): void
  deleteConnection(c: ConnectionInfo): void
  newConnection(): void
  /** Desni klik na bazu → Projekti… */
  editDatabaseProjects(c: ConnectionInfo, database: string): void
  /** Objekti baze su učitani (main je provjerio shemu spremljenih queryja). */
  objectsLoaded(): void
  notify(text: string, kind?: 'error' | 'info'): void
  /** Tab tablice/viewa: kolone, podaci, indeksi, strani ključevi, DDL. */
  openTable(connectionId: string, database: string, obj: DbObject): void
  /** Prije odspajanja: tabovi s otvorenom transakcijom (potvrda + Rollback). false = odustani. */
  beforeDisconnect(connectionId: string): Promise<boolean>
}

const KIND_ORDER: ObjectKind[] = ['table', 'view', 'procedure', 'function', 'trigger']

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${num(n, { maximumFractionDigits: n >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`
}

function objectNodes(conn: ConnectionInfo, db: string, objs: DbObject[], a: ExplorerActions): TreeNodeData[] {
  const multiSchema = new Set(objs.map((o) => o.schema)).size > 1
  return objs.map((o) => {
    const display = (o.label ?? o.name)
    const label = o.schema && multiSchema ? `${o.schema}.${display}` : display
    const isData = o.kind === 'table' || o.kind === 'view'
    // Samo tablice (ne viewovi) mogu se uređivati u gridu.
    const source: SourceTable | undefined = o.kind === 'table' ? { database: db, schema: o.schema, table: o.name } : undefined
    /** Predložak SQL-a sa stupcima tablice u novom tabu (ne izvršava se). */
    const generate = async (kind: 'select' | 'insert' | 'update' | 'delete') => {
      try {
        const ch = await api.explorer.children(conn.id, db, o)
        const columns = ch.flatMap((c) => (c.type === 'column' ? [c] : []))
        const target = { type: conn.type, table: qualifiedName(conn.type, o), columns, quote: (n: string) => ident(conn.type, n) }
        const sql = { select: genSelect, insert: genInsert, update: genUpdate, delete: genDelete }[kind](target)
        a.newQuery(conn.id, db, sql, { title: `${kind.toUpperCase()} ${o.name}`, source: kind === 'select' ? source : undefined })
      } catch (e) {
        a.notify((e as Error).message, 'error')
      }
    }
    const script = async () => {
      try {
        const def = await api.explorer.definition(conn.id, db, o)
        a.newQuery(conn.id, db, def, { title: o.name })
      } catch (e) {
        a.notify((e as Error).message, 'error')
      }
    }
    return {
      key: `${o.kind}:${o.schema ?? ''}.${o.name}:${o.id ?? ''}`,
      label,
      icon: o.kind,
      iconClass: 'k-' + o.kind,
      detail: o.parent ?? (o.sizeBytes !== undefined ? formatBytes(o.sizeBytes) : undefined),
      title: (o.schema ? `${o.schema}.${display}` : display) + (o.sizeBytes !== undefined ? ` — ${formatBytes(o.sizeBytes)}` : ''),
      onOpen: isData
        ? () => a.newQuery(conn.id, db, selectTopSql(conn.type, o), { run: true, title: o.name, source })
        : script,
      load: o.expandable
        ? async () => {
            const ch = await api.explorer.children(conn.id, db, o)
            return ch.map((c) =>
              c.type === 'column'
                ? {
                    key: 'c:' + c.name,
                    label: c.name,
                    icon: c.primaryKey ? 'key' : 'column',
                    iconClass: c.primaryKey ? 'k-key' : 'k-column',
                    detail: `${c.dataType}${c.nullable ? '' : ' not null'}${c.identity ? ' identity' : ''}`,
                    onOpen: () => a.insertText(c.name),
                    menu: () => [{ label: t('explorer.insertName'), onClick: () => a.insertText(c.name) }]
                  }
                : {
                    key: 'p:' + c.name,
                    label: c.name,
                    icon: 'param',
                    iconClass: 'k-param',
                    detail: `${c.mode === 'RETURN' ? '' : c.mode + ' '}${c.dataType}`
                  }
            )
          }
        : undefined,
      menu: ({ refresh }) => [
        ...(isData
          ? [
              { label: o.kind === 'view' ? t('explorer.openView') : t('explorer.openTable'), onClick: () => a.openTable(conn.id, db, o) },
              { label: t('explorer.selectTop'), onClick: () => a.newQuery(conn.id, db, selectTopSql(conn.type, o), { run: true, title: o.name, source }) },
              { label: t('explorer.rowCount'), onClick: () => a.newQuery(conn.id, db, countSql(conn.type, o), { run: true, title: o.name }) },
              'separator' as const,
              { label: t('explorer.genSelect'), onClick: () => void generate('select') },
              ...(o.kind === 'table'
                ? [
                    { label: t('explorer.gen', 'INSERT'), onClick: () => void generate('insert') },
                    { label: t('explorer.gen', 'UPDATE'), onClick: () => void generate('update') },
                    { label: t('explorer.gen', 'DELETE'), onClick: () => void generate('delete') }
                  ]
                : []),
              'separator' as const
            ]
          : []),
        { label: t('explorer.script'), onClick: script },
        { label: t('explorer.insertName'), onClick: () => a.insertText(qualifiedName(conn.type, o)) },
        { label: t('explorer.copyName'), onClick: () => navigator.clipboard.writeText(qualifiedName(conn.type, o)) },
        ...(o.expandable ? ['separator' as const, { label: t('common.refresh'), onClick: refresh }] : [])
      ]
    }
  })
}

function databaseNode(conn: ConnectionInfo, db: string, a: ExplorerActions, expanded: boolean, size?: number): TreeNodeData {
  const sizeText = size === undefined ? undefined : formatBytes(size)
  return {
    key: 'db:' + db,
    label: db,
    detail: sizeText,
    title: sizeText ? `${db} — ${sizeText} (${conn.type === 'mssql' ? t('explorer.sizeMssql') : t('explorer.sizeOther')})` : db,
    icon: 'database',
    iconClass: 'k-database',
    defaultExpanded: expanded,
    onOpen: () => a.newQuery(conn.id, db),
    load: async () => {
      const objs = await api.explorer.objects(conn.id, db)
      primeObjects(conn.id, db, objs)
      a.objectsLoaded()
      return KIND_ORDER.map((kind) => {
        const items = objs.filter((o) => o.kind === kind)
        return {
          key: 'folder:' + kind,
          label: objectKindLabel(kind),
          icon: 'folder' as const,
          iconClass: 'k-folder',
          detail: String(items.length),
          filterChildren: true,
          defaultExpanded: kind === 'table' && items.length > 0 && items.length < 300,
          load: async () => objectNodes(conn, db, items, a)
        }
      })
    },
    menu: ({ refresh }) => [
      { label: t('explorer.newQuery'), shortcut: t('common.doubleClick'), onClick: () => a.newQuery(conn.id, db) },
      { label: t('explorer.erDiagram'), onClick: () => a.openDiagram(conn.id, db) },
      { label: t('explorer.projects'), onClick: () => a.editDatabaseProjects(conn, db) },
      'separator',
      {
        label: t('common.refresh'),
        onClick: () => {
          invalidateObjects(conn.id, db)
          refresh()
        }
      }
    ]
  }
}

function connectionNode(
  conn: ConnectionInfo,
  a: ExplorerActions,
  onConnected: (id: string, v: string) => void,
  /** Baze aktivnog projekta na ovoj konekciji; undefined = sve. */
  only?: Set<string>
): TreeNodeData {
  return {
    key: 'conn:' + conn.id,
    label: conn.name,
    icon: 'server',
    iconClass: 'k-server',
    detail: (conn.environment ? conn.environment.toUpperCase() + ' · ' : '') + DB_TYPE_LABELS[conn.type],
    accent: conn.color,
    title: `${conn.name} — ${conn.mssqlAuth === 'windows' ? t('explorer.windowsAuth') : conn.user}@${conn.host}:${conn.port}`,
    onOpen: () => a.newQuery(conn.id, conn.database),
    load: async () => {
      const { version } = await api.explorer.connect(conn.id)
      onConnected(conn.id, version)
      const [all, sizes] = await Promise.all([
        api.explorer.databases(conn.id),
        api.explorer.databaseSizes(conn.id).catch(() => ({}) as Record<string, number>)
      ])
      const dbs = only ? all.filter((d) => only.has(d)) : all
      const single = dbs.length === 1
      return dbs.map((d) => databaseNode(conn, d, a, single || d === conn.database, sizes[d]))
    },
    menu: ({ refresh }) => [
      { label: t('explorer.newQuery'), onClick: () => a.newQuery(conn.id, conn.database) },
      'separator',
      { label: t('explorer.editConnection'), onClick: () => a.editConnection(conn) },
      {
        label: t('common.refresh'),
        onClick: () => {
          invalidateObjects(conn.id)
          refresh()
        }
      },
      {
        label: t('explorer.disconnect'),
        onClick: async () => {
          if (!(await a.beforeDisconnect(conn.id))) return
          await api.explorer.disconnect(conn.id)
          invalidateObjects(conn.id)
          a.notify(t('explorer.disconnected', conn.name))
        }
      },
      'separator',
      { label: t('explorer.deleteConnection'), danger: true, onClick: () => a.deleteConnection(conn) }
    ]
  }
}

function scopeKey(scope: ProjectScope | undefined, connectionId: string): string {
  const dbs = scope?.get(connectionId)
  return dbs ? JSON.stringify([...dbs].sort()) : '*'
}

export function Explorer({
  connections,
  actions,
  scope,
  projectName,
  visible = true
}: {
  connections: ConnectionInfo[]
  actions: ExplorerActions
  /** Aktivni projekt: samo njegove konekcije i baze. */
  scope?: ProjectScope
  projectName?: string
  visible?: boolean
}) {
  const [filter, setFilter] = useState('')
  const [versions, setVersions] = useState<Record<string, string>>({})

  const nodes = useMemo(
    () =>
      connections
        .filter((c) => !scope || scope.has(c.id))
        .map((c) =>
          connectionNode(c, actions, (id, v) => setVersions((prev) => (prev[id] === v ? prev : { ...prev, [id]: v })), scope?.get(c.id))
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connections, scope]
  )

  return (
    <div className="explorer" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="explorer-filter">
        <Icon name="search" />
        <input
          placeholder={t('explorer.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
        />
      </div>
      <div className="tree">
        {nodes.map((n) => (
          // Promjena projekta mijenja popis baza; ključ s opsegom ponovno učita čvor konekcije.
          <div key={n.key + '|' + scopeKey(scope, n.key.slice(5))} title={versions[n.key.slice(5)]}>
            <TreeItem node={n} depth={0} filter={filter.trim().toLowerCase()} />
          </div>
        ))}
        {connections.length > 0 && scope && nodes.length === 0 && (
          <div className="explorer-empty">
            <p>{t('explorer.projectEmpty', projectName ?? '')}</p>
            <p className="small">{t('explorer.projectEmptyHint')}</p>
          </div>
        )}
        {connections.length === 0 && (
          <div className="explorer-empty">
            <p>{t('explorer.noConnections')}</p>
            <button className="btn primary" onClick={actions.newConnection}>
              <Icon name="plug" /> {t('explorer.addConnection')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
