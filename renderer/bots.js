'use strict'
/* global icon, api, S, $, $$, esc, el, settings, saveSettings, voice, music, curMeta, nameOf, toast, openModal, openPopup, closePopup, avatar, fmtDur, YT_RE, refreshMeta, renderStage */
/*
 * Ön tanımlı botlar. P2P'de sürekli çalışan bir bot sunucusu olmadığı için botların
 * davranışı herkesin uygulamasında aynı kurallarla, imzalı op'lardan hesaplanır:
 *  - Zar: sonuç mesajın kimliğinden türetilir → herkes aynı sonucu görür.
 *  - Anket: oylar imzalı op'lardır.
 *  - Karşılama: yeni üyeler seçilen kanalda karşılanır.
 *  - Müzik Çalar: kuyruk ve zamanlama op'lardan hesaplanır; her dinleyici YouTube'dan
 *    aynı şarkıyı aynı saniyeden çalar ("birlikte dinle").
 */

const BOT_DEFS = {
  dice: {
    name: 'Zar', glyph: 'dice', colors: ['#ffb020', '#ff5d5d'], kind: 'text',
    desc: 'Adil zar atar. Sonuç mesajdan hesaplanır, herkes aynı sonucu görür.',
    commands: [['/zar', '1 tane 6 yüzlü zar'], ['/zar 2d20+3', '2 tane 20 yüzlü zar, +3']]
  },
  poll: {
    name: 'Anket', glyph: 'poll', colors: ['#3ddc84', '#18c8ff'], kind: 'text',
    desc: 'Hızlı anket oluşturur; herkes tek oy verir, istediğinde değiştirir.',
    commands: [['/anket Soru | Seçenek 1 | Seçenek 2', 'En fazla 10 seçenek']]
  },
  welcome: {
    name: 'Karşılama', glyph: 'wave', colors: ['#ff4f8b', '#9b6bff'], kind: 'text',
    desc: 'Sunucuya katılan yeni üyeleri seçtiğin kanalda karşılar.',
    commands: []
  },
  music: {
    name: 'Müzik Çalar', glyph: 'music', colors: ['#9b6bff', '#18c8ff'], kind: 'voice',
    desc: 'Ses kanalında YouTube bağlantılarını herkesle aynı anda dinletir. Kuyruk, atla, durdur.',
    commands: [['/çal <YouTube bağlantısı>', 'Kuyruğa ekler'], ['/geç', 'Çalan şarkıyı atlar'], ['/dur', 'Durdurur, kuyruğu temizler']]
  }
}

const WELCOMES = [
  'Aramıza hoş geldin {u}! 🎉',
  'Bir yankı duyuldu… {u} geldi! 👋',
  '{u} sunucuya giriş yaptı, yer açın! 🚀',
  'Hoş geldin {u}, umarız atıştırmalık getirmişsindir 🍕',
  '{u} katıldı. Takım artık daha güçlü 💪',
  'Selam {u}! Kahveler bizden ☕'
]

function botAvatar (id, size = 40) {
  const b = BOT_DEFS[id]
  return `<span class="avw bot" style="--s:${size}px;background:linear-gradient(135deg, ${b.colors[0]}, ${b.colors[1]})">${icon(b.glyph, Math.round(size * 0.52))}</span>`
}

function botsIn (meta, channelId) {
  const out = new Set()
  for (const b of meta?.bots || []) if (b.enabled && b.channels.includes(channelId)) out.add(b.id)
  return out
}
const botEnabledIn = (serverId, channelId, bot) => botsIn(S.meta.get(serverId), channelId).has(bot)

function welcomeText (key) {
  let h = 0
  for (let i = 0; i < 12; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0
  return WELCOMES[h % WELCOMES.length]
}

// ---------- Mesaj içi bot kartları ----------

function renderBotReply (m) {
  const b = m.bot
  if (!b) return ''
  const def = BOT_DEFS[b.id] || BOT_DEFS.dice
  if (b.error) {
    return `<div class="bot-reply">${botAvatar(b.id, 22)}<b>${def.name}</b><span class="tag-bot">BOT</span><span class="bot-err">${esc(b.error)}</span></div>`
  }
  if (b.id === 'dice') {
    const faces = b.rolls.map(r => `<span class="die ${b.sides === 6 ? 'd6' : ''}">${r}</span>`).join('')
    return `
      <div class="bot-reply dice">
        ${botAvatar('dice', 22)}<b>Zar</b><span class="tag-bot">BOT</span>
        <span class="dice-line"><span class="muted">${esc(nameOf(m.author))} · ${esc(b.expr)}</span>${faces}${b.mod ? `<span class="die mod">${b.mod > 0 ? '+' : ''}${b.mod}</span>` : ''}<span class="dice-total">= ${b.total}</span></span>
      </div>`
  }
  return ''
}

function renderPoll (m) {
  const p = m.poll
  const max = Math.max(1, ...p.counts)
  return `
    <div class="poll">
      <div class="poll-head">${botAvatar('poll', 22)}<span>Anket</span><span class="tag-bot">BOT</span><span class="muted small">${p.total} oy</span></div>
      <div class="poll-q">${esc(p.question)}</div>
      ${p.options.map((o, i) => {
        const pct = p.total ? Math.round(p.counts[i] / p.total * 100) : 0
        return `<button class="poll-opt ${p.mine === i ? 'mine' : ''} ${p.counts[i] === max && p.total ? 'lead' : ''}" data-act="vote" data-id="${m.id}" data-opt="${i}">
          <span class="poll-bar" style="width:${pct}%"></span>
          <span class="poll-label">${p.mine === i ? icon('check', 14) : ''}${esc(o)}</span>
          <span class="poll-count">${p.counts[i]} · %${pct}</span>
        </button>`
      }).join('')}
      <div class="muted small">${p.mine >= 0 ? 'Oyunu geri almak için seçtiğin seçeneğe tekrar tıkla.' : 'Oy vermek için bir seçeneğe tıkla.'}</div>
    </div>`
}

// ---------- Komut ipuçları ----------

function availableCommands () {
  const out = []
  if (S.mode === 'home') {
    if (S.dm) { out.push(...BOT_DEFS.dice.commands.map(c => ['dice', ...c])); out.push(...BOT_DEFS.poll.commands.map(c => ['poll', ...c])) }
    return out
  }
  const bots = botsIn(curMeta(), S.channel)
  for (const id of ['dice', 'poll']) if (bots.has(id)) out.push(...BOT_DEFS[id].commands.map(c => [id, ...c]))
  if (voice.active && voice.server === S.server && botEnabledIn(voice.server, voice.channel, 'music')) out.push(...BOT_DEFS.music.commands.map(c => ['music', ...c]))
  return out
}

function renderCmdHints () {
  const box = $('#cmd-hints')
  const v = $('#input').value
  if (!v.startsWith('/') || v.includes('\n')) { box.hidden = true; return }
  const word = v.split(/\s/)[0].toLowerCase()
  const list = availableCommands().filter(([, c]) => c.toLowerCase().startsWith(word) || word === '/')
  if (!list.length) { box.hidden = true; return }
  box.hidden = false
  box.innerHTML = `<div class="cmd-title">Komutlar</div>` + list.map(([id, c, d]) => `
    <button class="cmd" data-act="cmd-fill" data-cmd="${esc(c.replace(/<.*>/, '').replace(/\s*\|.*$/, ' ').trimEnd() + ' ')}">${botAvatar(id, 22)}<code>${esc(c)}</code><span class="muted">${esc(d)}</span></button>`).join('')
}

// Müzik komutlarını yakala; true dönerse mesaj gönderilmez
async function handleMusicCommand (text) {
  const m = text.trim().match(/^\/(çal|cal|play|geç|gec|skip|dur|stop)\b\s*(.*)$/i)
  if (!m || S.mode !== 'server') return false
  const cmd = m[1].toLowerCase()
  if (!voice.active || voice.server !== S.server || !botEnabledIn(voice.server, voice.channel, 'music')) {
    toast('Müzik Çalar için önce müzik botunun etkin olduğu bir ses kanalına katıl.')
    return true
  }
  if (cmd === 'çal' || cmd === 'cal' || cmd === 'play') await musicAdd(m[2])
  else if (cmd === 'dur' || cmd === 'stop') await musicStop()
  else await musicSkip()
  return true
}

// ---------- Müzik Çalar ----------

async function musicAdd (url) {
  const id = String(url || '').match(YT_RE)?.[1] || (/^[A-Za-z0-9_-]{11}$/.test(String(url).trim()) ? String(url).trim() : null)
  if (!id) { toast('Geçerli bir YouTube bağlantısı yapıştır.'); return false }
  if (!voice.active) return false
  toast('Şarkı bilgisi alınıyor…', 1500)
  const meta = await api.ytMeta(id).catch(() => null) || { id, title: 'YouTube videosu', duration: 0 }
  await api.post(voice.server, 'music', { channel: voice.channel, action: 'add', video: { id, title: meta.title, duration: meta.duration } })
  toast(`🎵 Kuyruğa eklendi: ${meta.title}` + (meta.duration ? '' : ' (süre alınamadı; bitince "Atla" ile geç)'), 4000)
  music.refresh()
  return true
}

async function musicSkip (target) {
  if (!voice.active) return
  const st = music.state
  const t = target || st?.playing?.id
  if (!t) return
  await api.post(voice.server, 'music', { channel: voice.channel, action: 'skip', target: t })
  music.refresh()
}

async function musicStop () {
  if (!voice.active) return
  await api.post(voice.server, 'music', { channel: voice.channel, action: 'stop' })
  music.refresh()
}

class MusicPlayer {
  constructor () {
    this.host = $('#music-host')
    this.state = null
    this.entryId = null
    this.iframe = null
    this._refreshTimer = null
    setInterval(() => this.tick(), 1000)
    setInterval(() => this.position(), 300)
    window.addEventListener('resize', () => this.position())
  }

  get ctx () {
    return voice.active && botEnabledIn(voice.server, voice.channel, 'music') ? { server: voice.server, channel: voice.channel } : null
  }

  sync () {
    clearTimeout(this._refreshTimer)
    this._refreshTimer = setTimeout(() => this.refresh(), 120)
  }

  async refresh () {
    const c = this.ctx
    this.state = c ? await api.music(c.server, c.channel).catch(() => null) : null
    this.apply()
    renderMusicPanel()
  }

  apply () {
    const p = this.state?.playing
    const want = p && !voice.deaf ? p.id : null
    if (want === this.entryId) return
    this.entryId = want
    this.host.innerHTML = ''
    this.iframe = null
    if (!want) { renderStage(); return }
    const start = Math.max(0, Math.floor((Date.now() - p.startedAt) / 1000))
    const f = document.createElement('iframe')
    f.src = `https://www.youtube-nocookie.com/embed/${p.video.id}?autoplay=1&start=${start}&enablejsapi=1&controls=0&rel=0&playsinline=1&modestbranding=1&iv_load_policy=3`
    f.allow = 'autoplay; encrypted-media'
    f.referrerPolicy = 'strict-origin-when-cross-origin'
    f.title = 'Müzik Çalar'
    f.addEventListener('load', () => { setTimeout(() => this.setVolume(settings.musicVolume), 600); setTimeout(() => this.setVolume(settings.musicVolume), 2500) })
    this.host.appendChild(f)
    this.iframe = f
    renderStage()
  }

  setVolume (v) {
    settings.musicVolume = v
    const w = this.iframe?.contentWindow
    if (!w) return
    const cmd = (func, args = []) => w.postMessage(JSON.stringify({ event: 'command', func, args }), '*')
    cmd('setVolume', [Number(v)])
    cmd(v > 0 ? 'unMute' : 'mute')
  }

  tick () {
    const p = this.state?.playing
    if (!p) return
    const d = p.video.duration
    const el = (Date.now() - p.startedAt) / 1000
    if (d && el >= d + 0.6) { this.refresh(); if (voice.server) refreshMeta(voice.server) }
    for (const bar of $$('.mp-progress i')) bar.style.width = (d ? Math.min(100, el / d * 100) : 0) + '%'
    for (const t of $$('.mp-time')) t.textContent = fmtDur(el) + (d ? ' / ' + fmtDur(d) : '')
  }

  // Oynatıcı hep aynı yerde yaşar (yeniden yüklenmesin diye); sahnede kutunun üstüne taşınır
  position () {
    const slot = $('#music-slot')
    const stage = $('#stage')
    if (slot && stage && !stage.hidden && this.iframe) {
      const r = slot.getBoundingClientRect()
      Object.assign(this.host.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
      this.host.classList.add('visible')
    } else {
      this.host.classList.remove('visible')
      Object.assign(this.host.style, { left: '-10000px', top: '0px', width: '480px', height: '270px' })
    }
  }
}

function musicPanelHTML () {
  const st = music.state
  const p = st?.playing
  const queue = st?.queue || []
  return `
    <div class="mp" id="music-panel">
      <div class="mp-head">${botAvatar('music', 28)}<b>Müzik Çalar</b><span class="tag-bot">BOT</span></div>
      ${p ? `
        <div class="mp-now">
          <img src="https://i.ytimg.com/vi/${p.video.id}/mqdefault.jpg" alt="">
          <div class="mp-info">
            <div class="mp-title" title="${esc(p.video.title)}">${esc(p.video.title)}</div>
            <div class="muted small">${esc(nameOf(p.addedBy))} ekledi</div>
            <div class="mp-progress"><i></i></div>
            <div class="mp-time small muted"></div>
          </div>
        </div>
        <div class="mp-ctrl">
          <button class="btn small" data-act="music-skip">${icon('skip', 15)} Atla</button>
          <button class="btn small danger-ghost" data-act="music-stop">${icon('stop', 15)} Durdur</button>
          <label class="mp-vol">${icon('volumeLow', 16)}<input type="range" min="0" max="100" value="${settings.musicVolume}" id="mp-vol"></label>
        </div>` : '<div class="mp-empty muted">Şu an bir şey çalmıyor. Bir YouTube bağlantısı ekle, kanaldaki herkes birlikte dinlesin.</div>'}
      ${voice.deaf ? '<div class="muted small">Sağırlaştırılmış olduğun için müzik sende çalmıyor.</div>' : ''}
      <div class="mp-add"><input id="mp-url" placeholder="YouTube bağlantısı yapıştır"><button class="btn small primary" data-act="music-add">Ekle</button></div>
      ${queue.length ? `<div class="mp-qt">Sırada · ${queue.length}</div><div class="mp-queue">${queue.map((q, i) => `
        <div class="mp-q"><span class="muted">${i + 1}</span><img src="https://i.ytimg.com/vi/${q.video.id}/default.jpg" alt=""><span class="ellipsis" title="${esc(q.video.title)}">${esc(q.video.title)}</span><span class="muted small">${q.video.duration ? fmtDur(q.video.duration) : ''}</span><button class="mini" data-act="music-remove" data-id="${q.id}" title="Kuyruktan çıkar">${icon('x', 14)}</button></div>`).join('')}</div>` : ''}
    </div>`
}

function openMusicPanel (anchor) {
  if (!music.ctx) { toast('Bu ses kanalında Müzik Çalar etkin değil.'); return }
  const p = openPopup(musicPanelHTML(), anchor, { align: 'above', cls: 'mp-pop' })
  bindMusicPanel(p)
  music.refresh()
}

function bindMusicPanel (root) {
  $('#mp-vol', root)?.addEventListener('input', (e) => { music.setVolume(+e.target.value); saveSettings() })
  $('#mp-url', root)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-act="music-add"]', root)?.click() })
}

function renderMusicPanel () {
  const box = $('#music-panel')
  if (!box) return
  const focused = document.activeElement?.id === 'mp-url'
  const val = $('#mp-url', box)?.value || ''
  const fresh = el(musicPanelHTML())
  box.replaceWith(fresh)
  const inp = $('#mp-url', fresh)
  if (inp) { inp.value = val; if (focused) inp.focus() }
  bindMusicPanel(fresh.parentElement || document)
  music.tick()
}

// ---------- Bot yönetimi (yöneticiler) ----------

function openBotsModal () {
  const m = curMeta()
  if (!m || !m.isAdmin) return
  const draft = {}
  for (const b of m.bots) draft[b.id] = { enabled: b.enabled, channels: new Set(b.channels) }
  const body = el(`<div class="bots-admin">${Object.entries(BOT_DEFS).map(([id, def]) => {
    const chans = m.channels.filter(c => c.kind === def.kind)
    return `
      <div class="bot-card" data-bot="${id}">
        <div class="bot-card-head">
          ${botAvatar(id, 44)}
          <div class="grow"><div class="bot-name">${def.name} <span class="tag-bot">BOT</span></div><div class="muted small">${esc(def.desc)}</div></div>
          <label class="switch"><input type="checkbox" data-en ${draft[id]?.enabled ? 'checked' : ''}><span></span></label>
        </div>
        ${def.commands.length ? `<div class="bot-cmds">${def.commands.map(([c, d]) => `<code>${esc(c)}</code><span class="muted small">${esc(d)}</span>`).join('')}</div>` : ''}
        <div class="bot-chans">
          <div class="muted small">${def.kind === 'voice' ? 'Hangi ses kanallarında çalışsın?' : 'Hangi metin kanallarında çalışsın?'}</div>
          ${chans.map(c => `<label class="chip"><input type="checkbox" data-ch="${c.id}" ${draft[id]?.channels.has(c.id) ? 'checked' : ''}><span>${icon(c.kind === 'voice' ? 'volume' : 'hash', 14)} ${esc(c.name)}</span></label>`).join('') || '<span class="muted small">Uygun kanal yok.</span>'}
        </div>
      </div>`
  }).join('')}</div>`)
  openModal({
    title: 'Botlar',
    body,
    wide: true,
    actions: [{ label: 'Vazgeç' }, {
      label: 'Kaydet',
      kind: 'primary',
      onClick: async (node) => {
        for (const card of $$('.bot-card', node)) {
          const id = card.dataset.bot
          const enabled = $('[data-en]', card).checked
          const channels = $$('[data-ch]:checked', card).map(x => x.dataset.ch)
          if (enabled && !channels.length) { toast(`${BOT_DEFS[id].name}: en az bir kanal seç.`); return false }
          const old = m.bots.find(b => b.id === id)
          const same = old && old.enabled === enabled && old.channels.length === channels.length && channels.every(c => old.channels.includes(c))
          if (!same) await api.post(S.server, 'bot-config', { bot: id, enabled, channels })
        }
        toast('Bot ayarları kaydedildi.')
      }
    }]
  })
}

function openBotCard (id, anchor) {
  const def = BOT_DEFS[id]
  const m = curMeta()
  const b = m?.bots.find(x => x.id === id)
  const chans = (b?.channels || []).map(c => m.channels.find(x => x.id === c)).filter(Boolean)
  const align = anchor.closest('#members') ? 'left' : 'right'
  openPopup(`
    <div class="pcard bot-pcard">
      <div class="pc-banner" style="background:linear-gradient(135deg, ${def.colors[0]}, ${def.colors[1]})"></div>
      <div class="pc-av">${botAvatar(id, 84)}</div>
      <div class="pc-body">
        <div class="pc-name">${def.name} <span class="tag-bot">BOT</span></div>
        <div class="pc-bio">${esc(def.desc)}</div>
        ${def.commands.length ? `<h5>Komutlar</h5><div class="bot-cmds">${def.commands.map(([c, d]) => `<code>${esc(c)}</code><span class="muted small">${esc(d)}</span>`).join('')}</div>` : ''}
        <h5>Kanallar</h5><div class="pc-since">${chans.map(c => (c.kind === 'voice' ? '🔊 ' : '#') + esc(c.name)).join(', ') || '—'}</div>
        ${m?.isAdmin ? `<div class="pc-actions"><button class="btn small" data-act="bots-admin">${icon('settings', 15)} Botları yönet</button></div>` : ''}
      </div>
    </div>`, anchor, { align, cls: 'pcard-pop' })
}

window.BOT_DEFS = BOT_DEFS
