import { tokenize, type FingerprintDialect, type Token } from './tokenize.ts'

export interface StatementRange {
  /** Položaj u izvornom SQL-u: [start, end), uključuje završni ';'. */
  start: number
  end: number
  text: string
}

const BLANK_LINE = /\n[ \t\r]*\n/
const GO_LINE = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*(?:--.*)?$/i
const DELIMITER_LINE = /^[ \t]*DELIMITER[ \t]+\S+[ \t]*$/i
const DELIMITER_RESET = /^[ \t]*DELIMITER[ \t]+;[ \t]*$/im
/** Riječi iza END (MariaDB: END IF, END LOOP, END CASE...). */
const END_SUFFIX = new Set(['if', 'loop', 'while', 'repeat', 'case'])
/** BEGIN iza kojeg slijedi ovo je početak transakcije, ne blok. */
const BEGIN_TX = new Set(['tran', 'transaction', 'work', ';', 'distributed', 'isolation'])

/** Redak u kojem je pozicija pos. */
function lineAt(sql: string, pos: number): string {
  const s = sql.lastIndexOf('\n', pos - 1) + 1
  const e = sql.indexOf('\n', pos)
  return sql.slice(s, e < 0 ? sql.length : e)
}

/**
 * Dijeli skriptu na naredbe kao DBeaver: ';', prazan redak i (SQL Server) GO.
 * Unutar BEGIN…END / CASE…END i u SQL Server CREATE/ALTER PROCEDURE/FUNCTION/TRIGGER/VIEW
 * (do GO) ';' i prazni retci ne dijele. MariaDB blok od `DELIMITER x` do `DELIMITER ;` je jedna
 * naredba (driver ga sam dijeli). Komentari ispred naredbe nisu dio nje.
 */
export interface SplitOptions {
  /** Prazan redak završava naredbu (zadano da). */
  blankLines?: boolean
}

export function splitStatements(sql: string, dialect: FingerprintDialect = 'generic', opts: SplitOptions = {}): StatementRange[] {
  const blankLines = opts.blankLines !== false
  const tokens = tokenize(sql, dialect)
  const out: StatementRange[] = []
  let first = -1
  let last = -1
  let depth = 0
  let module = false
  const flush = () => {
    if (first >= 0) {
      const start = tokens[first].start!
      const end = tokens[last].end!
      out.push({ start, end, text: sql.slice(start, end) })
    }
    first = -1
    last = -1
    depth = 0
    module = false
  }
  const word = (t: Token | undefined) => (t && (t.kind === 'word' || t.kind === 'punct') ? t.text : '')

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    // GO u svom retku (SQL Server) je separator, ne dio naredbe.
    if (dialect === 'mssql' && t.kind === 'word' && t.text === 'go' && GO_LINE.test(lineAt(sql, t.start!))) {
      flush()
      if (tokens[k + 1]?.kind === 'literal' && lineAt(sql, tokens[k + 1].start!) === lineAt(sql, t.start!)) k++
      continue
    }
    // MariaDB: DELIMITER $$ … DELIMITER ; ide cijeli, uključujući oba retka.
    if (dialect === 'mariadb' && t.kind === 'word' && t.text === 'delimiter' && DELIMITER_LINE.test(lineAt(sql, t.start!))) {
      flush()
      const lineEnd = sql.indexOf('\n', t.start!)
      const reset = lineEnd < 0 ? null : DELIMITER_RESET.exec(sql.slice(lineEnd + 1))
      const end = reset ? lineEnd + 1 + reset.index + reset[0].length : sql.length
      const stop = t.start! + sql.slice(t.start!, end).trimEnd().length
      out.push({ start: t.start!, end: stop, text: sql.slice(t.start!, stop) })
      while (k + 1 < tokens.length && tokens[k + 1].start! < end) k++
      continue
    }
    // Prazan redak između tokena završava naredbu (osim unutar bloka).
    if (blankLines && first >= 0 && depth === 0 && !module && BLANK_LINE.test(sql.slice(tokens[k - 1].end!, t.start!))) flush()

    if (first < 0) {
      if (t.text === ';') continue
      first = k
      if (dialect === 'mssql' && (t.text === 'create' || t.text === 'alter')) {
        const head = tokens.slice(k + 1, k + 4).map(word)
        module = head.some((w) => ['procedure', 'proc', 'function', 'trigger', 'view'].includes(w))
      }
    }
    last = k

    if (t.kind === 'word') {
      if (t.text === 'begin' && !BEGIN_TX.has(word(tokens[k + 1]))) depth++
      else if (t.text === 'case') depth++
      else if (t.text === 'end' && depth > 0) {
        const suffix = word(tokens[k + 1])
        // END IF / END LOOP... zatvaraju blokove koje ne brojimo; END CASE zatvara CASE.
        if (suffix !== 'case' && END_SUFFIX.has(suffix)) last = ++k
        else {
          depth--
          if (suffix === 'case') last = ++k
        }
      }
    } else if (t.text === ';' && depth === 0 && !module) flush()
  }
  flush()
  return out
}

/**
 * Naredba na poziciji kursora. Kursor izvan naredbe: prethodna ako između nje i kursora nema
 * praznog retka, inače sljedeća pod istim uvjetom; inače undefined.
 */
export function statementAt(
  sql: string,
  offset: number,
  dialect: FingerprintDialect = 'generic',
  opts: SplitOptions = {}
): StatementRange | undefined {
  const list = splitStatements(sql, dialect, opts)
  const inside = list.find((s) => offset >= s.start && offset <= s.end)
  if (inside) return inside
  const prev = [...list].reverse().find((s) => s.end <= offset)
  if (prev && !BLANK_LINE.test(sql.slice(prev.end, offset))) return prev
  const next = list.find((s) => s.start >= offset)
  if (next && !BLANK_LINE.test(sql.slice(offset, next.start))) return next
  return undefined
}
