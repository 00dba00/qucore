// Modul koji pri buildu radi scripts/vite-guide-plugin.ts iz docs/guide/README.md (hr) i README.en.md (en).
declare module 'virtual:guide' {
  /** Po jeziku: HTML vodiča (lokalne slike su placeholderi __GUIDE_IMG__<putanja>__) i putanja slike → URL asseta. */
  export const guides: Partial<Record<string, { html: string; images: Record<string, string> }>>
}
