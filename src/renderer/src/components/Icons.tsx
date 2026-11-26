import type { ComponentType } from 'react'
import {
  ChevronRight, Close, Code, Columns, Database, Download, Edit, Eye, Folder, Function as FunctionIcon, Image, Indent, Key,
  Link, Maximize, Minus, Network, PlaySolid, Plus, Refresh, Search, Server, StopSolid, Table, Zap, type IconProps
} from '@vectilume/react'

// Ikone iz Vectilume seta (16 px). `param` i `plug` još nemaju par u Vectilumeu (0.3.0) —
// ostaju ručno crtane dok ne budu objavljene.
const P = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export type IconName =
  | 'server' | 'database' | 'folder' | 'table' | 'view' | 'procedure' | 'function' | 'trigger'
  | 'column' | 'key' | 'param' | 'play' | 'stop' | 'plus' | 'close' | 'refresh' | 'chevron' | 'search' | 'edit' | 'plug' | 'format'
  | 'link' | 'diagram' | 'minus' | 'fit' | 'image' | 'download'

const VECTILUME: Record<Exclude<IconName, 'param' | 'plug'>, ComponentType<IconProps>> = {
  server: Server,
  database: Database,
  folder: Folder,
  table: Table,
  view: Eye,
  procedure: Code,
  function: FunctionIcon,
  trigger: Zap,
  column: Columns,
  key: Key,
  play: PlaySolid,
  stop: StopSolid,
  plus: Plus,
  close: Close,
  refresh: Refresh,
  chevron: ChevronRight,
  search: Search,
  edit: Edit,
  format: Indent,
  link: Link,
  diagram: Network,
  minus: Minus,
  fit: Maximize,
  image: Image,
  download: Download
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const cls = 'ui-icon ui-icon-' + name + (className ? ' ' + className : '')
  if (name === 'param') return <svg {...P} className={cls} stroke="currentColor"><path d="M5 3c-1.5 1.3-2 3-2 5s.5 3.7 2 5M11 3c1.5 1.3 2 3 2 5s-.5 3.7-2 5" /><circle cx="8" cy="8" r="1" fill="currentColor" /></svg>
  if (name === 'plug') return <svg {...P} className={cls} stroke="currentColor"><path d="M6 1.5v3M10 1.5v3M4 4.5h8v2.5a4 4 0 0 1-8 0zM8 11v3.5" /></svg>
  const C = VECTILUME[name]
  return <C size={16} className={cls} />
}
