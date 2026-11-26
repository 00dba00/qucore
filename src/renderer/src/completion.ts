import { monaco } from './monaco'
import { api } from './api'
import type { ColumnInfo, DbObject } from '../../shared/types'
import { KEYWORD_LIST } from './dialect'

/**
 * Keš metapodataka za autocomplete: objekti po (konekcija, baza) i kolone po tablici.
 * Puni se lijeno — kad editor zatraži prijedloge ili kad explorer učita objekte.
 */
const objectsCache = new Map<string, Promise<DbObject[]>>()
const columnsCache = new Map<string, Promise<ColumnInfo[]>>()
const modelContext = new Map<string, { connectionId: string; database?: string }>()

const key = (c: string, d?: string) => `${c}\u0000${d ?? ''}`

export function primeObjects(connectionId: string, database: string, objects: DbObject[]): void {
  objectsCache.set(key(connectionId, database), Promise.resolve(objects))
}

export function invalidateObjects(connectionId: string, database?: string): void {
  for (const k of [...objectsCache.keys(), ...columnsCache.keys()]) {
    if (k.startsWith(database === undefined ? connectionId + '\u0000' : key(connectionId, database))) {
      objectsCache.delete(k)
      columnsCache.delete(k)
    }
  }
}

function objectsFor(connectionId: string, database: string): Promise<DbObject[]> {
  const k = key(connectionId, database)
  let p = objectsCache.get(k)
  if (!p) {
    p = api.explorer.objects(connectionId, database).catch(() => [])
    objectsCache.set(k, p)
  }
  return p
}

function columnsFor(connectionId: string, database: string, obj: DbObject): Promise<ColumnInfo[]> {
  const k = key(connectionId, database) + '\u0000' + (obj.schema ?? '') + '.' + obj.name
  let p = columnsCache.get(k)
  if (!p) {
    p = api.explorer
      .children(connectionId, database, obj)
      .then((c) => c.filter((x) => x.type === 'column') as ColumnInfo[])
      .catch(() => [])
    columnsCache.set(k, p)
  }
  return p
}

export function setModelContext(model: monaco.editor.ITextModel, connectionId?: string, database?: string): void {
  if (connectionId) modelContext.set(model.uri.toString(), { connectionId, database })
  else modelContext.delete(model.uri.toString())
}

const KIND_ICON: Record<DbObject['kind'], monaco.languages.CompletionItemKind> = {
  table: monaco.languages.CompletionItemKind.Struct,
  view: monaco.languages.CompletionItemKind.Interface,
  procedure: monaco.languages.CompletionItemKind.Method,
  function: monaco.languages.CompletionItemKind.Function,
  trigger: monaco.languages.CompletionItemKind.Event
}

/** Pronalazi alias → tablica iz FROM/JOIN dijelova upita (npr. "FROM sales.orders o"). */
function aliasMap(text: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /\b(?:from|join|update|into)\s+((?:[\w$"`\[\]]+\.)?[\w$"`\[\]]+)(?:\s+(?:as\s+)?([\w$]+))?/gi
  let m: RegExpExecArray | null
  const stop = new Set(['where', 'on', 'join', 'inner', 'left', 'right', 'full', 'cross', 'group', 'order', 'limit', 'set', 'values', 'select'])
  while ((m = re.exec(text))) {
    const table = m[1].replace(/["`\[\]]/g, '')
    const short = table.split('.').pop()!
    map.set(short.toLowerCase(), table)
    if (m[2] && !stop.has(m[2].toLowerCase())) map.set(m[2].toLowerCase(), table)
  }
  return map
}

function findObject(objs: DbObject[], ref: string): DbObject | undefined {
  const parts = ref.toLowerCase().split('.')
  const name = parts.pop()!
  const schema = parts.pop()
  return objs.find(
    (o) => (o.kind === 'table' || o.kind === 'view') && o.name.toLowerCase() === name && (!schema || o.schema?.toLowerCase() === schema)
  )
}

for (const lang of ['sql', 'pgsql', 'mysql']) {
  monaco.languages.registerCompletionItemProvider(lang, {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      const ctx = modelContext.get(model.uri.toString())
      const suggestions: monaco.languages.CompletionItem[] = []

      const linePrefix = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1)
      const dotted = /([\w$"`\[\]]+)\.$/.exec(linePrefix)

      if (ctx?.database) {
        const objs = await objectsFor(ctx.connectionId, ctx.database)
        if (dotted) {
          // "alias." ili "tablica." → kolone; "shema." → objekti u shemi
          const ref = dotted[1].replace(/["`\[\]]/g, '')
          const table = aliasMap(model.getValue()).get(ref.toLowerCase()) ?? ref
          const obj = findObject(objs, table)
          if (obj) {
            for (const c of await columnsFor(ctx.connectionId, ctx.database, obj)) {
              suggestions.push({
                label: { label: c.name, description: c.dataType },
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: c.name,
                sortText: '0',
                range
              })
            }
          }
          for (const o of objs.filter((o) => o.schema?.toLowerCase() === ref.toLowerCase())) {
            suggestions.push({ label: { label: o.name, description: o.kind }, kind: KIND_ICON[o.kind], insertText: o.name, range })
          }
          return { suggestions }
        }
        for (const o of objs) {
          if (o.kind === 'trigger') continue
          suggestions.push({
            label: { label: o.name, description: o.schema ? `${o.schema} · ${o.kind}` : o.kind },
            kind: KIND_ICON[o.kind],
            insertText: o.name,
            sortText: o.kind === 'table' ? '1' : '2',
            range
          })
        }
      }
      for (const kw of KEYWORD_LIST) {
        suggestions.push({ label: kw, kind: monaco.languages.CompletionItemKind.Keyword, insertText: kw, sortText: '3', range })
      }
      return { suggestions }
    }
  })
}
