# QuCore

**The Power Behind Every Query.**

Ranije SQL Studio. Od v0.17 profil je u `%APPDATA%\QuCore`; stara mapa `SQL Studio` se pri prvom pokretanju preimenuje (konekcije, ključevi i povijest ostaju). Instalacijski `appId` ostaje isti radi nadogradnje.

Desktop SQL editor za **SQL Server, PostgreSQL i MariaDB/MySQL**, zamišljen kao lakša alternativa Aqua Data Studiju.
Sučelje je na **engleskom** i **hrvatskom** (Postavke → Jezik). [English version of this document](README.md).
Electron + React + TypeScript; sloj za rad s bazama (`src/core`) nema Electron ovisnosti, pa ga web verzija koristi bez izmjena.

## Pokretanje (Windows)

Potrebno: [Node.js 22+](https://nodejs.org).

```bash
npm install
npm run dev          # razvoj s hot-reloadom
npm run build:win    # installer u dist/ (QuCore Setup x.y.z.exe)
npm run build:mac    # macOS .dmg i .zip (na Macu)
npm run build:linux  # Linux AppImage i .tar.gz (na Linuxu)
```

**Korisnički vodič s primjerima i slikama: [docs/guide/README.md](docs/guide/README.md)** ([engleski](docs/guide/README.en.md)) — isti vodič je i u aplikaciji (F1), na jeziku sučelja. Pri buildu ga `scripts/vite-guide-plugin.ts` pretvara u HTML (modul `virtual:guide`), a slike idu u bundle.

## Što radi

- **Konekcije**: SQL Server, PostgreSQL, MariaDB/MySQL; test konekcije; boja konekcije (npr. crvena = produkcija).
  SQL Server prijava: SQL Server login, Windows kao trenutni korisnik (`msnodesqlv8` + ODBC driver za SQL Server,
  bira se najnoviji instalirani: ODBC Driver 18 → 17 → Native Client 11 → stari `SQL Server`) ili Windows domena\korisnik + lozinka (NTLM).
  Lozinke se spremaju kriptirano (Windows DPAPI preko Electron `safeStorage`) u `%APPDATA%\QuCore\connections.json`.
- **Object explorer**: baze → tablice, viewovi, procedure, funkcije, triggeri → kolone (PK, tip, null, identity) i parametri.
  Lijeno učitavanje, filter, desni klik: *SELECT prvih 100*, *Broj redaka*, *Skripta (CREATE)*, *Ubaci u editor*.
  Veličina svake baze i tablice prikazuje se uz naziv.
- **SQL editor** (Monaco, kao u VS Codeu): više tabova, sintaksa po dijalektu, autocomplete tablica i kolona
  (razumije aliase: `FROM orders o` → `o.` nudi kolone), izvršavanje cijele skripte ili označenog dijela.
  Formatiranje SQL-a po dijalektu (gumb *Formatiraj* ili Shift+Alt+F; samo označeni dio ako postoji),
  `GO` i `DELIMITER` linije ostaju gdje jesu.
- **Izvršavanje**: više result setova, poruke (PRINT / RAISE NOTICE / SHOW WARNINGS), broj obuhvaćenih redaka,
  prekid upita (Esc), `GO` separatori za SQL Server, `DELIMITER` za MariaDB, svaki tab ima vlastitu sesiju
  (temp tablice i transakcije ostaju između izvršavanja).
- **ER dijagram**: desni klik na bazu → *ER dijagram*. Tablice s kolonama (PK, FK) i veze iz stranih ključeva,
  automatski raspored (ELK; povezane tablice gore, nepovezane u mreži ispod), filter sheme, pretraga tablica i kolona
  (Enter skoči na prvu), klik na tablicu ističe njezine veze, izvoz cijelog dijagrama u SVG i PNG.
- **Streaming rezultata**: retci se čitaju kao tok i prikazuju dok upit još traje. Na *Max redaka* čitanje se
  pauzira (upit ostaje otvoren na serveru): *Učitaj još* donosi sljedeću stranicu, *Prebroji ostatak* pročita
  ostatak i samo ga broji, *Zatvori* prekida upit. *Prekini* zadržava već primljene retke.
- **Projekti i spremljeni queryji** (Smart Query Manager, faza 1): projekt (npr. *AML*) grupira baze
  (konekcija + baza; desni klik na bazu → *Projekti…*) i spremljene queryje; ista baza i isti query mogu biti
  u više projekata. Aktivni projekt (izbor na vrhu sidebara, Ctrl+Shift+P) filtrira Konekcije, Spremljeno i Povijest.
  Ctrl+S sprema tab kao query (naslov, markdown opis, projekti; predlaže projekt baze ili aktivni projekt),
  idući Ctrl+S ga ažurira, Ctrl+Shift+S sprema kao novi. Ctrl+P traži spremljene queryje i projekte.
  Sprema se u `%APPDATA%\QuCore\qucore.db` (SQLite ugrađen u Electron, `node:sqlite`).
  Pretraga spremljenih (FTS5 trigram: dio riječi, bez obzira na dijakritike, i ticketi poput `AML-123` iz opisa)
  s filterima `project:AML`, `table:alerts` (ili `shema.tablica`), `type:select|insert|update|delete|merge|ddl|exec`,
  `db:core`, `ran:<7d`, `ran:>30d`, `is:pinned` (gumb ? uz polje). Tablice i vrste naredbi izvlače se iz SQL-a
  pri spremanju (vlastita heuristika nad tokenima: podupiti, CTE-ovi, tablične funkcije i `EXTRACT(… FROM …)` se preskaču).
- **Okruženja i aliasi**: konekcija se označi kao *dev / test / prod* (prikazano u Exploreru). U projektu alias
  (npr. `core-db`) pokazuje na bazu po okruženju; query spremljen na alias otvara se u zadanom okruženju projekta
  (prekidač uz izbor projekta), a svaki tab ima svoj izbor okruženja, pa isti query može biti otvoren na testu i produ.
- **Varijable**: `:customer_id` ili `${date_from}` u SQL-u (ne u stringovima, komentarima, `::castu`, `:=` i `@varijablama`)
  prije izvršavanja otvaraju formu. Vrijednost ide u SQL kao literal s escapeom po dijalektu; tip *auto* (broj ili tekst),
  *tekst*, *broj*, *NULL* ili *SQL izraz*. Zadnje vrijednosti pamte se po projektu; povijest sprema predložak i vrijednosti,
  pa izvršavanje otvoreno iz povijesti nudi iste vrijednosti.
- **Zaštita**: tab na *prod* konekciji ima crveni okvir i oznaku PROD; INSERT/UPDATE/DELETE/MERGE/DDL/EXEC na produ traži
  potvrdu. `UPDATE`/`DELETE` bez `WHERE` i `TRUNCATE` (na bilo kojem okruženju) traže još i kvačicu *Razumijem da mijenja
  sve retke*. Spremljeni query pokrenut na drugoj bazi nego što je spremljen pita prije izvršavanja. Nakon izvršavanja tab
  upozori ako je upit 5× sporiji od medijana (i dulji od 1 s) ili vrati 0 redaka, a inače vraća retke (usporedba s
  prethodnim izvršavanjima istog upita na istoj bazi).
- **Verzije, mape, snippeti**: svako spremanje s promijenjenim SQL-om je nova verzija; *Verzije i izvršavanja…* (desni
  klik na spremljeni query) usporedi verziju s trenutnom (Monaco diff), vrati je (otvoreni tab dobiva vraćeni SQL) ili
  otvori u novom tabu, i pokaže trajanje i broj redaka zadnjih 30 izvršavanja. Kad Explorer učita objekte baze,
  spremljeni queryji te baze (i aliasa koji na nju pokazuju) koji koriste tablice kojih više nema dobiju upozorenje
  (filter `is:broken`; kolone se ne provjeravaju). Queryji mogu biti u mapama (`Izvještaji/Mjesečni`), Spremljeno ih
  grupira i pokazuje *Nedavno pokretano*. Gumb *Snippeti* ubacuje spremljene fragmente na kursor; označeni tekst
  sprema se kao snippet za projekt ili sve projekte.
- **Uređivanje podataka**: tablica otvorena iz Explorera (dvoklik / *SELECT prvih 100*) može se uređivati u gridu
  ako ima primarni ključ: dvoklik / F2 uređuje ćeliju, desni klik *Postavi NULL*, *Obriši redak*, *Dodaj novi redak*.
  *Spremi…* prikazuje točne naredbe prije izvršavanja; sve ide u jednoj transakciji s parametrima, svaka naredba mora
  obuhvatiti točno jedan redak, inače rollback. MariaDB izmjene idu u strogom `sql_mode` (bez tihog pretvaranja u 0 / '').
- **Povijest upita** (sidebar → *Povijest*): svako izvršavanje se bilježi (konekcija, baza, projekt, spremljeni query,
  vrijeme, trajanje, broj redaka, greška ili prekid) u `qucore.db`, zadnjih 20.000. Uz svaki upit ide *fingerprint*
  (SQL bez komentara i razmaka, literali kao `?`), pa `WHERE id = 5` i `where id=7` vrijede kao isti upit: povijest
  pokazuje ×N, a nakon 5 izvršavanja u 7 dana tab nudi *Spremiti ga?* (*Kasnije* / *Ne pitaj više*).
  Pretraga, filter na konekciju aktivnog taba, dvoklik otvara upit u novom tabu. Tekst upita sprema se nekriptiran.
  Stara `history.jsonl` (do v0.9) uveze se jednom i ostaje kao `history.jsonl.imported`.
- **Rezultati**: virtualizirana tablica (glatko i sa 100.000 redaka), sortiranje, promjena širine kolona,
  kopiranje ćelije/retka/svega, *Kopiraj kao IN (…)*, export u CSV (Excel-friendly, `;` separator, UTF-8 BOM).
- **Jezici**: engleski i hrvatski; poruke su u `src/shared/locales/en.ts` (izvor) i `hr.ts`, a typecheck javlja ključ koji nedostaje.
- **Sigurnost**: renderer čita i sprema samo datoteke koje je korisnik sam odabrao (`file-grants.json`), a zahtjevi za kameru,
  mikrofon, lokaciju i obavijesti se odbijaju.

## Prečaci

| Tipka | Akcija |
|---|---|
| F5 / Ctrl+Enter / Ctrl+E | Izvrši upit ili označeni dio |
| Esc | Prekini upit |
| F2 / dvoklik na ćeliju | Uredi ćeliju (tablica otvorena iz Explorera) |
| Shift+Alt+F | Formatiraj SQL (označeni dio ili cijeli upit) |
| Ctrl+T / Ctrl+W | Novi / zatvori tab |
| Ctrl+Tab | Sljedeći tab |
| Ctrl+S / Ctrl+Shift+S | Spremi query / spremi kao novi |
| Ctrl+P | Spremljeni queryji i projekti |
| Ctrl+Shift+P | Promjena aktivnog projekta |
| Ctrl+Space | Prijedlozi |
| Dvoklik na tablicu | Prvih 100 redaka |
| Dvoklik na kolonu | Ubaci naziv u editor |

## Struktura

```
src/
  shared/types.ts        tipovi + StudioApi sučelje (UI ↔ backend ugovor)
  core/                  rad s bazama — bez Electrona, dijeli se s web verzijom
    manager.ts           ConnectionManager: metadata konekcije + sesije po tabu
    drivers/mssql.ts     SQL Server (mssql/tedious; Windows prijava preko mssql/msnodesqlv8)
    drivers/postgres.ts  PostgreSQL (pg)
    drivers/mariadb.ts   MariaDB/MySQL (mysql2)
    util.ts              normalizacija vrijednosti, GO splitter
  main/                  Electron main proces: IPC + kriptirano spremanje konekcija
    workspaceStore.ts    projekti i spremljeni queryji (qucore.db, migracije preko PRAGMA user_version)
  preload/               izlaže window.api (StudioApi) UI-u
  renderer/              React UI
scripts/
  test-core.ts           integracijski testovi core sloja na pravim bazama
  e2e.mjs                end-to-end test cijele aplikacije (Playwright + Electron)
```

**Web verzija**: `StudioApi` u `src/shared/types.ts` je jedini ugovor između UI-a i backenda. Za web se piše
mali HTTP server (npr. Fastify) koji poziva isti `ConnectionManager`, a u `src/renderer/src/api.ts` se umjesto
`window.api` podmetne implementacija preko `fetch`. UI ostaje isti.

## Testovi

```bash
npm run test:unit   # bez baza: fingerprint, tablice iz SQL-a, sintaksa pretrage, projekti, spremljeni queryji, povijest
npm run db:up       # PostgreSQL, MariaDB i SQL Server u Dockeru (docker/compose.yml, portovi 15432/13306/11433)
npm run test:db     # ponovno napravi bazu shop (docker/seed) pa test:core na sve tri
npm run test:core   # samo testovi; druge baze preko PG_*/MARIA_*/MSSQL_* env varijabli, TEST_DBS=pg,maria bira neke
npm run test:e2e
npm run db:demo     # demo baza "demo" (izmišljena web trgovina) za snimke vodiča, vidi scripts/guide-shots.mjs
```

## Poznata ograničenja

- SQL Server Windows prijava (trenutni korisnik i NTLM) nije isprobana na pravom serveru; provjereno je učitavanje drivera u zapakiranoj aplikaciji i greška kad server ne postoji. Stari ugrađeni ODBC driver `SQL Server` ne zna *Vjeruj certifikatu servera*, pa uz enkripciju traži valjan certifikat.
- Uređivanje podataka: upis je isproban na MariaDB; za PostgreSQL i SQL Server samo typecheck i testovi generiranja SQL-a.
- Formatiranje: tijela T-SQL procedura s `BEGIN … END` ispadnu ispravna, ali ne lijepa (ograničenje biblioteke sql-formatter).
- Pauzirani upit drži konekciju (i eventualne lockove) dok se ne učita do kraja, zatvori ili pokrene novi upit u tabu.
- ER dijagram isproban na MariaDB (133 tablice, 86 veza); upiti za PostgreSQL i SQL Server katalog nisu isprobani.
- `test:core` (CI na svakom pushu) pokriva na sve tri baze: Explorer, više result setova, *Max redaka* / *Učitaj još* / prebrojavanje, privremene tablice, ručne transakcije, plan izvršavanja, indekse i strane ključeve, prekid upita.
- Raspored dijagrama s jednom središnjom tablicom (npr. `users` s desecima referenci) ispada visok; tablice se mogu pomicati mišem.
- *Zatvori* na MariaDB prekida upit s `KILL QUERY`; dok prekid ne stigne, server još šalje retke (odbacuju se).

## Plan

1. ~~Konekcije, explorer, editor, izvršavanje~~ ✔
2. ~~Windows autentikacija~~ ✔, ~~streaming rezultata~~ ✔, ~~povijest upita~~ ✔, ~~formatiranje SQL-a~~ ✔, ~~uređivanje podataka u tablici~~ ✔
3. ~~ER dijagram iz stranih ključeva (React Flow + ELK), export PNG/SVG~~ ✔
4. AI asistent (OpenAI / Anthropic / Gemini / Ollama ključ): SQL iz opisa, objašnjenje i optimizacija upita
5. Vizualni query builder → generator REST API projekta (Node/.NET + Dockerfile + Swagger)
6. Web verzija
7. Smart Query Manager: ~~projekti i spremljeni queryji~~ ✔, ~~povijest s fingerprintom~~ ✔,
   ~~FTS pretraga i reference tablica~~ ✔, ~~varijable i aliasi baza po okruženju~~ ✔, ~~prod zaštita i upozorenja~~ ✔,
   ~~verzije/kolekcije/snippeti~~ ✔, AI i export

## Licenca

[MIT](LICENSE)
