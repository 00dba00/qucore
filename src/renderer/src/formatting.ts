import { monaco } from './monaco'
import { formatSql } from './format'
import { t } from './i18n'

let onError: (message: string) => void = (m) => console.error(m)

/** App postavlja handler kako bi se greška formatiranja prikazala kao toast. */
export function setFormatErrorHandler(fn: (message: string) => void): void {
  onError = fn
}

function edit(model: monaco.editor.ITextModel, range: monaco.IRange): monaco.languages.TextEdit[] {
  const text = model.getValueInRange(range)
  if (!text.trim()) return []
  try {
    const formatted = formatSql(text, model.getLanguageId())
    return formatted === text ? [] : [{ range, text: formatted }]
  } catch (err) {
    onError(t('format.failed') + ' ' + ((err as Error).message.split('\n')[0] ?? ''))
    return []
  }
}

// Shift+Alt+F (Format Document) i Ctrl+K Ctrl+F (Format Selection) dolaze iz Monaca;
// svaka promjena je jedan korak za Ctrl+Z.
for (const lang of ['sql', 'pgsql', 'mysql']) {
  monaco.languages.registerDocumentFormattingEditProvider(lang, {
    provideDocumentFormattingEdits: (model) => edit(model, model.getFullModelRange())
  })
  monaco.languages.registerDocumentRangeFormattingEditProvider(lang, {
    provideDocumentRangeFormattingEdits: (model, range) => edit(model, range)
  })
}

/** Toolbar: formatira označeni dio ili, ako ništa nije označeno, cijeli editor. */
export function formatEditor(editor: monaco.editor.IStandaloneCodeEditor): void {
  const sel = editor.getSelection()
  const action = sel && !sel.isEmpty() ? 'editor.action.formatSelection' : 'editor.action.formatDocument'
  editor.focus()
  void editor.getAction(action)?.run()
}
