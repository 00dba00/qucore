import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { CellValue, JobFileFormat, JobFileTarget } from '../../shared/types.ts'
import { csvValue, safeNumber } from '../resultFormats.ts'
import { buildXlsx } from '../xlsx.ts'
import { kindOf, type OutColumn, type TransferValue } from './sql.ts'
import { t } from '../../shared/i18n.ts'

const pad = (n: number) => String(n).padStart(2, '0')
/** Znakovi koji ne smiju biti u nazivu datoteke (Windows je najstroži). */
const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
/** Excel list ima najviše 1 048 576 redaka, uključujući zaglavlje. */
export const XLSX_MAX_ROWS = 1048575

/**
 * Naziv datoteke iz predloška: {date} = 2026-11-27, {time} = 143005, {job} = naziv posla.
 * Bez putanje (mapa je zasebno odabrana); nastavak se dodaje ako ga nema.
 */
export function expandFileName(pattern: string, jobName: string, now: Date, format: JobFileFormat): string {
  const job = jobName.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').trim() || 'job'
  const name = pattern
    .replace(/\{date\}/gi, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    .replace(/\{time\}/gi, `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`)
    .replace(/\{job\}/gi, job)
    .trim()
  if (!name || BAD_CHARS.test(name) || /^\.+$/.test(name)) throw new Error(t('core.jobBadFileName', pattern))
  return extname(name).toLowerCase() === `.${format}` ? name : `${name}.${format}`
}

/** "izvoz.csv" → "izvoz (2).csv" dok ne nađe slobodan naziv. */
export function uniqueFileName(folder: string, name: string, exists: (path: string) => boolean = existsSync): string {
  if (!exists(join(folder, name))) return name
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!exists(join(folder, candidate))) return candidate
  }
}

/** Vrijednost za tekstualne formate: binarni podaci kao 0x hex, ostalo kako je. */
function cell(v: TransferValue): CellValue {
  if (v instanceof Uint8Array) return '0x' + Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex').toUpperCase()
  return v
}

const NUMERIC_KINDS = new Set(['int', 'bigint', 'decimal', 'float'])

export interface FileSink {
  write(rows: TransferValue[][]): Promise<void>
  /** Zatvara datoteku i premješta je na konačno mjesto; vraća putanju. */
  finish(): Promise<string>
  /** Briše nedovršenu datoteku. */
  abort(): Promise<void>
}

/**
 * Datoteka se piše u "<naziv>.part" pa se na kraju preimenuje, tako da neuspjeli posao
 * ne ostavlja napola zapisanu datoteku pod pravim nazivom.
 */
export function openFileSink(target: JobFileTarget, columns: OutColumn[], path: string): FileSink {
  const part = path + '.part'
  const names = columns.map((c) => c.name)

  if (target.format === 'xlsx') {
    const rows: CellValue[][] = []
    return {
      async write(batch) {
        if (rows.length + batch.length > XLSX_MAX_ROWS) throw new Error(t('core.jobXlsxTooManyRows', XLSX_MAX_ROWS))
        for (const r of batch) rows.push(r.map(cell))
      },
      async finish() {
        const view = { columns: columns.map((c) => ({ name: c.name, type: c.sourceType })), rows }
        await writeFile(part, buildXlsx(view))
        await rename(part, path)
        return path
      },
      async abort() {
        await rm(part, { force: true })
      }
    }
  }

  const out: WriteStream = createWriteStream(part, { encoding: 'utf8' })
  let failed: Error | null = null
  out.on('error', (e) => (failed = e))
  const put = (text: string) =>
    new Promise<void>((resolve, reject) => {
      if (failed) return reject(failed)
      if (out.write(text)) resolve()
      else out.once('drain', resolve)
    })
  const close = () =>
    new Promise<void>((resolve, reject) => {
      if (failed) return reject(failed)
      out.end((e?: Error | null) => (e ? reject(e) : resolve()))
    })

  let first = true
  let numeric: boolean[] | null = null
  const delimiter = target.delimiter ?? ';'

  return {
    async write(batch) {
      if (target.format === 'csv') {
        // BOM i ';' kao i "Kopiraj kao CSV": Excel s hrvatskim postavkama ga otvara ispravno.
        const head = first ? '﻿' + names.map(csvValue).join(delimiter) + '\r\n' : ''
        first = false
        await put(head + batch.map((r) => r.map((v) => csvValue(cell(v))).join(delimiter) + '\r\n').join(''))
        return
      }
      // JSON: polje objekata; brojevi iz numeričkih stupaca (driver ih šalje kao tekst) kad se ne gubi preciznost.
      numeric ??= columns.map((c, i) => NUMERIC_KINDS.has(kindOf(c.sourceType, batch.map((r) => r[i]))))
      const objects = batch.map((r) =>
        JSON.stringify(
          Object.fromEntries(
            names.map((n, i) => {
              const v = cell(r[i])
              return [n, numeric![i] && typeof v === 'string' ? (safeNumber(v) ?? v) : v]
            })
          )
        )
      )
      const prefix = first ? '[\n' : ',\n'
      first = false
      await put(prefix + objects.join(',\n'))
    },
    async finish() {
      if (target.format === 'csv' && first) await put('﻿' + names.map(csvValue).join(delimiter) + '\r\n')
      if (target.format === 'json') await put(first ? '[]\n' : '\n]\n')
      await close()
      await rename(part, path)
      return path
    },
    async abort() {
      if (!out.closed) {
        await new Promise<void>((resolve) => {
          out.once('close', () => resolve())
          out.destroy()
        })
      }
      await rm(part, { force: true })
    }
  }
}
