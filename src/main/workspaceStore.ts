import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { parseSavedSearch } from '../core/savedSearch.ts'
import type { TableRef } from '../core/sqlRefs.ts'
import type { AliasTarget, DbRef, Environment, ParamValue, ProjectAlias, RunAnomaly, QueryVersion, SavedRun, SchemaCheck, Snippet, SnippetInput, HistoryEntry, HistoryQuery, Project, ProjectInput, RunInfo, SavedQuery, SavedQueryFilter, SavedQueryInput } from '../shared/types'
import { t } from '../shared/i18n.ts'

/**
 * Migracije sheme, redom; indeks + 1 je PRAGMA user_version nakon migracije.
 * Nove faze (povijest izvršavanja, verzije, FTS…) dodaju se na kraj, postojeće se ne mijenjaju.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE project (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     color TEXT,
     archived INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE project_database (
     project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
     connection_id TEXT NOT NULL,
     database TEXT NOT NULL,
     PRIMARY KEY (project_id, connection_id, database)
   );
   CREATE INDEX project_database_conn ON project_database(connection_id, database);
   CREATE TABLE saved_query (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     sql TEXT NOT NULL,
     connection_id TEXT,
     database TEXT,
     pinned INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE project_query (
     project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
     query_id INTEGER NOT NULL REFERENCES saved_query(id) ON DELETE CASCADE,
     PRIMARY KEY (project_id, query_id)
   );
   CREATE INDEX project_query_query ON project_query(query_id);`,
  // v2: povijest izvršavanja s fingerprintom (#sqm-2)
  `CREATE TABLE query_run (
     id INTEGER PRIMARY KEY,
     query_id INTEGER REFERENCES saved_query(id) ON DELETE SET NULL,
     sql_text TEXT NOT NULL,
     sql_fingerprint TEXT NOT NULL,
     connection_id TEXT NOT NULL,
     connection_name TEXT NOT NULL,
     database TEXT,
     project_id INTEGER REFERENCES project(id) ON DELETE SET NULL,
     started_at TEXT NOT NULL,
     duration_ms REAL NOT NULL,
     row_count INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('success', 'error', 'cancelled')),
     error TEXT
   );
   CREATE INDEX query_run_started ON query_run(started_at);
   CREATE INDEX query_run_fingerprint ON query_run(sql_fingerprint, started_at);
   CREATE INDEX query_run_query ON query_run(query_id);
   ALTER TABLE saved_query ADD COLUMN fingerprint TEXT;
   CREATE INDEX saved_query_fingerprint ON saved_query(fingerprint);
   CREATE TABLE fingerprint_ignored (
     fingerprint TEXT PRIMARY KEY,
     ignored_at TEXT NOT NULL
   );`,
  // v3: pretraga (FTS5 trigram, bez dijakritika) i tablice koje query koristi (#sqm-3)
  `CREATE VIRTUAL TABLE saved_query_fts USING fts5(
     title, description, sql, content='saved_query', content_rowid='id', tokenize='trigram remove_diacritics 1'
   );
   CREATE TRIGGER saved_query_fts_ai AFTER INSERT ON saved_query BEGIN
     INSERT INTO saved_query_fts(rowid, title, description, sql) VALUES (new.id, new.title, new.description, new.sql);
   END;
   CREATE TRIGGER saved_query_fts_ad AFTER DELETE ON saved_query BEGIN
     INSERT INTO saved_query_fts(saved_query_fts, rowid, title, description, sql) VALUES ('delete', old.id, old.title, old.description, old.sql);
   END;
   CREATE TRIGGER saved_query_fts_au AFTER UPDATE OF title, description, sql ON saved_query BEGIN
     INSERT INTO saved_query_fts(saved_query_fts, rowid, title, description, sql) VALUES ('delete', old.id, old.title, old.description, old.sql);
     INSERT INTO saved_query_fts(rowid, title, description, sql) VALUES (new.id, new.title, new.description, new.sql);
   END;
   INSERT INTO saved_query_fts(saved_query_fts) VALUES ('rebuild');
   CREATE TABLE query_table_ref (
     query_id INTEGER NOT NULL REFERENCES saved_query(id) ON DELETE CASCADE,
     schema_name TEXT NOT NULL DEFAULT '',
     table_name TEXT NOT NULL,
     PRIMARY KEY (query_id, schema_name, table_name)
   );
   CREATE INDEX query_table_ref_table ON query_table_ref(table_name, schema_name);
   ALTER TABLE saved_query ADD COLUMN statement_types TEXT;`,
  // v4: aliasi baza po okruženju, zapamćene vrijednosti varijabli (#sqm-4)
  `ALTER TABLE project ADD COLUMN default_env TEXT NOT NULL DEFAULT 'dev';
   CREATE TABLE project_alias (
     id INTEGER PRIMARY KEY,
     project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     UNIQUE (project_id, name)
   );
   CREATE TABLE project_alias_target (
     alias_id INTEGER NOT NULL REFERENCES project_alias(id) ON DELETE CASCADE,
     env TEXT NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
     connection_id TEXT NOT NULL,
     database TEXT NOT NULL,
     PRIMARY KEY (alias_id, env)
   );
   ALTER TABLE saved_query ADD COLUMN alias_id INTEGER REFERENCES project_alias(id) ON DELETE SET NULL;
   CREATE TABLE param_value (
     project_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     value TEXT NOT NULL,
     type TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, name)
   );
   ALTER TABLE query_run ADD COLUMN params_json TEXT;`,
  // v5: verzije, mape, provjera sheme, snippeti (#sqm-5b)
  `CREATE TABLE query_version (
     id INTEGER PRIMARY KEY,
     query_id INTEGER NOT NULL REFERENCES saved_query(id) ON DELETE CASCADE,
     sql TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX query_version_query ON query_version(query_id, id);
   INSERT INTO query_version (query_id, sql, created_at) SELECT id, sql, updated_at FROM saved_query ORDER BY id;
   ALTER TABLE query_run ADD COLUMN version_id INTEGER REFERENCES query_version(id) ON DELETE SET NULL;
   CREATE INDEX query_run_version ON query_run(version_id);
   ALTER TABLE saved_query ADD COLUMN folder TEXT NOT NULL DEFAULT '';
   ALTER TABLE saved_query ADD COLUMN schema_check TEXT;
   CREATE TABLE snippet (
     id INTEGER PRIMARY KEY,
     project_id INTEGER REFERENCES project(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`
]

/** Objekt baze za provjeru sheme (tablice i viewovi iz Explorera). */
export interface SchemaObject {
  kind: string
  schema?: string
  name: string
}

const ENV_ORDER: Environment[] = ['dev', 'test', 'prod']

/** Analiza SQL-a spremljenog queryja (main je računa po dijalektu konekcije). */
export interface QueryMeta {
  fingerprint?: string
  tables?: TableRef[]
  types?: string[]
}

/** Mapa: dijelovi odvojeni '/', bez praznih dijelova i razmaka na rubovima. */
export function normalizeFolder(f: string): string {
  return f.split('/').map((x) => x.trim()).filter(Boolean).join('/')
}

/** FTS izraz: svaki pojam kao fraza u navodnicima (trigram traži podniz). */
const ftsPhrase = (t: string) => '"' + t.replace(/"/g, '""') + '"'

/** Koliko se izvršavanja čuva (najnovija). */
const MAX_RUNS = 20000
const MAX_SQL_CHARS = 64 * 1024
const DEFAULT_HISTORY_LIMIT = 500
/** Prijedlog spremanja: barem ovoliko izvršavanja istog fingerprinta u zadnjih 7 dana. */
export const SUGGEST_RUNS = 5
const SUGGEST_DAYS = 7
/** Anomalije: usporedba s najviše ovoliko prethodnih uspješnih izvršavanja, a barem MIN. */
const ANOMALY_WINDOW = 20
const ANOMALY_MIN = 3
const SLOW_FACTOR = 5
const SLOW_MIN_MS = 1000

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface NewRun {
  sql: string
  fingerprint: string
  connectionId: string
  connectionName: string
  database?: string
  queryId?: number
  projectId?: number
  startedAt: string
  durationMs: number
  rows: number
  status: 'success' | 'error' | 'cancelled'
  error?: string
  params?: Record<string, ParamValue>
}

interface RunRow {
  id: number
  query_id: number | null
  sql_text: string
  connection_id: string
  connection_name: string
  database: string | null
  started_at: string
  duration_ms: number
  row_count: number
  status: string
  error: string | null
  repeats: number
  params_json: string | null
}

interface ProjectRow {
  id: number
  name: string
  description: string
  color: string | null
  archived: number
  query_count: number
  default_env: string
}

interface SavedRow {
  id: number
  title: string
  description: string
  sql: string
  connection_id: string | null
  database: string | null
  pinned: number
  created_at: string
  updated_at: string
  run_count: number
  last_run_at: string | null
  statement_types: string | null
  alias_id: number | null
  folder: string
  schema_check: string | null
  version_count: number
}

const SAVED_SELECT = `SELECT s.*,
  (SELECT COUNT(*) FROM query_run r WHERE r.query_id = s.id) AS run_count,
  (SELECT MAX(started_at) FROM query_run r WHERE r.query_id = s.id) AS last_run_at,
  (SELECT COUNT(*) FROM query_version v WHERE v.query_id = s.id) AS version_count
  FROM saved_query s`

/** Projekti i spremljeni queryji u %APPDATA%/QuCore/qucore.db (SQLite ugrađen u Node/Electron). */
export class WorkspaceStore {
  private db: DatabaseSync

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    this.migrate()
  }

  private migrate(): void {
    const { user_version: current } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v])
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params)
  }

  close(): void {
    this.db.close()
  }

  // ---- Projekti ----

  listProjects(): Project[] {
    const rows = this.all<ProjectRow>(
      `SELECT p.*, (SELECT COUNT(*) FROM project_query q WHERE q.project_id = p.id) AS query_count
       FROM project p ORDER BY p.archived, p.name COLLATE NOCASE`
    )
    const dbs = this.all<{ project_id: number; connection_id: string; database: string }>(
      'SELECT project_id, connection_id, database FROM project_database ORDER BY database COLLATE NOCASE'
    )
    const aliases = this.all<{ id: number; project_id: number; name: string }>('SELECT * FROM project_alias ORDER BY name COLLATE NOCASE')
    const targets = this.all<{ alias_id: number; env: Environment; connection_id: string; database: string }>('SELECT * FROM project_alias_target')
    const aliasOf = (a: { id: number; name: string }): ProjectAlias => ({
      id: a.id,
      name: a.name,
      targets: targets
        .filter((t) => t.alias_id === a.id)
        .map((t): AliasTarget => ({ env: t.env, connectionId: t.connection_id, database: t.database }))
        .sort((x, y) => ENV_ORDER.indexOf(x.env) - ENV_ORDER.indexOf(y.env))
    })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      color: r.color ?? undefined,
      archived: !!r.archived,
      queryCount: r.query_count,
      databases: dbs.filter((d) => d.project_id === r.id).map((d) => ({ connectionId: d.connection_id, database: d.database })),
      defaultEnv: (ENV_ORDER as string[]).includes(r.default_env) ? (r.default_env as Environment) : 'dev',
      aliases: aliases.filter((a) => a.project_id === r.id).map(aliasOf)
    }))
  }

  setDefaultEnv(id: number, env: Environment): void {
    if (!ENV_ORDER.includes(env)) throw new Error(t('main.unknownEnv', env))
    this.run('UPDATE project SET default_env = ? WHERE id = ?', env, id)
  }

  saveProject(p: ProjectInput): Project {
    const name = p.name.trim()
    if (!name) throw new Error(t('main.projectNameRequired'))
    const id = this.tx(() => {
      let id = p.id
      if (id) {
        const r = this.run(
          'UPDATE project SET name = ?, description = ?, color = ?, archived = ? WHERE id = ?',
          name, p.description ?? '', p.color ?? null, p.archived ? 1 : 0, id
        )
        if (!r.changes) throw new Error(t('main.projectMissing'))
      } else {
        id = Number(
          this.run('INSERT INTO project (name, description, color, archived) VALUES (?, ?, ?, ?)', name, p.description ?? '', p.color ?? null, p.archived ? 1 : 0)
            .lastInsertRowid
        )
      }
      if (p.databases) {
        this.run('DELETE FROM project_database WHERE project_id = ?', id)
        for (const d of p.databases) {
          this.run('INSERT OR IGNORE INTO project_database (project_id, connection_id, database) VALUES (?, ?, ?)', id, d.connectionId, d.database)
        }
      }
      if (p.defaultEnv) this.setDefaultEnv(id, p.defaultEnv)
      if (p.aliases) this.replaceAliases(id, p.aliases)
      return id
    })
    return this.listProjects().find((x) => x.id === id)!
  }

  /** Zamjenjuje aliase projekta; postojeći (s id-em) se ažuriraju, pa spremljeni queryji ostaju vezani. */
  private replaceAliases(projectId: number, aliases: NonNullable<ProjectInput['aliases']>): void {
    const names = new Set<string>()
    for (const a of aliases) {
      const name = a.name.trim()
      if (!name) throw new Error(t('main.aliasNameRequired'))
      if (names.has(name.toLowerCase())) throw new Error(t('main.aliasDuplicate', name))
      names.add(name.toLowerCase())
    }
    const keep = aliases.filter((a) => a.id).map((a) => a.id!)
    this.run(
      `DELETE FROM project_alias WHERE project_id = ?${keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}`,
      projectId,
      ...keep
    )
    // Privremeni nazivi da zamjena dvaju naziva ne prekrši UNIQUE (project_id, name).
    for (const id of keep) this.run("UPDATE project_alias SET name = '~tmp~' || id WHERE id = ? AND project_id = ?", id, projectId)
    for (const a of aliases) {
      let aliasId = a.id
      if (aliasId) {
        const r = this.run('UPDATE project_alias SET name = ? WHERE id = ? AND project_id = ?', a.name.trim(), aliasId, projectId)
        if (!r.changes) throw new Error(t('main.aliasMissingNamed', a.name))
      } else {
        aliasId = Number(this.run('INSERT INTO project_alias (project_id, name) VALUES (?, ?)', projectId, a.name.trim()).lastInsertRowid)
      }
      this.run('DELETE FROM project_alias_target WHERE alias_id = ?', aliasId)
      for (const t of a.targets) {
        this.run(
          'INSERT OR REPLACE INTO project_alias_target (alias_id, env, connection_id, database) VALUES (?, ?, ?, ?)',
          aliasId, t.env, t.connectionId, t.database
        )
      }
    }
  }

  removeProject(id: number): void {
    this.run('DELETE FROM project WHERE id = ?', id)
  }

  setDatabaseProjects(ref: DbRef, projectIds: number[]): void {
    this.tx(() => {
      this.run('DELETE FROM project_database WHERE connection_id = ? AND database = ?', ref.connectionId, ref.database)
      for (const pid of projectIds) {
        this.run('INSERT OR IGNORE INTO project_database (project_id, connection_id, database) VALUES (?, ?, ?)', pid, ref.connectionId, ref.database)
      }
    })
  }

  /** Obrisana konekcija: njene baze izlaze iz projekata; spremljeni queryji ostaju (bez konekcije). */
  forgetConnection(connectionId: string): void {
    this.tx(() => {
      this.run('DELETE FROM project_database WHERE connection_id = ?', connectionId)
      this.run('DELETE FROM project_alias_target WHERE connection_id = ?', connectionId)
      this.run('UPDATE saved_query SET connection_id = NULL, database = NULL WHERE connection_id = ?', connectionId)
    })
  }

  // ---- Spremljeni queryji ----

  private toSaved(r: SavedRow, projects: Map<number, number[]>, tables: Map<number, string[]>): SavedQuery {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      sql: r.sql,
      connectionId: r.connection_id ?? undefined,
      database: r.database ?? undefined,
      pinned: !!r.pinned,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      projectIds: projects.get(r.id) ?? [],
      runCount: r.run_count,
      lastRunAt: r.last_run_at ?? undefined,
      aliasId: r.alias_id ?? undefined,
      folder: r.folder,
      versionCount: r.version_count,
      schemaCheck: r.schema_check ? (JSON.parse(r.schema_check) as SchemaCheck) : undefined,
      tables: tables.get(r.id) ?? [],
      statementTypes: (r.statement_types ?? '').split(',').filter(Boolean)
    }
  }

  private tablesOf(ids: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>()
    if (!ids.length) return out
    const rows = this.all<{ query_id: number; schema_name: string; table_name: string }>(
      `SELECT query_id, schema_name, table_name FROM query_table_ref WHERE query_id IN (${ids.map(() => '?').join(',')})
       ORDER BY table_name, schema_name`,
      ...ids
    )
    for (const r of rows) out.set(r.query_id, [...(out.get(r.query_id) ?? []), r.schema_name ? `${r.schema_name}.${r.table_name}` : r.table_name])
    return out
  }

  private projectsOf(ids: number[]): Map<number, number[]> {
    const out = new Map<number, number[]>()
    if (!ids.length) return out
    const rows = this.all<{ project_id: number; query_id: number }>(
      `SELECT project_id, query_id FROM project_query WHERE query_id IN (${ids.map(() => '?').join(',')})`,
      ...ids
    )
    for (const r of rows) out.set(r.query_id, [...(out.get(r.query_id) ?? []), r.project_id])
    return out
  }

  /**
   * Spremljeni queryji, prikvačeni prvi. search podržava filtere (vidi core/savedSearch.ts):
   * različiti filteri se kombiniraju s AND, više vrijednosti istog filtra (type:, db:) s OR, tablice i projekti s AND.
   */
  listSaved(f: SavedQueryFilter = {}): SavedQuery[] {
    const where: string[] = []
    const params: SQLInputValue[] = []
    let fts: string | undefined
    if (f.projectId) {
      where.push('s.id IN (SELECT query_id FROM project_query WHERE project_id = ?)')
      params.push(f.projectId)
    }
    const q = parseSavedSearch(f.search ?? '')
    const long = q.terms.filter((t) => [...t].length >= 3)
    if (long.length) fts = long.map(ftsPhrase).join(' AND ')
    for (const t of q.terms.filter((x) => [...x].length < 3)) {
      // Trigram ne indeksira kraće od 3 znaka; instr nad lower() (LIKE bi % i _ shvatio kao zamjenske znakove).
      where.push('(instr(lower(s.title), ?) > 0 OR instr(lower(s.description), ?) > 0 OR instr(lower(s.sql), ?) > 0)')
      const v = t.toLowerCase()
      params.push(v, v, v)
    }
    for (const name of q.projects) {
      where.push(`s.id IN (SELECT pq.query_id FROM project_query pq JOIN project p ON p.id = pq.project_id WHERE lower(p.name) = lower(?))`)
      params.push(name)
    }
    for (const t of q.tables) {
      where.push(`s.id IN (SELECT query_id FROM query_table_ref WHERE table_name = ?${t.schema ? ' AND schema_name = ?' : ''})`)
      params.push(t.table, ...(t.schema ? [t.schema] : []))
    }
    if (q.types.length) {
      where.push('(' + q.types.map(() => "instr(',' || coalesce(s.statement_types, '') || ',', ',' || ? || ',') > 0").join(' OR ') + ')')
      params.push(...q.types)
    }
    if (q.dbs.length) {
      where.push(`lower(s.database) IN (${q.dbs.map(() => '?').join(',')})`)
      params.push(...q.dbs)
    }
    const lastRun = '(SELECT MAX(started_at) FROM query_run r WHERE r.query_id = s.id)'
    if (q.ranWithinDays !== undefined) {
      where.push(`${lastRun} >= ?`)
      params.push(new Date(Date.now() - q.ranWithinDays * 86400000).toISOString())
    }
    if (q.notRunForDays !== undefined) {
      where.push(`(${lastRun} IS NULL OR ${lastRun} < ?)`)
      params.push(new Date(Date.now() - q.notRunForDays * 86400000).toISOString())
    }
    if (q.pinned) where.push('s.pinned = 1')
    if (q.broken) where.push("json_array_length(s.schema_check, '$.missing') > 0")

    const join = fts ? 'JOIN (SELECT rowid, bm25(saved_query_fts) AS rank FROM saved_query_fts WHERE saved_query_fts MATCH ?) f ON f.rowid = s.id' : ''
    const rows = this.all<SavedRow>(
      `${SAVED_SELECT} ${join} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.pinned DESC, ${fts ? 'f.rank, ' : ''}s.updated_at DESC`,
      ...(fts ? [fts] : []),
      ...params
    )
    const ids = rows.map((r) => r.id)
    const projects = this.projectsOf(ids)
    const tables = this.tablesOf(ids)
    return rows.map((r) => this.toSaved(r, projects, tables))
  }

  getSaved(id: number): SavedQuery | null {
    const r = this.all<SavedRow>(`${SAVED_SELECT} WHERE s.id = ?`, id)[0]
    return r ? this.toSaved(r, this.projectsOf([id]), this.tablesOf([id])) : null
  }

  /** Analiza (tablice, vrste naredbi) jednog queryja; poziva se pri spremanju i za stare queryje. */
  setAnalysis(id: number, tables: TableRef[], types: string[]): void {
    this.run('DELETE FROM query_table_ref WHERE query_id = ?', id)
    for (const t of tables) {
      this.run('INSERT OR IGNORE INTO query_table_ref (query_id, schema_name, table_name) VALUES (?, ?, ?)', id, t.schema ?? '', t.table)
    }
    this.run('UPDATE saved_query SET statement_types = ? WHERE id = ?', types.join(','), id)
  }

  /** Queryji spremljeni prije v3 (bez analize). */
  unanalyzed(): { id: number; sql: string; connectionId?: string }[] {
    return this.all<{ id: number; sql: string; connection_id: string | null }>(
      'SELECT id, sql, connection_id FROM saved_query WHERE statement_types IS NULL'
    ).map((r) => ({ id: r.id, sql: r.sql, connectionId: r.connection_id ?? undefined }))
  }

  /** meta: fingerprint (spremljen query se više ne predlaže) i analiza SQL-a, računa ih main po dijalektu konekcije. */
  saveQuery(q: SavedQueryInput, meta: QueryMeta = {}): SavedQuery {
    const fingerprint = meta.fingerprint
    const title = q.title.trim()
    if (!title) throw new Error(t('main.queryTitleRequired'))
    if (!q.sql.trim()) throw new Error(t('main.queryEmpty'))
    const now = new Date().toISOString()
    const folder = q.folder === undefined ? undefined : normalizeFolder(q.folder)
    const id = this.tx(() => {
      let id = q.id
      let sqlChanged = true
      if (id) {
        const prev = this.all<{ sql: string }>('SELECT sql FROM saved_query WHERE id = ?', id)[0]
        if (!prev) throw new Error(t('main.savedMissing'))
        sqlChanged = prev.sql !== q.sql
        this.run(
          `UPDATE saved_query SET title = ?, description = ?, sql = ?, connection_id = ?, database = ?,
             pinned = COALESCE(?, pinned), updated_at = ?, fingerprint = ?, alias_id = ?, folder = COALESCE(?, folder),
             schema_check = CASE WHEN ? THEN NULL ELSE schema_check END WHERE id = ?`,
          title, q.description ?? '', q.sql, q.connectionId ?? null, q.database ?? null,
          q.pinned === undefined ? null : q.pinned ? 1 : 0, now, fingerprint ?? null, q.aliasId ?? null, folder ?? null,
          sqlChanged ? 1 : 0, id
        )
      } else {
        id = Number(
          this.run(
            `INSERT INTO saved_query (title, description, sql, connection_id, database, pinned, created_at, updated_at, fingerprint, alias_id, folder)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            title, q.description ?? '', q.sql, q.connectionId ?? null, q.database ?? null, q.pinned ? 1 : 0, now, now, fingerprint ?? null,
            q.aliasId ?? null, folder ?? ''
          ).lastInsertRowid
        )
      }
      // Nova verzija samo kad se SQL promijenio (naslov, opis i projekti nisu verzija).
      if (sqlChanged) this.run('INSERT INTO query_version (query_id, sql, created_at) VALUES (?, ?, ?)', id, q.sql, now)
      this.run('DELETE FROM project_query WHERE query_id = ?', id)
      const projectIds = new Set(q.projectIds)
      // Alias pripada projektu: query mora biti i u tom projektu.
      if (q.aliasId) {
        const owner = this.all<{ project_id: number }>('SELECT project_id FROM project_alias WHERE id = ?', q.aliasId)[0]
        if (!owner) throw new Error(t('main.aliasMissing'))
        projectIds.add(owner.project_id)
      }
      for (const pid of projectIds) this.run('INSERT OR IGNORE INTO project_query (project_id, query_id) VALUES (?, ?)', pid, id)
      if (meta.tables && meta.types) this.setAnalysis(id, meta.tables, meta.types)
      return id
    })
    return this.getSaved(id)!
  }

  removeSaved(id: number): void {
    this.run('DELETE FROM saved_query WHERE id = ?', id)
  }

  setPinned(id: number, pinned: boolean): void {
    this.run('UPDATE saved_query SET pinned = ? WHERE id = ?', pinned ? 1 : 0, id)
  }

  // ---- Verzije, trend, mape ----

  versions(queryId: number): QueryVersion[] {
    return this.all<{ id: number; sql: string; created_at: string; runs: number }>(
      `SELECT v.id, v.sql, v.created_at, (SELECT COUNT(*) FROM query_run r WHERE r.version_id = v.id) AS runs
       FROM query_version v WHERE v.query_id = ? ORDER BY v.id`,
      queryId
    ).map((v, i) => ({ id: v.id, number: i + 1, sql: v.sql, createdAt: v.created_at, runCount: v.runs }))
  }

  version(queryId: number, versionId: number): QueryVersion | undefined {
    return this.versions(queryId).find((v) => v.id === versionId)
  }

  savedRuns(queryId: number, limit = 30): SavedRun[] {
    const numbers = new Map(this.versions(queryId).map((v) => [v.id, v.number]))
    return this.all<{ id: number; started_at: string; duration_ms: number; row_count: number; status: SavedRun['status']; version_id: number | null }>(
      'SELECT id, started_at, duration_ms, row_count, status, version_id FROM query_run WHERE query_id = ? ORDER BY id DESC LIMIT ?',
      queryId,
      limit
    ).map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      rows: r.row_count,
      status: r.status,
      versionNumber: r.version_id ? numbers.get(r.version_id) : undefined
    }))
  }

  folders(): string[] {
    return this.all<{ folder: string }>("SELECT DISTINCT folder FROM saved_query WHERE folder <> '' ORDER BY folder COLLATE NOCASE").map((r) => r.folder)
  }

  // ---- Provjera sheme ----

  /**
   * Explorer je učitao objekte baze: spremljeni queryji na toj bazi (izravno ili preko aliasa) dobivaju popis
   * tablica koje nisu pronađene. Preskaču se #temp, tablice nepoznate sheme (druga baza, sys…) i queryji s DDL-om.
   */
  checkSchema(connectionId: string, database: string, objects: SchemaObject[]): number {
    const rel = objects.filter((o) => o.kind === 'table' || o.kind === 'view')
    const names = new Set(rel.map((o) => o.name.toLowerCase()))
    const qualified = new Set(rel.filter((o) => o.schema).map((o) => `${o.schema!.toLowerCase()}.${o.name.toLowerCase()}`))
    const schemas = new Set(rel.filter((o) => o.schema).map((o) => o.schema!.toLowerCase()))
    const db = database.toLowerCase()
    const queries = this.all<{ id: number; statement_types: string | null }>(
      `SELECT s.id, s.statement_types FROM saved_query s
       WHERE (s.connection_id = ? AND s.database = ?)
          OR s.alias_id IN (SELECT alias_id FROM project_alias_target WHERE connection_id = ? AND database = ?)`,
      connectionId, database, connectionId, database
    )
    const at = new Date().toISOString()
    let changed = 0
    for (const q of queries) {
      if ((q.statement_types ?? '').split(',').includes('ddl')) continue
      const refs = this.all<{ schema_name: string; table_name: string }>('SELECT schema_name, table_name FROM query_table_ref WHERE query_id = ?', q.id)
      const missing: string[] = []
      for (const r of refs) {
        if (r.table_name.startsWith('#')) continue
        if (r.schema_name) {
          if (schemas.has(r.schema_name)) {
            if (!qualified.has(`${r.schema_name}.${r.table_name}`)) missing.push(`${r.schema_name}.${r.table_name}`)
          } else if (r.schema_name === db) {
            if (!names.has(r.table_name)) missing.push(r.table_name)
          }
          continue
        }
        if (!names.has(r.table_name)) missing.push(r.table_name)
      }
      const check: SchemaCheck = { connectionId, database, missing, at }
      this.run('UPDATE saved_query SET schema_check = ? WHERE id = ?', JSON.stringify(check), q.id)
      changed++
    }
    return changed
  }

  // ---- Snippeti ----

  listSnippets(projectId: number | null): Snippet[] {
    return this.all<{ id: number; project_id: number | null; name: string; body: string; updated_at: string }>(
      'SELECT * FROM snippet WHERE project_id IS NULL OR project_id = ? ORDER BY name COLLATE NOCASE',
      projectId ?? -1
    ).map((r) => ({ id: r.id, projectId: r.project_id, name: r.name, body: r.body, updatedAt: r.updated_at }))
  }

  saveSnippet(s: SnippetInput): Snippet {
    const name = s.name.trim()
    if (!name) throw new Error(t('main.snippetNameRequired'))
    if (!s.body.trim()) throw new Error(t('main.snippetEmpty'))
    const now = new Date().toISOString()
    let id = s.id
    if (id) {
      const r = this.run('UPDATE snippet SET project_id = ?, name = ?, body = ?, updated_at = ? WHERE id = ?', s.projectId, name, s.body, now, id)
      if (!r.changes) throw new Error(t('main.snippetMissing'))
    } else {
      id = Number(
        this.run('INSERT INTO snippet (project_id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', s.projectId, name, s.body, now, now)
          .lastInsertRowid
      )
    }
    const r = this.all<{ id: number; project_id: number | null; name: string; body: string; updated_at: string }>('SELECT * FROM snippet WHERE id = ?', id)[0]
    return { id: r.id, projectId: r.project_id, name: r.name, body: r.body, updatedAt: r.updated_at }
  }

  removeSnippet(id: number): void {
    this.run('DELETE FROM snippet WHERE id = ?', id)
  }

  // ---- Povijest izvršavanja ----

  private insertsSincePrune = 0

  private insertRun(r: NewRun): number {
    const sql = r.sql.length > MAX_SQL_CHARS ? r.sql.slice(0, MAX_SQL_CHARS) : r.sql
    return Number(
      this.run(
        `INSERT INTO query_run (query_id, sql_text, sql_fingerprint, connection_id, connection_name, database, project_id,
           started_at, duration_ms, row_count, status, error, params_json, version_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT MAX(id) FROM query_version WHERE query_id = ?))`,
        r.queryId ?? null, sql, r.fingerprint, r.connectionId, r.connectionName, r.database ?? null, r.projectId ?? null,
        r.startedAt, r.durationMs, r.rows, r.status, r.error ?? null,
        r.params && Object.keys(r.params).length ? JSON.stringify(r.params) : null,
        r.queryId ?? null
      ).lastInsertRowid
    )
  }

  /** Zapisuje izvršavanje i vraća podatke za prijedlog spremanja. */
  addRun(r: NewRun): RunInfo {
    // Query ili projekt obrisan u međuvremenu: izvršavanje se svejedno zapisuje, bez veze.
    const queryId = r.queryId && this.all('SELECT 1 FROM saved_query WHERE id = ?', r.queryId).length ? r.queryId : undefined
    const projectId = r.projectId && this.all('SELECT 1 FROM project WHERE id = ?', r.projectId).length ? r.projectId : undefined
    const anomaly = r.status === 'success' ? this.anomalyOf(r) : undefined
    const runId = this.insertRun({ ...r, queryId, projectId })
    if (++this.insertsSincePrune >= 500) {
      this.insertsSincePrune = 0
      this.prune()
    }
    const since = new Date(Date.now() - SUGGEST_DAYS * 86400000).toISOString()
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM query_run WHERE sql_fingerprint = ? AND started_at >= ?')
      .get(r.fingerprint, since) as { n: number }
    const known =
      this.all('SELECT 1 FROM saved_query WHERE fingerprint = ? LIMIT 1', r.fingerprint).length > 0 ||
      this.all('SELECT 1 FROM fingerprint_ignored WHERE fingerprint = ?', r.fingerprint).length > 0
    return { runId, fingerprint: r.fingerprint, recentRuns: n, suggestSave: !queryId && !known && n >= SUGGEST_RUNS, anomaly }
  }

  /** Usporedba s prethodnim uspješnim izvršavanjima istog upita na istoj konekciji i bazi (druga baza = drugi podaci). */
  private anomalyOf(r: NewRun): RunAnomaly | undefined {
    const prev = this.all<{ duration_ms: number; row_count: number }>(
      `SELECT duration_ms, row_count FROM query_run
       WHERE sql_fingerprint = ? AND connection_id = ? AND database IS ? AND status = 'success'
       ORDER BY id DESC LIMIT ?`,
      r.fingerprint, r.connectionId, r.database ?? null, ANOMALY_WINDOW
    )
    if (prev.length < ANOMALY_MIN) return undefined
    const medianMs = median(prev.map((x) => x.duration_ms))
    const medianRows = median(prev.map((x) => x.row_count))
    const base = { samples: prev.length, medianMs, medianRows }
    if (r.durationMs > SLOW_MIN_MS && r.durationMs > SLOW_FACTOR * medianMs) return { kind: 'slow', ...base }
    if (r.rows === 0 && medianRows > 0) return { kind: 'empty', ...base }
    return undefined
  }

  /** Jednokratni uvoz stare povijesti (history.jsonl), najstariji prvi. */
  importRuns(runs: NewRun[]): void {
    this.tx(() => {
      for (const r of runs) this.insertRun(r)
    })
    this.prune()
  }

  runCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM query_run').get() as { n: number }).n
  }

  private prune(): void {
    this.run(
      `DELETE FROM query_run WHERE id < (SELECT id FROM query_run ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      MAX_RUNS - 1
    )
  }

  /** Najnovija prva. scope = baze aktivnog projekta (izvršavanje bez zapisane baze broji se uz konekciju). */
  listRuns(q: HistoryQuery = {}): HistoryEntry[] {
    const where: string[] = []
    const params: SQLInputValue[] = []
    if (q.connectionId) {
      where.push('r.connection_id = ?')
      params.push(q.connectionId)
    }
    const search = q.search?.trim()
    if (search) {
      where.push('instr(lower(r.sql_text), ?) > 0')
      params.push(search.toLowerCase())
    }
    if (q.scope) {
      const byConn = new Map<string, string[]>()
      for (const d of q.scope) byConn.set(d.connectionId, [...(byConn.get(d.connectionId) ?? []), d.database])
      if (!byConn.size) return []
      const parts: string[] = []
      for (const [conn, dbs] of byConn) {
        parts.push(`(r.connection_id = ? AND (r.database IS NULL OR r.database IN (${dbs.map(() => '?').join(',')})))`)
        params.push(conn, ...dbs)
      }
      where.push('(' + parts.join(' OR ') + ')')
    }
    params.push(q.limit ?? DEFAULT_HISTORY_LIMIT)
    const rows = this.all<RunRow>(
      `SELECT r.*, (SELECT COUNT(*) FROM query_run x WHERE x.sql_fingerprint = r.sql_fingerprint) AS repeats
       FROM query_run r ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY r.id DESC LIMIT ?`,
      ...params
    )
    return rows.map((r) => ({
      id: String(r.id),
      ts: r.started_at,
      connectionId: r.connection_id,
      connectionName: r.connection_name,
      database: r.database ?? undefined,
      sql: r.sql_text,
      durationMs: r.duration_ms,
      rows: r.row_count,
      error: r.status === 'error' ? (r.error ?? t('main.error')) : undefined,
      cancelled: r.status === 'cancelled' || undefined,
      repeats: r.repeats,
      savedQueryId: r.query_id ?? undefined,
      params: r.params_json ? (JSON.parse(r.params_json) as Record<string, ParamValue>) : undefined
    }))
  }

  removeRun(id: string): void {
    this.run('DELETE FROM query_run WHERE id = ?', Number(id))
  }

  clearRuns(): void {
    this.run('DELETE FROM query_run')
  }

  // ---- Vrijednosti varijabli ----

  getParams(projectId: number | null, names: string[]): Record<string, ParamValue> {
    const out: Record<string, ParamValue> = {}
    if (!names.length) return out
    const rows = this.all<{ name: string; value: string; type: ParamValue['type'] }>(
      `SELECT name, value, type FROM param_value WHERE project_id = ? AND name IN (${names.map(() => '?').join(',')})`,
      projectId ?? 0,
      ...names
    )
    for (const r of rows) out[r.name] = { value: r.value, type: r.type }
    return out
  }

  saveParams(projectId: number | null, values: Record<string, ParamValue>): void {
    const now = new Date().toISOString()
    this.tx(() => {
      for (const [name, v] of Object.entries(values)) {
        this.run(
          'INSERT OR REPLACE INTO param_value (project_id, name, value, type, updated_at) VALUES (?, ?, ?, ?, ?)',
          projectId ?? 0, name, v.value, v.type, now
        )
      }
    })
  }

  ignoreFingerprint(fingerprint: string): void {
    this.run('INSERT OR REPLACE INTO fingerprint_ignored (fingerprint, ignored_at) VALUES (?, ?)', fingerprint, new Date().toISOString())
  }
}
