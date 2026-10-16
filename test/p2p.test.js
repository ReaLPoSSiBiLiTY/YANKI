'use strict'
// Hyperswarm yerine bellek içi sahte bir ağ ile P2P çekirdeğinin testi.
// Çalıştırma: node test/p2p.test.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { P2PNode } = require('../src/p2p/node')
const { musicState, rollDice } = require('../src/p2p/state')

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
      sw.wantKeys = new Set()
      sw.join = (topic) => { sw.topics.add(topic.toString('hex')); net.connectAll() }
      sw.joinPeer = (key) => { sw.wantKeys.add(key.toString('hex')); net.connectAll() }
      sw.leavePeer = (key) => { sw.wantKeys.delete(key.toString('hex')) }
      sw.listen = async () => {}
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
      const ka = a.keyPair.publicKey.toString('hex'); const kb = b.keyPair.publicKey.toString('hex')
      if (![...a.topics].some(t => b.topics.has(t)) && !a.wantKeys.has(kb) && !b.wantKeys.has(ka)) continue
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
  const mid = A.messages(sid, genel).find(m => m.author === A.me).id
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


  // ---------- v1.1: profil budama ----------
  B.setProfile({ name: 'burak', bio: 'v2' })
  B.setProfile({ name: 'burak', bio: 'v3' })
  await until(() => A.meta(sid).members.find(m => m.key === B.me)?.profile?.bio === 'v3', 'profil güncellemesi')
  const bStore = B.servers.get(sid)
  const myProfiles = [...bStore.ops.values()].filter(o => o.type === 'profile' && o.author === B.me)
  assert.strictEqual(myProfiles.length, 1, 'eski profil kayıtları budanmalı')
  assert.ok(bStore.pruned.size >= 2)
  const fileLines = fs.readFileSync(bStore.file, 'utf8').split('\n').filter(Boolean).length
  assert.ok(fileLines > bStore.ops.size, 'dosya henüz sıkıştırılmadı (yeniden başlatmada sıkışır)')

  // ---------- v1.1: botlar ----------
  A.post(sid, 'bot-config', { bot: 'poll', enabled: true, channels: [genel] })
  await wait(100)
  const diceId = B.post(sid, 'message', { channel: genel, text: '/zar 3d6+2' })
  const pollId = B.post(sid, 'message', { channel: genel, text: '/anket Akşam ne oynayalım? | Valheim | CS2 | ETS2' })
  await until(() => A.messages(sid, genel).some(m => m.id === pollId), 'bot mesajları')
  const dA = A.messages(sid, genel).find(m => m.id === diceId)
  const dB = B.messages(sid, genel).find(m => m.id === diceId)
  assert.ok(dA.bot && dA.bot.id === 'dice' && dA.bot.rolls.length === 3)
  assert.deepStrictEqual(dA.bot, dB.bot, 'zar sonucu her eşte aynı olmalı')
  assert.strictEqual(dA.bot.total, dA.bot.rolls.reduce((x, y) => x + y, 0) + 2)
  A.post(sid, 'poll-vote', { target: pollId, option: 1 })
  B.post(sid, 'poll-vote', { target: pollId, option: 1 })
  B.post(sid, 'poll-vote', { target: pollId, option: 2 }) // oyunu değiştirdi
  await until(() => { const p = A.messages(sid, genel).find(m => m.id === pollId).poll; return p.total === 2 && p.counts[2] === 1 }, 'anket oyları')
  assert.deepStrictEqual(A.messages(sid, genel).find(m => m.id === pollId).poll.counts, [0, 1, 1])
  assert.strictEqual(rollDice('x', '/zar abc').error.length > 0, true)

  // Müzik kuyruğu zaman çizelgesi
  const v = (id, d) => ({ id, title: id, duration: d })
  const evs = [
    { id: 'a', ts: 1000, author: 'u', action: 'add', video: v('aaaaaaaaaaa', 10) },
    { id: 'b', ts: 2000, author: 'u', action: 'add', video: v('bbbbbbbbbbb', 20) },
    { id: 'c', ts: 3000, author: 'u', action: 'add', video: v('ccccccccccc', 5) }
  ]
  assert.strictEqual(musicState(evs, 5000).playing.id, 'a')
  assert.strictEqual(musicState(evs, 12000).playing.id, 'b')
  assert.strictEqual(musicState(evs, 12000).playing.startedAt, 11000)
  assert.strictEqual(musicState(evs, 31500).playing.id, 'c')
  assert.strictEqual(musicState(evs, 40000).playing, null)
  assert.strictEqual(musicState([...evs, { id: 's', ts: 4000, action: 'skip', target: 'a' }], 4500).playing.startedAt, 4000)
  const sesKanal = A.meta(sid).channels.find(c => c.kind === 'voice' && c.name === 'Sesli Sohbet').id
  B.post(sid, 'music', { channel: sesKanal, action: 'add', video: { id: 'dQw4w9WgXcQ', title: 'Şarkı', duration: 200 } })
  await until(() => A.music(sid, sesKanal).playing?.video.title === 'Şarkı', 'müzik eşitleme')
  assert.strictEqual(A.meta(sid).channels.find(c => c.id === sesKanal).music.title, 'Şarkı')

  // ---------- v1.1: arkadaşlık ve özel mesaj ----------
  // D hiçbir ortak sunucusu olmayan yeni bir kullanıcı; A'yı açık anahtarıyla ekler
  const D = await mk('deniz')
  assert.throws(() => D.dmPost(A.me, 'dm', { text: 'selam' }), /arkadaş/)
  D.friendRequest(A.me)
  await until(() => A.friendStatus(D.me) === 'incoming', 'arkadaşlık isteği ulaştı')
  assert.strictEqual(D.friendStatus(A.me), 'outgoing')
  assert.strictEqual(A.dmList().find(x => x.key === D.me).profile.name, 'deniz')
  A.friendAccept(D.me)
  await until(() => D.friendStatus(A.me) === 'friends', 'arkadaşlık kabul edildi')
  D.dmPost(A.me, 'dm', { text: 'Selam! Bu özel bir mesaj' })
  A.dmPost(D.me, 'dm', { text: 'Aleyküm selam' })
  await until(() => A.dmMessages(D.me).length === 2 && D.dmMessages(A.me).length === 2, 'özel mesajlar')
  // Özel mesajlar üçüncü kişilere gitmez
  assert.ok(!B.dms.has(D.me) && !B.dms.has(A.me))
  // Etkinlik arkadaşa doğrudan iletilir
  let gotAct = null
  D.on('activity', e => { if (e.from === A.me && e.act) gotAct = e.act })
  A.setActivity({ type: 'game', name: 'Valheim', since: Date.now() })
  await until(() => gotAct && gotAct.name === 'Valheim', 'etkinlik')
  // Arkadaşlıktan çıkarma
  D.friendRemove(A.me)
  await until(() => A.friendStatus(D.me) === 'none', 'arkadaşlıktan çıkarma')
  assert.throws(() => D.dmPost(A.me, 'dm', { text: 'tekrar' }), /arkadaş/i)

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
  assert.strictEqual(A2.messages(sid, genel).length, 4)
  assert.strictEqual(A2.meta(sid).name, 'VAULT')
  assert.strictEqual(A2.dmMessages(D.me).length, 2, 'özel mesajlar diskte kalıcı')
  // Budanan profil kayıtları yeniden başlatmada dosyadan atılır
  await B.destroy()
  const B2 = new P2PNode(path.join(root, 'burak'), { swarmFactory: net.factory() })
  await B2.start()
  const lines2 = fs.readFileSync(B2.servers.get(sid).file, 'utf8').split('\n').filter(Boolean).length
  assert.strictEqual(lines2, B2.servers.get(sid).ops.size)
  assert.strictEqual(B2.meta(sid).members.find(m => m.key === B2.me).profile.bio, 'v3')

  console.log('✓ Tüm P2P testleri geçti')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
