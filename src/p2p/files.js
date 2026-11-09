'use strict'
/*
 * Dosya paylaşımı
 * - Gönderilen dosya, içeriğinin SHA-256 özetiyle (h) uygulamanın önbelleğine kopyalanır;
 *   mesajda yalnızca künyesi (h, ad, boyut, tür) bulunur.
 * - İndirmek isteyen, dosyayı paylaşan kişiden (ya da onu daha önce indirmiş bir üyeden)
 *   parça parça ister. Gelen dosyanın özeti doğrulanmadan kullanılmaz.
 * - Bir eş dosyayı yalnızca, dosyanın paylaşıldığı kanala (ya da özel sohbete) erişimi
 *   olan kişilere verir.
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const CHUNK = 256 * 1024
const WINDOW = 6
const REQ_TIMEOUT = 15000
const CACHE_CAP = 4 * 1024 * 1024 * 1024 // önbellek üst sınırı (en eski indirilenler silinir)

const HEX64 = /^[0-9a-f]{64}$/
const ctxKey = (c) => c.dm ? 'dm:' + c.dm : 's:' + c.server + ':' + c.channel

class FileStore extends EventEmitter {
  constructor (dir) {
    super()
    this.dir = dir
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true })
    this.indexFile = path.join(dir, 'index.json')
    this.index = {}
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) || {} } catch {}
    // Kaybolmuş dosyaları dizinden çıkar
    for (const h of Object.keys(this.index)) if (!HEX64.test(h) || !fs.existsSync(this.path(h))) delete this.index[h]
    this._saveSoon = null
  }

  path (h) { return path.join(this.dir, h) }
  has (h) { return !!this.index[h] && fs.existsSync(this.path(h)) }

  _save () {
    clearTimeout(this._saveSoon)
    this._saveSoon = setTimeout(() => { try { fs.writeFileSync(this.indexFile, JSON.stringify(this.index)) } catch {} }, 300)
  }

  addCtx (h, ctx) {
    const e = this.index[h]
    if (!e || !ctx) return
    const k = ctxKey(ctx)
    if (!e.ctx.some(c => ctxKey(c) === k)) { e.ctx.push(ctx); this._save() }
  }

  // Yerel bir dosyayı önbelleğe al (özeti hesaplanırken kopyalanır)
  async addFromPath (src, ctx, maxSize) {
    const st = await fsp.stat(src)
    if (!st.isFile()) throw new Error('Yalnızca dosya paylaşılabilir.')
    if (st.size > maxSize) throw new Error(`Dosya çok büyük (en fazla ${Math.round(maxSize / 1024 / 1024 / 1024)} GB).`)
    const tmp = path.join(this.dir, 'tmp', crypto.randomBytes(8).toString('hex'))
    const hash = crypto.createHash('sha256')
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src)
      const ws = fs.createWriteStream(tmp)
      rs.on('data', (b) => hash.update(b))
      rs.on('error', reject)
      ws.on('error', reject)
      ws.on('finish', resolve)
      rs.pipe(ws)
    })
    const h = hash.digest('hex')
    return this._commit(tmp, h, { name: path.basename(src), size: st.size, own: true }, ctx)
  }

  async _commit (tmp, h, meta, ctx) {
    if (this.has(h)) { await fsp.rm(tmp, { force: true }) } else await fsp.rename(tmp, this.path(h))
    const prev = this.index[h]
    this.index[h] = { name: meta.name, size: meta.size, at: Date.now(), own: !!(meta.own || prev?.own), ctx: prev?.ctx || [] }
    this.addCtx(h, ctx)
    this._save()
    this._evict()
    return { h, name: meta.name, size: meta.size }
  }

  _evict () {
    let total = Object.values(this.index).reduce((n, e) => n + (e.size || 0), 0)
    if (total <= CACHE_CAP) return
    const list = Object.entries(this.index).filter(([, e]) => !e.own).sort((a, b) => a[1].at - b[1].at)
    for (const [h, e] of list) {
      if (total <= CACHE_CAP) break
      try { fs.rmSync(this.path(h), { force: true }) } catch {}
      delete this.index[h]
      total -= e.size || 0
    }
    this._save()
  }
}

// İndirme işi: tek bir kaynaktan sırayla parça ister, kaynak yanıt vermezse sıradakine geçer
class Download {
  constructor (node, store, file, ctx, sources, dest) {
    this.node = node
    this.store = store
    this.file = file
    this.ctx = ctx
    this.sources = sources
    this.dest = dest
    this.id = crypto.randomBytes(8).toString('hex')
    this.got = 0
    this.next = 0
    this.inflight = new Map() // offset -> zaman
    this.done = false
    this.src = null
    this.tmp = path.join(store.dir, 'tmp', this.id)
    this.fd = fs.openSync(this.tmp, 'w')
    this.tried = new Set()
    this.timer = setInterval(() => this._check(), 2000)
  }

  _progress (extra = {}) { this.node.emit('file-progress', { job: this.id, h: this.file.h, got: this.got, total: this.file.size, ...extra }) }

  _pickSource () {
    for (const k of this.sources) {
      if (this.tried.has(k)) continue
      const p = this.node.peers.get(k)
      if (p) { this.tried.add(k); return p }
    }
    return null
  }

  start () {
    if (this.file.size === 0) return this._finish()
    this._pump()
  }

  _pump () {
    if (this.done) return
    if (!this.src) {
      this.src = this._pickSource()
      if (!this.src) { this._waitSince = this._waitSince || Date.now(); return }
      this._waitSince = 0
      this.next = this.got
      this.inflight.clear()
      this._progress({ source: this.src.key })
    }
    while (this.inflight.size < WINDOW && this.next < this.file.size) {
      const o = this.next
      const n = Math.min(CHUNK, this.file.size - o)
      this.inflight.set(o, Date.now())
      this.src.send({ t: 'fq', id: this.id, h: this.file.h, o, n })
      this.next += n
    }
  }

  onData (peer, m) {
    if (this.done || peer !== this.src || !this.inflight.has(m.o)) return
    const buf = Buffer.from(String(m.d || ''), 'base64')
    const want = Math.min(CHUNK, this.file.size - m.o)
    if (buf.length !== want) return this._fail(peer)
    fs.writeSync(this.fd, buf, 0, buf.length, m.o)
    this.inflight.delete(m.o)
    this.got += buf.length
    if (Date.now() - (this._lastEmit || 0) > 250) { this._lastEmit = Date.now(); this._progress() }
    if (this.got >= this.file.size) this._finish()
    else this._pump()
  }

  onError (peer) { if (peer === this.src) this._fail(peer) }

  _fail () {
    // Bu kaynaktan vazgeç, başkasını dene. Parçalar sırayla istendiği için en küçük eksik
    // parçaya kadar her şey alınmıştır; oradan devam edilir.
    const resume = this.inflight.size ? Math.min(...this.inflight.keys()) : this.next
    this.src = null
    this.inflight.clear()
    this.got = resume
    this.next = resume
    this._pump()
  }

  _check () {
    if (this.done) return
    const now = Date.now()
    if (this.src && [...this.inflight.values()].some(t => now - t > REQ_TIMEOUT)) return this._fail(this.src)
    if (!this.src) {
      this._pump()
      if (!this.src && this._waitSince && now - this._waitSince > 45000) {
        this._abort('Dosyayı paylaşan kişiye (ya da dosyaya sahip başka bir üyeye) şu an ulaşılamıyor. O çevrim içiyken tekrar dene.')
      } else if (!this.src && this.tried.size >= this.sources.length) {
        this.tried.clear() // biri yeniden bağlanırsa tekrar denenebilsin
      }
    }
  }

  async _finish () {
    if (this.done) return
    this.done = true
    clearInterval(this.timer)
    try {
      fs.closeSync(this.fd)
      const hash = crypto.createHash('sha256')
      await new Promise((resolve, reject) => fs.createReadStream(this.tmp).on('data', b => hash.update(b)).on('end', resolve).on('error', reject))
      if (hash.digest('hex') !== this.file.h) throw new Error('Dosya doğrulanamadı (içerik bozuk ya da değiştirilmiş).')
      await this.store._commit(this.tmp, this.file.h, { name: this.file.name, size: this.file.size }, this.ctx)
      await fsp.copyFile(this.store.path(this.file.h), this.dest)
      this._progress({ done: true, path: this.dest })
    } catch (e) {
      try { fs.rmSync(this.tmp, { force: true }) } catch {}
      this._progress({ error: e.message || String(e) })
    }
    this.node.downloads.delete(this.id)
  }

  _abort (msg) {
    if (this.done) return
    this.done = true
    clearInterval(this.timer)
    try { fs.closeSync(this.fd) } catch {}
    try { fs.rmSync(this.tmp, { force: true }) } catch {}
    this.node.downloads.delete(this.id)
    this._progress({ error: msg })
  }

  cancel () { this._abort('İndirme iptal edildi.') }
}

module.exports = { FileStore, Download, CHUNK, ctxKey }
