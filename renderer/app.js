'use strict'
/* global icon, Voice, SCREEN_QUALITY */
const api = window.yanki

// =====================================================================
// Yardımcılar
// =====================================================================
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild }
const SAFE_IMG = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/
const safeImg = (s) => (typeof s === 'string' && SAFE_IMG.test(s) ? s : null)
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem('yanki.' + k)); return v ?? d } catch { return d } }
const save = (k, v) => { try { localStorage.setItem('yanki.' + k, JSON.stringify(v)) } catch {} }
const debounce = (fn, ms) => { const timers = new Map(); return (key, ...a) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => { timers.delete(key); fn(key, ...a) }, ms)) } }

function hashColor (key) {
  let h = 0
  for (let i = 0; i < 8; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  const hues = [262, 200, 150, 340, 30, 190, 280, 10, 120, 50]
  return `hsl(${hues[h % hues.length]} 60% 52%)`
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
  servers: [],
  meta: new Map(),
  server: null,
  channel: null,
  view: 'chat', // 'chat' | 'stage'
  msgs: [],
  limit: 100,
  typing: new Map(), // "server:channel" -> Map(user -> ts)
  collapsed: load('collapsed', {}),
  lastRead: load('lastRead', {}),
  lastChannel: load('lastChannel', {}),
  showMembers: load('showMembers', true),
  reply: null,
  editing: null,
  attachments: [],
  search: '',
  focusTile: null
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
  notify: 'mentions', // 'all' | 'mentions' | 'none'
  sounds: true,
  linkPreviews: true,
  turnUrl: '',
  turnUser: '',
  turnPass: ''
}, load('settings', {}))
const saveSettings = () => save('settings', settings)

let voice = null

// Mevcut sunucu verisi kısayolları
const curMeta = () => S.meta.get(S.server)
const member = (key, meta = curMeta()) => meta?.members?.find(m => m.key === key)
function profileOf (key, meta = curMeta()) {
  if (key === S.me) return S.profile
  return member(key, meta)?.profile || null
}
const nameOf = (key, meta) => profileOf(key, meta)?.name || ('Kullanıcı-' + key.slice(0, 6))
const colorOf = (key, meta) => profileOf(key, meta)?.color || null

function avatar (key, size = 40, meta, extra = '') {
  const p = profileOf(key, meta)
  const src = safeImg(p?.avatar)
  const style = `width:${size}px;height:${size}px`
  if (src) return `<img class="av ${extra}" data-speak="${key}" style="${style}" src="${src}" alt="">`
  return `<div class="av av-fallback ${extra}" data-speak="${key}" style="${style};background:${hashColor(key)};font-size:${Math.round(size * 0.4)}px">${esc(initials(p?.name || key))}</div>`
}

// =====================================================================
// Başlatma ve olaylar
// =====================================================================
async function init () {
  const r = await api.init()
  S.me = r.me
  S.profile = r.profile
  S.servers = r.servers
  S.platform = r.platform
  document.body.classList.add('os-' + r.platform)

  voice = new Voice({
    api,
    me: S.me,
    settings: () => settings,
    toast,
    onUpdate: () => { renderVoiceInSidebar(); renderBottomBar(); renderStage(); renderHeader() },
    onSpeaking: (key, on) => $$(`[data-speak="${key}"]`).forEach(n => n.classList.toggle('speaking', on))
  })

  api.on(onEvent)
  bindStatic()

  if (!S.profile.name) openProfileSetup()

  for (const s of S.servers) refreshMeta(s.id)
  const last = load('lastServer', null)
  const first = S.servers.find(s => s.id === last) || S.servers[0]
  if (first) await selectServer(first.id)
  renderAll()
}

const refreshMeta = debounce(async (serverId) => {
  const m = await api.meta(serverId)
  if (!m) return
  S.meta.set(serverId, m)
  if (serverId === S.server) {
    // Seçili kanal silindiyse başka bir kanala geç
    if (!m.pending && S.channel && !m.channels.some(c => c.id === S.channel)) {
      S.channel = null
      pickDefaultChannel()
      await loadMessages()
    }
    if (!m.pending && !S.channel) { pickDefaultChannel(); await loadMessages() }
    renderSidebar(); renderHeader(); renderMembers(); renderBottomBar(); renderEmpty()
  }
  renderRail()
}, 80)

const reloadMessages = debounce(() => loadMessages(), 60)

function onEvent (ev) {
  switch (ev.type) {
    case 'servers':
      S.servers = ev.servers
      renderRail()
      if (S.server && !S.servers.some(s => s.id === S.server)) {
        S.server = null
        if (S.servers[0]) selectServer(S.servers[0].id); else renderAll()
      } else if (S.server) refreshMeta(S.server)
      break
    case 'ops': {
      refreshMeta(ev.server)
      let touchCurrent = false
      for (const o of ev.ops) {
        if (ev.server === S.server && (o.channel === S.channel || ['message-edit', 'message-delete', 'reaction', 'pin', 'profile'].includes(o.type))) touchCurrent = true
        if (o.type === 'message' && o.author !== S.me) maybeNotify(ev.server, o)
        if (o.type === 'message') clearTyping(ev.server, o.channel, o.author)
      }
      if (touchCurrent) reloadMessages('cur')
      break
    }
    case 'peers':
      for (const s of ev.servers || []) refreshMeta(s)
      break
    case 'eph':
      if (ev.kind === 'voice') voice.onState(ev.server, ev.from, ev.data)
      else if (ev.kind === 'typing' && ev.data && typeof ev.data.channel === 'string') {
        const k = ev.server + ':' + ev.data.channel
        if (!S.typing.has(k)) S.typing.set(k, new Map())
        S.typing.get(k).set(ev.from, Date.now())
        renderTyping()
      }
      break
    case 'signal':
      voice.onSignal(ev.from, ev.data)
      break
    case 'focus':
      markRead()
      break
  }
}

function clearTyping (server, channel, user) {
  S.typing.get(server + ':' + channel)?.delete(user)
  renderTyping()
}
setInterval(renderTyping, 1500)

function maybeNotify (serverId, o) {
  const meta = S.meta.get(serverId)
  const myName = S.profile.name
  const mention = !!(myName && o.text && (o.text.includes('@' + myName) || o.text.includes('@everyone') || o.text.includes('@herkes')))
  const visible = document.hasFocus() && serverId === S.server && o.channel === S.channel && S.view === 'chat'
  if (visible) return
  if (settings.notify === 'none' || (settings.notify === 'mentions' && !mention)) return
  const ch = meta?.channels?.find(c => c.id === o.channel)
  api.notify(`${nameOf(o.author, meta)}${ch ? ' · #' + ch.name : ''}`, o.text || (o.hasImage ? '📷 Resim' : ''))
  if (settings.sounds) voice.sound('message')
}

// =====================================================================
// Sunucu ve kanal seçimi
// =====================================================================
async function selectServer (id) {
  S.server = id
  save('lastServer', id)
  S.channel = null
  S.msgs = []
  S.search = ''
  const m = await api.meta(id)
  S.meta.set(id, m)
  pickDefaultChannel()
  if (S.view === 'stage' && voice.server !== id) S.view = 'chat'
  await loadMessages()
  renderAll()
}

function pickDefaultChannel () {
  const m = curMeta()
  if (!m || m.pending) return
  const text = m.channels.filter(c => c.kind === 'text')
  const lastId = S.lastChannel[S.server]
  S.channel = (text.find(c => c.id === lastId) || sortedChannels(m).find(c => c.kind === 'text') || text[0])?.id || null
}

function sortedChannels (m) {
  const out = []
  for (const c of m.channels.filter(c => !c.category || !m.categories.some(k => k.id === c.category))) out.push(c)
  for (const cat of m.categories) for (const c of m.channels.filter(c => c.category === cat.id)) out.push(c)
  return out
}

async function selectChannel (id) {
  const m = curMeta()
  const ch = m?.channels.find(c => c.id === id)
  if (!ch) return
  if (ch.kind === 'voice') {
    const limit = ch.userLimit || 0
    const count = voice.participants(S.server, id).length
    if (!(voice.server === S.server && voice.channel === id) && limit && count >= limit) { toast('Bu ses kanalı dolu.'); return }
    await voice.join(S.server, id)
    S.view = 'stage'
    renderAll()
    return
  }
  S.channel = id
  S.view = 'chat'
  S.lastChannel[S.server] = id
  save('lastChannel', S.lastChannel)
  S.reply = null
  S.editing = null
  S.limit = 100
  S.search = ''
  await loadMessages(true)
  renderAll()
  $('#input').focus()
}

async function loadMessages (scrollBottom = false) {
  if (!S.server || !S.channel) { S.msgs = []; renderMessages(); return }
  const [s, c] = [S.server, S.channel]
  const list = await api.messages(s, c, { limit: S.limit })
  if (s !== S.server || c !== S.channel) return
  S.msgs = list
  renderMessages(scrollBottom)
  markRead()
}

function markRead () {
  if (!S.server || !S.channel || !document.hasFocus() || S.view !== 'chat') return
  const ch = curMeta()?.channels?.find(c => c.id === S.channel)
  const ts = ch?.lastTs || Date.now()
  const k = S.server + ':' + S.channel
  if ((S.lastRead[k] || 0) < ts) {
    S.lastRead[k] = ts
    save('lastRead', S.lastRead)
    renderSidebarSoon()
    renderRail()
  }
}
const renderSidebarSoon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(renderSidebar, 30) } })()

const isUnread = (serverId, ch) => ch.kind === 'text' && ch.lastTs && ch.lastAuthor !== S.me && ch.lastTs > (S.lastRead[serverId + ':' + ch.id] || 0)

// =====================================================================
// Render: tümü
// =====================================================================
function renderAll () {
  renderRail()
  renderSidebar()
  renderHeader()
  renderMessages()
  renderMembers()
  renderBottomBar()
  renderStage()
  renderEmpty()
  renderComposerState()
}

function renderEmpty () {
  const empty = $('#empty')
  const chat = $('#chat')
  const m = curMeta()
  let html = ''
  if (!S.servers.length) {
    html = `
      <div class="empty-card">
        <div class="empty-logo">${icon('volume', 40)}</div>
        <h1>Yankı'ya hoş geldin</h1>
        <p>Merkezi sunucu yok. Topluluğun yalnızca üyelerinin bilgisayarlarında yaşar ve doğrudan, uçtan uca şifreli bağlantılarla haberleşir.</p>
        <div class="row gap">
          <button class="btn primary" data-act="create-server">${icon('plus', 18)} Sunucu oluştur</button>
          <button class="btn" data-act="join-server">${icon('link', 18)} Davet koduyla katıl</button>
        </div>
      </div>`
  } else if (m && m.pending) {
    html = `
      <div class="empty-card">
        <div class="spinner"></div>
        <h1>Eşler aranıyor…</h1>
        <p>Bu sunucunun verileri, çevrimiçi bir üyesi bulunduğu anda doğrudan ondan eşitlenecek. Davet eden kişinin uygulamasının açık olduğundan emin ol.</p>
        <p class="muted small">Bağlı eş: ${m.peers || 0}</p>
        <button class="btn danger" data-act="leave-server">Vazgeç ve ayrıl</button>
      </div>`
  } else if (m && !S.channel && S.view === 'chat') {
    html = `<div class="empty-card"><h1>Metin kanalı yok</h1><p>${m.isAdmin ? 'Kenar çubuğundan yeni bir kanal oluşturabilirsin.' : 'Bir yöneticinin kanal oluşturmasını bekle.'}</p></div>`
  }
  empty.innerHTML = html
  empty.hidden = !html
  chat.hidden = !!html || S.view === 'stage'
}

// =====================================================================
// Sol: sunucu rayı
// =====================================================================
function renderRail () {
  const rail = $('#rail')
  const items = S.servers.map(s => {
    const meta = S.meta.get(s.id)
    const unread = meta && !meta.pending && meta.channels.some(c => isUnread(s.id, c))
    const icn = safeImg(s.icon)
    const inVoice = voice?.server === s.id
    return `
      <button class="rail-item ${s.id === S.server ? 'active' : ''} ${unread ? 'unread' : ''}" data-act="server" data-id="${s.id}" title="${esc(s.name)}">
        <span class="pill"></span>
        ${icn ? `<img src="${icn}" alt="">` : `<span class="rail-initials" style="background:${hashColor(s.id)}">${esc(initials(s.name))}</span>`}
        ${s.pending ? '<span class="rail-badge sync">…</span>' : ''}
        ${inVoice ? `<span class="rail-voice">${icon('volume', 11)}</span>` : ''}
      </button>`
  }).join('')
  rail.innerHTML = `
    <div class="rail-top">${S.platform === 'darwin' ? '<div class="traffic-space"></div>' : ''}</div>
    <div class="rail-list">${items}
      <button class="rail-item add" data-act="add-server" title="Sunucu ekle">${icon('plus', 22)}</button>
    </div>
    <div class="rail-bottom">
      <button class="rail-item me" data-act="my-profile" title="Profilim">${avatar(S.me, 44)}</button>
    </div>`
  const unreadCount = S.servers.filter(s => { const m = S.meta.get(s.id); return m && !m.pending && m.channels.some(c => isUnread(s.id, c)) }).length
  api.badge(unreadCount)
}

// =====================================================================
// Kanal kenar çubuğu
// =====================================================================
function renderSidebar () {
  const m = curMeta()
  const header = $('#server-header')
  const box = $('#channels')
  if (!m) { header.innerHTML = ''; box.innerHTML = ''; return }
  if (m.pending) {
    header.innerHTML = `<div class="sh-title">Eşitleniyor…</div>`
    box.innerHTML = `<div class="muted pad small">Sunucu verisi bekleniyor. Bağlı eş: ${m.peers}</div>`
    return
  }
  const banner = safeImg(m.banner)
  header.className = banner ? 'has-banner' : ''
  header.style.backgroundImage = banner ? `linear-gradient(180deg, transparent 30%, var(--bg-1) 100%), url(${banner})` : ''
  header.innerHTML = `
    <button class="sh-title" data-act="server-menu">
      <span class="ellipsis">${esc(m.name)}</span>
      <span class="sh-peers" title="Doğrudan bağlı eş sayısı">${icon('signal', 13)} ${m.peers}</span>
      ${icon('chevronDown', 18)}
    </button>`

  const groups = []
  const orphan = m.channels.filter(c => !c.category || !m.categories.some(k => k.id === c.category))
  if (orphan.length) groups.push({ cat: null, list: orphan })
  for (const cat of m.categories) groups.push({ cat, list: m.channels.filter(c => c.category === cat.id) })

  box.innerHTML = groups.map(({ cat, list }) => {
    const collapsed = cat && S.collapsed[cat.id]
    const visible = collapsed ? list.filter(c => c.id === S.channel || (voice.server === S.server && voice.channel === c.id) || isUnread(S.server, c)) : list
    return `
      <div class="cat">
        ${cat ? `
          <div class="cat-head">
            <button class="cat-toggle" data-act="toggle-cat" data-id="${cat.id}">${icon(collapsed ? 'chevronRight' : 'chevronDown', 14)}<span>${esc(cat.name)}</span></button>
            ${m.isAdmin ? `<button class="mini" data-act="new-channel" data-cat="${cat.id}" title="Kanal oluştur">${icon('plus', 15)}</button><button class="mini" data-act="edit-cat" data-id="${cat.id}" title="Kategoriyi düzenle">${icon('settings', 14)}</button>` : ''}
          </div>` : ''}
        ${visible.map(c => channelRow(c, m)).join('')}
      </div>`
  }).join('')
  renderVoiceInSidebar()
}

function channelRow (c, m) {
  const active = c.kind === 'text' ? (c.id === S.channel && S.view === 'chat') : (voice.server === S.server && voice.channel === c.id)
  const unread = isUnread(S.server, c)
  return `
    <div class="ch ${c.kind} ${active ? 'active' : ''} ${unread ? 'unread' : ''}" data-act="channel" data-id="${c.id}" title="${esc(c.topic || c.name)}">
      <span class="ch-icon">${icon(c.kind === 'voice' ? 'volume' : 'hash', 18)}</span>
      <span class="ch-text">
        <span class="ch-name">${esc(c.name)}</span>
        ${c.topic && c.kind === 'voice' ? `<span class="ch-topic">${esc(c.topic)}</span>` : ''}
      </span>
      ${c.kind === 'voice' && c.userLimit ? `<span class="ch-limit">${voice.participants(S.server, c.id).length}/${c.userLimit}</span>` : ''}
      ${m.isAdmin ? `<button class="mini ch-edit" data-act="edit-channel" data-id="${c.id}" title="Kanalı düzenle">${icon('settings', 14)}</button>` : ''}
    </div>
    ${c.kind === 'voice' ? `<div class="voice-users" data-voice="${c.id}"></div>` : ''}`
}

function renderVoiceInSidebar () {
  for (const box of $$('.voice-users')) {
    const cid = box.dataset.voice
    const list = voice.participants(S.server, cid)
    box.innerHTML = list.map(p => `
      <div class="vu" data-act="user" data-key="${p.key}">
        ${avatar(p.key, 24, undefined, voice.speaking.has(p.key) ? 'speaking' : '')}
        <span class="vu-name ${p.self ? 'self' : ''}" style="${colorOf(p.key) ? `color:${colorOf(p.key)}` : ''}">${esc(nameOf(p.key))}</span>
        <span class="vu-flags">
          ${p.screen ? '<span class="live">CANLI</span>' : ''}
          ${p.cam ? icon('video', 14) : ''}
          ${p.deaf ? icon('headphonesOff', 14, 'red') : p.muted ? icon('micOff', 14, 'red') : ''}
        </span>
      </div>`).join('')
  }
}

// =====================================================================
// Kanal başlığı
// =====================================================================
function renderHeader () {
  const h = $('#chan-header')
  const m = curMeta()
  if (!m || m.pending) { h.innerHTML = ''; return }
  let left = ''
  if (S.view === 'stage' && voice.channel && voice.server === S.server) {
    const ch = m.channels.find(c => c.id === voice.channel)
    left = `<span class="hd-icon">${icon('volume', 22)}</span><span class="hd-name">${esc(ch?.name || 'Ses')}</span>${ch?.topic ? `<span class="hd-sep"></span><span class="hd-topic">${esc(ch.topic)}</span>` : ''}`
  } else {
    const ch = m.channels.find(c => c.id === S.channel)
    if (!ch) { h.innerHTML = ''; return }
    left = `<span class="hd-icon">${icon('hash', 22)}</span><span class="hd-name">${esc(ch.name)}</span>${ch.topic ? `<span class="hd-sep"></span><span class="hd-topic">${esc(ch.topic)}</span>` : ''}`
  }
  const chObj = m.channels.find(c => c.id === S.channel)
  h.innerHTML = `
    <div class="hd-left">${left}</div>
    <div class="hd-right">
      ${voice.channel && voice.server === S.server ? `<button class="hd-btn ${S.view === 'stage' ? 'on' : ''}" data-act="toggle-view" title="${S.view === 'stage' ? 'Sohbete dön' : 'Sesli sahneyi göster'}">${icon(S.view === 'stage' ? 'chat' : 'stage', 20)}</button>` : ''}
      ${S.view === 'chat' ? `
        <div class="hd-search">${icon('search', 15)}<input id="search" placeholder="Bu kanalda ara" value="${esc(S.search)}"></div>
        <button class="hd-btn" data-act="pins" title="Sabitlenmiş mesajlar">${icon('pin', 20)}${chObj?.pins?.length ? `<span class="hd-count">${chObj.pins.length}</span>` : ''}</button>` : ''}
      <button class="hd-btn ${S.showMembers ? 'on' : ''}" data-act="toggle-members" title="Üye listesi">${icon('users', 20)}</button>
    </div>`
}

// =====================================================================
// Mesajlar
// =====================================================================
const YT_RE = /(?:youtube\.com\/(?:watch\?(?:[^ ]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/gi
const IMG_URL_RE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i

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
    const known = me || name === 'everyone' || name === 'herkes' || curMeta()?.members?.some(m => m.profile?.name?.toLowerCase() === name.toLowerCase())
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

function messageEmbeds (m) {
  if (!m.text) return ''
  const urls = [...new Set(m.text.match(URL_RE) || [])].slice(0, 4)
  return urls.map(u => {
    const yt = u.match(YT_RE)
    if (yt) {
      return `<div class="embed yt" data-act="yt-play" data-yt="${yt[1]}">
        <img src="https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg" alt="" loading="lazy">
        <span class="yt-play">${icon('play', 28)}</span>
        <span class="yt-badge">YouTube</span>
      </div>`
    }
    if (IMG_URL_RE.test(u)) return `<img class="att-img remote" src="${esc(u)}" data-act="lightbox" alt="" loading="lazy">`
    if (!settings.linkPreviews) return ''
    return `<div class="embed-slot" data-url="${esc(u)}"></div>`
  }).join('')
}

function renderMessages (forceBottom = false) {
  const box = $('#messages')
  if (!S.channel) { box.innerHTML = ''; return }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  const prevHeight = box.scrollHeight
  const prevTop = box.scrollTop
  const m = curMeta()
  const ch = m?.channels.find(c => c.id === S.channel)

  let list = S.msgs
  const q = S.search.trim().toLowerCase()
  if (q) list = list.filter(x => x.text.toLowerCase().includes(q) || nameOf(x.author).toLowerCase().includes(q))

  // Varsayılan kanalda "topluluğa katıldı" sistem mesajları
  const firstText = m ? sortedChannels(m).find(c => c.kind === 'text') : null
  let items = list.map(x => ({ kind: 'msg', ts: x.ts, m: x }))
  if (!q && firstText && firstText.id === S.channel && m) {
    const from = S.msgs.length >= S.limit ? S.msgs[0].ts : 0
    for (const mem of m.members) if (mem.joinedAt > from && mem.key !== m.owner) items.push({ kind: 'join', ts: mem.joinedAt, key: mem.key })
    items.sort((a, b) => a.ts - b.ts)
  }

  let html = ''
  if (!q && S.msgs.length < S.limit) {
    html += `
      <div class="chan-welcome">
        <div class="cw-icon">${icon('hash', 40)}</div>
        <h2>#${esc(ch?.name || '')} kanalına hoş geldin!</h2>
        <p>Bu, #${esc(ch?.name || '')} kanalının başlangıcı.${ch?.topic ? ' ' + esc(ch.topic) : ''}</p>
      </div>`
  } else if (!q) {
    html += '<div class="load-more muted small">Daha eski mesajlar için yukarı kaydır…</div>'
  }
  if (q) html += `<div class="search-info muted small">"${esc(S.search)}" için ${list.length} sonuç</div>`

  let prev = null
  let lastDay = ''
  const pins = new Set(ch?.pins || [])
  for (const it of items) {
    const day = new Date(it.ts).toDateString()
    if (day !== lastDay) { html += `<div class="day-sep"><span>${esc(fmtDay(it.ts))}</span></div>`; lastDay = day; prev = null }
    if (it.kind === 'join') {
      html += `<div class="sys-msg">${icon('users', 18)}<span><span class="mention" data-act="user" data-key="${it.key}">@${esc(nameOf(it.key))}</span> topluluğa katıldı!</span><span class="msg-time">${esc(fmtTime(it.ts))}</span></div>`
      prev = null
      continue
    }
    const x = it.m
    const grouped = prev && prev.author === x.author && x.ts - prev.ts < 5 * 60 * 1000 && !x.reply
    const own = x.author === S.me
    const color = colorOf(x.author)
    const reactions = Object.entries(x.reactions || {})
    html += `
      <div class="msg ${grouped ? 'grouped' : ''} ${mentionsMe(x.text) ? 'mentioned' : ''} ${S.editing === x.id ? 'editing' : ''}" data-id="${x.id}">
        ${x.reply ? `<div class="reply-ref" data-act="jump" data-id="${x.reply.id}">${avatar(x.reply.author, 16)}<span class="rr-name">${esc(nameOf(x.reply.author))}</span><span class="rr-text">${esc(x.reply.text || (x.reply.hasImage ? '📷 Resim' : ''))}</span></div>` : ''}
        <div class="msg-row">
          <div class="msg-gutter">${grouped ? `<span class="msg-hover-time">${fmtHM(x.ts)}</span>` : `<button class="av-btn" data-act="user" data-key="${x.author}">${avatar(x.author, 40)}</button>`}</div>
          <div class="msg-body">
            ${grouped ? '' : `<div class="msg-head"><button class="msg-name" data-act="user" data-key="${x.author}" ${color ? `style="color:${color}"` : ''}>${esc(nameOf(x.author))}</button>${member(x.author)?.owner ? `<span class="tag owner" title="Sunucu sahibi">${icon('crown', 12)}</span>` : member(x.author)?.admin ? `<span class="tag admin" title="Yönetici">${icon('shield', 12)}</span>` : ''}<span class="msg-time">${esc(fmtTime(x.ts))}</span>${pins.has(x.id) ? `<span class="pinned">${icon('pin', 12)}</span>` : ''}</div>`}
            ${x.text ? `<div class="msg-text">${md(x.text)}${x.edited ? '<span class="edited">(düzenlendi)</span>' : ''}</div>` : ''}
            ${x.attachments.length ? `<div class="atts n${Math.min(x.attachments.length, 4)}">${x.attachments.map(a => safeImg(a.data) ? `<img class="att-img" src="${a.data}" alt="${esc(a.name)}" data-act="lightbox" loading="lazy">` : '').join('')}</div>` : ''}
            ${messageEmbeds(x)}
            ${reactions.length ? `<div class="reactions">${reactions.map(([e, users]) => `<button class="react ${users.includes(S.me) ? 'mine' : ''}" data-act="react" data-id="${x.id}" data-emoji="${esc(e)}" title="${esc(users.map(u => nameOf(u)).join(', '))}">${esc(e)} <b>${users.length}</b></button>`).join('')}<button class="react add" data-act="react-pick" data-id="${x.id}">${icon('smile', 15)}</button></div>` : ''}
          </div>
          <div class="msg-actions">
            ${['👍', '❤️', '😂'].map(e => `<button data-act="react" data-id="${x.id}" data-emoji="${e}" title="Tepki ver">${e}</button>`).join('')}
            <button data-act="react-pick" data-id="${x.id}" title="Tepki ekle">${icon('smile', 17)}</button>
            <button data-act="reply" data-id="${x.id}" title="Yanıtla">${icon('reply', 17)}</button>
            ${own ? `<button data-act="edit" data-id="${x.id}" title="Düzenle">${icon('edit', 17)}</button>` : ''}
            ${m?.isAdmin ? `<button data-act="pin" data-id="${x.id}" title="${pins.has(x.id) ? 'Sabitlemeyi kaldır' : 'Sabitle'}">${icon('pin', 17)}</button>` : ''}
            <button data-act="copy" data-id="${x.id}" title="Metni kopyala">${icon('copy', 17)}</button>
            ${own || m?.isAdmin ? `<button class="danger" data-act="delete" data-id="${x.id}" title="Sil">${icon('trash', 17)}</button>` : ''}
          </div>
        </div>
      </div>`
    prev = x
  }
  box.innerHTML = html

  // Gömme önizlemelerini doldur
  for (const slot of $$('.embed-slot', box)) fillPreview(slot)
  for (const img of $$('img', box)) img.addEventListener('load', () => { if (box._stick) box.scrollTop = box.scrollHeight }, { once: true })

  if (forceBottom || nearBottom || S._scrollBottomNext) {
    box.scrollTop = box.scrollHeight
    box._stick = true
    S._scrollBottomNext = false
  } else if (S._keepFromTop) {
    box.scrollTop = box.scrollHeight - prevHeight + prevTop
    S._keepFromTop = false
  } else {
    box.scrollTop = prevTop
  }
}

const previewCache = new Map()
async function fillPreview (slot) {
  const url = slot.dataset.url
  let p = previewCache.get(url)
  if (p === undefined) {
    p = await api.linkPreview(url).catch(() => null)
    previewCache.set(url, p)
  }
  if (!p || !slot.isConnected) return
  if (p.kind === 'image') { slot.outerHTML = `<img class="att-img remote" src="${esc(p.url)}" data-act="lightbox" alt="">`; return }
  const img = /^https:\/\//.test(p.image || '') ? p.image : ''
  slot.outerHTML = `
    <div class="embed link" ${/^#[0-9a-f]{3,8}$/i.test(p.color || '') ? `style="border-left-color:${p.color}"` : ''}>
      <div class="lk-site">${esc(p.site)}</div>
      <a class="lk-title" data-act="open-link" data-url="${esc(p.url)}" href="${esc(p.url)}">${esc(p.title)}</a>
      ${p.description ? `<div class="lk-desc">${esc(p.description)}</div>` : ''}
      ${img ? `<img class="lk-img" src="${esc(img)}" alt="" loading="lazy">` : ''}
    </div>`
}

function renderTyping () {
  const box = $('#typing')
  if (!box) return
  const map = S.typing.get(S.server + ':' + S.channel)
  const now = Date.now()
  const who = map ? [...map].filter(([k, t]) => now - t < 6000 && k !== S.me).map(([k]) => nameOf(k)) : []
  box.innerHTML = who.length
    ? `<span class="dots"><i></i><i></i><i></i></span> <b>${esc(who.slice(0, 3).join(', '))}</b> ${who.length > 1 ? 'yazıyorlar' : 'yazıyor'}…`
    : ''
}

// =====================================================================
// Mesaj yazma alanı
// =====================================================================
function renderComposerState () {
  const m = curMeta()
  const ch = m?.channels?.find(c => c.id === S.channel)
  const input = $('#input')
  input.placeholder = ch ? `#${ch.name} kanalına mesaj gönder` : 'Mesaj gönder'
  const rb = $('#reply-bar')
  if (S.reply) {
    const r = S.msgs.find(x => x.id === S.reply)
    rb.hidden = false
    rb.innerHTML = `<span><b>${esc(r ? nameOf(r.author) : '')}</b> kişisine yanıt veriliyor</span><button class="mini" data-act="cancel-reply">${icon('x', 16)}</button>`
  } else if (S.editing) {
    rb.hidden = false
    rb.innerHTML = '<span>Mesaj düzenleniyor — <kbd>Esc</kbd> ile iptal</span><button class="mini" data-act="cancel-edit">' + icon('x', 16) + '</button>'
  } else {
    rb.hidden = true
  }
  $('#attach-preview').innerHTML = S.attachments.map((a, i) => `
    <div class="ap-item"><img src="${a.data}" alt=""><button data-act="remove-att" data-i="${i}" title="Kaldır">${icon('x', 14)}</button><span>${esc(a.name)}</span></div>`).join('')
}

function autoGrow () {
  const t = $('#input')
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 260) + 'px'
}

let lastTypingSent = 0
function onTyping () {
  autoGrow()
  if (!S.server || !S.channel) return
  if ($('#input').value.trim() && Date.now() - lastTypingSent > 3000) {
    lastTypingSent = Date.now()
    api.eph(S.server, 'typing', { channel: S.channel })
  }
}

async function send () {
  const input = $('#input')
  const text = input.value.replace(/\s+$/, '')
  if (!S.server || !S.channel) return
  try {
    if (S.editing) {
      if (text.trim()) await api.post(S.server, 'message-edit', { target: S.editing, text })
      S.editing = null
    } else {
      if (!text.trim() && !S.attachments.length) return
      const size = S.attachments.reduce((n, a) => n + a.data.length, 0)
      if (size > 10 * 1024 * 1024) { toast('Ekler çok büyük (toplam en fazla ~7 MB).'); return }
      await api.post(S.server, 'message', { channel: S.channel, text, attachments: S.attachments, replyTo: S.reply })
      S.reply = null
      S.attachments = []
    }
  } catch (e) {
    toast('Gönderilemedi: ' + (e.message || e))
    return
  }
  lastTypingSent = 0
  input.value = ''
  autoGrow()
  renderComposerState()
  S._scrollBottomNext = true
  await loadMessages(true)
}

function wrapSelection (mark) {
  const t = $('#input')
  const [a, b] = [t.selectionStart, t.selectionEnd]
  const sel = t.value.slice(a, b)
  t.setRangeText(mark + sel + mark, a, b, sel ? 'select' : 'end')
  if (!sel) t.selectionStart = t.selectionEnd = a + mark.length
  t.focus()
  autoGrow()
}

async function addFiles (files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) { toast('Şimdilik yalnızca resim paylaşılabilir.'); continue }
    if (S.attachments.length >= 6) { toast('En fazla 6 resim.'); break }
    try {
      let data
      if (f.type === 'image/gif' && f.size < 5 * 1024 * 1024) data = await fileToDataURL(f)
      else data = await resizeImage(f, { max: 2048, quality: 0.86 })
      const dims = await imageSize(data)
      S.attachments.push({ type: 'image', data, name: f.name || 'resim', w: dims.w, h: dims.h })
    } catch { toast('Resim okunamadı.') }
  }
  renderComposerState()
}

// =====================================================================
// Resim yardımcıları
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
  if (type === 'image/jpeg') { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, tw, th) }
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, tw, th)
  const keepAlpha = type === 'image/jpeg' && file.type === 'image/png'
  return c.toDataURL(keepAlpha ? 'image/webp' : type, quality)
}

function pickImage (opts) {
  return new Promise(resolve => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = 'image/*'
    inp.onchange = async () => {
      const f = inp.files[0]
      if (!f) return resolve(null)
      try { resolve(await resizeImage(f, opts)) } catch { toast('Resim okunamadı.'); resolve(null) }
    }
    inp.click()
  })
}

// =====================================================================
// Sağ: üye listesi
// =====================================================================
function renderMembers () {
  const box = $('#members')
  const m = curMeta()
  $('#app').classList.toggle('no-members', !!(!S.showMembers || !m || m.pending))
  if (!S.showMembers || !m || m.pending) { box.innerHTML = ''; return }
  const sortFn = (a, b) => (b.owner - a.owner) || (b.admin - a.admin) || nameOf(a.key).localeCompare(nameOf(b.key), 'tr')
  const online = m.members.filter(x => x.online).sort(sortFn)
  const offline = m.members.filter(x => !x.online).sort(sortFn)
  const row = (x) => {
    const p = profileOf(x.key)
    return `
      <button class="mem ${x.online ? '' : 'offline'}" data-act="user" data-key="${x.key}">
        <span class="mem-av">${avatar(x.key, 34)}<span class="status-dot ${x.online ? 'on' : ''}"></span></span>
        <span class="mem-text">
          <span class="mem-name" style="${p?.color && x.online ? `color:${p.color}` : ''}">${esc(nameOf(x.key))}${x.owner ? icon('crown', 13, 'gold') : x.admin ? icon('shield', 13, 'blue') : ''}</span>
          ${p?.status ? `<span class="mem-status">${esc(p.status)}</span>` : ''}
        </span>
      </button>`
  }
  box.innerHTML = `
    ${m.description ? `<div class="srv-desc">${esc(m.description)}</div>` : ''}
    <div class="mem-group">Çevrimiçi — ${online.length}</div>
    ${online.map(row).join('')}
    ${offline.length ? `<div class="mem-group">Çevrimdışı — ${offline.length}</div>${offline.map(row).join('')}` : ''}`
}

// =====================================================================
// Alt çubuk (kullanıcı + ses kontrolleri)
// =====================================================================
function renderBottomBar () {
  const bar = $('#bottombar')
  const inVoice = voice.active
  const vm = inVoice ? S.meta.get(voice.server) : null
  const vch = vm?.channels?.find(c => c.id === voice.channel)
  const peers = [...voice.peers.values()]
  const bad = peers.some(p => ['failed', 'disconnected'].includes(p.pc.connectionState))
  const connecting = peers.some(p => ['new', 'connecting'].includes(p.pc.connectionState))
  const status = !inVoice ? '' : bad ? 'Bağlantı sorunlu' : connecting ? 'Bağlanıyor…' : 'Bağlandı'
  const statusCls = bad ? 'bad' : connecting ? 'warn' : 'ok'
  bar.innerHTML = `
    <div class="bb-left">
      <button class="bb-user" data-act="my-profile">
        <span class="mem-av">${avatar(S.me, 40)}<span class="status-dot on"></span></span>
        <span class="bb-user-text"><b>${esc(S.profile.name || 'Ben')}</b><small>${esc(S.profile.status || 'Çevrim içi')}</small></span>
      </button>
      ${inVoice ? `
        <div class="bb-voice">
          <span class="bb-status ${statusCls}">${icon('signal', 16)} ${status}</span>
          <button class="bb-chan" data-act="goto-voice" title="Sesli sahneye git">${icon('volume', 16)} <span class="ellipsis">${esc(vch?.name || 'Ses')}</span>${vm && voice.server !== S.server ? `<small> / ${esc(vm.name)}</small>` : ''}</button>
        </div>` : ''}
    </div>
    <div class="bb-right">
      ${inVoice ? `
        <button class="bb-btn ${voice.screen ? 'live' : ''}" data-act="screen" title="${voice.screen ? 'Paylaşımı durdur' : 'Ekranını paylaş (1080p)'}">${icon(voice.screen ? 'screenOff' : 'screen', 22)}</button>
        <button class="bb-btn ${voice.cam ? 'on' : ''}" data-act="camera" title="${voice.cam ? 'Kamerayı kapat' : 'Kamerayı aç'}">${icon(voice.cam ? 'video' : 'videoOff', 22)}</button>
        <button class="bb-btn ${S.view === 'chat' ? '' : 'on'}" data-act="toggle-view" title="Sohbet / Sahne">${icon(S.view === 'stage' ? 'chat' : 'stage', 22)}</button>
        <span class="bb-div"></span>` : ''}
      <button class="bb-icon ${voice.muted || voice.deaf ? 'red' : ''}" data-act="mute" title="${voice.muted ? 'Sesi aç' : 'Sustur'} (Ctrl+Shift+M)">${icon(voice.muted || voice.deaf ? 'micOff' : 'mic', 22)}</button>
      <button class="bb-icon ${voice.deaf ? 'red' : ''}" data-act="deafen" title="${voice.deaf ? 'Sağırlaştırmayı kaldır' : 'Sağırlaştır'} (Ctrl+Shift+D)">${icon(voice.deaf ? 'headphonesOff' : 'headphones', 22)}</button>
      <button class="bb-icon" data-act="settings" title="Ayarlar">${icon('settings', 22)}</button>
      ${inVoice ? `<button class="bb-hangup" data-act="hangup">${icon('phoneOff', 20)} Bağlantıyı kes</button>` : ''}
    </div>`
}

// =====================================================================
// Sesli sahne (görüntü ızgarası)
// =====================================================================
const videoEls = new Map()
function videoFor (stream) {
  let v = videoEls.get(stream.id)
  if (!v) {
    v = document.createElement('video')
    v.autoplay = true
    v.playsInline = true
    v.muted = true
    v.srcObject = stream
    videoEls.set(stream.id, v)
  }
  return v
}

function renderStage () {
  const stage = $('#stage')
  const show = S.view === 'stage' && voice.active && voice.server === S.server
  stage.hidden = !show
  $('#chat').hidden = show || !$('#empty').hidden
  if (!show) return
  const tiles = voice.tiles()
  if (S.focusTile && !tiles.some(t => t.id === S.focusTile)) S.focusTile = null
  const used = new Set()
  const tileEl = (t, big) => {
    const p = voice.participants(voice.server, voice.channel).find(x => x.key === t.key) || {}
    const div = el(`
      <div class="tile ${t.kind} ${big ? 'big' : ''} ${voice.speaking.has(t.key) && t.kind !== 'screen' ? 'speaking' : ''}" data-speak="${t.kind === 'screen' ? '' : t.key}" data-tile="${t.id}">
        <div class="tile-media"></div>
        <div class="tile-label">
          ${t.kind === 'screen' ? '<span class="live">CANLI</span>' : ''}
          <span>${esc(nameOf(t.key))}${t.kind === 'screen' ? ' · Ekran' : ''}</span>
          ${t.label ? `<small>${esc(t.label)}</small>` : ''}
          ${p.deaf ? icon('headphonesOff', 15, 'red') : p.muted ? icon('micOff', 15, 'red') : ''}
        </div>
        ${t.kind !== 'avatar' ? `<button class="tile-full" data-act="tile-full" title="Tam ekran">${icon('maximize', 16)}</button>` : ''}
      </div>`)
    const media = $('.tile-media', div)
    if (t.kind === 'avatar') {
      media.innerHTML = `<div class="tile-av">${avatar(t.key, big ? 120 : 84)}</div>${t.conn && t.conn !== 'connected' ? `<div class="tile-conn">${t.conn === 'failed' ? 'Bağlantı kurulamadı' : 'Bağlanıyor…'}</div>` : ''}`
      const pr = profileOf(t.key)
      if (pr?.banner && safeImg(pr.banner)) div.style.setProperty('--tile-bg', `url(${pr.banner})`)
    } else if (t.stream) {
      const v = videoFor(t.stream)
      used.add(t.stream.id)
      if (t.self && t.kind === 'cam') v.classList.add('mirror')
      media.appendChild(v)
      v.play().catch(() => {})
    } else {
      media.innerHTML = '<div class="tile-conn"><div class="spinner small"></div> Görüntü bekleniyor…</div>'
    }
    return div
  }

  stage.innerHTML = ''
  const focus = S.focusTile && tiles.find(t => t.id === S.focusTile)
  if (focus) {
    const wrap = el('<div class="stage-focus"><div class="focus-main"></div><div class="focus-strip"></div></div>')
    $('.focus-main', wrap).appendChild(tileEl(focus, true))
    for (const t of tiles) if (t !== focus) $('.focus-strip', wrap).appendChild(tileEl(t, false))
    stage.appendChild(wrap)
  } else {
    const grid = el(`<div class="stage-grid n${Math.min(tiles.length, 9)}"></div>`)
    for (const t of tiles) grid.appendChild(tileEl(t, false))
    stage.appendChild(grid)
  }
  if (!tiles.length) stage.innerHTML = '<div class="empty-card"><p>Kanalda kimse yok.</p></div>'
  stage.appendChild(el(`<div class="stage-hint muted small">Bir kutuya tıklayarak odakla · çift tıklayarak tam ekran</div>`))
  for (const [id, v] of videoEls) if (!used.has(id)) { v.srcObject = null; videoEls.delete(id) }
}

// =====================================================================
// Açılır pencereler (modal) ve menüler
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
    try { const r = await a.onClick(node); if (r !== false) close() } finally { b.disabled = false }
  }))
  root.appendChild(node)
  setTimeout(() => $('input:not([type=file]):not([type=checkbox]):not([type=color]), textarea', bodyEl)?.focus(), 30)
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
  let x = align === 'right' ? r.right + 8 : align === 'left' ? r.left - pw - 8 : r.left
  let y = align === 'below' ? r.bottom + 6 : r.top
  if (align === 'above') y = r.top - ph - 8
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

// ---------- Sunucu ekle / katıl ----------
function openAddServer () {
  let icon64 = null
  const body = el(`
    <div class="add-server">
      <div class="as-col">
        <h3>Yeni sunucu oluştur</h3>
        <p class="muted small">Sunucun senin ve üyelerin bilgisayarlarında yaşar. Sahibi sensin.</p>
        <button class="icon-pick" type="button"><span>${icon('image', 26)}<small>Simge</small></span></button>
        <label>Sunucu adı<input id="as-name" maxlength="60" value="${esc((S.profile.name || 'Benim') + ' sunucusu')}"></label>
        <button class="btn primary block" id="as-create">Oluştur</button>
      </div>
      <div class="as-or">veya</div>
      <div class="as-col">
        <h3>Bir sunucuya katıl</h3>
        <p class="muted small">Arkadaşından aldığın davet kodunu yapıştır.</p>
        <label>Davet kodu<input id="as-code" placeholder="yanki://3f9a…"></label>
        <button class="btn block" id="as-join">Katıl</button>
      </div>
    </div>`)
  const mdl = openModal({ title: 'Sunucu ekle', body, wide: true })
  $('.icon-pick', body).addEventListener('click', async () => {
    icon64 = await pickImage({ w: 256, h: 256, cover: true, quality: 0.9 })
    if (icon64) $('.icon-pick', body).innerHTML = `<img src="${icon64}" alt="">`
  })
  $('#as-create', body).addEventListener('click', async () => {
    const name = $('#as-name', body).value.trim()
    if (!name) return toast('Bir ad gir.')
    const id = await api.createServer(name, icon64)
    mdl.close()
    S.servers = await api.init().then(r => r.servers)
    await selectServer(id)
    toast('Sunucu oluşturuldu. Davet kodunu sunucu menüsünden paylaşabilirsin.')
  })
  $('#as-join', body).addEventListener('click', async () => {
    const code = $('#as-code', body).value.trim()
    try {
      const id = await api.joinServer(code)
      mdl.close()
      S.servers = await api.init().then(r => r.servers)
      await selectServer(id)
    } catch (e) { toast('Geçersiz davet kodu.') }
  })
}

// ---------- Sunucu menüsü ----------
function serverMenu (anchor) {
  const m = curMeta()
  if (!m || m.pending) return
  const items = [
    { label: 'Davet kodunu kopyala', icon: 'link', onClick: () => copyText('yanki://' + m.id, 'Davet kodu kopyalandı — arkadaşına gönder!') }
  ]
  if (m.isAdmin) {
    items.push('-',
      { label: 'Kanal oluştur', icon: 'plus', onClick: () => channelModal(null, null) },
      { label: 'Kategori oluştur', icon: 'folderPlus', onClick: () => categoryModal(null) },
      { label: 'Sunucu ayarları', icon: 'settings', onClick: serverSettingsModal })
  }
  items.push('-', { label: 'Sunucudan ayrıl', icon: 'logout', danger: true, onClick: leaveServer })
  menu(items, anchor, { align: 'below' })
}

async function leaveServer () {
  const m = curMeta()
  if (!m) return
  if (m.owner === S.me && !(await confirmModal('Sunucudan ayrıl', 'Bu sunucunun sahibisin. Ayrılırsan sahiplik devredilemez ve yönetim yetkileri yalnızca mevcut yöneticilerde kalır. Emin misin?', 'Ayrıl'))) return
  if (m.owner !== S.me && !(await confirmModal('Sunucudan ayrıl', `<b>${esc(m.name || 'Sunucu')}</b> sunucusundan ayrılmak istediğine emin misin? Yerel kopyası silinecek.`, 'Ayrıl'))) return
  if (voice.server === S.server) voice.leave()
  await api.leaveServer(S.server)
}

// ---------- Kanal / kategori ----------
function channelModal (channelId, categoryId) {
  const m = curMeta()
  const ch = channelId ? m.channels.find(c => c.id === channelId) : null
  const body = el(`
    <div class="form">
      ${ch ? '' : `
      <div class="seg" role="radiogroup">
        <label><input type="radio" name="kind" value="text" checked><span>${icon('hash', 20)}<b>Metin</b><small>Mesaj, resim, YouTube</small></span></label>
        <label><input type="radio" name="kind" value="voice"><span>${icon('volume', 20)}<b>Ses</b><small>Sesli/görüntülü sohbet, ekran paylaşımı</small></span></label>
      </div>`}
      <label>Kanal adı<input id="ch-name" maxlength="50" value="${esc(ch?.name || '')}" placeholder="yeni-kanal"></label>
      <label>Konu / açıklama<input id="ch-topic" maxlength="200" value="${esc(ch?.topic || '')}" placeholder="İsteğe bağlı"></label>
      <label>Kategori<select id="ch-cat"><option value="">— Kategorisiz —</option>${m.categories.map(c => `<option value="${c.id}" ${(ch ? ch.category : categoryId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="voice-only" ${ch && ch.kind !== 'voice' ? 'hidden' : ''}>Kullanıcı sınırı (0 = sınırsız)<input id="ch-limit" type="number" min="0" max="99" value="${ch?.userLimit || 0}"></label>
    </div>`)
  const actions = []
  if (ch) actions.push({ label: 'Kanalı sil', kind: 'danger left', onClick: async () => { if (await confirmModal('Kanalı sil', `#${esc(ch.name)} kanalı herkes için silinecek.`, 'Sil')) await api.post(S.server, 'channel-update', { target: ch.id, deleted: true }) } })
  actions.push({ label: 'Vazgeç' }, {
    label: ch ? 'Kaydet' : 'Oluştur',
    kind: 'primary',
    onClick: async (node) => {
      const name = $('#ch-name', node).value.trim()
      if (!name) { toast('Kanal adı gerekli.'); return false }
      const kind = ch ? ch.kind : $('input[name=kind]:checked', node).value
      const finalName = kind === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name
      const data = { name: finalName, topic: $('#ch-topic', node).value, category: $('#ch-cat', node).value || null, userLimit: +$('#ch-limit', node).value || 0 }
      if (ch) await api.post(S.server, 'channel-update', { target: ch.id, ...data })
      else {
        const siblings = m.channels.filter(c => c.category === data.category)
        await api.post(S.server, 'channel-create', { ...data, kind, order: siblings.length ? Math.max(...siblings.map(c => c.order)) + 1 : 0 })
      }
    }
  })
  const mdl = openModal({ title: ch ? 'Kanalı düzenle' : 'Kanal oluştur', body, actions })
  $$('input[name=kind]', mdl.node).forEach(r => r.addEventListener('change', () => { $('.voice-only', mdl.node).hidden = r.value !== 'voice' || !r.checked }))
  $('.voice-only', mdl.node).hidden = !ch || ch.kind !== 'voice'
}

function categoryModal (catId) {
  const m = curMeta()
  const cat = catId ? m.categories.find(c => c.id === catId) : null
  const actions = []
  if (cat) actions.push({ label: 'Kategoriyi sil', kind: 'danger left', onClick: async () => { if (await confirmModal('Kategoriyi sil', 'Kategori silinir; içindeki kanallar kategorisiz kalır.', 'Sil')) await api.post(S.server, 'category-update', { target: cat.id, deleted: true }) } })
  actions.push({ label: 'Vazgeç' }, {
    label: cat ? 'Kaydet' : 'Oluştur',
    kind: 'primary',
    onClick: async (node) => {
      const name = $('#cat-name', node).value.trim()
      if (!name) return false
      if (cat) await api.post(S.server, 'category-update', { target: cat.id, name })
      else await api.post(S.server, 'category-create', { name, order: m.categories.length ? Math.max(...m.categories.map(c => c.order)) + 1 : 0 })
    }
  })
  openModal({ title: cat ? 'Kategoriyi düzenle' : 'Kategori oluştur', body: `<div class="form"><label>Kategori adı<input id="cat-name" maxlength="50" value="${esc(cat?.name || '')}"></label>${cat ? `<div class="row gap"><button class="btn small" id="cat-up">Yukarı taşı</button><button class="btn small" id="cat-down">Aşağı taşı</button></div>` : ''}</div>`, actions })
  if (cat) {
    const move = async (dir) => {
      const list = m.categories
      const i = list.findIndex(c => c.id === cat.id)
      const other = list[i + dir]
      if (!other) return
      await api.post(S.server, 'category-update', { target: cat.id, order: other.order })
      await api.post(S.server, 'category-update', { target: other.id, order: cat.order })
      toast('Sıralama güncellendi')
    }
    $('#cat-up').addEventListener('click', () => move(-1))
    $('#cat-down').addEventListener('click', () => move(1))
  }
}

// ---------- Sunucu ayarları ----------
function serverSettingsModal () {
  const m = curMeta()
  let iconData = m.icon
  let bannerData = m.banner
  const body = el(`
    <div class="form">
      <div class="row gap center">
        <button class="icon-pick" id="ss-icon">${iconData ? `<img src="${iconData}" alt="">` : `<span>${icon('image', 26)}<small>Simge</small></span>`}</button>
        <div class="grow">
          <label>Sunucu adı<input id="ss-name" maxlength="60" value="${esc(m.name)}"></label>
        </div>
      </div>
      <label>Açıklama<textarea id="ss-desc" maxlength="300" rows="3">${esc(m.description || '')}</textarea></label>
      <div class="banner-pick" id="ss-banner" style="${bannerData ? `background-image:url(${bannerData})` : ''}"><span>${icon('image', 18)} Sunucu bannerı (960×320)</span></div>
      ${bannerData ? '<button class="btn small" id="ss-banner-rm">Bannerı kaldır</button>' : ''}
      <h4>Davet kodu</h4>
      <div class="invite-box"><code>yanki://${m.id}</code><button class="btn small" id="ss-copy">${icon('copy', 15)} Kopyala</button></div>
      ${m.banned.length ? `<h4>Yasaklılar</h4>${m.banned.map(b => `<div class="ban-row"><span>${esc(b.profile?.name || b.key.slice(0, 10))}</span><button class="btn small" data-unban="${b.key}">Yasağı kaldır</button></div>`).join('')}` : ''}
    </div>`)
  const mdl = openModal({
    title: 'Sunucu ayarları',
    body,
    actions: [{ label: 'Vazgeç' }, {
      label: 'Kaydet',
      kind: 'primary',
      onClick: async (node) => {
        await api.post(S.server, 'server-update', { name: $('#ss-name', node).value, description: $('#ss-desc', node).value, icon: iconData, banner: bannerData })
      }
    }]
  })
  $('#ss-icon', body).addEventListener('click', async () => { const d = await pickImage({ w: 256, h: 256, cover: true }); if (d) { iconData = d; $('#ss-icon', body).innerHTML = `<img src="${d}" alt="">` } })
  $('#ss-banner', body).addEventListener('click', async () => { const d = await pickImage({ w: 960, h: 320, cover: true, quality: 0.85 }); if (d) { bannerData = d; $('#ss-banner', body).style.backgroundImage = `url(${d})` } })
  $('#ss-banner-rm', body)?.addEventListener('click', () => { bannerData = null; $('#ss-banner', body).style.backgroundImage = '' })
  $('#ss-copy', body).addEventListener('click', () => copyText('yanki://' + m.id, 'Davet kodu kopyalandı'))
  $$('[data-unban]', body).forEach(b => b.addEventListener('click', async () => { await api.post(S.server, 'unban', { user: b.dataset.unban }); b.closest('.ban-row').remove() }))
  void mdl
}

// ---------- Profil kartı ----------
function openProfileCard (key, anchor) {
  const m = curMeta()
  const mem = member(key)
  const p = profileOf(key) || {}
  const banner = safeImg(p.banner)
  const isMe = key === S.me
  const inRoom = voice.active && voice.participants(voice.server, voice.channel).some(x => x.key === key) && !isMe
  const canMod = m?.isAdmin && !isMe && !mem?.owner && (!mem?.admin || m.owner === S.me)
  const html = `
    <div class="pcard" style="--accent:${p.color || hashColor(key)}">
      <div class="pc-banner" style="${banner ? `background-image:url(${banner})` : ''}"></div>
      <div class="pc-av">${avatar(key, 84)}<span class="status-dot big ${mem?.online || isMe ? 'on' : ''}"></span></div>
      <div class="pc-body">
        <div class="pc-name">${esc(nameOf(key))}${p.pronouns ? `<small> · ${esc(p.pronouns)}</small>` : ''}</div>
        <div class="pc-key" title="Kimlik anahtarı">${key.slice(0, 8)}…${key.slice(-6)}</div>
        ${p.status ? `<div class="pc-status">${esc(p.status)}</div>` : ''}
        <div class="pc-roles">
          ${mem?.owner ? `<span class="role gold">${icon('crown', 13)} Sahip</span>` : ''}
          ${mem?.admin && !mem?.owner ? `<span class="role blue">${icon('shield', 13)} Yönetici</span>` : ''}
          ${!mem?.admin ? '<span class="role">Üye</span>' : ''}
        </div>
        ${p.bio ? `<h5>Hakkımda</h5><div class="pc-bio">${md(p.bio)}</div>` : ''}
        ${mem?.joinedAt ? `<h5>Üyelik</h5><div class="pc-since">${new Date(mem.joinedAt).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })}</div>` : ''}
        ${inRoom ? `<h5>Ses düzeyi</h5><input type="range" min="0" max="100" value="${Math.round((voice.volumes[key] ?? 1) * 100)}" id="pc-vol">` : ''}
        <div class="pc-actions">
          ${isMe ? `<button class="btn small primary" id="pc-edit">${icon('edit', 15)} Profili düzenle</button>` : `<button class="btn small" id="pc-mention">@ Bahset</button>`}
          ${m?.owner === S.me && !isMe ? `<button class="btn small" id="pc-admin">${mem?.admin ? 'Yöneticiliği al' : 'Yönetici yap'}</button>` : ''}
          ${canMod ? `<button class="btn small danger-ghost" id="pc-kick">${icon('userX', 15)} At</button><button class="btn small danger-ghost" id="pc-ban">${icon('ban', 15)} Yasakla</button>` : ''}
        </div>
      </div>
    </div>`
  const align = anchor.closest('#members') ? 'left' : anchor.closest('#bottombar') ? 'above' : 'right'
  const pop = openPopup(html, anchor, { align, cls: 'pcard-pop' })
  $('#pc-edit', pop)?.addEventListener('click', () => { closePopup(); openSettings('profile') })
  $('#pc-mention', pop)?.addEventListener('click', () => { closePopup(); const t = $('#input'); t.value += (t.value && !t.value.endsWith(' ') ? ' ' : '') + '@' + nameOf(key) + ' '; t.focus() })
  $('#pc-vol', pop)?.addEventListener('input', (e) => voice.setUserVolume(key, e.target.value / 100))
  $('#pc-admin', pop)?.addEventListener('click', async () => { closePopup(); await api.post(S.server, 'role-set', { user: key, role: mem?.admin ? 'member' : 'admin' }) })
  $('#pc-kick', pop)?.addEventListener('click', async () => { closePopup(); if (await confirmModal('Üyeyi at', `${esc(nameOf(key))} sunucudan atılacak (davet koduyla yeniden katılabilir).`, 'At')) await api.post(S.server, 'kick', { user: key }) })
  $('#pc-ban', pop)?.addEventListener('click', async () => { closePopup(); if (await confirmModal('Üyeyi yasakla', `${esc(nameOf(key))} kalıcı olarak yasaklanacak; mesajları ve bağlantıları reddedilecek.`, 'Yasakla')) await api.post(S.server, 'ban', { user: key }) })
}

// ---------- Emoji seçici ----------
const EMOJI = '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😎 🤓 🧐 🤔 🤨 😐 😑 😶 🙄 😏 😬 😮‍💨 😴 😌 🤤 😷 🤒 🥵 🥶 🥴 😵 🤯 🤠 🥳 😢 😭 😤 😡 🤬 😱 😨 😰 😓 🤗 🤭 🫡 🤫 👍 👎 👏 🙌 🙏 💪 👀 🫶 🤝 ✌️ 🤞 👋 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 🔥 ✨ ⭐ 🎉 🎊 🎮 🕹️ 🏆 ⚽ 🏀 🎵 🎧 📷 🍕 🍔 🍺 ☕ 💯 ✅ ❌ ⚠️ 💀 👻 🤖 👑 🚀 🌙 ☀️ 🌈'.split(' ')
function emojiPicker (anchor, onPick) {
  const p = openPopup(`<div class="emoji-grid">${EMOJI.map(e => `<button data-e="${e}">${e}</button>`).join('')}</div>`, anchor, { align: 'above', cls: 'emoji-pop' })
  p.addEventListener('click', (e) => { const b = e.target.closest('[data-e]'); if (b) { onPick(b.dataset.e); if (!e.shiftKey) closePopup() } })
}

// ---------- Ekran paylaşımı seçici ----------
async function openScreenPicker () {
  if (S.platform === 'darwin') {
    const ok = await api.mediaAccess('screen')
    if (!ok) toast('macOS: Sistem Ayarları › Gizlilik ve Güvenlik › Ekran Kaydı bölümünden Yankı\'ya izin ver ve uygulamayı yeniden başlat.', 7000)
  }
  let sources = []
  try { sources = await api.desktopSources() } catch { toast('Ekran kaynakları alınamadı.'); return }
  let tab = 'screen'
  let chosen = null
  const body = el(`
    <div class="picker">
      <div class="tabs"><button data-tab="screen" class="on">Ekranlar</button><button data-tab="window">Pencereler</button></div>
      <div class="src-grid"></div>
      <div class="picker-opts">
        <label>Kalite<select id="sp-q">${Object.entries(SCREEN_QUALITY).map(([k, q]) => `<option value="${k}" ${settings.screenQuality === k ? 'selected' : ''}>${q.label}</option>`).join('')}</select></label>
        ${S.platform === 'win32' ? `<label class="check"><input type="checkbox" id="sp-audio" ${settings.screenAudio ? 'checked' : ''}> Sistem sesini de paylaş</label>` : '<span class="muted small">macOS\'ta sistem sesi paylaşımı desteklenmez.</span>'}
      </div>
    </div>`)
  const grid = $('.src-grid', body)
  const draw = () => {
    const list = sources.filter(s => s.kind === tab)
    grid.innerHTML = list.length
      ? list.map(s => `<button class="src ${chosen === s.id ? 'on' : ''}" data-id="${esc(s.id)}">${s.thumb ? `<img src="${s.thumb}" alt="">` : '<div class="src-ph"></div>'}<span>${s.icon ? `<img class="src-icon" src="${s.icon}" alt="">` : ''}${esc(s.name)}</span></button>`).join('')
      : '<div class="muted pad">Kaynak bulunamadı.</div>'
  }
  draw()
  $$('.tabs button', body).forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; $$('.tabs button', body).forEach(x => x.classList.toggle('on', x === b)); draw() }))
  grid.addEventListener('click', (e) => { const b = e.target.closest('.src'); if (b) { chosen = b.dataset.id; draw() } })
  grid.addEventListener('dblclick', (e) => { if (e.target.closest('.src')) $('.modal-foot .primary').click() })
  openModal({
    title: 'Ekranını paylaş',
    body,
    wide: true,
    actions: [{ label: 'Vazgeç' }, {
      label: 'Yayına başla',
      kind: 'primary',
      onClick: async (node) => {
        if (!chosen) { toast('Bir ekran veya pencere seç.'); return false }
        settings.screenQuality = $('#sp-q', node).value
        settings.screenAudio = !!$('#sp-audio', node)?.checked
        saveSettings()
        await voice.startScreen(chosen, settings.screenQuality, settings.screenAudio && chosen.startsWith('screen'))
        S.view = 'stage'
        renderAll()
      }
    }]
  })
}

// ---------- Ayarlar ----------
function openProfileSetup () {
  const body = el(`
    <div class="form">
      <p class="muted">Kimliğin bu bilgisayarda oluşturulan bir şifreleme anahtarıdır — hesap, e-posta veya şifre yok. Sadece nasıl görüneceğini seç.</p>
      <label>Görünen ad<input id="su-name" maxlength="32" placeholder="ör. ReaLPoSSiBiLiTY"></label>
    </div>`)
  openModal({
    title: 'Yankı\'ya hoş geldin',
    body,
    actions: [{
      label: 'Başla',
      kind: 'primary',
      onClick: async (node) => {
        const name = $('#su-name', node).value.trim()
        if (!name) { toast('Bir ad gir.'); return false }
        S.profile = await api.setProfile({ ...S.profile, name })
        renderAll()
      }
    }]
  })
}

async function openSettings (tab = 'profile') {
  const draft = { ...S.profile }
  const tabs = [['profile', 'Profilim'], ['av', 'Ses ve Görüntü'], ['screen', 'Ekran Paylaşımı'], ['notify', 'Bildirimler'], ['net', 'Ağ ve Gizlilik'], ['about', 'Hakkında']]
  const body = el(`<div class="settings"><nav>${tabs.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</nav><div class="st-pane"></div></div>`)
  let testStream = null
  let testRaf = 0
  const stopTest = () => { testStream?.getTracks().forEach(t => t.stop()); testStream = null; cancelAnimationFrame(testRaf) }
  const mdl = openModal({ title: 'Ayarlar', body, wide: true, cls: 'settings-modal', onClose: stopTest })
  const pane = $('.st-pane', body)

  const show = async (k) => {
    stopTest()
    $$('nav button', body).forEach(b => b.classList.toggle('on', b.dataset.tab === k))
    if (k === 'profile') {
      const preview = () => {
        const pv = $('.pv', pane)
        pv.style.setProperty('--accent', draft.color || hashColor(S.me))
        $('.pv-banner', pane).style.backgroundImage = draft.banner ? `url(${draft.banner})` : ''
        $('.pv-av', pane).innerHTML = draft.avatar ? `<img class="av" src="${draft.avatar}" style="width:80px;height:80px">` : `<div class="av av-fallback" style="width:80px;height:80px;background:${hashColor(S.me)};font-size:32px">${esc(initials(draft.name))}</div>`
        $('.pv-name', pane).textContent = draft.name || 'Adın'
        $('.pv-status', pane).textContent = draft.status || ''
        $('.pv-bio', pane).innerHTML = md(draft.bio || '')
      }
      pane.innerHTML = `
        <div class="profile-edit">
          <div class="form">
            <label>Görünen ad<input data-f="name" maxlength="32" value="${esc(draft.name)}"></label>
            <label>Durum mesajı<input data-f="status" maxlength="80" value="${esc(draft.status || '')}" placeholder="ör. Valheim oynuyor 🎮"></label>
            <label>Zamirler<input data-f="pronouns" maxlength="30" value="${esc(draft.pronouns || '')}" placeholder="İsteğe bağlı"></label>
            <label>Hakkımda<textarea data-f="bio" maxlength="600" rows="4" placeholder="Kendinden bahset… (markdown desteklenir)">${esc(draft.bio || '')}</textarea></label>
            <div class="row gap wrap">
              <button class="btn small" id="pe-av">${icon('image', 15)} Avatar yükle</button>
              <button class="btn small" id="pe-av-rm">Avatarı kaldır</button>
              <button class="btn small" id="pe-bn">${icon('image', 15)} Banner yükle</button>
              <button class="btn small" id="pe-bn-rm">Bannerı kaldır</button>
            </div>
            <label class="row gap center">Profil rengi <input type="color" data-f="color" value="${draft.color || '#7c5cff'}"></label>
            <div class="row gap"><button class="btn primary" id="pe-save">Değişiklikleri kaydet</button></div>
          </div>
          <div class="pv">
            <div class="pv-banner"></div>
            <div class="pv-av"></div>
            <div class="pv-body"><div class="pv-name"></div><div class="pv-status"></div><div class="pv-bio"></div></div>
          </div>
        </div>`
      preview()
      $$('[data-f]', pane).forEach(i => i.addEventListener('input', () => { draft[i.dataset.f] = i.value; preview() }))
      $('#pe-av', pane).addEventListener('click', async () => { const d = await pickImage({ w: 256, h: 256, cover: true, quality: 0.88 }); if (d) { draft.avatar = d; preview() } })
      $('#pe-av-rm', pane).addEventListener('click', () => { draft.avatar = null; preview() })
      $('#pe-bn', pane).addEventListener('click', async () => { const d = await pickImage({ w: 960, h: 320, cover: true, quality: 0.85 }); if (d) { draft.banner = d; preview() } })
      $('#pe-bn-rm', pane).addEventListener('click', () => { draft.banner = null; preview() })
      $('#pe-save', pane).addEventListener('click', async () => {
        if (!draft.name.trim()) return toast('Ad boş olamaz.')
        S.profile = await api.setProfile(draft)
        toast('Profil kaydedildi ve tüm sunuculara yayıldı.')
        renderAll()
      })
    } else if (k === 'av') {
      let devices = []
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
        devices = await navigator.mediaDevices.enumerateDevices()
        tmp?.getTracks().forEach(t => t.stop())
      } catch {}
      const opts = (kind, sel) => devices.filter(d => d.kind === kind).map(d => `<option value="${esc(d.deviceId)}" ${d.deviceId === sel ? 'selected' : ''}>${esc(d.label || d.kind)}</option>`).join('')
      pane.innerHTML = `
        <div class="form">
          <h4>Ses</h4>
          <div class="row gap">
            <label class="grow">Giriş aygıtı<select id="av-in"><option value="default">Varsayılan</option>${opts('audioinput', settings.inputDevice)}</select></label>
            <label class="grow">Çıkış aygıtı<select id="av-out"><option value="default">Varsayılan</option>${opts('audiooutput', settings.outputDevice)}</select></label>
          </div>
          <div class="mic-test"><button class="btn small" id="av-test">Mikrofonu test et</button><div class="meter"><i></i></div></div>
          <label class="check"><input type="checkbox" id="av-ns" ${settings.noiseSuppression ? 'checked' : ''}> Gürültü bastırma</label>
          <label class="check"><input type="checkbox" id="av-ec" ${settings.echoCancellation ? 'checked' : ''}> Yankı engelleme</label>
          <label class="check"><input type="checkbox" id="av-ag" ${settings.autoGain ? 'checked' : ''}> Otomatik kazanç kontrolü</label>
          <h4>Görüntü</h4>
          <label>Kamera<select id="av-cam"><option value="">Varsayılan</option>${opts('videoinput', settings.cameraDevice)}</select></label>
          <div class="cam-test"><button class="btn small" id="av-camtest">Kamerayı önizle</button><video id="av-video" autoplay muted playsinline></video></div>
        </div>`
      const persist = async (reMic) => { saveSettings(); if (reMic && voice.mic) await voice.setInputDevice().catch(() => toast('Aygıt değiştirilemedi')) }
      $('#av-in', pane).addEventListener('change', e => { settings.inputDevice = e.target.value; persist(true) })
      $('#av-out', pane).addEventListener('change', e => { settings.outputDevice = e.target.value; saveSettings(); voice.setOutputDevice() })
      $('#av-cam', pane).addEventListener('change', e => { settings.cameraDevice = e.target.value; saveSettings() })
      $('#av-ns', pane).addEventListener('change', e => { settings.noiseSuppression = e.target.checked; persist(true) })
      $('#av-ec', pane).addEventListener('change', e => { settings.echoCancellation = e.target.checked; persist(true) })
      $('#av-ag', pane).addEventListener('change', e => { settings.autoGain = e.target.checked; persist(true) })
      $('#av-test', pane).addEventListener('click', async () => {
        if (testStream) { stopTest(); $('.meter i', pane).style.width = '0'; return }
        testStream = await navigator.mediaDevices.getUserMedia({ audio: voice._audioConstraints() }).catch(() => null)
        if (!testStream) return toast('Mikrofon açılamadı')
        const ctx = new AudioContext()
        const an = ctx.createAnalyser()
        ctx.createMediaStreamSource(testStream).connect(an)
        const buf = new Uint8Array(an.fftSize)
        const loop = () => {
          an.getByteTimeDomainData(buf)
          let s = 0; for (const v of buf) { const x = (v - 128) / 128; s += x * x }
          const meter = $('.meter i', pane)
          if (meter) meter.style.width = Math.min(100, Math.sqrt(s / buf.length) * 400) + '%'
          testRaf = requestAnimationFrame(loop)
        }
        loop()
      })
      $('#av-camtest', pane).addEventListener('click', async () => {
        if (testStream) { stopTest(); $('#av-video', pane).srcObject = null; return }
        await api.mediaAccess('camera')
        testStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: settings.cameraDevice ? { exact: settings.cameraDevice } : undefined } }).catch(() => null)
        if (!testStream) return toast('Kamera açılamadı')
        $('#av-video', pane).srcObject = testStream
      })
    } else if (k === 'screen') {
      pane.innerHTML = `
        <div class="form">
          <label>Varsayılan kalite<select id="sc-q">${Object.entries(SCREEN_QUALITY).map(([key, q]) => `<option value="${key}" ${settings.screenQuality === key ? 'selected' : ''}>${q.label} — en fazla ${(q.bitrate / 1e6).toFixed(0)} Mbps</option>`).join('')}</select></label>
          <p class="muted small">Ekran paylaşımı eşler arası doğrudan gönderilir. Her izleyici için ayrı bir akış yüklenir; 1080p60'ta 3 izleyici ≈ 27 Mbps yükleme hızı gerektirir. Bağlantın yavaşsa 1080p30 veya 720p seç.</p>
          ${S.platform === 'win32' ? `<label class="check"><input type="checkbox" id="sc-audio" ${settings.screenAudio ? 'checked' : ''}> Tüm ekran paylaşılırken sistem sesini de paylaş</label>` : '<p class="muted small">macOS: İlk paylaşımda Sistem Ayarları › Gizlilik ve Güvenlik › Ekran Kaydı izni gerekir.</p>'}
        </div>`
      $('#sc-q', pane).addEventListener('change', e => { settings.screenQuality = e.target.value; saveSettings() })
      $('#sc-audio', pane)?.addEventListener('change', e => { settings.screenAudio = e.target.checked; saveSettings() })
    } else if (k === 'notify') {
      pane.innerHTML = `
        <div class="form">
          <label>Masaüstü bildirimleri<select id="nt-mode">
            <option value="all" ${settings.notify === 'all' ? 'selected' : ''}>Tüm mesajlar</option>
            <option value="mentions" ${settings.notify === 'mentions' ? 'selected' : ''}>Yalnızca benden bahsedildiğinde (@ad, @herkes)</option>
            <option value="none" ${settings.notify === 'none' ? 'selected' : ''}>Kapalı</option>
          </select></label>
          <label class="check"><input type="checkbox" id="nt-sound" ${settings.sounds ? 'checked' : ''}> Mesaj sesi çal</label>
        </div>`
      $('#nt-mode', pane).addEventListener('change', e => { settings.notify = e.target.value; saveSettings() })
      $('#nt-sound', pane).addEventListener('change', e => { settings.sounds = e.target.checked; saveSettings() })
    } else if (k === 'net') {
      pane.innerHTML = `
        <div class="form">
          <h4>Kimliğin</h4>
          <div class="invite-box"><code>${S.me}</code><button class="btn small" id="net-copy">${icon('copy', 15)}</button></div>
          <p class="muted small">Bu ed25519 açık anahtarıdır. Gizli anahtar yalnızca bu bilgisayarda saklanır; tüm mesajların onunla imzalanır.</p>
          <h4>Bağlantı önizlemeleri</h4>
          <label class="check"><input type="checkbox" id="net-prev" ${settings.linkPreviews ? 'checked' : ''}> Paylaşılan bağlantıların başlık/görsel önizlemesini getir</label>
          <p class="muted small">Önizleme, bağlantıyı senin bilgisayarının indirmesiyle oluşturulur (IP adresin o siteye görünür).</p>
          <h4>TURN sunucusu (isteğe bağlı)</h4>
          <p class="muted small">Çok katı NAT/kurumsal güvenlik duvarı arkasındaki kullanıcılar arasında ses/görüntü kurulamazsa kendi TURN aktarıcını (ör. coturn) girebilirsin. Normalde gerekmez.</p>
          <label>TURN adresi<input id="net-turn" placeholder="turn:alan.adi:3478" value="${esc(settings.turnUrl)}"></label>
          <div class="row gap"><label class="grow">Kullanıcı<input id="net-tu" value="${esc(settings.turnUser)}"></label><label class="grow">Parola<input id="net-tp" type="password" value="${esc(settings.turnPass)}"></label></div>
          <button class="btn small primary" id="net-save">Kaydet</button>
        </div>`
      $('#net-copy', pane).addEventListener('click', () => copyText(S.me))
      $('#net-prev', pane).addEventListener('change', e => { settings.linkPreviews = e.target.checked; saveSettings(); renderMessages() })
      $('#net-save', pane).addEventListener('click', () => { settings.turnUrl = $('#net-turn', pane).value.trim(); settings.turnUser = $('#net-tu', pane).value; settings.turnPass = $('#net-tp', pane).value; saveSettings(); toast('Kaydedildi — sonraki ses bağlantısında geçerli.') })
    } else if (k === 'about') {
      pane.innerHTML = `
        <div class="about">
          <div class="empty-logo">${icon('volume', 36)}</div>
          <h2>Yankı</h2>
          <p>Merkezi sunucusuz, eşler arası (P2P) topluluk ve haberleşme uygulaması.</p>
          <ul class="muted small">
            <li>Eş keşfi: Hyperswarm DHT + NAT delme (UDP hole-punching)</li>
            <li>Taşıma: Noise protokolüyle uçtan uca şifreli akışlar</li>
            <li>Veri: ed25519 imzalı, değişmez olay günlüğü; her üyede tam kopya</li>
            <li>Ses/Görüntü/Ekran: WebRTC (DTLS-SRTP), mesh topoloji</li>
          </ul>
          <p class="muted small">Klavye: Ctrl/⌘+Shift+M sustur · Ctrl/⌘+Shift+D sağırlaştır · Ctrl/⌘+K kanal ara · Esc iptal</p>
        </div>`
    }
  }
  $$('nav button', body).forEach(b => b.addEventListener('click', () => show(b.dataset.tab)))
  show(tab)
  void mdl
}

// ---------- Hızlı kanal geçişi (Ctrl+K) ----------
function quickSwitcher () {
  const all = []
  for (const s of S.servers) {
    const m = S.meta.get(s.id)
    if (!m || m.pending) continue
    for (const c of m.channels) all.push({ s, c })
  }
  const body = el(`<div class="qs"><input id="qs-in" placeholder="Kanal veya sunucu ara…"><div class="qs-list"></div></div>`)
  const mdl = openModal({ body, cls: 'qs-modal' })
  let idx = 0
  let found = []
  const draw = () => {
    const q = $('#qs-in', body).value.toLowerCase()
    found = all.filter(x => !q || x.c.name.toLowerCase().includes(q) || x.s.name.toLowerCase().includes(q)).slice(0, 12)
    idx = Math.min(idx, Math.max(0, found.length - 1))
    $('.qs-list', body).innerHTML = found.map((x, i) => `<button class="qs-item ${i === idx ? 'on' : ''}" data-i="${i}">${icon(x.c.kind === 'voice' ? 'volume' : 'hash', 16)} ${esc(x.c.name)} <small>${esc(x.s.name)}</small></button>`).join('')
  }
  const go = async (x) => { if (!x) return; mdl.close(); if (S.server !== x.s.id) await selectServer(x.s.id); selectChannel(x.c.id) }
  $('#qs-in', body).addEventListener('input', () => { idx = 0; draw() })
  $('#qs-in', body).addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { idx = Math.min(found.length - 1, idx + 1); draw(); e.preventDefault() }
    if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); draw(); e.preventDefault() }
    if (e.key === 'Enter') go(found[idx])
  })
  $('.qs-list', body).addEventListener('click', (e) => { const b = e.target.closest('.qs-item'); if (b) go(found[+b.dataset.i]) })
  draw()
}

function pinsPopup (anchor) {
  const ch = curMeta()?.channels.find(c => c.id === S.channel)
  const pins = new Set(ch?.pins || [])
  const list = S.msgs.filter(x => pins.has(x.id))
  openPopup(`<div class="pins"><h4>Sabitlenmiş mesajlar</h4>${list.length ? list.map(x => `<button class="pin-item" data-act="jump" data-id="${x.id}"><b>${esc(nameOf(x.author))}</b><span>${esc(x.text.slice(0, 160) || '📷 Resim')}</span></button>`).join('') : '<p class="muted small">Bu kanalda (yüklü mesajlar arasında) sabitlenmiş mesaj yok.</p>'}</div>`, anchor, { align: 'below', cls: 'pins-pop' })
}

function lightbox (src) {
  const node = el(`<div class="lightbox"><img src="${esc(src)}" alt=""><div class="lb-actions"><button class="btn small" data-open>Tarayıcıda aç</button></div></div>`)
  node.addEventListener('click', (e) => {
    if (e.target.closest('[data-open]') && /^https?:/.test(src)) api.openExternal(src)
    node.remove()
  })
  document.body.appendChild(node)
}

// =====================================================================
// Olay bağlama
// =====================================================================
function bindStatic () {
  // Biçim düğmelerine ikon yerleştir
  const fmtIcons = { '**': 'bold', '*': 'italic', '~~': 'strike', '||': 'eye', '`': 'code' }
  $$('[data-fmt]').forEach(b => { b.innerHTML = icon(fmtIcons[b.dataset.fmt], 18) })
  $('#btn-attach').innerHTML = icon('paperclip', 19)
  $('#btn-emoji').innerHTML = icon('smile', 19)
  $('#btn-send').innerHTML = icon('send', 19)

  $$('[data-fmt]').forEach(b => b.addEventListener('click', () => wrapSelection(b.dataset.fmt)))
  $('#btn-attach').addEventListener('click', () => $('#file-input').click())
  $('#file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = '' })
  $('#btn-emoji').addEventListener('click', (e) => emojiPicker(e.currentTarget, (em) => { const t = $('#input'); t.setRangeText(em, t.selectionStart, t.selectionEnd, 'end'); t.focus() }))
  $('#btn-send').addEventListener('click', send)

  const input = $('#input')
  input.addEventListener('input', onTyping)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
    if (e.key === 'Escape') { if (S.editing) { S.editing = null; input.value = ''; autoGrow() } S.reply = null; renderComposerState(); renderMessages() }
    if (e.key === 'ArrowUp' && !input.value) {
      const mine = [...S.msgs].reverse().find(x => x.author === S.me && x.text)
      if (mine) { e.preventDefault(); startEdit(mine.id) }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrapSelection('**') }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); wrapSelection('*') }
  })
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'))
    if (files.length) { e.preventDefault(); addFiles(files) }
  })

  // Sürükle-bırak
  let dragDepth = 0
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files') && S.channel) { dragDepth++; $('#drop-overlay').hidden = false } })
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true } })
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    dragDepth = 0
    $('#drop-overlay').hidden = true
    if (S.channel && e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files])
  })

  // Eski mesajları yükle
  $('#messages').addEventListener('scroll', async (e) => {
    const box = e.target
    box._stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60
    if (box.scrollTop < 40 && S.msgs.length >= S.limit && !S._loadingOlder && !S.search) {
      S._loadingOlder = true
      S.limit += 100
      S._keepFromTop = true
      await loadMessages()
      S._loadingOlder = false
    }
  })

  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') { S.search = e.target.value; renderMessages() }
  })

  // Genel tıklama yönlendirmesi
  document.addEventListener('click', onClick)
  document.addEventListener('dblclick', (e) => {
    const t = e.target.closest('.tile')
    if (t) { const v = $('video', t); (v || t).requestFullscreen?.() }
  })
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.popup') && !e.target.closest('[data-act]') && !e.target.closest('#btn-emoji')) closePopup()
  })
  document.addEventListener('contextmenu', onContext)

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); voice.toggleMute() }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); voice.toggleDeafen() }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); quickSwitcher() }
    if (e.key === 'Escape') closePopup()
  })
  window.addEventListener('focus', markRead)
}

function startEdit (id) {
  const msg = S.msgs.find(x => x.id === id)
  if (!msg) return
  S.editing = id
  S.reply = null
  const t = $('#input')
  t.value = msg.text
  autoGrow()
  t.focus()
  renderComposerState()
  renderMessages()
}

async function onClick (e) {
  const a = e.target.closest('[data-act]')
  if (!a) {
    const tile = e.target.closest('.tile')
    if (tile && !e.target.closest('button')) { S.focusTile = S.focusTile === tile.dataset.tile ? null : tile.dataset.tile; renderStage() }
    return
  }
  const act = a.dataset.act
  const id = a.dataset.id
  switch (act) {
    case 'server': if (id !== S.server) await selectServer(id); break
    case 'add-server': case 'create-server': case 'join-server': openAddServer(); break
    case 'leave-server': leaveServer(); break
    case 'server-menu': serverMenu(a); break
    case 'toggle-cat': S.collapsed[id] = !S.collapsed[id]; save('collapsed', S.collapsed); renderSidebar(); break
    case 'channel': if (!e.target.closest('.ch-edit')) await selectChannel(id); break
    case 'new-channel': e.stopPropagation(); channelModal(null, a.dataset.cat); break
    case 'edit-channel': e.stopPropagation(); channelModal(id); break
    case 'edit-cat': categoryModal(id); break
    case 'user': e.stopPropagation(); openProfileCard(a.dataset.key, a); break
    case 'my-profile': openProfileCard(S.me, a); break
    case 'settings': openSettings('profile'); break
    case 'toggle-members': S.showMembers = !S.showMembers; save('showMembers', S.showMembers); renderMembers(); renderHeader(); break
    case 'toggle-view':
      if (voice.server !== S.server && voice.active) { await selectServer(voice.server) }
      S.view = S.view === 'stage' ? 'chat' : 'stage'
      renderAll()
      if (S.view === 'chat') { S._scrollBottomNext = true; renderMessages(true) }
      break
    case 'goto-voice':
      if (voice.server !== S.server) await selectServer(voice.server)
      S.view = 'stage'; renderAll(); break
    case 'mute': voice.toggleMute(); break
    case 'deafen': voice.toggleDeafen(); break
    case 'camera': voice.toggleCamera(); break
    case 'screen': if (voice.screen) voice.stopScreen(); else openScreenPicker(); break
    case 'hangup': voice.leave(); S.view = 'chat'; S.focusTile = null; renderAll(); break
    case 'tile-full': { const t = a.closest('.tile'); ($('video', t) || t).requestFullscreen?.(); break }
    case 'pins': pinsPopup(a); break
    case 'open-link': e.preventDefault(); api.openExternal(a.dataset.url); break
    case 'spoiler': a.classList.add('revealed'); break
    case 'lightbox': lightbox(a.getAttribute('src')); break
    case 'yt-play': {
      const vid = a.dataset.yt
      a.outerHTML = `<div class="embed yt playing"><iframe src="https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="YouTube"></iframe></div>`
      break
    }
    case 'reply': S.reply = id; S.editing = null; renderComposerState(); $('#input').focus(); break
    case 'cancel-reply': S.reply = null; renderComposerState(); break
    case 'cancel-edit': S.editing = null; $('#input').value = ''; autoGrow(); renderComposerState(); renderMessages(); break
    case 'edit': startEdit(id); break
    case 'copy': { const msg = S.msgs.find(x => x.id === id); if (msg) copyText(msg.text); break }
    case 'delete':
      if (e.shiftKey || await confirmModal('Mesajı sil', 'Bu mesaj herkes için silinecek. (İpucu: Shift+tık ile onaysız sil)', 'Sil')) await api.post(S.server, 'message-delete', { target: id })
      break
    case 'pin': {
      const ch = curMeta()?.channels.find(c => c.id === S.channel)
      await api.post(S.server, 'pin', { target: id, on: !(ch?.pins || []).includes(id) })
      break
    }
    case 'react': {
      const msg = S.msgs.find(x => x.id === id)
      const on = !(msg?.reactions?.[a.dataset.emoji] || []).includes(S.me)
      await api.post(S.server, 'reaction', { target: id, emoji: a.dataset.emoji, on })
      break
    }
    case 'react-pick': emojiPicker(a, (em) => { const msg = S.msgs.find(x => x.id === id); const on = !(msg?.reactions?.[em] || []).includes(S.me); api.post(S.server, 'reaction', { target: id, emoji: em, on }) }); break
    case 'jump': {
      closePopup()
      const node = $(`.msg[data-id="${CSS.escape(id)}"]`)
      if (node) { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1600) } else toast('Mesaj yüklü değil.')
      break
    }
    case 'remove-att': S.attachments.splice(+a.dataset.i, 1); renderComposerState(); break
  }
}

function onContext (e) {
  const msgNode = e.target.closest('.msg')
  const ch = e.target.closest('.ch')
  const srv = e.target.closest('.rail-item[data-id]')
  if (msgNode) {
    e.preventDefault()
    const id = msgNode.dataset.id
    const msg = S.msgs.find(x => x.id === id)
    if (!msg) return
    const items = [
      { label: 'Yanıtla', icon: 'reply', onClick: () => { S.reply = id; renderComposerState(); $('#input').focus() } },
      { label: 'Metni kopyala', icon: 'copy', onClick: () => copyText(msg.text) }
    ]
    if (msg.author === S.me) items.push({ label: 'Düzenle', icon: 'edit', onClick: () => startEdit(id) })
    if (msg.author === S.me || curMeta()?.isAdmin) items.push('-', { label: 'Sil', icon: 'trash', danger: true, onClick: () => api.post(S.server, 'message-delete', { target: id }) })
    const anchor = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }), closest: () => null }
    menu(items, anchor, { align: 'below' })
  } else if (ch && curMeta()?.isAdmin) {
    e.preventDefault()
    const anchor = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }), closest: () => null }
    menu([{ label: 'Kanalı düzenle', icon: 'settings', onClick: () => channelModal(ch.dataset.id) }], anchor, { align: 'below' })
  } else if (srv) {
    e.preventDefault()
    const anchor = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }), closest: () => null }
    menu([{ label: 'Davet kodunu kopyala', icon: 'link', onClick: () => copyText('yanki://' + srv.dataset.id, 'Davet kodu kopyalandı') }], anchor, { align: 'below' })
  }
}

init().catch(e => { console.error(e); document.body.innerHTML = `<pre style="color:#f88;padding:24px">Başlatma hatası:\n${esc(e.stack || e)}</pre>` })
