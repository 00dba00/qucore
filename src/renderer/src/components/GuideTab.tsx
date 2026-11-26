import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from '@vectilume/react'
import { guides } from 'virtual:guide'
import { getLang, t } from '../i18n'

/** Vodič na jeziku sučelja; ako ga nema, hrvatski (izvorni). */
const guide = guides[getLang()] ?? guides.hr ?? { html: '', images: {} }
const { html, images } = guide

/** HTML vodiča s pravim URL-ovima slika (placeholderi iz build plugina). */
const guideHtml = html.replace(/<img src="__GUIDE_IMG__(.+?)__"/g, (m, src: string) => {
  const url = images[src.replace(/&amp;/g, '&')]
  // Slika koja nije ušla u build: ne prikazuj prazan okvir.
  return url ? `<img src="${url}"` : '<img hidden src=""'
})

interface Chapter {
  id: string
  title: string
  /** Tekst poglavlja malim slovima, za pretragu. */
  text: string
}

/** Korisnički vodič (docs/guide) kao tab: poglavlja lijevo, pretraga, sadržaj desno. */
export function GuideTab({ active }: { active: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [search, setSearch] = useState('')
  const [current, setCurrent] = useState<string | null>(null)

  // Poglavlja = naslovi h2 s tekstom do idućeg h2.
  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const list: Chapter[] = []
    let cur: Chapter | null = null
    for (const el of Array.from(root.children)) {
      if (el.tagName === 'H2') {
        cur = { id: el.id, title: el.textContent ?? '', text: (el.textContent ?? '').toLowerCase() }
        list.push(cur)
      } else if (cur) cur.text += ' ' + (el.textContent ?? '').toLowerCase()
    }
    setChapters(list)
  }, [])

  // Poglavlje koje se trenutno čita (za isticanje u popisu).
  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const onScroll = () => {
      const heads = Array.from(root.querySelectorAll('h2'))
      const top = root.getBoundingClientRect().top + 40
      let id: string | null = heads[0]?.id ?? null
      for (const h of heads) if (h.getBoundingClientRect().top <= top) id = h.id
      setCurrent(id)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => root.removeEventListener('scroll', onScroll)
  }, [])

  const go = (id: string) => {
    const el = contentRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)
    el?.scrollIntoView({ block: 'start' })
  }

  // Linkovi #sidro unutar vodiča skrolaju tab (navigacija prozora je ionako zabranjena).
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href')
    if (href?.startsWith('#')) {
      e.preventDefault()
      go(decodeURIComponent(href.slice(1)))
    }
  }

  const q = search.trim().toLowerCase()
  const shown = useMemo(() => (q ? chapters.filter((c) => c.text.includes(q)) : chapters), [chapters, q])

  return (
    <div className="guide-tab" style={{ display: active ? 'flex' : 'none' }}>
      <nav className="guide-nav">
        <div className="explorer-filter">
          <Search size={14} />
          <input
            placeholder={t('guide.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearch('')
              if (e.key === 'Enter' && shown[0]) go(shown[0].id)
            }}
          />
        </div>
        <div className="guide-chapters">
          {shown.map((c) => (
            <button key={c.id} className={'guide-chapter' + (c.id === current ? ' active' : '')} onClick={() => go(c.id)}>
              {c.title}
            </button>
          ))}
          {q && shown.length === 0 && <div className="muted small guide-empty">{t('guide.noChapter', search)}</div>}
        </div>
      </nav>
      <div className="guide-content" ref={contentRef} onClick={onClick} dangerouslySetInnerHTML={{ __html: guideHtml }} />
    </div>
  )
}
