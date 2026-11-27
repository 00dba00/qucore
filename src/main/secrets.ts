import { safeStorage } from 'electron'
import { t } from '../shared/i18n.ts'

/**
 * Kriptiranje tajni (lozinke konekcija, tokeni servisa) ključem vezanim uz korisnički račun:
 * Windows DPAPI, macOS Keychain, Linux secret service. Rezultat je base64.
 */
export async function encryptSecret(value: string): Promise<string> {
  // Na Linuxu bez keyringa Electron nudi samo slabiju "basic_text" zaštitu — bolje nego čisti tekst.
  if (!(await safeStorage.isAsyncEncryptionAvailable()) && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true)
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error(t('main.encryptionUnavailable'))
  return (await safeStorage.encryptStringAsync(value)).toString('base64')
}

/** Dekriptira tajnu; reEncrypted je postavljen kad je ključ rotiran (pozivatelj sprema novu vrijednost). */
export async function decryptSecret(enc: string): Promise<{ value: string; reEncrypted?: string }> {
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))
  return { value: result, reEncrypted: shouldReEncrypt ? await encryptSecret(result) : undefined }
}
