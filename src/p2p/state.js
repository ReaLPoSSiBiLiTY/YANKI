'use strict'
/*
 * Olay günlüğünden (op log) durum türetme.
 * Tüm eşler aynı imzalı op kümesine sahip olduğunda aynı durumu hesaplar
 * (sıralama: zaman damgası, eşitlikte op kimliği).
 */
const crypto = require('crypto')

const OP_TYPES = new Set([
  'genesis', 'server-update', 'role-set', 'kick', 'ban', 'unban',
  'member-join', 'member-leave', 'profile',
  'category-create', 'category-update',
  'channel-create', 'channel-update',
  'message', 'message-edit', 'message-delete', 'reaction', 'pin',
  'bot-config', 'poll-vote', 'music'
])

// İki kişi arasındaki özel alan (arkadaşlık + özel mesajlar)
const DM_TYPES = new Set([
  'friend-request', 'friend-accept', 'friend-remove', 'profile',
  'dm', 'dm-edit', 'dm-delete', 'dm-reaction', 'poll-vote'
])

// Ön tanımlı botlar. kind: hangi tür kanala eklenebilecekleri
const BOTS = {
  dice: { kind: 'text' },
  poll: { kind: 'text' },
  welcome: { kind: 'text' },
  music: { kind: 'voice' }
}

// data: URL uzunluk sınırları (base64 karakter). GIF'ler kırpılamadığı için daha cömert.
const LIMITS = { avatar: 3_700_000, banner: 7_300_000, icon: 3_700_000, attachment: 11_000_000 }

const IMG_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const YT_ID = /^[A-Za-z0-9_-]{11}$/

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v, d) => (Number.isFinite(v) ? v : d)
const img = (v, maxLen) => (typeof v === 'string' && v.length <= maxLen && IMG_RE.test(v) ? v : null)

function sanitizeProfile (d, ts) {
  d = d || {}
  return {
    name: str(d.name, 32).trim() || 'Anonim',
    avatar: img(d.avatar, LIMITS.avatar),
    banner: img(d.banner, LIMITS.banner),
    bio: str(d.bio, 600),
    status: str(d.status, 80),
    pronouns: str(d.pronouns, 30),
    color: COLOR_RE.test(d.color || '') ? d.color : null,
    updatedAt: ts
  }
}

function sanitizeAttachments (list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const a of list.slice(0, 6)) {
    if (!a || a.type !== 'image') continue
    const data = img(a.data, LIMITS.attachment)
    if (!data) continue
    out.push({ type: 'image', data, name: str(a.name, 120) || 'resim', w: num(a.w, 0), h: num(a.h, 0) })
  }
  return out
}

function sortOps (ops) {
  return [...ops].sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ---------- Bot komutları ----------

// Zar: sonuç op kimliğinden deterministik türetilir; böylece her eş aynı sonucu görür.
function rollDice (opId, text) {
  const m = text.trim().match(/^\/(?:zar|roll|r)(?:\s+(.*))?$/i)
  if (!m) return null
  let arg = (m[1] || '').trim().toLowerCase().replace(/\s+/g, '')
  if (!arg) arg = '1d6'
  if (/^\d+$/.test(arg)) arg = '1d' + arg
  const p = arg.match(/^(\d{0,2})d(\d{1,4})([+-]\d{1,4})?$/)
  if (!p) return { error: 'Biçim: /zar 2d6+1' }
  const count = Math.max(1, Math.min(20, parseInt(p[1] || '1', 10)))
  const sides = Math.max(2, Math.min(1000, parseInt(p[2], 10)))
  const mod = p[3] ? parseInt(p[3], 10) : 0
  const rolls = []
  for (let i = 0; i < count; i++) {
    const h = crypto.createHash('sha256').update(opId + ':' + i).digest()
    rolls.push((h.readUInt32BE(0) % sides) + 1)
  }
  return { expr: `${count}d${sides}${mod ? (mod > 0 ? '+' : '') + mod : ''}`, rolls, mod, total: rolls.reduce((a, b) => a + b, 0) + mod, sides }
}

function parsePoll (text) {
  const m = text.trim().match(/^\/(?:anket|poll)\s+([\s\S]+)$/i)
  if (!m) return null
  const parts = m[1].split('|').map(x => x.trim()).filter(Boolean)
  if (parts.length < 3) return { error: 'Biçim: /anket Soru | Seçenek 1 | Seçenek 2' }
  return { question: parts[0].slice(0, 200), options: parts.slice(1, 11).map(o => o.slice(0, 80)) }
}

// ---------- Ortak mesaj işleme (sunucu kanalları ve özel mesajlar) ----------

function applyMessageOp (s, op, { canWrite, isMod, botsFor }) {
  const a = op.author
  const d = op.data || {}
  switch (op.type) {
    case 'message': case 'dm': {
      const channel = op.type === 'dm' ? 'dm' : d.channel
      if (!canWrite(a, channel)) return
      const text = str(d.text, 4000)
      const attachments = sanitizeAttachments(d.attachments)
      if (!text.trim() && !attachments.length) return
      const m = {
        id: op.id, channel, author: a, ts: op.ts, text, attachments,
        replyTo: typeof d.replyTo === 'string' ? d.replyTo : null,
        edited: null, deleted: false, reactions: {}, bot: null, poll: null
      }
      if (text.startsWith('/')) {
        const bots = botsFor(channel)
        if (bots.has('dice')) {
          const r = rollDice(op.id, text)
          if (r) m.bot = { id: 'dice', ...r }
        }
        if (!m.bot && bots.has('poll')) {
          const p = parsePoll(text)
          if (p && p.error) m.bot = { id: 'poll', error: p.error }
          else if (p) m.poll = { ...p, votes: new Map() }
        }
      }
      if (!s.messages.has(channel)) s.messages.set(channel, [])
      s.messages.get(channel).push(m)
      s.msgIndex.set(op.id, m)
      if (op.ts > s.lastTs) s.lastTs = op.ts
      return
    }
    case 'message-edit': case 'dm-edit': {
      const m = s.msgIndex.get(d.target)
      if (!m || m.author !== a || m.deleted || m.poll) return
      const text = str(d.text, 4000)
      if (!text.trim() && !m.attachments.length) return
      m.text = text
      m.edited = op.ts
      if (m.bot && m.bot.id === 'dice') m.bot = null // düzenlenen zar sonucu geçersiz
      return
    }
    case 'message-delete': case 'dm-delete': {
      const m = s.msgIndex.get(d.target)
      if (m && (m.author === a || isMod(a))) m.deleted = true
      return
    }
    case 'reaction': case 'dm-reaction': {
      const m = s.msgIndex.get(d.target)
      const emoji = str(d.emoji, 16)
      if (!m || !emoji || !canWrite(a, m.channel, true)) return
      const set = new Set(m.reactions[emoji] || [])
      if (d.on) set.add(a); else set.delete(a)
      if (set.size) m.reactions[emoji] = [...set]
      else delete m.reactions[emoji]
      return
    }
    case 'poll-vote': {
      const m = s.msgIndex.get(d.target)
      if (!m || !m.poll || m.deleted || !canWrite(a, m.channel, true)) return
      const opt = d.option
      if (opt === -1) m.poll.votes.delete(a)
      else if (Number.isInteger(opt) && opt >= 0 && opt < m.poll.options.length) m.poll.votes.set(a, opt)
    }
  }
}

// ---------- Müzik botu zaman çizelgesi ----------
// Kuyruk, op'lardan ve şarkı sürelerinden deterministik hesaplanır: herkes aynı şarkıyı
// aynı saniyede dinler.
function musicState (events, now) {
  let playing = null
  const queue = []
  const advance = (t) => {
    while (playing && playing.video.duration > 0 && playing.startedAt + playing.video.duration * 1000 <= t) {
      const end = playing.startedAt + playing.video.duration * 1000
      const next = queue.shift()
      playing = next ? { ...next, startedAt: end } : null
    }
  }
  for (const e of events || []) {
    advance(e.ts)
    if (e.action === 'add') {
      const entry = { id: e.id, video: e.video, addedBy: e.author, addedAt: e.ts }
      if (!playing) playing = { ...entry, startedAt: e.ts }
      else if (queue.length < 100) queue.push(entry)
    } else if (e.action === 'skip') {
      if (playing && playing.id === e.target) {
        const next = queue.shift()
        playing = next ? { ...next, startedAt: e.ts } : null
      } else {
        const i = queue.findIndex(q => q.id === e.target)
        if (i >= 0) queue.splice(i, 1)
      }
    } else if (e.action === 'stop') {
      playing = null
      queue.length = 0
    }
  }
  advance(now)
  return { playing, queue }
}

// ---------- Sunucu durumu ----------

function derive (serverId, opsIterable) {
  const ops = sortOps(opsIterable)
  const genesis = ops.find(o => o.type === 'genesis' && o.id === serverId)
  if (!genesis) return null
  const g = genesis.data || {}
  const owner = genesis.author

  const s = {
    id: serverId,
    owner,
    createdAt: genesis.ts,
    name: str(g.name, 60) || 'Sunucu',
    icon: img(g.icon, LIMITS.icon),
    banner: null,
    description: str(g.description, 300),
    admins: new Set([owner]),
    banned: new Set(),
    members: new Map([[owner, { joinedAt: genesis.ts }]]),
    profiles: new Map(),
    categories: new Map(),
    channels: new Map(),
    messages: new Map(), // kanalId -> [mesaj]
    msgIndex: new Map(),
    pins: new Map(), // kanalId -> Set(mesajId)
    bots: new Map(), // botId -> { enabled, channels:Set }
    music: new Map(), // sesKanalId -> [olay]
    lastTs: 0
  }
  const isAdmin = a => s.admins.has(a)
  const canModerate = (a, target) => isAdmin(a) && target !== owner && (!s.admins.has(target) || a === owner)
  const botsFor = (channel) => {
    const out = new Set()
    for (const [id, b] of s.bots) if (b.enabled && b.channels.has(channel)) out.add(id)
    return out
  }
  const msgCtx = {
    canWrite: (a, channel) => {
      const ch = s.channels.get(channel)
      return !!ch && ch.kind === 'text' && s.members.has(a)
    },
    isMod: isAdmin,
    botsFor
  }

  for (const op of ops) {
    if (op.type === 'genesis') continue
    const a = op.author
    const d = op.data || {}
    if (s.banned.has(a)) continue

    switch (op.type) {
      case 'member-join':
        if (!s.members.has(a)) s.members.set(a, { joinedAt: op.ts })
        break
      case 'member-leave':
        if (a !== owner) s.members.delete(a)
        break
      case 'profile':
        s.profiles.set(a, sanitizeProfile(d, op.ts))
        break
      case 'server-update':
        if (!isAdmin(a)) break
        if (typeof d.name === 'string' && d.name.trim()) s.name = str(d.name, 60)
        if ('icon' in d) s.icon = img(d.icon, LIMITS.icon)
        if ('banner' in d) s.banner = img(d.banner, LIMITS.banner)
        if (typeof d.description === 'string') s.description = str(d.description, 300)
        break
      case 'role-set':
        if (a !== owner || d.user === owner || typeof d.user !== 'string') break
        if (d.role === 'admin') s.admins.add(d.user)
        else s.admins.delete(d.user)
        break
      case 'kick':
        if (canModerate(a, d.user)) s.members.delete(d.user)
        break
      case 'ban':
        if (canModerate(a, d.user)) { s.members.delete(d.user); s.admins.delete(d.user); s.banned.add(d.user) }
        break
      case 'unban':
        if (isAdmin(a)) s.banned.delete(d.user)
        break
      case 'category-create':
        if (!isAdmin(a)) break
        s.categories.set(op.id, { id: op.id, name: str(d.name, 50) || 'Kategori', order: num(d.order, op.ts) })
        break
      case 'category-update': {
        const c = s.categories.get(d.target)
        if (!isAdmin(a) || !c) break
        if (d.deleted) { s.categories.delete(d.target); break }
        if (typeof d.name === 'string' && d.name.trim()) c.name = str(d.name, 50)
        if (Number.isFinite(d.order)) c.order = d.order
        break
      }
      case 'channel-create':
        if (!isAdmin(a)) break
        s.channels.set(op.id, {
          id: op.id,
          name: str(d.name, 50) || 'kanal',
          kind: d.kind === 'voice' ? 'voice' : 'text',
          category: typeof d.category === 'string' ? d.category : null,
          topic: str(d.topic, 200),
          order: num(d.order, op.ts),
          userLimit: Math.max(0, Math.min(99, num(d.userLimit, 0)))
        })
        break
      case 'channel-update': {
        const c = s.channels.get(d.target)
        if (!isAdmin(a) || !c) break
        if (d.deleted) { s.channels.delete(d.target); break }
        if (typeof d.name === 'string' && d.name.trim()) c.name = str(d.name, 50)
        if (typeof d.topic === 'string') c.topic = str(d.topic, 200)
        if ('category' in d) c.category = typeof d.category === 'string' ? d.category : null
        if (Number.isFinite(d.order)) c.order = d.order
        if (Number.isFinite(d.userLimit)) c.userLimit = Math.max(0, Math.min(99, d.userLimit))
        break
      }
      case 'bot-config': {
        if (!isAdmin(a) || !BOTS[d.bot]) break
        const chans = Array.isArray(d.channels) ? d.channels.filter(x => typeof x === 'string').slice(0, 50) : []
        s.bots.set(d.bot, { enabled: !!d.enabled, channels: new Set(chans) })
        break
      }
      case 'music': {
        const ch = s.channels.get(d.channel)
        if (!ch || ch.kind !== 'voice' || !s.members.has(a) || !botsFor(d.channel).has('music')) break
        const ev = { id: op.id, ts: op.ts, author: a, action: d.action }
        if (d.action === 'add') {
          const v = d.video || {}
          if (!YT_ID.test(v.id || '')) break
          ev.video = { id: v.id, title: str(v.title, 200) || 'YouTube videosu', duration: Math.max(0, Math.min(43200, Math.floor(num(v.duration, 0)))) }
        } else if (d.action === 'skip') {
          if (typeof d.target !== 'string') break
          ev.target = d.target
        } else if (d.action !== 'stop') break
        if (!s.music.has(d.channel)) s.music.set(d.channel, [])
        s.music.get(d.channel).push(ev)
        break
      }
      case 'pin': {
        const m = s.msgIndex.get(d.target)
        if (!m || !isAdmin(a)) break
        if (!s.pins.has(m.channel)) s.pins.set(m.channel, new Set())
        if (d.on) s.pins.get(m.channel).add(m.id); else s.pins.get(m.channel).delete(m.id)
        break
      }
      default:
        applyMessageOp(s, op, msgCtx)
    }
  }
  return s
}

// ---------- Özel alan (iki kişi) durumu ----------

function deriveDM (dmId, me, other, opsIterable) {
  const s = {
    id: dmId,
    status: 'none', // none | pending | friends
    requester: null,
    since: 0,
    profiles: new Map(),
    messages: new Map(),
    msgIndex: new Map(),
    lastTs: 0,
    lastFriendOp: null
  }
  const ctx = { canWrite: () => true, isMod: () => false, botsFor: () => new Set(['dice', 'poll']) }
  for (const op of sortOps(opsIterable)) {
    const a = op.author
    if (a !== me && a !== other) continue
    switch (op.type) {
      case 'friend-request':
        if (s.status === 'none') { s.status = 'pending'; s.requester = a } else if (s.status === 'pending' && s.requester !== a) { s.status = 'friends'; s.since = op.ts }
        s.lastFriendOp = op.ts
        break
      case 'friend-accept':
        if (s.status === 'pending' && s.requester !== a) { s.status = 'friends'; s.since = op.ts }
        s.lastFriendOp = op.ts
        break
      case 'friend-remove':
        s.status = 'none'
        s.requester = null
        s.lastFriendOp = op.ts
        break
      case 'profile':
        s.profiles.set(a, sanitizeProfile(op.data, op.ts))
        break
      default:
        applyMessageOp(s, op, ctx)
    }
  }
  return s
}

module.exports = { derive, deriveDM, musicState, rollDice, parsePoll, OP_TYPES, DM_TYPES, BOTS, LIMITS, sanitizeProfile, IMG_RE }
