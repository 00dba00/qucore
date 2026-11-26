import { useSyncExternalStore } from 'react'
import { isLang, type Lang } from '../../shared/i18n'

/**
 * Korisničke postavke ponašanja s kompromisom (sigurnost ↔ brzina rada).
 * Zadane vrijednosti = ponašanje prije postavki; spremaju se u localStorage profila.
 */
export interface Settings {
  language: Lang
  autoCommitDefault: boolean
  autoCommitProd: boolean
  guardProd: boolean
  guardUnbounded: boolean
  guardWrongDb: boolean
  txWarnMinutes: number
  ctrlEnterScope: 'statement' | 'all'
  blankLineSplits: boolean
  restoreTabs: boolean
  defaultMaxRows: number
  suggestSave: boolean
  runWarnings: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'en',
  autoCommitDefault: true,
  autoCommitProd: true,
  guardProd: true,
  guardUnbounded: true,
  guardWrongDb: true,
  txWarnMinutes: 5,
  ctrlEnterScope: 'statement',
  blankLineSplits: true,
  restoreTabs: true,
  defaultMaxRows: 10000,
  suggestSave: true,
  runWarnings: true
}

export const MAX_ROWS_OPTIONS = [100, 1000, 10000, 100000]

const KEY = 'qucore.settings.v1'
const listeners = new Set<() => void>()
let current: Settings = load()

/**
 * Prvo pokretanje s jezikom: postojeći profil (već ima nešto u localStorageu) ostaje na hrvatskom, kakav je UI
 * bio dosad; novi profil uzima jezik sustava (hrvatski ako je sustav na hrvatskom, inače engleski).
 * Odluka se odmah sprema da se ne mijenja kasnije.
 */
function initialLanguage(): Lang {
  if (localStorage.length > 0) return 'hr'
  return /^hr(-|$)/i.test(navigator.language) ? 'hr' : 'en'
}

function load(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null
    // Nepoznati ključevi (starije/novije verzije) se ignoriraju, nedostajući dobivaju zadanu vrijednost.
    const out = { ...DEFAULT_SETTINGS }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        if (typeof v[k] === typeof DEFAULT_SETTINGS[k]) (out as Record<string, unknown>)[k] = v[k]
      }
    }
    if (!v || !isLang(v.language)) {
      out.language = initialLanguage()
      localStorage.setItem(KEY, JSON.stringify(out))
    }
    return out
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Trenutne postavke (za kod izvan Reacta i trenutak izvršavanja). */
export function getSettings(): Settings {
  return current
}

export function saveSettings(next: Settings): void {
  current = next
  localStorage.setItem(KEY, JSON.stringify(next))
  for (const l of listeners) l()
}

/** Postavke kao React stanje: svi tabovi se osvježe kad se promijene. */
export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
}
