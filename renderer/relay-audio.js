'use strict'
/*
 * Aktarmalı ses (yedek ses yolu)
 * Bazı ağlarda (operatör NAT'ı, mobil paylaşım, kurumsal ağlar) iki kişi arasında doğrudan
 * WebRTC bağlantısı kurulamaz; eskiden bu kişiler birbirini hiç duyamıyordu. Bu durumda ses,
 * Opus ile sıkıştırılıp (~32 kbps) YANKI'nın kendi P2P bağlantısı üzerinden gönderilir.
 * İki kişi arasında o bağlantı da yoksa, ikisine de bağlı ortak bir üye paketleri iletir
 * (paketler imzalıdır; aracı yalnızca iletir).
 */
const RELAY_RATE = 48000
const JITTER_MIN = 3 * 960 // oynatmaya başlamadan önce ~60 ms biriktir
const JITTER_MAX = 18 * 960 // ~360 ms'den fazla birikirse eskiyi at (gecikme büyümesin)

const b64enc = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s) }
const b64dec = (s) => { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8 }

class AudioRelay {
  constructor (voice) {
    this.v = voice
    this.targets = new Set()
    this.rx = new Map()
    this.tx = null
    this.seq = 0
    this.playCtx = null
    setInterval(() => this._sweep(), 1000)
  }

  static supported () { return typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined' && typeof AudioData !== 'undefined' }

  // ---------- Gönderme ----------

  setTargets (keys) {
    this.targets = new Set(keys)
    if (this.targets.size && this.v.mic) this._startTx(); else this._stopTx()
  }

  restart () { this._stopTx(); if (this.targets.size && this.v.mic) this._startTx() }

  _startTx () {
    if (this.tx || !AudioRelay.supported()) return
    const track = this.v.mic?.getAudioTracks()[0]
    if (!track) return
    try {
      const ctx = new AudioContext({ sampleRate: RELAY_RATE })
      const src = ctx.createMediaStreamSource(new MediaStream([track]))
      const proc = ctx.createScriptProcessor(1024, 1, 1)
      const enc = new AudioEncoder({ output: (chunk) => this._send(chunk), error: (e) => { console.warn('relay enc', e); this._stopTx() } })
      enc.configure({ codec: 'opus', sampleRate: RELAY_RATE, numberOfChannels: 1, bitrate: 32000 })
      let ts = 0
      proc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0)
        const dur = data.length / RELAY_RATE * 1e6
        if (this.v.micOff || !this.targets.size || enc.state !== 'configured') { ts += dur; return }
        const ad = new AudioData({ format: 'f32-planar', sampleRate: RELAY_RATE, numberOfFrames: data.length, numberOfChannels: 1, timestamp: ts, data: new Float32Array(data) })
        ts += dur
        try { enc.encode(ad) } catch {}
        ad.close()
      }
      src.connect(proc)
      proc.connect(ctx.destination) // çıkış sessizdir; işlemcinin çalışması için bağlı olmalı
      this.tx = { ctx, src, proc, enc }
    } catch (e) { console.warn('relay tx', e) }
  }

  _stopTx () {
    if (!this.tx) return
    const { ctx, src, proc, enc } = this.tx
    this.tx = null
    try { proc.onaudioprocess = null; src.disconnect(); proc.disconnect() } catch {}
    try { if (enc.state !== 'closed') enc.close() } catch {}
    ctx.close().catch(() => {})
  }

  _send (chunk) {
    if (!this.targets.size) return
    const buf = new Uint8Array(chunk.byteLength)
    chunk.copyTo(buf)
    this.v.api.sendAudio([...this.targets], { q: this.seq++, d: b64enc(buf), r: RELAY_RATE, c: 1 })
  }

  // ---------- Alma ----------

  onPacket (from, pkt) {
    if (!AudioRelay.supported() || !this.v.channel || !pkt || typeof pkt.d !== 'string') return
    const p = this.v.peers.get(from)
    // Yalnızca aynı odadaki ve doğrudan bağlantısı kurulamamış kişilerden
    if (!p || p.pc.connectionState === 'connected') return
    let r = this.rx.get(from)
    if (!r) r = this._newRx(from)
    if (!r) return
    if (pkt.q <= r.lastQ && r.lastQ - pkt.q < 5000) return // yinelenen/eski paket
    r.lastQ = pkt.q
    r.at = Date.now()
    try { r.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: pkt.q * 20000, data: b64dec(pkt.d) })) } catch {}
  }

  _newRx (from) {
    try {
      if (!this.playCtx) this.playCtx = new AudioContext({ sampleRate: RELAY_RATE })
      const ctx = this.playCtx
      if (ctx.state === 'suspended') ctx.resume()
      const dest = ctx.createMediaStreamDestination()
      const node = ctx.createScriptProcessor(1024, 1, 1)
      const r = { q: [], qlen: 0, started: false, lastQ: -1, at: Date.now(), node, dest, dec: null, stream: dest.stream }
      node.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0)
        if (!r.started) { if (r.qlen < JITTER_MIN) { out.fill(0); return } r.started = true }
        while (r.qlen > JITTER_MAX && r.q.length > 1) { r.qlen -= r.q[0].length; r.q.shift() }
        let i = 0
        while (i < out.length && r.q.length) {
          const head = r.q[0]
          const n = Math.min(head.length, out.length - i)
          out.set(head.subarray(0, n), i)
          i += n
          r.qlen -= n
          if (n === head.length) r.q.shift(); else r.q[0] = head.subarray(n)
        }
        if (i < out.length) { out.fill(0, i); r.started = false } // boşaldı: yeniden biriktir
      }
      node.connect(dest)
      r.dec = new AudioDecoder({
        output: (ad) => {
          try {
            const f = new Float32Array(ad.numberOfFrames)
            ad.copyTo(f, { planeIndex: 0, format: 'f32-planar' })
            r.q.push(f)
            r.qlen += f.length
          } catch {}
          ad.close()
        },
        error: (e) => console.warn('relay dec', e)
      })
      r.dec.configure({ codec: 'opus', sampleRate: RELAY_RATE, numberOfChannels: 1 })
      this.rx.set(from, r)
      this.v._playAudio(from, r.stream)
      this.v.onUpdate()
      return r
    } catch (e) { console.warn('relay rx', e); return null }
  }

  _closeRx (from) {
    const r = this.rx.get(from)
    if (!r) return
    this.rx.delete(from)
    try { r.node.onaudioprocess = null; r.node.disconnect() } catch {}
    try { if (r.dec.state !== 'closed') r.dec.close() } catch {}
    this.v._stopAudio(from, r.stream.id)
    this.v.onUpdate()
  }

  receiving (key) { return this.rx.has(key) }

  _sweep () {
    const now = Date.now()
    for (const [k, r] of this.rx) if (now - r.at > 3000 || !this.v.peers.has(k)) this._closeRx(k)
  }

  stopAll () {
    this.setTargets([])
    for (const k of [...this.rx.keys()]) this._closeRx(k)
  }
}

window.AudioRelay = AudioRelay
