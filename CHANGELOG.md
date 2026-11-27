# Changelog

## v0.23.0 (2026-11-27)

- Jobs: send rows to a web service (REST API) per row or per batch, with a JSON body template, Bearer, Basic, API key or OAuth2 sign-ins stored encrypted, retries, and a test request with the first row

## v0.22.0 (2026-11-27)

- Jobs: move the result of a saved query or a whole table into a table in another database (add, add or update by key, replace all, table created if missing) or into a CSV, JSON or Excel file, with a run log that shows the row where writing failed
- Results: SQL Server dates and times are shown as stored instead of shifted by the time zone (also in exports and data editing)

## v0.21.1 (2026-11-26)

- Builds: macOS and Linux installers build without the Windows-only SQL Server driver

## v0.21.0 (2026-11-26)

- Platforms: QuCore builds for macOS (Intel and Apple Silicon) and Linux (AppImage, tar.gz), with a proper application menu on macOS
- Connections: on Linux without a keyring the connection dialog warns that the password can only be stored obfuscated
- Messages: PostgreSQL error positions follow the interface language

## v0.20.0 (2026-11-26)

- Guide: the user guide is now also in English, and F1 opens it in the interface language

## v0.19.0 (2026-11-26)

- Files: QuCore reads and saves only files you opened or chose yourself (a tab with a file opened in an older version saves once through Save to file as…)
- Security: the app refuses camera, microphone, location and notification requests
- Guide: screenshots now come from a fictional demo shop database

## v0.18.0 (2026-11-26)

- Settings: QuCore speaks English and Croatian, chosen in Settings (the app restarts to switch). A new profile follows the system language, an existing one stays Croatian
- Messages: errors, row counts, plan labels and generated SQL comments follow the chosen language

## v0.17.1 (2026-11-25)

- Transactions: on PostgreSQL a failed statement now shows 'Transakcija u grešci' and disables Commit right away
- SQL Server: #temp tables and SET options now stay in the tab's session between runs
- Plan: execution plans work on PostgreSQL

## v0.17.0 (2026-11-25)

- Profile: settings, connections and history now live in %APPDATA%\QuCore. The old SQL Studio folder is moved there on first start, passwords keep working
- License: QuCore is now MIT licensed

## v0.16.0 (2026-11-25)

- Editor: Ctrl+Enter runs only the statement at the cursor, F5 and Alt+X run the whole editor
- Editor: Ctrl+Enter, Ctrl+E and F1 act on the tab you are in (with several tabs open they went to the last opened one)
- Editor: open tabs and their unsaved text come back after a restart
- Results: quick search and per-column filters above the grid
- Editor: manual transactions with an Auto-commit switch, Commit and Rollback, and a question before anything would roll back silently
- Settings: safety and editor behaviours can be switched by the user, each with a note about the risk
- Results: Kopiraj copies column names and all displayed rows for Excel, and the cell menu has more copy options
- Results: copy as INSERT, JSON, Markdown or CSV and export to Excel, CSV or JSON, always from the displayed rows
- Files: open and save .sql files with Ctrl+O, drag and drop and Ctrl+S, keeping their encoding
- Results: full cell value panel with JSON and XML formatted and binary as hex, and a one-row vertical view
- Editor: execution plan with Ctrl+Shift+E, the most expensive step marked, and ANALYZE for SELECT
- Explorer: generate SELECT, INSERT, UPDATE and DELETE templates for a table
- Explorer: table tab with columns, data, indexes, foreign keys and DDL

## v0.15.0 (2026-11-24)

- Help: the user guide with screenshots is built into the app and opens with F1, the ? button next to the project picker or Vodič on the welcome screen, with a chapter list and search

## v0.14.0 (2026-11-24)

- Saved: every change of a saved query's SQL is kept as a version, with a side-by-side comparison, restore, and charts of duration and rows of recent runs
- Saved: queries that use tables which no longer exist are marked when the database is opened in the Explorer, and is:broken finds them
- Saved: queries can be put into folders, and recently run ones are listed on top
- Editor: snippets insert saved SQL fragments at the cursor, and any selection can be saved as a snippet

## v0.13.0 (2026-11-24)

- Editor: tabs on a prod connection are framed red and ask before INSERT, UPDATE, DELETE, MERGE, DDL or EXEC
- Editor: UPDATE or DELETE without WHERE and TRUNCATE need an extra confirmation on any connection
- Editor: a saved query run on another database than it was saved for asks first
- Editor: a warning appears when a query is much slower than usual or suddenly returns no rows

## v0.12.0 (2026-11-24)

- Connections: mark a connection as dev, test or prod
- Projects: aliases such as core-db point to a database per environment, and a query saved on an alias runs on the environment chosen in its tab
- Editor: variables like :customer_id or ${date_from} open a form before the run, values are remembered per project and kept in History

## v0.11.0 (2026-11-24)

- Saved: search finds parts of words regardless of diacritics, including ticket numbers in the description
- Saved: filters such as project:AML table:alerts type:delete db:core ran:<7d is:pinned, with a help list
- Saved: the tables a query uses and its statement type are shown in its tooltip

## v0.10.0 (2026-11-24)

- History: repeated runs of the same query are recognised even with other values, shown as xN, and after 5 runs in 7 days the tab offers to save the query
- Saved: each saved query shows how many times it ran and when it last ran
- History: existing history moves into the app database on first start

## v0.9.0 (2026-11-24)

- Projects: group databases and saved queries into projects (e.g. AML), and the active project filters Connections, Saved and History
- Editor: Ctrl+S saves the query with a title, description and projects, and Ctrl+P finds saved queries and projects

## v0.8.0 (2026-11-24)

- Connections: SQL Server can sign in with Windows, as the current Windows user or as domain\user with a password

## v0.7.0 (2026-11-24)

- Results: rows appear while the query is still running, and a running query can be stopped without losing the rows already received
- Results: after Max redaka the query pauses, with Učitaj još N to load the next page, Prebroji ostatak to count the rest, or Zatvori
- Explorer: ER diagram of a database from its foreign keys, with search, schema filter and export to PNG or SVG
- Brand: refreshed app icon and favicon

## v0.6.0 (2026-11-23)

- Brand: SQL Studio is now QuCore, with the slogan The Power Behind Every Query. on the welcome screen
- existing connections, saved passwords and history carry over
- Brand: new database-and-console logo on the welcome screen, favicon, window and installer icon

## v0.5.0 (2026-11-20)

- Editor: table data can be edited in the results grid, with a preview of the exact SQL and one transaction that rolls back unless every statement hits exactly one row
- Brand: new SQL Studio logo on the welcome screen, favicon, window and installer icon

## v0.4.0 (2026-11-20)

- Editor: Formatiraj button and Shift+Alt+F format the query or the selected part for the connection's SQL dialect
- UI: icons now come from the Vectilume set

## v0.3.0 (2026-11-20)

- History: every executed query is saved and can be searched and reopened from the new Povijest tab in the sidebar
- Explorer: database and table sizes use the Croatian number format and are no longer cut off next to long names

## v0.2.0 (2026-11-20)

- Explorer: shows the size of each database next to its name
- Explorer: shows the size of each table next to its name
- Connections: saved passwords use Electron's current encryption API and are re-encrypted automatically when the key changes

