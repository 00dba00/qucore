// Gradi web stranicu (site/dist) za GitHub Pages: početna, vodič po poglavljima (docs/guide/README.en.md), changelog.
//   npm run site:build              → site/dist (base /qucore/ za 00dba00.github.io/qucore)
//   npm run site:preview            → build + lokalni server na http://localhost:4173/qucore/
// SITE_BASE i SITE_URL mijenjaju putanju i adresu (npr. za vlastitu domenu: SITE_BASE=/ SITE_URL=https://qucore.io/).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Marked, type Tokens } from 'marked'
import { slug } from './vite-guide-plugin.ts'

const root = resolve(import.meta.dirname, '..')
const src = join(root, 'site', 'src')
const out = join(root, 'site', 'dist')
const base = process.env.SITE_BASE ?? '/qucore/'
const siteUrl = process.env.SITE_URL ?? 'https://00dba00.github.io/qucore/'
const GITHUB = 'https://github.com/00dba00/qucore'
const require = createRequire(import.meta.url)
const read = (p: string) => readFileSync(p, 'utf8')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function write(rel: string, content: string | Buffer): void {
  const file = join(out, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

// ---------- icons (Vectilume, outline) inline ----------
const iconDir = join(root, 'node_modules', '@vectilume', 'icons', 'outline')
function icon(id: string): string {
  const svg = read(join(iconDir, `${id}.svg`))
  return svg.replace('<svg', '<svg aria-hidden="true" focusable="false"').replace(/\s(width|height)="[^"]*"/g, '')
}

// ---------- layout ----------
const layout = read(join(src, 'layout.html'))
function page(opts: { title: string; description: string; content: string; bodyClass?: string; nav?: 'guide' | 'changelog' }): string {
  const vars: Record<string, string> = {
    title: esc(opts.title),
    description: esc(opts.description),
    bodyClass: opts.bodyClass ?? '',
    navGuide: opts.nav === 'guide' ? ' aria-current="page"' : '',
    navChangelog: opts.nav === 'changelog' ? ' aria-current="page"' : '',
    base,
    siteUrl
  }
  return layout
    .replace('{{content}}', opts.content)
    .replace(/\{\{icon:([a-z0-9-]+)\}\}/g, (_, id: string) => icon(id))
    .replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m)
}

// ---------- guide: one page per chapter ----------
interface Chapter {
  slug: string
  title: string
  md: string
}
const guideMd = read(join(root, 'docs', 'guide', 'README.en.md'))
const parts = guideMd.split(/^(?=## )/m)
const intro = parts.shift() ?? ''
const chapters: Chapter[] = parts
  .map((p) => {
    const title = p.match(/^## (.+)$/m)![1].trim()
    return { slug: slug(title), title, md: p.replace(/^## .+\n/, '') }
  })
  // Popis sadržaja iz Markdowna ne treba: poglavlja su lijevo i na početnoj stranici vodiča.
  .filter((c) => c.title !== 'Contents')
/** Svako sidro iz vodiča (poglavlje ili podnaslov) → stranica poglavlja na kojoj je. */
const anchorPage = new Map<string, string>()
for (const c of chapters) {
  anchorPage.set(c.slug, c.slug)
  for (const m of c.md.matchAll(/^#{3,6} (.+)$/gm)) anchorPage.set(slug(m[1].replace(/[*`]/g, '')), c.slug)
}
function guideHref(href: string): string {
  if (/^(https?:|mailto:)/.test(href)) return href
  if (href.startsWith('#')) {
    const a = decodeURIComponent(href.slice(1))
    const p = anchorPage.get(a)
    if (!p) return href
    return p === a ? `${base}guide/${p}/` : `${base}guide/${p}/#${a}`
  }
  return `${GITHUB}/blob/main/docs/guide/${href}`
}
function imgSrc(href: string): string {
  return /^https?:/.test(href) ? href : `${base}img/${href.replace(/^img\/(en\/)?/, '')}`
}
function markedFor(): Marked {
  return new Marked({
    gfm: true,
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Heading) {
        return `<h${t.depth} id="${esc(slug(t.text.replace(/[*`]/g, '')))}">${this.parser.parseInline(t.tokens)}</h${t.depth}>\n`
      },
      image(t: Tokens.Image) {
        return `<img src="${esc(imgSrc(t.href))}" alt="${esc(t.text)}" loading="lazy">`
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Link) {
        return `<a href="${esc(guideHref(t.href))}">${this.parser.parseInline(t.tokens)}</a>`
      }
    }
  })
}
const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim()
const guideNav = (current: string | null) => `
        <nav class="doc-nav" aria-label="Guide chapters">
          <label class="sr" for="guide-search">Search the guide</label>
          <input id="guide-search" class="doc-search" type="search" placeholder="Search the guide" autocomplete="off" />
          <p class="hits" aria-live="polite"></p>
          <ol>
${chapters.map((c) => `            <li data-slug="${c.slug}"><a href="${base}guide/${c.slug}/"${c.slug === current ? ' aria-current="page"' : ''}>${esc(c.title)}</a></li>`).join('\n')}
          </ol>
        </nav>`

function buildGuide(): void {
  const md = markedFor()
  const search: Record<string, string> = {}
  chapters.forEach((c, i) => {
    const body = md.parse(c.md, { async: false }) as string
    search[c.slug] = strip(body)
    const prev = chapters[i - 1]
    const next = chapters[i + 1]
    const pager = `
          <nav class="pager" aria-label="Chapters">
            ${prev ? `<a class="prev" href="${base}guide/${prev.slug}/"><span>Previous</span>${esc(prev.title)}</a>` : ''}
            ${next ? `<a class="next" href="${base}guide/${next.slug}/"><span>Next</span>${esc(next.title)}</a>` : ''}
          </nav>`
    const content = `
      <div class="doc">${guideNav(c.slug)}
        <article class="doc-body">
          <h1>${esc(c.title)}</h1>
${body}${pager}
        </article>
      </div>`
    const firstPara = strip(md.parse(c.md.split('\n\n').find((p) => p.trim() && !p.startsWith('#') && !p.startsWith('!')) ?? '', { async: false }) as string)
    write(`guide/${c.slug}/index.html`, page({ title: `${c.title.replace(/^\d+\.\s*/, '')} | QuCore guide`, description: firstPara.slice(0, 160), content, nav: 'guide', bodyClass: 'is-doc' }))
  })
  // Uvod bez naslova i popisa sadržaja (popis je lijevo).
  const introBody = md.parse(intro.replace(/^# .+\n/, '').replace(/^> \*\*Maintenance rule.*$/m, ''), { async: false }) as string
  const list = `<ol class="toc">${chapters.map((c) => `<li><a href="${base}guide/${c.slug}/">${esc(c.title.replace(/^\d+\.\s*/, ''))}</a></li>`).join('')}</ol>`
  write(
    'guide/index.html',
    page({
      title: 'User guide | QuCore',
      description: 'Step-by-step guide to QuCore: connections, the editor, results, projects, saved queries, safety checks and settings.',
      nav: 'guide',
      bodyClass: 'is-doc',
      content: `
      <div class="doc">${guideNav(null)}
        <article class="doc-body">
          <h1>QuCore user guide</h1>
${introBody}
          <h2>Chapters</h2>
          ${list}
        </article>
      </div>`
    })
  )
  write('guide/search.json', JSON.stringify(search))
}

// ---------- changelog ----------
function buildChangelog(): void {
  const md = new Marked({
    gfm: true,
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Heading) {
        const m = t.text.match(/^(v[\d.]+)\s*\(([\d-]+)\)$/)
        if (t.depth === 2 && m) return `<h2 id="${m[1]}">${m[1]}<span class="date">${m[2]}</span></h2>\n`
        return t.depth === 1 ? '' : `<h${t.depth}>${this.parser.parseInline(t.tokens)}</h${t.depth}>\n`
      }
    }
  })
  const body = md.parse(read(join(root, 'CHANGELOG.md')), { async: false }) as string
  write(
    'changelog/index.html',
    page({
      title: 'Changelog | QuCore',
      description: 'What changed in each QuCore release.',
      nav: 'changelog',
      content: `
      <div class="wrap doc-body changelog">
        <h1>Changelog</h1>
        <p class="muted">Every release, newest first. Downloads are on the <a href="${GITHUB}/releases">releases page</a>.</p>
${body}
      </div>`
    })
  )
}

// ---------- static files ----------
function copyAssets(): void {
  for (const f of ['styles.css', 'site.js']) copyFileSync(join(src, f), join(out, f))
  const fonts: [string, string][] = [
    ['@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2', 'instrument-sans-400.woff2'],
    ['@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2', 'instrument-sans-600.woff2'],
    ['@fontsource/instrument-sans/files/instrument-sans-latin-700-normal.woff2', 'instrument-sans-700.woff2'],
    ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'jetbrains-mono-400.woff2'],
    ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2', 'jetbrains-mono-600.woff2']
  ]
  mkdirSync(join(out, 'fonts'), { recursive: true })
  for (const [from, to] of fonts) copyFileSync(require.resolve(from), join(out, 'fonts', to))
  copyFileSync(join(root, 'src/renderer/src/assets/favicon.svg'), join(out, 'favicon.svg'))
  copyFileSync(join(root, 'src/renderer/src/assets/favicon.svg'), join(out, 'logo-icon.svg'))
  const imgDir = join(root, 'docs/guide/img/en')
  mkdirSync(join(out, 'img'), { recursive: true })
  for (const f of readdirSync(imgDir)) copyFileSync(join(imgDir, f), join(out, 'img', f))
  copyFileSync(join(imgDir, '05-editor-results.jpg'), join(out, 'img', 'og.jpg'))
  writeFileSync(join(out, '.nojekyll'), '')
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
copyAssets()
write(
  'index.html',
  page({
    title: 'QuCore: a free SQL editor for SQL Server, PostgreSQL and MariaDB',
    description: 'QuCore is a free, open-source desktop SQL editor for SQL Server, PostgreSQL and MariaDB/MySQL with projects, saved queries, versions and safety checks for production.',
    content: read(join(src, 'index.html'))
  })
)
buildGuide()
buildChangelog()
write(
  '404.html',
  page({
    title: 'Page not found | QuCore',
    description: 'This page does not exist.',
    content: `
      <div class="wrap notfound">
        <h1>No rows returned</h1>
        <p>This page does not exist. It may have moved when the guide was split into chapters.</p>
        <p><a href="${base}">Go to the home page</a> or <a href="${base}guide/">open the user guide</a>.</p>
      </div>`
  })
)
const count = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1), 0)
console.log(`site/dist: ${count(out)} files, ${chapters.length} guide chapters, base ${base}`)

// ---------- local preview ----------
if (process.argv.includes('--serve')) {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2' }
  createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (!path.startsWith(base)) {
      res.writeHead(302, { Location: base }).end()
      return
    }
    let file = join(out, path.slice(base.length))
    if (!extname(file)) file = join(file, 'index.html')
    if (!file.startsWith(out) || !existsSync(file)) {
      res.writeHead(404, { 'Content-Type': types['.html'] }).end(read(join(out, '404.html')))
      return
    }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
  }).listen(4173, () => console.log(`Preview: http://localhost:4173${base}`))
}
