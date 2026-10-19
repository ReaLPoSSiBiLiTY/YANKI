'use strict'
const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, Notification, systemPreferences, net, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const { P2PNode } = require('./src/p2p/node')
const { ActivityDetector } = require('./src/activity')
const { Updater } = require('./src/updater')
const UPDATE_REPO = (require('./package.json').yanki || {}).updateRepo || 'ReaLPoSSiBiLiTY/YANKI'

const APP_NAME = 'YANKI'
app.setName(APP_NAME)
// Müzik botunun kullanıcı etkileşimi olmadan çalabilmesi için
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Aynı bilgisayarda test için ikinci profil: npm run start:2  (--profile=ikinci)
const profileArg = process.argv.find(a => a.startsWith('--profile='))
const appData = app.getPath('appData')
if (profileArg) {
  app.setPath('userData', path.join(appData, 'YANKI-' + profileArg.split('=')[1].replace(/[^\w-]/g, '')))
} else {
  app.setPath('userData', path.join(appData, APP_NAME))
  migrateOldData()
  if (!app.requestSingleInstanceLock()) app.quit()
}

// v1.0 verileri "Yankı" klasöründeydi; kimlik ve sunucular kaybolmasın diye taşı.
function migrateOldData () {
  const target = app.getPath('userData')
  if (fs.existsSync(path.join(target, 'p2p', 'identity.json'))) return
  for (const old of ['Yankı', 'Yanki', 'yanki']) {
    const src = path.join(appData, old)
    if (src === target || !fs.existsSync(path.join(src, 'p2p', 'identity.json'))) continue
    try {
      fs.mkdirSync(target, { recursive: true })
      fs.cpSync(src, target, { recursive: true, force: false, errorOnExist: false, filter: (p) => !/Singleton|lockfile|\.lock$/i.test(p) })
    } catch (e) { console.error('taşıma', e) }
    return
  }
}

if (process.platform === 'win32') app.setAppUserModelId('app.yanki.desktop')

let win = null
let node = null
let activity = null
let updater = null
let pendingShare = null

function send (ev) {
  if (win && !win.isDestroyed()) win.webContents.send('p2p:event', ev)
}

function createWindow () {
  win = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#07080d',
    title: APP_NAME,
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false // arka planda da ses/görüntü kesintisiz kalsın
    }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  // backgroundThrottling kapalı olduğu için sayfa küçültülünce kendiliğinden "gizli" sayılmaz;
  // arayüz gereksiz çizim yapmasın diye durumu kendimiz bildiriyoruz
  const vis = (hidden) => send({ type: 'window', hidden })
  win.on('minimize', () => vis(true))
  win.on('hide', () => vis(true))
  win.on('restore', () => vis(false))
  win.on('show', () => vis(false))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
  win.on('focus', () => send({ type: 'focus' }))
  win.on('page-title-updated', (e) => e.preventDefault())
}

function setupSession () {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'display-capture'].includes(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission) => ['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'display-capture'].includes(permission))

  // YouTube gömmeleri file:// kökenden Referer olmadan "Hata 153" verir; geçerli bir Referer ekle.
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*', 'https://*.googlevideo.com/*'] },
    (details, cb) => {
      details.requestHeaders.Referer = 'https://yanki.app/'
      cb({ requestHeaders: details.requestHeaders })
    }
  )

  // Ekran paylaşımı: arayüz kaynağı kendi seçicisinde seçer, burada o kaynak verilir.
  // Windows'ta sistem sesi "loopback" ile alınır; arayüz restrictOwnAudio kısıtıyla
  // YANKI'nın kendi çaldığı sesleri (diğer konuşmacılar, müzik botu) yayından çıkarır.
  ses.setDisplayMediaRequestHandler(async (req, cb) => {
    const want = pendingShare
    pendingShare = null
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      const src = (want && sources.find(s => s.id === want.sourceId)) || sources.find(s => s.id.startsWith('screen'))
      if (!src) return cb({})
      const res = { video: src }
      if (want && want.audio && req.audioRequested && process.platform === 'win32') res.audio = 'loopback'
      cb(res)
    } catch {
      cb({})
    }
  })
}

function registerIpc () {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a))
  h('p2p:init', () => ({ me: node.me, profile: node.profile, servers: node.listServers(), platform: process.platform, version: app.getVersion() }))
  h('p2p:createServer', (name, icon) => node.createServer(name, icon))
  h('p2p:join', (code) => {
    const id = String(code || '').trim().replace(/^yanki:\/*/i, '').replace(/[^0-9a-f]/gi, '').toLowerCase()
    return node.joinServer(id)
  })
  h('p2p:leave', (id) => node.leaveServer(id))
  h('p2p:post', (s, type, data) => node.post(s, type, data))
  h('p2p:meta', (s) => node.meta(s))
  h('p2p:messages', (s, c, o) => node.messages(s, c, o || {}))
  h('p2p:music', (s, c) => node.music(s, c))
  h('p2p:setProfile', (p) => node.setProfile(p))
  ipcMain.on('p2p:eph', (_e, s, k, d) => node.sendEph(s, k, d))
  ipcMain.on('p2p:signal', (_e, to, d) => node.sendSignal(to, d))
  ipcMain.on('p2p:wantPeer', (_e, key, reason, on) => node.wantPeer(key, String(reason), !!on))

  // Arkadaşlar ve özel mesajlar
  h('dm:list', () => node.dmList())
  h('dm:messages', (key, o) => node.dmMessages(key, o || {}))
  h('dm:post', (key, type, data) => node.dmPost(key, type, data))
  h('dm:canDM', (key) => node.canDM(key))
  h('friend:request', (key) => node.friendRequest(key))
  h('friend:accept', (key) => node.friendAccept(key))
  h('friend:remove', (key) => node.friendRemove(key))
  h('friend:status', (key) => node.friendStatus(key))
  h('friend:block', (key) => node.block(key))
  h('friend:unblock', (key) => node.unblock(key))
  h('friend:blocked', () => node.blockedList())
  ipcMain.on('dm:typing', (_e, key) => node.dmTyping(key))

  // Etkinlik
  h('activity:config', (cfg) => { activity.configure(cfg || {}); return activity.current })
  h('activity:current', () => activity.current)
  h('activity:all', () => node.activities())

  // Güncelleme
  h('update:check', () => updater.check().catch(e => ({ status: 'error', reason: e.message })))
  h('update:download', () => updater.download())
  h('update:install', () => updater.install())
  h('update:page', () => updater.openPage())
  h('update:info', () => updater.info)

  h('desktop:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 384, height: 216 }, fetchWindowIcons: true })
    return sources
      .filter(s => !/^YANKI$/i.test(s.name))
      .map(s => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window', thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(), icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null }))
  })
  h('screen:prepare', (sourceId, audio) => { pendingShare = { sourceId: String(sourceId), audio: !!audio } })

  h('media:access', async (kind) => {
    if (process.platform !== 'darwin') return true
    if (kind === 'screen') return systemPreferences.getMediaAccessStatus('screen') === 'granted'
    try { return await systemPreferences.askForMediaAccess(kind === 'camera' ? 'camera' : 'microphone') } catch { return false }
  })

  h('link:preview', (url) => linkPreview(url))
  h('yt:meta', (id) => ytMeta(id))

  // Tema: kullanıcının yüklediği arka plan resmi uygulama klasöründe saklanır
  const themeFile = () => path.join(app.getPath('userData'), 'theme-custom.bin')
  h('theme:saveImage', (dataUrl) => {
    if (dataUrl === null) { try { fs.rmSync(themeFile(), { force: true }) } catch {} return true }
    if (typeof dataUrl !== 'string' || dataUrl.length > 14e6 || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)) return false
    fs.writeFileSync(themeFile(), dataUrl)
    return true
  })
  h('theme:loadImage', () => { try { return fs.readFileSync(themeFile(), 'utf8') } catch { return null } })

  ipcMain.on('app:notify', (_e, title, body) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 200) })
    n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() } })
    n.show()
  })
  ipcMain.on('app:badge', (_e, count) => {
    try { app.setBadgeCount(count) } catch {}
    if (win && process.platform === 'win32') win.flashFrame(count > 0 && !win.isFocused())
  })
  ipcMain.on('app:open', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url) })
}

// ---------- YouTube bilgisi (müzik botu için başlık + süre) ----------
const ytCache = new Map()
async function ytMeta (id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null
  if (ytCache.has(id)) return ytCache.get(id)
  let title = ''
  let duration = 0
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', 'Accept-Language': 'tr,en;q=0.8', Cookie: 'SOCS=CAI; CONSENT=YES+1' }
  const timed = (url) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    return net.fetch(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(t))
  }
  try {
    const r = await timed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`)
    if (r.ok) title = String((await r.json()).title || '')
  } catch {}
  try {
    const r = await timed(`https://www.youtube.com/watch?v=${id}&hl=tr`)
    const html = (await r.text()).slice(0, 4_000_000)
    const m = html.match(/"lengthSeconds":"(\d+)"/)
    if (m) duration = parseInt(m[1], 10)
    if (!title) title = decode(html.match(/<meta name="title" content="([^"]*)"/)?.[1] || '')
  } catch {}
  const out = { id, title: title || 'YouTube videosu', duration }
  ytCache.set(id, out)
  return out
}

// ---------- Bağlantı önizleme (Open Graph) ----------
const previewCache = new Map()
function decode (s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
}

// Bir sohbet üyesi, herkesin uygulamasına yerel ağdaki (modem arayüzü, NAS, localhost'taki
// servisler) adresleri açtıramasın: yalnızca internetteki genel adreslere izin verilir.
const dns = require('dns').promises
const net4 = require('net')
function privateIp (ip) {
  if (net4.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  const v = ip.toLowerCase()
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7))
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff')
}
async function publicUrl (u) {
  let x
  try { x = new URL(u) } catch { return false }
  if (!/^https?:$/.test(x.protocol) || x.username || x.password) return false
  if (x.port && !['80', '443', '8080', '8443'].includes(x.port)) return false
  const host = x.hostname.replace(/^\[|\]$/g, '')
  if (/^localhost$|\.local$|\.internal$|\.lan$|\.home$/i.test(host)) return false
  try {
    const addrs = net4.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
    return addrs.length > 0 && !addrs.some(a => privateIp(a.address))
  } catch { return false }
}

async function linkPreview (url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 2000) return null
  if (previewCache.has(url)) return previewCache.get(url)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 7000)
  let result = null
  try {
    // Yönlendirmeleri elle izle; her adımda adres yeniden denetlenir
    let res = null
    let cur = url
    for (let hop = 0; hop < 5; hop++) {
      if (!(await publicUrl(cur))) throw new Error('blocked')
      res = await net.fetch(cur, { signal: ctrl.signal, redirect: 'manual', credentials: 'omit', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YankiBot/1.2)', 'Accept-Language': 'tr,en;q=0.8' } })
      const loc = res.status >= 300 && res.status < 400 && res.headers.get('location')
      if (!loc) break
      cur = new URL(loc, cur).href
      res = null
    }
    if (!res) throw new Error('too many redirects')
    const ct = res.headers.get('content-type') || ''
    if (/^image\//.test(ct)) {
      result = { kind: 'image', url }
    } else if (/html/.test(ct)) {
      const reader = res.body.getReader()
      let html = ''
      const dec = new TextDecoder()
      while (html.length < 700000) {
        const { done, value } = await reader.read()
        if (done) break
        html += dec.decode(value, { stream: true })
        if (/<\/head>/i.test(html)) break
      }
      try { reader.cancel() } catch {}
      const meta = (prop) => {
        const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i')
        const tag = html.match(re)?.[0]
        const v = tag && tag.match(/content=["']([^"']*)["']/i)?.[1]
        return v ? decode(v).trim() : ''
      }
      const title = meta('og:title') || meta('twitter:title') || decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim()
      let image = meta('og:image') || meta('twitter:image')
      if (image) { try { image = new URL(image, res.url || url).href } catch { image = '' } }
      if (image && !/^https:\/\//.test(image)) image = ''
      if (title) {
        result = {
          kind: 'page',
          url,
          site: meta('og:site_name') || new URL(url).hostname.replace(/^www\./, ''),
          title: title.slice(0, 200),
          description: (meta('og:description') || meta('description') || meta('twitter:description')).slice(0, 400),
          image,
          color: meta('theme-color')
        }
      }
    }
  } catch {}
  clearTimeout(timer)
  previewCache.set(url, result)
  if (previewCache.size > 500) previewCache.delete(previewCache.keys().next().value)
  return result
}

app.whenReady().then(async () => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  setupSession()
  node = new P2PNode(path.join(app.getPath('userData'), 'p2p'))
  await node.start()
  node.on('ops', e => send({ type: 'ops', ...e }))
  node.on('peers', servers => send({ type: 'peers', servers }))
  node.on('eph', e => send({ type: 'eph', ...e }))
  node.on('signal', e => send({ type: 'signal', ...e }))
  node.on('servers', servers => send({ type: 'servers', servers }))
  node.on('dm', e => send({ type: 'dm', ...e }))
  node.on('friends', () => send({ type: 'friends' }))
  node.on('activity', e => send({ type: 'activity', ...e }))
  node.on('dmtyping', e => send({ type: 'dmtyping', ...e }))
  node.on('error', e => console.error('[p2p]', e))

  activity = new ActivityDetector(app, (act) => {
    node.setActivity(act)
    send({ type: 'activity', from: node.me, act })
  })

  registerIpc()
  createWindow()
  activity.start()

  updater = new Updater(app, net, shell, UPDATE_REPO)
  updater.on('available', info => send({ type: 'update-available', info }))
  updater.on('progress', p => send({ type: 'update-progress', ...p }))
  const autoCheck = () => updater.check().catch(() => {})
  setTimeout(autoCheck, 8000)
  setInterval(autoCheck, 4 * 60 * 60 * 1000)

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus() }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', async (e) => {
  if (quitting || !node) return
  e.preventDefault()
  quitting = true
  activity?.stop()
  try { await Promise.race([node.destroy(), new Promise(r => setTimeout(r, 1500))]) } catch {}
  app.quit()
})
