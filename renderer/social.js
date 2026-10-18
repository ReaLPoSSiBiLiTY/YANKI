'use strict'
/* global icon, api, S, $, $$, esc, el, toast, copyText, avatar, avatarFull, actLine, actIcon, actText, activityOf, profileOf, nameOf, colorOf, cacheProfile, md, safeImg, hashColor, fmtDate, fmtSince, menu, confirmModal, renderAll, renderRail, renderSidebar, renderHeader, renderMembers, loadMessages, voice, settings, save, openDM */
// Arkadaşlar ve özel mesajlar

const friendOf = (key) => S.dms.find(d => d.key === key)
const friendStatusOf = (key) => friendOf(key)?.status || 'none'
const isOnline = (key) => key === S.me || !!friendOf(key)?.online || [...S.meta.values()].some(m => m?.members?.some(x => x.key === key && x.online))
const dmUnread = (d) => d.lastTs && d.lastAuthor !== S.me && d.lastTs > (S.lastRead['dm:' + d.key] || 0)
const incomingCount = () => S.dms.filter(d => d.status === 'incoming').length
const homeBadge = () => incomingCount() + S.dms.filter(dmUnread).length

let refreshing = null
async function refreshDMs () {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      S.dms = await api.dmList()
      for (const d of S.dms) cacheProfile(d.key, d.profile)
      if (S.mode === 'home' && S.homeTab === 'blocked') S.blocked = await api.blockedList()
      if (S.dm) S.dmAllowed = await api.canDM(S.dm)
    } catch {}
    refreshing = null
    renderRail()
    if (S.mode === 'home') { renderSidebar(); renderHome(); renderMembers(); renderHeader(); renderDMComposer() }
  })()
  return refreshing
}

// ---------- Kenar çubuğu: sohbet listesi ----------
function renderHomeSidebar () {
  const head = $('#side-head')
  const body = $('#side-body')
  head.className = 'home-head'
  head.style.backgroundImage = ''
  head.innerHTML = '<img class="wordmark" src="assets/word.svg" alt="YANKI">'
  const convs = S.dms.filter(d => d.lastTs > 0 || (d.status === 'friends' && d.key === S.dm)).sort((a, b) => b.lastTs - a.lastTs)
  const inc = incomingCount()
  body.innerHTML = `
    <button class="nav-item ${!S.dm ? 'active' : ''}" data-act="home-friends">${icon('users', 19)}<span>Arkadaşlar</span>${inc ? `<span class="count">${inc}</span>` : ''}</button>
    <div class="side-label"><span>Özel mesajlar</span><button class="mini" data-act="home-add" title="Arkadaş ekle">${icon('plus', 15)}</button></div>
    ${convs.length ? convs.map(d => `
      <button class="dm-row ${S.dm === d.key ? 'active' : ''} ${dmUnread(d) ? 'unread' : ''}" data-act="open-dm" data-key="${d.key}">
        ${avatarFull(d.key, 34, { online: d.online })}
        <span class="dm-text">
          <span class="dm-name" ${colorOf(d.key) ? `style="color:${colorOf(d.key)}"` : ''}>${esc(nameOf(d.key))}</span>
          ${actLine(d.key) || `<span class="dm-last">${d.lastAuthor === S.me ? 'Sen: ' : ''}${esc(window.plainText ? window.plainText(d.lastText) : d.lastText)}</span>`}
        </span>
      </button>`).join('') : '<div class="side-empty muted small">Henüz özel mesaj yok. Bir arkadaşının yanındaki sohbet simgesine tıkla.</div>'}`
}

// ---------- Ana sayfa: arkadaşlar ----------
function friendRow (d) {
  const p = profileOf(d.key)
  let actions = ''
  if (d.status === 'friends') {
    actions = `<button class="round" data-act="open-dm" data-key="${d.key}" title="Mesaj gönder">${icon('chat', 18)}</button><button class="round" data-act="friend-more" data-key="${d.key}" title="Diğer">${icon('more', 18)}</button>`
  } else if (d.status === 'incoming') {
    actions = `<button class="round ok" data-act="friend-accept" data-key="${d.key}" title="Kabul et">${icon('check', 18)}</button><button class="round no" data-act="friend-decline" data-key="${d.key}" title="Reddet">${icon('x', 18)}</button>`
  } else if (d.status === 'outgoing') {
    actions = `<button class="round no" data-act="friend-decline" data-key="${d.key}" title="İsteği iptal et">${icon('x', 18)}</button>`
  }
  const sub = d.status === 'incoming' ? 'Sana arkadaşlık isteği gönderdi' : d.status === 'outgoing' ? 'Giden arkadaşlık isteği' : (actLine(d.key) || esc(p?.status || (d.online ? 'Çevrim içi' : 'Çevrimdışı')))
  return `
    <div class="friend-row" data-act="user" data-key="${d.key}">
      ${avatarFull(d.key, 40, { online: d.online })}
      <div class="fr-text"><b ${colorOf(d.key) ? `style="color:${colorOf(d.key)}"` : ''}>${esc(nameOf(d.key))}</b><span class="fr-sub">${sub}</span></div>
      <div class="fr-actions">${actions}</div>
    </div>`
}

function renderHome () {
  const box = $('#home')
  if (S.mode !== 'home' || S.dm) return
  const tab = S.homeTab
  const friends = S.dms.filter(d => d.status === 'friends').sort((a, b) => nameOf(a.key).localeCompare(nameOf(b.key), 'tr'))
  let html = ''
  if (tab === 'online' || tab === 'all') {
    const list = tab === 'online' ? friends.filter(d => d.online) : friends
    html = `<div class="home-label">${tab === 'online' ? 'Çevrim içi' : 'Tüm arkadaşlar'} — ${list.length}</div>` +
      (list.length ? list.map(friendRow).join('') : `<div class="home-empty">${icon('users', 44)}<p>${friends.length ? 'Şu an çevrim içi arkadaşın yok.' : 'Henüz arkadaşın yok. Bir sunucudaki birinin profil kartından ya da arkadaş koduyla ekleyebilirsin.'}</p><button class="btn primary" data-act="home-add">${icon('userPlus', 17)} Arkadaş ekle</button></div>`)
  } else if (tab === 'pending') {
    const list = S.dms.filter(d => d.status === 'incoming' || d.status === 'outgoing').sort((a, b) => b.friendTs - a.friendTs)
    html = `<div class="home-label">Bekleyen — ${list.length}</div>` + (list.length ? list.map(friendRow).join('') : `<div class="home-empty">${icon('userCheck', 44)}<p>Bekleyen arkadaşlık isteği yok.</p></div>`)
  } else if (tab === 'blocked') {
    html = `<div class="home-label">Engellenenler — ${S.blocked.length}</div>` + (S.blocked.length
      ? S.blocked.map(b => `<div class="friend-row">${avatar(b.key, 40)}<div class="fr-text"><b>${esc(b.profile?.name || nameOf(b.key))}</b><span class="fr-sub">Engellendi</span></div><div class="fr-actions"><button class="btn small" data-act="unblock" data-key="${b.key}">Engeli kaldır</button></div></div>`).join('')
      : `<div class="home-empty">${icon('ban', 44)}<p>Engellediğin kimse yok.</p></div>`)
  } else if (tab === 'add') {
    html = `
      <div class="add-friend">
        <h2>Arkadaş ekle</h2>
        <p class="muted">Arkadaşının <b>arkadaş kodunu</b> yapıştır. İsteğin ona iletilir; kabul ettiğinde arkadaş listene eklenir. Hiçbir ortak sunucunuz olmasa da olur.</p>
        <div class="af-input"><input id="af-code" placeholder="yanki://arkadas/…" autocomplete="off"><button class="btn primary" data-act="friend-send">İstek gönder</button></div>
        <div class="af-mine">
          <div class="muted small">Senin arkadaş kodun — bunu arkadaşına gönder</div>
          <div class="invite-box"><code>yanki://arkadas/${S.me}</code><button class="btn small" data-act="copy-friend-code">${icon('copy', 15)} Kopyala</button></div>
        </div>
        <p class="muted small">İpucu: Bir sunucudaki birinin avatarına tıklayıp <b>Arkadaş ekle</b> de diyebilirsin. İstek, karşı taraf çevrim içi olduğunda doğrudan ona ulaşır.</p>
      </div>`
  }
  box.innerHTML = `<div class="home-inner">${html}</div>`
}

function homeTabsHTML () {
  const inc = incomingCount()
  const tabs = [['online', 'Çevrim içi'], ['all', 'Tümü'], ['pending', 'Bekleyen' + (inc ? ` <span class="count">${inc}</span>` : '')], ['blocked', 'Engellenen']]
  return `<div class="home-tabs">${tabs.map(([k, l]) => `<button class="${S.homeTab === k ? 'on' : ''}" data-act="home-tab" data-tab="${k}">${l}</button>`).join('')}<button class="add ${S.homeTab === 'add' ? 'on' : ''}" data-act="home-tab" data-tab="add">${icon('userPlus', 16)} Arkadaş ekle</button></div>`
}

// Sağ panel (ana sayfa): şu an aktif arkadaşlar
function activeNowHTML () {
  const list = S.dms.filter(d => d.status === 'friends' && activityOf(d.key))
  return `<div class="panel-title">Şu an aktif</div>` + (list.length
    ? list.map(d => {
      const act = activityOf(d.key)
      return `<div class="active-card" data-act="user" data-key="${d.key}">
        <div class="ac-top">${avatarFull(d.key, 36, { online: true, badge: false })}<div><b>${esc(nameOf(d.key))}</b><div class="muted small">${act.type === 'music' ? esc(act.service || 'Müzik') : 'Oyunda'} · ${fmtSince(act.since)}</div></div></div>
        <div class="ac-act">${actIcon(act, 32)}<div class="ellipsis"><b>${esc(act.name)}</b>${act.details ? `<div class="muted small ellipsis">${esc(act.details)}</div>` : ''}</div></div>
      </div>`
    }).join('')
    : '<div class="muted small pad">Şu an kimse oyun oynamıyor veya müzik dinlemiyor. Arkadaşların bir şey başlattığında burada görünür.</div>')
}

// Sağ panel (özel sohbet): karşı tarafın profili
function dmProfileHTML (key) {
  const p = profileOf(key) || {}
  const d = friendOf(key)
  const banner = safeImg(p.banner)
  const act = activityOf(key)
  const mutual = [...S.meta.values()].filter(m => m?.members?.some(x => x.key === key)).map(m => m.name)
  return `
    <div class="dm-profile" style="--accent-user:${p.color || hashColor(key)}">
      <div class="pc-banner" style="${banner ? `background-image:url(${banner})` : ''}"></div>
      <div class="pc-av">${avatarFull(key, 88, { online: isOnline(key), badge: false })}</div>
      <div class="pc-body">
        <div class="pc-name">${esc(nameOf(key))}${p.pronouns ? `<small> · ${esc(p.pronouns)}</small>` : ''}</div>
        ${p.status ? `<div class="pc-status">${esc(p.status)}</div>` : ''}
        ${act ? activityBlock(act) : ''}
        ${p.bio ? `<h5>Hakkımda</h5><div class="pc-bio">${md(p.bio)}</div>` : ''}
        ${d?.status === 'friends' && d.since ? `<h5>Arkadaşlık</h5><div class="pc-since">${fmtDate(d.since)} tarihinden beri</div>` : ''}
        ${mutual.length ? `<h5>Ortak sunucular</h5><div class="pc-since">${mutual.map(esc).join(', ')}</div>` : ''}
        <div class="pc-actions">${friendButton(key)}</div>
      </div>
    </div>`
}

function activityBlock (act) {
  return `<h5>${act.type === 'music' ? `${esc(act.service || 'Müzik')} dinliyor` : 'Şu an oynuyor'}</h5>
    <div class="act-block">${actIcon(act, 40)}<div class="ellipsis"><b>${esc(act.name)}</b>${act.details ? `<div class="small ellipsis">${esc(act.details)}</div>` : ''}<div class="muted small">${fmtSince(act.since)}</div></div></div>`
}

function friendButton (key) {
  if (key === S.me) return ''
  const st = friendStatusOf(key)
  if (st === 'friends') return `<button class="btn small" disabled>${icon('userCheck', 15)} Arkadaşsınız</button>`
  if (st === 'outgoing') return `<button class="btn small" data-act="friend-decline" data-key="${key}">${icon('x', 15)} İsteği iptal et</button>`
  if (st === 'incoming') return `<button class="btn small primary" data-act="friend-accept" data-key="${key}">${icon('check', 15)} İsteği kabul et</button>`
  return `<button class="btn small" data-act="friend-add" data-key="${key}">${icon('userPlus', 15)} Arkadaş ekle</button>`
}

function renderDMComposer () {
  const lock = $('#dm-lock')
  const show = S.mode === 'home' && S.dm && !S.dmAllowed
  $('.composer-box').hidden = !!show
  if (!show) { lock.hidden = true; return }
  lock.hidden = false
  lock.innerHTML = `<span>${icon('userPlus', 18)} Mesajlaşmak için arkadaş olmanız ya da ortak bir sunucuda bulunmanız gerekir.</span>${friendButton(S.dm)}`
}

// ---------- Eylemler ----------
async function friendAction (act, key) {
  try {
    if (act === 'friend-add') { await api.friendRequest(key); toast('Arkadaşlık isteği gönderildi.') }
    if (act === 'friend-accept') { await api.friendAccept(key); toast(`${nameOf(key)} artık arkadaşın! 🎉`); voice.sound('friend') }
    if (act === 'friend-decline') await api.friendRemove(key)
    if (act === 'friend-remove') {
      if (!await confirmModal('Arkadaşlıktan çıkar', `${esc(nameOf(key))} arkadaş listenden çıkarılacak.`, 'Çıkar')) return
      await api.friendRemove(key)
    }
    if (act === 'block') {
      if (!await confirmModal('Engelle', `${esc(nameOf(key))} engellenecek: arkadaşlıktan çıkarılır, sana istek ve özel mesaj gönderemez, doğrudan bağlantıları reddedilir.`, 'Engelle')) return
      await api.block(key)
      if (S.dm === key) { S.dm = null }
    }
    if (act === 'unblock') { await api.unblock(key); S.blocked = await api.blockedList() }
  } catch (e) { toast(e.message || String(e)) }
  await refreshDMs()
  renderAll()
}

async function sendFriendCode () {
  const v = $('#af-code').value.trim()
  if (!v) return toast('Bir arkadaş kodu yapıştır.')
  try {
    const st = await api.friendRequest(v)
    $('#af-code').value = ''
    toast(st === 'friends' ? 'Artık arkadaşsınız!' : 'İstek gönderildi. Arkadaşın çevrim içi olduğunda ona ulaşır.', 4500)
    S.homeTab = 'pending'
    await refreshDMs()
    renderAll()
  } catch (e) { toast(e.message || 'Geçersiz arkadaş kodu') }
}

function friendMoreMenu (key, anchor) {
  menu([
    { label: 'Mesaj gönder', icon: 'chat', onClick: () => openDM(key) },
    { label: 'Arkadaş kodunu kopyala', icon: 'copy', onClick: () => copyText('yanki://arkadas/' + key) },
    '-',
    { label: 'Arkadaşlıktan çıkar', icon: 'userX', danger: true, onClick: () => friendAction('friend-remove', key) },
    { label: 'Engelle', icon: 'ban', danger: true, onClick: () => friendAction('block', key) }
  ], anchor, { align: 'below' })
}
