// Konekcije na testne baze za test:core i seed-test-db. Zadano su baze iz docker/compose.yml;
// env varijable (PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, isto MARIA_* i MSSQL_*) ih mijenjaju,
// a TEST_DBS=pg,maria bira samo neke.
import type { ConnectionConfig } from '../src/shared/types.ts'

const env = process.env
const port = (v: string | undefined, d: number) => (v ? Number(v) : d)

const all: ConnectionConfig[] = [
  { id: 'pg', name: 'pg', type: 'postgres', host: env.PG_HOST ?? '127.0.0.1', port: port(env.PG_PORT, 15432), user: env.PG_USER ?? 'postgres', password: env.PG_PASSWORD ?? 'studio' },
  { id: 'maria', name: 'maria', type: 'mariadb', host: env.MARIA_HOST ?? '127.0.0.1', port: port(env.MARIA_PORT, 13306), user: env.MARIA_USER ?? 'studio', password: env.MARIA_PASSWORD ?? 'studio' },
  { id: 'mssql', name: 'mssql', type: 'mssql', host: env.MSSQL_HOST ?? '127.0.0.1', port: port(env.MSSQL_PORT, 11433), user: env.MSSQL_USER ?? 'sa', password: env.MSSQL_PASSWORD ?? 'Studio_Passw0rd!', trustServerCertificate: true }
]

const only = env.TEST_DBS?.split(',').map((s) => s.trim())
export const testConfigs = only ? all.filter((c) => only.includes(c.id)) : all
