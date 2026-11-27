import { errorMessage } from '../util.ts'
import type { TransferValue } from './sql.ts'

/** Upis paketa (ili jednog retka) nije uspio; nosi retke da se može pronaći koji je kriv. */
export class BatchError extends Error {
  rows: TransferValue[][]
  /** Redni broj (od 0) prvog retka u izvoru. */
  offset: number
  constructor(cause: unknown, rows: TransferValue[][], offset: number) {
    super(errorMessage(cause))
    this.rows = rows
    this.offset = offset
  }
}

/** Posao je išao do kraja ("nastavi na grešku"), ali dio redaka nije upisan. */
export class SomeRowsFailed extends Error {
  failedRow?: Record<string, unknown>
  failedRowNumber?: number
  constructor(message: string, failedRow?: Record<string, unknown>, failedRowNumber?: number) {
    super(message)
    this.failedRow = failedRow
    this.failedRowNumber = failedRowNumber
  }
}

/** Redak kao objekt za log (binarni podaci skraćeni). */
export function rowObject(columns: { name: string }[], row: TransferValue[]): Record<string, unknown> {
  return Object.fromEntries(
    columns.map((c, i) => {
      const v = row[i]
      if (!(v instanceof Uint8Array)) return [c.name, v]
      const hex = Buffer.from(v.buffer, v.byteOffset, v.byteLength).subarray(0, 32).toString('hex').toUpperCase()
      return [c.name, `0x${hex}${v.byteLength > 32 ? `… (${v.byteLength} B)` : ''}`]
    })
  )
}
