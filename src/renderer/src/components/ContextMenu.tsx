import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}
export type MenuEntry = MenuItem | 'separator'

interface MenuState {
  x: number
  y: number
  items: MenuEntry[]
}

const Ctx = createContext<(e: React.MouseEvent, items: MenuEntry[]) => void>(() => {})

export function useContextMenu() {
  return useContext(Ctx)
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const open = (e: React.MouseEvent, items: MenuEntry[]) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Ne dopusti da izbornik izađe izvan prozora.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !menu) return
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth) el.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`
  }, [menu])

  return (
    <Ctx.Provider value={open}>
      {children}
      {menu && (
        <div ref={ref} className="context-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {menu.items.map((it, i) =>
            it === 'separator' ? (
              <div key={i} className="context-menu-sep" />
            ) : (
              <button
                key={i}
                className={'context-menu-item' + (it.danger ? ' danger' : '')}
                disabled={it.disabled}
                onClick={() => {
                  setMenu(null)
                  it.onClick()
                }}
              >
                <span>{it.label}</span>
                {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
              </button>
            )
          )}
        </div>
      )}
    </Ctx.Provider>
  )
}
