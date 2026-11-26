// Monaco se učitava lokalno (bez CDN-a) kako bi aplikacija radila offline.
// Uvozimo samo jezgru editora + SQL dijalekte, bez TypeScript/HTML/CSS jezičnih servisa.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/languages/definitions/mysql/register'
import 'monaco-editor/languages/definitions/pgsql/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

monaco.editor.defineTheme('studio-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '569CD6', fontStyle: 'bold' },
    { token: 'operator.sql', foreground: 'D4D4D4' },
    { token: 'string', foreground: 'CE9178' },
    { token: 'number', foreground: 'B5CEA8' },
    { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'predefined', foreground: 'DCDCAA' }
  ],
  colors: {
    'editor.background': '#1e1f22',
    'editorLineNumber.foreground': '#4b4f57',
    'editorLineNumber.activeForeground': '#a0a4ab',
    'editor.lineHighlightBackground': '#26282e',
    'editorGutter.background': '#1e1f22'
  }
})

loader.config({ monaco })

export { monaco }
