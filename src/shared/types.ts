import { t } from './i18n.ts'
// Tipovi koje dijele core sloj, Electron main proces, UI i (kasnije) web server.
// Sve što ovdje putuje mora biti čisti JSON, kako bi radilo i preko IPC-a i preko HTTP-a.

export type DbType = 'mssql' | 'postgres' | 'mariadb'

export const DB_TYPE_LABELS: Record<DbType, string> = {
  mssql: 'SQL Server',
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB / MySQL'
}

export const DEFAULT_PORTS: Record<DbType, number> = {
  mssql: 1433,
  postgres: 5432,
  mariadb: 3306
}

/** Okruženje konekcije; prod će dobiti dodatnu zaštitu (#sqm-5). */
export type Environment = 'dev' | 'test' | 'prod'

export const ENVIRONMENTS: Environment[] = ['dev', 'test', 'prod']

/** sql = SQL Server login, windows = trenutni Windows korisnik, ntlm = domena\korisnik + lozinka. */
export type MssqlAuth = 'sql' | 'windows' | 'ntlm'

export const MSSQL_AUTHS: MssqlAuth[] = ['sql', 'windows', 'ntlm']

export const mssqlAuthLabel = (a: MssqlAuth): string =>
  a === 'sql' ? 'SQL Server login' : a === 'windows' ? t('auth.windows') : t('auth.ntlm')

export interface ConnectionConfig {
  id: string
  name: string
  type: DbType
  host: string
  port: number
  user: string
  password?: string
  /** Početna baza (opcionalno). */
  database?: string
  /** SQL Server: način prijave (zadano 'sql'). */
  mssqlAuth?: MssqlAuth
  /** SQL Server NTLM: Windows domena. */
  domain?: string
  /** SQL Server: TLS enkripcija. */
  encrypt?: boolean
  /** SQL Server: prihvati self-signed certifikat. */
  trustServerCertificate?: boolean
  /** PostgreSQL / MariaDB: SSL konekcija. */
  ssl?: boolean
  /** Boja konekcije u sučelju (npr. crvena za produkciju). */
  color?: string
  /** dev / test / prod; bez vrijednosti = nije označeno. */
  environment?: Environment
}

/** Konekcija bez lozinke, za prikaz u UI-u. */
export type ConnectionInfo = Omit<ConnectionConfig, 'password'> & { hasPassword: boolean }

export type ObjectKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger'

/** Naziv grupe objekata u Exploreru (množina, u trenutnom jeziku). */
export const objectKindLabel = (k: ObjectKind): string => t(`kind.${k}`)

export interface DbObject {
  kind: ObjectKind
  schema?: string
  name: string
  /** Prikazni naziv (npr. funkcija s argumentima). */
  label?: string
  /** Interni identifikator (npr. PostgreSQL OID kod preopterećenih funkcija). */
  id?: string
  /** Za triggere: tablica na kojoj je trigger. */
  parent?: string
  /** Ima li djecu (kolone / parametre). */
  expandable: boolean
  /** Tablice: zauzeće na disku u bajtovima (podaci + indeksi), ako ga baza može dati. */
  sizeBytes?: number
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  primaryKey: boolean
  identity: boolean
  defaultValue?: string | null
}

export interface ParameterInfo {
  name: string
  dataType: string
  mode: 'IN' | 'OUT' | 'INOUT' | 'RETURN'
}

export type ChildInfo =
  | ({ type: 'column' } & ColumnInfo)
  | ({ type: 'parameter' } & ParameterInfo)

export type CellValue = string | number | boolean | null

/** Tablica u ER dijagramu. */
export interface GraphTable {
  schema?: string
  name: string
  columns: { name: string; type: string; nullable: boolean; primaryKey: boolean }[]
}

/** Strani ključ između dvije tablice (kolone u istom redoslijedu). */
export interface GraphForeignKey {
  name: string
  from: { schema?: string; table: string; columns: string[] }
  to: { schema?: string; table: string; columns: string[] }
}

/** Tablice i strani ključevi jedne baze, za ER dijagram. */
export interface IndexInfo {
  name: string
  /** Stupci ključa redom. */
  columns: string[]
  unique: boolean
  primary: boolean
  /** Vrsta (BTREE, HASH, CLUSTERED, gin…), ako je baza daje. */
  type?: string
  /** SQL Server INCLUDE stupci. */
  included?: string[]
}

/** Strani ključ: from* je tablica koja upućuje, to* tablica na koju upućuje. */
export interface ForeignKeyInfo {
  name: string
  fromSchema?: string
  fromTable: string
  fromColumns: string[]
  toSchema?: string
  toTable: string
  toColumns: string[]
}

export interface TableDetails {
  indexes: IndexInfo[]
  /** Strani ključevi ove tablice (ona upućuje na druge). */
  foreignKeys: ForeignKeyInfo[]
  /** Strani ključevi drugih tablica koji upućuju na ovu. */
  referencedBy: ForeignKeyInfo[]
}

export interface SchemaGraph {
  tables: GraphTable[]
  foreignKeys: GraphForeignKey[]
}

export interface ResultColumn {
  name: string
  type?: string
}

export interface ResultSet {
  columns: ResultColumn[]
  rows: CellValue[][]
  /** True ako je broj redaka odrezan na maxRows. */
  truncated: boolean
  totalRows: number
  /** Čitanje je pauzirano na limitu; fetchMore učitava dalje. */
  hasMore?: boolean
}

export interface QueryMessage {
  kind: 'info' | 'error' | 'rows'
  text: string
}

export interface QueryResult {
  resultSets: ResultSet[]
  messages: QueryMessage[]
  durationMs: number
  error?: string
  /** Korisnik je prekinuo upit; resultSets sadrže retke primljene do prekida. */
  cancelled?: boolean
  /** Upit je pauziran na Max redaka i ostaje otvoren na sesiji (vidi query.fetchMore). */
  pending?: boolean
  /** Zapis u povijesti (samo za query.execute). */
  runInfo?: RunInfo
  /** Stanje transakcije nakon izvršavanja (nema ga dok je rezultat pauziran). */
  tx?: TxState
}

/** Nastavak pauziranog upita: još jedna stranica, prebrojavanje ostatka ili zatvaranje. */
export type FetchMode = 'page' | 'count' | 'close'

/** Promjena jednog result seta od prethodne dojave napretka. */
export interface ResultSetDelta {
  index: number
  /** Samo u prvoj dojavi za taj set. */
  columns?: ResultColumn[]
  /** Novi retci (nadovezuju se na prethodno poslane); prazno kad je set već na maxRows. */
  rows: CellValue[][]
  totalRows: number
  truncated: boolean
  hasMore?: boolean
}

/** Dojava napretka dok se upit izvršava (rezultat stiže u dijelovima). */
export interface QueryProgress {
  sets: ResultSetDelta[]
}

export interface ExecuteOptions {
  /** Maksimalan broj redaka koji se šalje u UI po result setu. */
  maxRows?: number
  /** Spremljeni query koji tab izvršava — izvršavanje se veže na njega. */
  savedQueryId?: number
  /** Aktivni projekt u trenutku izvršavanja. */
  projectId?: number
  /** SQL s varijablama (:x, ${x}) prije zamjene — on ide u povijest i fingerprint. */
  template?: string
  /** Vrijednosti varijabli, spremaju se uz izvršavanje. */
  params?: Record<string, ParamValue>
  /** false: prije upita se otvara transakcija ako već nije otvorena (Commit/Rollback ručno). Zadano true. */
  autoCommit?: boolean
}

/** Stanje transakcije na sesiji taba; 'failed' = transakcija u grešci, moguć je samo rollback. */
export type TxState = 'none' | 'open' | 'failed' | 'unknown'
export type TxAction = 'begin' | 'commit' | 'rollback'

/** Čvor plana izvršavanja (zajednički oblik za sve tri baze). */
export interface PlanNode {
  label: string
  detail?: string
  /** Procijenjeni trošak (kumulativan, s djecom), u jedinicama baze. */
  cost?: number
  /** Procijenjeni broj redaka. */
  rows?: number
  /** Stvarni broj redaka (samo ANALYZE). */
  actualRows?: number
  /** Stvarno vrijeme u ms, s djecom (samo ANALYZE). */
  timeMs?: number
  children: PlanNode[]
}

export interface QueryPlan {
  root: PlanNode
  /** Izvorni plan (JSON ili XML) za kopiranje. */
  raw: string
  /** Upit je stvarno izvršen (ANALYZE) pa postoje stvarni redci i vremena. */
  analyzed: boolean
  totalMs?: number
}

/** Što je povijest zapisala o izvršavanju (vraća se uz rezultat). */
export interface RunInfo {
  runId: number
  /** Hash normaliziranog SQL-a (literali kao ?, bez komentara i razmaka). */
  fingerprint: string
  /** Izvršavanja istog fingerprinta u zadnjih 7 dana, uključujući ovo. */
  recentRuns: number
  /** Ponudi spremanje: često se pokreće, nije spremljen i korisnik ga nije odbio. */
  suggestSave: boolean
  /** Izvršavanje bitno drukčije od dosadašnjih istog upita na istoj bazi. */
  anomaly?: RunAnomaly
}

/** slow: > 5× medijana trajanja (i > 1 s); empty: 0 redaka, a medijan dosadašnjih je > 0. */
export interface RunAnomaly {
  kind: 'slow' | 'empty'
  /** Koliko je prethodnih uspješnih izvršavanja uspoređeno (3–20). */
  samples: number
  medianMs: number
  medianRows: number
}

export interface SessionInfo {
  sessionId: string
  connectionId: string
  database?: string
}

/** Jedna izmjena retka iz grida. */
export interface RowEdit {
  kind: 'update' | 'insert' | 'delete'
  /** update/delete: vrijednosti primarnog ključa (izvorne, prije izmjene). */
  key?: Record<string, CellValue>
  /** update: samo promijenjene kolone; insert: popunjene kolone. */
  values?: Record<string, CellValue>
}

/** Parametrizirana naredba za izmjenu podataka. */
export interface EditStatement {
  sql: string
  params: CellValue[]
  /** UPDATE/DELETE/INSERT moraju obuhvatiti točno jedan redak, inače rollback. */
  expectOneRow: boolean
}

/** Tablica koju tab prikazuje (za uređivanje podataka). */
export interface EditTable {
  database: string
  schema?: string
  table: string
}

/** Jedan izvršeni upit u povijesti. */
export interface HistoryEntry {
  id: string
  /** Vrijeme izvršavanja, ISO 8601. */
  ts: string
  connectionId: string
  /** Naziv konekcije u trenutku izvršavanja (konekcija se kasnije može obrisati ili preimenovati). */
  connectionName: string
  database?: string
  sql: string
  durationMs: number
  /** Ukupno vraćenih redaka u svim result setovima. */
  rows: number
  error?: string
  cancelled?: boolean
  /** Vrijednosti varijabli (sql je tada predložak s :x / ${x}). */
  params?: Record<string, ParamValue>
  /** Koliko je ukupno izvršavanja s istim fingerprintom u povijesti. */
  repeats?: number
  savedQueryId?: number
}

export interface HistoryQuery {
  /** Podniz SQL teksta, bez obzira na velika/mala slova. */
  search?: string
  connectionId?: string
  /** Aktivni projekt: samo izvršavanja na ovim konekcijama/bazama. */
  scope?: DbRef[]
  limit?: number
}

/** Kako se vrijednost varijable upisuje u SQL; auto = broj ako se da pročitati kao broj, inače tekst. */
export type ParamType = 'auto' | 'text' | 'number' | 'null' | 'raw'

export interface ParamValue {
  value: string
  type: ParamType
}

/** Baza na konekciji — jedinica članstva u projektu. */
export interface DbRef {
  connectionId: string
  database: string
}

/** Gdje alias pokazuje u jednom okruženju. */
export interface AliasTarget extends DbRef {
  env: Environment
}

/** Alias baze unutar projekta (npr. core-db) → konekcija/baza po okruženju. */
export interface ProjectAlias {
  id: number
  name: string
  targets: AliasTarget[]
}

export interface Project {
  id: number
  name: string
  description: string
  color?: string
  archived: boolean
  databases: DbRef[]
  queryCount: number
  /** Okruženje u kojem se otvaraju novi alias tabovi. */
  defaultEnv: Environment
  aliases: ProjectAlias[]
}

export interface ProjectInput {
  /** Bez id-a = novi projekt. */
  id?: number
  name: string
  description?: string
  color?: string
  archived?: boolean
  /** Ako je zadano, zamjenjuje popis baza projekta. */
  databases?: DbRef[]
  defaultEnv?: Environment
  /** Ako je zadano, zamjenjuje aliase (postojeći zadržavaju id, pa spremljeni queryji ostaju vezani). */
  aliases?: { id?: number; name: string; targets: AliasTarget[] }[]
}

export interface SavedQuery {
  id: number
  title: string
  /** Markdown. */
  description: string
  sql: string
  connectionId?: string
  database?: string
  pinned: boolean
  /** ISO 8601. */
  createdAt: string
  updatedAt: string
  projectIds: number[]
  /** Izvršavanja iz taba ovog queryja. */
  runCount: number
  lastRunAt?: string
  /** Alias projekta na koji je query vezan (umjesto fiksne konekcije). */
  aliasId?: number
  /** Tablice koje SQL koristi (shema.tablica ili tablica), malim slovima. */
  tables: string[]
  /** select, insert, update, delete, merge, ddl, exec */
  statementTypes: string[]
  /** Mapa (kolekcija); '' = bez mape. Podmape kao "Izvještaji/Mjesečni". */
  folder: string
  versionCount: number
  /** Zadnja provjera sheme: tablice koje nisu pronađene na toj bazi (prazno = sve postoje). */
  schemaCheck?: SchemaCheck
}

export interface SchemaCheck {
  connectionId: string
  database: string
  missing: string[]
  /** ISO 8601. */
  at: string
}

export interface QueryVersion {
  id: number
  /** Redni broj (1 = prva). */
  number: number
  sql: string
  createdAt: string
  runCount: number
}

/** Izvršavanje spremljenog queryja (za trend). */
export interface SavedRun {
  id: number
  startedAt: string
  durationMs: number
  rows: number
  status: 'success' | 'error' | 'cancelled'
  versionNumber?: number
}

export interface Snippet {
  id: number
  /** null = u svim projektima. */
  projectId: number | null
  name: string
  body: string
  updatedAt: string
}

export interface SnippetInput {
  id?: number
  projectId: number | null
  name: string
  body: string
}

export interface SavedQueryInput {
  /** Bez id-a = novi query. */
  id?: number
  title: string
  description?: string
  sql: string
  connectionId?: string
  database?: string
  pinned?: boolean
  projectIds: number[]
  aliasId?: number
  /** Bez vrijednosti = zadrži postojeću mapu. */
  folder?: string
}

export interface SavedQueryFilter {
  /** Samo queryji ovog projekta. */
  projectId?: number
  /** Tekst i filteri: project:AML table:alerts type:select db:core ran:<7d ran:>30d is:pinned */
  search?: string
}

// ---------- Poslovi prijenosa podataka (#data-jobs) ----------

/** insert = dodaj retke, upsert = dodaj ili ažuriraj po ključu, replace = obriši sve retke pa dodaj. */
export type JobWriteMode = 'insert' | 'upsert' | 'replace'
export type JobFileFormat = 'csv' | 'json' | 'xlsx'

/** Spremljeni query projekta (s varijablama i okruženjem aliasa) ili cijela tablica. */
export type JobSource =
  | { kind: 'query'; savedQueryId: number; env?: Environment; params?: Record<string, ParamValue> }
  | { kind: 'table'; connectionId: string; database: string; schema?: string; table: string }

export interface JobDatabaseTarget {
  kind: 'database'
  connectionId: string
  database: string
  schema?: string
  table: string
  mode: JobWriteMode
  /** Stupci po kojima upsert prepoznaje postojeći redak. */
  keyColumns: string[]
  /** Kreiraj tablicu ako ne postoji (tipovi prema izvoru). */
  createTable: boolean
  /** all = jedna transakcija (greška ne ostavlja ništa), batch = commit nakon svakog paketa. */
  transaction: 'all' | 'batch'
}

export interface JobFileTarget {
  kind: 'file'
  format: JobFileFormat
  /** Mapa koju je korisnik odabrao u dijalogu. */
  folder: string
  /** Naziv datoteke; {date}, {time} i {job} se zamjenjuju pri izvođenju. */
  fileName: string
  ifExists: 'overwrite' | 'new'
  /** CSV: razdjelnik (zadano ';'). */
  delimiter?: ';' | ',' | '\t'
}

export type JobDestination = JobDatabaseTarget | JobFileTarget

/** Stupac odredišta: iz stupca izvora ili konstanta. */
export interface JobColumn {
  target: string
  /** Naziv stupca izvora; bez vrijednosti = konstanta. */
  source?: string
  constant?: string
}

export interface DataJobConfig {
  source: JobSource
  /** Prazno = svi stupci izvora pod istim nazivima. */
  columns: JobColumn[]
  destination: JobDestination
  /** Redaka po paketu (upis u bazu i dojave napretka). */
  batchSize: number
}

export type JobRunStatus = 'running' | 'success' | 'error' | 'cancelled'

export interface JobRun {
  id: number
  jobId: number
  /** ISO 8601. */
  startedAt: string
  finishedAt?: string
  status: JobRunStatus
  trigger: 'manual' | 'schedule'
  rowsRead: number
  rowsWritten: number
  /** Kamo je upisano (konekcija/baza/tablica ili putanja datoteke). */
  target: string
  error?: string
  /** Redak na kojem je upis pao (JSON objekt stupaca odredišta) i njegov redni broj. */
  failedRow?: string
  failedRowNumber?: number
}

export interface DataJob {
  id: number
  projectId: number
  name: string
  config: DataJobConfig
  createdAt: string
  updatedAt: string
  lastRun?: JobRun
}

export interface DataJobInput {
  /** Bez id-a = novi posao. */
  id?: number
  projectId: number
  name: string
  config: DataJobConfig
}

export interface JobProgress {
  jobId: number
  rowsRead: number
  rowsWritten: number
}

/** API koji UI vidi (preload ga izlaže kao window.api). Web verzija će ga implementirati preko fetch-a. */
export interface StudioApi {
  app: {
    /** Jezik poruka iz main procesa i corea (greške, dijalozi za datoteke). */
    setLanguage(lang: 'en' | 'hr'): Promise<void>
    /** Zatvara prozor (uz uobičajena pitanja o transakcijama) i ponovno pokreće aplikaciju. */
    relaunch(): Promise<void>
    /** Korisnik je odustao od zatvaranja: aplikacija se pri idućem izlasku ne pokreće ponovno. */
    cancelRelaunch(): Promise<void>
  }
  connections: {
    list(): Promise<ConnectionInfo[]>
    get(id: string): Promise<ConnectionInfo | null>
    save(config: ConnectionConfig): Promise<ConnectionInfo>
    remove(id: string): Promise<void>
    test(config: ConnectionConfig): Promise<{ ok: boolean; message: string; version?: string }>
    /** 'plaintext' = lozinke se spremaju samo prikriveno (Linux bez keyringa), inače 'secure'. */
    passwordStorage(): Promise<'secure' | 'plaintext'>
  }
  explorer: {
    connect(connectionId: string): Promise<{ version: string }>
    disconnect(connectionId: string): Promise<void>
    databases(connectionId: string): Promise<string[]>
    databaseSizes(connectionId: string): Promise<Record<string, number>>
    objects(connectionId: string, database: string): Promise<DbObject[]>
    children(connectionId: string, database: string, obj: DbObject): Promise<ChildInfo[]>
    definition(connectionId: string, database: string, obj: DbObject): Promise<string>
    /** Tablice s kolonama i strani ključevi baze (ER dijagram). */
    schemaGraph(connectionId: string, database: string): Promise<SchemaGraph>
    /** Indeksi i strani ključevi (u oba smjera) jedne tablice. */
    tableDetails(connectionId: string, database: string, obj: DbObject): Promise<TableDetails>
  }
  edits: {
    /** Naredbe koje bi se izvršile — za pregled prije spremanja. */
    preview(connectionId: string, target: EditTable, edits: RowEdit[]): Promise<string[]>
    /** Izvršava sve izmjene u jednoj transakciji; vraća broj obuhvaćenih redaka. */
    apply(connectionId: string, target: EditTable, edits: RowEdit[]): Promise<number>
  }
  query: {
    openSession(connectionId: string, database?: string): Promise<SessionInfo>
    execute(sessionId: string, sql: string, options?: ExecuteOptions): Promise<QueryResult>
    /** Nastavlja pauzirani upit; vraća cijeli rezultat do sada (opet pending ako je ponovno pauziran). */
    fetchMore(sessionId: string, mode: FetchMode): Promise<QueryResult>
    /** Dojave napretka za sesiju dok traje execute ili fetchMore; vraća funkciju za odjavu. */
    onProgress(sessionId: string, listener: (progress: QueryProgress) => void): () => void
    cancel(sessionId: string): Promise<void>
    closeSession(sessionId: string): Promise<void>
    currentDatabase(sessionId: string): Promise<string | undefined>
    /** Ručna transakcija na sesiji taba; vraća stanje nakon akcije. */
    transaction(sessionId: string, action: TxAction): Promise<TxState>
    /** Plan izvršavanja jedne naredbe; analyze = stvarno izvrši (samo SELECT). */
    explain(sessionId: string, sql: string, analyze: boolean): Promise<QueryPlan>
  }
  history: {
    list(query?: HistoryQuery): Promise<HistoryEntry[]>
    remove(id: string): Promise<void>
    clear(): Promise<void>
    /** "Ne pitaj više" za prijedlog spremanja ovog fingerprinta. */
    ignoreSuggestion(fingerprint: string): Promise<void>
  }
  projects: {
    list(): Promise<Project[]>
    save(p: ProjectInput): Promise<Project>
    remove(id: number): Promise<void>
    /** Projekti kojima baza pripada (zamjenjuje dosadašnje članstvo te baze). */
    setDatabaseProjects(ref: DbRef, projectIds: number[]): Promise<void>
    setDefaultEnv(id: number, env: Environment): Promise<void>
  }
  params: {
    /** Zadnje vrijednosti varijabli u projektu (null = bez projekta). */
    get(projectId: number | null, names: string[]): Promise<Record<string, ParamValue>>
    save(projectId: number | null, values: Record<string, ParamValue>): Promise<void>
  }
  saved: {
    list(filter?: SavedQueryFilter): Promise<SavedQuery[]>
    get(id: number): Promise<SavedQuery | null>
    save(q: SavedQueryInput): Promise<SavedQuery>
    remove(id: number): Promise<void>
    setPinned(id: number, pinned: boolean): Promise<void>
    versions(id: number): Promise<QueryVersion[]>
    runs(id: number, limit?: number): Promise<SavedRun[]>
    /** Vraća SQL verzije kao novu (najnoviju) verziju. */
    restoreVersion(id: number, versionId: number): Promise<SavedQuery>
    folders(): Promise<string[]>
  }
  snippets: {
    /** Snippeti projekta i globalni (projectId null = samo globalni). */
    list(projectId: number | null): Promise<Snippet[]>
    save(s: SnippetInput): Promise<Snippet>
    remove(id: number): Promise<void>
  }
  jobs: {
    list(projectId: number): Promise<DataJob[]>
    get(id: number): Promise<DataJob | null>
    save(job: DataJobInput): Promise<DataJob>
    remove(id: number): Promise<void>
    /** Pokreće posao i čeka kraj; napredak stiže kroz onProgress. Vraća zapis izvođenja (i kad padne). */
    run(id: number): Promise<JobRun>
    cancel(id: number): Promise<void>
    onProgress(listener: (p: JobProgress) => void): () => void
    runs(id: number, limit?: number): Promise<JobRun[]>
    /** Stupci izvora (izvodi upit samo do zaglavlja rezultata). */
    sourceColumns(source: JobSource): Promise<ResultColumn[]>
    /** Dijalog za mapu odredišne datoteke; null ako je odustao. */
    chooseFolder(): Promise<string | null>
  }
  files: {
    /** Dijalog Otvori (više datoteka); prazno ako je odustao. */
    open(): Promise<TextFile[]>
    /** Čitanje datoteke povučene u prozor (putanju određuje preload iz File objekta). */
    readDropped(file: File): Promise<TextFile>
    /** Spremanje u postojeću datoteku (samo onu koju je korisnik otvorio ili odabrao); vraća stvarno kodiranje (Windows-1250 može prijeći u UTF-8). */
    save(path: string, text: string, encoding: TextEncodingName): Promise<TextEncodingName>
    /** Dijalog Spremi kao; null ako je odustao. */
    saveAs(suggestedName: string, text: string, encoding?: TextEncodingName): Promise<TextFile | null>
  }
}

/** Kodiranje .sql datoteke; sprema se u istom u kojem je otvorena. */
export type TextEncodingName = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'windows-1250'

export interface TextFile {
  path: string
  /** Naziv datoteke (bez mape). */
  name: string
  text: string
  encoding: TextEncodingName
}
