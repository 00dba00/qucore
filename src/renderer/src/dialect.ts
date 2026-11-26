import type { DbObject, DbType } from '../../shared/types'
import { t } from './i18n'

export const MONACO_LANGUAGE: Record<DbType, string> = {
  mssql: 'sql',
  postgres: 'pgsql',
  mariadb: 'mysql'
}

const RESERVED = new Set(
  `select from where order group by having join inner outer left right full cross on and or not null is in exists between like
   table view index key primary foreign user users case when then else end as asc desc limit offset top distinct union all
   insert update delete into values set create alter drop column default check unique references grant revoke procedure
   function trigger database schema date time timestamp year month day level session current position value values`
    .split(/\s+/)
    .filter(Boolean)
)

/** Navodnici samo kad su potrebni — generirani SQL ostaje čitljiv. */
export function ident(type: DbType, name: string): string {
  const simple =
    type === 'postgres' ? /^[a-z_][a-z0-9_$]*$/.test(name) : /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)
  if (simple && !RESERVED.has(name.toLowerCase())) return name
  if (type === 'mssql') return '[' + name.replace(/]/g, ']]') + ']'
  if (type === 'postgres') return '"' + name.replace(/"/g, '""') + '"'
  return '`' + name.replace(/`/g, '``') + '`'
}

export function qualifiedName(type: DbType, obj: DbObject): string {
  return obj.schema ? `${ident(type, obj.schema)}.${ident(type, obj.name)}` : ident(type, obj.name)
}

export function selectTopSql(type: DbType, obj: DbObject, n = 100): string {
  const name = qualifiedName(type, obj)
  return type === 'mssql' ? `SELECT TOP ${n} *\nFROM ${name};` : `SELECT *\nFROM ${name}\nLIMIT ${n};`
}

export function countSql(type: DbType, obj: DbObject): string {
  return `SELECT COUNT(*) AS ${t('q.rowCountAlias')}\nFROM ${qualifiedName(type, obj)};`
}

/** Ključne riječi za autocomplete. */
export const KEYWORD_LIST = Array.from(
  new Set(
    `SELECT FROM WHERE AND OR NOT NULL IS IN EXISTS BETWEEN LIKE ILIKE ORDER GROUP BY HAVING LIMIT OFFSET TOP DISTINCT AS ON
     JOIN INNER LEFT RIGHT FULL OUTER CROSS UNION ALL EXCEPT INTERSECT INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER
     DROP TABLE VIEW INDEX PROCEDURE FUNCTION TRIGGER BEGIN END COMMIT ROLLBACK TRANSACTION CASE WHEN THEN ELSE COUNT SUM AVG
     MIN MAX COALESCE CAST CONVERT NULLIF ROW_NUMBER OVER PARTITION WITH RETURNING DECLARE EXEC EXECUTE ASC DESC PRIMARY KEY
     FOREIGN REFERENCES DEFAULT CONSTRAINT UNIQUE CHECK TRUNCATE`.split(/\s+/).filter(Boolean)
  )
)
