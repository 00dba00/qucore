import type { StatementType, TableRef } from './sqlRefs.ts'
import { t } from '../shared/i18n.ts'

/** Pretraga spremljenih queryja: slobodan tekst + filteri project: table: type: db: ran: is:. */
export interface SavedSearch {
  /** Pojmovi slobodnog teksta (fraze u navodnicima ostaju cijele). */
  terms: string[]
  projects: string[]
  tables: TableRef[]
  types: StatementType[]
  dbs: string[]
  /** ran:<7d — pokrenut u zadnjih N dana. */
  ranWithinDays?: number
  /** ran:>30d — nije pokrenut N dana (ili nikad). */
  notRunForDays?: number
  pinned?: boolean
  /** is:broken — queryji čije tablice nisu pronađene pri zadnjoj provjeri sheme. */
  broken?: boolean
  /** Što nije prepoznato (prikazuje se ispod polja za pretragu). */
  problems: string[]
}

export const STATEMENT_TYPES: StatementType[] = ['select', 'insert', 'update', 'delete', 'merge', 'ddl', 'exec']

const KEYS = ['project', 'table', 'type', 'db', 'ran', 'is'] as const

/** Pomoć za pretragu (u trenutnom jeziku). */
export function searchHelp(): [string, string][] {
  return [
    ['project:AML', t('search.help.project')],
    ['table:alerts', t('search.help.table')],
    ['type:select', 'select, insert, update, delete, merge, ddl, exec'],
    ['db:core', t('search.help.db')],
    ['ran:<7d', t('search.help.ranRecent')],
    ['ran:>30d', t('search.help.ranOld')],
    ['is:pinned', t('search.help.pinned')],
    ['is:broken', t('search.help.broken')]
  ]
}

const UNIT_DAYS: Record<string, number> = { d: 1, w: 7, m: 30 }

export function parseSavedSearch(input: string): SavedSearch {
  const s: SavedSearch = { terms: [], projects: [], tables: [], types: [], dbs: [], problems: [] }
  const re = /([A-Za-z]+):(?:"([^"]*)"?|(\S*))|"([^"]*)"?|(\S+)/g
  for (let m = re.exec(input); m; m = re.exec(input)) {
    const [, rawKey, quotedVal, plainVal, phrase, word] = m
    if (phrase !== undefined) {
      if (phrase.trim()) s.terms.push(phrase.trim())
      continue
    }
    if (word !== undefined) {
      s.terms.push(word)
      continue
    }
    const key = rawKey.toLowerCase()
    const value = (quotedVal ?? plainVal ?? '').trim()
    if (!(KEYS as readonly string[]).includes(key)) {
      // Nije filter (npr. "http://…" ili "a:b") — ostaje tekst, uz napomenu.
      s.terms.push(m[0])
      s.problems.push(t('search.unknownFilter', rawKey))
      continue
    }
    if (!value) {
      s.problems.push(t('search.emptyFilter', key))
      continue
    }
    const v = value.toLowerCase()
    switch (key) {
      case 'project':
        s.projects.push(value)
        break
      case 'table': {
        const dot = v.lastIndexOf('.')
        s.tables.push(dot > 0 ? { schema: v.slice(0, dot), table: v.slice(dot + 1) } : { table: v })
        break
      }
      case 'type':
        if ((STATEMENT_TYPES as string[]).includes(v)) s.types.push(v as StatementType)
        else s.problems.push(t('search.badType', value, STATEMENT_TYPES.join(', ')))
        break
      case 'db':
        s.dbs.push(v)
        break
      case 'ran': {
        const r = /^([<>])(\d+)([dwm]?)$/.exec(v)
        if (!r) {
          s.problems.push(t('search.badRan', value))
          break
        }
        const days = Number(r[2]) * UNIT_DAYS[r[3] || 'd']
        if (r[1] === '<') s.ranWithinDays = days
        else s.notRunForDays = days
        break
      }
      case 'is':
        if (v === 'pinned') s.pinned = true
        else if (v === 'broken') s.broken = true
        else s.problems.push(t('search.badIs', value))
        break
    }
  }
  return s
}
