'use strict'
// Ed25519 kimlik — Node'un yerleşik kripto modülü. Aynı tohumdan (seed)
// Hyperswarm için libsodium biçiminde anahtar çifti de üretilir; böylece
// ağ bağlantısının karşı tarafı kriptografik olarak doğrulanmış olur.
const crypto = require('crypto')

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const pubCache = new Map()

function fromSeed (seed) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const publicRaw = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length)
  return {
    privateKey,
    publicKey: Buffer.from(publicRaw),
    // libsodium/Hyperswarm biçimi: secretKey = seed || publicKey
    swarmKeyPair: { publicKey: Buffer.from(publicRaw), secretKey: Buffer.concat([seed, publicRaw]) }
  }
}

function publicKeyObject (hex) {
  let k = pubCache.get(hex)
  if (!k) {
    k = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' })
    if (pubCache.size > 5000) pubCache.clear()
    pubCache.set(hex, k)
  }
  return k
}

function sign (privateKey, data) {
  return crypto.sign(null, data, privateKey).toString('base64')
}

function verify (authorHex, data, sigB64) {
  try {
    return crypto.verify(null, data, publicKeyObject(authorHex), Buffer.from(sigB64, 'base64'))
  } catch {
    return false
  }
}

// ---------- Özel kanal şifrelemesi ----------
// Her kullanıcının ayrı bir X25519 anahtarı vardır (kimlik dosyasında saklanır). Kanal anahtarı,
// her üye için tek kullanımlık bir X25519 anahtarıyla mühürlenir (ECDH + HKDF + AES-256-GCM).
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex')

function xFromSeed (seed) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, seed]), format: 'der', type: 'pkcs8' })
  const pub = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(X_SPKI.length)
  return { privateKey, publicRaw: Buffer.from(pub) }
}
const xPub = (raw) => crypto.createPublicKey({ key: Buffer.concat([X_SPKI, raw]), format: 'der', type: 'spki' })

function aesSeal (key, plain, aad) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (aad) c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
  return { iv: iv.toString('base64'), ct: ct.toString('base64') }
}

function aesOpen (key, box, aad) {
  try {
    const iv = Buffer.from(box.iv, 'base64')
    const all = Buffer.from(box.ct, 'base64')
    if (iv.length !== 12 || all.length < 16) return null
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv)
    if (aad) d.setAAD(Buffer.from(aad))
    d.setAuthTag(all.subarray(all.length - 16))
    return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()])
  } catch { return null }
}

function sealKey (recipientRawB64, key) {
  const recipient = Buffer.from(recipientRawB64, 'base64')
  const eph = crypto.generateKeyPairSync('x25519')
  const ephRaw = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(X_SPKI.length)
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: xPub(recipient) })
  const k = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephRaw, recipient]), 'yanki/v1/chkey', 32))
  return { e: Buffer.from(ephRaw).toString('base64'), ...aesSeal(k, key) }
}

function openKey (x, sealed) {
  try {
    const ephRaw = Buffer.from(sealed.e, 'base64')
    const shared = crypto.diffieHellman({ privateKey: x.privateKey, publicKey: xPub(ephRaw) })
    const k = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephRaw, x.publicRaw]), 'yanki/v1/chkey', 32))
    return aesOpen(k, sealed)
  } catch { return null }
}

const keyCheck = (key) => crypto.createHash('sha256').update('yanki/v1/check').update(key).digest('base64')

module.exports = { fromSeed, sign, verify, xFromSeed, sealKey, openKey, aesSeal, aesOpen, keyCheck }
