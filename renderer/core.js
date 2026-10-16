'use strict'
/* global icon */
// Ortak durum ve yardımcılar (diğer arayüz dosyaları bunları kullanır)
const api = window.yanki

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild }
const SAFE_IMG = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/
const safeImg = (s) => (typeof s === 'string' && SAFE_IMG.test(s) ? s : null)
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem('yanki.' + k)); return v ?? d } catch { return d } }
const save = (k, v) => { try { localStorage.setItem('yanki.' + k, JSON.stringify(v)) } catch {} }
const debounce = (fn, ms) => { const timers = new Map(); return (key, ...a) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => { timers.delete(key); fn(key, ...a) }, ms)) } }
const throttleRaf = (fn) => { let q = false; return () => { if (q) return; q = true; requestAnimationFrame(() => { q = false; fn() }) } }

function hashColor (key) {
  let h = 0
  for (let i = 0; i < 8; i++) h = (h * 31 + String(key).charCodeAt(i)) >>> 0
  const hues = [330, 262, 200, 170, 20, 45, 290, 0, 140, 220]
  return `hsl(${hues[h % hues.length]} 70% 55%)`
}
const initials = (name) => (String(name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase()

function fmtTime (ts) {
  const d = new Date(ts)
  const now = new Date()
  const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return 'Bugün ' + hm
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'Dün ' + hm
  return d.toLocaleDateString('tr-TR') + ' ' + hm
}
const fmtDay = (ts) => new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })
const fmtHM = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
const fmtDate = (ts) => new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
function fmtDur (sec) {
  sec = Math.max(0, Math.floor(sec))
  const h = Math.floor(sec / 3600); const m = Math.floor(sec / 60) % 60; const s = sec % 60
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0')
}
function fmtSince (ts) {
  const min = Math.floor((Date.now() - ts) / 60000)
  if (min < 1) return 'az önce başladı'
  if (min < 60) return `${min} dakikadır`
  const h = Math.floor(min / 60)
  return `${h} saat ${min % 60} dakikadır`
}

function toast (msg, ms = 3200) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => t.classList.remove('show'), ms)
}

async function copyText (text, msg = 'Kopyalandı') {
  try { await navigator.clipboard.writeText(text); toast(msg) } catch { toast('Kopyalanamadı') }
}

// =====================================================================
// Durum
// =====================================================================
const S = {
  me: null,
  profile: null,
  platform: 'win32',
  version: '',
  servers: [],
  meta: new Map(),
  mode: 'server', // 'server' | 'home'
  server: null,
  channel: null,
  dm: null, // açık özel sohbetin karşı tarafı
  dmAllowed: true,
  homeTab: 'online',
  view: 'chat', // 'chat' | 'stage'
  msgs: [],
  limit: 100,
  typing: new Map(),
  collapsed: load('collapsed', {}),
  lastRead: load('lastRead', {}),
  lastChannel: load('lastChannel', {}),
  showMembers: load('showMembers', true),
  reply: null,
  editing: null,
  attachments: [],
  search: '',
  focusTile: null,
  profiles: new Map(),
  acts: new Map(),
  myAct: null,
  dms: [],
  blocked: []
}

const settings = Object.assign({
  inputDevice: 'default',
  outputDevice: 'default',
  cameraDevice: '',
  noiseSuppression: true,
  echoCancellation: true,
  autoGain: true,
  screenQuality: '1080p30',
  screenAudio: true,
  allowEchoAudio: false,
  notify: 'mentions', // 'all' | 'mentions' | 'none'
  sounds: true,
  linkPreviews: true,
  musicVolume: 60,
  turnUrl: '',
  turnUser: '',
  turnPass: ''
}, load('settings', {}))
settings.theme = Object.assign({ id: 'yanki', dim: 45, blur: 0, glass: 30 }, settings.theme || {})
settings.activity = Object.assign({ enabled: true, custom: [] }, settings.activity || {})
const saveSettings = () => save('settings', settings)

let voice = null
let music = null

// =====================================================================
// Profiller, avatarlar, etkinlik
// =====================================================================
const curMeta = () => S.meta.get(S.server)
const member = (key, meta = curMeta()) => meta?.members?.find(m => m.key === key)

function cacheProfile (key, p) {
  if (!p) return
  const cur = S.profiles.get(key)
  if (!cur || (p.updatedAt || 0) >= (cur.updatedAt || 0)) S.profiles.set(key, p)
}

function profileOf (key) {
  if (key === S.me) return S.profile
  return S.profiles.get(key) || null
}
const nameOf = (key) => profileOf(key)?.name || ('Kullanıcı-' + String(key).slice(0, 6))
const colorOf = (key) => profileOf(key)?.color || null

function activityOf (key) {
  if (key === S.me) return S.myAct
  const e = S.acts.get(key)
  return e && e.act && Date.now() - e.at < 60000 ? e.act : null
}

function actText (act) {
  if (!act) return ''
  if (act.type === 'music') return `${act.details ? act.details + ' - ' : ''}${act.name} dinliyor`
  return `${act.name} oynuyor`
}

function actIcon (act, size = 14) {
  if (!act) return ''
  const src = typeof act.icon === 'string' && /^data:image\/png;base64,/.test(act.icon) ? act.icon : null
  if (src) return `<img class="aicon" src="${src}" style="width:${size}px;height:${size}px" alt="">`
  return `<span class="aicon glyph ${act.type}">${icon(act.type === 'music' ? 'music' : 'gamepad', size - 2)}</span>`
}

function actLine (key, cls = '') {
  const act = activityOf(key)
  if (!act) return ''
  return `<span class="actline ${act.type} ${cls}" title="${esc(actText(act))}">${actIcon(act, 14)}<span class="ellipsis">${esc(actText(act))}</span></span>`
}

// data-speak öğesi konuşurken "yankı halkaları" çizer
function avatar (key, size = 40, extra = '') {
  const p = profileOf(key)
  const src = safeImg(p?.avatar)
  const inner = src
    ? `<img src="${src}" alt="">`
    : `<span class="av-fallback" style="background:${hashColor(key)};font-size:${Math.round(size * 0.4)}px">${esc(initials(p?.name || key))}</span>`
  return `<span class="avw ${extra} ${voice?.speaking?.has(key) ? 'speaking' : ''}" data-speak="${esc(key)}" style="--s:${size}px">${inner}</span>`
}

function avatarFull (key, size = 40, { online = null, badge = true } = {}) {
  const act = badge ? activityOf(key) : null
  return `<span class="avx" style="--s:${size}px">${avatar(key, size)}` +
    (online !== null ? `<i class="sdot ${online ? 'on' : ''}"></i>` : '') +
    (act ? `<i class="abadge ${act.type}" title="${esc(actText(act))}">${actIcon(act, Math.max(12, Math.round(size * 0.36)))}</i>` : '') +
    '</span>'
}

// =====================================================================
// Markdown
// =====================================================================
const YT_RE = /(?:youtube\.com\/(?:watch\?(?:[^ ]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:[^ ]*&)?v=)([A-Za-z0-9_-]{11})/
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/gi
const IMG_URL_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i

function knownName (name) {
  const n = name.toLowerCase()
  if (S.profile.name && n === S.profile.name.toLowerCase()) return true
  for (const p of S.profiles.values()) if (p?.name?.toLowerCase() === n) return true
  return false
}

function md (text) {
  const codes = []
  let s = esc(text)
  s = s.replace(/```(?:[a-z0-9]+\n)?([\s\S]*?)```/gi, (_, c) => { codes.push(`<pre class="code-block"><code>${c.replace(/^\n/, '')}</code></pre>`); return `\u0000${codes.length - 1}\u0000` })
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(`<code class="code-inline">${c}</code>`); return `\u0000${codes.length - 1}\u0000` })
  s = s.replace(URL_RE, (u) => { codes.push(`<a href="${u}" class="link" data-act="open-link" data-url="${u}">${u}</a>`); return `\u0000${codes.length - 1}\u0000` })
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '<span class="spoiler" data-act="spoiler">$1</span>')
  s = s.replace(/^&gt; (.*)$/gm, '<span class="quote">$1</span>')
  s = s.replace(/(^|\s)@([\p{L}\p{N}_.-]{2,32})/gu, (all, pre, name) => {
    const me = S.profile.name && name.toLowerCase() === S.profile.name.toLowerCase()
    const known = me || name === 'everyone' || name === 'herkes' || knownName(name)
    return known ? `${pre}<span class="mention ${me ? 'me' : ''}">@${name}</span>` : all
  })
  s = s.replace(/\n/g, '<br>')
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i])
  return s
}

const mentionsMe = (text) => {
  const n = S.profile.name
  return !!text && ((n && text.toLowerCase().includes('@' + n.toLowerCase())) || /@(everyone|herkes)\b/.test(text))
}

// =====================================================================
// Modallar, açılır pencereler, menüler
// =====================================================================
function openModal ({ title, body, actions = [], wide = false, cls = '', onClose }) {
  closePopup()
  const root = $('#modal-root')
  const node = el(`
    <div class="modal-back">
      <div class="modal ${wide ? 'wide' : ''} ${cls}" role="dialog" aria-modal="true">
        ${title ? `<div class="modal-head"><h2>${title}</h2><button class="mini" data-close>${icon('x', 20)}</button></div>` : ''}
        <div class="modal-body"></div>
        ${actions.length ? `<div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-i="${i}">${a.label}</button>`).join('')}</div>` : ''}
      </div>
    </div>`)
  const bodyEl = $('.modal-body', node)
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body)
  const close = () => { node.remove(); document.removeEventListener('keydown', onKey, true); onClose?.() }
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  document.addEventListener('keydown', onKey, true)
  node.addEventListener('mousedown', (e) => { if (e.target === node) close() })
  $$('[data-close]', node).forEach(b => b.addEventListener('click', close))
  $$('.modal-foot button', node).forEach(b => b.addEventListener('click', async () => {
    const a = actions[+b.dataset.i]
    if (!a.onClick) return close()
    b.disabled = true
    try { const r = await a.onClick(node); if (r !== false) close() } catch (e) { toast(e.message || String(e)) } finally { b.disabled = false }
  }))
  root.appendChild(node)
  setTimeout(() => $('input:not([type=file]):not([type=checkbox]):not([type=color]):not([type=range]), textarea', bodyEl)?.focus(), 30)
  return { node, close, body: bodyEl }
}

function confirmModal (title, text, label = 'Onayla', kind = 'danger') {
  return new Promise(resolve => {
    let ok = false
    openModal({
      title,
      body: `<p>${text}</p>`,
      actions: [{ label: 'Vazgeç' }, { label, kind, onClick: () => { ok = true } }],
      onClose: () => resolve(ok)
    })
  })
}

function closePopup () { $('#popup-root').innerHTML = '' }

function openPopup (html, anchor, { align = 'right', cls = '' } = {}) {
  closePopup()
  const p = el(`<div class="popup ${cls}">${html}</div>`)
  $('#popup-root').appendChild(p)
  const r = anchor.getBoundingClientRect()
  const pw = p.offsetWidth
  const ph = p.offsetHeight
  let x = align === 'right' ? r.right + 10 : align === 'left' ? r.left - pw - 10 : r.left
  let y = align === 'below' ? r.bottom + 6 : r.top
  if (align === 'above') { y = r.top - ph - 10; x = r.left + r.width / 2 - pw / 2 }
  x = Math.max(8, Math.min(x, innerWidth - pw - 8))
  y = Math.max(8, Math.min(y, innerHeight - ph - 8))
  p.style.left = x + 'px'
  p.style.top = y + 'px'
  return p
}

function menu (items, anchor, opts) {
  const p = openPopup(`<div class="menu">${items.map((it, i) => it === '-' ? '<div class="menu-sep"></div>' : `<button class="menu-item ${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon ? icon(it.icon, 17) : ''}<span>${it.label}</span></button>`).join('')}</div>`, anchor, opts)
  $$('.menu-item', p).forEach(b => b.addEventListener('click', () => { closePopup(); items[+b.dataset.i].onClick() }))
}

const pointAnchor = (e) => ({ getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0 }), closest: () => null })

// =====================================================================
// Resim yardımcıları (GIF'ler hareketli kalsın diye olduğu gibi saklanır)
// =====================================================================
const fileToDataURL = (f) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(f) })
const imageSize = (src) => new Promise(resolve => { const i = new Image(); i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => resolve({ w: 0, h: 0 }); i.src = src })

async function resizeImage (file, { max = 2048, w, h, quality = 0.88, cover = false, type = 'image/jpeg' } = {}) {
  const bmp = await createImageBitmap(file)
  let tw, th, sx = 0, sy = 0, sw = bmp.width, sh = bmp.height
  if (cover && w && h) {
    const scale = Math.max(w / bmp.width, h / bmp.height)
    sw = w / scale; sh = h / scale
    sx = (bmp.width - sw) / 2; sy = (bmp.height - sh) / 2
    tw = w; th = h
  } else {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
    tw = Math.round(bmp.width * scale); th = Math.round(bmp.height * scale)
  }
  const c = document.createElement('canvas')
  c.width = tw; c.height = th
  const ctx = c.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  const keepAlpha = file.type === 'image/png' || file.type === 'image/webp'
  if (!keepAlpha) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, tw, th) }
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, tw, th)
  return c.toDataURL(keepAlpha ? 'image/webp' : type, quality)
}

// gifMax: hareketli GIF için en büyük dosya boyutu (bayt)
function pickImage (opts = {}) {
  return new Promise(resolve => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = 'image/png,image/jpeg,image/webp,image/gif'
    inp.onchange = async () => {
      const f = inp.files[0]
      if (!f) return resolve(null)
      try {
        if (f.type === 'image/gif' && opts.gifMax) {
          if (f.size > opts.gifMax) {
            toast(`GIF çok büyük (en fazla ${(opts.gifMax / 1048576).toFixed(1)} MB). Daha küçük bir GIF dene.`, 5000)
            return resolve(null)
          }
          return resolve(await fileToDataURL(f))
        }
        resolve(await resizeImage(f, opts))
      } catch { toast('Resim okunamadı.'); resolve(null) }
    }
    inp.click()
  })
}

const GIF_LIMITS = { avatar: 2.5 * 1048576, banner: 5 * 1048576, icon: 2.5 * 1048576 }
