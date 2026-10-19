'use strict'
/*
 * GitHub Releases üzerinden otomatik güncelleme.
 * - Son sürüm: GET api.github.com/repos/<depo>/releases/latest  (depo herkese açık olmalı)
 * - Windows (kurulum dosyasıyla kurulmuşsa): yeni .exe indirilir, sessiz kurulur (/S),
 *   uygulama kendiliğinden yeniden açılır. Kurulumsuz (zip) sürümde indirme sayfası açılır.
 * - macOS: yeni sürümün .zip'i indirilir, uygulama kapanınca küçük bir betik YANKI.app'i
 *   yenisiyle değiştirip yeniden açar. (Apple imzası gerektirmez; uygulama /Applications
 *   gibi yazılabilir bir yerde olmalı.)
 */
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')

function parseVer (v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? [+m[1], +m[2], +m[3]] : null
}
function newer (a, b) {
  const x = parseVer(a); const y = parseVer(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i] }
  return false
}

class Updater extends EventEmitter {
  constructor (app, net, shell, repo) {
    super()
    this.app = app
    this.net = net
    this.shell = shell
    this.repo = repo
    this.info = null
    this.file = null
    this.busy = false
  }

  get current () { return this.app.getVersion() }

  // Bu kurulum kendini güncelleyebilir mi?
  mode () {
    if (!this.app.isPackaged) return 'manual'
    if (process.platform === 'win32') {
      return fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall YANKI.exe')) ? 'auto' : 'manual'
    }
    if (process.platform === 'darwin') {
      const bundle = this.bundlePath()
      try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); return bundle.endsWith('.app') && !bundle.includes('/AppTranslocation/') ? 'auto' : 'manual' } catch { return 'manual' }
    }
    return 'manual'
  }

  bundlePath () { return path.resolve(process.execPath, '..', '..', '..') }

  // İndirme adresi yalnızca bu deponun sürüm dosyası olabilir
  trustedAsset (a) {
    return !!a && typeof a.browser_download_url === 'string' &&
      a.browser_download_url.startsWith(`https://github.com/${this.repo}/releases/download/`) &&
      /^[\w.-]+$/.test(a.name || '')
  }

  pickAsset (assets) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const test = process.platform === 'win32'
      ? (this.mode() === 'auto' ? /-win-x64\.exe$/i : /-win-x64\.zip$/i)
      : new RegExp(`-mac-${arch}\\.zip$`, 'i')
    return assets.find(a => test.test(a.name) && this.trustedAsset(a)) || null
  }

  async check () {
    const res = await this.net.fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'YANKI-Updater' }
    })
    if (res.status === 404) return { status: 'unavailable', reason: 'Sürüm sayfasına erişilemedi (depo herkese açık olmalı).' }
    if (!res.ok) return { status: 'error', reason: 'GitHub yanıtı: ' + res.status }
    const r = await res.json()
    const version = (String(r.tag_name || '').match(/\d+\.\d+\.\d+/) || [])[0]
    if (!version || !newer(version, this.current)) {
      this.info = null
      return { status: 'latest', current: this.current }
    }
    const asset = this.pickAsset(r.assets || [])
    this.info = {
      status: 'available',
      version,
      current: this.current,
      notes: String(r.body || '').slice(0, 20000),
      page: `https://github.com/${this.repo}/releases/latest`,
      mode: asset ? this.mode() : 'manual',
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest || null } : null
    }
    this.emit('available', this.info)
    return this.info
  }

  async download () {
    const info = this.info
    if (!info || !info.asset || this.busy) return false
    this.busy = true
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yanki-update-'))
      const file = path.join(dir, info.asset.name)
      const res = await this.net.fetch(info.asset.url, { headers: { 'User-Agent': 'YANKI-Updater' } })
      if (!res.ok || !res.body) throw new Error('İndirme başarısız: ' + res.status)
      const total = info.asset.size || +res.headers.get('content-length') || 0
      const hash = crypto.createHash('sha256')
      const out = fs.createWriteStream(file)
      const reader = res.body.getReader()
      let got = 0
      let lastEmit = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const buf = Buffer.from(value)
        hash.update(buf)
        if (!out.write(buf)) await new Promise(r => out.once('drain', r))
        got += buf.length
        if (Date.now() - lastEmit > 200) { lastEmit = Date.now(); this.emit('progress', { got, total }) }
      }
      await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()))
      if (total && got !== total) throw new Error('İndirilen dosya eksik.')
      const digest = info.asset.digest
      if (digest && /^sha256:/i.test(digest) && digest.slice(7).toLowerCase() !== hash.digest('hex')) throw new Error('Dosya doğrulanamadı (özet uyuşmuyor).')
      this.file = file
      this.emit('progress', { got, total: total || got, done: true })
      return true
    } finally {
      this.busy = false
    }
  }

  async install () {
    if (!this.file) throw new Error('Önce güncelleme indirilmeli.')
    if (process.platform === 'win32') {
      // electron-builder NSIS: /S sessiz, --updated güncelleme kipi, --force-run bitince başlat
      spawn(this.file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      setTimeout(() => this.app.quit(), 300)
      return true
    }
    if (process.platform === 'darwin') {
      const work = path.dirname(this.file)
      const unzip = path.join(work, 'unzipped')
      await new Promise((resolve, reject) => execFile('/usr/bin/ditto', ['-x', '-k', this.file, unzip], (e) => e ? reject(e) : resolve()))
      const appName = fs.readdirSync(unzip).find(f => f.endsWith('.app'))
      if (!appName) throw new Error('Güncelleme paketinde uygulama bulunamadı.')
      const target = this.bundlePath()
      const script = path.join(work, 'swap.sh')
      fs.writeFileSync(script, `#!/bin/bash
PID="$1"; NEW="$2"; APP="$3"
for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
rm -rf "$APP.old"
if mv "$APP" "$APP.old"; then
  if /usr/bin/ditto "$NEW" "$APP"; then rm -rf "$APP.old"; else rm -rf "$APP"; mv "$APP.old" "$APP"; fi
fi
/usr/bin/xattr -cr "$APP" 2>/dev/null
/usr/bin/open "$APP"
`, { mode: 0o755 })
      spawn('/bin/bash', [script, String(process.pid), path.join(unzip, appName), target], { detached: true, stdio: 'ignore' }).unref()
      setTimeout(() => this.app.quit(), 300)
      return true
    }
    return false
  }

  openPage () { if (this.info?.page) this.shell.openExternal(this.info.page) }
}

module.exports = { Updater, newer, parseVer }
