'use strict'
/*
 * Yankı P2P düğümü
 * - Merkezi sunucu yok: eşler Hyperswarm DHT üzerinden birbirini bulur (NAT delme dahil).
 * - Her sunucu, üyelerinin ed25519 ile imzaladığı değişmez bir olay günlüğüdür.
 * - Eşler bağlandığında günlükleri karşılaştırır, eksikleri gönderir (gossip).
 * - Geçici veriler (ses durumu, yazıyor..., çevrimiçi) imzalı ama kalıcı değildir.
 * - WebRTC sinyalleşmesi de aynı şifreli eş bağlantıları üzerinden yapılır.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { derive, OP_TYPES, sanitizeProfile } = require('./state')
const identity = require('./identity')

const HEX64 = /^[0-9a-f]{64}$/
const MAX_LINE = 64 * 1024 * 1024
const MAX_OP_BYTES = 14 * 1024 * 1024
const BATCH_BYTES = 4 * 1024 * 1024
const PRESENCE_MS = 15000
const ONLINE_TTL = 45000

const sha256 = (x) => crypto.createHash('sha256').update(x).digest()
const canonical = (op) => JSON.stringify([1, op.type, op.server, op.author, op.ts, op.data ?? null])
const opId = (op) => sha256(canonical(op)).toString('hex')
const topicFor = (serverId) => sha256('yanki/v1/server/' + serverId)

class ServerStore {
  constructor (dir, id) {
    this.dir = dir
    this.id = id
    this.file = path.join(dir, 'ops.ndjson')
    this.ops = new Map()
    this._state = undefined
    fs.mkdirSync(dir, { recursive: true })
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue
        try { const op = JSON.parse(line); if (op && op.id) this.ops.set(op.id, op) } catch {}
      }
    }
  }

  has (id) { return this.ops.has(id) }

  add (op) {
    this.ops.set(op.id, op)
    fs.appendFileSync(this.file, JSON.stringify(op) + '\n')
    this._state = undefined
  }

  get state () {
    if (this._state === undefined) this._state = derive(this.id, this.ops.values())
    return this._state
  }
}

class P2PNode extends EventEmitter {
  /**
   * @param {string} dataDir
   * @param {object} opts { swarmFactory?: (keyPair) => swarm, bootstrap? }
   */
  constructor (dataDir, opts = {}) {
    super()
    this.dir = dataDir
    this.opts = opts
    this.servers = new Map()
    this.peers = new Map()
    this.seen = new Map()
    this.presence = new Map()
    this._lastTs = 0
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
    this.profile = { name: '', avatar: null, banner: null, bio: '', status: '', pronouns: '', color: '#7c5cff' }
    try { Object.assign(this.profile, JSON.parse(fs.readFileSync(this.profileFile, 'utf8'))) } catch {}

    const sdir = path.join(this.dir, 'servers')
    fs.mkdirSync(sdir, { recursive: true })
    for (const name of fs.readdirSync(sdir)) {
      if (HEX64.test(name)) this.servers.set(name, new ServerStore(path.join(sdir, name), name))
    }

    const factory = this.opts.swarmFactory || ((keyPair) => {
      const Hyperswarm = require('hyperswarm')
      return new Hyperswarm({ keyPair, bootstrap: this.opts.bootstrap })
    })
    this.swarm = factory(this.id.swarmKeyPair)
    this.swarm.on('connection', (conn) => this._onConnection(conn))
    for (const id of this.servers.keys()) this._joinTopic(id)

    this._timer = setInterval(() => this._tick(), PRESENCE_MS)
    this._timer.unref?.()
    return this
  }

  async destroy () {
    clearInterval(this._timer)
    for (const p of this.peers.values()) { try { p.conn.destroy() } catch {} }
    try { await this.swarm.destroy() } catch {}
  }

  // ---------- Op oluşturma ve doğrulama ----------

  _createOp (serverId, type, data) {
    const ts = Math.max(Date.now(), this._lastTs + 1)
    this._lastTs = ts
    const op = { type, server: serverId, author: this.me, ts, data: data ?? null }
    op.id = opId(op)
    op.sig = identity.sign(this.id.privateKey, Buffer.from(op.id, 'hex'))
    return op
  }

  _validate (op, serverId) {
    if (!op || typeof op !== 'object') return null
    if (!OP_TYPES.has(op.type)) return null
    if (typeof op.author !== 'string' || !HEX64.test(op.author)) return null
    if (!Number.isFinite(op.ts) || op.ts > Date.now() + 10 * 60 * 1000) return null
    if (typeof op.sig !== 'string' || typeof op.id !== 'string') return null
    if (op.type === 'genesis') { if (op.server !== '') return null } else if (op.server !== serverId) return null
    const clean = { type: op.type, server: op.server, author: op.author, ts: op.ts, data: op.data ?? null }
    const c = canonical(clean)
    if (c.length > MAX_OP_BYTES) return null
    const id = sha256(c).toString('hex')
    if (id !== op.id) return null
    if (op.type === 'genesis' && id !== serverId) return null
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
    store.add(op)
    return op
  }

  _signObj (arr) { return identity.sign(this.id.privateKey, Buffer.from(JSON.stringify(arr))) }
  _verifyObj (arr, sig, author) { return typeof sig === 'string' && identity.verify(author, Buffer.from(JSON.stringify(arr)), sig) }

  // ---------- Genel API ----------

  listServers () {
    return [...this.servers.values()].map(st => {
      const s = st.state
      return { id: st.id, name: s ? s.name : 'Eşitleniyor…', icon: s ? s.icon : null, pending: !s }
    })
  }

  createServer (name, icon) {
    const genesis = this._createOp('', 'genesis', { name: String(name || 'Sunucum').slice(0, 60), icon: icon || null })
    const id = genesis.id
    const store = new ServerStore(path.join(this.dir, 'servers', id), id)
    this.servers.set(id, store)
    store.add(genesis)
    const add = (type, data) => { const op = this._createOp(id, type, data); store.add(op); return op.id }
    add('member-join', {})
    if (this.profile.name) add('profile', this.profile)
    const genel = add('category-create', { name: 'Genel', order: 0 })
    add('channel-create', { name: 'genel', kind: 'text', category: genel, topic: 'Hoş geldin! Sohbet burada başlar.', order: 0 })
    add('channel-create', { name: 'medya', kind: 'text', category: genel, topic: 'Resimler, videolar ve YouTube bağlantıları', order: 1 })
    const ses = add('category-create', { name: 'Sesli Kanallar', order: 1 })
    add('channel-create', { name: 'Sesli Sohbet', kind: 'voice', category: ses, order: 0 })
    add('channel-create', { name: 'Oyun Odası', kind: 'voice', category: ses, order: 1 })
    this._joinTopic(id)
    this._rehelloAll()
    this.emit('servers', this.listServers())
    return id
  }

  joinServer (serverId) {
    if (!HEX64.test(serverId)) throw new Error('Geçersiz davet kodu')
    if (!this.servers.has(serverId)) {
      const store = new ServerStore(path.join(this.dir, 'servers', serverId), serverId)
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
    return clean
  }

  onlineSet (serverId) {
    const set = new Set([this.me])
    for (const p of this.peers.values()) if (p.shared.has(serverId)) set.add(p.key)
    const pres = this.presence.get(serverId)
    if (pres) for (const [k, t] of pres) if (Date.now() - t < ONLINE_TTL) set.add(k)
    return set
  }

  meta (serverId) {
    const store = this.servers.get(serverId)
    if (!store) return null
    const s = store.state
    if (!s) return { id: serverId, pending: true, me: this.me, peers: this._peerCount(serverId) }
    const online = this.onlineSet(serverId)
    const channels = [...s.channels.values()].map(c => {
      const list = s.messages.get(c.id) || []
      let last = null
      for (let i = list.length - 1; i >= 0; i--) if (!list[i].deleted) { last = list[i]; break }
      return { ...c, lastTs: last ? last.ts : 0, lastAuthor: last ? last.author : null, pins: [...(s.pins.get(c.id) || [])] }
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
    return {
      id: s.id, name: s.name, icon: s.icon, banner: s.banner, description: s.description,
      owner: s.owner, me: this.me, isAdmin: s.admins.has(this.me), createdAt: s.createdAt,
      categories, channels, members,
      banned: [...s.banned].map(k => ({ key: k, profile: s.profiles.get(k) || null })),
      peers: this._peerCount(serverId)
    }
  }

  messages (serverId, channelId, { before = null, limit = 100 } = {}) {
    const s = this.servers.get(serverId)?.state
    if (!s) return []
    let list = (s.messages.get(channelId) || []).filter(m => !m.deleted)
    if (before) { const i = list.findIndex(m => m.id === before); if (i >= 0) list = list.slice(0, i) }
    const slice = list.slice(-Math.min(500, limit))
    return slice.map(m => {
      let reply = null
      if (m.replyTo) {
        const r = s.msgIndex.get(m.replyTo)
        if (r && !r.deleted) reply = { id: r.id, author: r.author, text: r.text.slice(0, 140), hasImage: r.attachments.length > 0 }
      }
      return { ...m, reply }
    })
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
    const m = { t: 'sig', to, from: this.me, d: data ?? null, n: crypto.randomBytes(9).toString('hex'), at: Date.now(), ttl: 1 }
    m.sig = this._signObj([m.to, m.from, m.d, m.n, m.at])
    this._markSeen(m.n)
    const direct = this.peers.get(to)
    if (direct) return direct.send(m)
    // Doğrudan bağlantı yoksa ortak eşler üzerinden tek adım aktarım
    for (const p of this.peers.values()) p.send(m)
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
    if (key === this.me) { conn.destroy(); return }
    const peer = {
      key,
      conn,
      shared: new Set(),
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
  }

  // Sunucu kimlikleri eş çiftine özgü bir özetle gizlenir: karşı taraf,
  // kendisinin de üyesi olmadığı sunucuları öğrenemez.
  _tags (peer) {
    const pair = [this.me, peer.key].sort().join(':')
    return [...this.servers.keys()].map(id => ({ id, tag: sha256(id + ':' + pair).toString('hex') }))
  }

  _sendHello (peer, reply) {
    peer.send({ t: 'hello', v: 1, reply, tags: this._tags(peer).map(x => x.tag) })
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
      if (!before.has(s)) peer.send({ t: 'have', s, ids: [...this.servers.get(s).ops.keys()] })
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
        return this._sendOpsBatched(peer, m.s, missing)
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
      case 'eph': return this._onEph(peer, m)
      case 'sig': return this._onSig(peer, m)
    }
  }

  _sendOpsBatched (peer, serverId, ops) {
    let batch = []
    let size = 0
    for (const op of ops) {
      const len = JSON.stringify(op).length
      if (batch.length && size + len > BATCH_BYTES) { peer.send({ t: 'ops', s: serverId, ops: batch }); batch = []; size = 0 }
      batch.push(op)
      size += len
    }
    if (batch.length) peer.send({ t: 'ops', s: serverId, ops: batch })
  }

  _broadcastOps (serverId, ops, exceptKey) {
    for (const p of this.peers.values()) {
      if (p.key !== exceptKey && p.shared.has(serverId)) this._sendOpsBatched(p, serverId, ops)
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
    this.emit('eph', { server: m.s, from: m.from, kind: m.k, data: m.d })
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
      this.emit('signal', { from: m.from, data: m.d })
    } else if (m.ttl > 0) {
      const target = this.peers.get(m.to)
      if (!target) return
      const shares = [...peer.shared].some(s => target.shared.has(s))
      if (shares) target.send({ ...m, ttl: m.ttl - 1 })
    }
  }

  _tick () {
    for (const id of this.servers.keys()) this.sendEph(id, 'presence', {})
    const now = Date.now()
    for (const [n, t] of this.seen) if (now - t > 180000) this.seen.delete(n)
    for (const [s, pres] of this.presence) {
      let dropped = false
      for (const [k, t] of pres) if (now - t > ONLINE_TTL) { pres.delete(k); dropped = true }
      if (dropped) this.emit('peers', [s])
    }
  }
}

module.exports = { P2PNode, topicFor, opId }
