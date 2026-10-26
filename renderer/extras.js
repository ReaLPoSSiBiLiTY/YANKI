'use strict'
/* global icon, api, S, settings, saveSettings, $, $$, esc, el, load, save, toast, avatar, avatarFull, nameOf, colorOf, profileOf, md, safeImg, hashColor,
   curMeta, member, openModal, confirmModal, closePopup, menu, fmtHM, voice, isOnline, friendOf, friendButton, chatCtx, renderSidebar, renderRail, renderMembers,
   renderComposerState, refreshMeta, openDM, autoGrow, availableCommands, postCtx, loadMessages, CHANGELOG, renderAll */
// v1.2 eklemeleri: @bahsetme, anket oluşturucu, mini özel mesaj penceresi, gruplar,
// güncelleme ve "Yenilikler" ekranları.

// =====================================================================
// @bahsetme
// =====================================================================
// Mesaj metninde bahsedilen kişi <@anahtar> olarak saklanır; ad değişse de doğru kişiyi gösterir.
const MENTION_TOKEN = /<@([0-9a-f]{64})>/g
const mentionMap = new Map() // "@Ad" -> anahtar (bu oturumda seçilenler)
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Bildirim, önizleme, kopyalama için okunur metin
function plainText (t) { return String(t || '').replace(MENTION_TOKEN, (_, k) => '@' + nameOf(k)) }

// Düzenlemeye açılırken <@anahtar> -> @Ad
function mentionsToNames (t) {
  return String(t || '').replace(MENTION_TOKEN, (_, k) => { const n = nameOf(k); mentionMap.set(n, k); return '@' + n })
}

// Bağlamdaki bahsedilebilecek kişiler
function mentionPool () {
  const c = chatCtx()
  if (!c) return []
  if (c.kind === 'dm') return [{ key: c.key, online: isOnline(c.key) }]
  const m = curMeta()
  const ch = m?.channels?.find(x => x.id === c.channel)
  if (!m || !ch) return []
  return m.members.filter(x => !ch.groups?.length || x.admin || (x.groups || []).some(g => ch.groups.includes(g)))
}

// Gönderirken @Ad -> <@anahtar>
function namesToMentions (text) {
  const names = new Map(mentionMap)
  const seen = new Map()
  for (const x of mentionPool()) {
    const n = nameOf(x.key)
    seen.set(n, seen.has(n) ? null : x.key) // aynı adlı iki kişi varsa tahmin etme
  }
  for (const [n, k] of seen) if (k && !names.has(n)) names.set(n, k)
  const list = [...names].sort((a, b) => b[0].length - a[0].length)
  for (const [n, k] of list) {
    if (!n) continue
    text = text.replace(new RegExp('(^|[\\s(])@' + escRe(n) + '(?![\\p{L}\\p{N}_])', 'gu'), (_, pre) => pre + '<@' + k + '>')
  }
  return text
}

const MQ = { open: false, start: 0, items: [], idx: 0 }

function mentionQuery () {
  const t = $('#input')
  const pos = t.selectionStart
  if (pos !== t.selectionEnd) return null
  const before = t.value.slice(0, pos)
  const m = before.match(/(?:^|[\s(])@([^\s@<>]{0,32})$/u)
  if (!m) return null
  return { q: m[1], start: pos - m[1].length - 1 }
}

function renderMentionHints () {
  const box = $('#mention-hints')
  const mq = chatCtx() ? mentionQuery() : null
  if (!mq) { closeMentions(); return }
  const q = mq.q.toLocaleLowerCase('tr')
  const pool = mentionPool().filter(x => x.key !== S.me)
  const scored = pool.map(x => ({ x, n: nameOf(x.key), l: nameOf(x.key).toLocaleLowerCase('tr') }))
    .filter(o => !q || o.l.includes(q))
    .sort((a, b) => (b.l.startsWith(q) - a.l.startsWith(q)) || (!!b.x.online - !!a.x.online) || a.n.localeCompare(b.n, 'tr'))
    .slice(0, 8)
  const items = []
  if (chatCtx().kind === 'channel' && (!q || 'herkes'.startsWith(q) || 'everyone'.startsWith(q))) items.push({ all: true })
  for (const o of scored) items.push({ key: o.x.key, name: o.n, online: o.x.online })
  if (!items.length) { closeMentions(); return }
  MQ.open = true
  MQ.start = mq.start
  MQ.items = items
  MQ.idx = Math.min(MQ.idx, items.length - 1)
  box.hidden = false
  box.innerHTML = '<div class="cmd-title">Bahset</div>' + items.map((it, i) => it.all
    ? `<button class="mh ${i === MQ.idx ? 'on' : ''}" data-mi="${i}"><span class="mh-all">@</span><b>@herkes</b><span class="muted">Kanaldaki herkese bildirim gönderir</span></button>`
    : `<button class="mh ${i === MQ.idx ? 'on' : ''}" data-mi="${i}">${avatarFull(it.key, 24, { online: !!it.online, badge: false })}<b ${colorOf(it.key) ? `style="color:${colorOf(it.key)}"` : ''}>${esc(it.name)}</b><span class="muted">${it.online ? 'Çevrim içi' : 'Çevrimdışı'}</span></button>`).join('')
}

function closeMentions () {
  MQ.open = false
  MQ.idx = 0
  const box = $('#mention-hints')
  if (box) { box.hidden = true; box.innerHTML = '' }
}

function pickMention (i) {
  const it = MQ.items[i]
  if (!it) return
  const t = $('#input')
  const label = it.all ? 'herkes' : it.name
  if (!it.all) mentionMap.set(it.name, it.key)
  t.setRangeText('@' + label + ' ', MQ.start, t.selectionStart, 'end')
  t.focus()
  closeMentions()
  autoGrow()
}

function bindMentions () {
  const t = $('#input')
  // Hedef öğedeki "capture" dinleyicisi uygulamanın kendi tuş dinleyicisinden önce çalışır
  t.addEventListener('keydown', (e) => {
    if (!MQ.open) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopImmediatePropagation()
      MQ.idx = (MQ.idx + (e.key === 'ArrowDown' ? 1 : -1) + MQ.items.length) % MQ.items.length
      renderMentionHints()
    } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      e.preventDefault(); e.stopImmediatePropagation()
      pickMention(MQ.idx)
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation()
      closeMentions()
    }
  }, true)
  t.addEventListener('input', () => { MQ.idx = 0; renderMentionHints() })
  t.addEventListener('click', renderMentionHints)
  t.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== t) closeMentions() }, 150))
  $('#mention-hints').addEventListener('mousedown', (e) => {
    const b = e.target.closest('[data-mi]')
    if (b) { e.preventDefault(); pickMention(+b.dataset.mi) }
  })
}

// Okunmamış bahsetme sayaçları (kanal ve sunucu yanında)
S.mentions = load('mentions', {})
function addMention (k) { S.mentions[k] = (S.mentions[k] || 0) + 1; save('mentions', S.mentions) }
function clearMention (k) { if (S.mentions[k]) { delete S.mentions[k]; save('mentions', S.mentions) } }
const mentionCount = (k) => S.mentions[k] || 0
const serverMentions = (serverId) => Object.entries(S.mentions).reduce((n, [k, v]) => n + (k.startsWith(serverId + ':') ? v : 0), 0)

// =====================================================================
// Anket oluşturucu
// =====================================================================
function canPoll () { return availableCommands().some(c => c[0] === 'poll') }

function openPollCreator () {
  const body = el(`
    <div class="form poll-make">
      <label>Soru<input id="pm-q" maxlength="200" placeholder="ör. Bu akşam ne oynayalım?"></label>
      <div class="pm-opts"></div>
      <button class="btn small" id="pm-add" type="button">${icon('plus', 15)} Seçenek ekle</button>
      <div class="pm-kind">
        <label class="pm-card"><input type="radio" name="pm-kind" value="anon" checked><span>${icon('eyeOff', 20)}<b>Gizli anket</b><small>Yalnızca oy sayıları görünür.</small></span></label>
        <label class="pm-card"><input type="radio" name="pm-kind" value="public"><span>${icon('eye', 20)}<b>Açık anket</b><small>Kimin hangi seçeneğe oy verdiği görünür.</small></span></label>
      </div>
    </div>`)
  const opts = $('.pm-opts', body)
  const addOpt = (v = '') => {
    if ($$('input', opts).length >= 10) return toast('En fazla 10 seçenek.')
    const row = el(`<div class="pm-opt"><input maxlength="80" placeholder="Seçenek ${$$('input', opts).length + 1}" value="${esc(v)}"><button class="mini" type="button" title="Kaldır">${icon('x', 14)}</button></div>`)
    $('button', row).addEventListener('click', () => { if ($$('input', opts).length > 2) row.remove() })
    $('input', row).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOpt(); $$('input', opts).at(-1).focus() } })
    opts.appendChild(row)
  }
  addOpt(); addOpt()
  $('#pm-add', body).addEventListener('click', () => { addOpt(); $$('input', opts).at(-1).focus() })
  openModal({
    title: 'Anket oluştur',
    body,
    actions: [{ label: 'Vazgeç' }, {
      label: 'Anketi gönder',
      kind: 'primary',
      onClick: async (node) => {
        const question = $('#pm-q', node).value.trim()
        const options = $$('.pm-opt input', node).map(i => i.value.trim()).filter(Boolean)
        if (!question) { toast('Bir soru yaz.'); return false }
        if (options.length < 2) { toast('En az iki seçenek gerekli.'); return false }
        const pub = $('input[name=pm-kind]:checked', node).value === 'public'
        await postCtx('message', { text: '', attachments: [], poll: { question, options, public: pub } })
        S._scrollBottomNext = true
        await loadMessages(true)
      }
    }]
  })
}

// =====================================================================
// Mini özel mesaj penceresi (açık ekranı değiştirmeden)
// =====================================================================
S.mini = null // { key, min, msgs, allowed }

// Sunucudayken küçük pencere, ana sayfadayken tam görünüm
function startDM (key) {
  if (!key || key === S.me) return
  if (S.mode === 'home') { closeMiniDM(); return openDM(key) }
  openMiniDM(key)
}

async function openMiniDM (key) {
  if (S.mini?.key !== key) S.mini = { key, min: false, msgs: [], allowed: true }
  else S.mini.min = false
  buildMiniDM()
  S.mini.allowed = await api.canDM(key).catch(() => false)
  await loadMini(true)
  $('#md-input')?.focus()
}

function closeMiniDM () {
  S.mini = null
  const box = $('#mini-dm')
  box.hidden = true
  box.innerHTML = ''
}

function buildMiniDM () {
  const box = $('#mini-dm')
  const k = S.mini.key
  box.hidden = false
  box.classList.toggle('min', !!S.mini.min)
  box.innerHTML = `
    <div class="md-head" data-md="toggle">
      ${avatarFull(k, 30, { online: isOnline(k), badge: false })}
      <div class="md-title"><b ${colorOf(k) ? `style="color:${colorOf(k)}"` : ''}>${esc(nameOf(k))}</b><small>${isOnline(k) ? 'Çevrim içi' : 'Çevrimdışı'}</small></div>
      <span class="md-unread" hidden></span>
      <button class="mini" data-md="full" title="Tam görünümde aç">${icon('maximize', 15)}</button>
      <button class="mini" data-md="min" title="${S.mini.min ? 'Aç' : 'Küçült'}">${icon(S.mini.min ? 'chevronUp' : 'chevronDown', 16)}</button>
      <button class="mini" data-md="close" title="Kapat">${icon('x', 16)}</button>
    </div>
    <div class="md-body"></div>
    <div class="md-foot">
      <textarea id="md-input" rows="1" maxlength="4000" placeholder="@${esc(nameOf(k))} kişisine mesaj"></textarea>
      <button class="tool send" data-md="send" title="Gönder">${icon('send', 17)}</button>
    </div>`
  const inp = $('#md-input', box)
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMini() }
    if (e.key === 'Escape') { e.stopPropagation(); S.mini.min = true; buildMiniDM(); renderMiniBody() }
  })
  let lastTyping = 0
  inp.addEventListener('input', () => {
    inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px'
    if (inp.value.trim() && Date.now() - lastTyping > 3000) { lastTyping = Date.now(); api.dmTyping(k) }
  })
  inp.addEventListener('paste', async (e) => {
    const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'))
    if (!f) return
    e.preventDefault()
    toast('Resim göndermek için tam görünümü aç.')
  })
}

async function loadMini (bottom = false) {
  const m = S.mini
  if (!m) return
  const list = await api.dmMessages(m.key, { limit: 60 }).catch(() => [])
  if (S.mini !== m) return
  m.msgs = list
  renderMiniBody(bottom)
  if (!m.min && document.hasFocus()) markMiniRead()
}

function markMiniRead () {
  const d = friendOf(S.mini?.key)
  const k = 'dm:' + S.mini.key
  const ts = d?.lastTs || Date.now()
  if ((S.lastRead[k] || 0) < ts) { S.lastRead[k] = ts; save('lastRead', S.lastRead); setTimeout(renderRail, 30) }
}

function renderMiniBody (bottom = false) {
  const box = $('#mini-dm .md-body')
  if (!box || !S.mini) return
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80
  const k = S.mini.key
  if (!S.mini.allowed) {
    box.innerHTML = `<div class="md-lock">${icon('userPlus', 22)}<p>Mesajlaşmak için arkadaş olmanız ya da ortak bir sunucuda bulunmanız gerekir.</p>${friendButton(k)}</div>`
    $('#mini-dm .md-foot').hidden = true
    return
  }
  $('#mini-dm .md-foot').hidden = false
  if (!S.mini.msgs.length) {
    box.innerHTML = `<div class="md-empty">${avatarFull(k, 54, { badge: false })}<p><b>${esc(nameOf(k))}</b> ile özel sohbetin. Mesajlar yalnızca ikinizin arasında, şifreli gider.</p></div>`
    return
  }
  let prev = null
  box.innerHTML = S.mini.msgs.map(x => {
    const own = x.author === S.me
    const grouped = prev && prev.author === x.author && x.ts - prev.ts < 5 * 60000
    prev = x
    let content = ''
    if (x.poll) content = `<div class="md-poll">${icon('poll', 14)} <b>${esc(x.poll.question)}</b><button class="link-like small" data-md="full">Oy vermek için aç</button></div>`
    else if (x.text) content = `<div class="md-text">${md(x.text)}</div>`
    const imgs = (x.attachments || []).map(a => safeImg(a.data) ? `<img src="${a.data}" alt="" data-act="lightbox">` : '').join('')
    const bot = x.bot?.id === 'dice' && x.bot.rolls ? `<div class="md-text muted">🎲 ${esc(x.bot.expr)} = <b>${x.bot.total}</b></div>` : ''
    return `<div class="md-msg ${own ? 'own' : ''} ${grouped ? 'grouped' : ''}" title="${esc(fmtHM(x.ts))}">${!own && !grouped ? avatar(x.author, 22) : '<span class="md-sp"></span>'}<div class="md-bubble">${content}${imgs ? `<div class="md-imgs">${imgs}</div>` : ''}${bot}</div></div>`
  }).join('')
  if (bottom || near) box.scrollTop = box.scrollHeight
  for (const img of $$('img', box)) img.addEventListener('load', () => { if (bottom || near) box.scrollTop = box.scrollHeight }, { once: true })
}

async function sendMini () {
  const inp = $('#md-input')
  const text = inp.value.replace(/\s+$/, '')
  if (!text.trim() || !S.mini) return
  try {
    await api.dmPost(S.mini.key, 'dm', { text, attachments: [] })
  } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return }
  inp.value = ''
  inp.style.height = 'auto'
  await loadMini(true)
}

function bindMiniDM () {
  const box = $('#mini-dm')
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-md]')
    if (!b || !S.mini) return
    const a = b.dataset.md
    if (a === 'toggle') { if (S.mini.min && !e.target.closest('button')) { S.mini.min = false; buildMiniDM(); renderMiniBody(true); markMiniRead() } return }
    e.stopPropagation()
    if (a === 'close') closeMiniDM()
    else if (a === 'min') { S.mini.min = !S.mini.min; buildMiniDM(); renderMiniBody(true); if (!S.mini.min) { markMiniRead(); $('#md-input')?.focus() } }
    else if (a === 'full') { const k = S.mini.key; closeMiniDM(); openDM(k) }
    else if (a === 'send') sendMini()
  })
}

// Yeni özel mesaj geldiğinde (app.js çağırır). true: mesaj mini pencerede görüldü
function miniOnDM (peer) {
  if (!S.mini || S.mini.key !== peer) return false
  loadMini()
  if (S.mini.min) {
    const u = $('#mini-dm .md-unread')
    if (u) { u.hidden = false; u.textContent = '•' }
    return false
  }
  return document.hasFocus()
}

// =====================================================================
// Gruplar ve özel kanallar
// =====================================================================
const groupById = (m, id) => (m?.groups || []).find(g => g.id === id)
const GROUP_COLORS = ['#ff4f8b', '#9b6bff', '#18c8ff', '#3ddc84', '#ffb020', '#ff5d5d', '#2dd4bf', '#f5c46b']

// Üye listesinde adın yanında görünebilecek grup simgeleri ('' = simgesiz)
const GROUP_ICONS = ['', 'shield', 'star', 'crown', 'zap', 'heart', 'flame', 'gem', 'leaf', 'gamepad', 'music', 'headphones', 'rocket', 'trophy', 'sword', 'skull']

function groupChip (g, extra = '') {
  return `<span class="gchip ${extra}" style="--gc:${g.color}">${g.icon ? icon(g.icon, 12) : '<i></i>'}${esc(g.name)}</span>`
}

// Bir üyenin grup simgeleri (adın yanında; en fazla 3)
function groupBadges (key, m = curMeta(), size = 14) {
  const mem = m?.members?.find(x => x.key === key)
  if (!mem?.groups?.length) return ''
  const list = (m.groups || []).filter(g => g.icon && mem.groups.includes(g.id)).slice(0, 3)
  return list.map(g => `<span class="gbadge" style="--gc:${g.color}" title="${esc(g.name)}">${icon(g.icon, size)}</span>`).join('')
}

async function freshMeta () {
  const m = await api.meta(S.server)
  if (m) S.meta.set(S.server, m)
  refreshMeta(S.server)
  return m
}

function openGroupsModal (selectId = null) {
  const m0 = curMeta()
  if (!m0?.isAdmin) return
  let sel = selectId || m0.groups[0]?.id || null
  const body = el('<div class="groups-admin"><div class="ga-list"></div><div class="ga-edit"></div></div>')
  const draw = () => {
    const m = curMeta()
    if (sel && !groupById(m, sel)) sel = m.groups[0]?.id || null
    $('.ga-list', body).innerHTML = `
      ${m.groups.map(g => `<button class="ga-item ${g.id === sel ? 'on' : ''}" data-g="${g.id}">${g.icon ? `<span class="gbadge" style="--gc:${g.color}">${icon(g.icon, 14)}</span>` : `<i style="background:${g.color}"></i>`}<span class="ellipsis">${esc(g.name)}</span><small>${g.members.length}</small></button>`).join('') || '<p class="muted small">Henüz grup yok.</p>'}
      <button class="btn small block" data-ga="new">${icon('plus', 15)} Yeni grup</button>
      <p class="muted small">Gruplar, belirli kanalları yalnızca seçili kişilere açmak içindir. Yöneticiler tüm kanalları görür.</p>`
    const g = groupById(m, sel)
    const ed = $('.ga-edit', body)
    if (!g) { ed.innerHTML = `<div class="ga-empty">${icon('users', 40)}<p>Bir grup oluştur; ardından üyeleri ve erişebileceği kanalları seç.</p></div>`; return }
    const sorted = [...m.members].sort((a, b) => (g.members.includes(b.key) - g.members.includes(a.key)) || nameOf(a.key).localeCompare(nameOf(b.key), 'tr'))
    ed.innerHTML = `
      <div class="row gap center">
        <input type="color" id="ga-color" value="${g.color}">
        <input id="ga-name" maxlength="40" value="${esc(g.name)}">
        <button class="btn small" data-ga="save">Kaydet</button>
      </div>
      <h4>Simge <span class="muted small">— üye listesinde adın yanında görünür</span></h4>
      <div class="ga-icons" style="--gc:${g.color}">${GROUP_ICONS.map(ic => `<button class="ga-icon ${(g.icon || '') === ic ? 'on' : ''}" data-icon="${ic}" title="${ic ? ic : 'Simgesiz'}">${ic ? icon(ic, 18) : '<span class="ga-noicon">Yok</span>'}</button>`).join('')}</div>
      <h4>Üyeler · ${g.members.length}</h4>
      <input id="ga-search" placeholder="Üye ara…">
      <div class="ga-members">${sorted.map(x => `
        <label class="ga-mem" data-name="${esc(nameOf(x.key).toLocaleLowerCase('tr'))}">
          <input type="checkbox" data-mem="${x.key}" ${g.members.includes(x.key) ? 'checked' : ''}>
          ${avatar(x.key, 26)}<span class="ellipsis">${esc(nameOf(x.key))}</span>${x.owner ? icon('crown', 13, 'gold') : x.admin ? icon('shield', 13, 'blue') : ''}
        </label>`).join('')}</div>
      <h4>Erişebildiği kanallar</h4>
      <div class="ga-chans">${m.channels.map(c => `<label class="chip"><input type="checkbox" data-ch="${c.id}" ${c.groups.includes(g.id) ? 'checked' : ''}><span>${icon(c.kind === 'voice' ? 'volume' : 'hash', 14)} ${esc(c.name)}${c.private ? icon('lock', 12) : ''}</span></label>`).join('')}</div>
      <p class="muted small">İşaretli kanallar özel olur: yalnızca bu kanala atanmış gruplardaki üyeler (ve yöneticiler) görebilir. Özel metin kanallarındaki mesajlar uçtan uca şifrelenir; gruptan çıkarılan biri sonraki mesajları okuyamaz.</p>
      <div class="row"><button class="btn small danger-ghost" data-ga="delete">${icon('trash', 15)} Grubu sil</button></div>`
    $('#ga-search', ed).addEventListener('input', (e) => {
      const q = e.target.value.toLocaleLowerCase('tr')
      for (const r of $$('.ga-mem', ed)) r.hidden = q && !r.dataset.name.includes(q)
    })
  }
  const run = async (fn) => { try { await fn(); await freshMeta(); draw() } catch (e) { toast(e.message || String(e)) } }
  body.addEventListener('click', (e) => {
    const gi = e.target.closest('[data-g]')
    if (gi) { sel = gi.dataset.g; draw(); return }
    const ib = e.target.closest('[data-icon]')
    if (ib) { run(() => api.post(S.server, 'group-update', { target: sel, icon: ib.dataset.icon })); return }
    const b = e.target.closest('[data-ga]')
    if (!b) return
    const act = b.dataset.ga
    if (act === 'new') {
      const m = curMeta()
      run(async () => {
        const id = await api.post(S.server, 'group-create', { name: 'Yeni grup ' + (m.groups.length + 1), color: GROUP_COLORS[m.groups.length % GROUP_COLORS.length] })
        sel = id
        setTimeout(() => $('#ga-name', body)?.select(), 60)
      })
    } else if (act === 'save') {
      run(() => api.post(S.server, 'group-update', { target: sel, name: $('#ga-name', body).value.trim() || 'Grup', color: $('#ga-color', body).value }))
    } else if (act === 'delete') {
      const g = groupById(curMeta(), sel)
      confirmModal('Grubu sil', `<b>${esc(g?.name || '')}</b> grubu silinecek. Yalnızca bu gruba açık kanallar yöneticiler dışında kimseye görünmez olur.`, 'Sil').then(ok => {
        if (ok) run(() => api.post(S.server, 'group-update', { target: sel, deleted: true }))
      })
    }
  })
  body.addEventListener('change', (e) => {
    const mem = e.target.closest('[data-mem]')
    if (mem) return run(() => api.post(S.server, 'group-member', { target: sel, user: mem.dataset.mem, on: mem.checked }))
    const ch = e.target.closest('[data-ch]')
    if (ch) {
      const c = curMeta().channels.find(x => x.id === ch.dataset.ch)
      if (!c) return
      const groups = ch.checked ? [...new Set([...c.groups, sel])] : c.groups.filter(x => x !== sel)
      run(() => api.post(S.server, 'channel-update', { target: c.id, groups }))
    }
  })
  openModal({ title: 'Gruplar ve kanal erişimi', body, wide: true, cls: 'groups-modal' })
  draw()
}

// Profil kartından grup ata
function groupMenu (key, anchor) {
  const m = curMeta()
  if (!m?.isAdmin) return
  const mem = member(key)
  if (!m.groups.length) { openGroupsModal(); return }
  menu([
    ...m.groups.map(g => ({
      label: `<span class="gm-row"><i style="background:${g.color}"></i>${esc(g.name)}</span>`,
      icon: (mem?.groups || []).includes(g.id) ? 'check' : null,
      onClick: async () => { await api.post(S.server, 'group-member', { target: g.id, user: key, on: !(mem?.groups || []).includes(g.id) }); refreshMeta(S.server) }
    })),
    '-',
    { label: 'Grupları yönet', icon: 'settings', onClick: () => openGroupsModal() }
  ], anchor, { align: 'below' })
}

// Ses kanalı izin denetimi (rtc.js kullanır)
function voiceAllowed (server, channel, key) {
  const m = S.meta.get(server)
  if (!m || m.pending) return true
  const ch = m.channels.find(c => c.id === channel)
  if (!ch || !ch.groups?.length) return true
  const mem = m.members.find(x => x.key === key)
  if (!mem) return false
  return mem.admin || (mem.groups || []).some(g => ch.groups.includes(g))
}

// =====================================================================
// Güncelleme
// =====================================================================
S.update = null
S.updProg = null

function notesHTML (raw) {
  let t = String(raw || '')
  t = t.split(/^##\s*İndir/m)[0]
  t = t.replace(/<[^>]+>/g, '').replace(/^\s*\|.*$/gm, '')
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean)
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
  let html = ''
  let inList = false
  for (const l of lines) {
    if (/^[-*]\s+/.test(l)) { if (!inList) { html += '<ul>'; inList = true } html += `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`; continue }
    if (inList) { html += '</ul>'; inList = false }
    if (/^#{1,6}\s/.test(l)) html += `<h4>${inline(l.replace(/^#+\s*/, ''))}</h4>`
    else if (!/^>/.test(l)) html += `<p>${inline(l)}</p>`
  }
  if (inList) html += '</ul>'
  return html || '<p class="muted">Sürüm notu yok.</p>'
}

function onUpdateAvailable (info) {
  const first = !S.update
  S.update = info
  renderRail()
  if (first) toast(`YANKI ${info.version} yayımlandı — güncellemek için soldaki yeşil düğmeye tıkla.`, 6000)
}

function updateProgress (p) {
  S.updProg = p
  const bar = $('#upd-bar i')
  if (bar) bar.style.width = (p.total ? Math.round(p.got / p.total * 100) : 0) + '%'
  const lbl = $('#upd-status')
  if (lbl) lbl.textContent = p.done ? 'İndirildi, kuruluyor… YANKI birazdan yeniden açılacak.' : `İndiriliyor… ${(p.got / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB`
}

function openUpdateModal () {
  const u = S.update
  if (!u) return
  const auto = u.mode === 'auto' && u.asset
  const hint = auto ? '' : S.platform === 'darwin'
    ? '<p class="muted small">Otomatik kurulum için YANKI\'nın <b>Uygulamalar</b> klasöründe olması gerekir. Şimdilik yeni sürümü indirme sayfasından alabilirsin.</p>'
    : '<p class="muted small">Kurulumsuz (zip) sürümü kullanıyorsun; otomatik kurulum için kurulum dosyalı (.exe) sürümü bir kez kur. Şimdilik yeni sürümü indirme sayfasından alabilirsin.</p>'
  const body = el(`
    <div class="update-modal">
      <div class="um-head"><img src="assets/mark.svg" alt=""><div><div class="um-ver">YANKI ${esc(u.version)}</div><div class="muted small">Şu anki sürüm: ${esc(u.current || S.version)}</div></div></div>
      <div class="um-notes">${notesHTML(u.notes)}</div>
      ${hint}
      <div class="um-progress" hidden><div class="meter" id="upd-bar"><i></i></div><div class="muted small" id="upd-status"></div></div>
      <p class="muted small">Sunucuların, mesajların, arkadaşların ve ayarların bilgisayarında kalır; güncelleme bunlara dokunmaz.</p>
    </div>`)
  openModal({
    title: 'Yeni sürüm hazır',
    body,
    actions: [
      { label: 'Sonra' },
      auto
        ? {
            label: `${icon('download', 17)} Güncelle`,
            kind: 'primary',
            onClick: async (node) => {
              $('.um-progress', node).hidden = false
              updateProgress({ got: 0, total: u.asset.size || 0 })
              const ok = await api.updateDownload()
              if (!ok) throw new Error('İndirme başlatılamadı.')
              updateProgress({ got: u.asset.size, total: u.asset.size, done: true })
              voice?.leave?.(true)
              await api.updateInstall()
              return false
            }
          }
        : { label: `${icon('link', 17)} İndirme sayfasını aç`, kind: 'primary', onClick: () => api.updatePage() }
    ]
  })
}

async function checkForUpdates () {
  toast('Güncellemeler denetleniyor…', 1500)
  const r = await api.updateCheck().catch(e => ({ status: 'error', reason: e.message }))
  if (r?.status === 'available') { S.update = r; renderRail(); openUpdateModal() } else if (r?.status === 'latest') toast(`En güncel sürümü kullanıyorsun (${S.version}).`)
  else toast(r?.reason || 'Güncelleme bilgisi alınamadı.', 5000)
}

// =====================================================================
// "Yenilikler" ekranı
// =====================================================================
const verNum = (v) => (String(v || '').match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number)
const verGt = (a, b) => { const x = verNum(a); const y = verNum(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }

// since: en son görülen sürüm. O sürümden sonra gelen (bu sürüm dahil) tüm notlar gösterilir.
function showWhatsNew (since = null) {
  const list = window.CHANGELOG || []
  const cur = list.find(e => e.version === S.version) ? S.version : list[0]?.version
  const fresh = list.filter(e => !verGt(e.version, cur) && (since ? verGt(e.version, since) : e.version === cur))
  if (!fresh.length) return
  const entry = fresh.find(e => e.items.length > 4) || fresh[0] // başlık: en kapsamlı sürüm
  const older = list.filter(e => !fresh.includes(e) && !verGt(e.version, cur))
  const sections = fresh.map(e => `
      ${fresh.length > 1 ? `<h3 class="wn-sec">${esc(e.version)} · ${esc(e.title)}</h3>` : ''}
      <div class="wn-grid">${e.items.map(it => `
        <div class="wn-card"><span class="wn-icon">${icon(it.icon || 'sparkle', 20)}</span><div><b>${esc(it.title)}</b><p>${esc(it.desc)}</p></div></div>`).join('')}</div>`).join('')
  const body = el(`
    <div class="whatsnew">
      <div class="wn-hero">
        <div class="wn-rings"><i></i><i></i><i></i><img src="assets/mark.svg" alt=""></div>
        <img class="wn-word" src="assets/word.svg" alt="YANKI">
        <div class="wn-badge">Sürüm ${esc(cur)}</div>
        <h2>${esc(entry.title)}</h2>
      </div>
      ${sections}
      ${older.length ? `<details class="wn-older"><summary>Önceki sürümler</summary>${older.map(e => `<h4>${esc(e.version)} · ${esc(e.title)}</h4><ul>${e.items.map(it => `<li><b>${esc(it.title)}</b> — ${esc(it.desc)}</li>`).join('')}</ul>`).join('')}</details>` : ''}
    </div>`)
  openModal({ body, wide: true, cls: 'whatsnew-modal', actions: [{ label: 'Hadi başlayalım', kind: 'primary' }] })
}

function maybeShowWhatsNew () {
  const seen = load('seenVersion', null)
  if (!S.version || seen === S.version) return
  save('seenVersion', S.version)
  // Yeni kurulumda değil, güncellemede göster. Yenilikler ekranı 1.2'de geldi; kaydı yoksa 1.1'den geliyordur.
  if (S.profile?.name) setTimeout(() => showWhatsNew(seen || '1.1.99'), 600)
}

// =====================================================================
// Davetler (uygulama yalnızca davetle kullanılır)
// =====================================================================
const INVITE_REASONS = {
  invalid: 'Bu davet kodu geçersiz.',
  revoked: 'Bu davet iptal edilmiş.',
  expired: 'Bu davetin süresi dolmuş.',
  used: 'Bu davetin kullanım hakkı bitmiş.'
}
const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function fmtLeft (ms) {
  if (ms <= 0) return 'süresi doldu'
  const h = Math.floor(ms / 3600000)
  if (h >= 48) return Math.floor(h / 24) + ' gün kaldı'
  if (h >= 1) return h + ' saat kaldı'
  return Math.max(1, Math.floor(ms / 60000)) + ' dakika kaldı'
}

async function openInviteModal () {
  const m = curMeta()
  if (!m?.isAdmin) return
  const body = el(`
    <div class="form invite-modal">
      <p class="muted small">YANKI yalnızca davetle kullanılır. Davet kodunu yalnızca katılmasını istediğin kişiye gönder; kod belirlediğin süre ve kullanım sayısı dolunca çalışmaz, istediğin an iptal edebilirsin.</p>
      <div class="row gap">
        <label class="grow">Geçerlilik<select id="iv-h"><option value="1">1 saat</option><option value="24" selected>1 gün</option><option value="168">7 gün</option><option value="720">30 gün</option><option value="0">Süresiz</option></select></label>
        <label class="grow">Kullanım<select id="iv-max"><option value="1" selected>1 kişi</option><option value="5">5 kişi</option><option value="10">10 kişi</option><option value="0">Sınırsız</option></select></label>
      </div>
      <label>Not (isteğe bağlı)<input id="iv-note" maxlength="60" placeholder="ör. Ahmet için"></label>
      <button class="btn primary" id="iv-make">${icon('link', 16)} Davet oluştur</button>
      <div id="iv-out"></div>
      <h4>Davetler</h4>
      <div class="iv-list"></div>
    </div>`)
  const draw = async () => {
    const list = await api.invites(S.server).catch(() => [])
    const now = Date.now()
    $('.iv-list', body).innerHTML = list.length
      ? list.map(i => `
        <div class="iv-row ${i.active ? '' : 'off'}">
          <div class="grow">
            <b>${esc(i.note || 'Davet')}</b>
            <div class="muted small">${esc(nameOf(i.by))} · ${i.uses}${i.max ? '/' + i.max : ''} kullanım · ${i.revoked ? 'iptal edildi' : i.exp ? fmtLeft(i.exp - now) : 'süresiz'}${i.members.length ? ' · Katılan: ' + i.members.map(k => esc(nameOf(k))).join(', ') : ''}</div>
          </div>
          ${i.active ? `<button class="btn small danger-ghost" data-revoke="${i.id}">İptal et</button>` : '<span class="muted small">Geçersiz</span>'}
        </div>`).join('')
      : '<p class="muted small">Henüz davet yok.</p>'
  }
  body.addEventListener('click', async (e) => {
    if (e.target.closest('#iv-make')) {
      try {
        const code = await api.createInvite(S.server, { hours: +$('#iv-h', body).value, max: +$('#iv-max', body).value, note: $('#iv-note', body).value.trim() })
        $('#iv-out', body).innerHTML = `<div class="invite-box"><code>${esc(code)}</code><button class="btn small primary" data-copy>${icon('copy', 15)} Kopyala</button></div>`
        $('[data-copy]', body).addEventListener('click', () => copyText(code, 'Davet kodu kopyalandı — yalnızca davet ettiğin kişiye gönder.'))
        $('#iv-note', body).value = ''
        draw()
      } catch (err) { toast(errText(err)) }
    }
    const r = e.target.closest('[data-revoke]')
    if (r) { try { await api.revokeInvite(S.server, r.dataset.revoke); toast('Davet iptal edildi.'); draw() } catch (err) { toast(errText(err)) } }
  })
  openModal({ title: 'Davet et', body, wide: true })
  draw()
}

// Hiç sunucu yokken uygulama kilitlidir: yalnızca davet koduyla açılır
function renderLock () {
  const box = $('#lock')
  const locked = !S.servers.length && !!S.profile?.name
  document.body.classList.toggle('locked', locked)
  box.hidden = !locked
  if (!locked) { box.innerHTML = ''; delete box.dataset.ready; return }
  if (box.dataset.ready) return
  box.dataset.ready = '1'
  box.innerHTML = `
    <div class="lock-card">
      <div class="wn-rings"><i></i><i></i><i></i><img src="assets/mark.svg" alt=""></div>
      <img class="lock-word" src="assets/word.svg" alt="YANKI">
      <h2>YANKI yalnızca davetle kullanılır</h2>
      <p class="muted">Seni davet eden kişiden aldığın davet kodunu yapıştır. Kod bir sunucu yöneticisi tarafından oluşturulur.</p>
      <div class="af-input"><input id="lock-code" placeholder="yanki://davet/…" autocomplete="off"><button class="btn primary" id="lock-join">Katıl</button></div>
      <div class="lock-err muted small"></div>
      ${S.canCreate ? `<button class="btn small" data-act="create-server">${icon('plus', 15)} Yeni sunucu oluştur</button>` : ''}
    </div>`
  const go = async () => {
    const code = $('#lock-code', box).value.trim()
    if (!code) return
    try {
      const id = await api.joinServer(code)
      delete box.dataset.ready
      S.servers = (await api.init()).servers
      await window.selectServer(id)
    } catch (err) { $('.lock-err', box).textContent = errText(err) }
  }
  $('#lock-join', box).addEventListener('click', go)
  $('#lock-code', box).addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
  setTimeout(() => $('#lock-code', box)?.focus(), 50)
}

Object.assign(window, { GROUP_ICONS, groupBadges, INVITE_REASONS, errText, openInviteModal, renderLock, plainText, mentionsToNames, namesToMentions, mentionMap, renderMentionHints, closeMentions, bindMentions, addMention, clearMention, mentionCount, serverMentions, canPoll, openPollCreator, startDM, openMiniDM, closeMiniDM, bindMiniDM, miniOnDM, loadMini, groupChip, groupById, openGroupsModal, groupMenu, voiceAllowed, onUpdateAvailable, updateProgress, openUpdateModal, checkForUpdates, showWhatsNew, maybeShowWhatsNew })
