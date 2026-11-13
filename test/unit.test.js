'use strict'
// Güncelleyici sürüm karşılaştırması ve sürüm notu üretimi
const assert = require('assert')
const { execFileSync } = require('child_process')
const path = require('path')
const { newer, parseVer } = require('../src/updater')
const CHANGELOG = require('../renderer/changelog')
const pkg = require('../package.json')

assert.deepStrictEqual(parseVer('v.1.1.1'), [1, 1, 1])
assert.deepStrictEqual(parseVer('v1.10.0'), [1, 10, 0])
assert.strictEqual(newer('1.2.0', '1.1.1'), true)
assert.strictEqual(newer('1.10.0', '1.9.9'), true)
assert.strictEqual(newer('1.2.0', '1.2.0'), false)
assert.strictEqual(newer('1.1.9', '1.2.0'), false)
assert.strictEqual(newer('garbage', '1.0.0'), false)

// Paket sürümünün sürüm notları olmalı (GitHub sayfası ve Yenilikler ekranı bundan üretilir)
assert.ok(CHANGELOG.some(e => e.version === pkg.version), `changelog.js içinde ${pkg.version} yok`)
for (const e of CHANGELOG) for (const it of e.items) assert.ok(it.title && it.desc)
const notes = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'release-notes.js'), 'v' + pkg.version]).toString()
assert.ok(notes.includes('## Yenilikler') && notes.includes(`YANKI-${pkg.version}-win-x64.exe`))
// Profil: sürüm ve kullanım sayaçları temizlenir
const { sanitizeProfile } = require('../src/p2p/state')
const pr = sanitizeProfile({ name: 'x', ver: '1.6.0', stats: { msgs: 12.7, dice: -3, evil: 5, streak: 1e12 } }, 1)
assert.strictEqual(pr.ver, '1.6.0')
assert.strictEqual(pr.stats.msgs, 12)
assert.ok(!('evil' in pr.stats) && !(pr.stats.dice > 0))
assert.ok(pr.stats.streak < 1e12)
assert.strictEqual(sanitizeProfile({ name: 'x', ver: '<b>1.6</b>' }, 1).ver, null)

// Oyun algılama: Unreal süreç adları ve Xbox/Game Pass
const { unrealName, ActivityDetector } = require('../src/activity')
const det0 = () => new ActivityDetector({}, () => {})
assert.strictEqual(unrealName('Hogwarts_Legacy-Win64-Shipping'), 'Hogwarts Legacy')
assert.strictEqual(unrealName('palworld-wingdk-shipping'), 'Palworld')
assert.strictEqual(unrealName('notepad'), null)
assert.strictEqual(unrealName('EOSOverlayRenderer-Win64-Shipping'), null)
assert.strictEqual(unrealName('CrashReportClient-Win64-Shipping'), null)
assert.strictEqual(det0()._matchGame('EOSOverlayRenderer-Win64-Shipping.exe'), null)
const det = new ActivityDetector({}, () => {})
det.xbox.set('somegame', { name: 'Bir Game Pass Oyunu', file: 'x' })
assert.strictEqual(det._matchGame('SomeGame.exe'), 'Bir Game Pass Oyunu')
assert.strictEqual(det._matchGame('ForzaHorizon5.exe'), 'Forza Horizon 5')

// Bas-Konuş: kapalıyken hiçbir şey başlatılmaz, bilinmeyen tuş reddedilir
const { PushToTalk, CODES } = require('../src/ptt')
const events = []
const ptt = new PushToTalk(e => events.push(e), null)
assert.deepStrictEqual(ptt.configure({ on: false }), { ok: true, global: false })
assert.strictEqual(ptt.configure({ on: true, key: { t: 'key', code: 'Nope' } }).reason, 'key')
assert.ok(CODES.CapsLock && CODES.KeyV && CODES.Backquote)
assert.strictEqual(ptt.configure({ on: true, key: { t: 'mouse', b: 0 } }).reason, 'key') // sol tık atanamaz
ptt.stop()

console.log('✓ Birim testleri geçti')
