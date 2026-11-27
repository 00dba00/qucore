// Integracijski test poslova prijenosa podataka (#data-jobs) na stvarnim bazama: svaki par izvor → odredište,
// upsert, zamjena, pronalaženje retka koji pada, prekid, datoteke. Pokretanje: npm run test:jobs (nakon db:seed).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FACTORIES } from '../src/core/manager.ts'
import { ResultCollector } from '../src/core/util.ts'
import { runDataJob, JobError, probeColumns, type JobPlan } from '../src/core/jobs/engine.ts'
import { insertSql, transferValue, type TransferValue } from '../src/core/jobs/sql.ts'
import type { ConnectionConfig, DbType, JobDestination, ResultColumn } from '../src/shared/types.ts'
import { testConfigs as configs } from './test-db-config.ts'
import { setLang } from '../src/shared/i18n.ts'

setLang('hr')

let passed = 0
/** Test koji visi (npr. driver čeka pauzirani socket) pada nakon dvije minute umjesto da blokira sve. */
const TIMEOUT_MS = 120000
async function check(name: string, fn: () => Promise<void> | void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timeout ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS)))
    ])
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${(err as Error).stack}`)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
}

const resolver = { resolve: async (id: string) => configs.find((c) => c.id === id)! }
const DB = 'shop'
const N = 1203

/** Sirovi retci (bez skraćivanja za prikaz) pretvoreni kao u poslu. */
class RawCollector extends ResultCollector {
  rows: TransferValue[][] = []
  cols: ResultColumn[] = []
  dialect: DbType
  constructor(dialect: DbType) {
    super(0)
    this.dialect = dialect
  }
  override startSet(c: ResultColumn[]): number {
    if (!this.cols.length) this.cols = c
    return super.startSet(c)
  }
  override addRow(raw: unknown[]): void {
    this.rows.push(raw.map((v, i) => transferValue(v, this.dialect, this.cols[i]?.type)))
  }
}

async function withSession<T>(c: ConnectionConfig, fn: (sql: (s: string) => Promise<TransferValue[][]>) => Promise<T>): Promise<T> {
  const s = FACTORIES[c.type].session(c, DB)
  await s.open()
  try {
    return await fn(async (text) => {
      const col = new RawCollector(c.type)
      const r = await s.execute(text, col)
      if (r.error) throw new Error(`${c.id}: ${r.error}\n${text.slice(0, 300)}`)
      return col.rows
    })
  } finally {
    await s.close()
  }
}

const dropSql = (type: DbType, table: string) =>
  type === 'mssql' ? `IF OBJECT_ID('dbo.${table}') IS NOT NULL DROP TABLE dbo.${table}` : `DROP TABLE IF EXISTS ${table}`

const SRC_DDL: Record<DbType, string> = {
  postgres: 'CREATE TABLE job_src (id int PRIMARY KEY, name varchar(100), amount numeric(12,2), created timestamp(3), flag boolean, data bytea, note text)',
  mariadb:
    'CREATE TABLE job_src (id int PRIMARY KEY, name varchar(100), amount decimal(12,2), created datetime(3), flag tinyint(1), data blob, note text) DEFAULT CHARSET=utf8mb4',
  mssql: 'CREATE TABLE job_src (id int PRIMARY KEY, name nvarchar(100), amount decimal(12,2), created datetime2(3), flag bit, data varbinary(max), note nvarchar(max))'
}

const pad = (n: number, l = 2) => String(n).padStart(l, '0')
function expectedRow(i: number) {
  const d = new Date(Date.UTC(2025, 0, 2, 3, 4, 5, 123) + i * 60000)
  const created = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  return {
    id: i,
    name: i % 50 === 0 ? `O'Brien \\ ${i}` : `Kupac ${i} Šđčćž 漢字`,
    amount: (i * 1.25).toFixed(2),
    created,
    flag: i % 2 === 0,
    data: Buffer.from([i & 255, 0xde, 0xad]),
    note: i % 3 === 0 ? null : `n${i}`
  }
}

const cols = ['id', 'name', 'amount', 'created', 'flag', 'data', 'note']
const asRow = (e: ReturnType<typeof expectedRow>): TransferValue[] => [e.id, e.name, e.amount, e.created, e.flag, e.data, e.note]

/** Usporedba pročitanog retka s očekivanim, neovisno o tome kako ga baza vraća. */
function assertRow(r: TransferValue[], i: number, where: string) {
  const e = expectedRow(i)
  assert.equal(Number(r[0]), e.id, where)
  assert.equal(r[1], e.name, `${where} name ${i}`)
  assert.equal(Number(r[2]), Number(e.amount), `${where} amount ${i}`)
  assert.equal(String(r[3]).replace('T', ' ').slice(0, 23), e.created, `${where} created ${i}`)
  assert.equal(r[4] === true || Number(r[4]) === 1, e.flag, `${where} flag ${i}`)
  assert.ok(r[5] instanceof Uint8Array, `${where} data ${i} ${typeof r[5]}`)
  assert.equal(Buffer.from(r[5] as Uint8Array).toString('hex'), e.data.toString('hex'), `${where} data ${i}`)
  assert.equal(r[6], e.note, `${where} note ${i}`)
}

const dbDest = (c: ConnectionConfig, table: string, extra: Partial<Extract<JobDestination, { kind: 'database' }>> = {}): JobDestination => ({
  kind: 'database',
  connectionId: c.id,
  database: DB,
  table,
  mode: 'insert',
  keyColumns: [],
  createTable: true,
  transaction: 'all',
  ...extra
})

const plan = (src: ConnectionConfig, destination: JobDestination, sql = 'SELECT id, name, amount, created, flag, data, note FROM job_src ORDER BY id'): JobPlan => ({
  name: 'test',
  source: { connectionId: src.id, database: DB, sql },
  columns: [],
  destination,
  batchSize: 500
})

const count = (c: ConnectionConfig, table: string) => withSession(c, async (sql) => Number((await sql(`SELECT COUNT(*) AS n FROM ${table}`))[0][0]))

console.log('priprema izvora')
for (const c of configs) {
  await check(`${c.id}: job_src s ${N} redaka`, () =>
    withSession(c, async (sql) => {
      for (const tbl of ['job_src', 'job_strict', ...configs.map((s) => `job_dst_${s.id}`), 'job_up', 'job_empty']) await sql(dropSql(c.type, tbl))
      await sql(SRC_DDL[c.type])
      for (let i = 1; i <= N; i += 500) {
        const rows = []
        for (let k = i; k < Math.min(N + 1, i + 500); k++) rows.push(asRow(expectedRow(k)))
        await sql(insertSql(c.type, { database: DB, table: 'job_src' }, cols, rows))
      }
      assert.equal(Number((await sql('SELECT COUNT(*) FROM job_src'))[0][0]), N)
    })
  )
}

console.log('svaki izvor → svako odredište (nova tablica, jedna transakcija)')
for (const src of configs) {
  for (const dst of configs) {
    await check(`${src.id} → ${dst.id}`, async () => {
      const table = `job_dst_${src.id}`
      const progress: number[] = []
      const r = await runDataJob(plan(src, dbDest(dst, table)), resolver, { onProgress: (p) => progress.push(p.rowsWritten) })
      assert.equal(r.rowsRead, N)
      assert.equal(r.rowsWritten, N)
      assert.equal(r.createdTable, true)
      assert.ok(progress.length >= 3, `napredak: ${progress}`)
      const rows = await withSession(dst, (sql) => sql(`SELECT id, name, amount, created, flag, data, note FROM ${table} ORDER BY id`))
      assert.equal(rows.length, N)
      for (const i of [1, 2, 3, 50, 499, 500, 501, 1000, N]) assertRow(rows[i - 1], i, `${src.id}→${dst.id}`)
    })
  }
}

const pgSrc = configs.find((c) => c.type === 'postgres') ?? configs[0]
console.log(`upsert, zamjena, greške (izvor ${pgSrc.id})`)
for (const dst of configs) {
  await check(`${dst.id}: upsert kreira primarni ključ i ne duplicira`, async () => {
    const d = dbDest(dst, 'job_up', { mode: 'upsert', keyColumns: ['id'] })
    await runDataJob(plan(pgSrc, d), resolver)
    const r = await runDataJob(plan(pgSrc, d, "SELECT id, 'novo' AS name, amount, created, flag, data, note FROM job_src WHERE id <= 10"), resolver)
    assert.equal(r.rowsWritten, 10)
    assert.equal(await count(dst, 'job_up'), N)
    const rows = await withSession(dst, (sql) => sql('SELECT name FROM job_up WHERE id IN (5, 11) ORDER BY id'))
    assert.deepEqual(rows.map((x) => x[0]), ['novo', expectedRow(11).name])
  })
  await check(`${dst.id}: zamjena briše postojeće retke`, async () => {
    const r = await runDataJob(plan(pgSrc, dbDest(dst, 'job_up', { mode: 'replace' }), 'SELECT id, name, amount, created, flag, data, note FROM job_src WHERE id <= 100'), resolver)
    assert.equal(r.rowsWritten, 100)
    assert.equal(await count(dst, 'job_up'), 100)
  })
  await check(`${dst.id}: redak koji pada je pronađen, transakcija poništena`, async () => {
    await withSession(dst, (sql) => sql(`CREATE TABLE job_strict (id int, name varchar(100) NOT NULL)`))
    const sql = 'SELECT id, CASE WHEN id = 777 THEN NULL ELSE name END AS name FROM job_src ORDER BY id'
    await assert.rejects(runDataJob(plan(pgSrc, dbDest(dst, 'job_strict', { createTable: false }), sql), resolver), (e: unknown) => {
      assert.ok(e instanceof JobError, String(e))
      assert.equal(e.failedRowNumber, 777, e.message)
      assert.equal(e.failedRow?.id, 777)
      assert.match(e.message, /777/)
      assert.equal(e.counts.rowsWritten, 500)
      return true
    })
    assert.equal(await count(dst, 'job_strict'), 0)
    // Commit po paketu: prvi paket ostaje.
    await assert.rejects(runDataJob(plan(pgSrc, dbDest(dst, 'job_strict', { createTable: false, transaction: 'batch' }), sql), resolver))
    assert.equal(await count(dst, 'job_strict'), 500)
  })
  await check(`${dst.id}: nepostojeći stupac i tablica bez kreiranja`, async () => {
    await assert.rejects(runDataJob(plan(pgSrc, dbDest(dst, 'job_strict', { createTable: false })), resolver), /nema stupce: amount, created, flag, data, note/)
    await assert.rejects(runDataJob(plan(pgSrc, dbDest(dst, 'job_nema', { createTable: false })), resolver), /ne postoji/)
  })
  await check(`${dst.id}: prazan izvor kreira praznu tablicu`, async () => {
    const r = await runDataJob(plan(pgSrc, dbDest(dst, 'job_empty'), 'SELECT id, name FROM job_src WHERE 1 = 0'), resolver)
    assert.equal(r.rowsWritten, 0)
    assert.equal(await count(dst, 'job_empty'), 0)
  })
}

const msSrc = configs.find((c) => c.type === 'mssql')
if (msSrc) {
  await check('mssql: samo prvi result set se prenosi', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qucore-jobs-'))
    try {
      const r = await runDataJob(
        plan(msSrc, { kind: 'file', format: 'json', folder: dir, fileName: 'x', ifExists: 'overwrite' }, 'SELECT 1 AS a; SELECT 2 AS b'),
        resolver
      )
      assert.equal(r.rowsRead, 1)
      assert.equal(r.ignoredSets, 1)
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'x.json'), 'utf8')), [{ a: 1 }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

console.log(`datoteke (izvor ${pgSrc.id})`)
const dir = mkdtempSync(join(tmpdir(), 'qucore-jobs-'))
await check('CSV, JSON i XLSX; mapiranje i konstanta; nova datoteka', async () => {
  const file = (format: 'csv' | 'json' | 'xlsx', ifExists: 'overwrite' | 'new' = 'overwrite'): JobDestination => ({ kind: 'file', format, folder: dir, fileName: '{job}-{date}', ifExists })
  const now = new Date(2026, 10, 27, 14, 30, 5)
  const csv = await runDataJob(plan(pgSrc, file('csv')), resolver, { now })
  assert.equal(csv.target, join(dir, 'test-2026-11-27.csv'))
  const lines = readFileSync(csv.target, 'utf8').split('\r\n')
  assert.equal(lines[0], '﻿id;name;amount;created;flag;data;note')
  assert.equal(lines.length, N + 2) // zaglavlje + retci + prazan kraj
  assert.equal(lines[1], `1;Kupac 1 Šđčćž 漢字;1.25;2025-01-02 03:05:05.123;false;0x01DEAD;n1`)

  const p = plan(pgSrc, file('json'))
  p.columns = [{ target: 'kod', source: 'ID' }, { target: 'izvor', constant: 'pg' }, { target: 'iznos', source: 'amount' }]
  const json = await runDataJob(p, resolver, { now })
  const data = JSON.parse(readFileSync(json.target, 'utf8')) as Record<string, unknown>[]
  assert.equal(data.length, N)
  assert.deepEqual(data[3], { kod: 4, izvor: 'pg', iznos: 5 })

  const xlsx = await runDataJob(plan(pgSrc, file('xlsx')), resolver, { now })
  assert.equal(readFileSync(xlsx.target).subarray(0, 2).toString(), 'PK')

  const again = await runDataJob(plan(pgSrc, file('csv', 'new')), resolver, { now })
  assert.equal(again.target, join(dir, 'test-2026-11-27 (2).csv'))
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.part')))
})
await check('prazan izvor: CSV samo sa zaglavljem; neuspjeh ne ostavlja datoteku', async () => {
  const d: JobDestination = { kind: 'file', format: 'csv', folder: dir, fileName: 'prazno', ifExists: 'overwrite' }
  const r = await runDataJob(plan(pgSrc, d, 'SELECT id, name FROM job_src WHERE 1 = 0'), resolver)
  assert.equal(readFileSync(r.target, 'utf8'), '﻿id;name\r\n')
  const bad: JobDestination = { ...d, fileName: 'pada' }
  await assert.rejects(runDataJob(plan(pgSrc, bad, 'SELECT id, 1 / (id - 700) AS x FROM job_src ORDER BY id'), resolver))
  assert.ok(!existsSync(join(dir, 'pada.csv')) && !existsSync(join(dir, 'pada.csv.part')))
})
rmSync(dir, { recursive: true, force: true })

console.log('prekid i stupci izvora')
for (const dst of configs) {
  await check(`${pgSrc.id} → ${dst.id}: prekid poništava upisano`, async () => {
    const abort = new AbortController()
    const big = plan(pgSrc, dbDest(dst, `job_dst_${pgSrc.id}`, { mode: 'replace', createTable: false }), 'SELECT g AS id, md5(g::text) AS name, 1.5 AS amount, now()::timestamp(3) AS created, true AS flag, NULL::bytea AS data, NULL AS note FROM generate_series(1, 3000000) g')
    let written = 0
    const run = runDataJob(big, resolver, {
      signal: abort.signal,
      onProgress: (p) => {
        written = p.rowsWritten
        if (p.rowsWritten >= 1000) abort.abort()
      }
    })
    await assert.rejects(run, (e: unknown) => e instanceof JobError && e.cancelled)
    assert.ok(written >= 1000)
    assert.equal(await count(dst, `job_dst_${pgSrc.id}`), N)
  })
}
for (const src of configs) {
  await check(`${src.id}: stupci izvora bez čitanja svih redaka`, async () => {
    const c = await probeColumns({ connectionId: src.id, database: DB, sql: 'SELECT id, name FROM job_src' }, resolver)
    assert.deepEqual(c.map((x) => x.name), ['id', 'name'])
    const empty = await probeColumns({ connectionId: src.id, database: DB, sql: 'SELECT id, name FROM job_src WHERE 1 = 0' }, resolver)
    assert.deepEqual(empty.map((x) => x.name), ['id', 'name'])
  })
}

console.log(`\n${passed} testova prošlo${process.exitCode ? ', IMA GREŠAKA' : ''}`)
// Ako neka konekcija ostane visjeti nakon greške, test ipak završava.
process.exit(process.exitCode ?? 0)
