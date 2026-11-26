// Integracijski test core sloja na stvarnim bazama.
// Pokretanje: npm run test:core  (konfiguracija preko env varijabli, vidi dolje)
import assert from 'node:assert/strict'
import { ConnectionManager } from '../src/core/manager.ts'
import { ResultCollector, splitGoBatches } from '../src/core/util.ts'
import type { QueryProgress } from '../src/shared/types.ts'
import { splitDelimiterScript } from '../src/core/drivers/mariadb.ts'
import { assertOneRow, buildEditStatements, literalSql } from '../src/core/edits.ts'
import { testConfigs as configs } from './test-db-config.ts'
import { setLang } from '../src/shared/i18n.ts'

// Provjere poruka su pisane za hrvatski.
setLang('hr')

let passed = 0
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${(err as Error).stack}`)
    process.exitCode = 1
  }
}

console.log('util')
await check('GO splitter', () => {
  const b = splitGoBatches("SELECT 1\nGO\n/* GO\n*/ SELECT 'x\nGO\n'\ngo 2\nSELECT 3")
  assert.equal(b.length, 4)
  assert.equal(b[0].text, 'SELECT 1')
  assert.equal(b[1].startLine, 3)
  assert.equal(b[3].text, 'SELECT 3')
})
await check('DELIMITER splitter', () => {
  const s = splitDelimiterScript('DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 1; SELECT 2;')
  assert.equal(s.length, 2)
  assert.match(s[0], /SELECT 1; SELECT 2; END$/)
})

await check('ResultCollector: limit, brojanje, dojave', () => {
  const progress: QueryProgress[] = []
  const c = new ResultCollector(1000, (p) => progress.push(p))
  c.startSet([{ name: 'n' }])
  for (let i = 0; i < 5000; i++) c.addRow([i, new Date(2025, 0, 2, 3, 4, 5)])
  c.endSet()
  c.startSet([{ name: 'empty' }])
  c.flush()
  assert.equal(c.sets.length, 2)
  assert.equal(c.sets[0].rows.length, 1000)
  assert.equal(c.sets[0].totalRows, 5000)
  assert.equal(c.sets[0].truncated, true)
  assert.equal(c.sets[0].rows[999][0], 999)
  assert.equal(c.sets[0].rows[0][1], '2025-01-02 03:04:05.000')
  assert.equal(c.sets[1].totalRows, 0)
  // Dojave nadovezuju retke bez ponavljanja; kolone samo u prvoj dojavi seta.
  const rows0 = progress.flatMap((p) => p.sets.filter((d) => d.index === 0).flatMap((d) => d.rows))
  assert.deepEqual(rows0.map((r) => r[0]), c.sets[0].rows.map((r) => r[0]))
  assert.equal(progress.flatMap((p) => p.sets.filter((d) => d.index === 0 && d.columns)).length, 1)
  const last = progress.at(-1)!
  assert.equal(last.sets.find((d) => d.index === 0)?.totalRows ?? 5000, 5000)
  assert.deepEqual(last.sets.find((d) => d.index === 1)?.columns, [{ name: 'empty' }])
})

await check('ResultCollector: pauza na limitu, stranica, prebrojavanje, zatvaranje', () => {
  let pauses = 0, resumes = 0, onPause = 0
  const c = new ResultCollector(100)
  c.onPause = () => onPause++
  c.setSource({ pause: () => pauses++, resume: () => resumes++ })
  c.startSet([{ name: 'n' }])
  for (let i = 0; i < 105; i++) c.addRow([i]) // 100 u gridu, 5 stiže nakon pauze
  assert.equal(c.paused, true)
  assert.equal(c.sets[0].rows.length, 100)
  assert.equal(c.sets[0].hasMore, true)
  assert.deepEqual([pauses, onPause], [1, 1])
  c.resume('page')
  assert.equal(c.paused, false)
  assert.equal(c.sets[0].rows.length, 105)
  assert.equal(resumes, 1)
  for (let i = 105; i < 250; i++) c.addRow([i])
  assert.equal(c.paused, true)
  assert.equal(c.sets[0].rows.length, 200)
  assert.equal(c.sets[0].rows[199][0], 199)
  c.resume('count')
  for (let i = 250; i < 300; i++) c.addRow([i])
  assert.equal(c.sets[0].rows.length, 200)
  assert.equal(c.sets[0].totalRows, 300)
  assert.equal(c.sets[0].truncated, true)
  assert.equal(c.sets[0].hasMore, false)
  // Zatvaranje pauziranog: preljev se odbacuje, izvor nastavlja.
  const z = new ResultCollector(10)
  z.setSource({ pause: () => {}, resume: () => resumes++ })
  z.startSet([{ name: 'n' }])
  for (let i = 0; i < 12; i++) z.addRow([i])
  z.stop()
  z.addRow([99])
  assert.deepEqual([z.paused, z.sets[0].rows.length, z.sets[0].truncated, z.sets[0].hasMore], [false, 10, true, false])
  assert.equal(resumes, 3)
})

console.log('edits')
await check('UPDATE/DELETE/INSERT po dijalektu', () => {
  const edits = [
    { kind: 'update' as const, key: { id: 7 }, values: { name: "O'Neal", note: null } },
    { kind: 'delete' as const, key: { id: '8', season: 2025 } },
    { kind: 'insert' as const, values: { name: 'a\\b' } }
  ]
  const m = buildEditStatements('mariadb', { database: 'shop', table: 'teams' }, edits)
  assert.equal(m[0].sql, 'UPDATE `shop`.`teams` SET `name` = ?, `note` = ? WHERE `id` = ?')
  assert.deepEqual(m[0].params, ["O'Neal", null, 7])
  assert.equal(m[1].sql, 'DELETE FROM `shop`.`teams` WHERE `id` = ? AND `season` = ?')
  assert.equal(literalSql('mariadb', m[2]), "INSERT INTO `shop`.`teams` (`name`) VALUES ('a\\\\b')") // MariaDB: backslash je escape znak
  const p = buildEditStatements('postgres', { database: 'shop', schema: 'sales', table: 'orders' }, edits)
  assert.equal(p[0].sql, 'UPDATE "sales"."orders" SET "name" = $1, "note" = $2 WHERE "id" = $3')
  assert.equal(literalSql('postgres', p[0]), `UPDATE "sales"."orders" SET "name" = 'O''Neal', "note" = NULL WHERE "id" = 7`)
  const s = buildEditStatements('mssql', { database: 'erp', table: 'x' }, edits)
  assert.equal(s[1].sql, 'DELETE FROM [erp].[dbo].[x] WHERE [id] = @p1 AND [season] = @p2')
  assert.equal(literalSql('mssql', s[1]), "DELETE FROM [erp].[dbo].[x] WHERE [id] = N'8' AND [season] = 2025")
})
await check('placeholderi u nazivima se ne diraju', () => {
  const [st] = buildEditStatements('mariadb', { database: 'd', table: 'why?' }, [{ kind: 'update', key: { 'id?': 1 }, values: { a: 2 } }])
  assert.equal(literalSql('mariadb', st), 'UPDATE `d`.`why?` SET `a` = 2 WHERE `id?` = 1')
  const [pg] = buildEditStatements('postgres', { database: 'd', table: 't$1' }, [{ kind: 'delete', key: { id: 5 } }])
  assert.equal(literalSql('postgres', pg), 'DELETE FROM "public"."t$1" WHERE "id" = 5')
})
await check('bez ključa / bez promjena → greška; assertOneRow', () => {
  assert.throws(() => buildEditStatements('mariadb', { database: 'd', table: 't' }, [{ kind: 'update', values: { a: 1 } }]), /primarni ključ/)
  assert.throws(() => buildEditStatements('mariadb', { database: 'd', table: 't' }, [{ kind: 'update', key: { id: 1 }, values: {} }]), /nema promijenjenih/)
  assert.equal(buildEditStatements('postgres', { database: 'd', table: 't' }, [{ kind: 'insert', values: {} }])[0].sql, 'INSERT INTO "public"."t" DEFAULT VALUES')
  assertOneRow(0, 1)
  assert.throws(() => assertOneRow(2, 0), /Naredba 3 .* 0 redaka/)
})

for (const cfg of configs) {
  const mgr = new ConnectionManager({ resolve: async () => cfg })
  console.log(cfg.type)
  await check('test()', async () => {
    const r = await ConnectionManager.test(cfg)
    assert.ok(r.ok, r.message)
    console.log('    ', r.version)
  })
  await check('test() s krivom lozinkom vraća grešku', async () => {
    const r = await ConnectionManager.test({ ...cfg, password: 'kriva-lozinka-123', user: cfg.type === 'postgres' ? 'nepostoji' : cfg.user })
    assert.equal(r.ok, false)
  })
  let dbs: string[] = []
  await check('databases', async () => {
    dbs = await mgr.databases(cfg.id)
    assert.ok(dbs.includes('shop'), dbs.join(','))
  })
  await check('objects + children + definition', async () => {
    const objs = await mgr.objects(cfg.id, 'shop')
    const kinds = new Set(objs.map((o) => o.kind))
    for (const k of ['table', 'view', 'procedure', 'function', 'trigger']) assert.ok(kinds.has(k as never), `nema ${k}: ${JSON.stringify(objs)}`)
    const orders = objs.find((o) => o.kind === 'table' && o.name === 'orders')!
    const cols = await mgr.children(cfg.id, 'shop', orders)
    const id = cols.find((c) => c.name === 'id')!
    assert.equal(id.type, 'column')
    if (id.type === 'column') { assert.ok(id.primaryKey); assert.ok(id.identity) }
    for (const o of objs) {
      const def = await mgr.definition(cfg.id, 'shop', o)
      assert.ok(def.length > 10, `${o.kind} ${o.name}: ${def}`)
      if (o.expandable) await mgr.children(cfg.id, 'shop', o)
    }
    const fn = objs.find((o) => o.kind === 'function')!
    const params = await mgr.children(cfg.id, 'shop', fn)
    console.log('     funkcija', fn.label ?? fn.name, '→', params.map((p) => `${p.name}:${p.dataType}`).join(', '))
    console.log('     DDL orders:\n' + (await mgr.definition(cfg.id, 'shop', orders)).split('\n').map((l) => '       ' + l).join('\n'))
  })

  const prefix = cfg.type === 'postgres' ? 'sales.' : ''
  const s = await mgr.openSession(cfg.id, 'shop')
  await check('multi-statement upit, više result setova, tipovi', async () => {
    const r = await mgr.execute(s.sessionId, `SELECT * FROM ${prefix}customers ORDER BY id ${cfg.type === 'mssql' ? 'OFFSET 0 ROWS FETCH NEXT 3 ROWS ONLY' : 'LIMIT 3'}; UPDATE ${prefix}orders SET total = total WHERE id < 5; SELECT 1 AS a, 'x' AS a, NULL AS n;`)
    assert.equal(r.error, undefined, r.error)
    assert.equal(r.resultSets.length, 2)
    assert.equal(r.resultSets[1].columns.length, 3)
    assert.deepEqual(r.resultSets[1].rows[0].slice(1), ['x', null])
    console.log('     ', JSON.stringify(r.resultSets[0].rows[0]), '|', r.messages.map((m) => m.text).join(' / '))
    // Mora se moći serijalizirati u JSON (web verzija).
    JSON.parse(JSON.stringify(r))
  })
  await check('maxRows: pauza, sljedeća stranica, prebrojavanje', async () => {
    const big = cfg.type === 'postgres' ? 'SELECT g, md5(g::text) FROM generate_series(1, 200000) g' : cfg.type === 'mariadb' ? 'SELECT seq, MD5(seq) FROM seq_1_to_200000' : 'SELECT TOP 200000 ROW_NUMBER() OVER (ORDER BY (SELECT 1)), NEWID() FROM sys.all_objects a CROSS JOIN sys.all_objects b'
    const r = await mgr.execute(s.sessionId, big, { maxRows: 100 })
    // Na limitu se čitanje pauzira; upit ostaje otvoren.
    assert.ok(r.pending)
    assert.equal(r.resultSets[0].rows.length, 100)
    assert.ok(r.resultSets[0].hasMore)
    const page = await mgr.fetchMore(s.sessionId, 'page')
    assert.equal(page.resultSets[0].rows.length, 200)
    const counted = await mgr.fetchMore(s.sessionId, 'count')
    const rs = counted.resultSets[0]
    assert.ok(!counted.pending)
    assert.equal(rs.totalRows, 200000)
    assert.equal(rs.rows.length, 200)
    assert.ok(rs.truncated)
    console.log(`      ${rs.totalRows} ukupno, ${counted.durationMs.toFixed(0)} ms`)
  })
  await check('stanje sesije ostaje (temp tablica)', async () => {
    const tt = cfg.type === 'mssql' ? '#tt' : 'tt'
    const create = { postgres: 'CREATE TEMP TABLE tt (x int)', mariadb: 'CREATE TEMPORARY TABLE tt (x int)', mssql: 'CREATE TABLE #tt (x int)' }[cfg.type]
    assert.equal((await mgr.execute(s.sessionId, create)).error, undefined)
    await mgr.execute(s.sessionId, `INSERT INTO ${tt} VALUES (42)`)
    const r = await mgr.execute(s.sessionId, `SELECT x FROM ${tt}`)
    assert.equal(r.resultSets[0].rows[0][0], 42)
  })
  await check('ručne transakcije: auto-commit off, commit, rollback, greška, pauzirani rezultat', async () => {
    const tt = cfg.type === 'mssql' ? '#tx_t' : 'tx_t'
    const create = { postgres: `CREATE TEMP TABLE ${tt} (x int)`, mariadb: `CREATE TEMPORARY TABLE ${tt} (x int)`, mssql: `CREATE TABLE ${tt} (x int)` }
    assert.equal((await mgr.execute(s.sessionId, create[cfg.type])).error, undefined)
    const count = async () => (await mgr.execute(s.sessionId, `SELECT COUNT(*) FROM ${tt}`)).resultSets[0].rows[0][0]
    // Auto-commit (zadano): bez transakcije.
    assert.equal((await mgr.execute(s.sessionId, 'SELECT 1')).tx, 'none')
    // Isključen: prvi upit otvara transakciju, idući ostaju u njoj, Rollback poništava.
    assert.equal((await mgr.execute(s.sessionId, `INSERT INTO ${tt} VALUES (1)`, { autoCommit: false })).tx, 'open')
    assert.equal((await mgr.execute(s.sessionId, `INSERT INTO ${tt} VALUES (2)`, { autoCommit: false })).tx, 'open')
    assert.equal(Number(await count()), 2)
    assert.equal(await mgr.transaction(s.sessionId, 'rollback'), 'none')
    assert.equal(Number(await count()), 0)
    // Commit sprema.
    await mgr.execute(s.sessionId, `INSERT INTO ${tt} VALUES (3)`, { autoCommit: false })
    assert.equal(await mgr.transaction(s.sessionId, 'commit'), 'none')
    assert.equal(Number(await count()), 1)
    // Ručni BEGIN uz uključen auto-commit se također vidi.
    const begin = cfg.type === 'mssql' ? 'BEGIN TRAN' : cfg.type === 'mariadb' ? 'START TRANSACTION' : 'BEGIN'
    assert.equal((await mgr.execute(s.sessionId, begin)).tx, 'open')
    await mgr.transaction(s.sessionId, 'rollback')
    // PostgreSQL / SQL Server: greška u transakciji → 'failed' (SQL Server samo uz XACT_ABORT), Commit odbijen.
    if (cfg.type !== 'mariadb') {
      if (cfg.type === 'mssql') await mgr.execute(s.sessionId, 'SET XACT_ABORT ON')
      await mgr.execute(s.sessionId, `INSERT INTO ${tt} VALUES (4)`, { autoCommit: false })
      const bad = await mgr.execute(s.sessionId, cfg.type === 'mssql' ? 'SELECT 1/0' : 'SELECT * FROM ne_postoji', { autoCommit: false })
      assert.ok(bad.error)
      // SQL Server s XACT_ABORT ON greškom sam poništi transakciju (none); PostgreSQL ostaje u grešci.
      assert.equal(bad.tx, cfg.type === 'mssql' ? 'none' : 'failed')
      if (cfg.type === 'postgres') await assert.rejects(mgr.transaction(s.sessionId, 'commit'), /samo Rollback/)
      assert.equal(await mgr.transaction(s.sessionId, 'rollback'), 'none')
      if (cfg.type === 'mssql') await mgr.execute(s.sessionId, 'SET XACT_ABORT OFF')
      assert.equal(Number(await count()), 1)
    }
    // Pauziran rezultat u transakciji: Commit se odbija (PostgreSQL bi prekidom tiho poništio).
    await mgr.execute(s.sessionId, `INSERT INTO ${tt} VALUES (5)`, { autoCommit: false })
    const big = cfg.type === 'postgres' ? 'SELECT g FROM generate_series(1, 50000) g' : cfg.type === 'mariadb' ? 'SELECT seq FROM seq_1_to_50000' : 'SELECT TOP 50000 1 FROM sys.all_objects a CROSS JOIN sys.all_objects b'
    const paused = await mgr.execute(s.sessionId, big, { autoCommit: false, maxRows: 100 })
    assert.ok(paused.pending)
    assert.equal(paused.tx, undefined)
    await assert.rejects(mgr.transaction(s.sessionId, 'commit'), /Max redaka/)
    assert.equal(await mgr.transaction(s.sessionId, 'rollback'), 'none')
    assert.equal(Number(await count()), 1)
  })
  await check('detalji tablice: indeksi i strani ključevi', async () => {
    const schema = cfg.type === 'postgres' ? 'sales' : cfg.type === 'mssql' ? 'dbo' : undefined
    const d = await mgr.tableDetails(cfg.id, 'shop', { kind: 'table', schema, name: 'orders', expandable: true })
    const ix = d.indexes.find((i) => i.name === 'orders_customer_idx')
    assert.ok(ix, JSON.stringify(d.indexes))
    assert.deepEqual(ix.columns, ['customer_id'])
    if (cfg.type !== 'mariadb') assert.deepEqual(ix.included, ['total'])
    assert.ok(d.indexes.some((i) => i.primary && i.columns.join() === 'id'), JSON.stringify(d.indexes))
    const fk = d.foreignKeys.find((f) => f.name === 'orders_customer_fk')
    assert.ok(fk, JSON.stringify(d.foreignKeys))
    assert.equal(fk.toTable, 'customers')
    assert.deepEqual(fk.fromColumns, ['customer_id'])
    assert.deepEqual(fk.toColumns, ['id'])
    const c = await mgr.tableDetails(cfg.id, 'shop', { kind: 'table', schema, name: 'customers', expandable: true })
    assert.ok(c.referencedBy.some((f) => f.fromTable === 'orders' && f.name === 'orders_customer_fk'), JSON.stringify(c.referencedBy))
  })
  await check('plan izvršavanja (procjena i ANALYZE)', async () => {
    const sql = `SELECT c.name, SUM(o.total) FROM ${prefix}orders o JOIN ${prefix}customers c ON c.id = o.customer_id WHERE o.total > 50 GROUP BY c.name`
    const flat = (n: { label: string; children: unknown[] }): string[] => [n.label, ...(n.children as never[]).flatMap(flat)]
    const est = await mgr.explain(s.sessionId, sql, false)
    assert.equal(est.analyzed, false)
    assert.ok(est.raw.length > 20)
    const labels = flat(est.root)
    assert.ok(labels.length >= 2, labels.join(' / '))
    console.log('      ', labels.join(' / '))
    if (cfg.type !== 'mssql') {
      const an = await mgr.explain(s.sessionId, sql, true)
      assert.equal(an.analyzed, true)
      const times: number[] = []
      const walk = (n: typeof an.root) => { if (n.timeMs !== undefined) times.push(n.timeMs); n.children.forEach(walk) }
      walk(an.root)
      assert.ok(times.length > 0, 'ANALYZE bez vremena')
    }
    // Sesija nakon plana i dalje izvršava upite normalno (SQL Server: SHOWPLAN mora biti isključen).
    const after = await mgr.execute(s.sessionId, `SELECT COUNT(*) FROM ${prefix}orders`)
    assert.equal(after.error, undefined, after.error)
    assert.equal(Number(after.resultSets[0].rows[0][0]), 500)
  })
  if (cfg.type === 'mssql') {
    await check('PRINT poruke', async () => {
      const r = await mgr.execute(s.sessionId, 'EXEC dbo.cleanup 5')
      assert.ok(r.messages.some((m) => m.text.includes('cleanup 5')), JSON.stringify(r.messages))
    })
  }
  await check('greška u upitu', async () => {
    const r = await mgr.execute(s.sessionId, 'SELECT * FROM ne_postoji_tablica')
    assert.ok(r.error)
    console.log('     ', r.error)
  })
  await check('prekid dugog upita', async () => {
    const slow = cfg.type === 'postgres' ? 'SELECT pg_sleep(30)' : cfg.type === 'mssql' ? "WAITFOR DELAY '00:00:30'" : 'SELECT SLEEP(30)'
    const t = performance.now()
    const p = mgr.execute(s.sessionId, slow)
    await new Promise((r) => setTimeout(r, 500))
    await mgr.cancel(s.sessionId)
    const r = await p
    const ms = performance.now() - t
    assert.ok(ms < 5000, `trajalo ${ms} ms`)
    console.log(`      prekinuto nakon ${ms.toFixed(0)} ms; ${r.error ?? JSON.stringify(r.resultSets[0]?.rows)}`)
    // sesija i dalje radi
    const after = await mgr.execute(s.sessionId, 'SELECT 1')
    assert.equal(after.error, undefined)
  })
  if (cfg.type === 'postgres') {
    await check('RAISE NOTICE poruke', async () => {
      const r = await mgr.execute(s.sessionId, 'CALL sales.cleanup(5)')
      assert.ok(r.messages.some((m) => m.text.includes('cleanup 5')), JSON.stringify(r.messages))
    })
  }
  if (cfg.type === 'mariadb') {
    await check('DELIMITER skripta + CALL', async () => {
      const r = await mgr.execute(s.sessionId, 'DROP PROCEDURE IF EXISTS p2;\nDELIMITER $$\nCREATE PROCEDURE p2() BEGIN SELECT 1 AS a; SELECT 2 AS b; END$$\nDELIMITER ;\nCALL p2();')
      assert.equal(r.error, undefined, r.error)
      assert.equal(r.resultSets.length, 2)
    })
    await check('binarni podaci i decimale', async () => {
      const r = await mgr.execute(s.sessionId, 'SELECT photo, balance FROM customers ORDER BY id')
      assert.equal(r.resultSets[0].rows[0][0], '0xDEADBEEF')
      assert.equal(r.resultSets[0].rows[1][1], '99999999.99')
    })
  }
  await mgr.closeAll()
}
console.log(`\n${passed} testova prošlo${process.exitCode ? ', IMA GREŠAKA' : ''}`)
