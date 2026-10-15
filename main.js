'use strict'
const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, Notification, systemPreferences, net, Menu } = require('electron')
const path = require('path')
const { P2PNode } = require('./src/p2p/node')

// Aynı bilgisayarda test için ikinci profil: npm run start:2  (--profile=ikinci)
const profileArg = process.argv.find(a => a.startsWith('--profile='))
if (profileArg) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Yanki-' + profileArg.split('=')[1].replace(/[^\w-]/g, '')))
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.setName('Yankı')
let win = null
let node = null

function send (ev) {
  if (win && !win.isDestroyed()) win.webContents.send('p2p:event', ev)
}

function createWindow () {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0d1015',
    title: 'Yankı',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
  win.on('focus', () => send({ type: 'focus' }))
}

function setupSession () {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'display-capture'].includes(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission) => ['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(permission))

  // YouTube gömmeleri file:// kökenden Referer olmadan "Hata 153" verir; geçerli bir Referer ekle.
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*', 'https://*.googlevideo.com/*'] },
    (details, cb) => {
      details.requestHeaders.Referer = 'https://yanki.app/'
      cb({ requestHeaders: details.requestHeaders })
    }
  )

  // getDisplayMedia için yedek: ilk ekranı ver (uygulama kendi seçicisini kullanır)
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    cb({ video: sources[0] })
  })
}

function registerIpc () {
  ipcMain.handle('p2p:init', () => ({ me: node.me, profile: node.profile, servers: node.listServers(), platform: process.platform, version: app.getVersion() }))
  ipcMain.handle('p2p:createServer', (_e, name, icon) => node.createServer(name, icon))
  ipcMain.handle('p2p:join', (_e, code) => {
    const id = String(code || '').trim().replace(/^yanki:\/*/i, '').replace(/[^0-9a-f]/gi, '').toLowerCase()
    return node.joinServer(id)
  })
  ipcMain.handle('p2p:leave', (_e, id) => node.leaveServer(id))
  ipcMain.handle('p2p:post', (_e, s, type, data) => node.post(s, type, data))
  ipcMain.handle('p2p:meta', (_e, s) => node.meta(s))
  ipcMain.handle('p2p:messages', (_e, s, c, o) => node.messages(s, c, o || {}))
  ipcMain.handle('p2p:setProfile', (_e, p) => node.setProfile(p))
  ipcMain.on('p2p:eph', (_e, s, k, d) => node.sendEph(s, k, d))
  ipcMain.on('p2p:signal', (_e, to, d) => node.sendSignal(to, d))

  ipcMain.handle('desktop:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 384, height: 216 }, fetchWindowIcons: true })
    return sources
      .filter(s => !s.name.startsWith('Yankı'))
      .map(s => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window', thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(), icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null }))
  })

  ipcMain.handle('media:access', async (_e, kind) => {
    if (process.platform !== 'darwin') return true
    if (kind === 'screen') return systemPreferences.getMediaAccessStatus('screen') === 'granted'
    try { return await systemPreferences.askForMediaAccess(kind === 'camera' ? 'camera' : 'microphone') } catch { return false }
  })

  ipcMain.handle('link:preview', (_e, url) => linkPreview(url))

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

// ---------- Bağlantı önizleme (Open Graph) ----------
const previewCache = new Map()
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))

async function linkPreview (url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 2000) return null
  if (previewCache.has(url)) return previewCache.get(url)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 7000)
  let result = null
  try {
    const res = await net.fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YankiBot/1.0; +https://yanki.app)', 'Accept-Language': 'tr,en;q=0.8' } })
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
  node.on('error', e => console.error('[p2p]', e))
  registerIpc()
  createWindow()

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
  try { await Promise.race([node.destroy(), new Promise(r => setTimeout(r, 1500))]) } catch {}
  app.quit()
})
