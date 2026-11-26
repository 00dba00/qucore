import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Datoteke koje je korisnik sam odabrao (dijalog Otvori / Spremi kao, povlačenje u prozor).
 * Renderer smije čitati i spremati samo njih: inače bi kod u rendereru (npr. nakon XSS-a) mogao
 * čitati ili prepisati bilo koju datoteku na disku. Popis se čuva u profilu, pa tabovi vraćeni
 * nakon ponovnog pokretanja i dalje spremaju u svoju datoteku.
 */
export class FileGrants {
  private paths: string[] = []

  constructor(
    private file: string,
    private max = 500
  ) {
    if (!existsSync(file)) return
    try {
      const v = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(v)) this.paths = v.filter((x): x is string => typeof x === 'string')
    } catch {
      // oštećena datoteka: kreće se od praznog popisa (korisnik ponovno otvori datoteku)
    }
  }

  private key(path: string): string {
    const p = resolve(path)
    return process.platform === 'win32' ? p.toLowerCase() : p
  }

  has(path: string): boolean {
    return typeof path === 'string' && this.paths.includes(this.key(path))
  }

  add(path: string): void {
    const k = this.key(path)
    // Najnovija na kraj; najstarije ispadaju preko granice.
    this.paths = [...this.paths.filter((p) => p !== k), k].slice(-this.max)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file + '.tmp', JSON.stringify(this.paths), 'utf8')
      renameSync(this.file + '.tmp', this.file)
    } catch (err) {
      console.error('file grants:', err)
    }
  }
}
