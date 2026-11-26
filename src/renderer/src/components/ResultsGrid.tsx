import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { CellValue, DbType, ResultSet } from '../../../shared/types'
import { toInserts, type ResultView } from '../../../core/resultFormats'
import { ident } from '../dialect'
import type { Pending } from '../editing'
import { useContextMenu, type MenuEntry } from './ContextMenu'
import { Icon } from './Icons'
import { ValuePanel, type PanelMode } from './ValuePanel'
import { compareText, num, t } from '../i18n'

const ROW_H = 24
const OVERSCAN = 12
const ROWNUM_W = 56
const CHAR_W = 7.4

function display(v: CellValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  const s = String(v)
  return s.length > 500 ? s.slice(0, 500) + '…' : s
}

function toTsvValue(v: CellValue): string {
  if (v === null) return ''
  const s = String(v)
  return /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

const NUMERIC = /int|numeric|decimal|float|double|real|money|serial/i

/** Filter po stupcu (desni klik na ćeliju); '≠' propušta i NULL. */
interface ColFilter {
  col: number
  op: 'eq' | 'ne' | 'null' | 'notnull'
  value?: CellValue
}

function matchFilter(f: ColFilter, x: CellValue): boolean {
  switch (f.op) {
    case 'null':
      return x === null
    case 'notnull':
      return x !== null
    case 'eq':
      return x !== null && String(x) === String(f.value)
    case 'ne':
      return x === null || String(x) !== String(f.value)
  }
}

function shortValue(v: CellValue | undefined): string {
  const s = display(v ?? null)
  return s.length > 30 ? s.slice(0, 30) + '…' : s
}

function filterLabel(f: ColFilter, name: string): string {
  if (f.op === 'null') return `${name} IS NULL`
  if (f.op === 'notnull') return `${name} IS NOT NULL`
  return `${name} ${f.op === 'eq' ? '=' : '≠'} ${shortValue(f.value)}`
}

/** Tekst ćelije s istaknutim pogocima brzog traženja (q je već malim slovima). */
function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text
  const lower = text.toLowerCase()
  let i = lower.indexOf(q)
  if (i < 0) return text
  const out: React.ReactNode[] = []
  let from = 0
  while (i >= 0) {
    if (i > from) out.push(text.slice(from, i))
    out.push(<mark key={i}>{text.slice(i, i + q.length)}</mark>)
    from = i + q.length
    i = lower.indexOf(q, from)
  }
  if (from < text.length) out.push(text.slice(from))
  return out
}

/** Gumbi iznad grida (Kopiraj, Kopiraj kao, Export) rade nad onim što grid prikazuje. */
export interface GridHandle {
  /** TSV s nazivima stupaca u međuspremnik; vraća broj redaka. */
  copyAll(): Promise<number>
  /** Prikazani retci (sortirani, filtrirani, s neuspremljenim izmjenama). */
  view(): ResultView
}

/** Kopiranje kao INSERT: dijalekt i naziv tablice (QueryTab ga zna iz izvora taba ili upita). */
export interface InsertTarget {
  dialect: DbType
  table(): string
}

/** Uređivanje podataka: grid samo bilježi izmjene u Pending, spremanje radi QueryTab. */
export interface GridEdit {
  /** Po koloni: smije li se uređivati. */
  editable: boolean[]
  pending: Pending
  onChange(next: Pending): void
}

/** Redak u prikazu: postojeći (ref na redak iz rezultata) ili novi (indeks u pending.inserts). */
type DisplayRow = { ref: CellValue[]; ins?: undefined } | { ref?: undefined; ins: number }

function clonePending(p: Pending): Pending {
  return { updates: new Map(p.updates), deletes: new Set(p.deletes), inserts: [...p.inserts] }
}

/** Virtualizirana tablica: renderira samo vidljive retke, pa radi glatko i s desecima tisuća redaka. */
export const ResultsGrid = memo(function ResultsGrid({
  rs,
  edit,
  gridRef,
  insert
}: {
  rs: ResultSet
  edit?: GridEdit
  /** Gumbi izvan grida (Kopiraj, Kopiraj kao, Export) dobivaju prikazane retke. */
  gridRef?: MutableRefObject<GridHandle | null>
  insert?: InsertTarget
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null)
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null)
  const [quick, setQuick] = useState('')
  const [filters, setFilters] = useState<ColFilter[]>([])
  const searchRef = useRef<HTMLInputElement>(null)
  /** Panel desno: puna vrijednost ćelije ili redak okomito; ostaje otvoren i za sljedeće rezultate. */
  const [panel, setPanel] = useState<PanelMode | null>(null)
  const togglePanel = (m: PanelMode) => {
    setPanel((p) => (p === m ? null : m))
    if (!sel && displayRows.length) setSel({ r: 0, c: 0 })
  }
  const [editing, setEditingState] = useState<{ r: number; c: number; text: string; initial: string } | null>(null)
  // Ref uz state: blur se može okinuti i nakon Enter/Esc (kad input nestaje) — tada ne smije ponovno spremiti.
  const editingRef = useRef(editing)
  const setEditing = (v: typeof editing) => {
    editingRef.current = v
    setEditingState(v)
  }
  const openMenu = useContextMenu()

  const numericCols = useMemo(
    () =>
      rs.columns.map(
        (c, i) => (c.type ? NUMERIC.test(c.type) : false) || rs.rows.slice(0, 50).some((r) => typeof r[i] === 'number')
      ),
    // Samo po kolonama: dok rezultat stiže u dijelovima, retci se dodaju, a širine i odabir ostaju.
    [rs.columns]
  )

  const initialWidths = useMemo(() => {
    const sample = rs.rows.slice(0, 200)
    return rs.columns.map((c, i) => {
      let max = c.name.length + 2
      for (const r of sample) max = Math.max(max, Math.min(60, display(r[i]).length))
      return Math.round(Math.min(420, Math.max(60, max * CHAR_W + 18)))
    })
  }, [rs.columns])
  const [widths, setWidths] = useState(initialWidths)
  useEffect(() => {
    setWidths(initialWidths)
    setSel(null)
    setSort(null)
    setEditing(null)
    setQuick('')
    setFilters([])
  }, [initialWidths])

  const q = quick.trim().toLowerCase()
  /** Retci nakon brzog traženja i filtera po stupcima (nad učitanim vrijednostima, bez neuspremljenih izmjena). */
  const filtered = useMemo(() => {
    if (!q && !filters.length) return rs.rows
    return rs.rows.filter(
      (r) => filters.every((f) => matchFilter(f, r[f.col])) && (!q || r.some((v) => display(v).toLowerCase().includes(q)))
    )
  }, [rs, q, filters])
  const isFiltered = !!q || filters.length > 0
  useEffect(() => setSel(null), [q, filters])
  const addFilter = (f: ColFilter) => setFilters((list) => [...list.filter((x) => x.col !== f.col), f])
  const clearFilters = () => {
    setFilters([])
    setQuick('')
  }

  const rows = useMemo(() => {
    if (!sort) return filtered
    const { col, dir } = sort
    const numeric = numericCols[col]
    return [...filtered].sort((a, b) => {
      const x = a[col]
      const y = b[col]
      if (x === y) return 0
      if (x === null) return 1
      if (y === null) return -1
      if (numeric) return (Number(x) - Number(y)) * dir
      return compareText(String(x), String(y)) * dir
    })
  }, [filtered, sort, numericCols])

  const pending = edit?.pending
  const displayRows = useMemo<DisplayRow[]>(() => {
    const out: DisplayRow[] = rows.map((ref) => ({ ref }))
    pending?.inserts.forEach((_, ins) => out.push({ ins }))
    return out
  }, [rows, pending])

  /** Vrijednost za prikaz; undefined = novi redak, kolona nije popunjena (DEFAULT). */
  const valueOf = (dr: DisplayRow, c: number): CellValue | undefined => {
    if (dr.ins !== undefined) return pending!.inserts[dr.ins].get(c)
    const changed = pending?.updates.get(dr.ref)
    return changed?.has(c) ? changed.get(c)! : dr.ref[c]
  }
  const isChanged = (dr: DisplayRow, c: number) =>
    dr.ins !== undefined ? pending!.inserts[dr.ins].has(c) : !!pending?.updates.get(dr.ref)?.has(c)
  const isDeleted = (dr: DisplayRow) => dr.ref !== undefined && !!pending?.deletes.has(dr.ref)
  const canEdit = (dr: DisplayRow, c: number) => !!edit && edit.editable[c] && !isDeleted(dr)

  /** value === undefined vraća izvornu vrijednost (ili DEFAULT kod novog retka). */
  const setCell = (dr: DisplayRow, c: number, value: CellValue | undefined) => {
    if (!edit) return
    const next = clonePending(edit.pending)
    if (dr.ins !== undefined) {
      const cells = new Map(next.inserts[dr.ins])
      if (value === undefined) cells.delete(c)
      else cells.set(c, value)
      next.inserts[dr.ins] = cells
    } else {
      const cells = new Map(next.updates.get(dr.ref) ?? [])
      if (value === undefined || value === dr.ref[c]) cells.delete(c)
      else cells.set(c, value)
      if (cells.size) next.updates.set(dr.ref, cells)
      else next.updates.delete(dr.ref)
    }
    edit.onChange(next)
  }
  const toggleDelete = (dr: DisplayRow) => {
    if (!edit) return
    const next = clonePending(edit.pending)
    if (dr.ins !== undefined) next.inserts.splice(dr.ins, 1)
    else if (next.deletes.has(dr.ref)) next.deletes.delete(dr.ref)
    else next.deletes.add(dr.ref)
    edit.onChange(next)
  }
  const addRow = () => {
    if (!edit) return
    const next = clonePending(edit.pending)
    next.inserts.push(new Map())
    edit.onChange(next)
    const r = rows.length + next.inserts.length - 1
    setSel({ r, c: edit.editable.indexOf(true) })
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  const startEdit = (r: number, c: number) => {
    const dr = displayRows[r]
    if (!dr || !canEdit(dr, c)) return
    const v = valueOf(dr, c)
    const text = v === null || v === undefined ? '' : String(v)
    setSel({ r, c })
    setEditing({ r, c, text, initial: text })
  }
  const commitEdit = () => {
    const cur = editingRef.current
    if (!cur) return
    const { r, c, text, initial } = cur
    setEditing(null)
    if (text !== initial) setCell(displayRows[r], c, text)
    scrollRef.current?.focus()
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const offsets = useMemo(() => {
    const o = [ROWNUM_W]
    for (const w of widths) o.push(o[o.length - 1] + w)
    return o
  }, [widths])
  const totalWidth = offsets[offsets.length - 1]

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(displayRows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN)

  const startResize = (e: React.MouseEvent, col: number) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = widths[col]
    const move = (ev: MouseEvent) =>
      setWidths((w) => w.map((x, i) => (i === col ? Math.max(40, startW + ev.clientX - startX) : x)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const shown = (dr: DisplayRow, c: number): CellValue => valueOf(dr, c) ?? null
  const copyCell = () => sel && navigator.clipboard.writeText(toTsvValue(shown(displayRows[sel.r], sel.c)))
  const copyRow = () => sel && navigator.clipboard.writeText(rs.columns.map((_, c) => toTsvValue(shown(displayRows[sel.r], c))).join('\t'))
  const header = () => rs.columns.map((c) => toTsvValue(c.name)).join('\t')
  const rowTsv = (dr: DisplayRow) => rs.columns.map((_, c) => toTsvValue(shown(dr, c))).join('\t')
  /** Nazivi stupaca + retci točno kako su prikazani (sortirani, s neuspremljenim izmjenama); TSV za Excel. */
  const copyAll = async (withHeader: boolean): Promise<number> => {
    await navigator.clipboard.writeText([...(withHeader ? [header()] : []), ...displayRows.map(rowTsv)].join('\n'))
    return displayRows.length
  }
  const viewOf = (list: DisplayRow[]): ResultView => ({ columns: rs.columns, rows: list.map((dr) => rs.columns.map((_, c) => shown(dr, c))) })
  if (gridRef) gridRef.current = { copyAll: () => copyAll(true), view: () => viewOf(displayRows) }
  const copyInserts = (list: DisplayRow[]) => {
    if (!insert) return
    const sql = toInserts(viewOf(list), insert.dialect, insert.table(), (n) => ident(insert.dialect, n))
    void navigator.clipboard.writeText(sql)
  }

  const move = (r: number, c: number) => {
    const nr = Math.max(0, Math.min(displayRows.length - 1, r))
    const nc = Math.max(0, Math.min(rs.columns.length - 1, c))
    setSel({ r: nr, c: nc })
    const el = scrollRef.current!
    const top = nr * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H * 2 > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H * 2 - el.clientHeight
    const left = offsets[nc] - ROWNUM_W
    if (left < el.scrollLeft) el.scrollLeft = left
    else if (offsets[nc + 1] > el.scrollLeft + el.clientWidth) el.scrollLeft = offsets[nc + 1] - el.clientWidth
  }

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
      return
    }
    if (!sel || editing) return
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); copyCell() }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); void copyAll(true) }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); setPanel((p) => (p ? null : 'value')) }
    else if (edit && (e.key === 'F2' || e.key === 'Enter')) { e.preventDefault(); startEdit(sel.r, sel.c) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(sel.r + 1, sel.c) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(sel.r - 1, sel.c) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(sel.r, sel.c - 1) }
    else if (e.key === 'ArrowRight' || e.key === 'Tab') { e.preventDefault(); move(sel.r, sel.c + 1) }
    else if (e.key === 'PageDown') { e.preventDefault(); move(sel.r + Math.floor(height / ROW_H), sel.c) }
    else if (e.key === 'PageUp') { e.preventDefault(); move(sel.r - Math.floor(height / ROW_H), sel.c) }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); move(0, sel.c) }
    else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); move(displayRows.length - 1, sel.c) }
  }

  const menuFor = (dr: DisplayRow, i: number, j: number): MenuEntry[] => {
    const v = shown(dr, j)
    const items: MenuEntry[] = [
      { label: t('grid.copyCell'), shortcut: 'Ctrl+C', onClick: () => navigator.clipboard.writeText(toTsvValue(v)) },
      { label: t('grid.copyRow'), onClick: () => navigator.clipboard.writeText(rowTsv(dr)) },
      { label: t('grid.copyRowHeader'), onClick: () => navigator.clipboard.writeText(header() + '\n' + rowTsv(dr)) },
      { label: t('grid.copyAllHeader'), shortcut: 'Ctrl+A', onClick: () => void copyAll(true) },
      { label: t('grid.copyAllNoHeader'), onClick: () => void copyAll(false) },
      'separator',
      { label: t('grid.copyIn'), onClick: () => navigator.clipboard.writeText(inList(rows, j)) },
      ...(insert
        ? [
            { label: t('grid.copyRowInsert'), onClick: () => copyInserts([dr]) },
            { label: t('grid.copyAllInsert'), onClick: () => copyInserts(displayRows) }
          ]
        : []),
      'separator',
      ...(dr.ref === undefined
        ? []
        : v === null
          ? [
              { label: t('grid.filter', 'IS NULL'), onClick: () => addFilter({ col: j, op: 'null' }) },
              { label: t('grid.filter', 'IS NOT NULL'), onClick: () => addFilter({ col: j, op: 'notnull' }) }
            ]
          : [
              { label: t('grid.filter', '= ' + shortValue(v)), onClick: () => addFilter({ col: j, op: 'eq', value: v }) },
              { label: t('grid.filter', '≠ ' + shortValue(v)), onClick: () => addFilter({ col: j, op: 'ne', value: v }) },
              { label: t('grid.filter', 'IS NOT NULL'), onClick: () => addFilter({ col: j, op: 'notnull' }) }
            ]),
      { label: t('grid.clearAllFilters'), disabled: !isFiltered, onClick: clearFilters }
    ]
    if (!edit) return items
    const editable = canEdit(dr, j)
    items.push(
      'separator',
      { label: t('grid.editCell'), shortcut: 'F2', disabled: !editable, onClick: () => startEdit(i, j) },
      { label: t('grid.setNull'), disabled: !editable || v === null, onClick: () => setCell(dr, j, null) },
      {
        label: dr.ins !== undefined ? t('grid.revertDefault') : t('grid.revertOriginal'),
        disabled: !isChanged(dr, j),
        onClick: () => setCell(dr, j, undefined)
      },
      'separator',
      dr.ins !== undefined
        ? { label: t('grid.removeNewRow'), danger: true, onClick: () => toggleDelete(dr) }
        : isDeleted(dr)
          ? { label: t('grid.undoDelete'), onClick: () => toggleDelete(dr) }
          : { label: t('grid.deleteRow'), danger: true, onClick: () => toggleDelete(dr) },
      { label: t('grid.addRow'), onClick: addRow }
    )
    return items
  }

  const visibleRows = []
  for (let i = first; i < last; i++) {
    const dr = displayRows[i]
    const deleted = isDeleted(dr)
    visibleRows.push(
      <div
        key={dr.ins !== undefined ? 'n' + dr.ins : i}
        className={'grid-row' + (i % 2 ? ' odd' : '') + (deleted ? ' deleted' : '') + (dr.ins !== undefined ? ' inserted' : '')}
        style={{ top: i * ROW_H, width: totalWidth }}
      >
        <div className="grid-cell rownum" style={{ width: ROWNUM_W }}>
          {dr.ins !== undefined ? '+' : i + 1}
        </div>
        {rs.columns.map((_, j) => {
          const v = valueOf(dr, j)
          if (editing && editing.r === i && editing.c === j) {
            return (
              <input
                key={j}
                className="grid-input"
                style={{ left: offsets[j], width: Math.max(widths[j], 160) }}
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') { e.preventDefault(); commitEdit(); move(i + 1, j) }
                  else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); move(i, j + (e.shiftKey ? -1 : 1)) }
                  else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); scrollRef.current?.focus() }
                }}
              />
            )
          }
          return (
            <div
              key={j}
              className={
                'grid-cell' +
                (v === null ? ' null' : '') +
                (v === undefined ? ' default' : '') +
                (numericCols[j] ? ' num' : '') +
                (isChanged(dr, j) ? ' changed' : '') +
                (sel && sel.r === i && sel.c === j ? ' selected' : '')
              }
              style={{ left: offsets[j], width: widths[j] }}
              onMouseDown={() => setSel({ r: i, c: j })}
              onDoubleClick={() => startEdit(i, j)}
              onContextMenu={(e) => {
                setSel({ r: i, c: j })
                openMenu(e, menuFor(dr, i, j))
              }}
            >
              {v === undefined ? 'DEFAULT' : highlight(display(v), q)}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="grid-wrap">
      <div className="grid-filter">
        <Icon name="search" />
        <input
          ref={searchRef}
          value={quick}
          placeholder={t('grid.search')}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && quick) {
              e.preventDefault()
              e.stopPropagation()
              setQuick('')
            } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
              e.preventDefault()
              if (displayRows.length) setSel({ r: 0, c: sel?.c ?? 0 })
              scrollRef.current?.focus()
            }
          }}
        />
        {filters.map((f) => {
          const label = filterLabel(f, rs.columns[f.col]?.name ?? '?')
          return (
            <span key={f.col} className="filter-chip" title={label}>
              {label}
              <button onClick={() => setFilters((list) => list.filter((x) => x !== f))} title={t('grid.removeFilter')}>
                <Icon name="close" />
              </button>
            </span>
          )
        })}
        {isFiltered && (
          <>
            <span className="filter-count">
              {t('grid.filteredCount', num(rows.length), num(rs.rows.length))}
            </span>
            <button className="link-btn" onClick={clearFilters}>
              {t('grid.clearFilters')}
            </button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button
          className={'link-btn' + (panel === 'value' ? ' on' : '')}
          title={t('grid.valueTitle')}
          onClick={() => togglePanel('value')}
        >
          {t('value.value')}
        </button>
        <button
          className={'link-btn' + (panel === 'record' ? ' on' : '')}
          title={t('grid.recordTitle')}
          onClick={() => togglePanel('record')}
        >
          {t('value.row')}
        </button>
      </div>
    <div className="grid-split">
    <div className="grid" ref={scrollRef} tabIndex={0} onKeyDown={onKey} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div className="grid-header" style={{ width: totalWidth }}>
        <div className="grid-hcell rownum" style={{ width: ROWNUM_W }} onClick={() => copyRow()} />
        {rs.columns.map((c, j) => (
          <div
            key={j}
            className="grid-hcell"
            style={{ left: offsets[j], width: widths[j] }}
            title={(c.type ? `${c.name} (${c.type})` : c.name) + (edit && !edit.editable[j] ? ' — ' + t('grid.notEditable') : '')}
            onClick={() =>
              setSort((s) => (s?.col === j ? (s.dir === 1 ? { col: j, dir: -1 } : null) : { col: j, dir: 1 }))
            }
          >
            <span className="hname">{c.name}</span>
            {sort?.col === j && <span className="sort">{sort.dir === 1 ? '▲' : '▼'}</span>}
            <span className="resizer" onMouseDown={(e) => startResize(e, j)} onClick={(e) => e.stopPropagation()} />
          </div>
        ))}
      </div>
      <div className="grid-body" style={{ height: displayRows.length * ROW_H, width: totalWidth }}>
        {visibleRows}
      </div>
    </div>
    {panel && (
      <ValuePanel
        mode={panel}
        columns={rs.columns}
        row={sel && displayRows[sel.r] ? rs.columns.map((_, c) => shown(displayRows[sel.r], c)) : null}
        rowNumber={sel ? sel.r + 1 : 0}
        col={sel?.c ?? 0}
        onMode={setPanel}
        onSelectCol={(c) => {
          if (sel) setSel({ r: sel.r, c })
          setPanel('value')
        }}
        onClose={() => {
          setPanel(null)
          scrollRef.current?.focus()
        }}
      />
    )}
    </div>
    </div>
  )
})

function inList(rows: CellValue[][], col: number): string {
  const vals = Array.from(new Set(rows.map((r) => r[col]).filter((v) => v !== null)))
  return '(' + vals.map((v) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)).join(', ') + ')'
}
