'use strict'
// Hyperswarm yerine bellek içi sahte bir ağ ile P2P çekirdeğinin testi.
// Çalıştırma: node test/p2p.test.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { P2PNode } = require('../src/p2p/node')

class FakeConn extends EventEmitter {
  constructor (remoteKey) { super(); this.remotePublicKey = remoteKey; this.destroyed = false; this.other = null }
  write (buf) {
    if (this.destroyed) return
    const data = Buffer.from(buf)
    // Parçalı teslimat: framing kodunu da sınar
    const cut = Math.max(1, Math.floor(data.length / 3))
    setImmediate(() => { if (!this.other.destroyed) { this.other.emit('data', data.subarray(0, cut)); this.other.emit('data', data.subarray(cut)) } })
  }
  destroy () { if (this.destroyed) return; this.destroyed = true; this.emit('close'); this.other.destroy() }
}

class FakeNet {
  constructor () { this.swarms = []; this.links = new Set(); this.blocked = new Set() }
  factory () {
    const net = this
    return (keyPair) => {
      const sw = new EventEmitter()
      sw.keyPair = keyPair
      sw.topics = new Set()
      sw.join = (topic) => { sw.topics.add(topic.toString('hex')); net.connectAll() }
      sw.leave = (topic) => { sw.topics.delete(topic.toString('hex')) }
      sw.destroy = async () => {}
      net.swarms.push(sw)
      return sw
    }
  }
  connectAll () {
    for (const a of this.swarms) for (const b of this.swarms) {
      if (a === b) continue
      const k = [a.keyPair.publicKey.toString('hex'), b.keyPair.publicKey.toString('hex')].sort().join()
      if (this.links.has(k) || this.blocked.has(k)) continue
      if (![...a.topics].some(t => b.topics.has(t))) continue
      this.links.add(k)
      const ca = new FakeConn(b.keyPair.publicKey)
      const cb = new FakeConn(a.keyPair.publicKey)
      ca.other = cb; cb.other = ca
      a.emit('connection', ca)
      b.emit('connection', cb)
    }
  }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))
async function until (fn, msg, timeout = 3000) {
  const t = Date.now()
  while (!fn()) { if (Date.now() - t > timeout) throw new Error('Zaman aşımı: ' + msg); await wait(20) }
}

async function main () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanki-test-'))
  const net = new FakeNet()
  const mk = async (name) => {
    const n = new P2PNode(path.join(root, name), { swarmFactory: net.factory() })
    await n.start()
    n.setProfile({ name, bio: name + ' biyografisi', color: '#33aa66' })
    return n
  }
  const A = await mk('ayse')
  const B = await mk('burak')
  const C = await mk('can')

  // A ile C doğrudan bağlanamıyor (NAT simülasyonu): veriler B üzerinden yayılmalı
  net.blocked.add([A.me, C.me].sort().join())

  const sid = A.createServer('VAULT', null)
  B.joinServer(sid)
  C.joinServer(sid)

  await until(() => B.meta(sid) && !B.meta(sid).pending && C.meta(sid) && !C.meta(sid).pending, 'genesis eşitleme')
  const meta = C.meta(sid)
  assert.strictEqual(meta.name, 'VAULT')
  assert.strictEqual(meta.channels.length, 4)
  const genel = meta.channels.find(c => c.name === 'genel').id

  A.post(sid, 'message', { channel: genel, text: 'Merhaba **dünya** https://youtu.be/dQw4w9WgXcQ' })
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  C.post(sid, 'message', { channel: genel, text: '', attachments: [{ type: 'image', data: pixel, name: 'p.png', w: 1, h: 1 }] })
  await until(() => A.messages(sid, genel).length === 2 && C.messages(sid, genel).length === 2, 'mesajlar her yöne (aktarım dahil)')

  // Üyeler ve profiller
  await until(() => A.meta(sid).members.length === 3 && A.meta(sid).members.every(m => m.profile), 'üye profilleri')
  assert.ok(A.meta(sid).members.find(m => m.key === C.me).profile.name === 'can')

  // Yetkisiz kanal oluşturma reddedilmeli
  B.post(sid, 'channel-create', { name: 'hack', kind: 'text' })
  await wait(200)
  assert.ok(!A.meta(sid).channels.some(c => c.name === 'hack'), 'yetkisiz kanal görünmemeli')

  // Yönetici yapınca izin verilmeli
  A.post(sid, 'role-set', { user: B.me, role: 'admin' })
  await wait(100)
  B.post(sid, 'channel-create', { name: 'duyurular', kind: 'text', category: null })
  await until(() => C.meta(sid).channels.some(c => c.name === 'duyurular'), 'yönetici kanalı')

  // Düzenleme, tepki, silme
  const mid = A.messages(sid, genel)[0].id
  A.post(sid, 'message-edit', { target: mid, text: 'Düzenlendi' })
  C.post(sid, 'reaction', { target: mid, emoji: '👍', on: true })
  C.post(sid, 'message-edit', { target: mid, text: 'başkasının mesajı' }) // reddedilmeli
  await until(() => {
    const m = B.messages(sid, genel).find(x => x.id === mid)
    return m && m.text === 'Düzenlendi' && m.reactions['👍']?.length === 1
  }, 'düzenleme + tepki')

  // Sahte imzalı op reddedilmeli
  const store = A.servers.get(sid)
  const forged = { ...[...store.ops.values()].find(o => o.type === 'message'), data: { channel: genel, text: 'sahte' } }
  assert.strictEqual(A._validate(forged, sid), null, 'sahte op')

  // Geçici mesaj (ses durumu) — C'den A'ya B üzerinden iletilmeli
  let gotEph = null
  A.on('eph', e => { if (e.kind === 'voice') gotEph = e })
  C.sendEph(sid, 'voice', { channel: 'x', muted: false })
  await until(() => gotEph && gotEph.from === C.me, 'aktarılmış eph')

  // WebRTC sinyali — doğrudan bağlantı yokken B üzerinden
  let gotSig = null
  C.on('signal', s => { gotSig = s })
  A.sendSignal(C.me, { desc: { type: 'offer', sdp: 'v=0' } })
  await until(() => gotSig && gotSig.from === A.me, 'aktarılmış sinyal')

  // Yasaklama
  A.post(sid, 'ban', { user: C.me })
  await until(() => B.meta(sid).members.length === 2 && B.meta(sid).banned.length === 1, 'ban')
  C.post(sid, 'message', { channel: genel, text: 'yasaklıyım' })
  await wait(200)
  assert.ok(!A.messages(sid, genel).some(m => m.text === 'yasaklıyım'))

  // Yeniden başlatma: disk kalıcılığı
  await A.destroy()
  const A2 = new P2PNode(path.join(root, 'ayse'), { swarmFactory: net.factory() })
  await A2.start()
  assert.strictEqual(A2.me, A.me)
  assert.strictEqual(A2.messages(sid, genel).length, 2)
  assert.strictEqual(A2.meta(sid).name, 'VAULT')

  console.log('✓ Tüm P2P testleri geçti')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
