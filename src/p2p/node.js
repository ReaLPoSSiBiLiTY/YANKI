'use strict'
/*
 * YANKI P2P düğümü
 * - Merkezi sunucu yok: eşler Hyperswarm DHT üzerinden birbirini bulur (NAT delme dahil).
 * - Her sunucu, üyelerinin ed25519 ile imzaladığı değişmez bir olay günlüğüdür.
 * - Her kullanıcı çifti için ayrı, yalnızca o iki kişi arasında eşitlenen özel bir alan vardır
 *   (arkadaşlık + özel mesajlar). Bu alan hiçbir üçüncü eşe gönderilmez.
 * - Kimlik anahtarı aynı zamanda ağ anahtarıdır: bir kullanıcıya açık anahtarıyla doğrudan
 *   bağlanılabilir (swarm.joinPeer).
 * - Geçici veriler (ses durumu, yazıyor..., çevrimiçi, etkinlik) kalıcı değildir.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { derive, deriveDM, musicState, OP_TYPES, DM_TYPES, BOTS, sanitizeProfile } = require('./state')
const identity = require('./identity')

const HEX64 = /^[0-9a-f]{64}$/
const MAX_LINE = 64 * 1024 * 1024
const MAX_OP_BYTES = 16 * 1024 * 1024
const BATCH_BYTES = 4 * 1024 * 1024
const PRESENCE_MS = 15000
const ONLINE_TTL = 45000
const SIG_QUEUE_MS = 25000
const ICON_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/

const sha256 = (x) => crypto.createHash('sha256').update(x).digest()
const canonical = (op) => JSON.stringify([1, op.type, op.server, op.author, op.ts, op.data ?? null])
const opId = (op) => sha256(canonical(op)).toString('hex')
const topicFor = (serverId) => sha256('yanki/v1/server/' + serverId)
const dmIdFor = (a, b) => sha256('yanki/v1/dm/' + [a, b].sort().join(':')).toString('hex')
const DM_MSG = new Set(['dm', 'dm-edit', 'dm-delete', 'dm-reaction', 'poll-vote'])

function sanitizeActivity (a) {
  if (!a || typeof a !== 'object') return null
  const type = a.type === 'music' ? 'music' : a.type === 'game' ? 'game' : null
  if (!type) return null
  return {
    type,
    name: String(a.name || '').slice(0, 80),
    details: String(a.details || '').slice(0, 140),
    service: String(a.service || '').slice(0, 30),
    icon: typeof a.icon === 'string' && a.icon.length < 24000 && ICON_RE.test(a.icon) ? a.icon : null,
    since: Number.isFinite(a.since) ? a.since : Date.now()
  }
}

/*
 * Op deposu. Profil gibi "son yazan kazanır" kayıtların eskileri budanır:
 * diskten silinir, yalnızca kimlikleri saklanır ki eşler onları tekrar göndermesin.
 */
class OpStore {
  constructor (dir, id, deriveFn) {
    this.dir = dir
    this.id = id
    this.deriveFn = deriveFn
    this.file = path.join(dir, 'ops.ndjson')
    this.prunedFile = path.join(dir, 'pruned.txt')
    this.ops = new Map()
    this.pruned = new Set()
    this.latestProfile = new Map()
    this._state = undefined
    this._prunedDirty = false
    fs.mkdirSync(dir, { recursive: true })
    if (fs.existsSync(this.prunedFile)) {
      for (const l of fs.readFileSync(this.prunedFile, 'utf8').split('\n')) if (l) this.pruned.add(l)
    }
    let lines = 0
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue
        lines++
        try {
          const op = JSON.parse(line)
          if (op && op.id && !this.pruned.has(op.id) && !this.ops.has(op.id)) this._track(op)
        } catch {}
      }
    }
    if (this.ops.size !== lines) this._rewrite()
    this._savePruned()
  }

  _track (op) {
    if (op.type === 'profile') {
      const prev = this.latestProfile.get(op.author)
      if (prev) {
        const newer = op.ts > prev.ts || (op.ts === prev.ts && op.id > prev.id)
        if (!newer) { this._prune(op.id); return false }
        this.ops.delete(prev.id)
        this._prune(prev.id)
      }
      this.latestProfile.set(op.author, op)
    }
    this.ops.set(op.id, op)
    return true
  }

  _prune (id) {
    if (!this.pruned.has(id)) { this.pruned.add(id); this._prunedDirty = true }
  }

  _savePruned () {
    if (!this._prunedDirty) return
    fs.writeFileSync(this.prunedFile, [...this.pruned].join('\n'))
    this._prunedDirty = false
  }

  _rewrite () {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, [...this.ops.values()].map(o => JSON.stringify(o)).join('\n') + (this.ops.size ? '\n' : ''))
    fs.renameSync(tmp, this.file)
  }

  has (id) { return this.ops.has(id) || this.pruned.has(id) }
  ids () { return [...this.ops.keys(), ...this.pruned] }

  add (op) {
    const kept = this._track(op)
    if (kept) fs.appendFileSync(this.file, JSON.stringify(op) + '\n')
    this._savePruned()
    this._state = undefined
    return kept
  }

  get state () {
    if (this._state === undefined) this._state = this.deriveFn(this.ops.values())
    return this._state
  }
}

class P2PNode extends EventEmitter {
  /**
   * @param {string} dataDir
   * @param {object} opts { swarmFactory?: (keyPair, firewall) => swarm, bootstrap? }
   */
  constructor (dataDir, opts = {}) {
    super()
    this.dir = dataDir
    this.opts = opts
    this.servers = new Map()
    this.dms = new Map() // karşı tarafın anahtarı -> OpStore
    this.peers = new Map()
    this.seen = new Map()
    this.presence = new Map()
    this.wants = new Map() // anahtar -> Set(sebep)  (doğrudan bağlantı istekleri)
    this.sigQueue = new Map()
    this.blocked = new Set()
    this.activity = null
    this.acts = new Map() // başkalarının son bilinen etkinliği
    this._lastTs = 0
    this.on('activity', (e) => { if (e.from !== this.me) this.acts.set(e.from, { act: e.act, at: Date.now() }) })
  }

  async start () {
    fs.mkdirSync(this.dir, { recursive: true })
    const idFile = path.join(this.dir, 'identity.json')
    let seed
    if (fs.existsSync(idFile)) {
      seed = Buffer.from(JSON.parse(fs.readFileSync(idFile, 'utf8')).seed, 'hex')
    } else {
      seed = crypto.randomBytes(32)
      fs.writeFileSync(idFile, JSON.stringify({ seed: seed.toString('hex') }), { mode: 0o600 })
    }
    this.id = identity.fromSeed(seed)
    this.me = this.id.publicKey.toString('hex')

    this.profileFile = path.join(this.dir, 'profile.json')
    this.profile = { name: '', avatar: null, banner: null, bio: '', status: '', pronouns: '', color: '#ff4f8b' }
    try { Object.assign(this.profile, JSON.parse(fs.readFileSync(this.profileFile, 'utf8'))) } catch {}

    this.blockFile = path.join(this.dir, 'blocked.json')
    try { for (const k of JSON.parse(fs.readFileSync(this.blockFile, 'utf8'))) if (HEX64.test(k)) this.blocked.add(k) } catch {}

    const sdir = path.join(this.dir, 'servers')
    fs.mkdirSync(sdir, { recursive: true })
    for (const name of fs.readdirSync(sdir)) {
      if (HEX64.test(name)) this.servers.set(name, this._serverStore(name))
    }
    const ddir = path.join(this.dir, 'dms')
    fs.mkdirSync(ddir, { recursive: true })
    for (const name of fs.readdirSync(ddir)) {
      if (HEX64.test(name) && name !== this.me) this.dms.set(name, this._dmStoreFor(name))
    }

    const firewall = (remotePublicKey) => this.blocked.has(Buffer.from(remotePublicKey).toString('hex'))
    const factory = this.opts.swarmFactory || ((keyPair) => {
      const Hyperswarm = require('hyperswarm')
      return new Hyperswarm({ keyPair, bootstrap: this.opts.bootstrap, firewall })
    })
    this.swarm = factory(this.id.swarmKeyPair, firewall)
    this.swarm.on('connection', (conn) => this._onConnection(conn))
    // Arkadaşlık istekleri için açık anahtarımızla her zaman ulaşılabilir ol
    try { const r = this.swarm.listen?.(); if (r && r.catch) r.catch(() => {}) } catch {}
    for (const id of this.servers.keys()) this._joinTopic(id)
    this._syncFriendWants()

    this._timer = setInterval(() => this._tick(), PRESENCE_MS)
    this._timer.unref?.()
    return this
  }

  async destroy () {
    clearInterval(this._timer)
    for (const p of this.peers.values()) { try { p.conn.destroy() } catch {} }
    try { await this.swarm.destroy() } catch {}
  }

  _serverStore (id) {
    return new OpStore(path.join(this.dir, 'servers', id), id, (ops) => derive(id, ops))
  }

  _dmStoreFor (key) {
    const dmId = dmIdFor(this.me, key)
    return new OpStore(path.join(this.dir, 'dms', key), dmId, (ops) => deriveDM(dmId, this.me, key, ops))
  }

  // ---------- Op oluşturma ve doğrulama ----------

  _createOp (scope, type, data) {
    const ts = Math.max(Date.now(), this._lastTs + 1)
    this._lastTs = ts
    const op = { type, server: scope, author: this.me, ts, data: data ?? null }
    op.id = opId(op)
    op.sig = identity.sign(this.id.privateKey, Buffer.from(op.id, 'hex'))
    return op
  }

  _validate (op, scope, types = OP_TYPES) {
    if (!op || typeof op !== 'object') return null
    if (!types.has(op.type)) return null
    if (typeof op.author !== 'string' || !HEX64.test(op.author)) return null
    if (!Number.isFinite(op.ts) || op.ts > Date.now() + 10 * 60 * 1000) return null
    if (typeof op.sig !== 'string' || typeof op.id !== 'string') return null
    if (op.type === 'genesis') { if (op.server !== '') return null } else if (op.server !== scope) return null
    const clean = { type: op.type, server: op.server, author: op.author, ts: op.ts, data: op.data ?? null }
    const c = canonical(clean)
    if (c.length > MAX_OP_BYTES) return null
    const id = sha256(c).toString('hex')
    if (id !== op.id) return null
    if (op.type === 'genesis' && id !== scope) return null
    if (!identity.verify(op.author, Buffer.from(id, 'hex'), op.sig)) return null
    clean.id = id
    clean.sig = op.sig
    return clean
  }

  _ingest (serverId, raw) {
    const store = this.servers.get(serverId)
    if (!store || !raw || store.has(raw.id)) return null
    const op = this._validate(raw, serverId)
    if (!op) return null
    return store.add(op) ? op : null
  }

  _signObj (arr) { return identity.sign(this.id.privateKey, Buffer.from(JSON.stringify(arr))) }
  _verifyObj (arr, sig, author) { return typeof sig === 'string' && identity.verify(author, Buffer.from(JSON.stringify(arr)), sig) }

  // ---------- Sunucular ----------

  listServers () {
    return [...this.servers.values()].map(st => {
      const s = st.state
      return { id: st.id, name: s ? s.name : 'Eşitleniyor…', icon: s ? s.icon : null, pending: !s }
    })
  }

  createServer (name, icon) {
    const genesis = this._createOp('', 'genesis', { name: String(name || 'Sunucum').slice(0, 60), icon: icon || null })
    const id = genesis.id
    const store = this._serverStore(id)
    this.servers.set(id, store)
    store.add(genesis)
    const add = (type, data) => { const op = this._createOp(id, type, data); store.add(op); return op.id }
    add('member-join', {})
    if (this.profile.name) add('profile', this.profile)
    const genel = add('category-create', { name: 'Genel', order: 0 })
    const genelCh = add('channel-create', { name: 'genel', kind: 'text', category: genel, topic: 'Hoş geldin! Sohbet burada başlar.', order: 0 })
    add('channel-create', { name: 'medya', kind: 'text', category: genel, topic: 'Resimler, videolar ve YouTube bağlantıları', order: 1 })
    const ses = add('category-create', { name: 'Sesli Kanallar', order: 1 })
    const sesCh = add('channel-create', { name: 'Sesli Sohbet', kind: 'voice', category: ses, order: 0 })
    add('channel-create', { name: 'Oyun Odası', kind: 'voice', category: ses, order: 1 })
    add('bot-config', { bot: 'welcome', enabled: true, channels: [genelCh] })
    add('bot-config', { bot: 'dice', enabled: true, channels: [genelCh] })
    add('bot-config', { bot: 'music', enabled: true, channels: [sesCh] })
    this._joinTopic(id)
    this._rehelloAll()
    this.emit('servers', this.listServers())
    return id
  }

  joinServer (serverId) {
    if (!HEX64.test(serverId)) throw new Error('Geçersiz davet kodu')
    if (!this.servers.has(serverId)) {
      const store = this._serverStore(serverId)
      this.servers.set(serverId, store)
      store.add(this._createOp(serverId, 'member-join', {}))
      if (this.profile.name) store.add(this._createOp(serverId, 'profile', this.profile))
      this._joinTopic(serverId)
      this._rehelloAll()
    }
    this.emit('servers', this.listServers())
    return serverId
  }

  leaveServer (serverId) {
    const store = this.servers.get(serverId)
    if (!store) return
    try { this.post(serverId, 'member-leave', {}) } catch {}
    try { this.swarm.leave(topicFor(serverId)) } catch {}
    this.servers.delete(serverId)
    setTimeout(() => { try { fs.rmSync(store.dir, { recursive: true, force: true }) } catch {} }, 1500)
    this._rehelloAll()
    this.emit('servers', this.listServers())
  }

  post (serverId, type, data) {
    const store = this.servers.get(serverId)
    if (!store) throw new Error('Sunucu bulunamadı')
    if (!OP_TYPES.has(type) || type === 'genesis') throw new Error('Geçersiz işlem')
    const op = this._createOp(serverId, type, data)
    store.add(op)
    this._broadcastOps(serverId, [op], null)
    this._emitOps(serverId, [op])
    return op.id
  }

  setProfile (p) {
    const clean = sanitizeProfile(p, Date.now())
    delete clean.updatedAt
    this.profile = clean
    fs.writeFileSync(this.profileFile, JSON.stringify(clean))
    for (const id of this.servers.keys()) this.post(id, 'profile', clean)
    for (const [key, st] of this.dms) {
      if (st.state.status !== 'none') this._dmPost(key, 'profile', clean)
    }
    return clean
  }

  onlineSet (serverId) {
    const set = new Set([this.me])
    for (const p of this.peers.values()) if (p.shared.has(serverId)) set.add(p.key)
    const pres = this.presence.get(serverId)
    if (pres) for (const [k, t] of pres) if (Date.now() - t < ONLINE_TTL) set.add(k)
    return set
  }

  isOnline (key) {
    if (key === this.me || this.peers.has(key)) return true
    for (const pres of this.presence.values()) {
      const t = pres.get(key)
      if (t && Date.now() - t < ONLINE_TTL) return true
    }
    return false
  }

  meta (serverId) {
    const store = this.servers.get(serverId)
    if (!store) return null
    const s = store.state
    if (!s) return { id: serverId, pending: true, me: this.me, peers: this._peerCount(serverId) }
    const online = this.onlineSet(serverId)
    const now = Date.now()
    const channels = [...s.channels.values()].map(c => {
      const list = s.messages.get(c.id) || []
      let last = null
      for (let i = list.length - 1; i >= 0; i--) if (!list[i].deleted) { last = list[i]; break }
      const out = { ...c, lastTs: last ? last.ts : 0, lastAuthor: last ? last.author : null, pins: [...(s.pins.get(c.id) || [])] }
      if (c.kind === 'voice' && s.music.has(c.id)) {
        const ms = musicState(s.music.get(c.id), now)
        out.music = ms.playing ? { title: ms.playing.video.title, id: ms.playing.video.id } : null
      }
      return out
    }).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const categories = [...s.categories.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const members = [...s.members.entries()].map(([key, m]) => ({
      key,
      joinedAt: m.joinedAt,
      profile: s.profiles.get(key) || null,
      owner: key === s.owner,
      admin: s.admins.has(key),
      online: online.has(key)
    }))
    const bots = Object.keys(BOTS).map(id => {
      const b = s.bots.get(id)
      return { id, kind: BOTS[id].kind, enabled: !!(b && b.enabled), channels: b ? [...b.channels] : [] }
    })
    return {
      id: s.id, name: s.name, icon: s.icon, banner: s.banner, description: s.description,
      owner: s.owner, me: this.me, isAdmin: s.admins.has(this.me), createdAt: s.createdAt,
      categories, channels, members, bots,
      banned: [...s.banned].map(k => ({ key: k, profile: s.profiles.get(k) || null })),
      peers: this._peerCount(serverId)
    }
  }

  _formatMessages (s, channelId, { before = null, limit = 100 } = {}) {
    let list = (s.messages.get(channelId) || []).filter(m => !m.deleted)
    if (before) { const i = list.findIndex(m => m.id === before); if (i >= 0) list = list.slice(0, i) }
    const slice = list.slice(-Math.min(500, limit))
    return slice.map(m => {
      let reply = null
      if (m.replyTo) {
        const r = s.msgIndex.get(m.replyTo)
        if (r && !r.deleted) reply = { id: r.id, author: r.author, text: r.text.slice(0, 140), hasImage: r.attachments.length > 0 }
      }
      let poll = null
      if (m.poll) {
        const counts = m.poll.options.map(() => 0)
        for (const v of m.poll.votes.values()) counts[v]++
        poll = { question: m.poll.question, options: m.poll.options, counts, total: m.poll.votes.size, mine: m.poll.votes.has(this.me) ? m.poll.votes.get(this.me) : -1 }
      }
      return {
        id: m.id, channel: m.channel, author: m.author, ts: m.ts, text: m.text, attachments: m.attachments,
        replyTo: m.replyTo, edited: m.edited, reactions: m.reactions, bot: m.bot, poll, reply
      }
    })
  }

  messages (serverId, channelId, opts = {}) {
    const s = this.servers.get(serverId)?.state
    if (!s) return []
    return this._formatMessages(s, channelId, opts)
  }

  music (serverId, channelId) {
    const s = this.servers.get(serverId)?.state
    if (!s) return { playing: null, queue: [] }
    return musicState(s.music.get(channelId), Date.now())
  }

  // ---------- Arkadaşlar ve özel mesajlar ----------

  _dmStore (key, create) {
    let st = this.dms.get(key)
    if (!st && create) {
      st = this._dmStoreFor(key)
      this.dms.set(key, st)
    }
    return st || null
  }

  friendStatus (key) {
    const st = this.dms.get(key)?.state
    if (!st || st.status === 'none') return 'none'
    if (st.status === 'friends') return 'friends'
    return st.requester === this.me ? 'outgoing' : 'incoming'
  }

  sharesServer (key) {
    for (const st of this.servers.values()) if (st.state?.members.has(key)) return true
    return false
  }

  _profileOf (key) {
    let best = this.dms.get(key)?.state?.profiles.get(key) || null
    for (const st of this.servers.values()) {
      const p = st.state?.profiles.get(key)
      if (p && (!best || p.updatedAt > best.updatedAt)) best = p
    }
    return best
  }

  _dmPost (key, type, data) {
    const store = this._dmStore(key, true)
    const op = this._createOp(store.id, type, data)
    store.add(op)
    this._sendDM(key, [op])
    this._emitDM(key, [op])
    return op.id
  }

  _ensureMyProfileIn (key) {
    if (!this.profile.name) return
    const st = this.dms.get(key)
    const mine = st?.latestProfile.get(this.me)
    if (!mine || JSON.stringify(mine.data) !== JSON.stringify(this.profile)) this._dmPost(key, 'profile', this.profile)
  }

  friendRequest (key) {
    key = String(key || '').trim().toLowerCase().replace(/^yanki:\/*(arkadas\/)?/, '')
    if (!HEX64.test(key)) throw new Error('Geçersiz arkadaş kodu')
    if (key === this.me) throw new Error('Kendini ekleyemezsin')
    if (this.blocked.has(key)) this.unblock(key)
    const status = this.friendStatus(key)
    if (status === 'friends' || status === 'outgoing') return status
    if (status === 'incoming') return this.friendAccept(key)
    this._dmPost(key, 'friend-request', {})
    this._ensureMyProfileIn(key)
    this._syncFriendWants()
    this.emit('friends')
    return this.friendStatus(key)
  }

  friendAccept (key) {
    if (this.friendStatus(key) !== 'incoming') return this.friendStatus(key)
    this._dmPost(key, 'friend-accept', {})
    this._ensureMyProfileIn(key)
    this._syncFriendWants()
    this.emit('friends')
    return 'friends'
  }

  friendRemove (key) {
    if (this.friendStatus(key) === 'none') return 'none'
    this._dmPost(key, 'friend-remove', {})
    this._syncFriendWants()
    this.emit('friends')
    return 'none'
  }

  block (key) {
    if (!HEX64.test(key) || key === this.me) return
    try { this.friendRemove(key) } catch {}
    this.blocked.add(key)
    fs.writeFileSync(this.blockFile, JSON.stringify([...this.blocked]))
    this.wantPeer(key, 'friend', false)
    this.wantPeer(key, 'dm', false)
    const p = this.peers.get(key)
    if (p) { try { p.conn.destroy() } catch {} }
    this.emit('friends')
  }

  unblock (key) {
    this.blocked.delete(key)
    fs.writeFileSync(this.blockFile, JSON.stringify([...this.blocked]))
    this.emit('friends')
  }

  canDM (key) {
    if (this.blocked.has(key)) return false
    return this.friendStatus(key) === 'friends' || this.sharesServer(key)
  }

  dmPost (key, type, data) {
    if (!HEX64.test(key) || !DM_MSG.has(type)) throw new Error('Geçersiz işlem')
    if (!this.canDM(key)) throw new Error('Bu kişiye mesaj atmak için önce arkadaş olmalısınız')
    this._ensureMyProfileIn(key)
    this.wantPeer(key, 'dm', true)
    return this._dmPost(key, type, data)
  }

  dmMessages (key, opts = {}) {
    const st = this.dms.get(key)?.state
    if (!st) return []
    return this._formatMessages(st, 'dm', opts)
  }

  dmTyping (key) {
    this.peers.get(key)?.send({ t: 'dmtyp' })
  }

  dmList () {
    const out = []
    for (const [key, store] of this.dms) {
      if (this.blocked.has(key)) continue
      const st = store.state
      const list = st.messages.get('dm') || []
      let last = null
      for (let i = list.length - 1; i >= 0; i--) if (!list[i].deleted) { last = list[i]; break }
      out.push({
        key,
        status: this.friendStatus(key),
        since: st.since,
        lastTs: last ? last.ts : 0,
        lastAuthor: last ? last.author : null,
        lastText: last ? (last.text.slice(0, 80) || (last.attachments.length ? '📷 Resim' : '')) : '',
        friendTs: st.lastFriendOp || 0,
        profile: this._profileOf(key),
        online: this.isOnline(key)
      })
    }
    return out
  }

  blockedList () {
    return [...this.blocked].map(key => ({ key, profile: this._profileOf(key) }))
  }

  _syncFriendWants () {
    for (const [key, st] of this.dms) {
      const want = !this.blocked.has(key) && st.state.status !== 'none'
      this.wantPeer(key, 'friend', want)
    }
  }

  _sendDM (key, ops) {
    const p = this.peers.get(key)
    if (p) this._sendBatched(p, (batch) => ({ t: 'dmops', ops: batch }), ops)
  }

  _emitDM (key, ops) {
    this.emit('dm', {
      peer: key,
      ops: ops.map(o => ({
        id: o.id, type: o.type, author: o.author, ts: o.ts,
        text: o.type === 'dm' && o.data ? String(o.data.text || '').slice(0, 200) : undefined,
        hasImage: o.type === 'dm' && Array.isArray(o.data?.attachments) && o.data.attachments.length > 0
      }))
    })
  }

  _ingestDM (key, raw) {
    if (this.blocked.has(key) || !raw) return null
    const dmId = dmIdFor(this.me, key)
    const existing = this.dms.get(key)
    if (existing && existing.has(raw.id)) return null
    const op = this._validate(raw, dmId, DM_TYPES)
    if (!op || (op.author !== key && op.author !== this.me)) return null
    if (op.author === key) {
      if (DM_MSG.has(op.type) && !this.canDM(key)) return null
      if (op.type === 'profile' && !existing) return null
    }
    const store = this._dmStore(key, true)
    return store.add(op) ? op : null
  }

  // ---------- Etkinlik (oyun / müzik) ----------

  activities () {
    const out = []
    for (const [key, v] of this.acts) if (v.act && Date.now() - v.at < 50000) out.push({ key, act: v.act })
    return out
  }

  setActivity (act) {
    this.activity = sanitizeActivity(act)
    for (const id of this.servers.keys()) this.sendEph(id, 'activity', this.activity)
    for (const p of this.peers.values()) if (this.dms.has(p.key)) p.send({ t: 'act', d: this.activity })
  }

  // ---------- Geçici mesajlar ve sinyalleşme ----------

  sendEph (serverId, kind, data) {
    if (!this.servers.has(serverId)) return
    const m = { t: 'eph', s: serverId, from: this.me, k: String(kind), d: data ?? null, n: crypto.randomBytes(9).toString('hex'), at: Date.now(), ttl: 2 }
    m.sig = this._signObj([m.s, m.from, m.k, m.d, m.n, m.at])
    this._markSeen(m.n)
    for (const p of this.peers.values()) if (p.shared.has(serverId)) p.send(m)
  }

  sendSignal (to, data) {
    if (!HEX64.test(to)) return
    const m = { t: 'sig', to, from: this.me, d: data ?? null, n: crypto.randomBytes(9).toString('hex'), at: Date.now(), ttl: 2 }
    m.sig = this._signObj([m.to, m.from, m.d, m.n, m.at])
    this._markSeen(m.n)
    const direct = this.peers.get(to)
    if (direct) return direct.send(m)
    // Doğrudan bağlantı yok: ortak eşler üzerinden aktar ve doğrudan bağlantı kurulunca tekrar gönder
    for (const p of this.peers.values()) p.send(m)
    if (!this.sigQueue.has(to)) this.sigQueue.set(to, [])
    const q = this.sigQueue.get(to)
    q.push(m)
    while (q.length > 200 || (q.length && Date.now() - q[0].at > SIG_QUEUE_MS)) q.shift()
  }

  // Bir eşle doğrudan bağlantı iste (ör. aynı ses kanalındayken ya da arkadaşken)
  wantPeer (key, reason, on = true) {
    if (!HEX64.test(key) || key === this.me) return
    let set = this.wants.get(key)
    if (on) {
      if (this.blocked.has(key)) return
      if (!set) {
        set = new Set()
        this.wants.set(key, set)
        try { this.swarm.joinPeer?.(Buffer.from(key, 'hex')) } catch {}
      }
      set.add(reason)
    } else if (set) {
      set.delete(reason)
      if (!set.size) {
        this.wants.delete(key)
        try { this.swarm.leavePeer?.(Buffer.from(key, 'hex')) } catch {}
      }
    }
  }

  // ---------- Ağ ----------

  _peerCount (serverId) {
    let n = 0
    for (const p of this.peers.values()) if (p.shared.has(serverId)) n++
    return n
  }

  _joinTopic (serverId) {
    try { this.swarm.join(topicFor(serverId), { server: true, client: true }) } catch (e) { this.emit('error', e) }
  }

  _onConnection (conn) {
    const key = Buffer.from(conn.remotePublicKey).toString('hex')
    if (key === this.me || this.blocked.has(key)) { conn.destroy(); return }
    const peer = {
      key,
      conn,
      shared: new Set(),
      dmReplied: false,
      send: (m) => { try { if (!conn.destroyed) conn.write(JSON.stringify(m) + '\n') } catch {} }
    }
    const old = this.peers.get(key)
    this.peers.set(key, peer)
    if (old && old.conn !== conn) { try { old.conn.destroy() } catch {} }

    conn.on('error', () => {})
    conn.on('close', () => {
      if (this.peers.get(key) !== peer) return
      this.peers.delete(key)
      this.emit('peers', [...peer.shared])
      if (this.dms.has(key)) this.emit('friends')
    })

    let pending = []
    let pendingLen = 0
    conn.on('data', (chunk) => {
      let start = 0
      let idx
      while ((idx = chunk.indexOf(10, start)) !== -1) {
        pending.push(chunk.subarray(start, idx))
        const line = Buffer.concat(pending).toString('utf8')
        pending = []
        pendingLen = 0
        start = idx + 1
        if (line) this._onMessage(peer, line)
      }
      if (start < chunk.length) {
        pending.push(chunk.subarray(start))
        pendingLen += chunk.length - start
        if (pendingLen > MAX_LINE) conn.destroy()
      }
    })
    this._sendHello(peer, false)

    // Özel alan eşitlemesi
    const dm = this.dms.get(key)
    if (dm) {
      peer.send({ t: 'dmhave', ids: dm.ids() })
      if (this.activity) peer.send({ t: 'act', d: this.activity })
      this.emit('friends')
    }
    // Bu eşe bekleyen WebRTC sinyalleri
    const q = this.sigQueue.get(key)
    if (q) {
      this.sigQueue.delete(key)
      for (const m of q) if (Date.now() - m.at < SIG_QUEUE_MS) peer.send(m)
    }
  }

  // Sunucu kimlikleri eş çiftine özgü bir özetle gizlenir: karşı taraf,
  // kendisinin de üyesi olmadığı sunucuları öğrenemez.
  _tags (peer) {
    const pair = [this.me, peer.key].sort().join(':')
    return [...this.servers.keys()].map(id => ({ id, tag: sha256(id + ':' + pair).toString('hex') }))
  }

  _sendHello (peer, reply) {
    peer.send({ t: 'hello', v: 2, reply, tags: this._tags(peer).map(x => x.tag) })
  }

  _rehelloAll () { for (const p of this.peers.values()) this._sendHello(p, false) }

  _onHello (peer, m) {
    const theirs = new Set(Array.isArray(m.tags) ? m.tags : [])
    const before = peer.shared
    const next = new Set()
    for (const { id, tag } of this._tags(peer)) {
      if (!theirs.has(tag)) continue
      const st = this.servers.get(id).state
      if (st && st.banned.has(peer.key)) continue
      next.add(id)
    }
    peer.shared = next
    const changed = next.size !== before.size || [...next].some(x => !before.has(x))
    for (const s of next) {
      if (!before.has(s)) peer.send({ t: 'have', s, ids: this.servers.get(s).ids() })
    }
    if (changed && !m.reply) this._sendHello(peer, true)
    if (changed) this.emit('peers', [...new Set([...before, ...next])])
  }

  _onMessage (peer, line) {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m !== 'object') return
    switch (m.t) {
      case 'hello': return this._onHello(peer, m)
      case 'have': {
        if (!peer.shared.has(m.s) || !Array.isArray(m.ids)) return
        const theirs = new Set(m.ids)
        const missing = []
        for (const [id, op] of this.servers.get(m.s).ops) if (!theirs.has(id)) missing.push(op)
        missing.sort((a, b) => a.ts - b.ts)
        return this._sendBatched(peer, (batch) => ({ t: 'ops', s: m.s, ops: batch }), missing)
      }
      case 'ops': {
        if (!peer.shared.has(m.s) || !Array.isArray(m.ops)) return
        const fresh = []
        for (const raw of m.ops) { const op = this._ingest(m.s, raw); if (op) fresh.push(op) }
        if (fresh.length) {
          this._broadcastOps(m.s, fresh, peer.key)
          this._emitOps(m.s, fresh)
          if (fresh.some(o => o.type === 'genesis' || o.type === 'server-update')) this.emit('servers', this.listServers())
          if (fresh.some(o => o.type === 'ban')) this._dropBanned(m.s)
        }
        return
      }
      case 'dmhave': {
        if (!Array.isArray(m.ids)) return
        const store = this.dms.get(peer.key)
        if (store) {
          const theirs = new Set(m.ids)
          const missing = [...store.ops.values()].filter(o => !theirs.has(o.id)).sort((a, b) => a.ts - b.ts)
          this._sendBatched(peer, (batch) => ({ t: 'dmops', ops: batch }), missing)
        } else if (!peer.dmReplied) {
          peer.dmReplied = true
          peer.send({ t: 'dmhave', ids: [] })
        }
        return
      }
      case 'dmops': {
        if (!Array.isArray(m.ops)) return
        const before = this.friendStatus(peer.key)
        const prio = (o) => (o && typeof o.type === 'string' && o.type.startsWith('friend') ? 0 : 1)
        const fresh = []
        for (const raw of [...m.ops].sort((a, b) => prio(a) - prio(b))) {
          const op = this._ingestDM(peer.key, raw)
          if (op) fresh.push(op)
        }
        if (fresh.length) {
          this._emitDM(peer.key, fresh)
          if (this.friendStatus(peer.key) !== before) {
            this._syncFriendWants()
            this.emit('friends')
          }
        }
        return
      }
      case 'act':
        if (this.dms.has(peer.key)) this.emit('activity', { from: peer.key, act: sanitizeActivity(m.d) })
        return
      case 'dmtyp':
        if (this.dms.has(peer.key) || this.sharesServer(peer.key)) this.emit('dmtyping', { from: peer.key })
        return
      case 'eph': return this._onEph(peer, m)
      case 'sig': return this._onSig(peer, m)
    }
  }

  _sendBatched (peer, wrap, ops) {
    let batch = []
    let size = 0
    for (const op of ops) {
      const len = JSON.stringify(op).length
      if (batch.length && size + len > BATCH_BYTES) { peer.send(wrap(batch)); batch = []; size = 0 }
      batch.push(op)
      size += len
    }
    if (batch.length) peer.send(wrap(batch))
  }

  _broadcastOps (serverId, ops, exceptKey) {
    for (const p of this.peers.values()) {
      if (p.key !== exceptKey && p.shared.has(serverId)) this._sendBatched(p, (batch) => ({ t: 'ops', s: serverId, ops: batch }), ops)
    }
  }

  _dropBanned (serverId) {
    const st = this.servers.get(serverId)?.state
    if (!st) return
    for (const p of this.peers.values()) if (st.banned.has(p.key)) p.shared.delete(serverId)
  }

  _emitOps (serverId, ops) {
    this.emit('ops', {
      server: serverId,
      ops: ops.map(o => ({
        id: o.id, type: o.type, author: o.author, ts: o.ts,
        channel: o.data && typeof o.data.channel === 'string' ? o.data.channel : null,
        text: o.type === 'message' && o.data ? String(o.data.text || '').slice(0, 200) : undefined,
        hasImage: o.type === 'message' && Array.isArray(o.data?.attachments) && o.data.attachments.length > 0
      }))
    })
  }

  _markSeen (n) { this.seen.set(n, Date.now()) }

  _onEph (peer, m) {
    if (typeof m.n !== 'string' || this.seen.has(m.n)) return
    this._markSeen(m.n)
    if (!peer.shared.has(m.s) || typeof m.from !== 'string' || !HEX64.test(m.from) || m.from === this.me) return
    if (!Number.isFinite(m.at) || Math.abs(Date.now() - m.at) > 90000) return
    if (!this._verifyObj([m.s, m.from, m.k, m.d, m.n, m.at], m.sig, m.from)) return
    const st = this.servers.get(m.s)?.state
    if (st && st.banned.has(m.from)) return
    if (!this.presence.has(m.s)) this.presence.set(m.s, new Map())
    const pres = this.presence.get(m.s)
    const wasOnline = pres.has(m.from) && Date.now() - pres.get(m.from) < ONLINE_TTL
    pres.set(m.from, Date.now())
    if (!wasOnline) this.emit('peers', [m.s])
    if (m.k === 'presence' && m.d && 'act' in m.d) this.emit('activity', { from: m.from, act: sanitizeActivity(m.d.act) })
    else if (m.k === 'activity') this.emit('activity', { from: m.from, act: sanitizeActivity(m.d) })
    else this.emit('eph', { server: m.s, from: m.from, kind: m.k, data: m.d })
    if (m.ttl > 0) {
      const fwd = { ...m, ttl: m.ttl - 1 }
      for (const p of this.peers.values()) if (p !== peer && p.key !== m.from && p.shared.has(m.s)) p.send(fwd)
    }
  }

  _onSig (peer, m) {
    if (typeof m.n !== 'string' || this.seen.has(m.n)) return
    this._markSeen(m.n)
    if (typeof m.from !== 'string' || !HEX64.test(m.from) || typeof m.to !== 'string') return
    if (!Number.isFinite(m.at) || Math.abs(Date.now() - m.at) > 90000) return
    if (m.to === this.me) {
      if (!this._verifyObj([m.to, m.from, m.d, m.n, m.at], m.sig, m.from)) return
      if (this.blocked.has(m.from)) return
      this.emit('signal', { from: m.from, data: m.d })
    } else if (m.ttl > 0 && peer.shared.size) {
      const fwd = { ...m, ttl: m.ttl - 1 }
      const target = this.peers.get(m.to)
      if (target) { target.send(fwd); return }
      if (fwd.ttl > 0) {
        for (const p of this.peers.values()) {
          if (p !== peer && p.key !== m.from && [...peer.shared].some(s => p.shared.has(s))) p.send(fwd)
        }
      }
    }
  }

  _tick () {
    for (const id of this.servers.keys()) this.sendEph(id, 'presence', { act: this.activity })
    for (const p of this.peers.values()) if (this.dms.has(p.key)) p.send({ t: 'act', d: this.activity })
    const now = Date.now()
    for (const [n, t] of this.seen) if (now - t > 180000) this.seen.delete(n)
    for (const [k, q] of this.sigQueue) {
      while (q.length && now - q[0].at > SIG_QUEUE_MS) q.shift()
      if (!q.length) this.sigQueue.delete(k)
    }
    for (const [s, pres] of this.presence) {
      let dropped = false
      for (const [k, t] of pres) if (now - t > ONLINE_TTL) { pres.delete(k); dropped = true }
      if (dropped) this.emit('peers', [s])
    }
  }
}

module.exports = { P2PNode, topicFor, opId, dmIdFor, sanitizeActivity }
