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
console.log('✓ Birim testleri geçti')
