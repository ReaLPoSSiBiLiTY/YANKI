'use strict'
/*
 * Etkinlik algılama: çalışan oyunu veya Spotify / Apple Music'te çalan şarkıyı bulur.
 * - Windows: pencereli süreçler PowerShell ile listelenir (ad, yol, pencere başlığı).
 *   Spotify'ın pencere başlığı çalarken "Sanatçı - Şarkı" olur.
 * - macOS: `ps` ile süreçler; Spotify/Music için AppleScript (ilk seferde izin sorulur).
 * - Oyunlar: bilinen oyun listesi + Steam/Epic/GOG/Riot kurulum klasörlerinden otomatik tanıma
 *   + Xbox uygulaması / Game Pass oyunları (XboxGames klasörleri, açılışta bir kez taranır)
 *   + Unreal Engine oyunlarının "-Win64-Shipping" süreç adları + kullanıcının eklediği özel oyunlar.
 * - Simge: kurulu uygulamanın kendi simgesi (app.getFileIcon).
 */
const { execFile } = require('child_process')
const path = require('path')

const KNOWN = {
  cs2: 'Counter-Strike 2', csgo: 'Counter-Strike: Global Offensive', valheim: 'Valheim',
  eurotrucks2: 'Euro Truck Simulator 2', amtrucks: 'American Truck Simulator', dota2: 'Dota 2',
  'league of legends': 'League of Legends', 'valorant-win64-shipping': 'VALORANT',
  'fortniteclient-win64-shipping': 'Fortnite', gta5: 'Grand Theft Auto V', gta5_enhanced: 'Grand Theft Auto V',
  rdr2: 'Red Dead Redemption 2', eldenring: 'ELDEN RING', cyberpunk2077: 'Cyberpunk 2077',
  rocketleague: 'Rocket League', tslgame: 'PUBG: BATTLEGROUNDS', r5apex: 'Apex Legends', r5apex_dx12: 'Apex Legends',
  overwatch: 'Overwatch 2', witcher3: 'The Witcher 3', bg3: "Baldur's Gate 3", bg3_dx11: "Baldur's Gate 3",
  factorio: 'Factorio', terraria: 'Terraria', 'stardew valley': 'Stardew Valley', 'among us': 'Among Us',
  rustclient: 'Rust', dayz_x64: 'DayZ', fc25: 'EA SPORTS FC 25', fc26: 'EA SPORTS FC 26', fc24: 'EA SPORTS FC 24',
  pes6: 'Pro Evolution Soccer 6', 'deadbydaylight-win64-shipping': 'Dead by Daylight',
  'palworld-win64-shipping': 'Palworld', helldivers2: 'HELLDIVERS 2', cod: 'Call of Duty',
  rainbowsix: 'Rainbow Six Siege', rainbowsix_vulkan: 'Rainbow Six Siege', sotgame: 'Sea of Thieves',
  phasmophobia: 'Phasmophobia', 'lethal company': 'Lethal Company', 'minecraft.windows': 'Minecraft',
  robloxplayerbeta: 'Roblox', 'hollow knight': 'Hollow Knight', hades: 'Hades', hades2: 'Hades II',
  left4dead2: 'Left 4 Dead 2', portal2: 'Portal 2', skyrimse: 'Skyrim Special Edition', fallout4: 'Fallout 4',
  starfield: 'Starfield', wow: 'World of Warcraft', hearthstone: 'Hearthstone', 'diablo iv': 'Diablo IV',
  'marvel-win64-shipping': 'Marvel Rivals', cities2: 'Cities: Skylines II', cities: 'Cities: Skylines',
  'cs2.app': 'Counter-Strike 2', 'football manager 2024': 'Football Manager 2024', fm: 'Football Manager',
  'the sims 4': 'The Sims 4', ts4_x64: 'The Sims 4', 'satisfactory-win64-shipping': 'Satisfactory',
  'deeprockgalactic-win64-shipping': 'Deep Rock Galactic', 'brotato': 'Brotato', 'balatro': 'Balatro',
  // Xbox / Game Pass (PC) oyunlarının yaygın süreç adları
  forzahorizon5: 'Forza Horizon 5', forzahorizon4: 'Forza Horizon 4', forzamotorsport: 'Forza Motorsport',
  haloinfinite: 'Halo Infinite', mcclauncher: 'Halo: The Master Chief Collection', 'mcc-win64-shipping': 'Halo: The Master Chief Collection',
  flightsimulator: 'Microsoft Flight Simulator', flightsimulator2024: 'Microsoft Flight Simulator 2024',
  gears5: 'Gears 5', 'gearsofwar4': 'Gears of War 4', 'stateofdecay2-win64-shipping': 'State of Decay 2',
  'maine-win64-shipping': 'Grounded', 'maine-wingdk-shipping': 'Grounded', 'hi-fi-rush': 'Hi-Fi RUSH',
  relicardinal: 'Age of Empires IV', aoe2de_s: 'Age of Empires II: DE', aoe3de_s: 'Age of Empires III: DE', aomx: 'Age of Mythology: Retold',
  thegreatcircle: 'Indiana Jones and the Great Circle', 'avowed-win64-shipping': 'Avowed', 'avowed-wingdk-shipping': 'Avowed',
  'palworld-wingdk-shipping': 'Palworld', 'sotgame_wingdk': 'Sea of Thieves', 'pentiment': 'Pentiment',
  'doomthedarkages': 'DOOM: The Dark Ages', 'doometernalx64vk': 'DOOM Eternal', 'outerworlds2-wingdk-shipping': 'The Outer Worlds 2',
  'microsoft.minecraftuwp': 'Minecraft', 'minecraft.exe': 'Minecraft', 'ninjagaiden2black-wingdk-shipping': 'Ninja Gaiden 2 Black'
}

// "SomeGame-Win64-Shipping" / "SomeGame-WinGDK-Shipping" → "Some Game" (Unreal Engine oyunları)
// Oyun olmayan Unreal yardımcıları (ör. Epic Online Services katmanı: EOSOverlayRenderer-Win64-Shipping)
const UNREAL_HELPER = /overlay|renderer|crash|cef|webhelper|helper|launcher|bootstrap|service|updater|prereq|anticheat|reporter|^eos|^epic|editor|server$/i
function unrealName (n) {
  const m = n.match(/^(.+?)[-_](win64|wingdk|wingdk64)[-_]shipping$/i)
  if (!m || UNREAL_HELPER.test(m[1])) return null
  const base = m[1].replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z0-9])/g, '$1 $2').trim()
  return base.length >= 2 ? base.replace(/\b\w/g, c => c.toUpperCase()) : null
}

// Xbox uygulaması/Game Pass oyunlarını bul: her sürücüdeki oyun kök klasörü (.GamingRoot dosyası
// ya da varsayılan "XboxGames"), oradaki oyun klasörleri ve oyunların .exe adları.
const XBOX_SKIP_EXE = /^(gamelaunchhelper|unins.*|.*crash.*|.*setup.*|.*redist.*|vc_?redist.*|dxsetup|ue4prereq.*|easyanticheat.*|.*launcher.*|.*helper|.*reporter.*|.*bootstrap.*)$/i
function scanXboxGames () {
  const fs = require('fs')
  const map = new Map() // exe (küçük harf, .exe'siz) -> { name, file }
  if (process.platform !== 'win32') return map
  const roots = new Set()
  for (const d of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = d + ':\\'
    try {
      const gr = fs.readFileSync(drive + '.GamingRoot')
      // "RGBX" + sayı + UTF-16 klasör yolu
      const rel = gr.subarray(8).toString('utf16le').replace(/\0+$/, '').replace(/[^\x20-\uffff]/g, '').trim()
      if (rel) roots.add(path.isAbsolute(rel) ? rel : drive + rel)
    } catch {}
    try { if (fs.statSync(drive + 'XboxGames').isDirectory()) roots.add(drive + 'XboxGames') } catch {}
  }
  for (const root of roots) {
    let games = []
    try { games = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).slice(0, 300) } catch { continue }
    for (const g of games) {
      const dir = path.join(root, g.name)
      const content = fs.existsSync(path.join(dir, 'Content')) ? path.join(dir, 'Content') : dir
      let name = g.name
      const exes = new Set()
      for (const cfg of ['MicrosoftGame.config', 'appxmanifest.xml', 'AppxManifest.xml']) {
        try {
          const x = fs.readFileSync(path.join(content, cfg), 'utf8')
          const dn = x.match(/DefaultDisplayName="([^"]+)"/)?.[1] || x.match(/<DisplayName>([^<]+)<\/DisplayName>/)?.[1]
          if (dn && !/^ms-resource:/i.test(dn)) name = dn.trim()
          for (const m of x.matchAll(/<Executable[^>]*\sName="([^"]+)"|\sExecutable="([^"]+)"/g)) exes.add(m[1] || m[2])
          break
        } catch {}
      }
      // Yapılandırma yalnızca başlatıcıyı gösteriyorsa: üst iki seviyedeki .exe dosyaları
      const walk = (d, depth) => {
        let list = []
        try { list = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of list.slice(0, 200)) {
          if (e.isFile() && /\.exe$/i.test(e.name)) exes.add(path.relative(content, path.join(d, e.name)))
          else if (e.isDirectory() && depth < 2 && !/^(redist|_commonredist|support|tools|engine|installers?)$/i.test(e.name)) walk(path.join(d, e.name), depth + 1)
        }
      }
      walk(content, 0)
      for (const rel of exes) {
        const base = path.basename(rel).replace(/\.exe$/i, '').toLowerCase()
        if (!base || XBOX_SKIP_EXE.test(base) || map.has(base)) continue
        map.set(base, { name: name.slice(0, 60), file: path.join(content, rel) })
      }
    }
  }
  return map
}

const IGNORE_DIRS = new Set(['steamworks shared', 'steamvr', 'steam controller configs', 'proton', 'steam linux runtime', 'launcher', 'directxredist', 'riot client', 'epic online services'])
const IGNORE_PROC = new Set(['steam', 'steamwebhelper', 'epicgameslauncher', 'explorer', 'yanki', 'electron', 'riotclientservices', 'riotclientux', 'galaxyclient', 'eadesktop', 'battle.net', 'unitycrashhandler64', 'crashreportclient'])

function run (cmd, args, timeout = 8000, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: env ? { ...process.env, ...env } : undefined }, (err, out) => resolve(err ? '' : String(out || '')))
  })
}

// Windows: .exe dosyasının içindeki simgeyi PowerShell ile PNG olarak çıkar. Electron'un
// getFileIcon'u bazı oyunlarda (ör. Battle.net oyunları) Windows'un genel "uygulama" simgesini
// döndürüyordu. Dosya yolu komuta yazılmaz, ortam değişkeniyle verilir (tırnak/enjeksiyon olmaz).
const PS_ICON = `
$p = $env:YANKI_ICON_PATH
if (-not $p -and $env:YANKI_ICON_PROC) { $p = (Get-Process -Name $env:YANKI_ICON_PROC -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1).Path }
if ($p) {
  Write-Output "PATH:$p"
  try {
    Add-Type -AssemblyName System.Drawing
    $i = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
    $b = $i.ToBitmap(); $m = New-Object System.IO.MemoryStream
    $b.Save($m, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ("PNG:" + [Convert]::ToBase64String($m.ToArray()))
  } catch {}
}`
async function psIcon ({ file, proc }) {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_ICON], 10000, { YANKI_ICON_PATH: file || '', YANKI_ICON_PROC: proc || '' })
  const path = out.match(/^PATH:(.+)$/m)?.[1]?.trim() || null
  const b64 = out.match(/^PNG:([A-Za-z0-9+/=]+)\s*$/m)?.[1] || null
  return { path, png: b64 ? Buffer.from(b64, 'base64') : null }
}

function gameFromPath (p) {
  if (!p) return null
  const m = p.match(/[\\/]steamapps[\\/]common[\\/]([^\\/]+)[\\/]/i) ||
    p.match(/[\\/]Epic Games[\\/]([^\\/]+)[\\/]/i) ||
    p.match(/[\\/]GOG Galaxy[\\/]Games[\\/]([^\\/]+)[\\/]/i) ||
    p.match(/[\\/]Riot Games[\\/]([^\\/]+)[\\/]/i)
  if (!m) return null
  const name = m[1].trim()
  return IGNORE_DIRS.has(name.toLowerCase()) ? null : name
}

class ActivityDetector {
  constructor (app, onChange) {
    this.app = app
    this.onChange = onChange
    this.enabled = true
    this.custom = [] // [{ exe, name }]
    this.current = null
    this.iconCache = new Map()
    this.timer = null
    this.busy = false
    this.xbox = new Map()
    this.xboxAt = 0
  }

  configure ({ enabled, custom } = {}) {
    if (typeof enabled === 'boolean') this.enabled = enabled
    if (Array.isArray(custom)) {
      this.custom = custom
        .filter(c => c && typeof c.exe === 'string' && typeof c.name === 'string')
        .map(c => ({ exe: c.exe.toLowerCase().replace(/\.exe$/, '').trim(), name: c.name.slice(0, 60) }))
        .filter(c => c.exe)
    }
    if (!this.enabled) this._set(null)
    this.poll()
  }

  start () {
    this.poll()
    this.timer = setInterval(() => this.poll(), 25000)
  }

  stop () { clearInterval(this.timer) }

  _pngToData (buf) {
    try {
      const { nativeImage } = require('electron')
      const img = nativeImage.createFromBuffer(buf)
      if (!img.isEmpty()) return img.resize({ width: 32, height: 32, quality: 'best' }).toDataURL()
    } catch {}
    return null
  }

  async _icon (file) {
    if (!file) return null
    if (this.iconCache.has(file)) return this.iconCache.get(file)
    let data = null
    if (process.platform === 'win32' && /\.exe$/i.test(file)) {
      const r = await psIcon({ file })
      if (r.png) data = this._pngToData(r.png)
    }
    if (!data) {
      try {
        const img = await this.app.getFileIcon(file, { size: 'normal' })
        if (!img.isEmpty()) data = img.resize({ width: 32, height: 32 }).toDataURL()
      } catch {}
    }
    this.iconCache.set(file, data)
    return data
  }

  _set (act) {
    const key = (a) => a ? [a.type, a.name, a.details].join('|') : ''
    if (key(act) === key(this.current)) return
    if (act && this.current && act.type === this.current.type && act.name === this.current.name && act.type === 'game') act.since = this.current.since
    this.current = act
    this.onChange(act)
  }

  // loose: tahmine dayalı eşleşmeye (Unreal süreç adı) izin ver
  _matchGame (procName, file, title, loose = true) {
    const n = procName.toLowerCase().replace(/\.exe$/, '')
    if (IGNORE_PROC.has(n)) return null
    const custom = this.custom.find(c => c.exe === n)
    if (custom) return custom.name
    if (KNOWN[n]) return KNOWN[n]
    const xb = this.xbox.get(n)
    if (xb) return xb.name
    if ((n === 'javaw' || n === 'java') && /^Minecraft/i.test(title || '')) return 'Minecraft'
    const viaPath = gameFromPath(file)
    if (viaPath) return viaPath
    if (!loose) return null
    const ue = unrealName(n)
    return ue && !IGNORE_PROC.has(n) ? ue : null
  }

  async poll () {
    if (!this.enabled || this.busy) return
    this.busy = true
    try {
      const act = process.platform === 'win32' ? await this._pollWindows() : process.platform === 'darwin' ? await this._pollMac() : null
      this._set(act)
    } catch {
      // algılama başarısızsa sessizce devam
    } finally {
      this.busy = false
    }
  }

  // Hafif Windows algılaması: PowerShell yerine tasklist + Steam kayıt defteri.
  // PowerShell yalnızca yeni bir oyun ilk kez görüldüğünde, simgesi için bir kez çalışır.
  async _pollWindows () {
    // Xbox/Game Pass oyun listesi: açılışta ve 30 dakikada bir (yalnızca klasör adlarını okur)
    if (Date.now() - this.xboxAt > 30 * 60000) {
      this.xboxAt = Date.now()
      try { this.xbox = scanXboxGames() } catch { this.xbox = new Map() }
    }
    const out = await run('tasklist', ['/fo', 'csv', '/nh'], 6000)
    const names = new Set()
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)"/)
      if (m) names.add(m[1])
    }
    const found = async (exe, game) => {
      const xb = this.xbox.get(exe.toLowerCase().replace(/\.exe$/, ''))
      return { type: 'game', name: game, icon: xb ? await this._icon(xb.file) : await this._winIcon(exe), since: Date.now(), store: xb ? 'Xbox' : undefined }
    }
    // Önce kesin eşleşmeler (bilinen oyunlar, Xbox, özel), sonra Steam, en son tahmin (Unreal süreç adı)
    for (const exe of names) { const game = this._matchGame(exe, null, '', false); if (game) return found(exe, game) }
    const steam = await this._steamGame()
    if (steam) return { type: 'game', name: steam.name, icon: steam.icon, since: Date.now() }
    for (const exe of names) { const game = this._matchGame(exe, null, ''); if (game) return found(exe, game) }
    const spotify = [...names].find(n => n.toLowerCase() === 'spotify.exe')
    if (spotify) {
      const v = await run('tasklist', ['/v', '/fo', 'csv', '/nh', '/fi', 'imagename eq Spotify.exe'], 6000)
      for (const line of v.split(/\r?\n/)) {
        const cols = line.match(/"([^"]*)"/g)
        if (!cols) continue
        const t = cols[cols.length - 1].slice(1, -1).trim()
        if (t && !/^spotify( free| premium)?$/i.test(t) && t !== 'N/A' && t.includes(' - ')) {
          const i = t.indexOf(' - ')
          return { type: 'music', service: 'Spotify', details: t.slice(0, i), name: t.slice(i + 3), icon: await this._winIcon('Spotify.exe'), since: Date.now() }
        }
      }
    }
    return null
  }

  async _winIcon (exe) {
    const k = 'exe:' + exe.toLowerCase()
    if (this.iconCache.has(k)) return this.iconCache.get(k)
    this.iconCache.set(k, null)
    const name = exe.replace(/\.exe$/i, '')
    if (!/^[\w .+-]{1,80}$/.test(name)) return null
    // Tek PowerShell çağrısı: sürecin yolu ve .exe'nin kendi simgesi
    const r = await psIcon({ proc: name })
    let icon = r.png ? this._pngToData(r.png) : null
    if (!icon && r.path) icon = await this._icon(r.path)
    this.iconCache.set(k, icon)
    return icon
  }

  // Steam, çalışan oyunun kimliğini kayıt defterine yazar (RunningAppID)
  async _steamGame () {
    const q = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'RunningAppID'], 4000)
    const m = q.match(/RunningAppID\s+REG_DWORD\s+0x([0-9a-f]+)/i)
    const id = m ? parseInt(m[1], 16) : 0
    if (!id) return null
    if (this.iconCache.has('steam:' + id)) return this.iconCache.get('steam:' + id)
    const sp = (await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], 4000)).match(/SteamPath\s+REG_SZ\s+(.+)/i)
    let result = { name: 'Steam oyunu', icon: null }
    if (sp) {
      const fs = require('fs')
      const root = sp[1].trim().replace(/\//g, '\\')
      const libs = [root]
      try {
        const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')
        for (const mm of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(mm[1].replace(/\\\\/g, '\\'))
      } catch {}
      for (const lib of libs) {
        try {
          const acf = fs.readFileSync(path.join(lib, 'steamapps', `appmanifest_${id}.acf`), 'utf8')
          const name = acf.match(/"name"\s+"([^"]+)"/)?.[1]
          const dir = acf.match(/"installdir"\s+"([^"]+)"/)?.[1]
          if (name) result.name = name
          if (dir) {
            const gdir = path.join(lib, 'steamapps', 'common', dir)
            const exes = fs.readdirSync(gdir).filter(f => /\.exe$/i.test(f) && !/unins|crash|launcher|setup|redist/i.test(f))
              .map(f => ({ f, size: fs.statSync(path.join(gdir, f)).size })).sort((a, b) => b.size - a.size)
            if (exes[0]) result.icon = await this._icon(path.join(gdir, exes[0].f))
          }
          break
        } catch {}
      }
    }
    if (this.custom.length || result) this.iconCache.set('steam:' + id, result)
    return result
  }

  async _pollMac () {
    const out = await run('ps', ['-axo', 'comm='])
    const procs = out.split('\n').map(s => s.trim()).filter(Boolean)
    for (const p of procs) {
      const base = path.basename(p)
      const game = this._matchGame(base, p, '')
      if (game) {
        const bundle = p.match(/^(.*?\.app)\//)
        return { type: 'game', name: game, icon: await this._icon(bundle ? bundle[1] : p), since: Date.now() }
      }
    }
    const players = [
      { app: 'Spotify', service: 'Spotify', marker: '/Spotify.app/' },
      { app: 'Music', service: 'Apple Music', marker: '/Music.app/Contents/MacOS/Music' }
    ]
    for (const pl of players) {
      const proc = procs.find(p => p.includes(pl.marker))
      if (!proc) continue
      const script = `tell application "${pl.app}" to if player state is playing then return (artist of current track) & "\t" & (name of current track)`
      const r = (await run('osascript', ['-e', script], 4000)).trim()
      if (!r.includes('\t')) continue
      const [artist, song] = r.split('\t')
      const bundle = proc.match(/^(.*?\.app)\//)
      return { type: 'music', service: pl.service, details: artist, name: song, icon: await this._icon(bundle ? bundle[1] : proc), since: Date.now() }
    }
    return null
  }
}

module.exports = { ActivityDetector, gameFromPath, KNOWN, unrealName, scanXboxGames }
