import type { TextEncodingName } from '../shared/types.ts'
import { t } from '../shared/i18n.ts'

/*
 * Čitanje i pisanje .sql datoteka u kodiranju u kojem su stigle:
 * UTF-8 (s BOM-om ili bez), UTF-16 s BOM-om (SSMS "Unicode") i Windows-1250 (stari hrvatski ANSI).
 */

let cp1250: Map<string, number> | undefined
/** Windows-1250 enkoder: obrnuta tablica TextDecodera (Node i Chromium imaju puni ICU). */
function cp1250Table(): Map<string, number> {
  if (!cp1250) {
    cp1250 = new Map()
    const dec = new TextDecoder('windows-1250')
    for (let b = 0; b < 256; b++) {
      const ch = dec.decode(new Uint8Array([b]))
      if (ch !== '�' && !cp1250.has(ch)) cp1250.set(ch, b)
    }
  }
  return cp1250
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf8bom' }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf16le' }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf16be' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' }
  } catch {
    // Nije ispravan UTF-8: najvjerojatnije ANSI datoteka iz starijih alata (Windows-1250 za naša slova).
    return { text: new TextDecoder('windows-1250').decode(bytes), encoding: 'windows-1250' }
  }
}

/**
 * Tekst u bajtove u zadanom kodiranju. Windows-1250 ne može zapisati svaki znak (npr. emoji, ćirilicu):
 * tada se sprema kao UTF-8 s BOM-om, a vraćeno kodiranje to javlja.
 */
export function encodeText(text: string, encoding: TextEncodingName): { bytes: Uint8Array; encoding: TextEncodingName } {
  switch (encoding) {
    case 'utf8':
      return { bytes: new TextEncoder().encode(text), encoding }
    case 'utf8bom': {
      const body = new TextEncoder().encode(text)
      const out = new Uint8Array(body.length + 3)
      out.set([0xef, 0xbb, 0xbf])
      out.set(body, 3)
      return { bytes: out, encoding }
    }
    case 'utf16le':
    case 'utf16be': {
      const out = new Uint8Array(2 + text.length * 2)
      const le = encoding === 'utf16le'
      out.set(le ? [0xff, 0xfe] : [0xfe, 0xff])
      const dv = new DataView(out.buffer)
      for (let i = 0; i < text.length; i++) dv.setUint16(2 + i * 2, text.charCodeAt(i), le)
      return { bytes: out, encoding }
    }
    case 'windows-1250': {
      const table = cp1250Table()
      const out = new Uint8Array(text.length)
      for (let i = 0; i < text.length; i++) {
        const b = table.get(text[i])
        if (b === undefined) return encodeText(text, 'utf8bom')
        out[i] = b
      }
      return { bytes: out, encoding }
    }
  }
}

export const ENCODING_LABELS: Record<TextEncodingName, string> = {
  utf8: 'UTF-8',
  get utf8bom() {
    return t('core.utf8bom')
  },
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  'windows-1250': 'Windows-1250'
}
