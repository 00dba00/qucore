import { format, type SqlLanguage } from 'sql-formatter'

/** Monaco jezik (vidi MONACO_LANGUAGE) → dijalekt sql-formattera. */
const DIALECT: Record<string, SqlLanguage> = {
  sql: 'transactsql',
  pgsql: 'postgresql',
  mysql: 'mariadb'
}

const GO_LINE = /^\s*GO(?:\s+\d+)?\s*(?:--.*)?$/i
const DELIMITER_LINE = /^\s*DELIMITER\s+(\S+)\s*$/i

function fmt(sql: string, language: SqlLanguage): string {
  return format(sql, { language, keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 })
}

/** T-SQL: GO nije SQL nego naredba klijenta — formatira se svaki batch zasebno, GO linije ostaju. */
function formatGoScript(text: string): string {
  const out: string[] = []
  let buf: string[] = []
  const flush = () => {
    const chunk = buf.join('\n')
    if (chunk.trim()) out.push(fmt(chunk, 'transactsql'))
    buf = []
  }
  for (const line of text.split(/\r?\n/)) {
    if (GO_LINE.test(line)) {
      flush()
      out.push(line.trim())
    } else buf.push(line)
  }
  flush()
  return out.join('\n')
}

/** MariaDB: DELIMITER (kao mysql CLI) — naredbe s vlastitim delimiterom formatiraju se jedna po jedna. */
function formatDelimiterScript(text: string): string {
  const out: string[] = []
  let delimiter = ';'
  let buf: string[] = []
  const flush = () => {
    const chunk = buf.join('\n')
    buf = []
    if (!chunk.trim()) return
    if (delimiter === ';') {
      out.push(fmt(chunk, 'mariadb'))
      return
    }
    for (const stmt of chunk.split(delimiter)) {
      if (stmt.trim()) out.push(fmt(stmt, 'mariadb').replace(/;\s*$/, '') + delimiter)
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const m = DELIMITER_LINE.exec(line)
    if (m) {
      flush()
      delimiter = m[1]
      out.push(`DELIMITER ${delimiter}`)
    } else buf.push(line)
  }
  flush()
  return out.join('\n')
}

/**
 * Formatira SQL za zadani Monaco jezik. Baca grešku ako tekst nije moguće parsirati —
 * pozivatelj tada ostavlja tekst nepromijenjen.
 */
export function formatSql(text: string, monacoLanguage: string): string {
  const language = DIALECT[monacoLanguage] ?? 'sql'
  if (language === 'transactsql' && text.split(/\r?\n/).some((l) => GO_LINE.test(l))) return formatGoScript(text)
  if (language === 'mariadb' && text.split(/\r?\n/).some((l) => DELIMITER_LINE.test(l))) return formatDelimiterScript(text)
  return fmt(text, language)
}
