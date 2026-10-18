'use strict'
// GitHub sürüm sayfasının metnini renderer/changelog.js'ten üretir.
// Kullanım: node scripts/release-notes.js v1.2.0 > notes.md
const path = require('path')
const CHANGELOG = require(path.join(__dirname, '..', 'renderer', 'changelog.js'))
const pkg = require(path.join(__dirname, '..', 'package.json'))

const tag = process.argv[2] || 'v' + pkg.version
const version = (tag.match(/\d+\.\d+\.\d+/) || [pkg.version])[0]
const entry = CHANGELOG.find(e => e.version === version) || CHANGELOG[0]
const repo = (pkg.yanki && pkg.yanki.updateRepo) || 'ReaLPoSSiBiLiTY/YANKI'
const raw = `https://raw.githubusercontent.com/${repo}/main`
const v = version
const dl = (file) => `https://github.com/${repo}/releases/download/${tag}/${file}`

const out = []
out.push(`<p align="center"><img src="${raw}/docs/banner.png" alt="YANKI" width="720"></p>`)
out.push('')
out.push(`<h2 align="center">${entry.title}</h2>`)
out.push('')
out.push('## Yenilikler')
out.push('')
for (const it of entry.items) out.push(`- **${it.title}** — ${it.desc}`)
out.push('')
out.push('## İndir')
out.push('')
out.push('| Sistem | Dosya |')
out.push('|---|---|')
out.push(`| 🪟 **Windows** (kurulum, otomatik güncellenir) | [YANKI-${v}-win-x64.exe](${dl(`YANKI-${v}-win-x64.exe`)}) |`)
out.push(`| 🪟 Windows (kurulumsuz) | [YANKI-${v}-win-x64.zip](${dl(`YANKI-${v}-win-x64.zip`)}) |`)
out.push(`| 🍎 **macOS** — Apple Silicon (M1–M4) | [YANKI-${v}-mac-arm64.dmg](${dl(`YANKI-${v}-mac-arm64.dmg`)}) |`)
out.push(`| 🍎 macOS — Intel | [YANKI-${v}-mac-x64.dmg](${dl(`YANKI-${v}-mac-x64.dmg`)}) |`)
out.push('')
out.push('> Uygulama içinden güncellenen sürümler bu sayfayı kendisi takip eder. İlk kurulumda: Windows uyarısında *Ek bilgi › Yine de çalıştır*, macOS\'ta *Sistem Ayarları › Gizlilik ve Güvenlik › Yine de Aç*.')
process.stdout.write(out.join('\n') + '\n')
