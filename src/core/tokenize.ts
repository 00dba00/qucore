import type { DbType } from '../shared/types.ts'

/** Dijalekt za tokenizer i fingerprint; 'generic' kad konekcija više ne postoji. */
export type FingerprintDialect = DbType | 'generic'

export interface Token {
  /** word = ključna riječ ili identifikator (malim slovima); quoted = identifikator u navodnicima/zagradama (izvorni oblik). */
  kind: 'word' | 'quoted' | 'literal' | 'param' | 'punct'
  text: string
  /** Položaj u izvornom SQL-u: [start, end). */
  start?: number
  end?: number
}

const isWordStart = (c: string) => /[\p{L}_]/u.test(c)
const isWord = (c: string) => /[\p{L}\p{N}_$#@]/u.test(c)
const isDigit = (c: string) => c >= '0' && c <= '9'

/**
 * Tokenizer za fingerprint i analizu tablica. Nije parser: razumije komentare (izbacuje ih), stringove,
 * brojeve i identifikatore dovoljno da ih ne pomiješa. Literali (stringovi, brojevi) postaju '?'.
 */
export function tokenize(sql: string, dialect: FingerprintDialect = 'generic'): Token[] {
  const out: Token[] = []
  const n = sql.length
  let i = 0
  const maria = dialect === 'mariadb'
  const pg = dialect === 'postgres' || dialect === 'generic'

  /** Kraj stringa koji počinje navodnikom q na poziciji start; '' (i \' gdje vrijedi) ne završavaju string. */
  const skipQuoted = (start: number, q: string, backslash: boolean): number => {
    let j = start + 1
    while (j < n) {
      const c = sql[j]
      if (backslash && c === '\\') j += 2
      else if (c === q) {
        if (sql[j + 1] === q) j += 2
        else return j + 1
      } else j++
    }
    return n
  }

  // Svaki prolaz petlje doda najviše jedan token; njegov kraj je i na početku idućeg prolaza.
  let lastLen = 0
  let lastStart = 0
  const settle = () => {
    if (out.length > lastLen) {
      out[lastLen].start = lastStart
      out[lastLen].end = i
      lastLen = out.length
    }
  }

  while (i < n) {
    settle()
    lastStart = i
    const c = sql[i]
    const next = sql[i + 1]

    // Razmaci
    if (/\s/.test(c)) {
      i++
      continue
    }
    // Komentari
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (maria && c === '#') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      // PostgreSQL i SQL Server dopuštaju ugniježđene blok komentare.
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (!maria && sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      continue
    }
    // Stringovi s prefiksom: N'..' (SQL Server/MariaDB), E'..' (PostgreSQL, backslash escape), X'..'/B'..'
    if (/[nNeExXbB]/.test(c) && next === "'" && (i === 0 || !isWord(sql[i - 1]))) {
      i = skipQuoted(i + 1, "'", c === 'e' || c === 'E' || maria)
      out.push({ kind: 'literal', text: '?' })
      continue
    }
    if (c === "'") {
      i = skipQuoted(i, "'", maria)
      out.push({ kind: 'literal', text: '?' })
      continue
    }
    // MariaDB (bez ANSI_QUOTES): "..." je string. Drugdje je identifikator.
    if (c === '"') {
      const end = skipQuoted(i, '"', maria)
      out.push(maria ? { kind: 'literal', text: '?' } : { kind: 'quoted', text: sql.slice(i, end) })
      i = end
      continue
    }
    // Identifikatori u navodnicima zadržavaju velika/mala slova.
    if (c === '`') {
      const end = skipQuoted(i, '`', false)
      out.push({ kind: 'quoted', text: sql.slice(i, end) })
      i = end
      continue
    }
    if (c === '[' && dialect !== 'postgres' && dialect !== 'mariadb') {
      const end = sql.indexOf(']', i)
      const stop = end < 0 ? n : end + 1
      out.push({ kind: 'quoted', text: sql.slice(i, stop) })
      i = stop
      continue
    }
    // PostgreSQL dollar-quoted string: $$...$$ ili $tag$...$tag$ (ne $1 parametar)
    if (pg && c === '$' && !isDigit(next ?? '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        i = end < 0 ? n : end + tag.length
        out.push({ kind: 'literal', text: '?' })
        continue
      }
    }
    // Brojevi: 12, 1.5, .5, 1e-3, 0x1F
    if (isDigit(c) || (c === '.' && isDigit(next ?? ''))) {
      if (i === 0 || !isWord(sql[i - 1])) {
        if (c === '0' && (next === 'x' || next === 'X')) {
          i += 2
          while (i < n && /[0-9a-fA-F]/.test(sql[i])) i++
        } else {
          while (i < n && (isDigit(sql[i]) || sql[i] === '.')) i++
          if (sql[i] === 'e' || sql[i] === 'E') {
            const k = sql[i + 1] === '+' || sql[i + 1] === '-' ? i + 2 : i + 1
            if (isDigit(sql[k] ?? '')) {
              i = k
              while (i < n && isDigit(sql[i])) i++
            }
          }
        }
        out.push({ kind: 'literal', text: '?' })
        continue
      }
    }
    // :: je PostgreSQL cast, ne parametar.
    if (c === ':' && next === ':') {
      out.push({ kind: 'punct', text: '::' })
      i += 2
      continue
    }
    // Riječi (ključne riječi, identifikatori) i parametri :x, @x, @@x, $1
    if (isWordStart(c) || ((c === ':' || c === '@' || c === '$') && next !== undefined && (isWord(next) || next === '@'))) {
      let j = i + 1
      while (j < n && (isWord(sql[j]) || (sql[j] === '@' && j === i + 1))) j++
      out.push({ kind: isWordStart(c) ? 'word' : 'param', text: sql.slice(i, j).toLowerCase() })
      i = j
      continue
    }
    // Interpunkcija i operatori, znak po znak
    out.push({ kind: 'punct', text: c })
    i++
  }
  settle()
  return out
}
