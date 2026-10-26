'use strict'
/* global icon, Voice, SCREEN_QUALITY, THEMES, applyTheme, extractPalettes, loadCustomThemeImage, currentTheme, themeImage,
   api, S, settings, saveSettings, $, $$, esc, el, load, save, debounce, toast, copyText, hashColor, initials, fmtTime, fmtDay, fmtHM, fmtDate,
   curMeta, member, cacheProfile, profileOf, nameOf, colorOf, activityOf, actText, actIcon, actLine, avatar, avatarFull, md, mentionsMe,
   YT_RE, URL_RE, IMG_URL_RE, openModal, confirmModal, closePopup, openPopup, menu, pointAnchor, fileToDataURL, imageSize, resizeImage, pickImage, GIF_LIMITS, safeImg,
   BOT_DEFS, botAvatar, botsIn, botEnabledIn, welcomeText, renderBotReply, renderPoll, renderCmdHints, handleMusicCommand, musicAdd, musicSkip, musicStop, MusicPlayer, openMusicPanel, openBotsModal, openBotCard,
   friendOf, friendStatusOf, isOnline, dmUnread, incomingCount, homeBadge, refreshDMs, renderHomeSidebar, renderHome, homeTabsHTML, activeNowHTML, dmProfileHTML, activityBlock, friendButton, renderDMComposer, friendAction, sendFriendCode, friendMoreMenu,
   throttleRaf, isLight, plainText, mentionsToNames, namesToMentions, mentionMap, closeMentions, bindMentions, addMention, clearMention, mentionCount, serverMentions, canPoll, openPollCreator,
   GROUP_ICONS, groupBadges, INVITE_REASONS, errText, openInviteModal, renderLock, openMiniDM,
   startDM, closeMiniDM, bindMiniDM, miniOnDM, groupChip, groupById, openGroupsModal, groupMenu, voiceAllowed, onUpdateAvailable, updateProgress, openUpdateModal, checkForUpdates, showWhatsNew, maybeShowWhatsNew */

// Ses arayüzü kare başına en fazla bir kez çizilir; pencere gizliyken (küçültülmüş, oyunun arkasında)
// requestAnimationFrame beklediği için hiç çizilmez, görünür olunca bir kez çizilir.
const drawVoice = throttleRaf(() => { if (S.winHidden) return; renderVoiceInSidebar(); renderVoiceCard(); renderDock(); renderStage(); renderHeader(); renderMeCard() })

// =====================================================================
// Başlatma ve olaylar
// =====================================================================
async function init () {
  await loadCustomThemeImage()
  applyTheme(settings.theme)
  const r = await api.init()
  S.me = r.me
  S.profile = r.profile
  S.servers = r.servers
  S.platform = r.platform
  S.version = r.version || ''
  S.canCreate = await api.canCreateServer?.().catch(() => false)
  document.body.classList.add('os-' + r.platform)
  api.setCloseToTray?.(settings.closeToTray !== false)

  voice = new Voice({
    api,
    me: S.me,
    settings: () => settings,
    toast,
    allowed: voiceAllowed,
    // Kare başına en fazla bir kez çizilir; pencere gizliyken requestAnimationFrame beklediği için hiç çizilmez
    onUpdate: () => { music?.sync(); drawVoice() },
    onSpeaking: (key, on) => $$(`[data-speak="${CSS.escape(key)}"]`).forEach(n => n.classList.toggle('speaking', on))
  })
  music = new MusicPlayer()

  api.on(onEvent)
  bindStatic()
  bindMentions()
  bindMiniDM()
  api.updateInfo?.().then(i => { if (i) onUpdateAvailable(i) }).catch(() => {})
  api.activityConfig(settings.activity).then(a => { S.myAct = a; renderActivitySoon() }).catch(() => {})
  api.activities?.().then(list => { for (const x of list || []) S.acts.set(x.key, { act: x.act, at: Date.now() }); renderActivitySoon() }).catch(() => {})

  maybeShowWhatsNew()
  if (!S.profile.name) openProfileSetup()
  for (const s of S.servers) refreshMeta(s.id)
  await refreshDMs()

  const last = load('lastServer', null)
  const first = S.servers.find(s => s.id === last) || S.servers[0]
  if (first && load('lastMode', 'server') !== 'home') await selectServer(first.id)
  else S.mode = first ? 'home' : 'server'
  renderAll()
}

const refreshMeta = debounce(async (serverId) => {
  const m = await api.meta(serverId)
  if (!m) return
  S.meta.set(serverId, m)
  if (!m.pending) for (const mem of m.members) cacheProfile(mem.key, mem.profile)
  if (serverId === S.server && S.mode === 'server') {
    if (!m.pending && S.channel && !m.channels.some(c => c.id === S.channel)) {
      S.channel = null
      pickDefaultChannel()
      await loadMessages()
    }
    if (!m.pending && !S.channel) { pickDefaultChannel(); if (S.channel) await loadMessages(true) }
    renderSidebar(); renderHeader(); renderMembers(); renderLayout(); renderComposerState()
  }
  if (serverId === voice?.server) { voice.recheckAccess(); renderVoiceCard(); renderDock(); music?.sync() }
  renderRail()
}, 80)

const reloadMessages = debounce(() => { if (!document.hidden && !S.winHidden) loadMessages() }, 60)
const renderActivitySoon = (() => {
  let t
  return () => {
    clearTimeout(t)
    t = setTimeout(() => {
      renderMeCard(); renderMembers(); renderVoiceInSidebar()
      if (S.mode === 'home') { renderSidebar(); renderHome(); renderHeader() }
    }, 250)
  }
})()

async function onEvent (ev) {
  switch (ev.type) {
    case 'servers':
      S.servers = ev.servers
      api.canCreateServer?.().then(v => { S.canCreate = v }).catch(() => {})
      renderLock()
      renderRail()
      if (S.server && !S.servers.some(s => s.id === S.server)) {
        S.server = null
        if (S.servers[0]) selectServer(S.servers[0].id); else { S.mode = 'home'; renderAll() }
      } else if (S.server) refreshMeta(S.server)
      break
    case 'ops': {
      refreshMeta(ev.server)
      let touchCurrent = false
      let touchMentions = false
      for (const o of ev.ops) {
        if (S.mode === 'server' && ev.server === S.server && (o.channel === S.channel || ['message-edit', 'message-delete', 'reaction', 'pin', 'profile', 'poll-vote', 'bot-config'].includes(o.type))) touchCurrent = true
        if (o.type === 'message' && o.author !== S.me) maybeNotify(ev.server, o)
        if (o.type === 'message' && o.author !== S.me && Date.now() - o.ts < 600000 && mentionsMe(o.text) && !chatVisible(ev.server, o.channel)) { addMention(ev.server + ':' + o.channel); touchMentions = true }
        if (o.type === 'message') clearTyping(ev.server + ':' + o.channel, o.author)
        if (o.type === 'music' && ev.server === voice.server) music.sync()
        if (o.type === 'profile') refreshDMs()
      }
      if (touchCurrent) reloadMessages('cur')
      if (touchMentions) { if (ev.server === S.server && S.mode === 'server') renderSidebar(); renderRail() }
      break
    }
    case 'peers':
      for (const s of ev.servers || []) refreshMeta(s)
      break
    case 'eph':
      if (ev.kind === 'voice') voice.onState(ev.server, ev.from, ev.data)
      else if (ev.kind === 'typing' && ev.data && typeof ev.data.channel === 'string') {
        setTyping(ev.server + ':' + ev.data.channel, ev.from)
      }
      break
    case 'signal':
      voice.onSignal(ev.from, ev.data)
      break
    case 'dm': {
      await refreshDMs()
      const miniSeen = ev.ops.some(o => o.type === 'dm' && o.author !== S.me) && miniOnDM(ev.peer)
      for (const o of ev.ops) {
        if (o.author === S.me) continue
        if (o.type === 'friend-request') { notifyRaw(`${nameOf(ev.peer)}`, 'Sana arkadaşlık isteği gönderdi'); if (settings.sounds) voice.sound('friend') }
        if (o.type === 'friend-accept') { notifyRaw(`${nameOf(ev.peer)}`, 'Arkadaşlık isteğini kabul etti 🎉'); if (settings.sounds) voice.sound('friend') }
        if (o.type === 'dm') {
          clearTyping('dm:' + ev.peer, ev.peer)
          const visible = (document.hasFocus() && S.mode === 'home' && S.dm === ev.peer) || miniSeen
          if (!visible && settings.notify !== 'none') { notifyRaw(nameOf(ev.peer), plainText(o.text) || (o.hasImage ? '📷 Resim' : '')); if (settings.sounds) voice.sound('message') }
        }
      }
      if (S.mode === 'home' && S.dm === ev.peer) reloadMessages('cur')
      break
    }
    case 'window':
      S.winHidden = !!ev.hidden
      if (!S.winHidden) { renderAll(); if (chatCtx()) reloadMessages('cur') }
      break
    case 'update-available':
      onUpdateAvailable(ev.info)
      break
    case 'update-progress':
      updateProgress(ev)
      break
    case 'friends':
      refreshDMs()
      break
    case 'activity':
      if (ev.from === S.me) S.myAct = ev.act
      else S.acts.set(ev.from, { act: ev.act, at: Date.now() })
      renderActivitySoon()
      break
    case 'dmtyping':
      setTyping('dm:' + ev.from, ev.from)
      break
    case 'focus':
      markRead()
      break
  }
}

function setTyping (k, who) {
  if (!S.typing.has(k)) S.typing.set(k, new Map())
  S.typing.get(k).set(who, Date.now())
  renderTyping()
}
function clearTyping (k, user) {
  S.typing.get(k)?.delete(user)
  renderTyping()
}
setInterval(() => renderTyping(), 1500)

function notifyRaw (title, body) { api.notify(title, body) }

const chatVisible = (serverId, channel) => document.hasFocus() && S.mode === 'server' && serverId === S.server && channel === S.channel && S.view === 'chat'

function maybeNotify (serverId, o) {
  const meta = S.meta.get(serverId)
  const mention = mentionsMe(o.text)
  if (chatVisible(serverId, o.channel)) return
  if (Date.now() - o.ts > 600000) return // eşitlenen eski mesajlar için bildirim yok
  if (settings.notify === 'none' || (settings.notify === 'mentions' && !mention)) return
  const ch = meta?.channels?.find(c => c.id === o.channel)
  api.notify(`${mention ? '📣 ' : ''}${nameOf(o.author)}${ch ? ' · #' + ch.name : ''}`, plainText(o.text) || (o.hasImage ? '📷 Resim' : o.locked ? '🔒 Şifreli mesaj' : ''))
  if (settings.sounds) voice.sound('message')
}

// =====================================================================
// Gezinme: sunucu, kanal, ana sayfa, özel sohbet
// =====================================================================
async function selectServer (id) {
  S.mode = 'server'
  save('lastMode', 'server')
  S.server = id
  save('lastServer', id)
  S.channel = null
  S.msgs = []
  S.search = ''
  const m = await api.meta(id)
  S.meta.set(id, m)
  if (m && !m.pending) for (const mem of m.members) cacheProfile(mem.key, mem.profile)
  pickDefaultChannel()
  if (S.view === 'stage' && voice.server !== id) S.view = 'chat'
  await loadMessages(true)
  renderAll()
}

async function goHome () {
  S.mode = 'home'
  save('lastMode', 'home')
  S.dm = null
  S.view = 'chat'
  if (S.homeTab === 'blocked') S.blocked = await api.blockedList()
  renderAll()
  refreshDMs()
}

async function openDM (key) {
  if (!key || key === S.me) return
  S.mode = 'home'
  save('lastMode', 'home')
  S.dm = key
  S.view = 'chat'
  S.reply = null
  S.editing = null
  S.limit = 100
  S.search = ''
  S.dmAllowed = await api.canDM(key).catch(() => false)
  if (!S.dms.some(d => d.key === key)) await refreshDMs()
  await loadMessages(true)
  renderAll()
  $('#input').focus()
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

// Sohbet bağlamı: sunucu kanalı ya da özel sohbet
function chatCtx () {
  if (S.mode === 'home') return S.dm ? { kind: 'dm', key: S.dm } : null
  return S.server && S.channel ? { kind: 'channel', server: S.server, channel: S.channel } : null
}
const ctxKey = () => { const c = chatCtx(); return !c ? '' : c.kind === 'dm' ? 'dm:' + c.key : c.server + ':' + c.channel }
const DM_TYPE = { message: 'dm', 'message-edit': 'dm-edit', 'message-delete': 'dm-delete', reaction: 'dm-reaction', 'poll-vote': 'poll-vote' }

async function postCtx (type, data) {
  const c = chatCtx()
  if (!c) return
  if (c.kind === 'dm') return api.dmPost(c.key, DM_TYPE[type], data)
  return api.post(c.server, type, type === 'message' ? { ...data, channel: c.channel } : data)
}

async function loadMessages (scrollBottom = false) {
  const c = chatCtx()
  if (!c) { S.msgs = []; renderMessages(); return }
  const key = ctxKey()
  const list = c.kind === 'dm' ? await api.dmMessages(c.key, { limit: S.limit }) : await api.messages(c.server, c.channel, { limit: S.limit })
  if (key !== ctxKey()) return
  S.msgs = list
  renderMessages(scrollBottom)
  markRead()
}

function markRead () {
  const c = chatCtx()
  if (!c || !document.hasFocus() || S.view !== 'chat') return
  let ts
  if (c.kind === 'dm') ts = friendOf(c.key)?.lastTs || Date.now()
  else ts = curMeta()?.channels?.find(ch => ch.id === c.channel)?.lastTs || Date.now()
  const k = ctxKey()
  if (mentionCount(k)) { clearMention(k); setTimeout(() => { renderSidebar(); renderRail() }, 30) }
  if ((S.lastRead[k] || 0) < ts) {
    S.lastRead[k] = ts
    save('lastRead', S.lastRead)
    setTimeout(() => { renderSidebar(); renderRail() }, 30)
  }
}

const isUnread = (serverId, ch) => ch.kind === 'text' && ch.lastTs && ch.lastAuthor !== S.me && ch.lastTs > (S.lastRead[serverId + ':' + ch.id] || 0)

// =====================================================================
// Render: tümü
// =====================================================================
function renderAll () {
  renderLock()
  renderRail()
  renderSidebar()
  renderHeader()
  renderLayout()
  renderMessages()
  renderMembers()
  renderVoiceCard()
  renderMeCard()
  renderDock()
  renderStage()
  renderHome()
  renderComposerState()
}

function renderLayout () {
  const m = curMeta()
  const homeFriends = S.mode === 'home' && !S.dm
  const stage = S.mode === 'server' && S.view === 'stage' && voice.active && voice.server === S.server
  let empty = ''
  if (S.mode === 'server') {
    if (!S.servers.length) empty = 'welcome'
    else if (m && m.pending) empty = 'pending'
    else if (m && !S.channel && !stage) empty = 'nochannel'
  }
  $('#home').hidden = !homeFriends
  $('#stage').hidden = !stage
  $('#chat').hidden = homeFriends || stage || !!empty
  const e = $('#empty')
  e.hidden = !empty
  if (empty === 'welcome') {
    e.innerHTML = `
      <div class="empty-card">
        <img class="hero-mark" src="assets/mark.svg" alt="">
        <img class="hero-word" src="assets/word.svg" alt="YANKI">
        <p>Merkezi sunucu yok. Topluluğun yalnızca üyelerinin bilgisayarlarında yaşar ve doğrudan, uçtan uca şifreli bağlantılarla haberleşir.</p>
        <div class="row gap center-x">
          <button class="btn primary" data-act="create-server">${icon('plus', 18)} Sunucu oluştur</button>
          <button class="btn" data-act="join-server">${icon('link', 18)} Davet koduyla katıl</button>
        </div>
      </div>`
  } else if (empty === 'pending') {
    e.innerHTML = `
      <div class="empty-card">
        <div class="echo-loader"><i></i><i></i><i></i></div>
        ${m.joinError ? `<h1>Katılamadın</h1><p>${INVITE_REASONS[m.joinError] || INVITE_REASONS.invalid} Seni davet eden kişiden yeni bir davet kodu iste.</p>` : `<h1>Eşler aranıyor…</h1>
        <p>Davetin, sunucunun çevrim içi bir üyesi tarafından doğrulanınca veriler doğrudan ondan eşitlenecek. Davet eden kişinin uygulamasının açık olduğundan emin ol.</p>`}
        <p class="muted small">Bağlı eş: ${m.peers || 0}</p>
        <button class="btn danger" data-act="leave-server">${m.joinError ? 'Kapat' : 'Vazgeç ve ayrıl'}</button>
      </div>`
  } else if (empty === 'nochannel') {
    e.innerHTML = `<div class="empty-card"><h1>Metin kanalı yok</h1><p>${m.isAdmin ? 'Kenar çubuğundan yeni bir kanal oluşturabilirsin.' : 'Bir yöneticinin kanal oluşturmasını bekle.'}</p></div>`
  }
  const showMembers = S.showMembers && ((S.mode === 'server' && m && !m.pending) || S.mode === 'home')
  $('#app').classList.toggle('no-members', !showMembers)
  $('#dock').hidden = !stage
}

// =====================================================================
// Sol: sunucu rayı
// =====================================================================
function renderRail () {
  const rail = $('#rail')
  const hb = homeBadge()
  const items = S.servers.map(s => {
    const meta = S.meta.get(s.id)
    const unread = meta && !meta.pending && meta.channels.some(c => isUnread(s.id, c))
    const icn = safeImg(s.icon)
    const inVoice = voice?.server === s.id
    const mc = serverMentions(s.id)
    return `
      <button class="rail-item ${S.mode === 'server' && s.id === S.server ? 'active' : ''} ${unread ? 'unread' : ''}" data-act="server" data-id="${s.id}" title="${esc(s.name)}">
        <span class="pill"></span>
        ${icn ? `<img src="${icn}" alt="">` : `<span class="rail-initials" style="background:${hashColor(s.id)}">${esc(initials(s.name))}</span>`}
        ${s.pending ? '<span class="rail-badge sync">…</span>' : mc ? `<span class="rail-badge">${mc > 99 ? '99+' : mc}</span>` : ''}
        ${inVoice ? `<span class="rail-voice">${icon('volume', 11)}</span>` : ''}
      </button>`
  }).join('')
  rail.innerHTML = `
    <div class="rail-top"></div>
    <button class="rail-item home ${S.mode === 'home' ? 'active' : ''}" data-act="home" title="Arkadaşlar ve özel mesajlar">
      <span class="pill"></span><img src="assets/mark.svg" alt="">${hb ? `<span class="rail-badge">${hb > 99 ? '99+' : hb}</span>` : ''}
    </button>
    <div class="rail-sep"></div>
    <div class="rail-list">${items}
      <button class="rail-item add" data-act="add-server" title="Sunucu ekle">${icon('plus', 22)}</button>
    </div>
    ${S.update ? `<button class="rail-item update" data-act="update" title="Güncelle: YANKI ${esc(S.update.version)}">${icon('download', 22)}<span class="rail-upd">Güncelle</span></button>` : ''}`
  const unreadCount = S.servers.filter(s => { const m = S.meta.get(s.id); return m && !m.pending && m.channels.some(c => isUnread(s.id, c)) }).length + hb + S.servers.reduce((n, s) => n + serverMentions(s.id), 0)
  api.badge(unreadCount)
}

// =====================================================================
// Kenar çubuğu
// =====================================================================
function renderSidebar () {
  if (S.mode === 'home') return renderHomeSidebar()
  const m = curMeta()
  const header = $('#side-head')
  const box = $('#side-body')
  header.className = ''
  if (!m) { header.innerHTML = '<img class="wordmark" src="assets/word.svg" alt="YANKI">'; header.style.backgroundImage = ''; box.innerHTML = ''; return }
  if (m.pending) {
    header.innerHTML = '<div class="sh-title">Eşitleniyor…</div>'
    header.style.backgroundImage = ''
    box.innerHTML = `<div class="muted pad small">Sunucu verisi bekleniyor. Bağlı eş: ${m.peers}</div>`
    return
  }
  const banner = safeImg(m.banner)
  header.className = banner ? 'has-banner' : ''
  header.style.backgroundImage = banner ? `linear-gradient(180deg, transparent 20%, rgba(var(--panel-rgb), .95) 100%), url(${banner})` : ''
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
    const visible = collapsed ? list.filter(c => c.id === S.channel || (voice.server === S.server && voice.channel === c.id) || isUnread(S.server, c) || mentionCount(S.server + ':' + c.id)) : list
    return `
      <div class="cat">
        ${cat ? `
          <div class="cat-head">
            <button class="cat-toggle" data-act="toggle-cat" data-id="${cat.id}">${icon(collapsed ? 'chevronRight' : 'chevronDown', 13)}<span>${esc(cat.name)}</span></button>
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
  const bots = botsIn(m, c.id)
  const mc = mentionCount(S.server + ':' + c.id)
  const gnames = (c.groups || []).map(g => groupById(m, g)?.name).filter(Boolean)
  return `
    <div class="ch ${c.kind} ${active ? 'active' : ''} ${unread ? 'unread' : ''}" data-act="channel" data-id="${c.id}" title="${esc(c.topic || c.name)}">
      <span class="ch-icon">${icon(c.kind === 'voice' ? 'volume' : 'hash', 17)}</span>
      <span class="ch-text">
        <span class="ch-name">${esc(c.name)}</span>
        ${c.topic && c.kind === 'voice' ? `<span class="ch-topic">${esc(c.topic)}</span>` : ''}
      </span>
      ${bots.size ? `<span class="ch-bots" title="Bu kanaldaki botlar: ${[...bots].map(b => BOT_DEFS[b].name).join(', ')}">${icon('bot', 13)}</span>` : ''}
      ${c.kind === 'voice' && c.userLimit ? `<span class="ch-limit">${voice.participants(S.server, c.id).length}/${c.userLimit}</span>` : ''}
      ${mc ? `<span class="ch-mention" title="Senden bahsedildi">@${mc > 9 ? '9+' : mc}</span>` : ''}
      ${c.private ? `<span class="ch-lock ${c.hasKey ? '' : 'wait'}" title="Özel kanal${gnames.length ? ': ' + esc(gnames.join(', ')) : ''}${c.hasKey ? '' : ' — şifreleme anahtarı bekleniyor'}">${icon('lock', 13)}</span>` : ''}
      ${m.isAdmin ? `<button class="mini ch-edit" data-act="edit-channel" data-id="${c.id}" title="Kanalı düzenle">${icon('settings', 14)}</button>` : ''}
    </div>
    ${c.kind === 'voice' ? `<div class="voice-users" data-voice="${c.id}"></div>` : ''}`
}

// Hem mikrofon hem kulaklık kapalıysa iki simge birden
function muteIcons (p, size = 14) {
  return (p.muted || p.deaf ? icon('micOff', size, 'red') : '') + (p.deaf ? icon('headphonesOff', size, 'red') : '')
}

function renderVoiceInSidebar () {
  const m = curMeta()
  for (const box of $$('.voice-users')) {
    const cid = box.dataset.voice
    const list = voice.participants(S.server, cid)
    const ch = m?.channels?.find(c => c.id === cid)
    box.innerHTML = list.map(p => `
      <div class="vu" data-act="user" data-key="${p.key}">
        ${avatarFull(p.key, 26)}
        <span class="vu-text">
          <span class="vu-name ${p.self ? 'self' : ''}" style="${colorOf(p.key) ? `color:${colorOf(p.key)}` : ''}">${esc(nameOf(p.key))}</span>
          ${actLine(p.key, 'tiny')}
        </span>
        <span class="vu-flags">
          ${p.screen ? `<span class="live" ${!p.self ? `data-act="watch" data-key="${p.key}" title="Yayını izle"` : ''}>CANLI</span>` : ''}
          ${p.cam ? icon('video', 14) : ''}
          ${muteIcons(p)}
        </span>
      </div>`).join('') + (ch?.music
      ? `<div class="vu bot" data-act="bot" data-id="music">${botAvatar('music', 26)}<span class="vu-text"><span class="vu-name">Müzik Çalar <span class="tag-bot">BOT</span></span><span class="actline music tiny">${icon('music', 12)}<span class="ellipsis">${esc(ch.music.title)}</span></span></span></div>`
      : '')
  }
}

// =====================================================================
// Ses kartı, kullanıcı kartı, sahne kontrol çubuğu
// =====================================================================
function voiceStatus () {
  const peers = [...voice.peers.values()]
  const bad = peers.some(p => ['failed', 'disconnected'].includes(p.pc.connectionState))
  const connecting = peers.some(p => ['new', 'connecting'].includes(p.pc.connectionState))
  return bad ? ['bad', 'Bağlantı onarılıyor…'] : connecting ? ['warn', 'Bağlanıyor…'] : ['ok', 'Bağlandı']
}

function renderVoiceCard () {
  const box = $('#voice-card')
  if (!voice.active) { box.hidden = true; box.innerHTML = ''; return }
  const vm = S.meta.get(voice.server)
  const vch = vm?.channels?.find(c => c.id === voice.channel)
  const [cls, text] = voiceStatus()
  const musicOn = botEnabledIn(voice.server, voice.channel, 'music')
  box.hidden = false
  box.innerHTML = `
    <div class="vc-top">
      <span class="vc-wave ${cls}"><i></i><i></i><i></i></span>
      <div class="vc-info">
        <span class="vc-status ${cls}">${text}</span>
        <button class="vc-chan" data-act="goto-voice">${esc(vch?.name || 'Ses')}<small> / ${esc(vm?.name || '')}</small></button>
      </div>
      <button class="ib hang" data-act="hangup" title="Bağlantıyı kes">${icon('phoneOff', 18)}</button>
    </div>
    <div class="vc-btns">
      <button class="vb ${voice.screen ? 'live' : ''}" data-act="screen" title="${voice.screen ? 'Paylaşımı durdur' : 'Ekranını paylaş (1080p)'}">${icon(voice.screen ? 'screenOff' : 'screen', 18)}</button>
      <button class="vb ${voice.cam ? 'on' : ''}" data-act="camera" title="${voice.cam ? 'Kamerayı kapat' : 'Kamerayı aç'}">${icon(voice.cam ? 'video' : 'videoOff', 18)}</button>
      ${musicOn ? `<button class="vb ${music?.state?.playing ? 'on' : ''}" data-act="music" title="Müzik Çalar">${icon('music', 18)}</button>` : ''}
      <button class="vb" data-act="goto-voice" title="Sahneyi göster">${icon('stage', 18)}</button>
    </div>`
}

function renderMeCard () {
  const box = $('#me-card')
  if (!S.profile) return
  const muted = voice?.muted || voice?.deaf
  box.innerHTML = `
    <button class="me-user" data-act="my-profile">
      ${avatarFull(S.me, 38, { online: true })}
      <span class="me-text"><b>${esc(S.profile.name || 'Ben')}</b>${actLine(S.me, 'tiny') || `<small>${esc(S.profile.status || 'Çevrim içi')}</small>`}</span>
    </button>
    <div class="me-btns">
      <button class="ib ${muted ? 'red' : ''}" data-act="mute" title="${voice?.muted ? 'Sesi aç' : 'Sustur'} (Ctrl+Shift+M)">${icon(muted ? 'micOff' : 'mic', 19)}</button>
      <button class="ib ${voice?.deaf ? 'red' : ''}" data-act="deafen" title="${voice?.deaf ? 'Sağırlaştırmayı kaldır' : 'Sağırlaştır'} (Ctrl+Shift+D)">${icon(voice?.deaf ? 'headphonesOff' : 'headphones', 19)}</button>
      <button class="ib" data-act="settings" title="Ayarlar">${icon('settings', 19)}</button>
    </div>`
}

function renderDock () {
  const d = $('#dock')
  if (!voice.active) { d.innerHTML = ''; return }
  const muted = voice.muted || voice.deaf
  const musicOn = botEnabledIn(voice.server, voice.channel, 'music')
  d.innerHTML = `
    <button class="db ${muted ? 'off' : ''}" data-act="mute" title="Mikrofon">${icon(muted ? 'micOff' : 'mic', 21)}</button>
    <button class="db ${voice.deaf ? 'off' : ''}" data-act="deafen" title="Kulaklık">${icon(voice.deaf ? 'headphonesOff' : 'headphones', 21)}</button>
    <span class="db-sep"></span>
    <button class="db ${voice.cam ? 'on' : ''}" data-act="camera" title="Kamera">${icon(voice.cam ? 'video' : 'videoOff', 21)}</button>
    <button class="db ${voice.screen ? 'live' : ''}" data-act="screen" title="${voice.screen ? 'Paylaşımı durdur' : 'Ekran paylaş'}">${icon(voice.screen ? 'screenOff' : 'screen', 21)}</button>
    ${musicOn ? `<button class="db ${music?.state?.playing ? 'on' : ''}" data-act="music" title="Müzik Çalar">${icon('music', 21)}</button>` : ''}
    <button class="db" data-act="toggle-view" title="Sohbete dön">${icon('chat', 21)}</button>
    <span class="db-sep"></span>
    <button class="db hang" data-act="hangup" title="Bağlantıyı kes">${icon('phoneOff', 21)}</button>`
}

// =====================================================================
// Başlık
// =====================================================================
function renderHeader () {
  const h = $('#chan-header')
  if (S.mode === 'home') {
    if (!S.dm) {
      h.innerHTML = `<div class="hd-left"><span class="hd-icon">${icon('users', 21)}</span><span class="hd-name">Arkadaşlar</span><span class="hd-sep"></span>${homeTabsHTML()}</div>
        <div class="hd-right"><button class="hd-btn ${S.showMembers ? 'on' : ''}" data-act="toggle-members" title="Şu an aktif">${icon('activity', 20)}</button></div>`
      return
    }
    const k = S.dm
    h.innerHTML = `
      <div class="hd-left">${avatarFull(k, 30, { online: isOnline(k), badge: false })}<button class="hd-name link-like" data-act="user" data-key="${k}">${esc(nameOf(k))}</button>${actLine(k) ? `<span class="hd-sep"></span>${actLine(k)}` : ''}</div>
      <div class="hd-right">
        <div class="hd-search">${icon('search', 15)}<input id="search" placeholder="Sohbette ara" value="${esc(S.search)}"></div>
        <button class="hd-btn ${S.showMembers ? 'on' : ''}" data-act="toggle-members" title="Profil">${icon('users', 20)}</button>
      </div>`
    return
  }
  const m = curMeta()
  if (!m || m.pending) { h.innerHTML = ''; return }
  let left = ''
  if (S.view === 'stage' && voice.channel && voice.server === S.server) {
    const ch = m.channels.find(c => c.id === voice.channel)
    left = `<span class="hd-icon">${icon('volume', 21)}</span><span class="hd-name">${esc(ch?.name || 'Ses')}</span>${ch?.topic ? `<span class="hd-sep"></span><span class="hd-topic">${esc(ch.topic)}</span>` : ''}`
  } else {
    const ch = m.channels.find(c => c.id === S.channel)
    if (!ch) { h.innerHTML = ''; return }
    left = `<span class="hd-icon">${icon('hash', 21)}</span><span class="hd-name">${esc(ch.name)}</span>${ch.topic ? `<span class="hd-sep"></span><span class="hd-topic">${esc(ch.topic)}</span>` : ''}`
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
  const c = chatCtx()
  if (!c) { box.innerHTML = ''; return }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  const prevHeight = box.scrollHeight
  const prevTop = box.scrollTop
  const m = c.kind === 'channel' ? curMeta() : null
  const ch = m?.channels.find(x => x.id === S.channel)

  let list = S.msgs
  const q = S.search.trim().toLowerCase()
  if (q) list = list.filter(x => x.text.toLowerCase().includes(q) || nameOf(x.author).toLowerCase().includes(q))

  let items = list.map(x => ({ kind: 'msg', ts: x.ts, m: x }))
  if (!q && m) {
    const firstText = sortedChannels(m).find(x => x.kind === 'text')
    const welcomeBot = botsIn(m, S.channel).has('welcome')
    if (welcomeBot || (firstText && firstText.id === S.channel && !m.bots.some(b => b.id === 'welcome' && b.enabled))) {
      const from = S.msgs.length >= S.limit ? S.msgs[0].ts : 0
      for (const mem of m.members) if (mem.joinedAt > from && mem.key !== m.owner) items.push({ kind: 'join', ts: mem.joinedAt, key: mem.key, bot: welcomeBot })
      items.sort((a, b) => a.ts - b.ts)
    }
  }

  let html = ''
  if (!q && S.msgs.length < S.limit) {
    if (c.kind === 'dm') {
      html += `<div class="chan-welcome">${avatarFull(c.key, 80, { badge: false })}<h2>${esc(nameOf(c.key))}</h2><p>Bu, <b>${esc(nameOf(c.key))}</b> ile özel sohbetinin başlangıcı. Mesajlar yalnızca ikinizin bilgisayarları arasında, doğrudan ve şifreli gider.</p></div>`
    } else {
      html += `
        <div class="chan-welcome">
          <div class="cw-icon">${icon(ch?.private ? 'lock' : 'hash', 40)}</div>
          <h2>#${esc(ch?.name || '')} kanalına hoş geldin!</h2>
          <p>Bu, #${esc(ch?.name || '')} kanalının başlangıcı.${ch?.topic ? ' ' + esc(ch.topic) : ''}</p>
          ${ch?.private ? `<p class="cw-private">${icon('lock', 14)} Özel kanal · yalnızca ${(ch.groups || []).map(g => groupById(m, g)).filter(Boolean).map(g => groupChip(g)).join(' ') || 'yöneticiler'} görebilir. Mesajlar uçtan uca şifrelenir.</p>` : ''}
        </div>`
    }
  } else if (!q) {
    html += '<div class="load-more muted small">Daha eski mesajlar için yukarı kaydır…</div>'
  }
  if (q) html += `<div class="search-info muted small">"${esc(S.search)}" için ${list.length} sonuç</div>`

  let prev = null
  let lastDay = ''
  const pins = new Set(ch?.pins || [])
  const isMod = !!m?.isAdmin
  for (const it of items) {
    const day = new Date(it.ts).toDateString()
    if (day !== lastDay) { html += `<div class="day-sep"><span>${esc(fmtDay(it.ts))}</span></div>`; lastDay = day; prev = null }
    if (it.kind === 'join') {
      if (it.bot) {
        html += `<div class="msg bot-msg"><div class="msg-row"><div class="msg-gutter">${botAvatar('welcome', 42)}</div><div class="msg-body"><div class="msg-head"><button class="msg-name" data-act="bot" data-id="welcome">Karşılama</button><span class="tag-bot">BOT</span><span class="msg-time">${esc(fmtTime(it.ts))}</span></div><div class="msg-text">${esc(welcomeText(it.key)).replace('{u}', `<span class="mention" data-act="user" data-key="${it.key}">@${esc(nameOf(it.key))}</span>`)}</div></div></div></div>`
      } else {
        html += `<div class="sys-msg">${icon('userPlus', 18)}<span><span class="mention" data-act="user" data-key="${it.key}">@${esc(nameOf(it.key))}</span> topluluğa katıldı!</span><span class="msg-time">${esc(fmtTime(it.ts))}</span></div>`
      }
      prev = null
      continue
    }
    const x = it.m
    const grouped = prev && prev.author === x.author && x.ts - prev.ts < 5 * 60 * 1000 && !x.reply && !x.poll && !prev.poll
    const own = x.author === S.me
    const color = colorOf(x.author)
    const reactions = Object.entries(x.reactions || {})
    const mem = m ? member(x.author) : null
    html += `
      <div class="msg ${grouped ? 'grouped' : ''} ${mentionsMe(x.text) ? 'mentioned' : ''} ${S.editing === x.id ? 'editing' : ''}" data-id="${x.id}">
        ${x.reply ? `<div class="reply-ref" data-act="jump" data-id="${x.reply.id}">${avatar(x.reply.author, 16)}<span class="rr-name">${esc(nameOf(x.reply.author))}</span><span class="rr-text">${esc(plainText(x.reply.text) || (x.reply.hasImage ? '📷 Resim' : ''))}</span></div>` : ''}
        <div class="msg-row">
          <div class="msg-gutter">${grouped ? `<span class="msg-hover-time">${fmtHM(x.ts)}</span>` : `<button class="av-btn" data-act="user" data-key="${x.author}">${avatar(x.author, 42)}</button>`}</div>
          <div class="msg-body">
            ${grouped ? '' : `<div class="msg-head"><button class="msg-name" data-act="user" data-key="${x.author}" ${color ? `style="color:${color}"` : ''}>${esc(nameOf(x.author))}</button>${mem?.owner ? `<span class="tag owner" title="Sunucu sahibi">${icon('crown', 12)}</span>` : mem?.admin ? `<span class="tag admin" title="Yönetici">${icon('shield', 12)}</span>` : ''}<span class="msg-time">${esc(fmtTime(x.ts))}</span>${pins.has(x.id) ? `<span class="pinned">${icon('pin', 12)}</span>` : ''}</div>`}
            ${x.locked ? `<div class="msg-text locked">${icon('lock', 14)} Şifreli mesaj — bu kanalın anahtarı sana henüz ulaşmadı.</div>` : x.poll ? renderPoll(x) : x.text ? `<div class="msg-text ${x.bot ? 'cmd-text' : ''}">${md(x.text)}${x.edited ? '<span class="edited">(düzenlendi)</span>' : ''}</div>` : ''}
            ${renderBotReply(x)}
            ${x.attachments.length ? `<div class="atts n${Math.min(x.attachments.length, 4)}">${x.attachments.map(a => safeImg(a.data) ? `<img class="att-img" src="${a.data}" alt="${esc(a.name)}" data-act="lightbox" loading="lazy">` : '').join('')}</div>` : ''}
            ${x.poll ? '' : messageEmbeds(x)}
            ${reactions.length ? `<div class="reactions">${reactions.map(([e, users]) => `<button class="react ${users.includes(S.me) ? 'mine' : ''}" data-act="react" data-id="${x.id}" data-emoji="${esc(e)}" title="${esc(users.map(u => nameOf(u)).join(', '))}">${esc(e)} <b>${users.length}</b></button>`).join('')}<button class="react add" data-act="react-pick" data-id="${x.id}">${icon('smile', 15)}</button></div>` : ''}
          </div>
          <div class="msg-actions">
            ${['👍', '❤️', '😂'].map(e => `<button data-act="react" data-id="${x.id}" data-emoji="${e}" title="Tepki ver">${e}</button>`).join('')}
            <button data-act="react-pick" data-id="${x.id}" title="Tepki ekle">${icon('smile', 17)}</button>
            <button data-act="reply" data-id="${x.id}" title="Yanıtla">${icon('reply', 17)}</button>
            ${own && !x.poll && !x.locked ? `<button data-act="edit" data-id="${x.id}" title="Düzenle">${icon('edit', 17)}</button>` : ''}
            ${isMod ? `<button data-act="pin" data-id="${x.id}" title="${pins.has(x.id) ? 'Sabitlemeyi kaldır' : 'Sabitle'}">${icon('pin', 17)}</button>` : ''}
            <button data-act="copy" data-id="${x.id}" title="Metni kopyala">${icon('copy', 17)}</button>
            ${own || isMod ? `<button class="danger" data-act="delete" data-id="${x.id}" title="Sil">${icon('trash', 17)}</button>` : ''}
          </div>
        </div>
      </div>`
    prev = x
  }
  box.innerHTML = html

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
  const map = S.typing.get(ctxKey())
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
  const input = $('#input')
  if (S.mode === 'home') {
    input.placeholder = S.dm ? `@${nameOf(S.dm)} kişisine mesaj gönder` : ''
  } else {
    const ch = curMeta()?.channels?.find(c => c.id === S.channel)
    input.placeholder = ch ? `#${ch.name} kanalına mesaj gönder` : 'Mesaj gönder'
  }
  renderDMComposer()
  $('#btn-poll').hidden = !canPoll()
  if (S.mode === 'server') {
    const ch = curMeta()?.channels?.find(c => c.id === S.channel)
    const wait = ch && ch.private && !ch.hasKey
    $('.composer-box').hidden = !!wait
    const lock = $('#dm-lock')
    lock.hidden = !wait
    if (wait) lock.innerHTML = `<span>${icon('key', 18)} Bu özel kanalın şifreleme anahtarı bekleniyor. Anahtarı olan bir üye (ör. yönetici) çevrim içi olduğunda otomatik gelir.</span>`
  }
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
  renderCmdHints()
  const c = chatCtx()
  if (!c) return
  if ($('#input').value.trim() && !$('#input').value.startsWith('/') && Date.now() - lastTypingSent > 3000) {
    lastTypingSent = Date.now()
    if (c.kind === 'dm') api.dmTyping(c.key)
    else api.eph(c.server, 'typing', { channel: c.channel })
  }
}

async function send () {
  const input = $('#input')
  const text = input.value.replace(/\s+$/, '')
  const c = chatCtx()
  if (!c) return
  try {
    if (S.editing) {
      if (text.trim()) await postCtx('message-edit', { target: S.editing, text: namesToMentions(text) })
      S.editing = null
    } else {
      if (!text.trim() && !S.attachments.length) return
      if (c.kind === 'channel' && !S.attachments.length && await handleMusicCommand(text)) {
        input.value = ''
        autoGrow()
        renderCmdHints()
        return
      }
      const size = S.attachments.reduce((n, a) => n + a.data.length, 0)
      if (size > 10.5 * 1024 * 1024) { toast('Ekler çok büyük (toplam en fazla ~7 MB).'); return }
      await postCtx('message', { text: namesToMentions(text), attachments: S.attachments, replyTo: S.reply })
      S.reply = null
      S.attachments = []
    }
  } catch (e) {
    toast('Gönderilemedi: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    return
  }
  lastTypingSent = 0
  input.value = ''
  mentionMap.clear()
  closeMentions()
  autoGrow()
  renderCmdHints()
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
      if (f.type === 'image/gif' && f.size < 7 * 1024 * 1024) data = await fileToDataURL(f)
      else data = await resizeImage(f, { max: 2048, quality: 0.86 })
      const dims = await imageSize(data)
      S.attachments.push({ type: 'image', data, name: f.name || 'resim', w: dims.w, h: dims.h })
    } catch { toast('Resim okunamadı.') }
  }
  renderComposerState()
}

// =====================================================================
// Sağ panel
// =====================================================================
function renderMembers () {
  const box = $('#members')
  if (S.mode === 'home') {
    box.innerHTML = S.dm ? dmProfileHTML(S.dm) : activeNowHTML()
    return
  }
  const m = curMeta()
  if (!S.showMembers || !m || m.pending) { box.innerHTML = ''; return }
  const sortFn = (a, b) => (b.owner - a.owner) || (b.admin - a.admin) || nameOf(a.key).localeCompare(nameOf(b.key), 'tr')
  const online = m.members.filter(x => x.online).sort(sortFn)
  const offline = m.members.filter(x => !x.online).sort(sortFn)
  const bots = m.bots.filter(b => b.enabled)
  const row = (x) => {
    const p = profileOf(x.key)
    return `
      <button class="mem ${x.online ? '' : 'offline'}" data-act="user" data-key="${x.key}">
        ${avatarFull(x.key, 36, { online: x.online, badge: x.online })}
        <span class="mem-text">
          <span class="mem-name" style="${p?.color && x.online ? `color:${p.color}` : ''}"><span class="ellipsis">${esc(nameOf(x.key))}</span>${x.owner ? icon('crown', 13, 'gold') : x.admin ? icon('shield', 13, 'blue') : ''}${groupBadges(x.key, m)}</span>
          ${(x.online && actLine(x.key)) || (p?.status ? `<span class="mem-status">${esc(p.status)}</span>` : '')}
        </span>
      </button>`
  }
  box.innerHTML = `
    ${m.description ? `<div class="srv-desc">${esc(m.description)}</div>` : ''}
    <div class="mem-group">Çevrim içi — ${online.length}</div>
    ${online.map(row).join('')}
    ${bots.length ? `<div class="mem-group">Botlar — ${bots.length}${m.isAdmin ? `<button class="mini" data-act="bots-admin" title="Botları yönet">${icon('settings', 13)}</button>` : ''}</div>${bots.map(b => `
      <button class="mem" data-act="bot" data-id="${b.id}">
        ${botAvatar(b.id, 36)}
        <span class="mem-text"><span class="mem-name">${BOT_DEFS[b.id].name} <span class="tag-bot">BOT</span></span><span class="mem-status">${esc(BOT_DEFS[b.id].commands[0]?.[0] || 'Otomatik')}</span></span>
      </button>`).join('')}` : (m.isAdmin ? `<button class="mem add-bots" data-act="bots-admin">${icon('bot', 18)}<span>Bot ekle</span></button>` : '')}
    ${offline.length ? `<div class="mem-group">Çevrimdışı — ${offline.length}</div>${offline.map(row).join('')}` : ''}`
}

// =====================================================================
// Sesli sahne
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

// Sahne, karoları yeniden oluşturmadan günceller: video öğeleri ve tam ekran korunur.
const tileEls = new Map()
let stageShell = null // { layout, root, main, strip }

function stageFullscreenIn (node) {
  const f = document.fullscreenElement
  return !!(f && node && (f === node || node.contains(f) || f.contains(node)))
}

function tileTop (t) {
  if (t.kind !== 'screen') return ''
  const n = (t.viewers || []).length
  const names = (t.viewers || []).map(k => nameOf(k)).join(', ')
  return `<span class="tile-viewers" title="${esc(names || 'Henüz izleyen yok')}">${icon('eye', 14)} ${n}${t.self ? ' izleyici' : ''}</span>`
}

function tileButtons (t) {
  let b = ''
  if (t.kind === 'screen' && !t.self && t.watching) b += `<button class="tile-btn danger" data-act="unwatch" data-key="${t.key}" title="Yayını kapat">${icon('x', 15)}<span>Yayını Kapat</span></button>`
  if (t.kind !== 'avatar' && t.kind !== 'music' && (t.stream || t.self)) b += `<button class="tile-btn" data-act="tile-full" title="Tam ekran">${icon('maximize', 16)}</button>`
  return b
}

function updateTile (div, t, big, parts) {
  div.className = `tile ${t.kind} ${big ? 'big' : ''} ${t.kind === 'screen' && !t.watching ? 'offer' : ''}`
  if (t.kind === 'music') {
    $('.tile-label', div).innerHTML = `${icon('music', 14)}<span class="ellipsis">${esc(t.label)}</span><small>Müzik Çalar</small>`
    return
  }
  const p = parts.find(x => x.key === t.key) || {}
  const label = `${t.kind === 'screen' ? '<span class="live">CANLI</span>' : ''}<span>${esc(nameOf(t.key))}${t.kind === 'screen' ? ' · Ekran' : ''}</span>${t.label ? `<small>${esc(t.label)}</small>` : ''}${muteIcons(p, 15)}`
  const lab = $('.tile-label', div)
  if (lab._h !== label) { lab.innerHTML = label; lab._h = label }
  const top = tileTop(t)
  const topEl = $('.tile-top', div)
  if (topEl._h !== top) { topEl.innerHTML = top; topEl._h = top }
  const btns = tileButtons(t)
  const bEl = $('.tile-btns', div)
  if (bEl._h !== btns) { bEl.innerHTML = btns; bEl._h = btns }

  const media = $('.tile-media', div)
  let sig
  if (t.kind === 'avatar') {
    const act = activityOf(t.key)
    const pr = profileOf(t.key)
    sig = ['av', t.key, big, act ? actText(act) : '', t.conn || '', pr?.avatar?.length || 0, pr?.banner?.length || 0].join('|')
    if (media._sig !== sig) {
      const bad = t.conn && t.conn !== 'connected'
      media.innerHTML = `<div class="tile-av">${avatar(t.key, big ? 120 : 86)}</div>${act ? `<div class="tile-act">${actIcon(act, 16)}<span class="ellipsis">${esc(actText(act))}</span></div>` : ''}${bad ? `<div class="tile-conn">${t.conn === 'failed' || t.conn === 'disconnected' ? 'Bağlantı onarılıyor…' : 'Bağlanıyor…'}<button class="btn small" data-act="peer-reconnect" data-key="${t.key}">${icon('signal', 14)} Yeniden bağlan</button></div>` : ''}`
      if (pr?.banner && safeImg(pr.banner)) div.style.setProperty('--tile-bg', `url(${pr.banner})`); else div.style.removeProperty('--tile-bg')
      div.style.setProperty('--tile-accent', pr?.color || hashColor(t.key))
    }
  } else if (t.kind === 'screen' && !t.self && !t.watching) {
    sig = ['offer', t.key, big].join('|')
    if (media._sig !== sig) {
      media.innerHTML = `<div class="watch-offer">${avatar(t.key, big ? 72 : 48)}<div><b>${esc(nameOf(t.key))}</b> ekranını paylaşıyor</div><button class="btn primary" data-act="watch" data-key="${t.key}">${icon('play', 16)} Yayını İzle</button></div>`
    }
  } else if (t.stream) {
    const v = videoFor(t.stream)
    sig = 'v|' + t.stream.id
    if (media._sig !== sig || v.parentNode !== media) { media.replaceChildren(v); v.play().catch(() => {}) }
    v.classList.toggle('mirror', !!(t.self && t.kind === 'cam'))
  } else {
    sig = 'wait|' + t.id
    if (media._sig !== sig) media.innerHTML = '<div class="tile-conn"><div class="spinner small"></div> Görüntü bekleniyor…</div>'
  }
  media._sig = sig
}

function makeTile (t) {
  if (t.kind === 'music') return el('<div class="tile music" data-tile="music"><div class="tile-media"><div id="music-slot"></div></div><div class="tile-label"></div></div>')
  return el(`<div class="tile" data-tile="${esc(t.id)}"><div class="tile-media"></div><div class="tile-top"></div><div class="tile-btns"></div><div class="tile-label"></div></div>`)
}

function renderStage () {
  const stage = $('#stage')
  const show = S.mode === 'server' && S.view === 'stage' && voice.active && voice.server === S.server
  stage.hidden = !show
  renderLayout()
  if (!show) return
  const tiles = voice.tiles()
  const mp = music?.state?.playing
  if (mp && music.iframe) tiles.splice(1, 0, { id: 'music', kind: 'music', key: 'music', label: mp.video.title })
  if (S.focusTile && !tiles.some(t => t.id === S.focusTile)) S.focusTile = null
  const parts = voice.participants(voice.server, voice.channel)
  const focus = S.focusTile && tiles.find(t => t.id === S.focusTile)
  const layout = !tiles.length ? 'empty' : focus ? 'focus' : 'grid'
  const fsLocked = stageFullscreenIn(stage)

  if (!stageShell || stageShell.layout !== layout || !stage.contains(stageShell.root)) {
    if (fsLocked && stageShell) {
      // Tam ekrandayken düzeni değiştirme; yalnızca içerikleri güncelle
    } else {
      let root
      if (layout === 'empty') root = el('<div class="empty-card"><p>Kanalda kimse yok.</p></div>')
      else if (layout === 'focus') root = el('<div class="stage-focus"><div class="focus-main"></div><div class="focus-strip"></div></div>')
      else root = el('<div class="stage-grid"></div>')
      stage.replaceChildren(root)
      stageShell = { layout, root, main: layout === 'focus' ? $('.focus-main', root) : root, strip: layout === 'focus' ? $('.focus-strip', root) : root }
    }
  }
  const sh = stageShell
  if (sh.layout === 'grid') sh.root.className = `stage-grid n${Math.min(tiles.length, 9)}`

  const keep = new Set()
  const place = (node, parent, index) => {
    if (parent.children[index] === node) return
    if (stageFullscreenIn(node)) return // tam ekrandaki karoyu yerinden oynatma
    parent.insertBefore(node, parent.children[index] || null)
  }
  let stripIdx = 0
  tiles.forEach((t, i) => {
    let node = tileEls.get(t.id)
    if (!node) { node = makeTile(t); tileEls.set(t.id, node) }
    keep.add(t.id)
    const big = sh.layout === 'focus' && t === focus
    updateTile(node, t, big, parts)
    if (sh.layout === 'empty') return
    if (sh.layout === 'focus') { if (big) place(node, sh.main, 0); else place(node, sh.strip, stripIdx++) } else place(node, sh.root, i)
  })
  for (const [id, node] of tileEls) {
    if (keep.has(id)) continue
    if (document.fullscreenElement && stageFullscreenIn(node)) document.exitFullscreen().catch(() => {})
    node.remove()
    tileEls.delete(id)
  }
  const used = new Set(tiles.filter(t => t.stream && (t.kind !== 'screen' || t.self || t.watching)).map(t => t.stream.id))
  for (const [id, v] of videoEls) {
    if (!used.has(id)) { v.srcObject = null; v.remove(); videoEls.delete(id) } else if (v.paused && v.isConnected) v.play().catch(() => {})
  }
  music?.position()
}

// =====================================================================
// Sunucu işlemleri
// =====================================================================
function openAddServer () {
  let icon64 = null
  const body = el(`
    <div class="add-server ${S.canCreate ? '' : 'join-only'}">
      ${S.canCreate ? `<div class="as-col">
        <h3>Yeni sunucu oluştur</h3>
        <p class="muted small">Sunucun senin ve üyelerin bilgisayarlarında yaşar. Sahibi sensin.</p>
        <button class="icon-pick" type="button"><span>${icon('image', 26)}<small>Simge</small></span></button>
        <label>Sunucu adı<input id="as-name" maxlength="60" value="${esc((S.profile.name || 'Benim') + ' sunucusu')}"></label>
        <button class="btn primary block" id="as-create">Oluştur</button>
      </div>
      <div class="as-or">veya</div>` : ''}
      <div class="as-col">
        <h3>Bir sunucuya katıl</h3>
        <p class="muted small">Sunucu yöneticisinden aldığın davet kodunu yapıştır.</p>
        <label>Davet kodu<input id="as-code" placeholder="yanki://davet/…"></label>
        <button class="btn block" id="as-join">Katıl</button>
      </div>
    </div>`)
  const mdl = openModal({ title: S.canCreate ? 'Sunucu ekle' : 'Sunucuya katıl', body, wide: S.canCreate })
  $('.icon-pick', body)?.addEventListener('click', async () => {
    icon64 = await pickImage({ w: 256, h: 256, cover: true, quality: 0.9, gifMax: GIF_LIMITS.icon })
    if (icon64) $('.icon-pick', body).innerHTML = `<img src="${icon64}" alt="">`
  })
  $('#as-create', body)?.addEventListener('click', async () => {
    const name = $('#as-name', body).value.trim()
    if (!name) return toast('Bir ad gir.')
    let id
    try { id = await api.createServer(name, icon64) } catch (e) { return toast(errText(e)) }
    mdl.close()
    S.servers = (await api.init()).servers
    await selectServer(id)
    toast('Sunucu oluşturuldu. Arkadaşlarını sunucu menüsündeki "Davet et" ile çağırabilirsin.')
  })
  $('#as-join', body).addEventListener('click', async () => {
    const code = $('#as-code', body).value.trim()
    try {
      const id = await api.joinServer(code)
      mdl.close()
      S.servers = (await api.init()).servers
      await selectServer(id)
    } catch (e) { toast(errText(e), 5000) }
  })
}

function serverMenu (anchor) {
  const m = curMeta()
  if (!m || m.pending) return
  const items = m.isAdmin
    ? [{ label: 'Davet et', icon: 'userPlus', onClick: openInviteModal }]
    : [{ label: 'Davet için bir yöneticiye başvur', icon: 'userPlus', onClick: () => toast('Davet kodlarını yalnızca sunucu yöneticileri oluşturabilir.') }]
  if (m.isAdmin) {
    items.push('-',
      { label: 'Kanal oluştur', icon: 'plus', onClick: () => channelModal(null, null) },
      { label: 'Kategori oluştur', icon: 'folderPlus', onClick: () => categoryModal(null) },
      { label: 'Gruplar ve erişim', icon: 'lock', onClick: () => openGroupsModal() },
      { label: 'Botlar', icon: 'bot', onClick: openBotsModal },
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
      <label class="voice-only">Kullanıcı sınırı (0 = sınırsız)<input id="ch-limit" type="number" min="0" max="99" value="${ch?.userLimit || 0}"></label>
      <h4>${icon('lock', 13)} Erişim</h4>
      ${m.groups.length ? `
        <div class="access-groups">
          <p class="muted small">Hiçbir grup seçmezsen kanal herkese açıktır. Grup seçersen yalnızca o gruplardaki üyeler (ve yöneticiler) kanalı görür; metin mesajları şifrelenir.</p>
          ${m.groups.map(g => `<label class="chip gpick" style="--gc:${g.color}"><input type="checkbox" data-grp="${g.id}" ${(ch?.groups || []).includes(g.id) ? 'checked' : ''}><span><i></i>${esc(g.name)} <small>${g.members.length}</small></span></label>`).join('')}
        </div>` : `<p class="muted small">Kanalı yalnızca belirli kişilere açmak için önce bir grup oluştur. <button class="link-like" type="button" id="ch-groups">Grupları yönet</button></p>`}
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
      const data = { name: finalName, topic: $('#ch-topic', node).value, category: $('#ch-cat', node).value || null, userLimit: +$('#ch-limit', node).value || 0, groups: $$('[data-grp]:checked', node).map(x => x.dataset.grp) }
      if (ch) await api.post(S.server, 'channel-update', { target: ch.id, ...data })
      else {
        const siblings = m.channels.filter(c => c.category === data.category)
        await api.post(S.server, 'channel-create', { ...data, kind, order: siblings.length ? Math.max(...siblings.map(c => c.order)) + 1 : 0 })
      }
    }
  })
  const mdl = openModal({ title: ch ? 'Kanalı düzenle' : 'Kanal oluştur', body, actions })
  $$('input[name=kind]', mdl.node).forEach(r => r.addEventListener('change', () => { $('.voice-only', mdl.node).hidden = !(r.value === 'voice' && r.checked) }))
  $('.voice-only', mdl.node).hidden = !ch || ch.kind !== 'voice'
  $('#ch-groups', mdl.node)?.addEventListener('click', () => { mdl.close(); openGroupsModal() })
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
  openModal({ title: cat ? 'Kategoriyi düzenle' : 'Kategori oluştur', body: `<div class="form"><label>Kategori adı<input id="cat-name" maxlength="50" value="${esc(cat?.name || '')}"></label>${cat ? '<div class="row gap"><button class="btn small" id="cat-up">Yukarı taşı</button><button class="btn small" id="cat-down">Aşağı taşı</button></div>' : ''}</div>`, actions })
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
      <div class="banner-pick" id="ss-banner" style="${bannerData ? `background-image:url(${bannerData})` : ''}"><span>${icon('image', 18)} Sunucu bannerı (960×320, GIF olabilir)</span></div>
      ${bannerData ? '<button class="btn small" id="ss-banner-rm">Bannerı kaldır</button>' : ''}
      <h4>Davetler</h4>
      <button class="btn small" id="ss-copy">${icon('userPlus', 15)} Davet oluştur ve yönet</button>
      <h4>Botlar</h4>
      <button class="btn small" id="ss-bots">${icon('bot', 15)} Botları yönet</button>
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
  $('#ss-icon', body).addEventListener('click', async () => { const d = await pickImage({ w: 256, h: 256, cover: true, gifMax: GIF_LIMITS.icon }); if (d) { iconData = d; $('#ss-icon', body).innerHTML = `<img src="${d}" alt="">` } })
  $('#ss-banner', body).addEventListener('click', async () => { const d = await pickImage({ w: 960, h: 320, cover: true, quality: 0.85, gifMax: GIF_LIMITS.banner }); if (d) { bannerData = d; $('#ss-banner', body).style.backgroundImage = `url(${d})` } })
  $('#ss-banner-rm', body)?.addEventListener('click', () => { bannerData = null; $('#ss-banner', body).style.backgroundImage = '' })
  $('#ss-copy', body).addEventListener('click', () => { mdl.close(); openInviteModal() })
  $('#ss-bots', body).addEventListener('click', () => { mdl.close(); openBotsModal() })
  $$('[data-unban]', body).forEach(b => b.addEventListener('click', async () => { await api.post(S.server, 'unban', { user: b.dataset.unban }); b.closest('.ban-row').remove() }))
}

// =====================================================================
// Profil kartı
// =====================================================================
function openProfileCard (key, anchor) {
  const m = S.mode === 'server' ? curMeta() : null
  const mem = m ? member(key) : null
  const p = profileOf(key) || {}
  const banner = safeImg(p.banner)
  const isMe = key === S.me
  const act = activityOf(key)
  const inRoom = voice.active && voice.participants(voice.server, voice.channel).some(x => x.key === key) && !isMe
  const canMod = m?.isAdmin && mem && !isMe && !mem.owner && (!mem.admin || m.owner === S.me)
  const fs = friendStatusOf(key)
  const html = `
    <div class="pcard" style="--accent-user:${p.color || hashColor(key)}">
      <div class="pc-banner" style="${banner ? `background-image:url(${banner})` : ''}"></div>
      <div class="pc-av">${avatarFull(key, 84, { online: isOnline(key), badge: false })}</div>
      <div class="pc-body">
        <div class="pc-name">${esc(nameOf(key))}${p.pronouns ? `<small> · ${esc(p.pronouns)}</small>` : ''}</div>
        <button class="pc-key" data-act="copy-key" data-key="${key}" title="Arkadaş kodunu kopyala">${key.slice(0, 8)}…${key.slice(-6)} ${icon('copy', 11)}</button>
        ${p.status ? `<div class="pc-status">${esc(p.status)}</div>` : ''}
        ${mem ? `<div class="pc-roles">
          ${mem.owner ? `<span class="role gold">${icon('crown', 13)} Sahip</span>` : ''}
          ${mem.admin && !mem.owner ? `<span class="role blue">${icon('shield', 13)} Yönetici</span>` : ''}
          ${!mem.admin ? '<span class="role">Üye</span>' : ''}
          ${fs === 'friends' ? `<span class="role accent">${icon('userCheck', 13)} Arkadaş</span>` : ''}
          ${(mem.groups || []).map(g => groupById(m, g)).filter(Boolean).map(g => groupChip(g, 'role')).join('')}
          ${m.isAdmin ? `<button class="role add" id="pc-groups" title="Gruplara ekle/çıkar">${icon('plus', 12)} Grup</button>` : ''}
        </div>` : ''}
        ${act ? activityBlock(act) : ''}
        ${p.bio ? `<h5>Hakkımda</h5><div class="pc-bio">${md(p.bio)}</div>` : ''}
        ${mem?.joinedAt ? `<h5>Üyelik</h5><div class="pc-since">${fmtDate(mem.joinedAt)}</div>` : ''}
        ${inRoom ? `<h5>Ses düzeyi</h5><input type="range" min="0" max="100" value="${Math.round((voice.volumes[key] ?? 1) * 100)}" id="pc-vol">` : ''}
        <div class="pc-actions">
          ${isMe ? `<button class="btn small primary" id="pc-edit">${icon('edit', 15)} Profili düzenle</button>` : `<button class="btn small primary" data-act="open-dm" data-key="${key}">${icon('chat', 15)} Mesaj</button>${friendButton(key)}`}
          ${m && !isMe ? '<button class="btn small" id="pc-mention">@ Bahset</button>' : ''}
          ${m?.owner === S.me && mem && !isMe ? `<button class="btn small" id="pc-admin">${mem.admin ? 'Yöneticiliği al' : 'Yönetici yap'}</button>` : ''}
          ${canMod ? `<button class="btn small danger-ghost" id="pc-kick">${icon('userX', 15)} At</button><button class="btn small danger-ghost" id="pc-ban">${icon('ban', 15)} Yasakla</button>` : ''}
        </div>
      </div>
    </div>`
  const align = anchor.closest('#members') ? 'left' : 'right'
  const pop = openPopup(html, anchor, { align, cls: 'pcard-pop' })
  $('#pc-edit', pop)?.addEventListener('click', () => { closePopup(); openSettings('profile') })
  $('#pc-mention', pop)?.addEventListener('click', () => { closePopup(); const t = $('#input'); t.value += (t.value && !t.value.endsWith(' ') ? ' ' : '') + '@' + nameOf(key) + ' '; t.focus() })
  $('#pc-groups', pop)?.addEventListener('click', (e) => { e.stopPropagation(); groupMenu(key, e.currentTarget) })
  $('#pc-vol', pop)?.addEventListener('input', (e) => voice.setUserVolume(key, e.target.value / 100))
  $('#pc-admin', pop)?.addEventListener('click', async () => { closePopup(); await api.post(S.server, 'role-set', { user: key, role: mem?.admin ? 'member' : 'admin' }) })
  $('#pc-kick', pop)?.addEventListener('click', async () => { closePopup(); if (await confirmModal('Üyeyi at', `${esc(nameOf(key))} sunucudan atılacak (yeni bir davetle yeniden katılabilir).`, 'At')) await api.post(S.server, 'kick', { user: key }) })
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
    if (!ok) toast('macOS: Sistem Ayarları › Gizlilik ve Güvenlik › Ekran Kaydı bölümünden YANKI\'ya izin ver ve uygulamayı yeniden başlat.', 7000)
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
        ${S.platform === 'win32' ? `<label class="check"><input type="checkbox" id="sp-audio" ${settings.screenAudio ? 'checked' : ''}> Sistem sesini de paylaş <span class="muted small">(sohbetteki sesler yayına girmez)</span></label>` : '<span class="muted small">macOS\'ta sistem sesi paylaşımı desteklenmez.</span>'}
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

// =====================================================================
// Ayarlar
// =====================================================================
function openProfileSetup () {
  const body = el(`
    <div class="form setup">
      <img class="hero-word" src="assets/word.svg" alt="YANKI">
      <p class="muted">Kimliğin bu bilgisayarda oluşturulan bir şifreleme anahtarıdır — hesap, e-posta veya şifre yok. Sadece nasıl görüneceğini seç.</p>
      <label>Görünen ad<input id="su-name" maxlength="32" placeholder="ör. ReaLPoSSiBiLiTY"></label>
      <p class="muted small">Devam ederek paylaştığın içerikten kendinin sorumlu olduğunu kabul edersin. YANKI ücretsizdir ve "olduğu gibi" sunulur; ayrıntılar Ayarlar › Hakkında'da.</p>
    </div>`)
  openModal({
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
  const tabs = [['profile', 'Profilim', 'edit'], ['appearance', 'Görünüm', 'palette'], ['activity', 'Etkinlik', 'gamepad'], ['av', 'Ses ve Görüntü', 'mic'], ['screen', 'Ekran Paylaşımı', 'screen'], ['notify', 'Bildirimler ve pencere', 'bell'], ['net', 'Ağ ve Gizlilik', 'shield'], ['about', 'Hakkında', 'sparkle']]
  const body = el(`<div class="settings"><nav>${tabs.map(([k, l, i]) => `<button data-tab="${k}">${icon(i, 16)}<span>${l}</span></button>`).join('')}</nav><div class="st-pane"></div></div>`)
  let testStream = null
  let testRaf = 0
  let testCtx = null
  const stopTest = () => { testStream?.getTracks().forEach(t => t.stop()); testStream = null; cancelAnimationFrame(testRaf); testCtx?.close().catch(() => {}); testCtx = null }
  openModal({ title: 'Ayarlar', body, wide: true, cls: 'settings-modal', onClose: stopTest })
  const pane = $('.st-pane', body)
  let palettes = null

  const show = async (k) => {
    stopTest()
    $$('nav button', body).forEach(b => b.classList.toggle('on', b.dataset.tab === k))
    if (k === 'profile') {
      const preview = () => {
        const pv = $('.pv', pane)
        pv.style.setProperty('--accent-user', draft.color || hashColor(S.me))
        $('.pv-banner', pane).style.backgroundImage = draft.banner ? `url(${draft.banner})` : ''
        $('.pv-av', pane).innerHTML = `<span class="avw" style="--s:80px">${draft.avatar ? `<img src="${draft.avatar}" alt="">` : `<span class="av-fallback" style="background:${hashColor(S.me)};font-size:32px">${esc(initials(draft.name))}</span>`}</span>`
        $('.pv-name', pane).textContent = draft.name || 'Adın'
        $('.pv-status', pane).textContent = draft.status || ''
        $('.pv-bio', pane).innerHTML = md(draft.bio || '')
        $('.pv-act', pane).innerHTML = S.myAct ? activityBlock(S.myAct) : ''
      }
      pane.innerHTML = `
        <div class="profile-edit">
          <div class="form">
            <label>Görünen ad<input data-f="name" maxlength="32" value="${esc(draft.name)}"></label>
            <label>Durum mesajı<input data-f="status" maxlength="80" value="${esc(draft.status || '')}" placeholder="ör. Akşam Valheim var 🎮"></label>
            <label>Zamirler<input data-f="pronouns" maxlength="30" value="${esc(draft.pronouns || '')}" placeholder="İsteğe bağlı"></label>
            <label>Hakkımda<textarea data-f="bio" maxlength="600" rows="4" placeholder="Kendinden bahset… (markdown desteklenir)">${esc(draft.bio || '')}</textarea></label>
            <div class="row gap wrap">
              <button class="btn small" id="pe-av">${icon('image', 15)} Avatar yükle</button>
              <button class="btn small" id="pe-av-rm">Avatarı kaldır</button>
              <button class="btn small" id="pe-bn">${icon('image', 15)} Banner yükle</button>
              <button class="btn small" id="pe-bn-rm">Bannerı kaldır</button>
            </div>
            <p class="muted small">Hareketli GIF desteklenir: avatar en fazla 2,5 MB, banner en fazla 5 MB. GIF'ler kırpılmadan, olduğu gibi yüklenir.</p>
            <label class="row gap center">Profil rengi <input type="color" data-f="color" value="${draft.color || '#ff4f8b'}"></label>
            <div class="row gap"><button class="btn primary" id="pe-save">Değişiklikleri kaydet</button></div>
          </div>
          <div class="pv">
            <div class="pv-banner"></div>
            <div class="pv-av"></div>
            <div class="pv-body"><div class="pv-name"></div><div class="pv-status"></div><div class="pv-act"></div><div class="pv-bio"></div></div>
          </div>
        </div>`
      preview()
      $$('[data-f]', pane).forEach(i => i.addEventListener('input', () => { draft[i.dataset.f] = i.value; preview() }))
      $('#pe-av', pane).addEventListener('click', async () => { const d = await pickImage({ w: 256, h: 256, cover: true, quality: 0.88, gifMax: GIF_LIMITS.avatar }); if (d) { draft.avatar = d; preview() } })
      $('#pe-av-rm', pane).addEventListener('click', () => { draft.avatar = null; preview() })
      $('#pe-bn', pane).addEventListener('click', async () => { const d = await pickImage({ w: 960, h: 320, cover: true, quality: 0.85, gifMax: GIF_LIMITS.banner }); if (d) { draft.banner = d; preview() } })
      $('#pe-bn-rm', pane).addEventListener('click', () => { draft.banner = null; preview() })
      $('#pe-save', pane).addEventListener('click', async () => {
        if (!draft.name.trim()) return toast('Ad boş olamaz.')
        S.profile = await api.setProfile(draft)
        toast('Profil kaydedildi ve tüm sunuculara, arkadaşlarına yayıldı.')
        renderAll()
      })
    } else if (k === 'appearance') {
      const cur = settings.theme
      const custom = themeImage.get()
      if (cur.id === 'custom' && custom && !palettes) palettes = await extractPalettes(custom).catch(() => [])
      const t = currentTheme(cur)
      const light = isLight(cur)
      const modes = [['dark', 'Koyu', 'moon'], ['light', 'Açık', 'sun'], ['system', 'Sistem', 'monitor']]
      pane.innerHTML = `
        <div class="form">
          <h4>Mod</h4>
          <div class="mode-seg">${modes.map(([k, l, i]) => `<button class="${(cur.mode || 'dark') === k ? 'on' : ''}" data-mode="${k}">${icon(i, 18)}<span>${l}</span></button>`).join('')}</div>
          <h4>Tema</h4>
          <div class="theme-grid">
            ${THEMES.map(th => `<button class="theme-card ${cur.id === th.id ? 'on' : ''}" data-theme="${th.id}">
              <span class="tc-img" style="${th.image ? `background-image:url(themes/${th.image}${light ? '-light' : ''}-thumb.jpg)` : `background:radial-gradient(circle at 25% 30%, ${th.accent}66, transparent 55%), radial-gradient(circle at 80% 85%, ${th.accent2}55, transparent 55%), ${light ? '#f3f2f8' : th.bg}`}">${th.genre ? `<em class="tc-genre">${esc(th.genre)}</em>` : ''}</span>
              <span class="tc-name"><i style="background:${th.accent}"></i><i style="background:${th.accent2}"></i>${esc(th.name)}</span>
            </button>`).join('')}
            <button class="theme-card custom ${cur.id === 'custom' ? 'on' : ''}" data-theme="custom">
              <span class="tc-img" style="${custom ? `background-image:url(${custom})` : ''}">${custom ? '' : icon('upload', 26)}</span>
              <span class="tc-name">${icon('image', 13)} Kendi resmin</span>
            </button>
          </div>
          ${cur.id === 'custom' ? `
            <div class="custom-theme">
              <div class="row gap wrap"><button class="btn small" id="ct-upload">${icon('upload', 15)} ${custom ? 'Resmi değiştir' : 'Resim yükle'}</button>${custom ? '<button class="btn small" id="ct-remove">Resmi kaldır</button>' : ''}</div>
              ${palettes && palettes.length ? `<div class="muted small">Resminden çıkarılan palet önerileri:</div>
              <div class="palettes">${palettes.map((p, i) => `<button class="pal ${cur.accent === p.accent ? 'on' : ''}" data-pal="${i}" title="Bu paleti kullan"><i style="background:${p.bg}"></i><i style="background:${p.accent}"></i><i style="background:${p.accent2}"></i></button>`).join('')}</div>` : ''}
              <div class="row gap wrap">
                <label class="row gap center">Vurgu <input type="color" id="ct-accent" value="${t.accent}"></label>
                <label class="row gap center">İkinci vurgu <input type="color" id="ct-accent2" value="${t.accent2}"></label>
                <label class="row gap center">Taban <input type="color" id="ct-bg" value="${t.bg}"></label>
              </div>
            </div>` : `
            <label class="row gap center">Vurgu rengini değiştir <input type="color" id="ap-accent" value="${t.accent}"> ${cur.accentOverride ? '<button class="btn small" id="ap-accent-reset">Varsayılana dön</button>' : ''}</label>`}
          <h4>Arka plan</h4>
          <label>Karartma <input type="range" data-k="dim" min="0" max="85" value="${cur.dim}"></label>
          <label>Bulanıklık <input type="range" data-k="blur" min="0" max="30" value="${cur.blur}"></label>
          <label>Panel saydamlığı <input type="range" data-k="glass" min="0" max="60" value="${cur.glass}"></label>
          <p class="muted small">Arka plan ayarları resimli temalarda geçerlidir. Tema resimleri YANKI için kodla üretilmiş özgün çalışmalardır; hiçbir oyun, takım ya da markaya ait içerik kullanılmaz.</p>
          <h4>Performans</h4>
          <label class="check"><input type="checkbox" id="ap-perf" ${cur.perf ? 'checked' : ''}> ${icon('zap', 16)} Performans modu</label>
          <p class="muted small">Cam bulanıklığını, animasyonları ve geçiş efektlerini kapatır. Ekran kartı zayıf bilgisayarlarda ya da oyun oynarken önerilir.</p>
        </div>`
      const commit = () => { applyTheme(settings.theme); saveSettings() }
      const uploadThemeImage = async () => {
        const d = await pickImage({ max: 1920, quality: 0.86 })
        if (!d) return
        await api.saveThemeImage(d)
        themeImage.set(d)
        palettes = await extractPalettes(d).catch(() => [])
        settings.theme = { ...settings.theme, id: 'custom', ...(palettes[0] || {}) }
        commit(); show('appearance')
        toast('Resim yüklendi; resminden bir palet seçildi. Diğer önerileri de deneyebilirsin.', 4500)
      }
      $$('[data-theme]', pane).forEach(b => b.addEventListener('click', async () => {
        const id = b.dataset.theme
        if (id === 'custom' && !themeImage.get()) { await uploadThemeImage(); return }
        settings.theme = { ...settings.theme, id }
        delete settings.theme.accentOverride
        if (id === 'custom' && !settings.theme.accent) Object.assign(settings.theme, (palettes || [])[0] || {})
        commit(); show('appearance')
      }))
      $('#ct-upload', pane)?.addEventListener('click', uploadThemeImage)
      $('#ct-remove', pane)?.addEventListener('click', async () => { await api.saveThemeImage(null); themeImage.set(null); palettes = null; settings.theme = { ...settings.theme, id: 'yanki' }; commit(); show('appearance') })
      $$('[data-pal]', pane).forEach(b => b.addEventListener('click', () => { Object.assign(settings.theme, palettes[+b.dataset.pal]); commit(); show('appearance') }))
      $('#ct-accent', pane)?.addEventListener('input', e => { settings.theme.accent = e.target.value; commit() })
      $('#ct-accent2', pane)?.addEventListener('input', e => { settings.theme.accent2 = e.target.value; commit() })
      $('#ct-bg', pane)?.addEventListener('input', e => { settings.theme.bg = e.target.value; commit() })
      $('#ap-accent', pane)?.addEventListener('input', e => { settings.theme.accentOverride = e.target.value; commit() })
      $('#ap-accent-reset', pane)?.addEventListener('click', () => { delete settings.theme.accentOverride; commit(); show('appearance') })
      $$('[data-k]', pane).forEach(i => i.addEventListener('input', () => { settings.theme[i.dataset.k] = +i.value; commit() }))
      $$('[data-mode]', pane).forEach(b => b.addEventListener('click', () => { settings.theme.mode = b.dataset.mode; commit(); show('appearance') }))
      $('#ap-perf', pane).addEventListener('change', e => { settings.theme.perf = e.target.checked; commit() })
    } else if (k === 'activity') {
      const a = settings.activity
      pane.innerHTML = `
        <div class="form">
          <label class="check"><input type="checkbox" id="act-en" ${a.enabled ? 'checked' : ''}> Oynadığım oyunu ve dinlediğim müziği profilimde göster</label>
          <div class="act-now">${S.myAct ? activityBlock(S.myAct) : '<span class="muted">Şu an bir oyun ya da çalan şarkı algılanmadı.</span>'}</div>
          <p class="muted small">Oyunlar; bilinen oyunlar listesinden ve Steam, Epic, GOG, Riot kurulum klasörlerinden otomatik tanınır. Müzik: Spotify (Windows ve macOS) ve Apple Music (macOS). Simgeler bilgisayarındaki uygulamanın kendi simgesidir. macOS ilk seferde Spotify'ı okumak için izin isteyebilir. Etkinliğin yalnızca sunucu üyelerine ve arkadaşlarına gider.</p>
          <h4>Kendi oyunlarını ekle</h4>
          <p class="muted small">Bir oyun algılanmıyorsa Görev Yöneticisi'nde (macOS'ta Etkinlik Monitörü) görünen süreç adını yaz.</p>
          <div class="cg-list">${a.custom.map((c, i) => `<div class="cg-row"><code>${esc(c.exe)}</code><span>→</span><b>${esc(c.name)}</b><button class="mini" data-cg-del="${i}">${icon('x', 14)}</button></div>`).join('') || '<span class="muted small">Henüz özel oyun yok.</span>'}</div>
          <div class="row gap"><input id="cg-exe" placeholder="ornek-oyun.exe"><input id="cg-name" placeholder="Görünecek ad"><button class="btn small" id="cg-add">Ekle</button></div>
        </div>`
      const push = async () => { saveSettings(); S.myAct = await api.activityConfig(a).catch(() => S.myAct); renderMeCard() }
      $('#act-en', pane).addEventListener('change', e => { a.enabled = e.target.checked; push() })
      $('#cg-add', pane).addEventListener('click', () => {
        const exe = $('#cg-exe', pane).value.trim(); const name = $('#cg-name', pane).value.trim()
        if (!exe || !name) return toast('Süreç adı ve görünecek ad gerekli.')
        a.custom.push({ exe, name }); push(); show('activity')
      })
      $$('[data-cg-del]', pane).forEach(b => b.addEventListener('click', () => { a.custom.splice(+b.dataset.cgDel, 1); push(); show('activity') }))
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
        testCtx = new AudioContext()
        const an = testCtx.createAnalyser()
        testCtx.createMediaStreamSource(testStream).connect(an)
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
          <p class="muted small">Ekran paylaşımı eşler arası doğrudan gönderilir ve yalnızca "Yayını İzle" diyen kişilere gider; izleyen yoksa bilgisayarın kodlama yapmaz. Her izleyici için ayrı bir akış yüklenir: 1080p60'ta 3 izleyici ≈ 27 Mbps yükleme hızı gerektirir. Oyunda takılma olursa 1080p30 veya 720p seç. Mümkünse donanım hızlandırmalı H.264 kullanılır.</p>
          ${S.platform === 'win32' ? `
            <label class="check"><input type="checkbox" id="sc-audio" ${settings.screenAudio ? 'checked' : ''}> Tüm ekran paylaşılırken sistem sesini de paylaş</label>
            <p class="muted small">Yankı koruması: YANKI'nın kendi çaldığı sesler (sohbetteki diğer kişiler, müzik botu) yayından çıkarılır; izleyenler kendi seslerini duymaz. Sistem bunu desteklemezse ekran otomatik olarak sessiz paylaşılır.</p>
            <label class="check"><input type="checkbox" id="sc-echo" ${settings.allowEchoAudio ? 'checked' : ''}> Yankı koruması çalışmasa da sistem sesini paylaş (önerilmez)</label>`
          : '<p class="muted small">macOS: İlk paylaşımda Sistem Ayarları › Gizlilik ve Güvenlik › Ekran Kaydı izni gerekir. Sistem sesi paylaşımı macOS\'ta desteklenmez.</p>'}
        </div>`
      $('#sc-q', pane).addEventListener('change', e => { settings.screenQuality = e.target.value; saveSettings() })
      $('#sc-audio', pane)?.addEventListener('change', e => { settings.screenAudio = e.target.checked; saveSettings() })
      $('#sc-echo', pane)?.addEventListener('change', e => { settings.allowEchoAudio = e.target.checked; saveSettings() })
    } else if (k === 'notify') {
      pane.innerHTML = `
        <div class="form">
          <label>Sunucu mesajları için masaüstü bildirimi<select id="nt-mode">
            <option value="all" ${settings.notify === 'all' ? 'selected' : ''}>Tüm mesajlar</option>
            <option value="mentions" ${settings.notify === 'mentions' ? 'selected' : ''}>Yalnızca benden bahsedildiğinde (@ad, @herkes)</option>
            <option value="none" ${settings.notify === 'none' ? 'selected' : ''}>Kapalı</option>
          </select></label>
          <p class="muted small">Özel mesajlar ve arkadaşlık istekleri için "Kapalı" seçilmedikçe her zaman bildirim gelir.</p>
          <label class="check"><input type="checkbox" id="nt-sound" ${settings.sounds ? 'checked' : ''}> Mesaj sesi çal</label>
          <h4>Pencere</h4>
          <label class="check"><input type="checkbox" id="nt-tray" ${settings.closeToTray !== false ? 'checked' : ''}> Pencereyi kapatınca YANKI arka planda çalışmaya devam etsin</label>
          <p class="muted small">${S.platform === 'darwin' ? 'Tamamen kapatmak için menü çubuğundaki YANKI simgesinden "Çıkış"ı seç ya da ⌘Q kullan.' : 'YANKI görev çubuğunun sağındaki simgelere iner. Tamamen kapatmak için oradaki YANKI simgesine sağ tıklayıp "Çıkış"ı seç.'}</p>
        </div>`
      $('#nt-mode', pane).addEventListener('change', e => { settings.notify = e.target.value; saveSettings() })
      $('#nt-sound', pane).addEventListener('change', e => { settings.sounds = e.target.checked; saveSettings() })
      $('#nt-tray', pane).addEventListener('change', e => { settings.closeToTray = e.target.checked; saveSettings(); api.setCloseToTray?.(settings.closeToTray) })
    } else if (k === 'net') {
      pane.innerHTML = `
        <div class="form">
          <h4>Kimliğin ve arkadaş kodun</h4>
          <div class="invite-box"><code>yanki://arkadas/${S.me}</code><button class="btn small" id="net-copy">${icon('copy', 15)}</button></div>
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
      $('#net-copy', pane).addEventListener('click', () => copyText('yanki://arkadas/' + S.me, 'Arkadaş kodun kopyalandı'))
      $('#net-prev', pane).addEventListener('change', e => { settings.linkPreviews = e.target.checked; saveSettings(); renderMessages() })
      $('#net-save', pane).addEventListener('click', () => { settings.turnUrl = $('#net-turn', pane).value.trim(); settings.turnUser = $('#net-tu', pane).value; settings.turnPass = $('#net-tp', pane).value; saveSettings(); toast('Kaydedildi — sonraki ses bağlantısında geçerli.') })
    } else if (k === 'about') {
      pane.innerHTML = `
        <div class="about">
          <img class="about-mark" src="assets/mark.svg" alt="">
          <img class="hero-word" src="assets/word.svg" alt="YANKI">
          <p>Merkezi sunucusuz, eşler arası (P2P) topluluk ve haberleşme uygulaması.${S.version ? ` Sürüm ${esc(S.version)}` : ''}</p>
          <ul class="muted small">
            <li>Eş keşfi: Hyperswarm DHT + NAT delme (UDP hole-punching)</li>
            <li>Taşıma: Noise protokolüyle uçtan uca şifreli akışlar</li>
            <li>Veri: ed25519 imzalı, değişmez olay günlüğü; her üyede tam kopya</li>
            <li>Özel mesajlar: yalnızca iki kişi arasında, üçüncü eşlere hiç gitmez</li>
            <li>Ses/Görüntü/Ekran: WebRTC (DTLS-SRTP), mesh topoloji</li>
          </ul>
          <div class="usage-note">
            <b>Kullanım notu</b>
            <p>YANKI ücretsizdir ve MIT lisansıyla, "olduğu gibi" sunulur; hiçbir garanti verilmez ve geliştiriciler kullanımdan doğan zararlardan sorumlu tutulamaz.</p>
            <p>YANKI'nın merkezi bir sunucusu yoktur; mesajlar geliştiricinin değil, yalnızca kullanıcıların bilgisayarları arasında dolaşır. Paylaştığın her içerikten (mesaj, resim, bağlantı, yayın) sen sorumlusun. Yasa dışı, başkalarının haklarını ihlal eden ya da telifli içerik paylaşma. Sunucu sahipleri ve yöneticiler, kendi sunucularındaki uygunsuz içeriği kaldırmalı ve paylaşanları uzaklaştırmalıdır.</p>
          </div>
          <div class="row gap center-x wrap">
            <button class="btn small primary" id="ab-update">${icon('download', 15)} Güncellemeleri denetle</button>
            <button class="btn small" id="ab-new">${icon('sparkle', 15)} Yenilikleri göster</button>
          </div>
          <p class="muted small">Klavye: Ctrl/⌘+Shift+M sustur · Ctrl/⌘+Shift+D sağırlaştır · Ctrl/⌘+K hızlı geçiş · Esc iptal · @ bahset</p>
        </div>`
      $('#ab-update', pane).addEventListener('click', checkForUpdates)
      $('#ab-new', pane).addEventListener('click', () => showWhatsNew())
    }
  }
  $$('nav button', body).forEach(b => b.addEventListener('click', () => show(b.dataset.tab)))
  show(tab)
}

// ---------- Hızlı geçiş (Ctrl+K) ----------
function quickSwitcher () {
  const all = []
  for (const d of S.dms) if (d.status === 'friends' || d.lastTs) all.push({ dm: d.key, name: nameOf(d.key), sub: 'Özel mesaj' })
  for (const s of S.servers) {
    const m = S.meta.get(s.id)
    if (!m || m.pending) continue
    for (const c of m.channels) all.push({ s, c, name: c.name, sub: s.name })
  }
  const body = el('<div class="qs"><input id="qs-in" placeholder="Kanal, sunucu ya da arkadaş ara…"><div class="qs-list"></div></div>')
  const mdl = openModal({ body, cls: 'qs-modal' })
  let idx = 0
  let found = []
  const draw = () => {
    const q = $('#qs-in', body).value.toLowerCase()
    found = all.filter(x => !q || x.name.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q)).slice(0, 12)
    idx = Math.min(idx, Math.max(0, found.length - 1))
    $('.qs-list', body).innerHTML = found.map((x, i) => `<button class="qs-item ${i === idx ? 'on' : ''}" data-i="${i}">${x.dm ? avatar(x.dm, 18) : icon(x.c.kind === 'voice' ? 'volume' : 'hash', 16)} ${esc(x.name)} <small>${esc(x.sub)}</small></button>`).join('')
  }
  const go = async (x) => {
    if (!x) return
    mdl.close()
    if (x.dm) return openDM(x.dm)
    if (S.mode !== 'server' || S.server !== x.s.id) await selectServer(x.s.id)
    selectChannel(x.c.id)
  }
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
  openPopup(`<div class="pins"><h4>Sabitlenmiş mesajlar</h4>${list.length ? list.map(x => `<button class="pin-item" data-act="jump" data-id="${x.id}"><b>${esc(nameOf(x.author))}</b><span>${esc(plainText(x.text).slice(0, 160) || '📷 Resim')}</span></button>`).join('') : '<p class="muted small">Bu kanalda (yüklü mesajlar arasında) sabitlenmiş mesaj yok.</p>'}</div>`, anchor, { align: 'below', cls: 'pins-pop' })
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
  const fmtIcons = { '**': 'bold', '*': 'italic', '~~': 'strike', '||': 'eye', '`': 'code' }
  $$('[data-fmt]').forEach(b => { b.innerHTML = icon(fmtIcons[b.dataset.fmt], 18) })
  $('#btn-attach').innerHTML = icon('paperclip', 19)
  $('#btn-emoji').innerHTML = icon('smile', 19)
  $('#btn-send').innerHTML = icon('send', 19)
  $('#btn-poll').innerHTML = icon('poll', 19)
  $('#btn-poll').addEventListener('click', openPollCreator)

  $$('[data-fmt]').forEach(b => b.addEventListener('click', () => wrapSelection(b.dataset.fmt)))
  $('#btn-attach').addEventListener('click', () => $('#file-input').click())
  $('#file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = '' })
  $('#btn-emoji').addEventListener('click', (e) => emojiPicker(e.currentTarget, (em) => { const t = $('#input'); t.setRangeText(em, t.selectionStart, t.selectionEnd, 'end'); t.focus() }))
  $('#btn-send').addEventListener('click', send)

  const input = $('#input')
  input.addEventListener('input', onTyping)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !$('#cmd-hints').hidden) { e.preventDefault(); $('#cmd-hints .cmd')?.click(); return }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
    if (e.key === 'Escape') { if (S.editing) { S.editing = null; input.value = ''; autoGrow() } S.reply = null; $('#cmd-hints').hidden = true; renderComposerState(); renderMessages() }
    if (e.key === 'ArrowUp' && !input.value) {
      const mine = [...S.msgs].reverse().find(x => x.author === S.me && x.text && !x.poll)
      if (mine) { e.preventDefault(); startEdit(mine.id) }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrapSelection('**') }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); wrapSelection('*') }
  })
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'))
    if (files.length) { e.preventDefault(); addFiles(files) }
  })

  let dragDepth = 0
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files') && chatCtx()) { dragDepth++; $('#drop-overlay').hidden = false } })
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true } })
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    dragDepth = 0
    $('#drop-overlay').hidden = true
    if (chatCtx() && e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files])
  })

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

  document.addEventListener('click', onClick)
  document.addEventListener('dblclick', (e) => {
    const mem = e.target.closest('#members .mem[data-key]')
    if (mem) {
      closePopup()
      if (mem.dataset.key !== S.me) openMiniDM(mem.dataset.key)
      return
    }
    const t = e.target.closest('.tile')
    if (t && !t.classList.contains('music') && $('video', t) && !e.target.closest('button')) toggleFullscreen(t)
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderAll(); if (chatCtx()) reloadMessages('cur') } })
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) renderStage() })
}

function startEdit (id) {
  const msg = S.msgs.find(x => x.id === id)
  if (!msg) return
  S.editing = id
  S.reply = null
  const t = $('#input')
  t.value = mentionsToNames(msg.text)
  autoGrow()
  t.focus()
  renderComposerState()
  renderMessages()
}

function toggleFullscreen (node) {
  if (!node) return
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  else node.requestFullscreen?.().catch(() => {})
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
  const key = a.dataset.key
  switch (act) {
    case 'home': goHome(); break
    case 'home-friends': S.dm = null; renderAll(); break
    case 'home-tab': S.homeTab = a.dataset.tab; if (S.homeTab === 'blocked') S.blocked = await api.blockedList(); S.dm = null; renderAll(); break
    case 'home-add': S.mode = 'home'; S.dm = null; S.homeTab = 'add'; renderAll(); setTimeout(() => $('#af-code')?.focus(), 30); break
    case 'open-dm': e.stopPropagation(); closePopup(); startDM(key); break
    case 'friend-more': e.stopPropagation(); friendMoreMenu(key, a); break
    case 'friend-add': case 'friend-accept': case 'friend-decline': case 'unblock': e.stopPropagation(); closePopup(); friendAction(act, key); break
    case 'friend-send': sendFriendCode(); break
    case 'copy-friend-code': copyText('yanki://arkadas/' + S.me, 'Arkadaş kodun kopyalandı — arkadaşına gönder!'); break
    case 'copy-key': copyText('yanki://arkadas/' + key, 'Arkadaş kodu kopyalandı'); break
    case 'server': if (S.mode !== 'server' || id !== S.server) await selectServer(id); break
    case 'add-server': case 'create-server': case 'join-server': openAddServer(); break
    case 'leave-server': leaveServer(); break
    case 'server-menu': serverMenu(a); break
    case 'toggle-cat': S.collapsed[id] = !S.collapsed[id]; save('collapsed', S.collapsed); renderSidebar(); break
    case 'channel': if (!e.target.closest('.ch-edit')) await selectChannel(id); break
    case 'new-channel': e.stopPropagation(); channelModal(null, a.dataset.cat); break
    case 'edit-channel': e.stopPropagation(); channelModal(id); break
    case 'edit-cat': categoryModal(id); break
    case 'user': if (e.target.closest('.fr-actions')) break; e.stopPropagation(); openProfileCard(key, a); break
    case 'bot': e.stopPropagation(); openBotCard(id, a); break
    case 'bots-admin': closePopup(); openBotsModal(); break
    case 'my-profile': openProfileCard(S.me, a); break
    case 'settings': openSettings('profile'); break
    case 'toggle-members': S.showMembers = !S.showMembers; save('showMembers', S.showMembers); renderLayout(); renderMembers(); renderHeader(); break
    case 'toggle-view':
      if (voice.active && (S.mode !== 'server' || voice.server !== S.server)) await selectServer(voice.server)
      S.view = S.view === 'stage' ? 'chat' : 'stage'
      renderAll()
      if (S.view === 'chat') { S._scrollBottomNext = true; renderMessages(true) }
      break
    case 'goto-voice':
      if (S.mode !== 'server' || voice.server !== S.server) await selectServer(voice.server)
      S.view = 'stage'; renderAll(); break
    case 'mute': voice.toggleMute(); renderMeCard(); break
    case 'deafen': voice.toggleDeafen(); renderMeCard(); break
    case 'camera': voice.toggleCamera(); break
    case 'screen': if (voice.screen) voice.stopScreen(); else openScreenPicker(); break
    case 'music': openMusicPanel(a); break
    case 'music-add': { const inp = $('#mp-url'); if (inp && await musicAdd(inp.value)) inp.value = ''; break }
    case 'music-skip': musicSkip(); break
    case 'music-stop': musicStop(); break
    case 'music-remove': musicSkip(id); break
    case 'hangup': voice.leave(); S.view = 'chat'; S.focusTile = null; renderAll(); break
    case 'tile-full': toggleFullscreen(a.closest('.tile')); break
    case 'watch':
      e.stopPropagation()
      if (voice.active && (S.mode !== 'server' || voice.server !== S.server)) await selectServer(voice.server)
      voice.watch(key)
      S.view = 'stage'
      S.focusTile = 'screen:' + key
      renderAll()
      break
    case 'unwatch':
      e.stopPropagation()
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
      voice.unwatch(key)
      if (S.focusTile === 'screen:' + key) S.focusTile = null
      renderStage()
      break
    case 'peer-reconnect': e.stopPropagation(); voice.reconnect(key); toast('Bağlantı yeniden kuruluyor…', 2000); break
    case 'update': openUpdateModal(); break
    case 'pins': pinsPopup(a); break
    case 'open-link': e.preventDefault(); api.openExternal(a.dataset.url); break
    case 'spoiler': a.classList.add('revealed'); break
    case 'lightbox': lightbox(a.getAttribute('src')); break
    case 'cmd-fill': { const t = $('#input'); t.value = a.dataset.cmd; t.focus(); renderCmdHints(); autoGrow(); break }
    case 'yt-play': {
      const vid = a.dataset.yt
      a.outerHTML = `<div class="embed yt playing"><iframe src="https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="YouTube"></iframe></div>`
      break
    }
    case 'reply': S.reply = id; S.editing = null; renderComposerState(); $('#input').focus(); break
    case 'cancel-reply': S.reply = null; renderComposerState(); break
    case 'cancel-edit': S.editing = null; $('#input').value = ''; autoGrow(); renderComposerState(); renderMessages(); break
    case 'edit': startEdit(id); break
    case 'copy': { const msg = S.msgs.find(x => x.id === id); if (msg) copyText(plainText(msg.text)); break }
    case 'delete':
      if (e.shiftKey || await confirmModal('Mesajı sil', 'Bu mesaj herkes için silinecek. (İpucu: Shift+tık ile onaysız sil)', 'Sil')) await postCtx('message-delete', { target: id })
      if (S.mode === 'home') loadMessages()
      break
    case 'pin': {
      const ch = curMeta()?.channels.find(c => c.id === S.channel)
      await api.post(S.server, 'pin', { target: id, on: !(ch?.pins || []).includes(id) })
      break
    }
    case 'react': {
      const msg = S.msgs.find(x => x.id === id)
      const on = !(msg?.reactions?.[a.dataset.emoji] || []).includes(S.me)
      await postCtx('reaction', { target: id, emoji: a.dataset.emoji, on })
      if (S.mode === 'home') loadMessages()
      break
    }
    case 'vote': {
      const msg = S.msgs.find(x => x.id === id)
      const opt = +a.dataset.opt
      await postCtx('poll-vote', { target: id, option: msg?.poll?.mine === opt ? -1 : opt })
      if (S.mode === 'home') loadMessages()
      break
    }
    case 'react-pick': emojiPicker(a, async (em) => { const msg = S.msgs.find(x => x.id === id); const on = !(msg?.reactions?.[em] || []).includes(S.me); await postCtx('reaction', { target: id, emoji: em, on }); if (S.mode === 'home') loadMessages() }); break
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
  const msgNode = e.target.closest('.msg[data-id]')
  const ch = e.target.closest('.ch')
  const srv = e.target.closest('.rail-item[data-id]')
  const userEl = e.target.closest('[data-act="user"], [data-act="open-dm"]')
  if (msgNode) {
    e.preventDefault()
    const id = msgNode.dataset.id
    const msg = S.msgs.find(x => x.id === id)
    if (!msg) return
    const items = [
      { label: 'Yanıtla', icon: 'reply', onClick: () => { S.reply = id; renderComposerState(); $('#input').focus() } },
      { label: 'Metni kopyala', icon: 'copy', onClick: () => copyText(plainText(msg.text)) }
    ]
    if (msg.author === S.me && !msg.poll && !msg.locked) items.push({ label: 'Düzenle', icon: 'edit', onClick: () => startEdit(id) })
    if (msg.author === S.me || curMeta()?.isAdmin) items.push('-', { label: 'Sil', icon: 'trash', danger: true, onClick: () => postCtx('message-delete', { target: id }).then(() => S.mode === 'home' && loadMessages()) })
    menu(items, pointAnchor(e), { align: 'below' })
  } else if (userEl && userEl.dataset.key && userEl.dataset.key !== S.me) {
    e.preventDefault()
    const key = userEl.dataset.key
    const st = friendStatusOf(key)
    const items = [{ label: 'Mesaj gönder', icon: 'chat', onClick: () => startDM(key) }]
    if (st === 'none') items.push({ label: 'Arkadaş ekle', icon: 'userPlus', onClick: () => friendAction('friend-add', key) })
    if (st === 'incoming') items.push({ label: 'İsteği kabul et', icon: 'check', onClick: () => friendAction('friend-accept', key) })
    if (st === 'friends') items.push({ label: 'Arkadaşlıktan çıkar', icon: 'userX', danger: true, onClick: () => friendAction('friend-remove', key) })
    items.push('-', { label: 'Engelle', icon: 'ban', danger: true, onClick: () => friendAction('block', key) })
    menu(items, pointAnchor(e), { align: 'below' })
  } else if (ch && S.mode === 'server' && curMeta()?.isAdmin) {
    e.preventDefault()
    menu([{ label: 'Kanalı düzenle', icon: 'settings', onClick: () => channelModal(ch.dataset.id) }, { label: 'Botlar', icon: 'bot', onClick: openBotsModal }], pointAnchor(e), { align: 'below' })
  } else if (srv) {
    e.preventDefault()
    const sm = S.meta.get(srv.dataset.id)
    if (sm?.isAdmin) menu([{ label: 'Davet et', icon: 'userPlus', onClick: async () => { if (S.server !== srv.dataset.id || S.mode !== 'server') await selectServer(srv.dataset.id); openInviteModal() } }], pointAnchor(e), { align: 'below' })
  }
}

init().catch(e => { console.error(e); document.body.innerHTML = `<pre style="color:#f88;padding:24px">Başlatma hatası:\n${esc(e.stack || e)}</pre>` })
