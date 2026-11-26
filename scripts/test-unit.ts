// Unit testovi bez baza podataka. Pokretanje: npm run test:unit
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprintSql, normalizeSql } from '../src/core/fingerprint.ts'
import { analyzeSql } from '../src/core/sqlRefs.ts'
import { parseSavedSearch } from '../src/core/savedSearch.ts'
import { findParams, paramLiteral, paramNames, substituteParams } from '../src/core/params.ts'
import { findUnboundedWrites } from '../src/core/guard.ts'
import { splitStatements, statementAt } from '../src/core/statements.ts'
import { sqlLiteral, toCsv, toInserts, toJson, toMarkdown, type ResultView } from '../src/core/resultFormats.ts'
import { buildXlsx, excelDate } from '../src/core/xlsx.ts'
import { decodeText, encodeText } from '../src/core/textFile.ts'
import { mariaPlan, mssqlPlan, pgPlan, selfCost, selfTime } from '../src/core/plan.ts'
import { genDelete, genInsert, genSelect, genUpdate, paramName } from '../src/core/generateSql.ts'
import { groupForeignKeyRows, groupIndexes, parsePgFkDef, parsePgIndexDef } from '../src/core/tableDetails.ts'
import { WorkspaceStore } from '../src/main/workspaceStore.ts'
import { setLang, t } from '../src/shared/i18n.ts'
import { en } from '../src/shared/locales/en.ts'
import { hr } from '../src/shared/locales/hr.ts'

// Provjere u ovim testovima su pisane za hrvatske poruke.
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

console.log('fingerprint')
await check('literali, razmaci, komentari i velika slova', () => {
  const a = fingerprintSql('SELECT * FROM orders WHERE id = 5', 'postgres')
  const b = fingerprintSql("select *\n  from Orders -- zadnja\n where id=7;", 'postgres')
  assert.equal(a.normalized, 'select * from orders where id = ?')
  assert.equal(a.hash, b.hash)
  assert.match(a.hash, /^[0-9a-f]{16}$/)
})
await check('stringovi po dijalektu', () => {
  assert.equal(normalizeSql("WHERE name = N'Ivan' AND x = 'it''s'", 'mssql'), 'where name = ? and x = ?')
  assert.equal(normalizeSql(`WHERE a = "x" AND b = 'y\\'z'`, 'mariadb'), 'where a = ? and b = ?')
  assert.equal(normalizeSql(`SELECT "Name" FROM "T" WHERE s = E'a\\'b'`, 'postgres'), 'select "Name" from "T" where s = ?')
  assert.equal(normalizeSql('SELECT $$a;b$$, $f$x$f$, $1', 'postgres'), 'select ? , ? , $1')
})
await check('identifikatori u zagradama i backtickovima zadržavaju oblik', () => {
  assert.equal(normalizeSql('SELECT [Order Id] FROM [dbo].[Orders]', 'mssql'), 'select [Order Id] from [dbo] . [Orders]')
  assert.equal(normalizeSql('SELECT `Order` FROM t # komentar', 'mariadb'), 'select `Order` from t')
})
await check('brojevi i hex', () => {
  assert.equal(normalizeSql('SELECT 1.5, .5, 1e-3, 0x1F, col1 FROM t2', 'mssql'), 'select ? , ? , ? , ? , col1 from t2')
})
await check('IN liste i VALUES redovi se sažimaju', () => {
  assert.equal(normalizeSql('WHERE id IN (1, 2, 3)'), normalizeSql('where id in (9)'))
  assert.equal(normalizeSql("INSERT INTO t VALUES (1,'a'),(2,'b')"), 'insert into t values ( ? )')
})
await check('parametri, cast i ugniježđeni komentari', () => {
  assert.equal(normalizeSql('SELECT @id, @@ROWCOUNT, :name, x::int /* a /* b */ c */ FROM t', 'postgres'), 'select @id , @@rowcount , :name , x :: int from t')
})
await check('različiti upiti daju različit hash', () => {
  assert.notEqual(fingerprintSql('SELECT a FROM t').hash, fingerprintSql('SELECT b FROM t').hash)
})

console.log('tablice i vrste naredbi')
const names = (sql: string, d?: Parameters<typeof analyzeSql>[1]) =>
  analyzeSql(sql, d).tables.map((t) => (t.schema ? `${t.schema}.${t.table}` : t.table)).sort()
await check('FROM, JOIN, zarez-join, aliasi, sheme', () => {
  assert.deepEqual(
    names('SELECT * FROM dbo.Orders o JOIN [Sales].[Customer Info] AS c ON c.id = o.cid LEFT JOIN items i ON 1=1 WHERE 1=1', 'mssql'),
    ['dbo.orders', 'items', 'sales.customer info']
  )
  assert.deepEqual(names('select * from a, b x, c as y where a.id = b.id'), ['a', 'b', 'c'])
  assert.deepEqual(names('SELECT * FROM `shop`.`orders`', 'mariadb'), ['shop.orders'])
  assert.deepEqual(names('SELECT * FROM db..t', 'mssql'), ['t'])
})
await check('podupiti, CTE, funkcije, izrazi s FROM', () => {
  assert.deepEqual(
    names(`WITH recent AS (SELECT * FROM transactions WHERE d > now()), x(a) AS (SELECT 1)
           SELECT EXTRACT(YEAR FROM r.d), TRIM(BOTH ' ' FROM name) FROM recent r JOIN (SELECT * FROM alerts) a ON true
           CROSS JOIN generate_series(1, 3) g WHERE a IS DISTINCT FROM b`, 'postgres'),
    ['alerts', 'transactions']
  )
  assert.deepEqual(names('SELECT 1 FROM dual'), [])
})
await check('pisanje: INSERT, UPDATE, DELETE, MERGE, DDL i vrste', () => {
  const a = analyzeSql(`INSERT INTO audit (a, b) SELECT a, b FROM src;
    UPDATE t1 SET x = 1; DELETE FROM t2 WHERE 1=0; DELETE t3 WHERE 1=0;
    MERGE INTO tgt USING srcm ON 1=1 WHEN MATCHED THEN UPDATE SET a = 1;
    CREATE TABLE newt (id int REFERENCES parent(id) ON DELETE CASCADE); TRUNCATE TABLE old_t; CREATE INDEX ix ON idx_t (a);
    SELECT * INTO #tmp FROM t4`, 'mssql')
  assert.deepEqual(a.tables.map((t) => t.table).sort(), ['#tmp', 'audit', 'idx_t', 'newt', 'old_t', 'src', 'srcm', 't1', 't2', 't3', 't4', 'tgt'])
  assert.deepEqual(a.types.sort(), ['ddl', 'delete', 'insert', 'merge', 'update'])
})
await check('samo čitanje je select; FOR UPDATE nije update; EXEC', () => {
  assert.deepEqual(analyzeSql('SELECT * FROM t FOR UPDATE').types, ['select'])
  assert.deepEqual(analyzeSql('EXEC dbo.report @d = 1', 'mssql').types, ['exec'])
  assert.deepEqual(analyzeSql("SELECT 'from x' AS s -- from y").tables, [])
})

console.log('varijable')
await check('pronalaženje :x i ${x}, ali ne u stringovima, komentarima, castu, := i @x', () => {
  const sql = `SELECT :Customer_Id, \${date_from}, '\${no} :no' -- :no
    /* :no */ , x::int, @v := 1, @tsql, $1, arr[1:2], :customer_id`
  assert.deepEqual(findParams(sql, 'postgres').map((p) => p.display), [':Customer_Id', '${date_from}', ':customer_id'])
  assert.deepEqual(paramNames(sql, 'postgres'), ['customer_id', 'date_from'])
  assert.deepEqual(paramNames("SELECT @x := 1, \"a :b\" FROM t WHERE c = :c # :d", 'mariadb'), ['c'])
})
await check('literali po dijalektu', () => {
  assert.equal(paramLiteral('a', { value: "O'Brien", type: 'auto' }, 'postgres'), "'O''Brien'")
  assert.equal(paramLiteral('a', { value: 'a\\b', type: 'text' }, 'mariadb'), "'a\\\\b'")
  assert.equal(paramLiteral('a', { value: 'a\\b', type: 'text' }, 'postgres'), "'a\\b'")
  assert.equal(paramLiteral('a', { value: 'Čakovec', type: 'text' }, 'mssql'), "N'Čakovec'")
  assert.equal(paramLiteral('a', { value: 'Zagreb', type: 'text' }, 'mssql'), "'Zagreb'")
  assert.equal(paramLiteral('a', { value: ' 10.5 ', type: 'auto' }, 'mssql'), '10.5')
  assert.equal(paramLiteral('a', { value: '007', type: 'text' }, 'mssql'), "'007'")
  assert.equal(paramLiteral('a', { value: 'x', type: 'null' }), 'NULL')
  assert.equal(paramLiteral('a', { value: 'now()', type: 'raw' }), 'now()')
  assert.throws(() => paramLiteral('a', { value: '1; DROP', type: 'number' }), /nije broj/)
})
await check('zamjena u SQL-u', () => {
  const out = substituteParams("SELECT * FROM t WHERE id = :id AND d >= ${from} AND n = :ID", 'postgres', {
    id: { value: '5', type: 'auto' },
    from: { value: '2026-11-01', type: 'auto' }
  })
  assert.equal(out, "SELECT * FROM t WHERE id = 5 AND d >= '2026-11-01' AND n = 5")
  assert.throws(() => substituteParams('SELECT :x', 'postgres', {}), /Nedostaje vrijednost za :x/)
})

console.log('zaštita')
await check('UPDATE/DELETE bez WHERE i TRUNCATE', () => {
  const found = findUnboundedWrites(
    `UPDATE dbo.Orders SET a = (SELECT x FROM y WHERE y.id = 1);
     UPDATE t2 SET a = 1 WHERE id = 5;
     DELETE FROM [Sales].[Log]
     GO
     DELETE TOP (10) FROM t3
     GO
     WITH c AS (SELECT * FROM src WHERE 1 = 1) DELETE FROM t4;
     WITH c AS (SELECT 1) DELETE FROM t5 WHERE id IN (SELECT * FROM c);
     TRUNCATE TABLE big;
     SELECT * FROM t WHERE 1 = 1;
     -- DELETE FROM in_comment
     SELECT 'UPDATE x SET y = 1'`,
    'mssql'
  )
  assert.deepEqual(found.map((f) => `${f.kind}:${f.table}`), ['update:dbo.Orders', 'delete:[Sales].[Log]', 'delete:t3', 'delete:t4', 'truncate:big'])
  assert.match(found[0].snippet, /^UPDATE dbo\.Orders SET a =/)
  assert.deepEqual(findUnboundedWrites('UPDATE LOW_PRIORITY t SET a = 1 LIMIT 5', 'mariadb').map((f) => f.table), ['t'])
  assert.deepEqual(findUnboundedWrites('DELETE FROM t USING u WHERE t.id = u.id', 'postgres'), [])
  assert.deepEqual(findUnboundedWrites('SELECT * FROM t FOR UPDATE'), [])
})

console.log('sintaksa pretrage')
await check('filteri, navodnici i tekst', () => {
  const s = parseSavedSearch('sumnjive project:"Q4 izvještaj" table:dbo.Alerts type:select db:Core ran:<2w is:pinned "AML-123 x"')
  assert.deepEqual(s.terms, ['sumnjive', 'AML-123 x'])
  assert.deepEqual(s.projects, ['Q4 izvještaj'])
  assert.deepEqual(s.tables, [{ schema: 'dbo', table: 'alerts' }])
  assert.deepEqual(s.types, ['select'])
  assert.deepEqual(s.dbs, ['core'])
  assert.equal(s.ranWithinDays, 14)
  assert.equal(s.pinned, true)
  assert.deepEqual(s.problems, [])
})
await check('neispravni filteri daju napomene', () => {
  const s = parseSavedSearch('type:read ran:7 foo:bar is:x table:')
  assert.equal(s.problems.length, 5)
  assert.deepEqual(s.terms, ['foo:bar'])
  assert.equal(parseSavedSearch('ran:>1m').notRunForDays, 30)
})

console.log('naredba pod kursorom')
const texts = (sql: string, d: Parameters<typeof splitStatements>[1]) => splitStatements(sql, d).map((s) => s.text)
const at = (sql: string, d: Parameters<typeof splitStatements>[1]) => statementAt(sql.replace('|', ''), sql.indexOf('|'), d)?.text
await check('; i prazan redak dijele, stringovi i komentari ne', () => {
  assert.deepEqual(texts("SELECT 'a;b' FROM t; SELECT 2;\n\nSELECT 3\n-- x;\nFROM u\n\n\nSELECT 4", 'postgres'), [
    "SELECT 'a;b' FROM t;",
    'SELECT 2;',
    'SELECT 3\n-- x;\nFROM u',
    'SELECT 4'
  ])
  assert.deepEqual(texts('SELECT $$a;\n\nb$$;\nSELECT 1', 'postgres'), ['SELECT $$a;\n\nb$$;', 'SELECT 1'])
})
await check('GO na SQL Serveru, procedura do GO', () => {
  const sql = 'CREATE PROCEDURE p AS\nSELECT 1;\n\nSELECT 2;\nGO\nSELECT 3\ngo 2\nSELECT 4'
  assert.deepEqual(texts(sql, 'mssql'), ['CREATE PROCEDURE p AS\nSELECT 1;\n\nSELECT 2;', 'SELECT 3', 'SELECT 4'])
  assert.deepEqual(texts('SELECT go FROM t', 'mssql'), ['SELECT go FROM t'])
})
await check('BEGIN…END i CASE…END ne dijele, BEGIN TRAN da', () => {
  assert.deepEqual(texts('BEGIN TRAN;\nUPDATE t SET a = CASE WHEN b = 1 THEN 2 END;\nCOMMIT;', 'mssql'), [
    'BEGIN TRAN;',
    'UPDATE t SET a = CASE WHEN b = 1 THEN 2 END;',
    'COMMIT;'
  ])
  const proc = 'CREATE PROCEDURE p() BEGIN\n  IF 1 THEN SELECT 1; END IF;\n\n  CASE x WHEN 1 THEN SELECT 2; END CASE;\nEND;'
  assert.deepEqual(texts(proc + '\nSELECT 9', 'mariadb'), [proc, 'SELECT 9'])
  assert.deepEqual(texts('BEGIN;\nSELECT 1;', 'postgres'), ['BEGIN;', 'SELECT 1;'])
})
await check('bez dijeljenja po praznom retku dijeli samo ;', () => {
  assert.deepEqual(splitStatements('SELECT 1\n\nSELECT 2;\nSELECT 3', 'postgres', { blankLines: false }).map((s) => s.text), [
    'SELECT 1\n\nSELECT 2;',
    'SELECT 3'
  ])
})
await check('MariaDB DELIMITER blok je jedna naredba', () => {
  const block = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN\n  SELECT 1;\n\n  SELECT 2;\nEND$$\nDELIMITER ;'
  assert.deepEqual(texts('SELECT 0;\n' + block + '\n\nSELECT 3', 'mariadb'), ['SELECT 0;', block, 'SELECT 3'])
  assert.deepEqual(texts('DELIMITER //\nSELECT 1//', 'mariadb'), ['DELIMITER //\nSELECT 1//'])
})
await check('izbor naredbe prema kursoru', () => {
  const sql = 'SELECT 1;\nSELECT |2;\n\nSELECT 3'
  assert.equal(at(sql, 'postgres'), 'SELECT 2;')
  assert.equal(at('SELECT 1;|\n\nSELECT 3', 'postgres'), 'SELECT 1;')
  assert.equal(at('SELECT 1;\n\n|\n\nSELECT 3', 'postgres'), undefined)
  assert.equal(at('SELECT 1;\n\n|SELECT 3', 'postgres'), 'SELECT 3')
  assert.equal(at('SELECT 1; SELECT |2', 'postgres'), 'SELECT 2')
})

console.log('formati rezultata')
const view: ResultView = {
  columns: [
    { name: 'id', type: 'int' },
    { name: 'name', type: 'varchar' },
    { name: 'amount', type: 'decimal(10,2)' },
    { name: 'created', type: 'datetime' },
    { name: 'photo', type: 'blob' },
    { name: 'name', type: 'varchar' }
  ],
  rows: [
    [1, "O'Brien | a\\b", '12.50', '2025-01-02 03:04:05.000', '0xDEAD', null],
    [2, 'Ž\nnovi red', '99999999999999999.99', null, null, 'x']
  ]
}
await check('INSERT po dijalektu: navodnici, NULL, brojevi, binarno, unicode', () => {
  const q = (n: string) => '`' + n + '`'
  const maria = toInserts(view, 'mariadb', '`t`', q).split('\n')
  assert.equal(maria[0], "INSERT INTO `t` (`id`, `name`, `amount`, `created`, `photo`, `name`) VALUES (1, 'O''Brien | a\\\\b', 12.50, '2025-01-02 03:04:05.000', 0xDEAD, NULL);")
  assert.equal(toInserts(view, 'mariadb', '`t`', q).match(/^INSERT INTO/gm)?.length, 2)
  assert.match(toInserts(view, 'mssql', '[t]', (n) => `[${n}]`), /VALUES \(1, N'O''Brien \| a\\b', 12\.50, N'2025-01-02 03:04:05\.000', 0xDEAD, NULL\);/)
  assert.match(toInserts(view, 'postgres', 't', (n) => n), /'\\xDEAD'::bytea/)
  assert.equal(sqlLiteral(true, 'mssql'), '1')
  assert.equal(sqlLiteral(true, 'postgres'), 'TRUE')
  assert.equal(sqlLiteral('12abc', 'postgres', 'int'), "'12abc'")
})
await check('JSON, Markdown i CSV', () => {
  const json = JSON.parse(toJson(view))
  assert.deepEqual(Object.keys(json[0]), ['id', 'name', 'amount', 'created', 'photo', 'name_2'])
  assert.equal(json[1].created, null)
  // DECIMAL kao tekst iz drivera → broj; više od 15 znamenki ostaje tekst.
  assert.equal(json[0].amount, 12.5)
  assert.equal(json[1].amount, '99999999999999999.99')
  const md = toMarkdown(view).split('\n')
  assert.equal(md[1], '| ---: | --- | ---: | --- | --- | --- |')
  assert.equal(md[2], "| 1 | O'Brien \\| a\\b | 12.50 | 2025-01-02 03:04:05.000 | 0xDEAD | NULL |")
  assert.match(md[3], /Ž<br>novi red/)
  const csv = toCsv(view)
  assert.equal(csv.charCodeAt(0), 0xfeff)
  assert.match(csv, /"Ž\nnovi red"/)
})
await check('xlsx: zip s ispravnim CRC-om, tipovi ćelija, datum, zamrznuto zaglavlje', () => {
  const bytes = buildXlsx(view, 'Moj/rezultat')
  // Središnji direktorij: 6 datoteka, potpis na kraju.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(dv.getUint32(bytes.length - 22, true), 0x06054b50)
  assert.equal(dv.getUint16(bytes.length - 22 + 10, true), 6)
  const text = new TextDecoder().decode(bytes)
  assert.match(text, /<c r="A2"><v>1<\/v><\/c>/)
  assert.match(text, /<c r="C2"><v>12\.5<\/v><\/c>/)
  // Više od 15 znamenki ostaje tekst (Excel bi izgubio preciznost).
  assert.match(text, /<c r="C3" t="inlineStr"><is><t xml:space="preserve">99999999999999999\.99/)
  assert.equal(excelDate('2025-01-02 03:04:05.000')!.serial.toFixed(6), (45659 + (3 * 3600 + 4 * 60 + 5) / 86400).toFixed(6))
  assert.match(text, /<c r="D2" s="2"><v>45659\.12/)
  assert.match(text, /O&apos;Brien|O'Brien \| a\\b/)
  assert.match(text, /state="frozen"/)
  assert.match(text, /<sheet name="Moj_rezultat"/)
  assert.equal(excelDate('nije datum'), undefined)
})

console.log('kodiranje .sql datoteka')
await check('prepoznavanje i spremanje u istom kodiranju (UTF-8, BOM, UTF-16, Windows-1250)', () => {
  const text = "SELECT 'čćžšđ ČĆŽŠĐ' -- komentar\r\nFROM t"
  for (const enc of ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'windows-1250'] as const) {
    const out = encodeText(text, enc)
    assert.equal(out.encoding, enc)
    assert.deepEqual(decodeText(out.bytes), { text, encoding: enc })
  }
  // SSMS "Unicode": UTF-16 LE s BOM-om
  assert.deepEqual([...encodeText('A', 'utf16le').bytes], [0xff, 0xfe, 0x41, 0x00])
  // Windows-1250: č = 0xE8, Š = 0x8A
  assert.deepEqual([...encodeText('čŠ', 'windows-1250').bytes], [0xe8, 0x8a])
  // Znak koji Windows-1250 nema → UTF-8 s BOM-om (javlja se pozivatelju)
  assert.equal(encodeText('SELECT 1 -- 🚀', 'windows-1250').encoding, 'utf8bom')
  // Čisti ASCII je UTF-8
  assert.equal(decodeText(new TextEncoder().encode('SELECT 1')).encoding, 'utf8')
})

console.log('plan izvršavanja')
await check('PostgreSQL JSON (ANALYZE): stablo, spoj, indeks, stvarni redci × petlje', () => {
  const json = [
    {
      Plan: {
        'Node Type': 'Hash Join', 'Join Type': 'Inner', 'Hash Cond': '(o.customer_id = c.id)', 'Total Cost': 120.5, 'Plan Rows': 100,
        'Actual Rows': 98, 'Actual Loops': 1, 'Actual Total Time': 4.2,
        Plans: [
          { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Alias: 'o', 'Total Cost': 80, 'Plan Rows': 1000, 'Actual Rows': 1000, 'Actual Loops': 1, 'Actual Total Time': 2.5, Filter: '(total > 10)' },
          { 'Node Type': 'Hash', 'Total Cost': 30, 'Plan Rows': 50, Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'customers', Alias: 'c', 'Index Name': 'customers_pkey', 'Total Cost': 30, 'Plan Rows': 50, 'Actual Rows': 5, 'Actual Loops': 10, 'Actual Total Time': 0.1 }] }
        ]
      },
      'Execution Time': 4.5
    }
  ]
  const p = pgPlan(json, '')
  assert.equal(p.analyzed, true)
  assert.equal(p.root.label, 'Inner Hash Join')
  assert.match(p.root.detail!, /spoj \(o.customer_id = c.id\)/)
  assert.equal(p.root.children[0].detail, 'na orders o · filter (total > 10)')
  const idx = p.root.children[1].children[0]
  assert.equal(idx.detail, 'na customers c · indeks customers_pkey')
  assert.equal(idx.actualRows, 50)
  assert.equal(selfCost(p.root), 10.5)
})
await check('MariaDB JSON: query_block, nested_loop, tablice, sortiranje', () => {
  const json = {
    query_block: {
      select_id: 1,
      filesort: {
        sort_key: 't.name',
        temporary_table: {
          nested_loop: [
            { table: { table_name: 't', access_type: 'ALL', rows: 120, filtered: 100, attached_condition: 't.a > 1' } },
            { table: { table_name: 'u', access_type: 'eq_ref', key: 'PRIMARY', rows: 1, filtered: 100, r_rows: 1 } }
          ]
        }
      }
    }
  }
  const p = mariaPlan(json, JSON.stringify(json))
  assert.equal(p.root.label, 'Upit #1')
  const sort = p.root.children[0]
  assert.equal(sort.label, 'Sortiranje (filesort)')
  assert.equal(sort.detail, 'po t.name')
  const loop = sort.children[0].children[0]
  assert.equal(loop.label, 'Nested loop')
  assert.deepEqual(loop.children.map((c) => c.label), ['t', 'u'])
  assert.equal(loop.children[0].detail, 'pristup ALL · filter t.a > 1 · prolazi 100%')
  assert.equal(loop.children[1].detail, 'pristup eq_ref · indeks PRIMARY · prolazi 100%')
  assert.equal(p.analyzed, true)
})
await check('MariaDB 11 ANALYZE (stvarni izlaz): block-nl-join, vrijeme tablice, najskuplji korak', () => {
  const json = {
    query_block: {
      select_id: 1, cost: 0.9733, r_total_time_ms: 983.3,
      filesort: {
        sort_key: 'count(0) desc', r_total_time_ms: 0.04,
        temporary_table: {
          nested_loop: [
            { table: { table_name: 't', access_type: 'ALL', r_loops: 1, r_rows: 85, cost: 0.0142, r_table_time_ms: 0.0077, r_other_time_ms: 35.29 } },
            { 'block-nl-join': { table: { table_name: 'c', access_type: 'ALL', r_loops: 1, r_rows: 2978, cost: 0.959, r_table_time_ms: 1.585, r_other_time_ms: 920.3 }, attached_condition: 'c.x = t.x' } }
          ]
        }
      }
    }
  }
  const p = mariaPlan(json, '"r_rows"')
  const loop = p.root.children[0].children[0].children[0]
  assert.deepEqual(loop.children.map((c) => c.label), ['t', 'Block nested loop join'])
  const c = loop.children[1].children[0]
  assert.equal(c.label, 'c')
  assert.equal(c.actualRows, 2978)
  assert.equal(Math.round(c.timeMs!), 922)
  // Korijen nema vlastiti trošak (sav je u tablicama ispod operacija bez troška).
  assert.ok(selfCost(p.root)! < 0.001)
  assert.ok(selfTime(c)! > 900)
  // Vrijeme filesorta postaje kumulativno (0,04 + tablice), pa korijenu ostaje samo ostatak (~26 ms), ne 983.
  const sort = p.root.children[0]
  assert.ok(sort.timeMs! > 957)
  assert.ok(selfTime(p.root)! < 30)
  assert.equal(mariaPlan({ query_block: { select_id: 1, table: { message: 'Impossible WHERE' } } }, '').root.children[0].label, 'Impossible WHERE')
})
await check('SQL Server SHOWPLAN_XML: RelOp stablo, Object tablica i indeks', () => {
  const xml = `<ShowPlanXML><BatchSequence><Batch><Statements><StmtSimple><QueryPlan>
<RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="10" EstimatedTotalSubtreeCost="0.5">
  <NestedLoops>
    <RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.003">
      <IndexScan><Object Database="[shop]" Schema="[dbo]" Table="[customers]" Index="[PK_customers]" Alias="[c]" /></IndexScan>
    </RelOp>
    <RelOp NodeId="2" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="10" EstimatedTotalSubtreeCost="0.4">
      <IndexScan><Object Database="[shop]" Schema="[dbo]" Table="[orders]" Index="[PK_orders]" /></IndexScan>
    </RelOp>
  </NestedLoops>
</RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`
  const p = mssqlPlan(xml)
  assert.equal(p.root.label, 'Nested Loops (Inner Join)')
  assert.equal(p.root.cost, 0.5)
  assert.deepEqual(p.root.children.map((c) => c.label), ['Index Seek', 'Clustered Index Scan'])
  assert.equal(p.root.children[0].detail, 'na dbo.customers c · indeks PK_customers')
  assert.equal(p.root.children[1].detail, 'na dbo.orders · indeks PK_orders')
  assert.equal(p.root.children[1].rows, 10)
})

console.log('generiranje SQL-a')
const genCols = [
  { name: 'id', dataType: 'int', nullable: false, primaryKey: true, identity: true },
  { name: 'name', dataType: 'varchar(50)', nullable: false, primaryKey: false, identity: false },
  { name: 'Order Date', dataType: 'date', nullable: true, primaryKey: false, identity: false, defaultValue: 'CURRENT_DATE' }
]
const gen = (type: 'mariadb' | 'mssql', columns = genCols) => ({ type, table: 't', columns, quote: (n: string) => (/\s/.test(n) ? `[${n}]` : n) })
await check('SELECT, INSERT (bez identity), UPDATE i DELETE po primarnom ključu, varijable', () => {
  assert.equal(genSelect(gen('mariadb')), 'SELECT\n    id,\n    name,\n    [Order Date]\nFROM t\nLIMIT 100;')
  assert.match(genSelect(gen('mssql')), /^SELECT TOP 100\n {4}id,/)
  assert.equal(
    genInsert(gen('mariadb')),
    'INSERT INTO t (\n    name,\n    [Order Date]\n)\nVALUES (\n    :name, -- name: varchar(50), not null\n    :Order_Date -- Order Date: date, default CURRENT_DATE\n);'
  )
  assert.equal(genUpdate(gen('mariadb')), 'UPDATE t\nSET\n    name = :name,\n    [Order Date] = :Order_Date\nWHERE id = :id;')
  assert.equal(genDelete(gen('mariadb')), 'DELETE FROM t\nWHERE id = :id;')
  // Bez primarnog ključa: uvjet koji ne mijenja ništa
  const noPk = genCols.map((c) => ({ ...c, primaryKey: false }))
  assert.match(genDelete(gen('mariadb', noPk)), /WHERE 1 = 0 -- tablica nema primarni ključ/)
  // Varijable se prepoznaju kao parametri aplikacije
  assert.deepEqual(paramNames(genUpdate(gen('mariadb')), 'mariadb'), ['name', 'order_date', 'id'])
  assert.equal(paramName('1st col'), 'p_1st_col')
})

console.log('detalji tablice')
await check('indeksi: grupiranje stupaca, PK prvi, INCLUDE; strani ključevi s više stupaca', () => {
  const ix = groupIndexes([
    { name: 'ix_b', column: 'b', unique: 0, primary: 0, type: 'BTREE' },
    { name: 'PRIMARY', column: 'id', unique: 1, primary: 1 },
    { name: 'ux_ac', column: 'a', unique: true, primary: false },
    { name: 'ux_ac', column: 'c', unique: true, primary: false },
    { name: 'ux_ac', column: 'd', unique: true, primary: false, included: true }
  ])
  assert.deepEqual(ix.map((i) => i.name), ['PRIMARY', 'ux_ac', 'ix_b'])
  assert.deepEqual(ix[1].columns, ['a', 'c'])
  assert.deepEqual(ix[1].included, ['d'])
  const fk = groupForeignKeyRows([
    { name: 'fk1', fromTable: 'stavke', fromColumn: 'nar_id', toTable: 'narudzbe', toColumn: 'id' },
    { name: 'fk1', fromTable: 'stavke', fromColumn: 'god', toTable: 'narudzbe', toColumn: 'godina' }
  ])
  assert.deepEqual(fk[0].fromColumns, ['nar_id', 'god'])
  assert.deepEqual(fk[0].toColumns, ['id', 'godina'])
})
await check('PostgreSQL indexdef i constraintdef', () => {
  assert.deepEqual(parsePgIndexDef('CREATE UNIQUE INDEX ux ON sales.t USING btree (a, lower((b)::text)) INCLUDE (c, "D")'), {
    columns: ['a', 'lower((b)::text)'],
    unique: true,
    type: 'btree',
    included: ['c', 'D']
  })
  assert.deepEqual(parsePgFkDef('FOREIGN KEY (customer_id, "Year") REFERENCES sales."Customers"(id, "Year") ON DELETE CASCADE'), {
    fromColumns: ['customer_id', 'Year'],
    toSchema: 'sales',
    toTable: 'Customers',
    toColumns: ['id', 'Year']
  })
})

console.log('workspace store')
const dir = mkdtempSync(join(tmpdir(), 'qucore-unit-'))
const file = join(dir, 'qucore.db')
try {
  let w = new WorkspaceStore(file)
  const run = (sql: string, extra: Partial<Parameters<WorkspaceStore['addRun']>[0]> = {}) =>
    w.addRun({
      sql,
      fingerprint: fingerprintSql(sql).hash,
      connectionId: 'c1',
      connectionName: 'Prod',
      database: 'core',
      startedAt: new Date().toISOString(),
      durationMs: 10,
      rows: 1,
      status: 'success',
      ...extra
    })

  await check('projekti, M:N, pretraga i forgetConnection', () => {
    const aml = w.saveProject({ name: 'AML', databases: [{ connectionId: 'c1', database: 'core' }] })
    const rep = w.saveProject({ name: 'Reporting' })
    w.setDatabaseProjects({ connectionId: 'c2', database: 'dwh' }, [rep.id])
    const q = w.saveQuery({ title: 'Sumnjive transakcije', sql: 'SELECT 1', connectionId: 'c1', database: 'core', projectIds: [aml.id, rep.id] })
    w.saveQuery({ title: '50% popust', sql: 'SELECT 2', projectIds: [rep.id], pinned: true })
    assert.equal(w.listSaved({ projectId: aml.id }).length, 1)
    assert.equal(w.listSaved({ projectId: rep.id })[0].pinned, true)
    assert.equal(w.listSaved({ search: '%' }).length, 1)
    assert.equal(w.listSaved({ search: 'TRANSAKC' }).length, 1)
    w.forgetConnection('c2')
    assert.equal(w.listProjects().find((p) => p.id === rep.id)!.databases.length, 0)
    w.removeProject(rep.id)
    assert.deepEqual(w.getSaved(q.id)!.projectIds, [aml.id])
  })

  await check('prijedlog spremanja nakon 5 izvršavanja u 7 dana', () => {
    const infos = [1, 2, 3, 4, 5].map((n) => run(`SELECT * FROM alerts WHERE id = ${n}`))
    assert.deepEqual(infos.map((i) => i.recentRuns), [1, 2, 3, 4, 5])
    assert.deepEqual(infos.map((i) => i.suggestSave), [false, false, false, false, true])
    // Stara izvršavanja (prije 7 dana) se ne broje.
    const old = new Date(Date.now() - 8 * 86400000).toISOString()
    for (let n = 0; n < 6; n++) run('SELECT * FROM old_t', { startedAt: old })
    assert.equal(run('SELECT * FROM old_t').suggestSave, false)
  })

  await check('ignorirano i spremljeno se više ne predlaže', () => {
    const fp = fingerprintSql('SELECT * FROM alerts WHERE id = 1').hash
    w.ignoreFingerprint(fp)
    assert.equal(run('SELECT * FROM alerts WHERE id = 9').suggestSave, false)
    for (let n = 0; n < 5; n++) run('SELECT * FROM cases')
    w.saveQuery({ title: 'Cases', sql: 'select * from cases', projectIds: [] }, { fingerprint: fingerprintSql('select * from cases').hash })
    assert.equal(run('SELECT *  FROM cases').suggestSave, false)
  })

  await check('izvršavanje spremljenog queryja se veže na njega', () => {
    const q = w.saveQuery({ title: 'Vezan', sql: 'SELECT 42', projectIds: [] })
    for (let n = 0; n < 6; n++) assert.equal(run('SELECT 42', { queryId: q.id }).suggestSave, false)
    run('SELECT 42', { queryId: 99999 }) // obrisan query: zapis bez veze
    const s = w.getSaved(q.id)!
    assert.equal(s.runCount, 6)
    assert.ok(s.lastRunAt)
    w.removeSaved(q.id)
    assert.equal(w.listRuns({ search: 'select 42' }).length, 7, 'izvršavanja ostaju nakon brisanja queryja')
  })

  await check('povijest: filtri, scope, ponavljanja, status', () => {
    run('UPDATE x SET a = 1', { status: 'error', error: 'boom', connectionId: 'c2', database: 'dwh' })
    run('SELECT 7', { status: 'cancelled', database: undefined })
    const all = w.listRuns()
    assert.equal(all[0].sql, 'SELECT 7')
    assert.equal(all[0].cancelled, true)
    assert.equal(all[1].error, 'boom')
    assert.equal(w.listRuns({ connectionId: 'c2' }).length, 1)
    const scoped = w.listRuns({ scope: [{ connectionId: 'c1', database: 'core' }] })
    assert.ok(scoped.every((e) => e.connectionId === 'c1'))
    assert.ok(scoped.some((e) => e.database === undefined), 'izvršavanje bez baze ide uz konekciju')
    assert.equal(w.listRuns({ scope: [] }).length, 0)
    assert.equal(w.listRuns({ search: 'from alerts' })[0].repeats, 6)
    w.removeRun(all[0].id)
    assert.equal(w.listRuns()[0].sql, 'UPDATE x SET a = 1')
  })

  await check('pretraga: FTS bez dijakritika, tablice, vrste, projekti, ran:, is:pinned', () => {
    const save = (title: string, sql: string, extra: Partial<Parameters<WorkspaceStore['saveQuery']>[0]> = {}) => {
      const { tables, types } = analyzeSql(sql, 'mssql')
      return w.saveQuery({ title, sql, projectIds: [], ...extra }, { tables, types })
    }
    const fraud = w.saveProject({ name: 'Fraud Q4' })
    const a = save('Sumnjive transakcije > 10k', 'SELECT * FROM dbo.bank_transactions t JOIN alerts a ON a.tid = t.id', {
      description: 'Ticket AML-123', database: 'Core', projectIds: [fraud.id]
    })
    const b = save('Čišćenje', 'DELETE FROM alerts WHERE closed = 1', { pinned: true })
    // Samo queryji iz ovog testa (baza već ima queryje iz prethodnih provjera).
    const ids = (search: string) => w.listSaved({ search }).map((x) => x.id).filter((id) => id === a.id || id === b.id)
    assert.deepEqual(ids('transakc'), [a.id])
    assert.deepEqual(ids('ciscenje'), [b.id], 'bez dijakritika')
    assert.deepEqual(ids('aml-123'), [a.id], 'ticket u opisu')
    assert.deepEqual(ids('table:alerts').sort(), [a.id, b.id].sort())
    assert.deepEqual(ids('table:dbo.bank_transactions'), [a.id])
    assert.deepEqual(ids('table:other.bank_transactions'), [])
    assert.deepEqual(ids('table:alerts type:delete'), [b.id])
    assert.deepEqual(ids('type:select type:delete').length, 2)
    assert.deepEqual(ids('project:"fraud q4"'), [a.id])
    assert.deepEqual(ids('db:core'), [a.id])
    assert.deepEqual(ids('is:pinned table:alerts'), [b.id])
    run('SELECT * FROM dbo.bank_transactions', { queryId: a.id })
    assert.deepEqual(ids('ran:<7d'), [a.id])
    assert.ok(ids('ran:>30d').includes(b.id) && !ids('ran:>30d').includes(a.id))
    const got = w.getSaved(a.id)!
    assert.deepEqual(got.tables, ['alerts', 'dbo.bank_transactions'])
    assert.deepEqual(got.statementTypes, ['select'])
    // Promjena naslova ažurira indeks; brisanje ga čisti.
    w.saveQuery({ ...got, title: 'Velike uplate' }, { tables: [], types: [] })
    assert.deepEqual(ids('transakc'), [])
    assert.deepEqual(ids('uplate'), [a.id])
    w.removeSaved(a.id)
    assert.deepEqual(ids('uplate'), [])
    assert.equal(w.unanalyzed().length > 0, true, 'queryji bez analize (spremljeni bez meta)')
  })

  await check('aliasi: okruženja, zamjena naziva, veza queryja, brisanje konekcije', () => {
    const p = w.saveProject({
      name: 'Alias test',
      defaultEnv: 'test',
      aliases: [
        { name: 'core-db', targets: [{ env: 'dev', connectionId: 'd1', database: 'core_dev' }, { env: 'prod', connectionId: 'p1', database: 'core' }] },
        { name: 'dwh', targets: [{ env: 'prod', connectionId: 'p1', database: 'dwh' }] }
      ]
    })
    assert.equal(p.defaultEnv, 'test')
    const core = p.aliases.find((a) => a.name === 'core-db')!
    const dwh = p.aliases.find((a) => a.name === 'dwh')!
    assert.deepEqual(core.targets.map((t) => t.env), ['dev', 'prod'])
    // Query vezan na alias automatski ulazi u projekt aliasa.
    const q = w.saveQuery({ title: 'Na aliasu', sql: 'SELECT 1', projectIds: [], aliasId: core.id })
    assert.equal(q.aliasId, core.id)
    assert.deepEqual(q.projectIds, [p.id])
    // Zamjena naziva između dva postojeća aliasa zadržava id-eve (UNIQUE se ne krši).
    const p2 = w.saveProject({ ...p, aliases: [{ ...core, name: 'dwh' }, { ...dwh, name: 'core-db' }] })
    assert.equal(p2.aliases.find((a) => a.id === core.id)!.name, 'dwh')
    assert.equal(w.getSaved(q.id)!.aliasId, core.id)
    assert.throws(() => w.saveProject({ ...p, aliases: [{ name: 'x', targets: [] }, { name: 'X', targets: [] }] }), /dvaput/)
    w.setDefaultEnv(p.id, 'prod')
    w.forgetConnection('p1')
    const p3 = w.listProjects().find((x) => x.id === p.id)!
    assert.equal(p3.defaultEnv, 'prod')
    assert.deepEqual(p3.aliases.find((a) => a.id === core.id)!.targets.map((t) => t.env), ['dev'])
    // Uklonjen alias: query ostaje, bez veze.
    w.saveProject({ ...p3, aliases: [] })
    assert.equal(w.getSaved(q.id)!.aliasId, undefined)
  })

  await check('vrijednosti varijabli po projektu i izvršavanje s parametrima', () => {
    w.saveParams(null, { id: { value: '5', type: 'auto' } })
    w.saveParams(7, { id: { value: '9', type: 'number' }, d: { value: '2026-01-01', type: 'text' } })
    assert.deepEqual(w.getParams(null, ['id', 'd']), { id: { value: '5', type: 'auto' } })
    assert.deepEqual(w.getParams(7, ['id']), { id: { value: '9', type: 'number' } })
    w.saveParams(7, { id: { value: '10', type: 'auto' } })
    assert.equal(w.getParams(7, ['id']).id.value, '10')
    run('SELECT * FROM t WHERE id = :id', { params: { id: { value: '10', type: 'auto' } } })
    assert.deepEqual(w.listRuns()[0].params, { id: { value: '10', type: 'auto' } })
    run('SELECT 1')
    assert.equal(w.listRuns()[0].params, undefined)
  })

  await check('anomalije: sporo (5× medijana i > 1 s) i prazno, po konekciji i bazi', () => {
    const sql = 'SELECT * FROM metrics_t WHERE d > :d'
    const at = (durationMs: number, rows: number, extra = {}) => run(sql, { durationMs, rows, database: 'm', ...extra })
    assert.equal(at(300, 10).anomaly, undefined)
    at(320, 12)
    assert.equal(at(280, 11).anomaly, undefined, 'manje od 3 prethodna')
    assert.equal(at(1400, 10).anomaly, undefined, '4,7× medijana nije dovoljno')
    const slow = at(2000, 10).anomaly!
    assert.equal(slow.kind, 'slow')
    assert.equal(slow.samples, 4)
    assert.equal(slow.medianMs, 310)
    assert.equal(at(300, 0).anomaly?.kind, 'empty')
    // Druga baza ima svoju povijest; greška se ne uspoređuje.
    assert.equal(at(5000, 0, { database: 'other' }).anomaly, undefined)
    assert.equal(at(9000, 0, { status: 'error' }).anomaly, undefined)
    // Brzo, ali ispod 1 s: nije sporo ni kad je 5× medijana.
    const fast = 'SELECT 1 FROM fast_t'
    for (let k = 0; k < 3; k++) run(fast, { durationMs: 20, rows: 1 })
    assert.equal(run(fast, { durationMs: 400, rows: 1 }).anomaly, undefined)
  })

  await check('verzije: samo kad se SQL promijeni, izvršavanja na zadnjoj verziji, trend', () => {
    const meta = (sql: string) => ({ ...analyzeSql(sql, 'mssql') })
    const v1 = 'SELECT * FROM dbo.orders'
    let q = w.saveQuery({ title: 'Verzionirani', sql: v1, projectIds: [] }, meta(v1))
    assert.equal(q.versionCount, 1)
    run(v1, { queryId: q.id })
    q = w.saveQuery({ ...q, title: 'Novi naslov' }, meta(v1))
    assert.equal(q.versionCount, 1, 'naslov nije nova verzija')
    const v2 = 'SELECT id FROM dbo.orders WHERE id > 10'
    q = w.saveQuery({ ...q, sql: v2 }, meta(v2))
    assert.equal(q.versionCount, 2)
    run(v2, { queryId: q.id })
    run(v2, { queryId: q.id, durationMs: 50, rows: 3 })
    const versions = w.versions(q.id)
    assert.deepEqual(versions.map((v) => [v.number, v.runCount]), [[1, 1], [2, 2]])
    const runs = w.savedRuns(q.id)
    assert.deepEqual(runs.map((r) => r.versionNumber), [2, 2, 1])
    assert.equal(runs[0].rows, 3)
  })

  await check('mape: normalizacija, zadržavanje i popis', () => {
    const q = w.saveQuery({ title: 'U mapi', sql: 'SELECT 2', projectIds: [], folder: ' Izvještaji / / Mjesečni ' })
    assert.equal(q.folder, 'Izvještaji/Mjesečni')
    assert.equal(w.saveQuery({ ...q, folder: undefined }).folder, 'Izvještaji/Mjesečni', 'undefined zadržava mapu')
    assert.ok(w.folders().includes('Izvještaji/Mjesečni'))
    assert.equal(w.saveQuery({ ...q, folder: '' }).folder, '')
  })

  await check('provjera sheme: nestale tablice, aliasi, preskakanje, is:broken, čišćenje pri promjeni SQL-a', () => {
    const save = (title: string, sql: string, extra: Partial<Parameters<WorkspaceStore['saveQuery']>[0]> = {}) =>
      w.saveQuery({ title, sql, projectIds: [], connectionId: 'sc', database: 'shop', ...extra }, analyzeSql(sql, 'mssql'))
    const ok = save('Postoji', 'SELECT * FROM dbo.orders o JOIN customers c ON c.id = o.cid JOIN #tmp t ON 1=1 JOIN sys.objects s ON 1=1')
    const broken = save('Nestalo', 'SELECT * FROM dbo.orders_old JOIN shop.legacy ON 1=1 JOIN otherdb.x ON 1=1')
    const ddl = save('DDL', 'CREATE TABLE newt (id int); SELECT * FROM newt')
    const p = w.saveProject({ name: 'SC', aliases: [{ name: 'sc-db', targets: [{ env: 'dev', connectionId: 'sc', database: 'shop' }] }] })
    const viaAlias = save('Preko aliasa', 'SELECT * FROM gone_t', { connectionId: 'elsewhere', database: 'x', aliasId: p.aliases[0].id })
    const n = w.checkSchema('sc', 'shop', [
      { kind: 'table', schema: 'dbo', name: 'Orders' },
      { kind: 'view', schema: 'dbo', name: 'customers' },
      { kind: 'procedure', schema: 'dbo', name: 'orders_old' }
    ])
    assert.equal(n, 3, 'DDL query se preskače')
    assert.deepEqual(w.getSaved(ok.id)!.schemaCheck!.missing, [])
    assert.deepEqual(w.getSaved(broken.id)!.schemaCheck!.missing.sort(), ['dbo.orders_old', 'legacy'])
    assert.equal(w.getSaved(ddl.id)!.schemaCheck, undefined)
    assert.deepEqual(w.getSaved(viaAlias.id)!.schemaCheck!.missing, ['gone_t'])
    assert.deepEqual(w.listSaved({ search: 'is:broken' }).map((q) => q.id).sort(), [broken.id, viaAlias.id].sort())
    const fixedSql = 'SELECT * FROM dbo.orders'
    w.saveQuery({ ...w.getSaved(broken.id)!, sql: fixedSql }, analyzeSql(fixedSql, 'mssql'))
    assert.equal(w.getSaved(broken.id)!.schemaCheck, undefined, 'promjena SQL-a briše staru provjeru')
  })

  await check('snippeti: globalni i projektni', () => {
    const p = w.saveProject({ name: 'Snip' })
    const g = w.saveSnippet({ projectId: null, name: 'Zadnjih 7 dana', body: 'WHERE d >= CURRENT_DATE - 7' })
    w.saveSnippet({ projectId: p.id, name: 'AML CTE', body: 'WITH x AS (SELECT 1)' })
    assert.deepEqual(w.listSnippets(null).map((s) => s.name), ['Zadnjih 7 dana'])
    assert.deepEqual(w.listSnippets(p.id).map((s) => s.name), ['AML CTE', 'Zadnjih 7 dana'])
    w.saveSnippet({ ...g, name: 'Tjedan' })
    assert.equal(w.listSnippets(null)[0].name, 'Tjedan')
    assert.throws(() => w.saveSnippet({ projectId: null, name: 'x', body: ' ' }), /prazan/)
    w.removeProject(p.id)
    assert.equal(w.listSnippets(p.id).length, 1, 'projektni snippet ide s projektom')
  })

  await check('ponovno otvaranje: migracije se ne ponavljaju, uvoz stare povijesti', () => {
    w.close()
    w = new WorkspaceStore(file)
    const before = w.runCount()
    assert.ok(before > 0)
    w.clearRuns()
    w.importRuns([
      { sql: 'SELECT 1', fingerprint: 'a', connectionId: 'c1', connectionName: 'x', startedAt: '2026-11-01T10:00:00Z', durationMs: 1, rows: 1, status: 'success' },
      { sql: 'SELECT 2', fingerprint: 'b', connectionId: 'c1', connectionName: 'x', startedAt: '2026-11-02T10:00:00Z', durationMs: 1, rows: 0, status: 'error', error: 'e' }
    ])
    assert.deepEqual(w.listRuns().map((e) => e.sql), ['SELECT 2', 'SELECT 1'])
    w.close()
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} prošlo${process.exitCode ? ', ima grešaka' : ''}`)
