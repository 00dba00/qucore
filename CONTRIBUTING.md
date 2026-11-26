# Contributing to QuCore

Thanks for helping. Bug reports, translations and pull requests are welcome.

## Reporting a bug

Open an issue with the QuCore version, your OS, the database (SQL Server / PostgreSQL / MariaDB and version), what you did and what happened. A screenshot helps. Never paste real passwords or production data.

## Development

```bash
npm install
npm run dev            # Electron app with hot reload
npm run typecheck
npm run test:unit      # no databases needed
npm run db:up          # PostgreSQL, MariaDB and SQL Server in Docker
npm run test:db        # core tests on all three
```

- `src/core` talks to the databases and must stay free of Electron imports.
- Every UI string goes through `t()` from `src/shared/i18n.ts`. Add the key to `src/shared/locales/en.ts` (the source) and `hr.ts`; `npm run typecheck` fails if a translation is missing.
- A user-visible feature also updates both user guides (`docs/guide/README.en.md` and `README.md`) and, for new screens, `scripts/guide-shots.mjs`.
- Keep pull requests focused; describe what the user will notice.

## Translations

To add a language, copy `src/shared/locales/en.ts` to a new file typed as `Messages`, translate the values, and add the language to `LANGUAGES` in `src/shared/i18n.ts` and to the catalogs there. Plural forms go through `plural()`.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
