// Ponovno stvara demo bazu "demo" (izmišljena web trgovina) na MariaDB-u iz docker/compose.yml, za snimke vodiča.
// Briše postojeću "demo" bazu, zato radi samo na MariaDB konekciji iz testConfigs (zadano 127.0.0.1:13306).
// Pokretanje: npm run db:up && npm run db:demo
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { testConfigs } from './test-db-config.ts'

const c = testConfigs.find((x) => x.type === 'mariadb')
if (!c) throw new Error('Nema MariaDB konekcije u test-db-config (TEST_DBS?).')
const batches = readFileSync(join(import.meta.dirname, '..', 'docker', 'seed', 'demo-mariadb.sql'), 'utf8')
  .split(/^\s*GO\s*$/im)
  .map((b) => b.trim())
  .filter((b) => b.replace(/^--.*$/gm, '').trim())

const t = performance.now()
// Korisnik "studio" iz compose.yml ima prava samo na "shop"; bazu stvara root.
const admin = await mysql.createConnection({ host: c.host, port: c.port, user: 'root', password: process.env.MARIA_ROOT_PASSWORD ?? 'studio' })
await admin.query('DROP DATABASE IF EXISTS demo')
await admin.query('CREATE DATABASE demo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
await admin.query(`GRANT ALL PRIVILEGES ON demo.* TO ?@'%'`, [c.user])
// Korisnik za snimke vodiča: vidi samo bazu demo (bez testne baze shop u Exploreru).
await admin.query(`CREATE USER IF NOT EXISTS 'guide'@'%' IDENTIFIED BY 'guide'`)
await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE, SHOW VIEW ON demo.* TO 'guide'@'%'`)
await admin.query('USE demo')
for (const b of batches) await admin.query(b)
const [counts] = await admin.query<mysql.RowDataPacket[]>(
  `SELECT table_name AS t, table_rows AS n FROM information_schema.tables WHERE table_schema = 'demo' AND table_type = 'BASE TABLE' ORDER BY table_name`
)
await admin.end()
console.log(`demo seeded (${(performance.now() - t).toFixed(0)} ms): ` + counts.map((r) => `${r.t} ~${r.n}`).join(', '))
