import type { PlanNode, QueryPlan } from '../shared/types.ts'
import { t, type MsgKey } from '../shared/i18n.ts'

/*
 * Planovi izvršavanja triju baza u jedno stablo za prikaz.
 * Brojevi koje baza ne daje ostaju undefined (npr. SQL Server bez stvarnih redaka u procjeni).
 */

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

// ---------- PostgreSQL: EXPLAIN (FORMAT JSON [, ANALYZE]) ----------

interface PgNode {
  'Node Type': string
  'Relation Name'?: string
  Alias?: string
  'Index Name'?: string
  'Join Type'?: string
  'Strategy'?: string
  'Sort Key'?: string[]
  'Group Key'?: string[]
  'Filter'?: string
  'Index Cond'?: string
  'Hash Cond'?: string
  'Join Filter'?: string
  'Total Cost'?: number
  'Plan Rows'?: number
  'Actual Rows'?: number
  'Actual Loops'?: number
  'Actual Total Time'?: number
  Plans?: PgNode[]
}

function pgNode(n: PgNode): PlanNode {
  const label = [n['Join Type'] && n['Node Type'].includes('Join') ? `${n['Join Type']} ${n['Node Type']}` : n['Node Type'], n['Strategy'] && n['Node Type'] === 'Aggregate' ? `(${n['Strategy']})` : '']
    .filter(Boolean)
    .join(' ')
  const on = n['Relation Name'] ? `${n['Relation Name']}${n.Alias && n.Alias !== n['Relation Name'] ? ' ' + n.Alias : ''}` : ''
  const detail = [
    on && t('plan.on', on),
    n['Index Name'] && t('plan.index', n['Index Name']),
    n['Index Cond'] && t('plan.indexCond', n['Index Cond']),
    n['Hash Cond'] && t('plan.join', n['Hash Cond']),
    n['Join Filter'] && t('plan.join', n['Join Filter']),
    n['Filter'] && t('plan.filter', n['Filter']),
    n['Sort Key'] && t('plan.by', n['Sort Key'].join(', ')),
    n['Group Key'] && t('plan.groups', n['Group Key'].join(', '))
  ]
    .filter(Boolean)
    .join(' · ')
  const loops = n['Actual Loops'] ?? 1
  return {
    label,
    detail: detail || undefined,
    cost: n['Total Cost'],
    rows: n['Plan Rows'],
    actualRows: n['Actual Rows'] !== undefined ? n['Actual Rows'] * loops : undefined,
    timeMs: n['Actual Total Time'] !== undefined ? n['Actual Total Time'] * loops : undefined,
    children: (n.Plans ?? []).map(pgNode)
  }
}

export function pgPlan(json: unknown, raw: string): QueryPlan {
  const top = (Array.isArray(json) ? json[0] : json) as { Plan: PgNode; 'Execution Time'?: number; 'Planning Time'?: number }
  const root = pgNode(top.Plan)
  return { root, raw, analyzed: top['Execution Time'] !== undefined, totalMs: top['Execution Time'] }
}

// ---------- MariaDB / MySQL: EXPLAIN FORMAT=JSON (ANALYZE FORMAT=JSON) ----------

const LABEL_KEYS: Record<string, MsgKey | string> = {
  query_block: 'plan.query',
  nested_loop: 'Nested loop',
  ordering_operation: 'plan.op.ordering',
  grouping_operation: 'plan.op.grouping',
  duplicates_removal: 'plan.op.duplicates',
  filesort: 'plan.op.filesort',
  temporary_table: 'plan.op.temporary',
  read_sorted_file: 'plan.op.readSorted',
  union_result: 'UNION',
  materialized_from_subquery: 'plan.op.materialized',
  subqueries: 'plan.op.subqueries',
  attached_subqueries: 'plan.op.subqueries',
  block_nl_join: 'Block nested loop',
  'block-nl-join': 'Block nested loop join',
  window_functions_computation: 'plan.op.window'
}

/** Naziv operacije u trenutnom jeziku (ključevi s "plan." se prevode, ostalo su nazivi iz MariaDB-a). */
const LABELS = new Proxy({} as Record<string, string>, {
  get: (_, k: string) => {
    const v = LABEL_KEYS[k]
    return v === undefined ? undefined : v.startsWith('plan.') ? t(v as 'plan.query') : v
  },
  has: (_, k: string) => k in LABEL_KEYS
})

/** Rekurzivno: objekt s "table" je čvor tablice, ostali poznati ključevi su operacije s djecom. */
function mariaWalk(key: string, v: unknown): PlanNode[] {
  if (Array.isArray(v)) {
    const kids = v.flatMap((x) => mariaWalk('', x))
    return key && LABELS[key] ? [{ label: LABELS[key], children: kids }] : kids
  }
  if (!v || typeof v !== 'object') return []
  const o = v as Record<string, unknown>
  // npr. "Impossible WHERE" / "No tables used": plan bez tablica, samo poruka optimizatora.
  if (key === 'table' && o.table_name === undefined && typeof o.message === 'string') return [{ label: o.message, children: [] }]
  if (key === 'table' || (o.table_name !== undefined && o.access_type !== undefined)) {
    const cost = o.cost_info as Record<string, unknown> | undefined
    const detail = [
      o.access_type && t('plan.access', String(o.access_type)),
      o.key && t('plan.index', String(o.key)),
      o.possible_keys && !o.key && t('plan.possibleKeys', (o.possible_keys as string[]).join(', ')),
      o.attached_condition && t('plan.filter', String(o.attached_condition)),
      o.filtered !== undefined && t('plan.passes', String(o.filtered))
    ]
      .filter(Boolean)
      .join(' · ')
    const children = Object.entries(o).flatMap(([k, x]) => (k in LABELS ? mariaWalk(k, x) : []))
    return [
      {
        label: `${String(o.table_name ?? '?')}`,
        detail: detail || undefined,
        cost: num(o.cost) ?? num(cost?.prefix_cost) ?? num(cost?.read_cost),
        rows: num(o.rows) ?? num(o.rows_examined_per_scan),
        // r_rows je prosjek po petlji; vrijeme tablice = čitanje + ostalo (MariaDB 10.x/11.x).
        actualRows: num(o.r_rows) !== undefined ? num(o.r_rows)! * (num(o.r_loops) ?? 1) : undefined,
        timeMs:
          num(o.r_total_time_ms) ??
          (num(o.r_table_time_ms) !== undefined ? num(o.r_table_time_ms)! + (num(o.r_other_time_ms) ?? 0) : undefined),
        children
      }
    ]
  }
  const children = Object.entries(o).flatMap(([k, x]) => (k === 'table' ? mariaWalk('table', x) : k in LABELS || typeof x === 'object' ? mariaWalk(k, x) : []))
  if (key && LABELS[key]) {
    const cost = o.cost_info as Record<string, unknown> | undefined
    const label = key === 'query_block' && o.select_id !== undefined ? t('plan.queryN', String(o.select_id)) : LABELS[key]
    const detail =
      key === 'filesort' || key === 'ordering_operation'
        ? o.sort_key
          ? t('plan.by', String(o.sort_key))
          : undefined
        : o.attached_condition
          ? t('plan.condition', String(o.attached_condition))
          : undefined
    return [{ label, detail, cost: num(o.cost) ?? num(cost?.query_cost), timeMs: num(o.r_total_time_ms), children }]
  }
  return children
}

/**
 * MariaDB r_total_time_ms operacije (npr. filesort) je samo njezino vrijeme, a PostgreSQL vrijeme
 * uključuje djecu. Svodi se na PostgreSQL oblik (s djecom); korijen već ima ukupno vrijeme upita.
 */
function cumulateTime(n: PlanNode, root: boolean): number | undefined {
  const kids = n.children.map((c) => cumulateTime(c, false))
  const sum = kids.reduce((s: number, k) => s + (k ?? 0), 0)
  const any = kids.some((k) => k !== undefined)
  if (!root && n.timeMs !== undefined) n.timeMs += sum
  return n.timeMs ?? (any ? sum : undefined)
}

export function mariaPlan(json: unknown, raw: string): QueryPlan {
  const nodes = mariaWalk('', json)
  const root = nodes.length === 1 ? nodes[0] : { label: t('plan.query'), children: nodes }
  const analyzed = raw.includes('"r_rows"')
  if (analyzed) cumulateTime(root, true)
  return { root, raw, analyzed }
}

// ---------- SQL Server: SET SHOWPLAN_XML ON (procjena) ----------

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}

/** RelOp elementi u XML-u su ugniježđeni kao stablo operatora; Object daje tablicu i indeks. */
export function mssqlPlan(xml: string): QueryPlan {
  const root: PlanNode = { label: t('plan.query'), children: [] }
  const stack: PlanNode[] = [root]
  const named = new WeakSet<PlanNode>()
  for (const m of xml.matchAll(/<(\/?)(RelOp|Object)\b([^>]*?)(\/?)>/g)) {
    const [, close, name, body, selfClose] = m
    if (name === 'RelOp') {
      if (close) {
        if (stack.length > 1) stack.pop()
        continue
      }
      const a = attrs(body)
      const node: PlanNode = {
        label: a.PhysicalOp && a.LogicalOp && a.PhysicalOp !== a.LogicalOp ? `${a.PhysicalOp} (${a.LogicalOp})` : (a.PhysicalOp ?? a.LogicalOp ?? '?'),
        cost: num(a.EstimatedTotalSubtreeCost),
        rows: num(a.EstimateRows),
        children: []
      }
      stack[stack.length - 1].children.push(node)
      if (!selfClose) stack.push(node)
    } else if (!close) {
      // Prvi Object unutar operatora (prije djece) je tablica/indeks tog operatora.
      const top = stack[stack.length - 1]
      if (top !== root && !named.has(top) && top.children.length === 0) {
        const a = attrs(body)
        const clean = (s?: string) => s?.replace(/^\[|\]$/g, '')
        const table = [clean(a.Schema), clean(a.Table)].filter(Boolean).join('.')
        top.detail = [table && t('plan.on', `${table}${a.Alias ? ' ' + clean(a.Alias) : ''}`), a.Index && t('plan.index', clean(a.Index)!)].filter(Boolean).join(' · ') || undefined
        named.add(top)
      }
    }
  }
  const only = root.children.length === 1 ? root.children[0] : root
  return { root: only, raw: xml, analyzed: false }
}

/** Zbroj vrijednosti najbližih potomaka koji je imaju (MariaDB operacije između često nemaju trošak). */
function below(n: PlanNode, pick: (x: PlanNode) => number | undefined): number {
  return n.children.reduce((s, c) => s + (pick(c) ?? below(c, pick)), 0)
}

/** Vlastiti trošak čvora (bez potomaka) — za isticanje najskupljih koraka. */
export function selfCost(n: PlanNode): number | undefined {
  if (n.cost === undefined) return undefined
  return Math.max(0, n.cost - below(n, (x) => x.cost))
}

/** Vlastito vrijeme čvora (bez potomaka), samo uz ANALYZE. */
export function selfTime(n: PlanNode): number | undefined {
  if (n.timeMs === undefined) return undefined
  return Math.max(0, n.timeMs - below(n, (x) => x.timeMs))
}
