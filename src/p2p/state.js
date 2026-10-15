'use strict'
/*
 * Olay günlüğünden (op log) sunucu durumunu türetir.
 * Tüm eşler aynı imzalı op kümesine sahip olduğunda aynı durumu hesaplar
 * (sıralama: zaman damgası, eşitlikte op kimliği).
 */

const OP_TYPES = new Set([
  'genesis', 'server-update', 'role-set', 'kick', 'ban', 'unban',
  'member-join', 'member-leave', 'profile',
  'category-create', 'category-update',
  'channel-create', 'channel-update',
  'message', 'message-edit', 'message-delete', 'reaction', 'pin'
])

const IMG_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v, d) => (Number.isFinite(v) ? v : d)
const img = (v, maxLen) => (typeof v === 'string' && v.length <= maxLen && IMG_RE.test(v) ? v : null)

function sanitizeProfile (d, ts) {
  d = d || {}
  return {
    name: str(d.name, 32).trim() || 'Anonim',
    avatar: img(d.avatar, 600 * 1024),
    banner: img(d.banner, 1600 * 1024),
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
    const data = img(a.data, 10 * 1024 * 1024)
    if (!data) continue
    out.push({ type: 'image', data, name: str(a.name, 120) || 'resim', w: num(a.w, 0), h: num(a.h, 0) })
  }
  return out
}

function sortOps (ops) {
  return [...ops].sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

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
    icon: img(g.icon, 600 * 1024),
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
    pins: new Map() // kanalId -> Set(mesajId)
  }
  const isAdmin = a => s.admins.has(a)
  const canModerate = (a, target) => isAdmin(a) && target !== owner && (!s.admins.has(target) || a === owner)

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
        if ('icon' in d) s.icon = img(d.icon, 600 * 1024)
        if ('banner' in d) s.banner = img(d.banner, 1600 * 1024)
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
      case 'message': {
        const ch = s.channels.get(d.channel)
        if (!ch || ch.kind !== 'text' || !s.members.has(a)) break
        const text = str(d.text, 4000)
        const attachments = sanitizeAttachments(d.attachments)
        if (!text.trim() && !attachments.length) break
        const m = {
          id: op.id, channel: d.channel, author: a, ts: op.ts, text, attachments,
          replyTo: typeof d.replyTo === 'string' ? d.replyTo : null,
          edited: null, deleted: false, reactions: {}
        }
        if (!s.messages.has(d.channel)) s.messages.set(d.channel, [])
        s.messages.get(d.channel).push(m)
        s.msgIndex.set(op.id, m)
        break
      }
      case 'message-edit': {
        const m = s.msgIndex.get(d.target)
        if (!m || m.author !== a || m.deleted) break
        const text = str(d.text, 4000)
        if (!text.trim() && !m.attachments.length) break
        m.text = text
        m.edited = op.ts
        break
      }
      case 'message-delete': {
        const m = s.msgIndex.get(d.target)
        if (m && (m.author === a || isAdmin(a))) m.deleted = true
        break
      }
      case 'reaction': {
        const m = s.msgIndex.get(d.target)
        const emoji = str(d.emoji, 16)
        if (!m || !emoji || !s.members.has(a)) break
        const set = new Set(m.reactions[emoji] || [])
        if (d.on) set.add(a); else set.delete(a)
        if (set.size) m.reactions[emoji] = [...set]
        else delete m.reactions[emoji]
        break
      }
      case 'pin': {
        const m = s.msgIndex.get(d.target)
        if (!m || !isAdmin(a)) break
        if (!s.pins.has(m.channel)) s.pins.set(m.channel, new Set())
        if (d.on) s.pins.get(m.channel).add(m.id); else s.pins.get(m.channel).delete(m.id)
        break
      }
    }
  }
  return s
}

module.exports = { derive, OP_TYPES, sanitizeProfile, IMG_RE }
