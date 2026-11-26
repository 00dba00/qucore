import { useEffect, useState, type ReactNode } from 'react'
import Editor from '@monaco-editor/react'
import type { ColumnInfo, ConnectionInfo, DbObject, ForeignKeyInfo, TableDetails } from '../../../shared/types'
import { api } from '../api'
import { MONACO_LANGUAGE } from '../dialect'
import { Icon } from './Icons'
import type { TabData } from './QueryTab'
import { t } from '../i18n'

export type TableSub = 'columns' | 'data' | 'indexes' | 'fks' | 'ddl'

const subs = (): { id: TableSub; label: string; tablesOnly?: boolean }[] => [
  { id: 'columns', label: t('table.columns') },
  { id: 'data', label: t('table.data') },
  { id: 'indexes', label: t('table.indexes'), tablesOnly: true },
  { id: 'fks', label: t('table.fks'), tablesOnly: true },
  { id: 'ddl', label: 'DDL' }
]

const fullName = (schema: string | undefined, name: string) => (schema ? `${schema}.${name}` : name)

/**
 * Tab tablice (ili viewa): struktura i podaci na jednom mjestu. Podaci su ugrađeni QueryTab
 * (renderData), pa vrijede uređivanje, filter, export i transakcije kao u običnom tabu.
 */
export function TableTab({
  tab,
  active,
  connections,
  onSub,
  onOpenTable,
  onNewQuery,
  renderData
}: {
  tab: TabData
  active: boolean
  connections: ConnectionInfo[]
  onSub(sub: TableSub): void
  /** Klik na tablicu u stranim ključevima otvara njezin tab. */
  onOpenTable(obj: DbObject): void
  onNewQuery(sql: string, title: string): void
  renderData(active: boolean): ReactNode
}) {
  const obj = tab.object!
  const conn = connections.find((c) => c.id === tab.connectionId)
  const sub: TableSub = tab.sub ?? 'columns'
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null)
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [ddl, setDdl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  /** Podaci se montiraju tek kad se prvi put otvore (SELECT se tada izvrši). */
  const [dataVisited, setDataVisited] = useState(sub === 'data')
  useEffect(() => {
    if (sub === 'data') setDataVisited(true)
  }, [sub])

  // Svaka podkartica učitava svoje tek kad je otvorena; Osvježi briše sve.
  useEffect(() => {
    if (!active || !tab.connectionId || !tab.database) return
    let alive = true
    const fail = (e: unknown) => alive && setError((e as Error).message)
    setError(null)
    if (sub === 'columns' && !columns) {
      api.explorer
        .children(tab.connectionId, tab.database, obj)
        .then((ch) => alive && setColumns(ch.flatMap((c) => (c.type === 'column' ? [c] : []))))
        .catch(fail)
    }
    if ((sub === 'indexes' || sub === 'fks') && !details) {
      api.explorer.tableDetails(tab.connectionId, tab.database, obj).then((d) => alive && setDetails(d)).catch(fail)
    }
    if (sub === 'ddl' && ddl === null) {
      api.explorer.definition(tab.connectionId, tab.database, obj).then((d) => alive && setDdl(d)).catch(fail)
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sub, version, tab.connectionId, tab.database])

  const refresh = () => {
    setColumns(null)
    setDetails(null)
    setDdl(null)
    setVersion((v) => v + 1)
  }

  const tableLink = (schema: string | undefined, name: string) => (
    <button className="link-btn" onClick={() => onOpenTable({ kind: 'table', schema, name, expandable: true })} title={t('table.openTable')}>
      {/* MariaDB: shema je baza — ne ponavljaj je za tablice iste baze */}
      {fullName(conn?.type === 'mariadb' && schema === tab.database ? undefined : schema, name)}
    </button>
  )
  const fkRow = (f: ForeignKeyInfo, outgoing: boolean) => (
    <tr key={`${f.fromTable}.${f.name}`}>
      <td className="mono">{f.name}</td>
      <td className="mono">{outgoing ? f.fromColumns.join(', ') : <>{tableLink(f.fromSchema, f.fromTable)} ({f.fromColumns.join(', ')})</>}</td>
      <td className="arrow">→</td>
      <td className="mono">{outgoing ? <>{tableLink(f.toSchema, f.toTable)} ({f.toColumns.join(', ')})</> : f.toColumns.join(', ')}</td>
    </tr>
  )

  return (
    <div className="table-tab" style={{ display: active ? 'flex' : 'none' }}>
      <div className="table-tab-head">
        <Icon name={obj.kind === 'view' ? 'view' : 'table'} />
        <b>{fullName(obj.schema, obj.name)}</b>
        <span className="muted small">
          {obj.kind === 'view' ? 'view' : t('table.table')} · {conn?.name ?? '?'} / {tab.database}
        </span>
        <div className="table-subs">
          {subs().filter((s) => !s.tablesOnly || obj.kind === 'table').map((s) => (
            <button key={s.id} className={'seg' + (sub === s.id ? ' active' : '')} onClick={() => onSub(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {sub !== 'data' && (
          <button className="icon-btn" title={t('table.refresh')} onClick={refresh}>
            <Icon name="refresh" />
          </button>
        )}
      </div>

      {dataVisited && <div className="table-data" style={{ display: sub === 'data' ? 'flex' : 'none' }}>{renderData(active && sub === 'data')}</div>}

      {sub !== 'data' && (
        <div className="table-body">
          {error && <div className="msg error">{error}</div>}
          {sub === 'columns' &&
            (columns ? (
              <table className="struct-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('common.name')}</th>
                    <th>{t('table.type')}</th>
                    <th>Null</th>
                    <th>{t('table.default')}</th>
                    <th>{t('table.key')}</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c, i) => (
                    <tr key={c.name}>
                      <td className="muted">{i + 1}</td>
                      <td className="mono strong">{c.name}</td>
                      <td className="mono">{c.dataType}</td>
                      <td>{c.nullable ? t('table.yes') : <b>NOT NULL</b>}</td>
                      <td className="mono muted">{c.defaultValue ?? ''}</td>
                      <td>
                        {c.primaryKey && <span className="tag pk">PK</span>}
                        {c.identity && <span className="tag">identity</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              !error && <div className="muted small pad">{t('common.loading')}</div>
            ))}
          {sub === 'indexes' &&
            (details ? (
              details.indexes.length ? (
                <table className="struct-table">
                  <thead>
                    <tr>
                      <th>{t('common.name')}</th>
                      <th>{t('table.ixColumns')}</th>
                      <th>{t('table.ixKind')}</th>
                      <th>INCLUDE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.indexes.map((ix) => (
                      <tr key={ix.name}>
                        <td className="mono strong">
                          {ix.name} {ix.primary ? <span className="tag pk">PK</span> : ix.unique ? <span className="tag">UNIQUE</span> : null}
                        </td>
                        <td className="mono">{ix.columns.join(', ')}</td>
                        <td className="muted">{ix.type ?? ''}</td>
                        <td className="mono muted">{ix.included?.join(', ') ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="muted small pad">{t('table.noIndexes')}</div>
              )
            ) : (
              !error && <div className="muted small pad">{t('common.loading')}</div>
            ))}
          {sub === 'fks' &&
            (details ? (
              <>
                <h4>{t('table.fkOut')}</h4>
                {details.foreignKeys.length ? (
                  <table className="struct-table">
                    <tbody>{details.foreignKeys.map((f) => fkRow(f, true))}</tbody>
                  </table>
                ) : (
                  <div className="muted small pad">{t('table.noFks')}</div>
                )}
                <h4>{t('table.fkIn')}</h4>
                {details.referencedBy.length ? (
                  <table className="struct-table">
                    <tbody>{details.referencedBy.map((f) => fkRow(f, false))}</tbody>
                  </table>
                ) : (
                  <div className="muted small pad">{t('table.noFkIn')}</div>
                )}
              </>
            ) : (
              !error && <div className="muted small pad">{t('common.loading')}</div>
            ))}
          {sub === 'ddl' &&
            (ddl !== null ? (
              <div className="table-ddl">
                <div className="table-ddl-bar">
                  <button className="link-btn" onClick={() => void navigator.clipboard.writeText(ddl)}>
                    {t('common.copy')}
                  </button>
                  <button className="link-btn" onClick={() => onNewQuery(ddl, `DDL ${obj.name}`)}>
                    {t('history.openNewTab')}
                  </button>
                </div>
                <Editor
                  value={ddl}
                  language={conn ? MONACO_LANGUAGE[conn.type] : 'sql'}
                  theme="studio-dark"
                  options={{ readOnly: true, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, fontSize: 13 }}
                />
              </div>
            ) : (
              !error && <div className="muted small pad">{t('common.loading')}</div>
            ))}
        </div>
      )}
    </div>
  )
}
