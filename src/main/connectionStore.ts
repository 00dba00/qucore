import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { decryptSecret, encryptSecret } from './secrets'
import type { ConnectionConfig, ConnectionInfo } from '../shared/types'
import type { ConnectionResolver } from '../core/manager'
import { t } from '../shared/i18n.ts'

interface StoredConnection extends Omit<ConnectionConfig, 'password'> {
  /** Lozinka kriptirana preko Windows DPAPI (safeStorage), base64. */
  passwordEnc?: string
}

/**
 * Konekcije se spremaju u %APPDATA%/QuCore/connections.json.
 * Lozinke se kriptiraju ključem vezanim uz Windows korisnički račun (DPAPI).
 */
export class ConnectionStore implements ConnectionResolver {
  private file: string
  private items: StoredConnection[] = []

  constructor(file: string) {
    this.file = file
    if (existsSync(file)) {
      try {
        this.items = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        this.items = []
      }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  private toInfo(s: StoredConnection): ConnectionInfo {
    const { passwordEnc, ...rest } = s
    return { ...rest, hasPassword: !!passwordEnc }
  }

  private encrypt(pw: string): Promise<string> {
    return encryptSecret(pw)
  }

  /** Dekriptira lozinku; ako je ključ u međuvremenu rotiran, odmah je ponovno kriptira i sprema. */
  private async decrypt(s?: StoredConnection): Promise<string | undefined> {
    const enc = s?.passwordEnc
    if (!s || !enc) return undefined
    const { value, reEncrypted } = await decryptSecret(enc)
    if (reEncrypted) {
      s.passwordEnc = reEncrypted
      this.persist()
    }
    return value
  }

  /**
   * Linux bez secret servicea (GNOME Keyring / KWallet): Electron sprema lozinke u basic_text obliku (v10 s fiksnim ključem),
   * što može pročitati svatko tko može čitati profil. Windows (DPAPI) i macOS (Keychain) su uvijek 'secure'.
   */
  async passwordStorage(): Promise<'secure' | 'plaintext'> {
    if (process.platform !== 'linux') return 'secure'
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return 'plaintext'
    return safeStorage.getSelectedStorageBackend() === 'basic_text' ? 'plaintext' : 'secure'
  }

  list(): ConnectionInfo[] {
    return this.items.map((s) => this.toInfo(s)).sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): ConnectionInfo | null {
    const s = this.items.find((x) => x.id === id)
    return s ? this.toInfo(s) : null
  }

  /**
   * Sprema konekciju. Ako password nije poslan (undefined), zadržava se postojeća lozinka;
   * prazan string briše lozinku.
   */
  async save(config: ConnectionConfig): Promise<ConnectionInfo> {
    const id = config.id || randomUUID()
    const existing = this.items.find((x) => x.id === id)
    const { password, ...rest } = config
    const stored: StoredConnection = {
      ...rest,
      id,
      passwordEnc: password === undefined ? existing?.passwordEnc : password === '' ? undefined : await this.encrypt(password)
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

  /** Puna konfiguracija s dekriptiranom lozinkom — koristi se samo u main procesu. */
  async resolve(id: string): Promise<ConnectionConfig> {
    const s = this.items.find((x) => x.id === id)
    if (!s) throw new Error(t('main.connectionMissing'))
    const { passwordEnc: _enc, ...rest } = s
    return { ...rest, password: await this.decrypt(s) }
  }

  /** Za "Test" u dijalogu: ako lozinka nije upisana, uzmi spremljenu. */
  async withStoredPassword(config: ConnectionConfig): Promise<ConnectionConfig> {
    if (config.password !== undefined || !config.id) return config
    const s = this.items.find((x) => x.id === config.id)
    return { ...config, password: await this.decrypt(s) }
  }
}
