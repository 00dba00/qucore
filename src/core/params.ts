import type { ParamValue } from '../shared/types.ts'
import { tokenize, type FingerprintDialect } from './tokenize.ts'
import { t } from '../shared/i18n.ts'

/** Jedno pojavljivanje varijable u SQL-u: :name ili ${name}. */
export interface ParamOccurrence {
  /** Naziv malim slovima (varijable ne razlikuju velika i mala slova). */
  name: string
  /** Kako je napisana, npr. ":customer_id" ili "${date_from}". */
  display: string
  start: number
  end: number
}

const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

/**
 * Varijable u SQL-u. Nikad u stringovima i komentarima (tokenizer ih preskače), ni u ::castu, := dodjeli,
 * @varijablama, $1 parametrima ni u PostgreSQL rasponu polja arr[1:2].
 */
export function findParams(sql: string, dialect: FingerprintDialect = 'generic'): ParamOccurrence[] {
  const tokens = tokenize(sql, dialect)
  const out: ParamOccurrence[] = []
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t.kind === 'param' && t.text.startsWith(':') && NAME.test(t.text.slice(1))) {
      out.push({ name: t.text.slice(1), display: sql.slice(t.start, t.end), start: t.start!, end: t.end! })
      continue
    }
    // ${name}: četiri tokena jedan do drugog
    const [b, w, c] = [tokens[k + 1], tokens[k + 2], tokens[k + 3]]
    if (
      t.kind === 'punct' && t.text === '$' && b?.text === '{' && w?.kind === 'word' && c?.text === '}' &&
      b.start === t.end && w.start === b.end && c.start === w.end && NAME.test(w.text)
    ) {
      out.push({ name: w.text, display: sql.slice(t.start, c.end), start: t.start!, end: c.end! })
      k += 3
    }
  }
  return out
}

/** Nazivi varijabli redom prvog pojavljivanja, bez ponavljanja. */
export function paramNames(sql: string, dialect: FingerprintDialect = 'generic'): string[] {
  return [...new Set(findParams(sql, dialect).map((p) => p.name))]
}

/** Tip koji 'auto' daje vrijednosti: broj ako se da pročitati kao broj, inače tekst. */
export function resolvedType(v: ParamValue): Exclude<ParamValue['type'], 'auto'> {
  if (v.type !== 'auto') return v.type
  return NUMBER.test(v.value.trim()) ? 'number' : 'text'
}

/** SQL literal za vrijednost varijable, s escapeom po dijalektu. Baca grešku s porukom za korisnika. */
export function paramLiteral(name: string, v: ParamValue, dialect: FingerprintDialect = 'generic'): string {
  switch (resolvedType(v)) {
    case 'null':
      return 'NULL'
    case 'number': {
      const n = v.value.trim()
      if (!NUMBER.test(n)) throw new Error(t('core.paramNotNumber', name, v.value))
      return n
    }
    case 'raw':
      if (!v.value.trim()) throw new Error(t('core.paramSqlEmpty', name))
      return v.value
    case 'text': {
      let s = v.value
      // MariaDB/MySQL (bez NO_BACKSLASH_ESCAPES) tumači \ u stringu kao escape.
      if (dialect === 'mariadb') s = s.replace(/\\/g, '\\\\')
      s = s.replace(/'/g, "''")
      // N'' samo za ne-ASCII: nvarchar literal na varchar koloni ruši korištenje indeksa.
      const prefix = dialect === 'mssql' && /[^\x00-\x7f]/.test(s) ? 'N' : ''
      return `${prefix}'${s}'`
    }
  }
}

/** SQL s varijablama zamijenjenima literalima. Varijabla bez vrijednosti je greška. */
export function substituteParams(sql: string, dialect: FingerprintDialect, values: Record<string, ParamValue>): string {
  const occ = findParams(sql, dialect)
  let out = sql
  for (let k = occ.length - 1; k >= 0; k--) {
    const p = occ[k]
    const v = values[p.name]
    if (!v) throw new Error(t('core.paramMissing', p.display))
    out = out.slice(0, p.start) + paramLiteral(p.name, v, dialect) + out.slice(p.end)
  }
  return out
}
