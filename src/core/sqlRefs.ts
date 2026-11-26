import { tokenize, type FingerprintDialect, type Token } from './tokenize.ts'

export interface TableRef {
  /** Shema (ili baza kod MariaDB) ako je navedena; malim slovima, bez navodnika. */
  schema?: string
  table: string
}

export type StatementType = 'select' | 'insert' | 'update' | 'delete' | 'merge' | 'ddl' | 'exec'

export interface SqlAnalysis {
  tables: TableRef[]
  /** select samo ako ništa ne piše. */
  types: StatementType[]
}

/** Riječi iza kojih slijedi naziv tablice (ili popis odvojen zarezima kod FROM). */
const BEFORE_TABLE = new Set(['from', 'join', 'update', 'into', 'table', 'using'])
/** Riječi koje se preskaču između ključne riječi i naziva tablice. */
const SKIP = new Set(['only', 'if', 'exists', 'not', 'lateral', 'temporary', 'temp', 'unlogged'])
/** Nazivi koji nisu tablice. */
const NOT_TABLES = new Set(['dual', 'select', 'values', 'set', 'where', 'on', 'as', 'with', 'default'])
/** Ključne riječi koje ne mogu biti alias tablice (kraj FROM stavke). */
const CLAUSE = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'join', 'inner', 'left', 'right', 'full', 'cross', 'outer',
  'on', 'using', 'union', 'except', 'intersect', 'set', 'values', 'select', 'output', 'returning', 'window', 'for',
  'option', 'natural', 'straight_join', 'apply', 'pivot', 'unpivot', 'tablesample', 'go', 'when', 'into', 'fetch', 'with'
])

function unquote(t: Token): string {
  if (t.kind !== 'quoted') return t.text
  const q = t.text[0]
  const body = q === '[' ? t.text.slice(1, -1).replace(/]]/g, ']') : t.text.slice(1, -1).split(q + q).join(q)
  return body.toLowerCase()
}

const isName = (t: Token | undefined) => !!t && (t.kind === 'word' || t.kind === 'quoted')

/**
 * Tablice koje SQL koristi i vrste naredbi. Heuristika nad tokenima (bez parsera), dovoljno dobra za
 * pretragu "svi queryji koji diraju transactions": podupiti, funkcije, CTE nazivi i DUAL se preskaču.
 */
export function analyzeSql(sql: string, dialect: FingerprintDialect = 'generic'): SqlAnalysis {
  const tokens = tokenize(sql, dialect)
  const found = new Map<string, TableRef>()
  const cte = new Set<string>()
  const kinds = new Set<StatementType>()
  const word = (k: number) => (tokens[k]?.kind === 'word' ? tokens[k].text : '')

  // Je li token unutar zagrade izraza (npr. EXTRACT(YEAR FROM d), TRIM(x FROM y)), a ne podupita?
  const inExpr: boolean[] = new Array(tokens.length)
  const stack: boolean[] = []
  for (let k = 0; k < tokens.length; k++) {
    inExpr[k] = stack.length > 0 && stack[stack.length - 1]
    if (tokens[k].text === '(') stack.push(!['select', 'with', 'values'].includes(word(k + 1)))
    else if (tokens[k].text === ')') stack.pop()
  }

  // CTE nazivi: WITH [RECURSIVE] x [(kolone)] AS (, y AS (
  for (let k = 0; k < tokens.length; k++) {
    if (word(k) !== 'with') continue
    let m = k + 1
    if (word(m) === 'recursive') m++
    while (isName(tokens[m])) {
      const name = unquote(tokens[m])
      let a = m + 1
      if (tokens[a]?.text === '(') a = skipParens(tokens, a)
      if (word(a) !== 'as') break
      cte.add(name)
      a++
      if (word(a) === 'not' || word(a) === 'materialized') a += word(a) === 'not' ? 2 : 1
      if (tokens[a]?.text !== '(') break
      a = skipParens(tokens, a)
      if (tokens[a]?.text !== ',') break
      m = a + 1
    }
  }

  /**
   * Čita kvalificirani naziv od pozicije k; vraća naziv i poziciju iza njega (ili null).
   * fromLike: iza FROM/JOIN/USING naziv s '(' je tablična funkcija; iza INTO/TABLE/UPDATE to su kolone.
   */
  const readName = (k: number, fromLike: boolean): { ref: TableRef; end: number } | null => {
    // SQL Server temp tablica: # + riječ
    if (tokens[k]?.text === '#' && tokens[k + 1]?.kind === 'word') {
      return { ref: { table: '#' + tokens[k + 1].text }, end: k + 2 }
    }
    if (!isName(tokens[k])) return null
    const parts = [unquote(tokens[k])]
    let e = k + 1
    while (tokens[e]?.text === '.' && (isName(tokens[e + 1]) || tokens[e + 1]?.text === '.')) {
      // db..tablica (SQL Server, zadana shema)
      if (tokens[e + 1]?.text === '.') {
        parts.push('')
        e += 1
        continue
      }
      parts.push(unquote(tokens[e + 1]))
      e += 2
    }
    // Funkcija (tablična) ili poziv, ne tablica.
    if (fromLike && tokens[e]?.text === '(') return null
    const table = parts[parts.length - 1]
    if (!table || (tokens[k].kind === 'word' && parts.length === 1 && NOT_TABLES.has(table))) return null
    const schema = parts.length > 1 ? parts[parts.length - 2] || undefined : undefined
    return { ref: schema ? { schema, table } : { table }, end: e }
  }

  const add = (ref: TableRef) => {
    if (!ref.schema && cte.has(ref.table)) return
    found.set(`${ref.schema ?? ''}.${ref.table}`, ref)
  }

  /** Preskače alias iza naziva tablice: [AS] alias. */
  const skipAlias = (k: number): number => {
    if (word(k) === 'as') return k + 2
    if (isName(tokens[k]) && !(tokens[k].kind === 'word' && CLAUSE.has(tokens[k].text))) return k + 1
    return k
  }

  for (let k = 0; k < tokens.length; k++) {
    const w = word(k)
    if (!w) continue
    const prev = word(k - 1)

    switch (w) {
      case 'select':
        kinds.add('select')
        break
      case 'insert':
        kinds.add('insert')
        break
      case 'update':
        // ON UPDATE (FK pravila), FOR UPDATE (zaključavanje) nisu naredbe.
        if (prev !== 'on' && prev !== 'for' && prev !== 'key') kinds.add('update')
        break
      case 'delete':
        if (prev !== 'on') kinds.add('delete')
        break
      case 'merge':
        kinds.add('merge')
        break
      case 'create':
      case 'alter':
      case 'drop':
      case 'truncate':
      case 'rename':
        kinds.add('ddl')
        break
      case 'exec':
      case 'execute':
      case 'call':
        kinds.add('exec')
        break
    }

    let start = -1
    // FROM u izrazu (EXTRACT, TRIM, SUBSTRING) i IS DISTINCT FROM nisu tablice.
    if (w === 'from' && (inExpr[k] || prev === 'distinct')) continue
    if (BEFORE_TABLE.has(w)) {
      // UPDATE je naredba samo na početku, ne u ON UPDATE / FOR UPDATE; INTO OUTFILE nije tablica.
      if (w === 'update' && (prev === 'on' || prev === 'for' || prev === 'key')) continue
      if (w === 'table' && !['create', 'alter', 'drop', 'truncate', 'lock', 'temporary', 'temp', 'unlogged', 'global', 'local'].includes(prev)) continue
      if (w === 'using' && !tokens.slice(Math.max(0, k - 40), k).some((t) => t.kind === 'word' && t.text === 'merge')) continue
      start = k + 1
    } else if ((w === 'delete' || w === 'merge') && prev !== 'on' && word(k + 1) !== 'from' && word(k + 1) !== 'into') {
      start = k + 1 // SQL Server: DELETE t / MERGE t
      if (word(start) === 'top') continue
    } else if (w === 'on' && tokens.slice(Math.max(0, k - 12), k).some((t) => t.kind === 'word' && t.text === 'index')) {
      start = k + 1 // CREATE INDEX i ON t
    } else continue

    while (SKIP.has(word(start))) start++
    const fromLike = w === 'from' || w === 'join' || w === 'using'
    let r = readName(start, fromLike)
    // FROM a, b, c (stari zarez-join) — samo iza FROM
    while (r) {
      add(r.ref)
      if (w !== 'from') break
      const after = skipAlias(r.end)
      if (tokens[after]?.text !== ',') break
      r = readName(after + 1, true)
    }
  }

  const writes = ['insert', 'update', 'delete', 'merge', 'ddl'] as const
  if (writes.some((x) => kinds.has(x))) kinds.delete('select')
  return { tables: [...found.values()], types: [...kinds] }
}

/** Pozicija iza zagrade koja se zatvara za '(' na poziciji k. */
function skipParens(tokens: Token[], k: number): number {
  let depth = 0
  for (let m = k; m < tokens.length; m++) {
    if (tokens[m].text === '(') depth++
    else if (tokens[m].text === ')' && --depth === 0) return m + 1
  }
  return tokens.length
}
