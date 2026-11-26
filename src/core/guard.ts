import { tokenize, type FingerprintDialect, type Token } from './tokenize.ts'

/** Naredba koja mijenja sve retke tablice. */
export interface UnboundedWrite {
  kind: 'update' | 'delete' | 'truncate'
  /** Tablica (kako je napisana u SQL-u), ako se da pročitati. */
  table?: string
  /** Početak naredbe iz izvornog SQL-a (za prikaz). */
  snippet: string
}

/** Dijeli tokene na naredbe: ';' i (SQL Server) GO. */
function statements(tokens: Token[], dialect: FingerprintDialect): Token[][] {
  const out: Token[][] = []
  let cur: Token[] = []
  for (const t of tokens) {
    if (t.text === ';' || (dialect === 'mssql' && t.kind === 'word' && t.text === 'go')) {
      if (cur.length) out.push(cur)
      cur = []
    } else cur.push(t)
  }
  if (cur.length) out.push(cur)
  return out
}

const word = (t: Token | undefined) => (t?.kind === 'word' ? t.text : '')

/** Naziv iza pozicije k (riječ ili identifikator u navodnicima, s točkama). */
function nameAt(sql: string, tokens: Token[], k: number): string | undefined {
  const first = tokens[k]
  if (!first || (first.kind !== 'word' && first.kind !== 'quoted')) return undefined
  let e = k
  while (tokens[e + 1]?.text === '.' && (tokens[e + 2]?.kind === 'word' || tokens[e + 2]?.kind === 'quoted')) e += 2
  return sql.slice(first.start, tokens[e].end)
}

/**
 * UPDATE/DELETE bez WHERE na vrhu naredbe (WHERE u podupitu ne vrijedi) i TRUNCATE.
 * Heuristika nad tokenima: dovoljna za upozorenje prije izvršavanja, ne za odluku o sigurnosti.
 */
export function findUnboundedWrites(sql: string, dialect: FingerprintDialect = 'generic'): UnboundedWrite[] {
  const out: UnboundedWrite[] = []
  for (const st of statements(tokenize(sql, dialect), dialect)) {
    // Preskoči WITH ... AS (...) [, x AS (...)] do glavne naredbe.
    let k = 0
    if (word(st[0]) === 'with') {
      let depth = 0
      for (k = 1; k < st.length; k++) {
        if (st[k].text === '(') depth++
        else if (st[k].text === ')') depth--
        else if (depth === 0 && ['select', 'update', 'delete', 'insert', 'merge'].includes(word(st[k]))) break
      }
    }
    const head = word(st[k])
    if (head !== 'update' && head !== 'delete' && head !== 'truncate') continue
    const snippet = sql.slice(st[k].start, st[Math.min(st.length - 1, k + 12)].end).replace(/\s+/g, ' ')

    if (head === 'truncate') {
      const t = word(st[k + 1]) === 'table' ? k + 2 : k + 1
      out.push({ kind: 'truncate', table: nameAt(sql, st, t), snippet })
      continue
    }
    // WHERE na vrhu naredbe (dubina zagrada 0); WHERE CURRENT OF također ograničava.
    let depth = 0
    let hasWhere = false
    for (let m = k + 1; m < st.length; m++) {
      if (st[m].text === '(') depth++
      else if (st[m].text === ')') depth--
      else if (depth === 0 && word(st[m]) === 'where') {
        hasWhere = true
        break
      }
    }
    if (hasWhere) continue
    let t = k + 1
    if (head === 'delete') {
      if (word(st[t]) === 'top') t += st[t + 1]?.text === '(' ? 4 : 2
      if (word(st[t]) === 'from') t++
    } else {
      while (['low_priority', 'ignore', 'only', 'top'].includes(word(st[t]))) t++
    }
    out.push({ kind: head, table: nameAt(sql, st, t), snippet })
  }
  return out
}
