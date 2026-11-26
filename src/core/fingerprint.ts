import { createHash } from 'node:crypto'
import { tokenize, type FingerprintDialect } from './tokenize.ts'

export { tokenize, type FingerprintDialect, type Token } from './tokenize.ts'

export interface Fingerprint {
  /** Normalizirani SQL: bez komentara, literali kao ?, jedan razmak između tokena. */
  normalized: string
  /** Prvih 16 heksa znakova SHA-256 od normalized. */
  hash: string
}

/**
 * Normalizira SQL tako da isti upit s drugim vrijednostima daje isti rezultat:
 * `WHERE id = 5` i `where id=7 -- test` → `where id = ?`.
 */
export function normalizeSql(sql: string, dialect: FingerprintDialect = 'generic'): string {
  const out = tokenize(sql, dialect).map((t) => t.text)
  while (out.length && out[out.length - 1] === ';') out.pop()
  return out
    .join(' ')
    .replace(/\( \?(?: , \?)+ \)/g, '( ? )')
    .replace(/\( \? \)(?: , \( \? \))+/g, '( ? )')
}

export function fingerprintSql(sql: string, dialect: FingerprintDialect = 'generic'): Fingerprint {
  const normalized = normalizeSql(sql, dialect)
  return { normalized, hash: createHash('sha256').update(normalized).digest('hex').slice(0, 16) }
}
