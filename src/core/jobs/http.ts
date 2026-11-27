import type { HttpTestResult, JobHttpTarget, ServiceCredential } from '../../shared/types.ts'
import { safeNumber } from '../resultFormats.ts'
import { errorMessage } from '../util.ts'
import { kindOf, type OutColumn, type TransferValue } from './sql.ts'
import { BatchError, SomeRowsFailed, rowObject } from './errors.ts'
import { t } from '../../shared/i18n.ts'

/** Izvor prijava servisa (desktop: kriptirana datoteka). */
export interface CredentialResolver {
  resolveCredential(id: string): Promise<ServiceCredential>
}

export interface HttpContext {
  jobName: string
  /** Vrijednosti varijabli izvornog upita (kao tekst). */
  variables?: Record<string, string>
  now?: Date
  signal?: AbortSignal
  credentials?: CredentialResolver
  /** Za testove: zamjena za fetch i kraće čekanje. */
  fetch?: typeof fetch
  backoffMs?: number
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_BACKOFF_MS = 1000
const MAX_RETRY_AFTER_MS = 60000
const BODY_PREVIEW = 4000
const ERROR_BODY = 500
const NUMERIC_KINDS = new Set(['int', 'bigint', 'decimal', 'float'])
const pad = (n: number) => String(n).padStart(2, '0')

/** Greška servisa: status i početak odgovora. */
export class HttpError extends Error {
  status: number
  constructor(status: number, statusText: string, body: string) {
    super(t('core.httpStatus', status, statusText, body.slice(0, ERROR_BODY)))
    this.status = status
  }
}

// ---------- Predlošci ----------

type Lookup = (name: string) => unknown

/** Vrijednost u JSON-u: binarni podaci kao base64, brojevi iz numeričkih stupaca (tekst iz drivera) kao brojevi. */
function jsonValue(v: TransferValue, numeric: boolean): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
  if (numeric && typeof v === 'string') return safeNumber(v) ?? v
  return v
}

/** Ugrađene vrijednosti i varijable upita (stupci imaju prednost). */
function builtins(ctx: HttpContext): Record<string, unknown> {
  const now = ctx.now ?? new Date()
  return {
    ...ctx.variables,
    job: ctx.jobName,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
    now: now.toISOString()
  }
}

function lookupIn(...scopes: Record<string, unknown>[]): Lookup {
  return (name) => {
    for (const s of scopes) if (Object.prototype.hasOwnProperty.call(s, name)) return s[name]
    const lower = name.toLowerCase()
    for (const s of scopes) for (const k of Object.keys(s)) if (k.toLowerCase() === lower) return s[k]
    throw new Error(t('core.httpUnknownPlaceholder', name))
  }
}

const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g

/**
 * JSON predložak: {{x}} izvan navodnika postaje JSON vrijednost ("tekst", 5, null, {…}),
 * unutar navodnika ("id-{{x}}") samo tekst s JSON escapeom. Rezultat mora biti ispravan JSON.
 */
export function renderJson(template: string, lookup: Lookup): string {
  let out = ''
  let last = 0
  let inString = false
  const scan = (to: number) => {
    for (let i = last; i < to; i++) {
      const c = template[i]
      if (c === '\\' && inString) i++
      else if (c === '"') inString = !inString
    }
  }
  for (const m of template.matchAll(PLACEHOLDER)) {
    scan(m.index)
    out += template.slice(last, m.index)
    const v = lookup(m[1])
    if (inString) {
      const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      out += JSON.stringify(text).slice(1, -1)
    } else out += JSON.stringify(v ?? null)
    last = m.index + m[0].length
  }
  out += template.slice(last)
  try {
    JSON.parse(out)
  } catch (e) {
    throw new Error(t('core.httpBodyNotJson', errorMessage(e), out.slice(0, 200)))
  }
  return out
}

/** Tekstualni predložak (adresa, header): null je prazno; encode za adresu. */
export function renderText(template: string, lookup: Lookup, encode: (s: string) => string = (s) => s): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    const v = lookup(name)
    const s = v === null || v === undefined ? '' : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return encode(s)
  })
}

// ---------- Prijava ----------

/** OAuth2 tokeni po prijavi, do isteka (minus minuta). */
const tokenCache = new Map<string, { token: string; expires: number }>()

interface Auth {
  apply(url: string, headers: Record<string, string>): Promise<string>
  /** Nakon 401: zaboravi OAuth2 token (iduće slanje traži novi). */
  invalidate(): boolean
  /** Adresa za prikaz (API ključ skriven). */
  mask(url: string): string
}

async function oauthToken(c: ServiceCredential, f: typeof fetch, signal?: AbortSignal): Promise<string> {
  const key = `${c.id}\u0000${c.tokenUrl}\u0000${c.clientId}`
  const cached = tokenCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.token
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId ?? '', client_secret: c.secret ?? '' })
  if (c.scope) form.set('scope', c.scope)
  const res = await f(c.tokenUrl ?? '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    signal
  })
  const text = await res.text()
  if (!res.ok) throw new Error(t('core.httpTokenFailed', res.status, text.slice(0, ERROR_BODY)))
  let body: { access_token?: string; expires_in?: number }
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(t('core.httpTokenFailed', res.status, text.slice(0, ERROR_BODY)))
  }
  if (!body.access_token) throw new Error(t('core.httpTokenFailed', res.status, text.slice(0, ERROR_BODY)))
  tokenCache.set(key, { token: body.access_token, expires: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000 })
  return body.access_token
}

async function authFor(id: string | undefined, ctx: HttpContext): Promise<Auth> {
  if (!id) return { apply: async (url) => url, invalidate: () => false, mask: (u) => u }
  if (!ctx.credentials) throw new Error(t('core.httpCredentialMissing'))
  const c = await ctx.credentials.resolveCredential(id)
  const f = ctx.fetch ?? fetch
  const withQuery = (url: string, name: string, value: string) => {
    const u = new URL(url)
    u.searchParams.set(name, value)
    return u.toString()
  }
  return {
    async apply(url, headers) {
      switch (c.kind) {
        case 'bearer':
          headers.Authorization = `Bearer ${c.secret ?? ''}`
          return url
        case 'basic':
          headers.Authorization = `Basic ${Buffer.from(`${c.user ?? ''}:${c.secret ?? ''}`).toString('base64')}`
          return url
        case 'apiKey':
          if (c.keyIn === 'query') return withQuery(url, c.keyName || 'api_key', c.secret ?? '')
          headers[c.keyName || 'X-API-Key'] = c.secret ?? ''
          return url
        case 'oauth2':
          headers.Authorization = `Bearer ${await oauthToken(c, f, ctx.signal)}`
          return url
      }
    },
    invalidate() {
      if (c.kind !== 'oauth2') return false
      tokenCache.delete(`${c.id}\u0000${c.tokenUrl}\u0000${c.clientId}`)
      return true
    },
    mask: (url) => (c.kind === 'apiKey' && c.keyIn === 'query' ? withQuery(url, c.keyName || 'api_key', '***') : url)
  }
}

// ---------- Slanje ----------

interface Request {
  method: JobHttpTarget['method']
  url: string
  headers: Record<string, string>
  body?: string
}

interface Response {
  status: number
  statusText: string
  text: string
  url: string
  durationMs: number
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(t('core.jobCancelled')))
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    function abort() {
      clearTimeout(timer)
      reject(new Error(t('core.jobCancelled')))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Retry-After u sekundama ili kao datum. */
function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined
  const s = Number(h)
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - Date.now()
  return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms)) : undefined
}

async function send(req: Request, d: JobHttpTarget, auth: Auth, ctx: HttpContext): Promise<Response> {
  const f = ctx.fetch ?? fetch
  const backoff = ctx.backoffMs ?? DEFAULT_BACKOFF_MS
  let refreshed = false
  for (let attempt = 0; ; attempt++) {
    const headers = { ...req.headers }
    const url = await auth.apply(req.url, headers)
    const started = performance.now()
    const signals = [AbortSignal.timeout(ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS), ...(ctx.signal ? [ctx.signal] : [])]
    let res: globalThis.Response
    try {
      res = await f(url, { method: req.method, headers, body: req.body, signal: AbortSignal.any(signals) })
    } catch (e) {
      if (ctx.signal?.aborted) throw new Error(t('core.jobCancelled'))
      if (attempt < d.retries) {
        await sleep(backoff * 2 ** attempt, ctx.signal)
        continue
      }
      const cause = (e as { cause?: unknown }).cause
      throw new Error(t('core.httpNetwork', auth.mask(url), errorMessage(cause ?? e)))
    }
    const text = await res.text()
    const durationMs = performance.now() - started
    if (res.ok) return { status: res.status, statusText: res.statusText, text, url: auth.mask(url), durationMs }
    // Istekao OAuth2 token: jednom traži novi, bez trošenja pokušaja.
    if (res.status === 401 && !refreshed && auth.invalidate()) {
      refreshed = true
      attempt--
      continue
    }
    if (RETRYABLE.has(res.status) && attempt < d.retries) {
      await sleep(retryAfterMs(res.headers.get('retry-after')) ?? backoff * 2 ** attempt, ctx.signal)
      continue
    }
    throw new HttpError(res.status, res.statusText, text)
  }
}

// ---------- Pisac ----------

export interface HttpSink {
  target: string
  rowsWritten: number
  write(rows: TransferValue[][], offset: number): Promise<void>
  finish(): Promise<string>
}

/** Provjera prije slanja (spremanje posla i pokretanje). */
export function validateHttpTarget(d: JobHttpTarget): void {
  let u: URL
  try {
    u = new URL(d.url.replace(PLACEHOLDER, 'x'))
  } catch {
    throw new Error(t('core.httpBadUrl', d.url))
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(t('core.httpBadUrl', d.url))
  if (d.method === 'GET' && d.send === 'batch') throw new Error(t('core.httpGetBatch'))
}

/** Zahtjevi za retke: po retku ili jedan za paket. */
function requestBuilder(d: JobHttpTarget, columns: OutColumn[], numeric: boolean[], ctx: HttpContext) {
  const base = builtins(ctx)
  const rowValues = (row: TransferValue[]) => Object.fromEntries(columns.map((c, i) => [c.name, jsonValue(row[i], numeric[i])]))
  const headers = (lookup: Lookup) => {
    const h: Record<string, string> = {}
    for (const x of d.headers) if (x.name.trim()) h[x.name.trim()] = renderText(x.value, lookup).replace(/[\r\n]+/g, ' ')
    const hasType = Object.keys(h).some((k) => k.toLowerCase() === 'content-type')
    if (!hasType && d.method !== 'GET') h['Content-Type'] = 'application/json; charset=utf-8'
    return h
  }
  const withBody = d.method !== 'GET' && (d.method !== 'DELETE' || d.body.trim() !== '')
  return (rows: TransferValue[][]): Request => {
    if (d.send === 'row') {
      const values = rowValues(rows[0])
      const lookup = lookupIn(values, base)
      return {
        method: d.method,
        url: renderText(d.url, lookup, encodeURIComponent),
        headers: headers(lookup),
        body: withBody ? (d.body.trim() ? renderJson(d.body, lookup) : JSON.stringify(values)) : undefined
      }
    }
    const list = rows.map(rowValues)
    const lookup = lookupIn({ rows: list }, base)
    return {
      method: d.method,
      url: renderText(d.url, lookupIn(base), encodeURIComponent),
      headers: headers(lookupIn(base)),
      body: withBody ? (d.body.trim() ? renderJson(d.body, lookup) : JSON.stringify(list)) : undefined
    }
  }
}

function numericFlags(columns: OutColumn[], sample: TransferValue[][]): boolean[] {
  return columns.map((c, i) => NUMERIC_KINDS.has(kindOf(c.sourceType, sample.map((r) => r[i]))))
}

export async function openHttpSink(d: JobHttpTarget, columns: OutColumn[], first: TransferValue[][], ctx: HttpContext): Promise<HttpSink> {
  validateHttpTarget(d)
  const auth = await authFor(d.credentialId, ctx)
  const build = requestBuilder(d, columns, numericFlags(columns, first), ctx)
  let failed = 0
  let firstFailure: { message: string; row?: Record<string, unknown>; rowNumber?: number } | undefined
  const sink: HttpSink = {
    target: `${d.method} ${d.url}`,
    rowsWritten: 0,
    async write(rows, offset) {
      const groups = d.send === 'row' ? rows.map((r) => [r]) : [rows]
      let at = offset
      for (const g of groups) {
        try {
          await send(build(g), d, auth, ctx)
          sink.rowsWritten += g.length
        } catch (e) {
          if (ctx.signal?.aborted || d.onError === 'stop') throw new BatchError(e, g, at)
          failed += g.length
          firstFailure ??=
            g.length === 1
              ? { message: errorMessage(e), row: rowObject(columns, g[0]), rowNumber: at + 1 }
              : { message: t('core.jobBatchFailed', at + 1, at + g.length, errorMessage(e)) }
        }
        at += g.length
      }
    },
    async finish() {
      if (failed && firstFailure) {
        const total = failed + sink.rowsWritten
        const where = firstFailure.rowNumber ? t('core.jobRowFailed', firstFailure.rowNumber, firstFailure.message) : firstFailure.message
        throw new SomeRowsFailed(t('core.httpSomeFailed', failed, total, where), firstFailure.row, firstFailure.rowNumber)
      }
      return sink.target
    }
  }
  return sink
}

/** Jedan zahtjev s prvim retkom (probni poziv iz sučelja); odgovor se vraća i kad je greška. */
export async function testHttpRequest(d: JobHttpTarget, columns: OutColumn[], row: TransferValue[], ctx: HttpContext): Promise<HttpTestResult> {
  validateHttpTarget(d)
  const auth = await authFor(d.credentialId, ctx)
  const req = requestBuilder(d, columns, numericFlags(columns, [row]), ctx)([row])
  const f = ctx.fetch ?? fetch
  const headers = { ...req.headers }
  const url = await auth.apply(req.url, headers)
  const started = performance.now()
  let res: globalThis.Response
  try {
    res = await f(url, { method: req.method, headers, body: req.body, signal: AbortSignal.timeout(ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS) })
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause
    throw new Error(t('core.httpNetwork', auth.mask(url), errorMessage(cause ?? e)))
  }
  const text = await res.text()
  return {
    method: req.method,
    url: auth.mask(url),
    status: res.status,
    statusText: res.statusText,
    durationMs: Math.round(performance.now() - started),
    body: text.slice(0, BODY_PREVIEW),
    sent: (req.body ?? '').slice(0, BODY_PREVIEW)
  }
}
