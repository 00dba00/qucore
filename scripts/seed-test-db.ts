// Ponovno stvara bazu "shop" na testnim bazama (docker/seed/*.sql). Briše postojeću "shop" bazu,
// zato radi samo na hostovima iz testConfigs (zadano docker/compose.yml na 127.0.0.1).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import mysql from 'mysql2/promise'
import mssql from 'mssql'
import { testConfigs } from './test-db-config.ts'

const seedDir = join(import.meta.dirname, '..', 'docker', 'seed')
/** Seed datoteke dijele naredbe redom koji sadrži samo GO. */
const batches = (file: string) =>
  readFileSync(join(seedDir, file), 'utf8')
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter((b) => b.replace(/^--.*$/gm, '').trim())

for (const c of testConfigs) {
  const t = performance.now()
  if (c.type === 'postgres') {
    const admin = new pg.Client({ host: c.host, port: c.port, user: c.user, password: c.password, database: 'postgres' })
    await admin.connect()
    await admin.query('DROP DATABASE IF EXISTS shop WITH (FORCE)')
    await admin.query('CREATE DATABASE shop')
    await admin.end()
    const db = new pg.Client({ host: c.host, port: c.port, user: c.user, password: c.password, database: 'shop' })
    await db.connect()
    for (const b of batches('postgres.sql')) await db.query(b)
    await db.end()
  } else if (c.type === 'mariadb') {
    const db = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password })
    await db.query('DROP DATABASE IF EXISTS shop')
    await db.query('CREATE DATABASE shop')
    await db.query('USE shop')
    for (const b of batches('mariadb.sql')) await db.query(b)
    await db.end()
  } else {
    const pool = await new mssql.ConnectionPool({ server: c.host, port: c.port, user: c.user, password: c.password, options: { trustServerCertificate: true } }).connect()
    await pool.batch("IF DB_ID('shop') IS NOT NULL BEGIN ALTER DATABASE shop SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE shop END")
    await pool.batch('CREATE DATABASE shop')
    await pool.close()
    const db = await new mssql.ConnectionPool({ server: c.host, port: c.port, user: c.user, password: c.password, database: 'shop', options: { trustServerCertificate: true } }).connect()
    for (const b of batches('mssql.sql')) await db.batch(b)
    await db.close()
  }
  console.log(`${c.id}: shop seeded (${(performance.now() - t).toFixed(0)} ms)`)
}
