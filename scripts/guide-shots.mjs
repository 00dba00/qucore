// Snimke zaslona za docs/guide (korisnički vodič).
//
// Pokretanje (nakon `npx electron-vite build`):
//   Demo baza (preporučeno, bez stvarnih podataka):
//     npm run db:up && npm run db:demo
//     GUIDE_PROFILE=<prazna mapa> node scripts/guide-shots.mjs
//   Vlastita konekcija:
//     GUIDE_PROFILE=<prazna mapa> GUIDE_SOURCE="%APPDATA%/QuCore" GUIDE_DB=<baza> node scripts/guide-shots.mjs
//
// - Radi na PRIVREMENOM profilu (QUCORE_USER_DATA), pa pravi profil korisnika ostaje netaknut. Mapu GUIDE_PROFILE obriši nakon snimanja.
// - Bez GUIDE_SOURCE: konekcija na demo bazu "demo" iz docker/compose.yml (MariaDB 127.0.0.1:13306, korisnik guide
//   koji vidi samo tu bazu; stvara ga scripts/seed-demo-db.ts).
// - S GUIDE_SOURCE: iz te mape kopira samo connections.json i Local State (ključ za lozinke) i koristi prvu konekciju
//   (MariaDB/MySQL) i bazu GUIDE_DB.
// - Na bazi izvršava samo SELECT, SLEEP i DATABASE(); naredbe koje pišu samo otvaraju potvrdu koja se otkaže.
// - Svaka snimka je zasebna: ako jedna ne uspije, ostale se svejedno rade (popis grešaka na kraju).
import { _electron as electron } from 'playwright-core'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { en } from '../src/shared/locales/en.ts'
import { hr } from '../src/shared/locales/hr.ts'

const profile = process.env.GUIDE_PROFILE
const source = process.env.GUIDE_SOURCE
const DEMO = !source
const DB = DEMO ? (process.env.GUIDE_DB ?? 'demo') : process.env.GUIDE_DB
if (!profile || !DB) throw new Error('Postavi GUIDE_PROFILE (i uz GUIDE_SOURCE još GUIDE_DB).')
// Jezik snimki (GUIDE_LANG=hr|en): hrvatske idu u docs/guide/img, engleske u docs/guide/img/en.
const LANG = process.env.GUIDE_LANG === 'en' ? 'en' : 'hr'
const out = join(process.cwd(), 'docs', 'guide', 'img', ...(LANG === 'en' ? ['en'] : []))
/** Tekst iz kataloga aplikacije (isti koji vidi korisnik), za selektore. */
const M = LANG === 'en' ? en : hr
const T = (key, ...args) => (typeof M[key] === 'function' ? M[key](...args) : M[key])
/** Bez završnog "…" (npr. "Projekti…") za has-text. */
const TT = (key, ...args) => T(key, ...args).replace(/….*$/, '')
/** Demo sadržaj (nazivi projekata, queryja, snippeta, datoteka) na jeziku snimki. */
const D =
  LANG === 'en'
    ? {
        connName: 'Analytics (MariaDB)', localServer: 'Local SQL Server', project: 'Demo analytics', projectDesc: 'Sample project for the guide',
        reports: 'Reports', folder: 'Database overview', subfolder: 'Database overview/Indexes',
        big: 'Biggest tables', bigDesc: 'Ticket DEMO-101: which tables grow fastest', cols: 'Columns by type', colsAlias: 'column_count', param: 'schema',
        idx: 'Table indexes', idxParam: 'table', old: 'Old report (missing table)', snip7: 'Last 7 days', snipSchema: 'Project schema',
        connDlgName: 'Production ERP', connDlgHost: 'sql01.company.local', file: 'biggest-tables.sql', fileComment: 'Biggest tables in the database',
        valueSql: `SELECT JSON_OBJECT('customer', 'Ana', 'items', JSON_ARRAY(1, 2, 3)) AS order_json,\n  '<order id="7"><item>coffee</item></order>' AS xml_column,\n  42 AS number`,
        pause: 'pause', guideChapter: 'Projects', qs: 'tab', jobName: 'Daily table export', jobTable: 'table_overview', httpJob: 'Tables to the catalog'
      }
    : {
        connName: 'Analitika (MariaDB)', localServer: 'Lokalni SQL Server', project: 'Demo analitika', projectDesc: 'Primjer projekta za vodič',
        reports: 'Izvještaji', folder: 'Pregled baze', subfolder: 'Pregled baze/Indeksi',
        big: 'Najveće tablice', bigDesc: 'Ticket DEMO-101: koje tablice rastu najbrže', cols: 'Kolone po tipu', colsAlias: 'kolona', param: 'shema',
        idx: 'Indeksi tablice', idxParam: 'tablica', old: 'Stari izvještaj (nestala tablica)', snip7: 'Zadnjih 7 dana', snipSchema: 'Shema projekta',
        connDlgName: 'Produkcija ERP', connDlgHost: 'sql01.firma.local', file: 'velike-tablice.sql', fileComment: 'Najveće tablice u bazi',
        valueSql: `SELECT JSON_OBJECT('kupac', 'Ana', 'stavke', JSON_ARRAY(1, 2, 3)) AS narudzba,\n  '<narudzba id="7"><stavka>kava</stavka></narudzba>' AS xml_stupac,\n  42 AS broj`,
        pause: 'pauza', guideChapter: 'Projekti', qs: 'tab', jobName: 'Dnevni izvoz tablica', jobTable: 'pregled_tablica', httpJob: 'Tablice u katalog'
      }
mkdirSync(out, { recursive: true })
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })
let conn
if (!DEMO) {
  for (const f of ['connections.json', 'Local State']) copyFileSync(join(source, f), join(profile, f))
  const conns = JSON.parse(readFileSync(join(profile, 'connections.json'), 'utf8'))
  conn = (Array.isArray(conns) ? conns : conns.connections)[0]
}
const IS = 'information_schema'
// Upiti za snimke: na demo bazi stvarne tablice trgovine, inače samo information_schema (bez stvarnih podataka).
const Q = DEMO
  ? {
      tabDb: DB,
      acType: 'SELECT * FROM ord',
      results: 'SELECT c.first_name, c.last_name, r.name AS region, COUNT(o.id) AS orders, SUM(o.total) AS revenue\nFROM customers c\nJOIN regions r ON r.id = c.region_id\nJOIN orders o ON o.customer_id = c.id\nGROUP BY c.id, c.first_name, c.last_name, r.name\nORDER BY revenue DESC\nLIMIT 20',
      filterList: 'SELECT id, order_date, status, channel, total\nFROM orders\nORDER BY order_date DESC\nLIMIT 300',
      quickFilter: 'mobile',
      tx: "SELECT id, order_date, status, total\nFROM orders\nWHERE status = 'new'\nLIMIT 10",
      copy: 'SELECT sku, name, price, stock\nFROM products\nORDER BY name\nLIMIT 15',
      plan: 'SELECT c.segment, COUNT(*) AS orders, SUM(o.total) AS revenue\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.order_date >= CURRENT_DATE - INTERVAL 90 DAY\nGROUP BY c.segment\nORDER BY revenue DESC',
      loadMore: 'SELECT order_id, line_no, product_id, quantity, unit_price\nFROM order_items',
      history: (n) => `SELECT id, order_date, total FROM orders ORDER BY total DESC LIMIT ${n}`,
      save: 'SELECT sku, name, category, supplier, stock\nFROM v_low_stock',
      versionTail: '\nORDER BY stock',
      saveTitle: LANG === 'en' ? 'Products running low' : 'Proizvodi pri kraju zalihe',
      saveDesc: LANG === 'en' ? 'Stock under 15 pieces, discontinued products left out' : 'Zaliha ispod 15 komada, bez ukinutih proizvoda',
      suggest: (n) => `SELECT COUNT(*) AS orders FROM orders WHERE total > ${n * 100}`,
      guardTable: 'orders',
      erTable: 'orders'
    }
  : {
      tabDb: IS,
      acType: 'SELECT * FROM inf',
      results: `SELECT table_name, table_rows, data_length\nFROM information_schema.tables\nWHERE table_schema = '${DB}'\nORDER BY data_length DESC\nLIMIT 20`,
      filterList: "SELECT table_name, table_type, engine\nFROM information_schema.tables\nWHERE table_schema = 'information_schema'\nORDER BY 1",
      quickFilter: 'col',
      tx: `SELECT table_name, table_rows\nFROM information_schema.tables\nWHERE table_schema = '${IS}'\nLIMIT 10`,
      copy: "SELECT table_name, table_type, engine\nFROM information_schema.tables\nWHERE table_schema = 'information_schema'\nORDER BY 1\nLIMIT 15",
      plan: `SELECT t.table_name, COUNT(*) AS stupaca\nFROM information_schema.tables t\nJOIN information_schema.columns c ON c.table_schema = t.table_schema AND c.table_name = t.table_name\nWHERE t.table_schema = '${IS}'\nGROUP BY t.table_name\nORDER BY stupaca DESC`,
      loadMore: 'SELECT table_name, column_name, data_type\nFROM information_schema.columns',
      history: (n) => `SELECT table_name FROM information_schema.tables LIMIT ${n}`,
      save: "SELECT table_name, create_time\nFROM information_schema.tables\nWHERE table_schema = 'information_schema'",
      versionTail: '\nORDER BY table_name',
      saveTitle: LANG === 'en' ? 'System tables' : 'Sistemske tablice',
      saveDesc: LANG === 'en' ? 'Tables in information_schema' : 'Popis tablica u information_schema',
      suggest: (n) => `SELECT COUNT(*) AS tablica FROM information_schema.tables WHERE table_rows > ${n * 100}`,
      guardTable: 'demo_orders',
      // Tablica koju ER snimka istakne i zumira (mora postojati u GUIDE_DB).
      erTable: process.env.GUIDE_ER_TABLE ?? 'orders'
    }

const env = { ...process.env, NODE_ENV: 'production', QUCORE_USER_DATA: profile }
let app = await electron.launch({ args: ['.'], env })
let win = await app.firstWindow()
await win.setViewportSize({ width: 1400, height: 860 })
// Udaljena baza se zna sporo spajati; 90 s po koraku.
win.setDefaultTimeout(90000)
const failures = []
const active = '.query-tab[style*="flex"]'

async function shot(name, target) {
  const path = join(out, name + '.jpg')
  if (target) await win.locator(target).first().screenshot({ path, type: 'jpeg', quality: 85 })
  else await win.screenshot({ path, type: 'jpeg', quality: 85 })
}
async function step(name, fn) {
  try {
    await fn()
    console.log('  ✓', name)
  } catch (e) {
    failures.push(name)
    console.log('  ✗', name, (e.message || '').split('\n')[0])
    // Snimka stanja u trenutku greške (u privremenom profilu, briše se s njim) — za dijagnozu.
    if (process.env.GUIDE_FAIL_SHOTS) await win.screenshot({ path: join(process.env.GUIDE_FAIL_SHOTS, `fail-${name}.png`) }).catch(() => {})
    await win.keyboard.press('Escape').catch(() => {})
    await win.keyboard.press('Escape').catch(() => {})
  }
}
const waitRun = async () => {
  await win.waitForTimeout(300)
  await win.waitForFunction(() => !document.querySelector('.query-tab[style*="flex"] .status.running'), null, { timeout: 60000 })
  await win.waitForTimeout(250)
}
const setSql = async (sql) => {
  await win.click(`${active} .monaco-editor`)
  await win.keyboard.press('Control+a')
  await win.keyboard.press('Delete')
  await win.keyboard.type(sql)
  await win.keyboard.press('Escape')
}
const runSql = async (sql) => {
  await setSql(sql)
  await win.keyboard.press('F5')
  await waitRun()
}
const newTab = async () => {
  await win.keyboard.press('Control+t')
  await win.waitForTimeout(400)
}
const closeAllTabs = async () => {
  while (await win.locator('.tab').count()) {
    await win.locator('.tab .tab-close').first().click()
    await win.waitForTimeout(100)
  }
}
const panel = async (title) => {
  await win.click(`.sidebar-tab[title="${title}"]`)
  await win.waitForTimeout(300)
}
const dbRow = (db) => `.tree-row:has(.k-database):has(.tree-label:text-is("${db}"))`
const CONN_NAME = D.connName
const connRow = `.tree-row:has(.k-server):has-text("${CONN_NAME}")`
/** Explorer s otvorenom konekcijom (promjena projekta ponovno iscrta čvor zatvoren). */
const showDb = async (db) => {
  await panel(T('app.connections'))
  if (!(await win.locator(dbRow(db)).count())) await win.click(connRow)
  await win.waitForSelector(dbRow(db))
}

await win.waitForSelector('.project-picker')

if (DEMO) {
  conn = await win.evaluate(() =>
    window.api.connections.save({ id: '', name: 'Demo', type: 'mariadb', host: '127.0.0.1', port: 13306, user: 'guide', password: 'guide', database: 'demo' })
  )
}

// ---------- Priprema demo podataka (samo u privremenom profilu) ----------
await win.evaluate(
  async ({ c, DB, IS, D }) => {
    const full = await window.api.connections.get(c.id)
    await window.api.connections.save({ ...full, name: D.connName, environment: 'dev', color: '#3b82f6', password: undefined })
    await window.api.connections.save({
      id: '', name: D.localServer, type: 'mssql', host: 'localhost', port: 1433, user: '', mssqlAuth: 'windows',
      environment: 'test', encrypt: true, trustServerCertificate: true, password: ''
    })
    const p = await window.api.projects.save({
      name: D.project, description: D.projectDesc, color: '#22c55e', defaultEnv: 'dev',
      databases: [{ connectionId: c.id, database: DB }, { connectionId: c.id, database: IS }]
    })
    await window.api.projects.save({ ...p, aliases: [{ name: 'core-db', targets: [{ env: 'dev', connectionId: c.id, database: IS }, { env: 'prod', connectionId: c.id, database: DB }] }] })
    await window.api.projects.save({ name: D.reports, color: '#a855f7' })
    const q = (title, sql, extra = {}) => window.api.saved.save({ title, sql, connectionId: c.id, database: IS, projectIds: [p.id], ...extra })
    await q(D.big, `SELECT table_name, table_rows, data_length\nFROM information_schema.tables\nWHERE table_schema = '${DB}'\nORDER BY data_length DESC\nLIMIT 20`, { folder: D.folder, description: D.bigDesc, pinned: true })
    await q(D.cols, `SELECT data_type, COUNT(*) AS ${D.colsAlias}\nFROM information_schema.columns\nWHERE table_schema = :${D.param}\nGROUP BY data_type\nORDER BY ${D.colsAlias} DESC`, { folder: D.folder })
    await q(D.idx, `SELECT index_name, column_name, seq_in_index\nFROM information_schema.statistics\nWHERE table_schema = '${DB}' AND table_name = \${${D.idxParam}}`, { folder: D.subfolder })
    await q(D.old, 'SELECT * FROM demo_old_report r JOIN tables t ON 1 = 0', { connectionId: c.id, database: DB })
    await window.api.snippets.save({ projectId: null, name: D.snip7, body: 'WHERE created_at >= CURRENT_DATE - INTERVAL 7 DAY' })
    await window.api.snippets.save({ projectId: p.id, name: D.snipSchema, body: `table_schema = '${DB}'` })
  },
  { c: conn, DB, IS, D }
)
// Snimke su na jeziku vodiča (GUIDE_LANG, zadano hr): novi profil bi inače uzeo jezik sustava.
await win.evaluate((lang) => {
  const key = 'qucore.settings.v1'
  localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), language: lang }))
}, LANG)
await win.reload()
await win.waitForSelector('.project-picker')
console.log('Snimke:')

// ---------- 1. Početni zaslon ----------
await step('01-welcome', () => shot('01-welcome'))

// ---------- 2. Konekcije ----------
await step('02-connection-dialog', async () => {
  await win.click(`.sidebar-tabs .icon-btn[title="${T('conn.new')}"]`)
  await win.click('.type-picker button:has-text("SQL Server")')
  await win.fill('.form-grid input >> nth=0', D.connDlgName)
  await win.fill('.form-grid input >> nth=1', D.connDlgHost)
  await win.selectOption('.form-grid select', 'windows')
  await win.click('.env-option:has-text("prod")')
  await win.locator('.color-dot').nth(5).click()
  await shot('02-connection-dialog', '.modal')
  await win.click(`.modal button:has-text("${T('common.cancel')}")`)
})

await step('03-explorer', async () => {
  await win.click(connRow)
  await win.waitForSelector(dbRow(DB))
  await win.waitForSelector(`.tree-row:has-text("${T('kind.table')}")`)
  await win.waitForTimeout(400)
  await shot('03-explorer')
})

await step('04-explorer-menu', async () => {
  const table = win.locator('.tree-row:has(.k-table)').nth(2)
  await table.click({ button: 'right' })
  await win.waitForSelector('.context-menu')
  await shot('04-explorer-menu')
  await win.keyboard.press('Escape')
  await win.mouse.click(700, 700)
})

await step('33-generate-sql', async () => {
  // Predložak INSERT-a (struktura tablice, bez podataka); tab se zatvara bez izvršavanja.
  const table = win.locator('.tree-row:has(.k-table)').nth(2)
  await table.click({ button: 'right' })
  await win.locator(`.context-menu >> text=${T('explorer.gen', 'INSERT')}`).click()
  await win.waitForSelector('.tab.active:has-text("INSERT")')
  await win.waitForTimeout(500)
  await shot('33-generate-sql')
  await win.keyboard.press('Control+w')
})

await step('34-table-tab', async () => {
  // Samo struktura (Kolone) — kartica Podaci se ne otvara, pa se stvarni podaci ne prikazuju.
  const table = win.locator('.tree-row:has(.k-table)').nth(2)
  await table.click({ button: 'right' })
  await win.locator(`.context-menu >> text=${T('explorer.openTable')}`).click()
  await win.waitForSelector('.table-tab[style*="flex"] .struct-table tbody tr')
  await win.waitForTimeout(300)
  await shot('34-table-tab')
  await win.keyboard.press('Control+w')
})

// ---------- 3. Editor i rezultati ----------
await step('05-editor-results', async () => {
  await win.dblclick(dbRow(Q.tabDb))
  await win.waitForSelector(`${active} .monaco-editor`)
  await runSql(Q.results)
  await shot('05-editor-results')
})

await step('25-results-filter', async () => {
  await runSql(Q.filterList)
  const row = win.locator(`${active} .grid-row`).first()
  const engine = await row.locator('.grid-cell').nth(3).innerText()
  await row.locator('.grid-cell').nth(3).click({ button: 'right' })
  await win.locator(`.context-menu >> text=${T('grid.filter', '= ' + engine)}`).click()
  await win.locator(`${active} .grid-filter input`).fill(Q.quickFilter)
  await win.waitForTimeout(300)
  await shot('25-results-filter')
  await win.locator(`${active} .grid-filter .link-btn:has-text("${T('grid.clearFilters')}")`).click()
})

await step('26-transaction', async () => {
  // Samo SELECT: uz isključen Auto-commit i on otvara transakciju (ništa se ne piše), pa Rollback.
  await win.locator(`${active} .tx-toggle input`).uncheck()
  await runSql(Q.tx)
  await win.waitForSelector(`${active} .tx-badge`)
  await shot('26-transaction')
  await win.locator(`${active} .tx-rollback`).click()
  await win.waitForSelector(`${active} .tx-badge`, { state: 'detached' })
  await win.locator(`${active} .tx-toggle input`).check()
})

await step('27-settings', async () => {
  // Jedna promjena (bez spremanja) da se vidi upozorenje i oznaka "promijenjeno"; Odustani.
  await win.keyboard.press('Control+,')
  await win.waitForSelector('.settings-modal')
  await win.locator(`.setting-row:has-text("${T('settings.guardUnbounded.label')}") input[type=checkbox]`).uncheck()
  await shot('27-settings', '.settings-modal')
  await win.click(`.settings-modal button:has-text("${T('common.cancel')}")`)
  await win.waitForSelector('.settings-modal', { state: 'detached' })
})

await step('28-copy-export', async () => {
  // Otvori izbornik Kopiraj kao, snimi, zatvori. Prvo pričekaj da nestane toast iz prethodnog koraka.
  await win.waitForTimeout(3500)
  await runSql(Q.copy)
  await win.locator(`${active} button:has-text("${T('q.copyAs')}")`).click()
  await win.waitForSelector('.context-menu')
  await shot('28-copy-export')
  await win.keyboard.press('Escape')
  await win.mouse.click(700, 300)
})

await step('29-sql-file', async () => {
  // Datoteka u privremenom profilu; dijalog Otvori zamijenjen da vrati nju (sistemski dijalog se ne može snimiti).
  const file = join(profile, D.file)
  writeFileSync(file, `-- ${D.fileComment}\nSELECT table_name, table_rows\nFROM information_schema.tables\nWHERE table_schema = '${IS}'\nORDER BY table_rows DESC`)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await win.keyboard.press('Control+o')
  await win.waitForSelector(`.tab:has-text("${D.file}")`)
  await win.click(`${active} .monaco-editor`)
  await win.keyboard.press('Control+End')
  await win.keyboard.type('\nLIMIT 10')
  await win.keyboard.press('Escape')
  await win.waitForSelector('.tab-dirty')
  await shot('29-sql-file')
  await win.keyboard.press('Control+w')
  await win.click(`.modal button:has-text("${T('unsavedFile.dontSave')}")`)
  await win.waitForSelector(`.tab:has-text("${D.file}")`, { state: 'detached' })
})

await step('30-value-panel', async () => {
  // Samo literali (SELECT bez tablica): JSON vrijednost u panelu Vrijednost.
  // Lijepi se (ne tipka): Monaco pri tipkanju sam zatvara navodnike i pokvari ovaj SQL.
  await app.evaluate(({ clipboard }, sql) => clipboard.writeText(sql), D.valueSql)
  await win.click(`${active} .monaco-editor`)
  await win.keyboard.press('Control+a')
  await win.keyboard.press('Control+v')
  await win.keyboard.press('F5')
  await waitRun()
  await win.locator(`${active} .grid-row`).first().locator('.grid-cell:not(.rownum)').first().click()
  await win.keyboard.press('Shift+Enter')
  await win.waitForSelector(`${active} .value-code .view-lines`)
  await win.waitForTimeout(500)
  await shot('30-value-panel')
  await win.keyboard.press('Shift+Enter')
})

await step('31-plan', async () => {
  // Samo SELECT nad information_schema: plan, pa ANALYZE (SELECT se smije stvarno izvršiti).
  const sql = Q.plan
  await app.evaluate(({ clipboard }, s) => clipboard.writeText(s), sql)
  await win.click(`${active} .monaco-editor`)
  await win.keyboard.press('Control+a')
  await win.keyboard.press('Control+v')
  await win.keyboard.press('Control+Shift+e')
  await win.waitForSelector(`${active} .plan-view`)
  await win.locator(`${active} .plan-head button:has-text("ANALYZE")`).click()
  await win.waitForFunction((txt) => document.querySelector('.query-tab[style*="flex"] .plan-head')?.textContent?.includes(txt), T('plan.executed'))
  await win.waitForTimeout(300)
  await shot('31-plan')
})

await step('32-find-replace', async () => {
  await app.evaluate(({ clipboard }) =>
    clipboard.writeText("SELECT table_name, table_rows\nFROM information_schema.tables\nWHERE table_name LIKE 'C%'\nORDER BY table_name")
  )
  await win.click(`${active} .monaco-editor`)
  await win.keyboard.press('Control+a')
  await win.keyboard.press('Control+v')
  await win.keyboard.press('Control+Home')
  await win.keyboard.press('Control+f')
  await win.waitForSelector(`${active} .find-widget.visible`)
  await win.keyboard.press('Control+a')
  await win.keyboard.type('table_name')
  // Ctrl+H otvara polje zamjene i fokusira ga (traženi tekst ostaje).
  await win.keyboard.press('Control+h')
  await win.keyboard.type('TABLE_NAME')
  await win.waitForTimeout(300)
  await shot('32-find-replace')
  await win.keyboard.press('Escape')
})

await step('06-autocomplete', async () => {
  await newTab()
  await win.selectOption(`${active} .toolbar select >> nth=1`, Q.tabDb).catch(() => {})
  await win.click(`${active} .monaco-editor`)
  await win.keyboard.type(Q.acType)
  await win.keyboard.press('Control+Space')
  await win.waitForTimeout(800)
  await shot('06-autocomplete')
  await win.keyboard.press('Escape')
})

await step('07-load-more', async () => {
  await win.selectOption(`${active} .toolbar select:near(:text("${T('q.maxRows')}"))`, '1000')
  await runSql(Q.loadMore)
  await win.waitForSelector(`${active} .more-bar`)
  await shot('07-load-more')
  await win.click(`${active} .more-bar button:has-text("${T('common.close')}")`)
  await waitRun()
})

await step('08-er-diagram', async () => {
  await win.click(dbRow(DB), { button: 'right' })
  await win.click(`.context-menu-item:has-text("${T('explorer.erDiagram')}")`)
  await win.waitForSelector('.react-flow__node', { timeout: 60000 })
  await win.waitForTimeout(2500)
  // Cijela baza je presitna za čitanje: pretraga ističe tablicu, Enter zumira na nju.
  await win.fill(`input[placeholder="${T('diagram.search')}"]`, Q.erTable)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1500)
  await shot('08-er-diagram')
})

// ---------- 4. Povijest ----------
await step('09-history', async () => {
  await closeAllTabs()
  await win.dblclick(dbRow(Q.tabDb))
  await win.waitForSelector(`${active} .monaco-editor`)
  for (const n of [5, 10, 15]) await runSql(Q.history(n))
  await panel(T('app.historyTitle'))
  await win.waitForTimeout(400)
  await shot('09-history')
})

// ---------- 5. Projekti ----------
await step('10-projects-dialog', async () => {
  await win.selectOption('.project-picker select', { label: D.project })
  await win.click('.project-picker .icon-btn')
  await win.click(`.projects-item:has-text("${D.project}")`)
  await win.waitForTimeout(300)
  await shot('10-projects-dialog', '.modal')
  await win.click(`.modal button:has-text("${T('common.close')}")`)
})

await step('11-db-projects', async () => {
  await showDb(DB)
  await win.click(dbRow(DB), { button: 'right' })
  await win.click(`.context-menu-item:has-text("${TT('explorer.projects')}")`)
  await shot('11-db-projects', '.modal')
  await win.click(`.modal button:has-text("${T('common.cancel')}")`)
})

// ---------- 6. Spremljeni queryji ----------
await step('12-save-dialog', async () => {
  await newTab()
  await setSql(Q.save)
  await win.keyboard.press('Control+s')
  await win.waitForSelector(`.modal h2:has-text("${T('saved.titleNew')}")`)
  await win.fill('.modal .form-grid input >> nth=0', Q.saveTitle)
  await win.fill('.modal textarea', Q.saveDesc)
  await win.fill('.modal input[list="saved-folders"]', D.folder)
  await shot('12-save-dialog', '.modal')
  await win.click(`.modal button:has-text("${T('common.save')}")`)
  await win.waitForSelector('.modal', { state: 'detached' })
})

await step('13-saved-panel', async () => {
  // Najveće tablice pokreni par puta (Nedavno pokretano, ×N, trend), pa učitaj objekte baze (provjera sheme).
  await panel(T('app.savedTitle'))
  await win.dblclick(`.saved-row:has-text("${D.big}")`)
  await win.waitForTimeout(400)
  for (let k = 0; k < 3; k++) {
    await win.click(`${active} .monaco-editor`)
    await win.keyboard.press('F5')
    await waitRun()
  }
  await showDb(DB)
  // Otvori bazu samo ako je zatvorena (klik na otvorenu bi je zatvorio).
  if (!(await win.locator(`.tree-row:has-text("${T('kind.table')}")`).count())) await win.click(dbRow(DB))
  await win.waitForSelector(`.tree-row:has-text("${T('kind.table')}")`)
  await win.waitForTimeout(1200)
  await panel(T('app.savedTitle'))
  await win.waitForTimeout(500)
  await shot('13-saved-panel')
})

await step('14-search-help', async () => {
  await panel(T('app.savedTitle'))
  await win.fill('.history:visible .explorer-filter input', 'table:tables type:select')
  await win.click('.history:visible .search-help-btn')
  await win.waitForTimeout(500)
  await shot('14-search-help')
  await win.click('.history:visible .search-help-btn')
  await win.fill('.history:visible .explorer-filter input', '')
})

await step('15-versions', async () => {
  // Druga verzija: dodaj ORDER BY i spremi.
  await panel(T('app.savedTitle'))
  await win.dblclick(`.saved-row:has-text("${Q.saveTitle}")`)
  await win.waitForTimeout(400)
  await win.click(`${active} .monaco-editor`)
  await win.keyboard.press('Control+End')
  await win.keyboard.type(Q.versionTail)
  await win.keyboard.press('Control+s')
  await win.waitForTimeout(400)
  for (let k = 0; k < 2; k++) {
    await win.keyboard.press('F5')
    await waitRun()
  }
  await win.click(`.saved-row:has-text("${D.big}")`, { button: 'right' })
  await win.click(`.context-menu-item:has-text("${TT('saved.versions', 0)}")`)
  await win.waitForSelector('.history-modal')
  await win.click(`.history-modal button:has-text("${T('common.close')}")`)
  await win.click(`.saved-row:has-text("${Q.saveTitle}")`, { button: 'right' })
  await win.click(`.context-menu-item:has-text("${TT('saved.versions', 0)}")`)
  await win.waitForSelector('.history-modal .monaco-diff-editor')
  await win.waitForTimeout(800)
  await shot('15-versions', '.modal')
  await win.click(`.history-modal button:has-text("${T('common.close')}")`)
})

await step('16-suggest-save', async () => {
  await newTab()
  for (const n of [1, 2, 3, 4, 5]) await runSql(Q.suggest(n))
  await win.waitForSelector(`${active} .suggest-bar`)
  await shot('16-suggest-save')
})

// ---------- 7. Aliasi i varijable ----------
await step('17-alias-tab', async () => {
  await panel(T('app.savedTitle'))
  await win.dblclick(`.saved-row:has-text("${D.cols}")`)
  await win.waitForTimeout(400)
  await win.click(`${active} .monaco-editor`)
  await win.keyboard.press('Control+s')
  await win.waitForTimeout(200)
  // Veži na alias kroz dijalog
  await win.click(`.saved-row:has-text("${D.cols}")`, { button: 'right' })
  await win.click(`.context-menu-item:has-text("${TT('saved.editMeta')}")`)
  await win.locator('.modal select').first().selectOption({ label: /core-db/ }).catch(async () => {
    const opts = await win.locator('.modal select').first().locator('option').allTextContents()
    await win.locator('.modal select').first().selectOption({ label: opts.find((o) => o.includes('core-db')) })
  })
  await win.click(`.modal button:has-text("${T('common.save')}")`)
  await win.waitForSelector('.modal', { state: 'detached' })
  await closeAllTabs()
  await panel(T('app.savedTitle'))
  await win.dblclick(`.saved-row:has-text("${D.cols}")`)
  await win.waitForSelector(`${active} .alias-bar`)
  await win.waitForTimeout(800) // Monaco iscrtava ostale retke s malim zakašnjenjem
  await shot('17-alias-tab')
})

await step('18-params', async () => {
  await win.click(`${active} .monaco-editor`)
  await win.keyboard.press('F5')
  await win.waitForSelector('.params-modal')
  await win.fill(`#param-${D.param}`, DB)
  await shot('18-params', '.modal')
  await win.click(`.params-modal button:has-text("${T('guard.run')}")`)
  await waitRun()
})

// ---------- 8. Snippeti i quick switcher ----------
await step('19-snippets', async () => {
  await newTab()
  await win.click(`${active} button:has-text("${T('snippets.title')}")`)
  await win.waitForSelector('.context-menu')
  await shot('19-snippets')
  await win.keyboard.press('Escape')
  await win.mouse.click(900, 300)
})

await step('20-quick-switcher', async () => {
  await win.keyboard.press('Control+p')
  await win.waitForSelector('.quick-switcher')
  await win.keyboard.type(D.qs)
  await win.waitForTimeout(300)
  await shot('20-quick-switcher')
  await win.keyboard.press('Escape')
})

// ---------- 9. Zaštita (konekcija privremeno prod) ----------
await step('21-guard-prod', async () => {
  await win.evaluate(async (id) => {
    const full = await window.api.connections.get(id)
    await window.api.connections.save({ ...full, environment: 'prod', password: undefined })
  }, conn.id)
  await win.reload()
  await win.waitForSelector('.project-picker')
  await showDb(DB)
  await win.dblclick(dbRow(DB))
  await win.waitForSelector(`${active} .monaco-editor`)
  await setSql(`UPDATE ${Q.guardTable} SET status = 'shipped' WHERE id = 42`)
  await win.keyboard.press('F5')
  await win.waitForSelector('.guard-modal')
  await shot('21-guard-prod')
  await win.click(`.guard-modal button:has-text("${T('common.cancel')}")`)
})

await step('22-guard-unbounded', async () => {
  await setSql(`DELETE FROM ${Q.guardTable}`)
  await win.keyboard.press('F5')
  await win.waitForSelector('.guard-modal')
  await shot('22-guard-unbounded', '.modal')
  await win.click(`.guard-modal button:has-text("${T('common.cancel')}")`)
})

await step('23-anomaly', async () => {
  await newTab()
  for (let k = 0; k < 3; k++) await runSql(`SELECT SLEEP(0) AS ${D.pause}`)
  await runSql(`SELECT SLEEP(2) AS ${D.pause}`)
  await win.waitForSelector(`${active} .anomaly-bar`)
  await shot('23-anomaly')
})

// ---------- 10. Poslovi prijenosa podataka ----------
// Izvoz u CSV u privremenom profilu (dijalog za mapu zamijenjen); forma za upis u bazu se samo snimi, ne pokreće.
// Putanja privremenog profila (korisničko ime, temp mapa) se na snimci prikazuje kao neutralna mapa.
const SHOWN_FOLDER = String.raw`C:\Users\ana\Documents\Exports`
const maskFolder = (folder) =>
  win.evaluate(
    ({ folder, shown }) => {
      for (const i of document.querySelectorAll('.job-tab input')) if (i.value.startsWith(folder)) i.value = shown + i.value.slice(folder.length)
      const walk = document.createTreeWalker(document.querySelector('.job-tab[style*="flex"]') ?? document.body, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.includes(folder)) n.nodeValue = n.nodeValue.split(folder).join(shown)
      for (const el of document.querySelectorAll('[title]')) if (el.title.includes(folder)) el.title = el.title.split(folder).join(shown)
    },
    { folder, shown: SHOWN_FOLDER }
  )
await step('35-job', async () => {
  const folder = join(profile, 'exports')
  mkdirSync(folder, { recursive: true })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, folder)
  await closeAllTabs()
  await panel(T('jobs.panelTitle'))
  await win.click('.jobs-head button')
  await win.waitForSelector('.job-tab')
  await win.fill('.job-name', D.jobName)
  const src = win.locator(`section:has(h3:text-is("${T('jobs.source')}"))`)
  await src.locator(`label:text-is("${T('jobs.query')}") + select`).selectOption({ label: `${D.folder} / ${D.big}` })
  await win.click(`button:has-text("${T('jobs.chooseFolder')}")`)
  await win.waitForFunction(() => [...document.querySelectorAll('.job-tab input[readonly]')].some((i) => i.value))
  await win.click(`.job-toolbar button:has-text("${T('jobs.run')}")`)
  await win.click(`.modal button:has-text("${T('jobs.run')}")`)
  await win.waitForSelector('.job-runs tbody tr .job-status.success')
  await win.waitForTimeout(3500) // obavijest o završetku nestane
  await maskFolder(folder)
  await shot('35-job')
})

await step('36-job-database', async () => {
  const dst = win.locator(`section:has(h3:text-is("${T('jobs.destination')}"))`)
  await dst.locator(`label:has-text("${T('jobs.destDatabase')}") input`).check()
  await dst.locator(`label:text-is("${T('jobs.connection')}") + select`).selectOption({ label: `${D.connName} (prod)` })
  await dst.locator(`label:text-is("${T('jobs.database')}") + select option:text-is("${DB}")`).waitFor({ state: 'attached' })
  await dst.locator(`label:text-is("${T('jobs.database')}") + select`).selectOption(DB)
  await dst.locator('input[list="job-dest-tables"]').fill(D.jobTable)
  await dst.locator(`label:text-is("${T('jobs.writeMode')}") + .row select`).selectOption('upsert')
  await dst.locator(`label:text-is("${T('jobs.keys')}") + .row input`).fill('table_name')
  await win.locator('.job-body').evaluate((el) => (el.scrollTop = 0))
  await maskFolder(join(profile, 'exports'))
  await shot('36-job-database')
  await win.keyboard.press('Control+w')
})

await step('37-job-http', async () => {
  // Lokalni servis umjesto pravog; na snimci se adresa prikazuje kao https://catalog.example.com.
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"updated"}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await panel(T('jobs.panelTitle'))
    await win.click('.jobs-head button')
    await win.waitForSelector('.job-tab')
    await win.fill('.job-name', D.httpJob)
    const src = win.locator(`section:has(h3:text-is("${T('jobs.source')}"))`)
    const dst = win.locator(`section:has(h3:text-is("${T('jobs.destination')}"))`)
    await src.locator(`label:text-is("${T('jobs.query')}") + select`).selectOption({ label: `${D.folder} / ${D.big}` })
    await dst.locator(`label:has-text("${T('jobs.destHttp')}") input`).check()
    await dst.locator(`label:text-is("${T('jobs.http.request')}") + .row select`).selectOption('PUT')
    await dst.locator('.job-url').fill(`${base}/api/tables/{{table_name}}`)
    await dst.locator('.job-headers button').click()
    await dst.locator('.job-headers .row input >> nth=0').fill('X-Source')
    await dst.locator('.job-headers .row input >> nth=1').fill('{{job}}')
    await dst.locator('textarea').fill('{\n  "name": {{table_name}},\n  "rows": {{table_rows}},\n  "bytes": {{data_length}},\n  "checkedOn": "{{date}}"\n}')
    await dst.locator(`button:has-text("${T('jobs.http.test')}")`).click()
    await win.waitForSelector('.job-test .status-box.ok')
    await win.waitForTimeout(3500) // obavijest o spremanju nestane
    await win.evaluate(({ from, to }) => {
      for (const i of document.querySelectorAll('input')) if (i.value.includes(from)) i.value = i.value.split(from).join(to)
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.includes(from)) n.nodeValue = n.nodeValue.split(from).join(to)
    }, { from: base, to: 'https://catalog.example.com' })
    await win.locator('.job-body').evaluate((el) => (el.scrollTop = el.querySelectorAll('section')[2].offsetTop - 10))
    await shot('37-job-http')
    await win.keyboard.press('Control+w')
  } finally {
    server.close()
  }
})

// ---------- 11. Vodič u aplikaciji ----------
await step('24-guide', async () => {
  await win.keyboard.press('F1')
  await win.waitForSelector('.guide-tab .guide-chapter')
  await win.click(`.guide-chapter:has-text("${D.guideChapter}")`)
  await win.waitForTimeout(600)
  await shot('24-guide')
})

await app.close()
rmSync(profile, { recursive: true, force: true })
console.log(failures.length ? `Neuspjele snimke: ${failures.join(', ')}` : 'Sve snimke gotove.')
if (failures.length) process.exitCode = 1
