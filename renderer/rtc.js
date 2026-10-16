'use strict'
/*
 * Sesli/görüntülü sohbet — WebRTC "mesh" (her katılımcı diğerlerine doğrudan bağlanır).
 * Sinyalleşme P2P ağı üzerinden yapılır; merkezi sinyal sunucusu yoktur.
 *
 * Bağlantı güvenilirliği:
 * - Her katılış yeni bir oturum kimliği (sess) alır; biri çıkıp geri girerse eski
 *   bağlantı kesin olarak kapatılıp yenisi kurulur (eski "Bağlanıyor…" takılmasının nedeni).
 * - Sinyaller hedef oturuma ve bağlantı kuşağına (gen) etiketlenir; bayat sinyaller yok sayılır.
 * - Uzak açıklama gelmeden ulaşan ICE adayları tamponlanır (önceden kayboluyordu).
 * - Bekçi zamanlayıcı: 10 sn'de bağlanmazsa ICE yeniden başlatılır, 22 sn'de bağlantı
 *   iki tarafta da sıfırdan kurulur; kopmalarda otomatik onarım.
 * - Aynı odadaki herkesle doğrudan P2P bağlantısı istenir (sinyaller aracıya muhtaç kalmaz).
 */

const SCREEN_QUALITY = {
  '1080p60': { w: 1920, h: 1080, fps: 60, bitrate: 9_000_000, label: '1080p · 60 FPS' },
  '1080p30': { w: 1920, h: 1080, fps: 30, bitrate: 6_000_000, label: '1080p · 30 FPS' },
  '720p30': { w: 1280, h: 720, fps: 30, bitrate: 3_000_000, label: '720p · 30 FPS' }
}

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

class Voice {
  constructor ({ api, me, settings, onUpdate, onSpeaking, toast }) {
    this.api = api
    this.me = me
    this.settings = settings
    this.onUpdate = onUpdate
    this.onSpeaking = onSpeaking
    this.toast = toast
    this.server = null
    this.channel = null
    this.session = null
    this.mic = null
    this.cam = null
    this.screen = null
    this.screenQuality = SCREEN_QUALITY['1080p30']
    this.muted = false
    this.deaf = false
    this.peers = new Map()
    this.states = new Map() // kullanıcı -> { server, channel, sess, muted, deaf, mic, cam, screen, at }
    this.audioEls = new Map()
    this.analysers = new Map()
    this.speaking = new Set()
    this.volumes = {}
    try { this.volumes = JSON.parse(localStorage.getItem('yanki.volumes') || '{}') } catch {}
    this.ctx = null
    this.sink = document.createElement('div')
    this.sink.hidden = true
    document.body.appendChild(this.sink)
    this._lastBroadcast = 0
    setInterval(() => this._tick(), 1000)
    setInterval(() => this._levels(), 100)
    window.addEventListener('beforeunload', () => this.leave(true))
  }

  get active () { return !!this.channel }

  iceServers () {
    const list = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
    const s = this.settings()
    if (s.turnUrl) list.push({ urls: s.turnUrl, username: s.turnUser || undefined, credential: s.turnPass || undefined })
    return list
  }

  _audioConstraints () {
    const s = this.settings()
    return {
      deviceId: s.inputDevice && s.inputDevice !== 'default' ? { exact: s.inputDevice } : undefined,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGain,
      channelCount: 1,
      sampleRate: 48000
    }
  }

  // ---------- Katılma / ayrılma ----------

  async join (server, channel) {
    if (this.server === server && this.channel === channel) return
    if (this.channel) this.leave(true)
    await this.api.mediaAccess('microphone')
    this.server = server
    this.channel = channel
    this.session = rid()
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: this._audioConstraints() })
    } catch (e) {
      this.mic = null
      this.toast('Mikrofona erişilemedi — yalnızca dinleme modundasın.')
    }
    if (!this.channel) { this.mic?.getTracks().forEach(t => t.stop()); this.mic = null; return }
    this._applyMute()
    if (this.mic) this._watch(this.me, this.mic)
    this._broadcast()
    for (const [k, st] of this.states) if (this._inRoom(st)) this._ensurePeer(k, st.sess)
    this._sound('join')
    this.onUpdate()
  }

  leave (silent = false) {
    if (!this.channel) return
    const server = this.server
    this.channel = null
    this.api.eph(server, 'voice', { channel: null })
    for (const k of [...this.peers.keys()]) this._closePeer(k)
    for (const s of [this.mic, this.cam, this.screen]) s?.getTracks().forEach(t => t.stop())
    this.mic = this.cam = this.screen = null
    this._unwatch(this.me)
    this.server = null
    this.session = null
    if (!silent) this._sound('leave')
    this.onUpdate()
  }

  _inRoom (st) { return !!(this.channel && st && st.server === this.server && st.channel === this.channel) }

  _state () {
    return {
      channel: this.channel,
      sess: this.session,
      muted: this.muted || this.deaf || !this.mic,
      deaf: this.deaf,
      mic: this.mic?.id || null,
      cam: this.cam?.id || null,
      screen: this.screen?.id || null,
      screenLabel: this.screen ? this.screenQuality.label : null
    }
  }

  _broadcast () {
    if (!this.server) return
    this.api.eph(this.server, 'voice', this._state())
    this._lastBroadcast = Date.now()
  }

  _tick () {
    if (this.channel && Date.now() - this._lastBroadcast > 4000) this._broadcast()
    let changed = false
    for (const [k, st] of this.states) {
      if (Date.now() - st.at > 13000) {
        this.states.delete(k)
        if (this.peers.has(k)) this._closePeer(k)
        changed = true
      }
    }
    if (changed) this.onUpdate()
  }

  // P2P ağından gelen ses durumu
  onState (server, from, data) {
    if (from === this.me || !data) return
    const prev = this.states.get(from)
    if (!data.channel) this.states.delete(from)
    else this.states.set(from, { ...data, server, at: Date.now() })
    const st = this.states.get(from)
    if (this._inRoom(st)) {
      const p = this.peers.get(from)
      // Karşı taraf çıkıp yeniden girdiyse eski bağlantıyı tamamen at
      if (p && st.sess && p.remoteSess && p.remoteSess !== st.sess) this._closePeer(from)
      const isNew = !this.peers.has(from)
      this._ensurePeer(from, st.sess)
      if (isNew && (!prev || prev.channel !== st.channel || prev.sess !== st.sess)) this._sound('join')
    } else if (this.peers.has(from)) {
      this._closePeer(from)
      this._sound('leave')
    }
    const significant = !prev || !st || prev.channel !== st.channel || prev.muted !== st.muted || prev.deaf !== st.deaf || prev.cam !== st.cam || prev.screen !== st.screen
    if (significant) this.onUpdate()
  }

  // ---------- Eş bağlantıları ----------

  _ensurePeer (key, remoteSess, gen = 0) {
    let p = this.peers.get(key)
    if (p) {
      if (!p.remoteSess && remoteSess) p.remoteSess = remoteSess
      return p
    }
    p = {
      key, remoteSess: remoteSess || null, gen,
      polite: this.me > key, makingOffer: false, ignoreOffer: false,
      streams: new Map(), queue: Promise.resolve(), pendingCands: [],
      since: Date.now(), attempts: 0, badSince: 0
    }
    this.peers.set(key, p)
    this._buildPc(p)
    p.watch = setInterval(() => this._checkPeer(p), 3000)
    this.api.wantPeer(key, 'voice', true)
    return p
  }

  _buildPc (p) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers(), bundlePolicy: 'max-bundle' })
    p.pc = pc
    p.makingOffer = false
    p.ignoreOffer = false
    p.pendingCands = []
    const key = p.key

    pc.onnegotiationneeded = async () => {
      if (p.pc !== pc) return
      try {
        p.makingOffer = true
        await pc.setLocalDescription()
        this._sig(p, { desc: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } })
      } catch (e) {
        console.warn('negotiation', e)
      } finally {
        p.makingOffer = false
      }
    }
    pc.onicecandidate = ({ candidate }) => { if (candidate && p.pc === pc) this._sig(p, { cand: candidate.toJSON() }) }
    pc.ontrack = ({ track, streams }) => {
      if (p.pc !== pc) return
      const stream = streams[0] || new MediaStream([track])
      p.streams.set(stream.id, stream)
      if (track.kind === 'audio') this._playAudio(key, stream)
      track.onunmute = () => this.onUpdate()
      track.onended = () => this.onUpdate()
      stream.onremovetrack = () => {
        if (!stream.getTracks().length) { p.streams.delete(stream.id); this._stopAudio(key, stream.id) }
        this.onUpdate()
      }
      this.onUpdate()
    }
    pc.onconnectionstatechange = () => {
      if (p.pc !== pc) return
      if (pc.connectionState === 'connected') { p.attempts = 0; p.badSince = 0; this._retuneScreen(p) }
      if (pc.connectionState === 'failed') { try { pc.restartIce() } catch {} }
      this.onUpdate()
    }

    let hasAudio = false
    for (const [stream, kind] of this._localStreams()) {
      for (const t of stream.getTracks()) {
        const sender = pc.addTrack(t, stream)
        if (t.kind === 'audio' && kind === 'mic') hasAudio = true
        if (kind === 'screen' && t.kind === 'video') this._tuneScreenSender(sender)
      }
    }
    // Mikrofonu olmayan dinleyici de müzakereyi başlatabilsin
    if (!hasAudio) pc.addTransceiver('audio', { direction: 'recvonly' })
  }

  // Takılan bağlantıları onar
  _checkPeer (p) {
    if (this.peers.get(p.key) !== p) return
    const st = p.pc.connectionState
    const now = Date.now()
    if (st === 'connected') { p.badSince = 0; return }
    if (!p.badSince) p.badSince = now
    const age = now - p.badSince
    if (st === 'disconnected' && age > 5000 && p.attempts === 0) {
      p.attempts = 1
      try { p.pc.restartIce() } catch {}
    } else if (age > 10000 && p.attempts === 0) {
      p.attempts = 1
      try { p.pc.restartIce() } catch {}
    } else if (age > 22000 && p.attempts >= 1) {
      // İki tarafta da sıfırdan kur
      p.attempts++
      this._rebuild(p, p.gen + 1, true)
    }
  }

  _rebuild (p, gen, notify) {
    try { p.pc.close() } catch {}
    for (const id of p.streams.keys()) this._stopAudio(p.key, id)
    p.streams.clear()
    p.gen = gen
    p.badSince = Date.now()
    p.queue = Promise.resolve()
    this._buildPc(p)
    if (notify) this._sig(p, { reset: true })
    this.onUpdate()
  }

  _closePeer (key) {
    const p = this.peers.get(key)
    if (!p) return
    clearInterval(p.watch)
    try { p.pc.close() } catch {}
    for (const id of p.streams.keys()) this._stopAudio(key, id)
    this._unwatch(key)
    this.peers.delete(key)
    this.api.wantPeer(key, 'voice', false)
  }

  _localStreams () {
    return [[this.mic, 'mic'], [this.cam, 'cam'], [this.screen, 'screen']].filter(x => x[0])
  }

  _sig (p, data) {
    this.api.signal(p.key, { ...data, s: this.server, c: this.channel, fs: this.session, ts: p.remoteSess, g: p.gen })
  }

  onSignal (from, d) {
    if (!this.channel || !d || d.s !== this.server || d.c !== this.channel) return
    if (d.ts && d.ts !== this.session) return // eski oturumumuza ait
    let p = this.peers.get(from)
    if (p && d.fs && p.remoteSess && d.fs !== p.remoteSess) { this._closePeer(from); p = null }
    const g = Number.isInteger(d.g) ? d.g : 0
    if (!p) p = this._ensurePeer(from, d.fs, g)
    else if (g > p.gen) this._rebuild(p, g, false)
    else if (g < p.gen) return // bayat kuşak
    if (!p.remoteSess && d.fs) p.remoteSess = d.fs
    if (d.reset) return
    const pc = p.pc
    p.queue = p.queue.then(() => this._handleSignal(p, pc, d)).catch(e => console.warn('signal', e))
  }

  async _handleSignal (p, pc, d) {
    if (p.pc !== pc) return
    if (d.desc) {
      const collision = d.desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable')
      p.ignoreOffer = !p.polite && collision
      if (p.ignoreOffer) return
      await pc.setRemoteDescription(d.desc)
      const cands = p.pendingCands.splice(0)
      for (const c of cands) { try { await pc.addIceCandidate(c) } catch {} }
      if (d.desc.type === 'offer') {
        await pc.setLocalDescription()
        this._sig(p, { desc: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } })
      }
    } else if (d.cand) {
      if (!pc.remoteDescription) { p.pendingCands.push(d.cand); return }
      try { await pc.addIceCandidate(d.cand) } catch (e) { if (!p.ignoreOffer) console.warn('ice', e) }
    }
  }

  _addStreamToPeers (stream, kind) {
    for (const p of this.peers.values()) {
      for (const t of stream.getTracks()) {
        const sender = p.pc.addTrack(t, stream)
        if (kind === 'screen' && t.kind === 'video') this._tuneScreenSender(sender)
      }
    }
  }

  _removeStreamFromPeers (stream) {
    const tracks = new Set(stream.getTracks())
    for (const p of this.peers.values()) {
      for (const sender of p.pc.getSenders()) {
        if (sender.track && tracks.has(sender.track)) { try { p.pc.removeTrack(sender) } catch {} }
      }
    }
  }

  // ---------- Mikrofon / kulaklık ----------

  _applyMute () {
    const off = this.muted || this.deaf
    this.mic?.getAudioTracks().forEach(t => { t.enabled = !off })
  }

  toggleMute () {
    if (this.deaf) { this.deaf = false; this._applyDeaf(); this.muted = false } else this.muted = !this.muted
    this._applyMute()
    this._sound(this.muted ? 'mute' : 'unmute')
    this._broadcast()
    this.onUpdate()
  }

  toggleDeafen () {
    this.deaf = !this.deaf
    this._applyDeaf()
    this._applyMute()
    this._sound(this.deaf ? 'mute' : 'unmute')
    this._broadcast()
    this.onUpdate()
  }

  _applyDeaf () {
    for (const el of this.audioEls.values()) el.muted = this.deaf
  }

  async setInputDevice () {
    if (!this.mic) return
    const fresh = await navigator.mediaDevices.getUserMedia({ audio: this._audioConstraints() })
    const nt = fresh.getAudioTracks()[0]
    const old = this.mic.getAudioTracks()[0]
    for (const p of this.peers.values()) {
      for (const s of p.pc.getSenders()) if (s.track === old) await s.replaceTrack(nt)
    }
    this.mic.removeTrack(old)
    old.stop()
    this.mic.addTrack(nt)
    this._applyMute()
    this._unwatch(this.me)
    this._watch(this.me, this.mic)
  }

  setOutputDevice () {
    const id = this.settings().outputDevice
    for (const el of this.audioEls.values()) if (el.setSinkId) el.setSinkId(id && id !== 'default' ? id : '').catch(() => {})
  }

  setUserVolume (key, v) {
    this.volumes[key] = v
    try { localStorage.setItem('yanki.volumes', JSON.stringify(this.volumes)) } catch {}
    for (const [k, el] of this.audioEls) if (k.startsWith(key + ':')) el.volume = Math.max(0, Math.min(1, v))
  }

  _playAudio (key, stream) {
    const id = key + ':' + stream.id
    if (this.audioEls.has(id)) return
    const el = new Audio()
    el.autoplay = true
    el.srcObject = stream
    el.muted = this.deaf
    el.volume = this.volumes[key] ?? 1
    const out = this.settings().outputDevice
    if (out && out !== 'default' && el.setSinkId) el.setSinkId(out).catch(() => {})
    this.sink.appendChild(el)
    el.play().catch(() => {})
    this.audioEls.set(id, el)
    const st = this.states.get(key)
    if (!st || !st.screen || st.screen !== stream.id) this._watch(key, stream)
  }

  _stopAudio (key, streamId) {
    const id = key + ':' + streamId
    const el = this.audioEls.get(id)
    if (el) { el.srcObject = null; el.remove(); this.audioEls.delete(id) }
  }

  // ---------- Konuşma algılama ----------

  _watch (key, stream) {
    try {
      if (!this.ctx) this.ctx = new AudioContext()
      if (this.ctx.state === 'suspended') this.ctx.resume()
      if (this.analysers.has(key)) this._unwatch(key)
      const src = this.ctx.createMediaStreamSource(stream)
      const an = this.ctx.createAnalyser()
      an.fftSize = 512
      src.connect(an)
      this.analysers.set(key, { an, src, buf: new Uint8Array(an.fftSize), hold: 0 })
    } catch (e) { console.warn('analyser', e) }
  }

  _unwatch (key) {
    const a = this.analysers.get(key)
    if (a) { try { a.src.disconnect() } catch {} this.analysers.delete(key) }
    if (this.speaking.delete(key)) this.onSpeaking(key, false)
  }

  _levels () {
    for (const [key, a] of this.analysers) {
      a.an.getByteTimeDomainData(a.buf)
      let sum = 0
      for (let i = 0; i < a.buf.length; i++) { const v = (a.buf[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / a.buf.length)
      const silenced = key === this.me ? (this.muted || this.deaf) : (this.states.get(key)?.muted)
      if (rms > 0.035 && !silenced) a.hold = 3; else if (a.hold > 0) a.hold--
      const on = a.hold > 0
      if (on !== this.speaking.has(key)) {
        if (on) this.speaking.add(key); else this.speaking.delete(key)
        this.onSpeaking(key, on)
      }
    }
  }

  // ---------- Kamera ----------

  async toggleCamera () {
    if (!this.channel) return
    if (this.cam) {
      this._removeStreamFromPeers(this.cam)
      this.cam.getTracks().forEach(t => t.stop())
      this.cam = null
    } else {
      await this.api.mediaAccess('camera')
      const dev = this.settings().cameraDevice
      try {
        this.cam = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: dev ? { exact: dev } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
        })
      } catch (e) {
        this.toast('Kameraya erişilemedi.')
        return
      }
      this._addStreamToPeers(this.cam, 'cam')
    }
    this._broadcast()
    this.onUpdate()
  }

  // ---------- Ekran paylaşımı (1080p) ----------
  // Sistem sesi, "restrictOwnAudio" kısıtıyla alınır: YANKI'nın kendi çaldığı sesler
  // (diğer konuşmacılar, müzik botu) yayına girmez, böylece izleyenler kendini duymaz.

  async startScreen (sourceId, qualityKey, withAudio) {
    if (!this.channel) return
    if (this.screen) this.stopScreen(true)
    const q = SCREEN_QUALITY[qualityKey] || SCREEN_QUALITY['1080p30']
    let stream = null
    try {
      await this.api.prepareScreen(sourceId, withAudio)
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: q.w, max: q.w }, height: { ideal: q.h, max: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
        audio: withAudio ? { restrictOwnAudio: true, suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
        systemAudio: withAudio ? 'include' : 'exclude',
        selfBrowserSurface: 'exclude'
      })
    } catch (e) {
      // Eski yöntem (ses olmadan)
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: q.w, maxHeight: q.h, maxFrameRate: q.fps, minFrameRate: Math.min(15, q.fps) } }
        })
      } catch {
        this.toast(window.yanki.platform === 'darwin'
          ? 'Ekran kaydı izni gerekli: Sistem Ayarları › Gizlilik ve Güvenlik › Ekran Kaydı › YANKI'
          : 'Ekran paylaşımı başlatılamadı.')
        return
      }
    }
    for (const at of stream.getAudioTracks()) {
      const restricted = at.getSettings?.().restrictOwnAudio === true
      if (!restricted && !this.settings().allowEchoAudio) {
        at.stop()
        stream.removeTrack(at)
        this.toast('Bu sistemde YANKI kendi sesini yayından ayıramadı; yankı olmaması için ekran sessiz paylaşılıyor. (Ayarlar › Ekran Paylaşımı)', 7000)
      }
    }
    if (!this.channel) { stream.getTracks().forEach(t => t.stop()); return }
    const vt = stream.getVideoTracks()[0]
    vt.contentHint = q.fps >= 60 ? 'motion' : 'detail'
    vt.onended = () => this.stopScreen()
    this.screen = stream
    this.screenQuality = q
    this._addStreamToPeers(stream, 'screen')
    this._broadcast()
    this.onUpdate()
  }

  stopScreen (silent) {
    if (!this.screen) return
    this._removeStreamFromPeers(this.screen)
    this.screen.getTracks().forEach(t => { t.onended = null; t.stop() })
    this.screen = null
    if (!silent) { this._broadcast(); this.onUpdate() }
  }

  _tuneScreenSender (sender) {
    const q = this.screenQuality
    const apply = async () => {
      try {
        const prm = sender.getParameters()
        if (!prm.encodings || !prm.encodings.length) return
        prm.encodings[0].maxBitrate = q.bitrate
        prm.encodings[0].maxFramerate = q.fps
        prm.encodings[0].scaleResolutionDownBy = 1
        prm.encodings[0].priority = 'high'
        prm.encodings[0].networkPriority = 'high'
        prm.degradationPreference = q.fps >= 60 ? 'maintain-framerate' : 'maintain-resolution'
        await sender.setParameters(prm)
      } catch {}
    }
    apply()
    setTimeout(apply, 1500)
    setTimeout(apply, 5000)
  }

  _retuneScreen (p) {
    if (!this.screen) return
    const vt = this.screen.getVideoTracks()[0]
    for (const s of p.pc.getSenders()) if (s.track === vt) this._tuneScreenSender(s)
  }

  // ---------- Arayüz için veri ----------

  peerState (key) {
    const p = this.peers.get(key)
    return p ? p.pc.connectionState : 'new'
  }

  participants (server, channel) {
    const list = []
    if (this.server === server && this.channel === channel) {
      list.push({ key: this.me, ...this._state(), self: true })
    }
    for (const [k, st] of this.states) {
      if (st.server === server && st.channel === channel) list.push({ key: k, ...st, self: false, conn: this.peerState(k) })
    }
    return list
  }

  tiles () {
    if (!this.channel) return []
    const out = []
    for (const p of this.participants(this.server, this.channel)) {
      if (p.self) {
        if (this.screen) out.push({ id: 'screen:' + p.key, key: p.key, kind: 'screen', stream: this.screen, self: true, label: this.screenQuality.label })
        if (this.cam) out.push({ id: 'cam:' + p.key, key: p.key, kind: 'cam', stream: this.cam, self: true })
        if (!this.cam) out.push({ id: 'av:' + p.key, key: p.key, kind: 'avatar', self: true })
        continue
      }
      const peer = this.peers.get(p.key)
      if (p.screen) out.push({ id: 'screen:' + p.key, key: p.key, kind: 'screen', stream: peer?.streams.get(p.screen) || null, label: p.screenLabel })
      if (p.cam) out.push({ id: 'cam:' + p.key, key: p.key, kind: 'cam', stream: peer?.streams.get(p.cam) || null })
      else out.push({ id: 'av:' + p.key, key: p.key, kind: 'avatar', conn: p.conn })
    }
    return out
  }

  // ---------- Bildirim sesleri (sentez — dosya gerekmez) ----------

  _sound (kind) {
    try {
      if (!this.ctx) this.ctx = new AudioContext()
      const ctx = this.ctx
      const notes = { join: [523, 784], leave: [784, 523], mute: [440, 330], unmute: [330, 440], message: [880], friend: [660, 880, 1046] }[kind] || [600]
      notes.forEach((f, i) => {
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.type = 'sine'
        o.frequency.value = f
        const t = ctx.currentTime + i * 0.09
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(0.08, t + 0.015)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
        o.connect(g).connect(ctx.destination)
        o.start(t)
        o.stop(t + 0.18)
      })
    } catch {}
  }

  sound (kind) { this._sound(kind) }
}

window.Voice = Voice
window.SCREEN_QUALITY = SCREEN_QUALITY
