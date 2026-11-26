import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Key, Link, Table } from '@vectilume/react'
import type { GraphTable } from '../../shared/types'

/** Tablica u izvozu: položaj i veličina u koordinatama dijagrama. */
export interface ExportNode {
  table: GraphTable
  fkColumns: Set<string>
  x: number
  y: number
  width: number
  height: number
}

export const HEADER_H = 30
export const ROW_H = 22
const MAX_TYPE = 26

/** Dugi tipovi (enum, set) skraćuju se u prikazu; puni tip ostaje u tooltipu. */
export function shortType(type: string): string {
  return type.length > MAX_TYPE ? type.slice(0, MAX_TYPE - 1) + '…' : type
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Vectilume ikona kao SVG markup (za samostalni SVG izvoz, bez DOM-a aplikacije). */
const iconCache = new Map<string, string>()
function icon(name: 'key' | 'link' | 'table', x: number, y: number, size: number, color: string): string {
  let inner = iconCache.get(name)
  if (inner === undefined) {
    const C = name === 'key' ? Key : name === 'link' ? Link : Table
    // Unutarnji dio ikone (bez vanjskog <svg>), da se može smjestiti s vlastitim x/y/veličinom.
    const markup = renderToStaticMarkup(createElement(C, { size: 24 }))
    const m = markup.match(/<svg([^>]*)>([\s\S]*)<\/svg>/)
    const viewBox = m?.[1].match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 24 24'
    inner = `${viewBox}|${m?.[2] ?? ''}`
    iconCache.set(name, inner)
  }
  const [viewBox, body] = [inner.slice(0, inner.indexOf('|')), inner.slice(inner.indexOf('|') + 1)]
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${viewBox}" fill="none" stroke="${color}" color="${color}">${body}</svg>`
}

const C = {
  bg: '#1e1f22',
  card: '#2b2d30',
  head: '#313338',
  border: '#393b40',
  text: '#dfe1e5',
  muted: '#8c9097',
  accent: '#3574f0',
  pk: '#e0b24f',
  fk: '#6fc3df',
  edge: '#6b7280'
}

/**
 * Samostalni SVG cijelog dijagrama: tablice iz podataka, veze iz putanja koje je React Flow već izračunao.
 * Mali i čist (tekst ostaje tekst), za razliku od snimke DOM-a sa svim stilovima.
 */
export function buildSvg(nodes: ExportNode[], edgePaths: string[], title: string): { svg: string; width: number; height: number } {
  const pad = 40
  const minX = Math.min(...nodes.map((n) => n.x)) - pad
  const minY = Math.min(...nodes.map((n) => n.y)) - pad
  const width = Math.ceil(Math.max(...nodes.map((n) => n.x + n.width)) - minX + pad)
  const height = Math.ceil(Math.max(...nodes.map((n) => n.y + n.height)) - minY + pad)
  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}" font-family="Segoe UI, system-ui, sans-serif" font-size="12">`,
    `<title>${esc(title)}</title>`,
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${C.bg}"/>`,
    `<g fill="none" stroke="${C.edge}" stroke-width="1.4">${edgePaths.map((d) => `<path d="${esc(d)}"/>`).join('')}</g>`
  )
  for (const n of nodes) {
    const t = n.table
    out.push(`<g transform="translate(${n.x} ${n.y})">`)
    out.push(`<rect width="${n.width}" height="${n.height}" rx="6" fill="${C.card}" stroke="${C.border}"/>`)
    out.push(`<path d="M0 6a6 6 0 0 1 6-6h${n.width - 12}a6 6 0 0 1 6 6v${HEADER_H - 6}H0Z" fill="${C.head}"/>`)
    out.push(`<line x1="0" y1="${HEADER_H}" x2="${n.width}" y2="${HEADER_H}" stroke="${C.border}"/>`)
    out.push(icon('table', 10, 8, 14, C.accent))
    const schema = t.schema ? `<tspan fill="${C.muted}" font-weight="400">${esc(t.schema)}.</tspan>` : ''
    out.push(`<text x="30" y="19.5" fill="${C.text}" font-weight="600">${schema}${esc(t.name)}</text>`)
    t.columns.forEach((c, i) => {
      const y = HEADER_H + i * ROW_H
      if (i % 2 === 1) out.push(`<rect x="1" y="${y}" width="${n.width - 2}" height="${ROW_H}" fill="#ffffff" fill-opacity="0.02"/>`)
      if (c.primaryKey) out.push(icon('key', 7, y + 5, 12, C.pk))
      else if (n.fkColumns.has(c.name)) out.push(icon('link', 7, y + 5, 12, C.fk))
      out.push(`<text x="26" y="${y + 15}" fill="${C.text}"${c.primaryKey ? ' font-weight="600"' : ''}>${esc(c.name)}</text>`)
      out.push(
        `<text x="${n.width - 10}" y="${y + 15}" fill="${C.muted}" text-anchor="end" font-family="Cascadia Code, Consolas, monospace" font-size="11">${esc(shortType(c.type))}${c.nullable ? '' : ' ·'}</text>`
      )
    })
    out.push('</g>')
  }
  out.push('</svg>')
  return { svg: out.join(''), width, height }
}

/** PNG iz istog SVG-a (canvas), do 2× gustoće; vrlo veliki dijagrami se smanjuju na granicu canvasa. */
export async function svgToPng(svg: string, width: number, height: number): Promise<string> {
  const MAX_SIDE = 16000
  const scale = Math.min(2, MAX_SIDE / width, MAX_SIDE / height)
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}
