import { Fragment, createElement, type ReactNode } from 'react'
import { getSettings } from './settings'
import { getLang, locale, setLang } from '../../shared/i18n'
import { api } from './api'

/**
 * Jezik se odabire jednom, pri pokretanju (promjena u Postavkama ponovno pokreće aplikaciju),
 * pa komponente mogu zvati t() izravno, bez React konteksta.
 */
const lang = getSettings().language
setLang(lang)
document.documentElement.lang = lang
void api.app.setLanguage(lang).catch(() => {})

export { t, num, plural, locale, compareText, getLang, LANGUAGES, type MsgKey } from '../../shared/i18n'

/**
 * Prijevod s React dijelovima: {0}, {1}… u tekstu zamjenjuju se zadanim elementima (npr. <b>naziv</b>),
 * pa redoslijed riječi ostaje stvar prijevoda.
 */
export function rich(text: string, ...parts: ReactNode[]): ReactNode {
  return createElement(Fragment, null, ...text.split(/\{(\d+)\}/).map((s, i) => (i % 2 ? parts[Number(s)] : s)))
}

/** Vrijeme (sati:minute) u formatu jezika. */
export function timeHM(d: Date): string {
  return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
}

/** Datum bez vremena: hr "26.11.2026." (bez godine "26.11."), en "Nov 26, 2026" / "Nov 26". */
export function dateDMY(d: Date, withYear = true): string {
  if (getLang() === 'hr') return `${d.getDate()}.${d.getMonth() + 1}.${withYear ? d.getFullYear() + '.' : ''}`
  return d.toLocaleDateString(locale(), withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' })
}
