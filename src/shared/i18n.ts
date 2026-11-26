import { en, type Messages } from './locales/en.ts'
import { hr } from './locales/hr.ts'
import { plural as pluralFor } from './plural.ts'

/**
 * Prijevodi za UI, main proces i core (greške koje korisnik vidi).
 * Poruke su u src/shared/locales/<jezik>.ts; engleski je izvor i određuje ključeve i argumente,
 * pa typecheck javlja svaki ključ koji nedostaje u drugom jeziku.
 */
export type Lang = 'en' | 'hr'

export const LANGUAGES: { id: Lang; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'hr', name: 'Hrvatski' }
]

const CATALOGS: Record<Lang, Messages> = { en, hr }

let lang: Lang = 'en'

export function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'hr'
}

export function setLang(l: Lang): void {
  if (isLang(l)) lang = l
}

export function getLang(): Lang {
  return lang
}

/** BCP 47 oznaka za brojeve, datume i sortiranje. */
export function locale(): string {
  return lang === 'hr' ? 'hr-HR' : 'en-US'
}

export type MsgKey = keyof Messages
type Args<K extends MsgKey> = Messages[K] extends (...a: infer A) => string ? A : []

export function t<K extends MsgKey>(key: K, ...args: Args<K>): string {
  const m = (CATALOGS[lang][key] ?? en[key]) as string | ((...a: unknown[]) => string)
  return typeof m === 'function' ? m(...args) : m
}

/** Broj u formatu trenutnog jezika. */
export function num(n: number, options?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(locale(), options)
}

/** Usporedba teksta za sortiranje po pravilima trenutnog jezika. */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, locale())
}

/** Oblik riječi za broj u trenutnom jeziku. */
export function plural(n: number, forms: { one: string; few?: string; other: string }): string {
  return pluralFor(n, forms, lang)
}
