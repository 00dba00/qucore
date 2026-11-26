// Vite plugin: korisnički vodič (docs/guide/README.md i README.en.md) kao modul 'virtual:guide' za renderer.
// Markdown se pretvara u HTML pri buildu (marked je samo devDependency), slike idu u bundle kao obični asseti.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Marked, type Tokens } from 'marked'
import type { Plugin } from 'vite'

const VIRTUAL = 'virtual:guide'
const RESOLVED = '\0' + VIRTUAL

/** GitHub stil sidra: mala slova, bez interpunkcije, razmaci u '-'. Tako rade linkovi iz sadržaja vodiča. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-')
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Jedan Markdown vodič → HTML s placeholderima slika i popis lokalnih slika (relativno na mapu vodiča). */
function renderGuide(mdPath: string): { html: string; images: string[] } {
  const images: string[] = []
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Heading) {
        return `<h${t.depth} id="${escapeAttr(slug(t.text))}">${this.parser.parseInline(t.tokens)}</h${t.depth}>\n`
      },
      image(t: Tokens.Image) {
        // Lokalne slike: placeholder koji komponenta zamijeni URL-om asseta.
        if (!/^https?:/.test(t.href)) {
          images.push(t.href)
          return `<img src="__GUIDE_IMG__${escapeAttr(t.href)}__" alt="${escapeAttr(t.text)}" loading="lazy">`
        }
        return `<img src="${escapeAttr(t.href)}" alt="${escapeAttr(t.text)}">`
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Link) {
        const inner = this.parser.parseInline(t.tokens)
        const external = /^https?:/.test(t.href)
        return `<a href="${escapeAttr(t.href)}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${inner}</a>`
      }
    }
  })
  return { html: marked.parse(readFileSync(mdPath, 'utf8'), { async: false }) as string, images }
}

/**
 * Vodiči po jeziku, npr. { hr: 'docs/guide/README.md', en: 'docs/guide/README.en.md' }.
 * Modul izvozi guides[lang] = { html, images }; jezik čiji Markdown ne postoji izostaje (aplikacija tada prikaže hrvatski).
 */
export function guidePlugin(mdPaths: Record<string, string>): Plugin {
  return {
    name: 'qucore-guide',
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : undefined
    },
    load(id) {
      if (id !== RESOLVED) return undefined
      const imports: string[] = []
      const entries: string[] = []
      for (const [lang, mdPath] of Object.entries(mdPaths)) {
        this.addWatchFile(mdPath)
        if (!existsSync(mdPath)) continue
        const dir = dirname(mdPath)
        const { html, images } = renderGuide(mdPath)
        // Slika koje još nema (npr. nova snimka prije pokretanja guide-shots) ne ruši build: samo upozorenje.
        const unique = [...new Set(images)].filter((src) => {
          if (existsSync(resolve(dir, src))) return true
          this.warn(`Vodič (${lang}): slika ${src} ne postoji (pokreni scripts/guide-shots.mjs).`)
          return false
        })
        const map = unique.map((src) => {
          const file = resolve(dir, src).replace(/\\/g, '/')
          this.addWatchFile(file)
          const name = `i${imports.length}`
          imports.push(`import ${name} from ${JSON.stringify(file)}`)
          return `${JSON.stringify(src)}: ${name}`
        })
        entries.push(`${JSON.stringify(lang)}: { html: ${JSON.stringify(html)}, images: { ${map.join(', ')} } }`)
      }
      return `${imports.join('\n')}\nexport const guides = { ${entries.join(', ')} }\n`
    }
  }
}
