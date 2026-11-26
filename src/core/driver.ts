import type {
  ChildInfo,
  ConnectionConfig,
  DbObject,
  EditStatement,
  QueryResult,
  SchemaGraph,
  TableDetails,
  QueryPlan,
  TxAction,
  TxState
} from '../shared/types.ts'
import type { ResultCollector } from './util.ts'

/**
 * Driver za pregled metapodataka (object explorer).
 * Drži mali pool konekcija i ne čuva stanje sesije.
 */
export interface MetadataDriver {
  connect(): Promise<void>
  close(): Promise<void>
  serverVersion(): Promise<string>
  listDatabases(): Promise<string[]>
  /** Veličina baza u bajtovima (podaci + indeksi), po nazivu. Baze bez prava pristupa izostaju. */
  databaseSizes(): Promise<Record<string, number>>
  listObjects(database: string): Promise<DbObject[]>
  listChildren(database: string, obj: DbObject): Promise<ChildInfo[]>
  getDefinition(database: string, obj: DbObject): Promise<string>
  /** Tablice (bez pogleda) s kolonama i strani ključevi — nekoliko upita na katalog za cijelu bazu. */
  schemaGraph(database: string): Promise<SchemaGraph>
  /** Indeksi i strani ključevi (u oba smjera) jedne tablice. */
  tableDetails(database: string, obj: DbObject): Promise<TableDetails>
  /**
   * Izvršava naredbe u jednoj transakciji na zasebnoj konekciji. Ako neka s expectOneRow
   * ne obuhvati točno jedan redak, radi rollback i baca grešku. Vraća ukupno obuhvaćenih redaka.
   */
  applyEdits(database: string, statements: EditStatement[]): Promise<number>
}

/**
 * Sesija za editor: jedna fizička konekcija po tabu,
 * kako bi temp tablice, transakcije i SET opcije preživjele između izvršavanja.
 */
export interface QuerySession {
  open(): Promise<void>
  close(): Promise<void>
  /**
   * Retke čita kao tok u collector (koji odlučuje o limitu, pauzi i dojavama napretka).
   * Za vrijeme čitanja naredbe drži collector.setSource() s pause/resume trenutnog toka.
   * Rezultat koristi collector.sets i collector.messages.
   */
  execute(sql: string, collector: ResultCollector): Promise<QueryResult>
  cancel(): Promise<void>
  currentDatabase(): Promise<string | undefined>
  /** Je li na konekciji otvorena transakcija. Bez konekcije: 'none'. */
  transactionState(): Promise<TxState>
  /** BEGIN / COMMIT / ROLLBACK na konekciji sesije (bez upita u tijeku). */
  transaction(action: TxAction): Promise<void>
  /** Plan jedne naredbe na konekciji sesije; analyze je već provjeren (samo SELECT). */
  explain(sql: string, analyze: boolean): Promise<QueryPlan>
}

export interface DriverFactory {
  metadata(config: ConnectionConfig): MetadataDriver
  session(config: ConnectionConfig, database?: string): QuerySession
}
