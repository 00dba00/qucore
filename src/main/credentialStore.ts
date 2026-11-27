import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CredentialKind, ServiceCredential, ServiceCredentialInfo, ServiceCredentialInput } from '../shared/types'
import type { CredentialResolver } from '../core/jobs/http'
import { decryptSecret, encryptSecret } from './secrets'
import { t } from '../shared/i18n.ts'

interface StoredCredential extends Omit<ServiceCredential, 'secret'> {
  /** Token, lozinka, API ključ ili client secret, kriptirano kao lozinke konekcija. */
  secretEnc?: string
}

const KINDS: CredentialKind[] = ['bearer', 'basic', 'apiKey', 'oauth2']

/**
 * Prijave web servisa za poslove (%APPDATA%/QuCore/credentials.json). Tajna se kriptira
 * i nikad ne vraća u renderer; tamo ide samo hasSecret.
 */
export class CredentialStore implements CredentialResolver {
  private file: string
  private items: StoredCredential[] = []

  constructor(file: string) {
    this.file = file
    if (!existsSync(file)) return
    try {
      const v = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(v)) this.items = v
    } catch {
      this.items = []
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file + '.tmp', JSON.stringify(this.items, null, 2), 'utf8')
    renameSync(this.file + '.tmp', this.file)
  }

  private toInfo(s: StoredCredential): ServiceCredentialInfo {
    const { secretEnc, ...rest } = s
    return { ...rest, hasSecret: !!secretEnc }
  }

  list(): ServiceCredentialInfo[] {
    return this.items.map((s) => this.toInfo(s)).sort((a, b) => a.name.localeCompare(b.name))
  }

  async save(c: ServiceCredentialInput): Promise<ServiceCredentialInfo> {
    const name = c.name.trim()
    if (!name) throw new Error(t('main.credentialNameEmpty'))
    if (!KINDS.includes(c.kind)) throw new Error(t('main.credentialKind'))
    const id = c.id || randomUUID()
    const existing = this.items.find((x) => x.id === id)
    if (this.items.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new Error(t('main.credentialNameTaken', name))
    const { secret, ...rest } = c
    const stored: StoredCredential = {
      ...rest,
      id,
      name,
      // Samo polja koja vrsta prijave koristi.
      user: c.kind === 'basic' ? c.user?.trim() : undefined,
      keyName: c.kind === 'apiKey' ? c.keyName?.trim() : undefined,
      keyIn: c.kind === 'apiKey' ? (c.keyIn ?? 'header') : undefined,
      tokenUrl: c.kind === 'oauth2' ? c.tokenUrl?.trim() : undefined,
      clientId: c.kind === 'oauth2' ? c.clientId?.trim() : undefined,
      scope: c.kind === 'oauth2' ? c.scope?.trim() || undefined : undefined,
      secretEnc: secret === undefined ? existing?.secretEnc : secret === '' ? undefined : await encryptSecret(secret)
    }
    if (existing) this.items[this.items.indexOf(existing)] = stored
    else this.items.push(stored)
    this.persist()
    return this.toInfo(stored)
  }

  remove(id: string): void {
    this.items = this.items.filter((x) => x.id !== id)
    this.persist()
  }

  /** S dekriptiranom tajnom — samo u main procesu, za slanje zahtjeva. */
  async resolveCredential(id: string): Promise<ServiceCredential> {
    const s = this.items.find((x) => x.id === id)
    if (!s) throw new Error(t('core.httpCredentialMissing'))
    const { secretEnc, ...rest } = s
    if (!secretEnc) return rest
    const { value, reEncrypted } = await decryptSecret(secretEnc)
    if (reEncrypted) {
      s.secretEnc = reEncrypted
      this.persist()
    }
    return { ...rest, secret: value }
  }
}
