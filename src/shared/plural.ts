/** Oblik riječi za broj (hrvatski: 1 redak, 2 retka, 5 redaka; engleski: 1 row, 2 rows). */
export function plural(n: number, forms: { one: string; few?: string; other: string }, lang: 'en' | 'hr'): string {
  const cat = new Intl.PluralRules(lang).select(n)
  if (cat === 'one') return forms.one
  if (cat === 'few') return forms.few ?? forms.other
  return forms.other
}
