// End-to-end test prave Electron aplikacije (Playwright). Pokretanje: xvfb-run node scripts/e2e.mjs
import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const shots = process.env.SHOTS ?? join(tmpdir(), 'qucore-e2e-shots')
mkdirSync(shots, { recursive: true })
// Privremeni profil: pravi profil korisnika (konekcije, lozinke, povijest) se ne dira.
const profile = mkdtempSync(join(tmpdir(), 'qucore-e2e-'))
process.on('exit', () => rmSync(profile, { recursive: true, force: true }))

const app = await electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, NODE_ENV: 'production', QUCORE_USER_DATA: profile } })
const win = await app.firstWindow()
win.on('console', (m) => m.type() === 'error' && console.log('[renderer]', m.text()))
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
await win.setViewportSize({ width: 1400, height: 860 })
await win.waitForSelector('.welcome')
// Selektori su pisani za hrvatsko sučelje; novi profil bi inače uzeo jezik sustava.
await win.evaluate(() => localStorage.setItem('qucore.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('qucore.settings.v1') ?? '{}'), language: 'hr' })))
await win.reload()
await win.waitForSelector('.welcome')
await win.screenshot({ path: `${shots}/01-welcome.png` })

async function addConnection({ type, name, host, port, user, password, database, colorIndex }) {
  await win.click('.panel-header .icon-btn')
  await win.click(`.type-picker button:has-text("${type}")`)
  const inputs = win.locator('.form-grid input')
  await inputs.nth(0).fill(name)
  await inputs.nth(1).fill(host)
  await inputs.nth(2).fill(String(port))
  await inputs.nth(3).fill(user)
  await inputs.nth(4).fill(password)
  if (database) await inputs.nth(5).fill(database)
  if (colorIndex) await win.locator('.color-dot').nth(colorIndex).click()
  await win.click('button:has-text("Testiraj")')
  await win.waitForSelector('.status-box')
  console.log('test:', (await win.textContent('.status-box')).trim().replace(/\n/g, ' | '))
  await win.screenshot({ path: `${shots}/02-dialog-${name}.png` })
  await win.click('button:has-text("Spremi")')
  await win.waitForSelector(`.tree-row:has-text("${name}")`)
}

await addConnection({ type: 'PostgreSQL', name: 'Lokalni Postgres', host: 'localhost', port: 5432, user: 'postgres', password: 'x', database: 'shop', colorIndex: 2 })
await addConnection({ type: 'MariaDB', name: 'MariaDB dev', host: '127.0.0.1', port: 3306, user: 'studio', password: 'studio', colorIndex: 5 })

// Explorer: otvori Postgres → shop (otvara se sam jer je zadana baza) → Tablice
await win.click('.tree-row:has-text("Lokalni Postgres")')
await win.waitForSelector('.tree-row:has-text("Tablice")')
await win.waitForSelector('.tree-row:has(.tree-label:text-is("customers"))')
await win.click('.tree-row:has-text("Procedure")')
await win.click('.tree-row:has-text("Funkcije")')
await win.click('.tree-row:has(.tree-label:text-is("orders"))')
await win.waitForSelector('.tree-row:has-text("customer_id")')
await win.screenshot({ path: `${shots}/03-explorer.png` })

// Dvoklik na tablicu → SELECT prvih 100 se izvrši
await win.dblclick('.tree-row:has(.tree-label:text-is("customers"))')
await win.waitForSelector('.grid-row')
await win.screenshot({ path: `${shots}/04-select-top.png` })

// Novi upit s više naredbi i greškom
await win.keyboard.press('Control+t')
await win.waitForTimeout(500)
await win.click('.query-tab[style*="flex"] .monaco-editor')
await win.keyboard.type(
  "SELECT c.name, count(o.id) AS broj, sum(o.total) AS ukupno\nFROM sales.customers c JOIN sales.orders o ON o.customer_id = c.id\nGROUP BY c.name ORDER BY ukupno DESC;\nUPDATE sales.orders SET total = total WHERE id < 10;\nSELECT now() AS sada, NULL AS prazno, '{\"a\":1}'::jsonb AS j;\n",
  { delay: 2 }
)
await win.keyboard.press('Escape')
await win.keyboard.press('Control+Enter')
await win.waitForSelector('.result-tabs button:has-text("Rezultat 2")')
await win.screenshot({ path: `${shots}/05-multi.png` })
await win.click('.query-tab[style*="flex"] .result-tabs button:has-text("Poruke")')
await win.screenshot({ path: `${shots}/06-messages.png` })

// Autocomplete: alias kolone
await win.click('.query-tab[style*="flex"] .monaco-editor')
await win.keyboard.press('Control+a')
await win.keyboard.press('Delete')
await win.keyboard.type('SELECT o. FROM sales.orders o', { delay: 5 })
for (let i = 0; i < ' FROM sales.orders o'.length; i++) await win.keyboard.press('ArrowLeft')
await win.keyboard.press('Control+Space')
await win.waitForSelector('.suggest-widget.visible')
await win.waitForTimeout(1200)
await win.screenshot({ path: `${shots}/07-autocomplete.png` })
console.log('autocomplete:', (await win.locator('.suggest-widget .monaco-list-row').allInnerTexts()).join(' | ').replace(/\n/g, ' '))
await win.keyboard.press('Escape')

// Greška
await win.keyboard.press('Control+a')
await win.keyboard.type('SELECT * FROM ne_postoji;')
await win.keyboard.press('Control+Enter')
await win.waitForSelector('.msg.error')
await win.screenshot({ path: `${shots}/08-error.png` })

// MariaDB explorer + procedura skripta
await win.click('.tree-row:has-text("MariaDB dev")')
const maria = win.locator('.tree > div', { hasText: 'MariaDB dev' })
await maria.locator('.tree-row:has(.tree-label:text-is("shop"))').click()
await maria.locator('.tree-row:has-text("Procedure")').click()
await maria.locator('.tree-row:has(.tree-label:text-is("get_orders"))').click({ button: 'right' })
await win.waitForSelector('.context-menu')
await win.screenshot({ path: `${shots}/09-context-menu.png` })
await win.click('.context-menu-item:has-text("Skripta")')
await win.waitForTimeout(800)
await win.screenshot({ path: `${shots}/10-maria-script.png` })
// izvrši skriptu (DELIMITER) pa pozovi proceduru
await win.click('.query-tab[style*="flex"] .monaco-editor')
await win.keyboard.press('Control+End')
await win.keyboard.press('Enter')
await win.keyboard.type('CALL get_orders(1, @c); SELECT @c AS ukupno_narudzbi;')
await win.keyboard.press('Escape')
const create = (await win.locator('.query-tab[style*="flex"] .view-lines').innerText())
console.log('skripta počinje s:', create.split('\n')[0])
await win.keyboard.press('Control+a')
await win.keyboard.type('DROP PROCEDURE IF EXISTS get_orders2;\nDELIMITER $$\nCREATE PROCEDURE get_orders2(IN p INT) BEGIN SELECT * FROM orders WHERE customer_id = p; SELECT COUNT(*) AS n FROM orders; END$$\nDELIMITER ;\nCALL get_orders2(1);')
await win.keyboard.press('Escape')
await win.keyboard.press('Control+Enter')
await win.waitForSelector('.query-tab[style*="flex"] .result-tabs button:has-text("Rezultat 2")')
await win.screenshot({ path: `${shots}/10b-maria-call.png` })

// Dugi upit + prekid
await win.keyboard.press('Control+t')
await win.waitForTimeout(400)
await win.click('.query-tab[style*="flex"] .monaco-editor')
await win.keyboard.type('SELECT SLEEP(20);')
await win.keyboard.press('F5')
await win.waitForSelector('.status.running')
await win.waitForTimeout(1200)
await win.screenshot({ path: `${shots}/11-running.png` })
await win.keyboard.press('Escape')
await win.waitForSelector('.query-tab[style*="flex"] .result-status')
console.log('nakon prekida:', await win.locator('.query-tab[style*="flex"] .results-pane').innerText())

// Velik rezultat — virtualizacija
await win.click('.query-tab[style*="flex"] .monaco-editor')
await win.keyboard.press('Control+a')
await win.keyboard.type('SELECT seq AS id, MD5(seq) AS hash, NOW() AS t FROM seq_1_to_100000;')
const t0 = Date.now()
await win.keyboard.press('Control+Enter')
await win.waitForSelector('.query-tab[style*="flex"] .result-status:has-text("redaka")')
console.log('100k redaka do prikaza:', Date.now() - t0, 'ms')
await win.locator('.query-tab[style*="flex"] .grid').evaluate((el) => (el.scrollTop = 24 * 60000))
await win.waitForTimeout(200)
await win.screenshot({ path: `${shots}/12-100k.png` })

console.log('OK')
await app.close()
