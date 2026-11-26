// QuCore website: one typing moment in the hero, downloads from the latest GitHub release, guide search.
const REPO = '00dba00/qucore'
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

// ---------- hero: the query types itself once ----------
function typeQuery() {
  const code = document.querySelector('[data-type]')
  if (!code || reduceMotion) return
  const nodes = []
  const walk = (n) => n.childNodes.forEach((c) => (c.nodeType === 3 ? nodes.push({ node: c, text: c.textContent }) : walk(c)))
  walk(code)
  nodes.forEach((n) => (n.node.textContent = ''))
  const caret = document.createElement('span')
  caret.className = 'caret'
  code.append(caret)
  let i = 0
  let pos = 0
  const step = () => {
    if (i >= nodes.length) return setTimeout(() => caret.remove(), 1600)
    const n = nodes[i]
    pos += 2
    n.node.textContent = n.text.slice(0, pos)
    if (pos >= n.text.length) {
      i++
      pos = 0
    }
    setTimeout(step, 22)
  }
  setTimeout(step, 250)
}

// ---------- downloads ----------
function detectOs() {
  const ua = navigator.userAgent
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? ''
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows'
  if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return 'mac'
  if (/Linux/i.test(platform) && !/Android/i.test(ua)) return 'linux'
  return null
}

const MATCH = {
  windows: (n) => /\.exe$/i.test(n),
  'mac-arm': (n) => /mac-arm64\.dmg$/i.test(n),
  'mac-intel': (n) => /mac-x64\.dmg$/i.test(n),
  linux: (n) => /\.AppImage$/i.test(n)
}
const LABEL = { windows: 'Windows', 'mac-arm': 'macOS (Apple Silicon)', 'mac-intel': 'macOS (Intel)', linux: 'Linux' }
const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`

async function setupDownloads() {
  const rows = document.querySelectorAll('[data-platforms] tr')
  if (!rows.length) return
  const os = detectOs()
  // macOS: the browser does not say which chip; Apple Silicon is the default for current Macs.
  const mine = os === 'mac' ? 'mac-arm' : os
  rows.forEach((r) => r.classList.toggle('mine', r.dataset.os === mine))
  const primary = document.querySelector('[data-primary-download]')
  let release
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(String(res.status))
    release = await res.json()
  } catch {
    return // the static links to the releases page stay
  }
  const version = release.tag_name.replace(/^v/, '')
  const date = new Date(release.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  document.querySelectorAll('[data-release-line]').forEach((el) => (el.textContent = `Version ${version}, released ${date}. Open source, MIT license.`))
  const detail = document.querySelector('[data-release-detail]')
  if (detail) {
    detail.innerHTML = ''
    detail.append(`Version ${version}, released ${date}. `)
    const a = document.createElement('a')
    a.href = release.html_url
    a.textContent = 'Release notes'
    detail.append(a)
  }
  rows.forEach((row) => {
    const asset = release.assets.find((a) => MATCH[row.dataset.os]?.(a.name))
    if (!asset) return
    row.querySelector('a').href = asset.browser_download_url
    row.querySelector('.size').textContent = mb(asset.size)
    if (row.dataset.os === mine && primary) {
      primary.href = asset.browser_download_url
      primary.querySelector('span').textContent = `Download for ${LABEL[mine]}`
    }
  })
}

// ---------- guide: filter chapters by title and text ----------
async function setupGuideSearch() {
  const input = document.querySelector('.doc-search')
  if (!input) return
  const base = document.body.dataset.base
  const links = [...document.querySelectorAll('.doc-nav li')]
  const hits = document.querySelector('.doc-nav .hits')
  let index = null
  input.addEventListener('input', async () => {
    const q = input.value.trim().toLowerCase()
    if (q && !index) index = await fetch(`${base}guide/search.json`).then((r) => r.json()).catch(() => ({}))
    let shown = 0
    for (const li of links) {
      const slug = li.dataset.slug
      const ok = !q || li.textContent.toLowerCase().includes(q) || (index?.[slug] ?? '').includes(q)
      li.hidden = !ok
      if (ok) shown++
    }
    hits.textContent = q ? (shown ? `${shown} ${shown === 1 ? 'chapter' : 'chapters'} mention "${input.value.trim()}"` : `No chapter mentions "${input.value.trim()}"`) : ''
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = ''
      input.dispatchEvent(new Event('input'))
    }
    if (e.key === 'Enter') links.find((li) => !li.hidden)?.querySelector('a')?.click()
  })
}

typeQuery()
setupDownloads()
setupGuideSearch()
