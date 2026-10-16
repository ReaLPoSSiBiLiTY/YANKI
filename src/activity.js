'use strict'
/*
 * Etkinlik algılama: çalışan oyunu veya Spotify / Apple Music'te çalan şarkıyı bulur.
 * - Windows: pencereli süreçler PowerShell ile listelenir (ad, yol, pencere başlığı).
 *   Spotify'ın pencere başlığı çalarken "Sanatçı - Şarkı" olur.
 * - macOS: `ps` ile süreçler; Spotify/Music için AppleScript (ilk seferde izin sorulur).
 * - Oyunlar: bilinen oyun listesi + Steam/Epic/GOG/Riot kurulum klasörlerinden otomatik tanıma
 *   + kullanıcının eklediği özel oyunlar.
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
  'deeprockgalactic-win64-shipping': 'Deep Rock Galactic', 'brotato': 'Brotato', 'balatro': 'Balatro'
}

const IGNORE_DIRS = new Set(['steamworks shared', 'steamvr', 'steam controller configs', 'proton', 'steam linux runtime', 'launcher', 'directxredist', 'riot client', 'epic online services'])
const IGNORE_PROC = new Set(['steam', 'steamwebhelper', 'epicgameslauncher', 'explorer', 'yanki', 'electron', 'riotclientservices', 'riotclientux', 'galaxyclient', 'eadesktop', 'battle.net', 'unitycrashhandler64', 'crashreportclient'])

function run (cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, out) => resolve(err ? '' : String(out || '')))
  })
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
    this.timer = setInterval(() => this.poll(), 20000)
  }

  stop () { clearInterval(this.timer) }

  async _icon (file) {
    if (!file) return null
    if (this.iconCache.has(file)) return this.iconCache.get(file)
    let data = null
    try {
      const img = await this.app.getFileIcon(file, { size: 'normal' })
      if (!img.isEmpty()) data = img.resize({ width: 32, height: 32 }).toDataURL()
    } catch {}
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

  _matchGame (procName, file, title) {
    const n = procName.toLowerCase().replace(/\.exe$/, '')
    if (IGNORE_PROC.has(n)) return null
    const custom = this.custom.find(c => c.exe === n)
    if (custom) return custom.name
    if (KNOWN[n]) return KNOWN[n]
    if ((n === 'javaw' || n === 'java') && /^Minecraft/i.test(title || '')) return 'Minecraft'
    return gameFromPath(file)
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

  async _pollWindows () {
    const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object ProcessName,Path,MainWindowTitle | ConvertTo-Json -Compress'
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps])
    if (!out.trim()) return null
    let list = JSON.parse(out)
    if (!Array.isArray(list)) list = [list]
    let music = null
    for (const p of list) {
      const name = p.ProcessName || ''
      const game = this._matchGame(name, p.Path, p.MainWindowTitle)
      if (game) return { type: 'game', name: game, icon: await this._icon(p.Path), since: Date.now() }
      if (name.toLowerCase() === 'spotify' && !music) {
        const t = (p.MainWindowTitle || '').trim()
        if (t && !/^spotify( free| premium)?$/i.test(t) && t.includes(' - ')) {
          const i = t.indexOf(' - ')
          music = { type: 'music', service: 'Spotify', details: t.slice(0, i), name: t.slice(i + 3), icon: await this._icon(p.Path), since: Date.now() }
        }
      }
    }
    return music
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

module.exports = { ActivityDetector, gameFromPath, KNOWN }
