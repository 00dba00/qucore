import { useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { CellValue, ResultColumn } from '../../../shared/types'
import { Icon } from './Icons'
import { num, t } from '../i18n'

export type PanelMode = 'value' | 'record'

const BINARY_TYPE = /binary|blob|bytea|image/i

type Shown =
  | { kind: 'null' }
  | { kind: 'text'; text: string }
  | { kind: 'code'; language: 'json' | 'xml'; text: string }
  | { kind: 'binary'; hex: string; bytes: number; truncated: boolean }

/** Uvlačenje XML-a bez parsera: novi red između oznaka, razina po otvorenoj oznaci. */
function prettyXml(xml: string): string | undefined {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) return undefined
  }
  let depth = 0
  return xml
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => {
      if (/^<\/[^>]+>$/.test(line)) depth = Math.max(0, depth - 1)
      const out = '  '.repeat(depth) + line
      if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/^<([^\s>]+)[^>]*>.*<\/\1>$/.test(line)) depth++
      return out
    })
    .join('\n')
}

/** Kako prikazati vrijednost: JSON i XML formatirano, binarno kao hex, ostalo kao tekst. */
export function classify(v: CellValue | undefined, type?: string): Shown {
  if (v === null || v === undefined) return { kind: 'null' }
  const s = String(v)
  const bin = /^0x([0-9a-f]*)(… \((\d+) B\))?$/i.exec(s)
  // Driver binarne podatke šalje kao "0x" + velika heks slova (MariaDB tip javlja kao varchar),
  // pa odlučuje oblik vrijednosti; kod binarnog tipa i mala slova.
  if (bin && (BINARY_TYPE.test(type ?? '') || /^0x[0-9A-F]{2,}/.test(s))) {
    const hex = bin[1]
    return { kind: 'binary', hex, bytes: bin[3] ? Number(bin[3]) : hex.length / 2, truncated: !!bin[2] }
  }
  const t = s.trim()
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return { kind: 'code', language: 'json', text: JSON.stringify(JSON.parse(t), null, 2) }
    } catch {
      // nije JSON — prikaži kao tekst
    }
  }
  if (t.startsWith('<') && t.endsWith('>')) {
    const x = prettyXml(t)
    if (x) return { kind: 'code', language: 'xml', text: x }
  }
  return { kind: 'text', text: s }
}

function hexDump(hex: string): string {
  const lines: string[] = []
  for (let off = 0; off < hex.length; off += 32) {
    const chunk = hex.slice(off, off + 32)
    const bytes = chunk.match(/../g) ?? []
    const ascii = bytes.map((b) => {
      const c = parseInt(b, 16)
      return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'
    })
    lines.push(`${(off / 2).toString(16).padStart(6, '0')}  ${bytes.join(' ').padEnd(47)}  ${ascii.join('')}`)
  }
  return lines.join('\n')
}

/**
 * Panel desno od grida: puna vrijednost odabrane ćelije (Vrijednost) ili odabrani redak okomito (Redak).
 * Strelice u gridu mijenjaju ćeliju/redak, panel ih prati.
 */
export function ValuePanel({
  mode,
  columns,
  row,
  rowNumber,
  col,
  onMode,
  onSelectCol,
  onClose
}: {
  mode: PanelMode
  columns: ResultColumn[]
  /** Prikazane vrijednosti odabranog retka (s neuspremljenim izmjenama); null = ništa odabrano. */
  row: CellValue[] | null
  rowNumber: number
  col: number
  onMode(m: PanelMode): void
  onSelectCol(c: number): void
  onClose(): void
}) {
  const [copied, setCopied] = useState(false)
  const value = row ? row[col] : undefined
  const shown = useMemo(() => classify(value, columns[col]?.type), [value, columns, col])
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="value-panel">
      <div className="value-panel-head">
        <button className={'seg' + (mode === 'value' ? ' active' : '')} onClick={() => onMode('value')}>
          {t('value.value')}
        </button>
        <button className={'seg' + (mode === 'record' ? ' active' : '')} onClick={() => onMode('record')}>
          {t('value.row')}
        </button>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title={t('value.close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {!row ? (
        <div className="value-empty muted small">{t('value.pickCell')}</div>
      ) : mode === 'record' ? (
        <div className="record-view">
          <div className="muted small record-title">{t('value.rowN', rowNumber)}</div>
          {columns.map((c, i) => (
            <div key={i} className={'record-row' + (i === col ? ' active' : '')} onClick={() => onSelectCol(i)} title={t('value.showFull')}>
              <span className="record-name" title={c.type ? `${c.name} (${c.type})` : c.name}>
                {c.name}
              </span>
              <span className={'record-value' + (row[i] === null ? ' null' : '')}>{row[i] === null ? 'NULL' : String(row[i])}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="value-view">
          <div className="value-meta muted small">
            <b>{columns[col]?.name}</b>
            {columns[col]?.type && <span> · {columns[col].type}</span>}
            {shown.kind === 'text' && <span> · {t('value.chars', shown.text.length)}</span>}
            {shown.kind === 'code' && <span> · {shown.language.toUpperCase()} {t('value.formatted')}</span>}
            {shown.kind === 'binary' && <span> · {num(shown.bytes)} B{shown.truncated ? ' ' + t('value.truncated') : ''}</span>}
            <span style={{ flex: 1 }} />
            {shown.kind !== 'null' && (
              <button className="link-btn" onClick={() => void copy(String(value))}>
                {copied ? t('common.copied') : t('common.copy')}
              </button>
            )}
          </div>
          {shown.kind === 'null' && <div className="value-empty muted">NULL</div>}
          {shown.kind === 'text' && <pre className="value-text">{shown.text}</pre>}
          {shown.kind === 'binary' && <pre className="value-text hex">{hexDump(shown.hex)}</pre>}
          {shown.kind === 'code' && (
            <div className="value-code">
              <Editor
                value={shown.text}
                language={shown.language}
                theme="studio-dark"
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  lineNumbers: 'off',
                  folding: true,
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  fontSize: 12.5,
                  renderLineHighlight: 'none'
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
